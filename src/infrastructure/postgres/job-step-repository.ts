// Postgres adapter for a job's steps (T2.7). Every read and write goes through
// withTenant — a step belongs to the firm that owes the work, and there is no
// identity-mode path here at all.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { JobStep, StepStatus } from "../../domain/orchestrator/model";
import { isStepStatus } from "../../domain/orchestrator/model";
import type {
  JobStepRepository,
  NewJobStep,
  StepTransition,
} from "../../usecase/orchestrator/ports";

interface StepRow {
  id: string;
  tenant_id: string;
  job_id: string;
  step_key: string;
  label: string;
  executor: string;
  status: string;
  outcome_note: string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  performed_by: string | null;
  assignee_user_id: string | null;
}

const COLUMNS =
  "id, tenant_id, job_id, step_key, label, executor, status, outcome_note, " +
  "started_at, finished_at, performed_by, assignee_user_id";

function iso(v: Date | string | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : v;
}

function toStep(r: StepRow): JobStep {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    jobId: r.job_id,
    stepKey: r.step_key,
    label: r.label,
    executor: r.executor,
    // The CHECK constraint guarantees this, so the cast states a fact the
    // database already enforces. The guard is here anyway because a status that
    // arrived unrecognised would otherwise flow into the readiness rule as a
    // string nothing matches, and the job would stall with nothing saying why.
    status: isStepStatus(r.status) ? r.status : "blocked",
    outcomeNote: r.outcome_note,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    performedBy: r.performed_by,
    assigneeUserId: r.assignee_user_id,
  };
}

export class PostgresJobStepRepository implements JobStepRepository {
  constructor(private readonly app: Db) {}

  /**
   * All of a job's steps in ONE statement, idempotently.
   *
   * `ON CONFLICT DO NOTHING` on `(job_id, step_key)` is what makes a redelivered
   * message harmless. One statement rather than a loop so a failure cannot leave
   * a job holding half a process — which would then run to completion looking
   * finished, which is the worst outcome available here.
   *
   * `created` is decided by how many rows the INSERT returned, not by comparing
   * counts afterwards: a partial pre-existing set is not a state this can reach
   * (the insert is one statement), and RETURNING says exactly what it wrote.
   */
  async createAllIfAbsent(
    steps: readonly NewJobStep[],
  ): Promise<{ readonly steps: readonly JobStep[]; readonly created: boolean }> {
    if (steps.length === 0) return { steps: [], created: false };
    const [first] = steps;
    if (!first) throw new Error("createAllIfAbsent called with no steps after a length check");
    const { tenantId, jobId } = first;
    // Asserted rather than assumed: a mixed batch would insert under the wrong
    // RLS context and the WITH CHECK would reject it, which is a confusing way
    // to learn this.
    if (steps.some((s) => s.tenantId !== tenantId || s.jobId !== jobId)) {
      throw new Error("createAllIfAbsent received steps for more than one job; a batch is one job's process");
    }

    return withTenant(this.app, tenantId, async (db) => {
      const inserted = await db<StepRow[]>`
        INSERT INTO delivery.job_step ${db(
          steps.map((s) => ({
            id: s.id,
            tenant_id: s.tenantId,
            job_id: s.jobId,
            step_key: s.stepKey,
            label: s.label,
            executor: s.executor,
            assignee_user_id: s.assigneeUserId,
          })),
        )}
        ON CONFLICT (job_id, step_key) DO NOTHING
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      if (inserted.length > 0) return { steps: inserted.map(toStep), created: true };

      const existing = await db<StepRow[]>`
        SELECT ${db.unsafe(COLUMNS)} FROM delivery.job_step
        WHERE job_id = ${jobId} ORDER BY step_key
      `;
      return { steps: existing.map(toStep), created: false };
    });
  }

  async listForJob(tenantId: string, jobId: string): Promise<readonly JobStep[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // Ordered by key for a deterministic read. The PRESENTATION order is the
      // template's, which the caller has; the readiness rule is over the set and
      // does not care.
      const rows = await db<StepRow[]>`
        SELECT ${db.unsafe(COLUMNS)} FROM delivery.job_step
        WHERE job_id = ${jobId} ORDER BY step_key
      `;
      return rows.map(toStep);
    });
  }

  async findByKey(tenantId: string, jobId: string, stepKey: string): Promise<JobStep | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<StepRow[]>`
        SELECT ${db.unsafe(COLUMNS)} FROM delivery.job_step
        WHERE job_id = ${jobId} AND step_key = ${stepKey}
      `;
      return row ? toStep(row) : null;
    });
  }

  async findById(tenantId: string, stepId: string): Promise<JobStep | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<StepRow[]>`
        SELECT ${db.unsafe(COLUMNS)} FROM delivery.job_step WHERE id = ${stepId}
      `;
      return row ? toStep(row) : null;
    });
  }

  /**
   * Compare-and-set. `WHERE status = expect` is the concurrency guard, and it is
   * in the SQL rather than in the service because a read-then-write has a race
   * between its halves — and two workers sweeping the same job WILL both decide
   * the same step is ready.
   *
   * Zero rows means somebody else moved it first. Null, not an exception: losing
   * that race is ordinary, and the caller carries on with the next step.
   *
   * The timestamps are written here rather than by the caller so that the pairs
   * the schema's CHECK insists on are always coherent — `running` gets a start,
   * `done` keeps that start and gains a finish, `skipped` gets neither.
   */
  async transition(
    tenantId: string,
    stepId: string,
    expect: StepStatus,
    to: StepTransition,
  ): Promise<JobStep | null> {
    const starts = to.status === "running" || to.status === "blocked";
    const finishes = to.status === "done" || to.status === "failed";
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<StepRow[]>`
        UPDATE delivery.job_step SET
          status       = ${to.status},
          outcome_note = ${to.outcomeNote ?? null},
          performed_by = ${to.performedBy ?? null},
          started_at   = ${
            starts || finishes
              ? db.unsafe(`COALESCE(started_at, '${to.at}'::timestamptz)`)
              : to.status === "skipped"
                ? // KEPT on a skip (0304): null for a step skipped before it
                  // opened, the day it opened for one withdrawn afterwards.
                  db.unsafe("started_at")
                : null
          },
          finished_at  = ${finishes ? to.at : null}
        WHERE id = ${stepId} AND status = ${expect}
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      return row ? toStep(row) : null;
    });
  }

  async assign(tenantId: string, stepId: string, assigneeUserId: string | null): Promise<JobStep | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<StepRow[]>`
        UPDATE delivery.job_step SET assignee_user_id = ${assigneeUserId}
        WHERE id = ${stepId} AND status IN ('pending', 'running', 'blocked')
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      return row ? toStep(row) : null;
    });
  }

  async listOpenForUser(tenantId: string, userId: string): Promise<readonly JobStep[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<StepRow[]>`
        SELECT ${db.unsafe(COLUMNS)} FROM delivery.job_step
        WHERE assignee_user_id = ${userId} AND status IN ('pending', 'running', 'blocked')
        ORDER BY created_at, step_key
      `;
      return rows.map(toStep);
    });
  }
}
