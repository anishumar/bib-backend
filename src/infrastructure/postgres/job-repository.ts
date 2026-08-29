// Postgres adapter for the delivery engine's jobs (T2.6), and for the two reads
// the scheduler needs around them.
//
// Three ports over two tables, the same shape the membership repository already
// uses: the job table is the scheduler's own, and the activation feed is a read
// of the LEDGER — which is how the engine hears about a signed engagement
// without the commercial lane knowing an engine exists.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { Job, JobSource, JobStatus } from "../../domain/scheduler/model";
import type {
  Activation,
  ActivationFeed,
  JobRepository,
  NewJob,
  TenantDirectory,
} from "../../usecase/scheduler/ports";

interface JobRow {
  id: string;
  tenant_id: string;
  source_kind: JobSource;
  source_ref: string;
  status: JobStatus;
  template_version_id: string | null;
  runnable_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
}

const COLUMNS =
  "id, tenant_id, source_kind, source_ref, status, template_version_id, runnable_at, started_at, finished_at";

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
    runnableAt: ts(r.runnable_at) ?? "",
    startedAt: ts(r.started_at),
    finishedAt: ts(r.finished_at),
  };
}

export class PostgresJobRepository implements JobRepository, ActivationFeed {
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
      const inserted = await db<JobRow[]>`
        INSERT INTO delivery.job (id, tenant_id, source_kind, source_ref, runnable_at)
        VALUES (${job.id}, ${job.tenantId}, ${job.sourceKind}, ${job.sourceRef}, ${job.runnableAt})
        ON CONFLICT (tenant_id, source_kind, source_ref) DO NOTHING
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      const row = inserted[0];
      if (row) return { job: toJob(row), created: true };

      const [existing] = await db<JobRow[]>`
        SELECT ${db.unsafe(COLUMNS)} FROM delivery.job
        WHERE source_kind = ${job.sourceKind} AND source_ref = ${job.sourceRef}
      `;
      if (!existing) {
        throw new Error(
          `job for ${job.sourceKind} ${job.sourceRef} neither inserted nor found — the unique ` +
            `key refused the insert but the row is not visible, which should be impossible ` +
            `inside one transaction`,
        );
      }
      return { job: toJob(existing), created: false };
    });
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
      const rows = await db<{ object_id: string; occurred_at: Date | string }[]>`
        SELECT e.object_id, e.occurred_at
        FROM ledger.event e
        WHERE e.verb = 'contract.activated'
          AND NOT EXISTS (
            SELECT 1 FROM delivery.job j
            WHERE j.source_kind = 'engagement' AND j.source_ref = e.object_id
          )
        ORDER BY e.occurred_at
        LIMIT ${limit}
      `;
      return rows.map((r) => ({
        engagementId: r.object_id,
        occurredAt: ts(r.occurred_at) ?? "",
      }));
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
