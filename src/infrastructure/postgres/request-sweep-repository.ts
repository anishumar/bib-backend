// The requests sweep (F1.4), in Postgres. `withTenant` throughout: a sweep is
// the firm's own machinery, never a portal read.
//
// ── THE SUBJECTS, THEIR STEPS AND WHAT THEY ALREADY ASKED, ONE TRANSACTION ─
//
// Two statements inside one `withTenant`: the period jobs (each with ONE open
// task, its steps' statuses and the template items already asked on any of its
// tasks), then the pinned process bodies, read ONCE per distinct version rather
// than once per job — four hundred jobs on one process share one body.
//
// ── DAYS ARE TEXT ─────────────────────────────────────────────────────────
//
// `period_end::text`: postgres.js hands a `date` back as a JS Date at UTC
// midnight, which names the day before west of Greenwich (CLAUDE.md, "A date
// column is a DAY"). No `Date` is constructed in this file.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import { readRequestTemplate, readWorkflowTemplate } from "../../domain/config/model";
import { isStepStatus, STEP_STATUSES } from "../../domain/orchestrator/model";
import type { StepStatus } from "../../domain/orchestrator/model";
import type {
  AskedItem,
  PublishedRequestTemplate,
  RequestSubject,
} from "../../domain/requests/model";
import type {
  PublishedRequestTemplateSource,
  RequestSubjectSource,
} from "../../usecase/requests/ports";

interface SubjectRow {
  job_id: string;
  period_end: string;
  template_version_id: string | null;
  work_item_id: string;
  steps: { stepKey: string; status: string }[];
  asked: AskedItem[];
}

/** A pinned process as the sweep reads it: each step's key and the request
 *  template it names. */
type PinnedSteps = readonly { readonly stepKey: string; readonly requestTemplateKey: string | null }[];

export class PostgresRequestSubjects implements RequestSubjectSource {
  constructor(private readonly app: Db) {}

  async periodJobs(tenantId: string): Promise<readonly RequestSubject[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // ── the period jobs still owed, each on one open task ─────────────────
      //
      // ONE TASK PER JOB, CHOSEN THE SAME WAY EVERY PASS. A job merged over two
      // engagements of one company (0046's grouping, per period since 0300)
      // has a task per engagement, and both are the same client's same month:
      // asking on each would put October's bank statements on the client's
      // page twice. Client-visible first, because an ask on a task the firm
      // hid is hidden with it (0062); then the oldest.
      //
      // `asked` READS EVERY TASK OF THE JOB, terminal ones included, and that
      // is what keeps the choice above honest across passes: once the first
      // task is finished the next pass picks the other, and it must not ask
      // again for what the first was already asked. 0385's unique index is per
      // TASK and cannot say this; the read can.
      //
      // The open-task test is the state's FLAG, never its code (0050).
      const rows = await db<SubjectRow[]>`
        SELECT j.id                  AS job_id,
               j.period_end::text    AS period_end,
               j.template_version_id,
               task.id               AS work_item_id,
               coalesce(
                 (SELECT jsonb_agg(jsonb_build_object('stepKey', s.step_key, 'status', s.status))
                    FROM delivery.job_step s
                   WHERE s.job_id = j.id AND s.tenant_id = j.tenant_id),
                 '[]'::jsonb
               ) AS steps,
               coalesce(
                 (SELECT jsonb_agg(DISTINCT jsonb_build_object(
                           'templateKey', a.request_template_key,
                           'itemKey', a.request_item_key))
                    FROM delivery.client_ask a
                    JOIN delivery.work_item wi
                      ON wi.id = a.work_item_id AND wi.tenant_id = a.tenant_id
                   WHERE wi.job_id = j.id
                     AND wi.tenant_id = j.tenant_id
                     AND a.request_item_key IS NOT NULL),
                 '[]'::jsonb
               ) AS asked
          FROM delivery.job j
          JOIN LATERAL (
            SELECT wi.id
              FROM delivery.work_item wi
              JOIN delivery.work_item_state ws
                ON ws.id = wi.state_id AND ws.tenant_id = wi.tenant_id
             WHERE wi.job_id = j.id
               AND wi.tenant_id = j.tenant_id
               AND NOT ws.is_terminal
             ORDER BY wi.is_client_visible DESC, wi.created_at, wi.id
             LIMIT 1
          ) task ON true
         WHERE j.tenant_id = ${tenantId}
           AND j.source_kind = 'engagement_period'
           AND j.status NOT IN ('done', 'cancelled')
         ORDER BY j.period_end, j.id
      `;

      // ── the pinned processes, once each ───────────────────────────────────
      //
      // By VERSION id with no status filter: the version a job pinned is
      // archived the moment the firm publishes a newer one, and reading it is
      // the point (the orchestrator's `pinnedTemplate`). The orchestrator's
      // resolved template does not carry `requestTemplateKey`, so the body is
      // read here, through the one reader for the kind.
      const versionIds = [
        ...new Set(rows.flatMap((r) => (r.template_version_id === null ? [] : [r.template_version_id]))),
      ];
      const pinned = new Map<string, PinnedSteps>();
      if (versionIds.length > 0) {
        const versions = await db<{ id: string; body: Record<string, unknown> }[]>`
          SELECT id, body
            FROM config.version
           WHERE tenant_id = ${tenantId}
             AND id = ANY(${versionIds}::uuid[])
        `;
        for (const v of versions) {
          // A pinned body that no longer reads asks for nothing here. It is not
          // silent: the orchestrator refuses to walk the same job
          // (`TemplateUnreadable`) and reports it on every pass.
          const body = readWorkflowTemplate(v.body);
          pinned.set(
            v.id,
            (body?.steps ?? []).map((s) => ({ stepKey: s.key, requestTemplateKey: s.requestTemplateKey })),
          );
        }
      }

      return rows.map((r): RequestSubject => {
        const status = new Map<string, StepStatus>(r.steps.map((s) => [s.stepKey, stepStatus(s.status)]));
        const steps =
          r.template_version_id === null ? [] : (pinned.get(r.template_version_id) ?? []);
        return {
          jobId: r.job_id,
          workItemId: r.work_item_id,
          periodEnd: r.period_end,
          pinnedVersionId: r.template_version_id,
          steps: steps.map((s) => ({
            stepKey: s.stepKey,
            requestTemplateKey: s.requestTemplateKey,
            status: status.get(s.stepKey) ?? null,
          })),
          asked: r.asked.map((a) => ({ templateKey: a.templateKey, itemKey: a.itemKey })),
        };
      });
    });
  }
}

