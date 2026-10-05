// Finished recurring work, for billing it early (Q071 b, 2026-10-05).
//
// Two kinds of work finish a period:
//   - a PERIOD JOB done (a recurring service's own process for the month,
//     quarter or year: `period_start` set, not a filing's job);
//   - a FILING done: its job done, its task completed, or the filing marked
//     filed (Q063: marking the job done means the return is filed).
// A filing belongs to the engagements whose service carries its rule, by
// CA#11's predicate, exactly as Work vs Billing and the sweep read it.
//
// A done day is the FIRM's day (`finished_at` in `tenancy.tenant.time_zone`),
// a filing's own `filed_on` when it has one.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { DoneWork, DoneWorkFacts } from "../../usecase/billing/ports";

interface JobRow {
  id: string;
  engagement_ids: string[];
  period_start: string;
  period_end: string;
  done_on: string;
}

interface FilingRow {
  id: string;
  job_id: string | null;
  name: string;
  engagement_ids: string[];
  period_start: string;
  period_end: string;
  done_on: string;
}

export class PostgresDoneWorkFacts implements DoneWorkFacts {
  constructor(private readonly app: Db) {}

  doneWork(
    tenantId: string,
    filter: {
      readonly since: string;
      readonly jobId?: string | undefined;
      readonly workItemId?: string | undefined;
      readonly partyId?: string | undefined;
    },
  ): Promise<readonly DoneWork[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const party = filter.partyId;
      const jobs = await db<JobRow[]>`
        SELECT j.id,
               array_agg(DISTINCT je.engagement_id) AS engagement_ids,
               j.period_start::text AS period_start, j.period_end::text AS period_end,
               (j.finished_at AT TIME ZONE t.time_zone)::date::text AS done_on
          FROM delivery.job j
          JOIN tenancy.tenant t ON t.id = j.tenant_id
          JOIN delivery.job_engagement je ON je.job_id = j.id AND je.tenant_id = j.tenant_id
          JOIN crm.engagement e ON e.id = je.engagement_id AND e.tenant_id = je.tenant_id
         WHERE j.status = 'done'
           AND j.source_kind <> 'obligation'
           AND j.period_start IS NOT NULL
           AND (j.finished_at AT TIME ZONE t.time_zone)::date >= ${filter.since}::date
           ${filter.jobId === undefined ? db`` : db`AND j.id = ${filter.jobId}`}
           ${
             filter.workItemId === undefined
               ? db``
               : db`AND EXISTS (SELECT 1 FROM delivery.work_item wi
                                 WHERE wi.tenant_id = j.tenant_id AND wi.id = ${filter.workItemId}
                                   AND wi.job_id = j.id)`
           }
           ${party === undefined ? db`` : db`AND e.party_id = ${party}`}
         GROUP BY j.id, j.period_start, j.period_end, j.finished_at, t.time_zone
         LIMIT 2000
      `;

      const filings = await db<FilingRow[]>`
        SELECT f.id, f.job_id, f.name, f.engagement_ids, f.period_start, f.period_end, f.done_on
          FROM (
            SELECT oi.id, oj.id AS job_id, ot.name,
                   oi.period_start::text AS period_start, oi.period_end::text AS period_end,
                   coalesce(
                     oi.filed_on,
                     (oj.finished_at AT TIME ZONE t.time_zone)::date,
                     (wi.completed_at AT TIME ZONE t.time_zone)::date
                   )::text AS done_on,
                   ARRAY(
                     SELECT e.id
                       FROM crm.engagement e
                       JOIN crm.engagement_letter_line ll
                         ON ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
                       LEFT JOIN config.version pinned
                         ON pinned.id = ll.service_version_id AND pinned.tenant_id = ll.tenant_id
                      WHERE e.tenant_id = oi.tenant_id
                        AND e.entity_party_id = oi.entity_party_id
                        ${party === undefined ? db`` : db`AND e.party_id = ${party}`}
                        AND (oi.engagement_id = e.id
                             OR EXISTS (SELECT 1 FROM delivery.obligation_rule_service k
                                         WHERE k.tenant_id = oi.tenant_id
                                           AND k.lineage_id = oi.lineage_id
                                           AND k.service_entry_id = pinned.entry_id
                                           AND k.unlinked_at IS NULL))
                   ) AS engagement_ids
              FROM delivery.obligation_instance oi
              JOIN tenancy.tenant t ON t.id = oi.tenant_id
              JOIN delivery.obligation_template ot ON ot.id = oi.template_id AND ot.tenant_id = oi.tenant_id
              JOIN delivery.obligation_state os ON os.id = oi.state_id AND os.tenant_id = oi.tenant_id
              LEFT JOIN delivery.job oj
                ON oj.tenant_id = oi.tenant_id AND oj.source_kind = 'obligation' AND oj.source_ref = oi.id
               AND oj.status = 'done'
              LEFT JOIN delivery.work_item wi
                ON wi.id = oi.work_item_id AND wi.tenant_id = oi.tenant_id AND wi.completed_at IS NOT NULL
             WHERE oi.withdrawn_at IS NULL
               AND (os.is_filed OR oj.id IS NOT NULL OR wi.id IS NOT NULL)
               ${filter.jobId === undefined ? db`` : db`AND oj.id = ${filter.jobId}`}
               ${
                 filter.workItemId === undefined
                   ? db``
                   : db`AND (oi.work_item_id = ${filter.workItemId}
                             OR EXISTS (SELECT 1 FROM delivery.work_item w2
                                         WHERE w2.tenant_id = oi.tenant_id AND w2.id = ${filter.workItemId}
                                           AND w2.job_id = oj.id))`
               }
          ) f
         WHERE f.done_on IS NOT NULL
           AND f.done_on::date >= ${filter.since}::date
           AND cardinality(f.engagement_ids) > 0
         LIMIT 2000
      `;

      return [
        ...jobs.map(
          (j): DoneWork => ({
            kind: "job",
            id: j.id,
            jobId: j.id,
            name: null,
            engagementIds: j.engagement_ids,
            periodStart: j.period_start,
            periodEnd: j.period_end,
            doneOn: j.done_on,
          }),
        ),
        ...filings.map(
          (f): DoneWork => ({
            kind: "filing",
            id: f.id,
            jobId: f.job_id,
            name: f.name,
            engagementIds: f.engagement_ids,
            periodStart: f.period_start,
            periodEnd: f.period_end,
            doneOn: f.done_on,
          }),
        ),
      ];
    });
  }

  async describe(
    tenantId: string,
    engagementIds: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly clientName: string; readonly serviceName: string; readonly letterRef: string }>> {
    if (engagementIds.length === 0) return new Map();
    const rows = await withTenant(this.app, tenantId, (db) => db<
      { engagement_id: string; fee_group_id: string | null; client_name: string; service_name: string; letter_ref: string }[]
    >`
      SELECT e.id AS engagement_id, g.id AS fee_group_id, p.display_name AS client_name,
             coalesce(g.title, ll.description) AS service_name, l.ref AS letter_ref
        FROM crm.engagement e
        JOIN core.party p ON p.id = e.party_id AND p.tenant_id = e.tenant_id
        JOIN crm.engagement_letter l ON l.id = e.engagement_letter_id AND l.tenant_id = e.tenant_id
        JOIN crm.engagement_letter_line ll ON ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
        LEFT JOIN crm.engagement_letter_fee_group g ON g.id = ll.fee_group_id AND g.tenant_id = ll.tenant_id
       WHERE e.id = ANY(${db.array([...engagementIds])}::uuid[])
    `);
    return new Map(
      rows.map((r) => [
        r.fee_group_id !== null ? `g:${r.fee_group_id}` : `e:${r.engagement_id}`,
        { clientName: r.client_name, serviceName: r.service_name, letterRef: r.letter_ref },
      ]),
    );
  }
}
