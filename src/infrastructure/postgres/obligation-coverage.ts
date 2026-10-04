// Which engagements the compliance calendar will produce work for (T3.2), and
// which of them BOUGHT a filing (T6.13).
//
// One query, and it is deliberately the GENERATOR'S OWN PREDICATE rather than a
// convenient approximation of it: an ACTIVE rule, carrying a due formula, that
// is not event-driven, confirmed by the firm, whose CHAIN has a live catalogue
// LINK to this engagement's service (T6.16, 0309), for the entity's own
// country. If the two ever drift, a recurring client gets either two tasks for
// one filing or none at all — so the predicate is written once here and the
// port that reads it says so.
//
// It answers at SPAWN time, when no obligation instance exists yet: the sweep
// generates later that night. That is why it asks about RULES and not about
// rows, and it is also why the answer is safe — a firm with no rules is not
// covered, so it gets exactly the behaviour it had before this existed.
//
// ── TWO QUESTIONS, AND TWO ANSWERS AGAIN (T6.16 follow-up, 2026-09-26) ─────
//
// T6.13 split `coveredEngagements` from `filingEngagements` because a rule
// owed by "Any service" (a NULL service, the shipped pack's every row) reached
// every engagement at the entity while naming none of them: bookkeeping was
// COVERED by the entity's GST rule, and was not a filing. Decision 1 removed
// that case, and for a while both methods ran this statement with no switch.
//
// Then the catalogue invited a filing onto ANY service, and a monthly
// bookkeeping service (a ten-step close of its own) that also carries TDS
// lost its month's task, "Monthly Accounting · Sep 2026": the calendar dated
// its filings, so the per-period spawn read the service as being its filings.
// The rule the firm chose: a service that names a PROCESS of its own keeps its
// per-period task, and its filings get their own tasks beside it; a service
// that names none (a pure "GST Compliance") IS its filings, as T6.13 had it.
// So `filingEngagements` is "reached AND no process of its own", and this is
// the one place that rule is written.
//
// THE PROCESS IS READ LIVE, the orchestrator's read (`job-subject-repository`):
// through the pinned version to the ENTRY and out to what is published now,
// judged by `readServiceBody`. A workflow key is not a term of the contract,
// and the period job this task sits on pins the firm's CURRENT process when it
// opens. Asking the signed version instead would skip the task on every
// engagement signed before the firm wrote its process, which is exactly the
// book a firm brings with it, while the job walked that process anyway. An
// entry with nothing published names no process, as it does for the
// orchestrator.
//
// `coveredEngagements` (the ONE-TIME activation task) is unchanged and does not
// ask: that task is due `effective_from + slaDays` on an engagement that runs a
// year and can never be completed, whatever steps the service has.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import { readServiceBody } from "../../domain/config/model";
import type { ObligationCoverage } from "../../usecase/workitem/ports";

interface ReachedRow {
  engagement_id: string;
  /** The service's PUBLISHED body now; null when nothing is published. */
  live_body: Record<string, unknown> | null;
}

export class PostgresObligationCoverage implements ObligationCoverage {
  constructor(private readonly app: Db) {}

  async coveredEngagements(
    tenantId: string,
    engagementIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const rows = await this.reached(tenantId, engagementIds);
    return new Set(rows.map((r) => r.engagement_id));
  }

  async filingEngagements(
    tenantId: string,
    engagementIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const rows = await this.reached(tenantId, engagementIds);
    return new Set(
      rows
        // A service with a process of its own keeps its month's task (the
        // header says why). Judged by the domain's own reading of a service
        // body, so a blank key is "no process" here exactly as it is to the
        // orchestrator, which runs no process for it either.
        .filter((r) => r.live_body === null || readServiceBody(r.live_body).workflowTemplateKey === null)
        .map((r) => r.engagement_id),
    );
  }

