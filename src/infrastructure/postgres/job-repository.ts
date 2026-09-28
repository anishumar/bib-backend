// Postgres adapter for the delivery engine's jobs (T2.6), and for the two reads
// the scheduler needs around them.
//
// Three ports over two tables, the same shape the membership repository already
// uses: the job table is the scheduler's own, and the activation feed is a read
// of the LEDGER — which is how the engine hears about a signed engagement
// without the commercial lane knowing an engine exists.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import { readServiceBody } from "../../domain/config/model";
import type { Job, JobSource, JobStatus } from "../../domain/scheduler/model";
import type { WorkSplitAxis } from "../../domain/serviceaxis/model";
import type {
  Activation,
  ActivationFeed,
  JobDetail,
  JobRepository,
  NewJob,
  RecurringEngagement,
  RecurringEngagementFeed,
  TenantDirectory,
} from "../../usecase/scheduler/ports";

interface JobRow {
  id: string;
  tenant_id: string;
  source_kind: JobSource;
  source_ref: string;
  status: JobStatus;
  template_version_id: string | null;
  split_axis: WorkSplitAxis;
  split_code: string | null;
  runnable_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  period_start: string | null;
  period_end: string | null;
  period_label: string | null;
}

interface DetailRow {
  job_id: string;
  engagement_id: string;
  service_name: string | null;
  entity_name: string | null;
  client_name: string | null;
  entity_party_id: string | null;
  client_party_id: string | null;
  period_label: string | null;
  due_on: string | null;
}

interface ActivationRow {
  object_id: string;
  occurred_at: Date | string;
  engagement_letter_id: string;
  entity_party_id: string;
  body: Record<string, unknown> | null;
}

interface RecurringRow {
  engagement_id: string;
  engagement_letter_id: string;
  entity_party_id: string;
  effective_from: string;
  recurrence: string;
  sla_days: string | null;
  body: Record<string, unknown> | null;
  linked_periods: string[];
}

const COLUMNS =
  "id, tenant_id, source_kind, source_ref, status, template_version_id, " +
  "split_axis, split_code, runnable_at, started_at, finished_at, " +
  // The period's DATE columns read as text (0300): postgres.js would hand back
  // a Date, which is an instant and a different calendar day either side of
  // midnight UTC — and these are the values the board prints and the sweep
  // deduplicates on.
  "period_start::text AS period_start, period_end::text AS period_end, period_label";

/** timestamptz comes back from postgres.js as a Date; the domain speaks ISO
 *  strings, so it is converted once, here at the door. */
function ts(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function toJob(r: JobRow): Job {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    sourceKind: r.source_kind,
    sourceRef: r.source_ref,
    status: r.status,
    templateVersionId: r.template_version_id,
    splitAxis: r.split_axis,
    splitCode: r.split_code,
    runnableAt: ts(r.runnable_at) ?? "",
    startedAt: ts(r.started_at),
    finishedAt: ts(r.finished_at),
    periodStart: r.period_start,
    periodEnd: r.period_end,
    periodLabel: r.period_label,
  };
}

/** A JSON number read out as text; a body that never stated one is null, and
 *  null means no turnaround rather than one this product invented. Range
 *  checked rather than bare-cast, because a body published before the
 *  validator existed could carry a non-numeric value. */