export class PostgresPublishedRequestTemplates implements PublishedRequestTemplateSource {
  constructor(private readonly app: Db) {}

  async publishedByKey(tenantId: string, key: string): Promise<PublishedRequestTemplate | null> {
    return withTenant(this.app, tenantId, async (db) => {
      // PUBLISHED only. A draft is a list somebody is still writing, and
      // asking a client from it would act on a decision nobody has taken.
      const [row] = await db<{ id: string; body: Record<string, unknown> }[]>`
        SELECT v.id, v.body
          FROM config.entry e
          JOIN config.version v
            ON v.entry_id = e.id AND v.tenant_id = e.tenant_id AND v.status = 'published'
         WHERE e.tenant_id = ${tenantId}
           AND e.kind = 'request_template'
           AND e.key = ${key}
      `;
      if (!row) return null;
      // A published body that no longer reads is the same answer as none
      // published: nothing to ask from, and the sweep counts it as such.
      const template = readRequestTemplate(row.body);
      return template === null ? null : { versionId: row.id, key, template };
    });
  }

  async anyPublished(tenantId: string): Promise<boolean> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ published: boolean }[]>`
        SELECT EXISTS (
          SELECT 1
            FROM config.entry e
            JOIN config.version v
              ON v.entry_id = e.id AND v.tenant_id = e.tenant_id AND v.status = 'published'
           WHERE e.tenant_id = ${tenantId}
             AND e.kind = 'request_template'
        ) AS published
      `;
      return row?.published ?? false;
    });
  }
}

/** `delivery.job_step.status` is held to the engine's six by a CHECK (0044);
 *  a value outside them means the schema moved under this code. */
function stepStatus(value: string): StepStatus {
  if (isStepStatus(value)) return value;
  throw new Error(
    `delivery.job_step.status is ${JSON.stringify(value)}, which is not one of the engine's ` +
      `step states (${STEP_STATUSES.join(", ")}); the CHECK in 0044 should have refused it`,
  );
}