  /** CA#11: the same rule `describeJobs` applies to a job, for one
   *  engagement's period. See the port. */
  async earliestFilingDue(
    tenantId: string,
    engagementId: string,
    period: { readonly start: string; readonly end: string },
  ): Promise<string | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ due: string | null }[]>`
        SELECT min(oi.statutory_due_on)::text AS due
          FROM crm.engagement e
          JOIN crm.engagement_letter_line ln
            ON ln.id = e.engagement_letter_line_id AND ln.tenant_id = e.tenant_id
          JOIN config.version pinned
            ON pinned.id = ln.service_version_id AND pinned.tenant_id = ln.tenant_id
          JOIN delivery.obligation_instance oi
            ON oi.tenant_id = e.tenant_id AND oi.entity_party_id = e.entity_party_id
          JOIN delivery.obligation_state os
            ON os.id = oi.state_id AND os.tenant_id = oi.tenant_id
         WHERE e.id = ${engagementId}
           AND oi.withdrawn_at IS NULL
           AND NOT os.is_terminal
           AND NOT os.is_filed
           AND (oi.engagement_id = e.id
                OR EXISTS (SELECT 1 FROM delivery.obligation_rule_service k
                            WHERE k.tenant_id = oi.tenant_id
                              AND k.lineage_id = oi.lineage_id
                              AND k.service_entry_id = pinned.entry_id
                              AND k.unlinked_at IS NULL))
           AND oi.period_start <= ${period.end}::date
           AND oi.period_end >= ${period.start}::date
      `;
      return row?.due ?? null;
    });
  }

  private async reached(
    tenantId: string,
    engagementIds: readonly string[],
  ): Promise<readonly ReachedRow[]> {
    if (engagementIds.length === 0) return [];
    return withTenant(this.app, tenantId, async (db) => {
      return db<ReachedRow[]>`
        SELECT DISTINCT e.id AS engagement_id, live.body AS live_body
        FROM crm.engagement e
        -- INNER, as subjectsFor has it since T6.16. These were LEFT joins so a
        -- rule naming NO service could still reach an engagement whose version
        -- could not be resolved; that reading is gone, and an engagement is
        -- reached only through the service its letter line pinned.
        JOIN crm.engagement_letter_line ln
          ON ln.id = e.engagement_letter_line_id AND ln.tenant_id = e.tenant_id
        JOIN config.version pinned
          ON pinned.id = ln.service_version_id AND pinned.tenant_id = ln.tenant_id
        -- What the service says NOW, read for its process alone: the hop the
        -- orchestrator makes. LEFT, because an entry with nothing published
        -- is still reached (the link is on the entry) and names no process.
        -- One row at most: 0005 allows one published version per entry, so
        -- the DISTINCT below still yields one row per engagement.
        LEFT JOIN config.version live
          ON live.entry_id = pinned.entry_id
         AND live.tenant_id = pinned.tenant_id
         AND live.status = 'published'
        JOIN core.legal_entity le
          ON le.party_id = e.entity_party_id AND le.tenant_id = e.tenant_id
        JOIN delivery.obligation_template t
          ON t.tenant_id = e.tenant_id
         -- THE LINK: a live one between the rule's CHAIN and this engagement's
         -- service. The bug this file's header warns about happened here once
         -- already, as one operator (a bare = against a NULL that meant
         -- "every service"), which is why coverage.integration.test.ts runs
         -- this, subjectsFor and gaps against one database.
         AND EXISTS (
           SELECT 1 FROM delivery.obligation_rule_service l
           WHERE l.tenant_id = t.tenant_id
             AND l.lineage_id = t.lineage_id
             AND l.service_entry_id = pinned.entry_id
             AND l.unlinked_at IS NULL
         )
         AND t.jurisdiction = le.jurisdiction
         AND (t.entity_type IS NULL OR t.entity_type = le.entity_type)
         AND t.is_active
         AND t.due_rule IS NOT NULL
         AND t.recurrence <> 'event'
         -- Confirmed by the firm — coverageOf() again. An unconfirmed rule
         -- covers nothing, so an engagement it would reach still gets its own
         -- task from the spawn rather than a filing the calendar never dated.
         AND t.status = 'confirmed'
        WHERE e.id = ANY(${db.array(engagementIds as string[])}::uuid[])
      `;
    });
  }
}