function wholeDays(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export class PostgresJobRepository
  implements JobRepository, ActivationFeed, RecurringEngagementFeed
{
  constructor(private readonly app: Db) {}

  /**
   * Insert, or hand back the row that is already there.
   *
   * `ON CONFLICT DO NOTHING` plus a follow-up read, rather than
   * `ON CONFLICT DO UPDATE ... RETURNING`. The difference matters: an UPDATE
   * would touch `updated_at` on every redelivery, so a job spawned once and
   * redelivered fifty times would look fifty times modified, and the column
   * that answers "when did this last actually change" would answer "just now"
   * forever.
   *
   * The two statements are in one transaction (withTenant opens one), so
   * nothing can delete the row between them — and nothing deletes jobs anyway;
   * bib_app holds no DELETE grant on the table.
   */
  async createIfAbsent(job: NewJob): Promise<{ job: Job; created: boolean }> {
    return withTenant(this.app, job.tenantId, async (db) => {
      // The conflict target names the partial index's PREDICATE as well as its
      // columns (0046) — postgres will not infer a partial index without it,
      // and the whole point of the index being partial is that a group whose
      // job has FINISHED may legally get another one when a later engagement
      // arrives. Without the WHERE, this would either not compile or would
      // silently match a different index.
      const inserted = await db<JobRow[]>`
        INSERT INTO delivery.job
          (id, tenant_id, source_kind, source_ref, runnable_at, split_axis, split_code,
           period_start, period_end, period_label)
        VALUES (
          ${job.id}, ${job.tenantId}, ${job.sourceKind}, ${job.sourceRef},
          ${job.runnableAt}, ${job.splitAxis}, ${job.splitCode},
          ${job.periodStart ?? null}::date, ${job.periodEnd ?? null}::date, ${job.periodLabel ?? null}
        )
        ON CONFLICT (tenant_id, source_kind, source_ref)
          WHERE status NOT IN ('done', 'cancelled')
          DO NOTHING
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      const row = inserted[0];
      if (row) return { job: toJob(row), created: true };

      // The OPEN one, matching the index that refused the insert. A finished
      // job for the same cause may also exist and is not the answer: handing it
      // back would attach new work to a checklist nobody will look at again.
      const [existing] = await db<JobRow[]>`
        SELECT ${db.unsafe(COLUMNS)} FROM delivery.job
        WHERE source_kind = ${job.sourceKind} AND source_ref = ${job.sourceRef}
          AND status NOT IN ('done', 'cancelled')
      `;
      if (!existing) {
        throw new Error(
          `job for ${job.sourceKind} ${job.sourceRef} neither inserted nor found — the unique ` +
            `key refused the insert but no open row is visible, which should be impossible ` +
            `inside one transaction`,
        );
      }
      return { job: toJob(existing), created: false };
    });
  }

  /**
   * Attach engagements to a job, and report which ones this call actually
   * attached.
   *
   * `ON CONFLICT DO NOTHING` over `UNIQUE (tenant_id, engagement_id)` is doing
   * two different jobs at once and both are wanted. An engagement already
   * linked to THIS job is a redelivery, and the right answer is "nothing
   * happened". An engagement linked to ANOTHER job is the thing that must never
   * occur — two checklists for one piece of work, two sets of tasks, eventually
   * two invoices — and the constraint refuses it here rather than leaving it to
   * a rule somebody remembers.
   *
   * One statement rather than a loop, so a failure cannot leave a merged job
   * holding half its engagements and then run to completion looking finished.
   */
  async linkEngagements(
    tenantId: string,
    jobId: string,
    engagementIds: readonly string[],
    periodStart: string | null = null,
  ): Promise<readonly string[]> {
    if (engagementIds.length === 0) return [];
    return withTenant(this.app, tenantId, async (db) => {
      // The three-column key (0300), and `NULLS NOT DISTINCT` on it is what
      // keeps this the same statement for a one-time engagement: its null
      // period is one value, so the old absolute rule still refuses a second
      // link exactly as the two-column key did.
      const rows = await db<{ engagement_id: string }[]>`
        INSERT INTO delivery.job_engagement (tenant_id, job_id, engagement_id, period_start)
        SELECT ${tenantId}, ${jobId}, e, ${periodStart}::date
        FROM unnest(${db.array([...engagementIds])}::uuid[]) AS e
        ON CONFLICT (tenant_id, engagement_id, period_start) DO NOTHING
        RETURNING engagement_id
      `;
      return rows.map((r) => r.engagement_id);
    });
  }

  /**
   * What a set of jobs is for, in words — one query for the whole list.
   *
   * The service NAME comes off the PINNED version while the grouping facts came
   * off the LIVE one, and that split is deliberate: the name is a term of the
   * client's letter and must read as it was written, while which team delivers
   * it and how is ours and reads as it is now.
   */
  async describeJobs(
    tenantId: string,
    jobIds: readonly string[],
  ): Promise<ReadonlyMap<string, JobDetail>> {
    const out = new Map<string, JobDetail>();
    if (jobIds.length === 0) return out;

    const rows = await withTenant(this.app, tenantId, async (db) => {
      return db<DetailRow[]>`
        SELECT
          je.job_id,
          je.engagement_id,
          pinned.body->>'name' AS service_name,
          ent.display_name AS entity_name,
          cl.display_name  AS client_name,
          ent.id           AS entity_party_id,
          cl.id            AS client_party_id,
          j.period_label,
          -- What a step on this job is due by (V2.1): the earliest date among
          -- the job's UNFINISHED tasks. Read as text, a DAY, never an instant.
          (SELECT min(wi.due_on)::text
             FROM delivery.work_item wi
             JOIN delivery.work_item_state ws
               ON ws.id = wi.state_id AND ws.tenant_id = wi.tenant_id
            WHERE wi.job_id = je.job_id
              AND wi.tenant_id = je.tenant_id
              AND NOT ws.is_terminal) AS due_on
        FROM delivery.job_engagement je
        JOIN delivery.job j
          ON j.id = je.job_id AND j.tenant_id = je.tenant_id
        -- LEFT all the way down. The link row is the fact that this work is in
        -- this job; everything below it is only how to NAME it. A row that
        -- could not be named must still appear, blank, rather than vanish from
        -- the card while its steps sit on somebody's board.
        LEFT JOIN crm.engagement e
          ON e.id = je.engagement_id AND e.tenant_id = je.tenant_id
        LEFT JOIN crm.engagement_letter_line l
          ON l.id = e.engagement_letter_line_id AND l.tenant_id = e.tenant_id
        LEFT JOIN config.version pinned
          ON pinned.id = l.service_version_id AND pinned.tenant_id = l.tenant_id
        -- The entity the work is delivered TO and the client who is BILLED are
        -- different parties and the board shows both. LEFT on each: a party is
        -- never deleted in this product, so a null here would be a real fault
        -- and is better rendered as a blank than as a crashed list.
        LEFT JOIN core.party ent
          ON ent.id = e.entity_party_id AND ent.tenant_id = e.tenant_id
        LEFT JOIN core.party cl
          ON cl.id = e.party_id AND cl.tenant_id = e.tenant_id
        WHERE je.job_id = ANY(${db.array([...jobIds])}::uuid[])
        ORDER BY je.job_id, je.created_at, je.engagement_id
      `;
    });

    for (const r of rows) {
      const existing = out.get(r.job_id);
      const service = {
        engagementId: r.engagement_id,
        // A published service body always has a name (the validator requires
        // it). The fallback is for the row that should not exist rather than a
        // default anybody is meant to see.
        serviceName: r.service_name ?? "(unnamed service)",
      };
      if (existing) {
        out.set(r.job_id, { ...existing, services: [...existing.services, service] });
      } else {
        out.set(r.job_id, {
          entityName: r.entity_name,
          clientName: r.client_name,
          entityPartyId: r.entity_party_id,
          clientPartyId: r.client_party_id,
          periodLabel: r.period_label,
          dueOn: r.due_on,
          services: [service],
        });
      }
    }
    return out;
  }

  async findById(tenantId: string, jobId: string): Promise<Job | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<JobRow[]>`
        SELECT ${db.unsafe(COLUMNS)} FROM delivery.job WHERE id = ${jobId}
      `;
      return row ? toJob(row) : null;
    });
  }

  async listRunnable(tenantId: string, asOf: string, limit: number): Promise<readonly Job[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // Oldest first: a backlog is worked in the order it was owed, not in
      // whatever order the index returns. Matches idx_job_runnable.
      //
      // `blocked` IS INCLUDED, and leaving it out was a real bug found by
      // running the engine (T2.7). A blocked job is one waiting on a PERSON —
      // the commonest state a job is in and the main thing a work board exists
      // to show. Worse, the orchestrator finds its work through this same read,
      // so a job that blocked would never be swept again: the moment somebody
      // finished a step outside the API path, or an agent was built for a step
      // that had been waiting, nothing would notice.
      //
      // The three excluded are the terminal ones — `done` and `cancelled` never
      // move again. That is what "runnable" has to mean here.
      const rows = await db<JobRow[]>`
        SELECT ${db.unsafe(COLUMNS)} FROM delivery.job
        WHERE status IN ('pending', 'running', 'blocked') AND runnable_at <= ${asOf}
        ORDER BY runnable_at
        LIMIT ${limit}
      `;
      return rows.map(toJob);
    });
  }

  /** The board's read (T6.13): everything open, including the per-period jobs
   *  whose window has not opened yet. Same statuses as `listRunnable`, no
   *  clock — the difference IS the upcoming rows. */
  async listOpen(tenantId: string, limit: number): Promise<readonly Job[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<JobRow[]>`
        SELECT ${db.unsafe(COLUMNS)} FROM delivery.job
        WHERE status IN ('pending', 'running', 'blocked')
        ORDER BY runnable_at, id
        LIMIT ${limit}
      `;
      return rows.map(toJob);
    });
  }

  /**
   * Move a job's status, and keep its timestamps honest.
   *
   * The timestamps are set HERE rather than by the caller because the CHECK
   * constraint in 0041 ties them to the status — a caller that forgot one would
   * get a constraint violation, which is a correct outcome but a poor error.
   * `started_at` uses COALESCE so a job that goes running -> blocked -> running
   * keeps the moment it FIRST started, which is what "how long has this been in
   * flight" means.
   */
  /**
   * Pin the workflow version, and only where nothing is pinned yet.
   *
   * `WHERE template_version_id IS NULL` is the guard, and it is in the SQL
   * rather than in the service on purpose: a check-then-write has a race between
   * its two halves, and two workers sweeping the same job would both read null.
   * The database decides, once, and the loser is told it lost.
   */
  async pinTemplate(tenantId: string, jobId: string, versionId: string): Promise<boolean> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db`
        UPDATE delivery.job SET template_version_id = ${versionId}
        WHERE id = ${jobId} AND template_version_id IS NULL
        RETURNING id
      `;
      return rows.length === 1;
    });
  }

  async updateStatus(
    tenantId: string,
    jobId: string,
    status: JobStatus,
    at: string,
  ): Promise<Job> {
    const terminal = status === "done" || status === "cancelled";
    const pending = status === "pending";
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<JobRow[]>`
        UPDATE delivery.job SET
          status      = ${status},
          started_at  = ${pending ? null : db.unsafe(`COALESCE(started_at, '${at}'::timestamptz)`)},
          finished_at = ${terminal ? at : null}
        WHERE id = ${jobId}
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      if (!row) throw new Error(`job ${jobId} vanished between the read and the write`);
      return toJob(row);
    });
  }

  // ── ActivationFeed ──────────────────────────────────────────────────────────

  /**
   * Released engagements this firm has no job for yet.
   *
   * The ledger IS the queue here. `contract.activated` is written by the
   * engagement module because a contract activated — not because anything
   * downstream asked — and this reads it. The commercial lane therefore has no
   * idea the engine exists, which is what "event, not a direct call" buys.
   *
   * The anti-join against `delivery.job` is what makes the feed self-limiting:
   * an activation leaves it the moment its job exists, so a worker that was
   * down for a day finds exactly the backlog and not a re-run of everything.
   * Both tables are under the same RLS context, so this cannot see another
   * firm's events or be confused by another firm's jobs.
   */
  async unspawnedActivations(tenantId: string, limit: number): Promise<readonly Activation[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<ActivationRow[]>`
        SELECT
          ev.object_id,
          ev.occurred_at,
          e.engagement_letter_id,
          e.entity_party_id,
          live.body AS body
        FROM ledger.event ev
        -- INNER on the engagement, and that is a deliberate narrowing (0046).
        -- An activation naming a row that is not there can no longer BECOME a
        -- job: job_engagement carries a foreign key to crm.engagement, so the
        -- link would be refused. The feed therefore does not offer work it
        -- could not create. Before the link table existed this produced a
        -- phantom job that sat forever unable to resolve its own subject,
        -- which was not better -- it was the same fault, further downstream.
        JOIN crm.engagement e
          ON e.id = ev.object_id AND e.tenant_id = ev.tenant_id
        -- LEFT from here down, and this half matters more. The line, the
        -- pinned version and the live body are needed only for the GROUPING
        -- facts, and a service that cannot be resolved -- unpublished since,
        -- or a line that went missing -- must still SPAWN. It lands in the
        -- unfiled bucket and gets its own job, exactly as a service filed
        -- under no Dept does. Losing work because we could not decide which
        -- checklist it belonged on is the worst failure available here.
        LEFT JOIN crm.engagement_letter_line l
          ON l.id = e.engagement_letter_line_id AND l.tenant_id = e.tenant_id
        -- Through the line's PINNED service version to the ENTRY, then back out
        -- to whatever is published NOW. The grouping facts are read LIVE for the
        -- reason the subject read gives at length: a client agreed to the
        -- service, not to which of our teams delivers it or what our internal
        -- steps are. LEFT, because a firm may have unpublished the service since
        -- — which reads as "filed under nothing, no process", both real states.
        LEFT JOIN config.version pinned
          ON pinned.id = l.service_version_id AND pinned.tenant_id = l.tenant_id
        LEFT JOIN config.version live
          ON live.entry_id = pinned.entry_id
         AND live.tenant_id = pinned.tenant_id
         AND live.status = 'published'
        WHERE ev.verb = 'contract.activated'
          -- RECURRING SERVICES TAKE THE OTHER ROUTE (T6.13). A pinned body
          -- that says monthly, quarterly or annually is owed a job PER PERIOD
          -- from activeRecurring, never the one-time checklist this feed
          -- produces. PINNED, because how often the work comes round is a
          -- term of the letter the client signed; the grouping facts above are
          -- live for the opposite reason. COALESCE so an unresolvable service
          -- keeps spawning here, exactly as the LEFT joins above intend.
          AND COALESCE(pinned.body ->> 'recurrence', '') NOT IN ('monthly', 'quarterly', 'annually')
          -- THE ANTI-JOIN, and it is now over the LINK table rather than over
          -- job.source_ref (0046). A merged job's source_ref is a derived
          -- group key that names no engagement, so the old test would have
          -- reported every already-merged engagement as unspawned and built a
          -- second checklist for it on the very next sweep.
          AND NOT EXISTS (
            SELECT 1 FROM delivery.job_engagement je
            WHERE je.engagement_id = ev.object_id AND je.tenant_id = ev.tenant_id
          )
        ORDER BY ev.occurred_at
        LIMIT ${limit}
      `;
      return rows.map((r) => {
        const service = r.body === null ? null : readServiceBody(r.body);
        return {
          engagementId: r.object_id,
          occurredAt: ts(r.occurred_at) ?? "",
          engagementLetterId: r.engagement_letter_id,
          entityPartyId: r.entity_party_id,
          deptCode: service?.module ?? null,
          teamCode: service?.group ?? null,
          workflowKey: service?.workflowTemplateKey ?? null,
        };
      });
    });
  }

  // ── RecurringEngagementFeed (T6.13) ──────────────────────────────────────

  /**
   * Active engagements whose service comes round every period, with the
   * periods each already has a job for.
   *
   * INNER on the line and the pinned version, unlike the feeds above, and
   * that is not a contradiction: `recurrence` is read off the pinned body, so
   * an engagement whose version cannot be resolved cannot be KNOWN to recur —
   * and it is not lost, because the COALESCE in `unspawnedActivations` sends
   * exactly that engagement down the one-time route. The two predicates are
   * complements by construction.
   *
   * `linked_periods` is aggregated in the row rather than fetched per
   * engagement, for the reason the port gives: this runs every hour over
   * every recurring engagement at the firm.
   */
  async activeRecurring(tenantId: string, limit: number): Promise<readonly RecurringEngagement[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<RecurringRow[]>`
        SELECT
          e.id                         AS engagement_id,
          e.engagement_letter_id,
          e.entity_party_id,
          -- A DATE, read as text: the period arithmetic is calendar arithmetic.
          e.effective_from::text       AS effective_from,
          -- PINNED: terms of the letter the client signed.
          pinned.body ->> 'recurrence' AS recurrence,
          pinned.body ->> 'slaDays'    AS sla_days,
          -- LIVE: how the firm delivers it now, as unspawnedActivations reads it.
          live.body                    AS body,
          COALESCE(
            (SELECT array_agg(je.period_start::text ORDER BY je.period_start)
             FROM delivery.job_engagement je
             WHERE je.engagement_id = e.id AND je.tenant_id = e.tenant_id
               AND je.period_start IS NOT NULL),
            '{}'::text[]
          )                            AS linked_periods
        FROM crm.engagement e
        JOIN crm.engagement_letter_line l
          ON l.id = e.engagement_letter_line_id AND l.tenant_id = e.tenant_id
        JOIN config.version pinned
          ON pinned.id = l.service_version_id AND pinned.tenant_id = l.tenant_id
        LEFT JOIN config.version live
          ON live.entry_id = pinned.entry_id
         AND live.tenant_id = pinned.tenant_id
         AND live.status = 'published'
        WHERE e.status = 'active'
          AND pinned.body ->> 'recurrence' IN ('monthly', 'quarterly', 'annually')
        ORDER BY e.effective_from, e.id
        LIMIT ${limit}
      `;
      return rows.map((r) => {
        const service = r.body === null ? null : readServiceBody(r.body);
        return {
          engagementId: r.engagement_id,
          engagementLetterId: r.engagement_letter_id,
          entityPartyId: r.entity_party_id,
          deptCode: service?.module ?? null,
          teamCode: service?.group ?? null,
          workflowKey: service?.workflowTemplateKey ?? null,
          effectiveFrom: r.effective_from,
          recurrence: r.recurrence,
          slaDays: wholeDays(r.sla_days),
          linkedPeriods: r.linked_periods,
        };
      });
    });
  }
}

/**
 * The firms a sweep walks.
 *
 * `tenancy.tenant` is GLOBAL (it is the platform's registry of firms, not a
 * firm's own data), so this is the one read in the engine that is not inside a
 * tenant context — and it returns nothing but ids. Every read that follows is
 * scoped to one of them. A worker has no session, so this list is how it
 * chooses a scope deliberately instead of running without one.
 */
export class PostgresTenantDirectory implements TenantDirectory {
  constructor(private readonly app: Db) {}

  async activeTenantIds(): Promise<readonly string[]> {
    const rows = await this.app<{ id: string }[]>`
      SELECT id FROM tenancy.tenant WHERE status = 'active' ORDER BY created_at
    `;
    return rows.map((r) => r.id);
  }
}
