// Postgres adapter for the verification queue (T2.9). Every read and write goes
// through withTenant — a check belongs to the firm whose work it is about, and
// there is no identity-mode path here at all.
//
// ONE THING THIS ADAPTER DELIBERATELY DOES NOT WRITE: `submitted_by`. It is
// derived by a trigger from `job_step.performed_by` and frozen there (migration
// 0048), because maker != checker compares two columns and a rule whose
// left-hand side the writer could choose is not a rule. The INSERT below names
// every other column and not that one; the RETURNING reads back what the
// database decided.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { ApprovalDecision, StepApproval } from "../../domain/verification/model";
import { isApprovalDecision } from "../../domain/verification/model";
import type {
  ApprovalDecisionWrite,
  NewStepApproval,
  PendingCheck,
  StepApprovalRepository,
  StepSentBack,
} from "../../usecase/verification/ports";
import { lockStepWithSubStepsSettled, openReviewPoints, openSubSteps } from "./step-lines";
import { isoInstant } from "./instant";

interface ApprovalRow {
  id: string;
  tenant_id: string;
  job_id: string;
  job_step_id: string;
  submitted_by: string | null;
  submitted_at: Date | string;
  policy_version_id: string | null;
  policy_key: string | null;
  decision: string;
  notes: string | null;
  decided_by: string | null;
  decided_at: Date | string | null;
}

/** A check joined to the step it is about and to the account that made the work
 *  — the queue read. Both joins exist so a screen never fetches per row; five
 *  lists in this codebase shipped returning uuids before anything drew them. */
interface CheckRow extends ApprovalRow {
  step_key: string;
  step_label: string;
  submitted_by_name: string | null;
  submitted_by_email: string | null;
  template_version_id: string | null;
}

const COLUMNS =
  "id, tenant_id, job_id, job_step_id, submitted_by, submitted_at, " +
  "policy_version_id, policy_key, decision, notes, decided_by, decided_at";

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : v;
}

function isoOrNull(v: Date | string | null): string | null {
  return v === null ? null : iso(v);
}

function toApproval(r: ApprovalRow): StepApproval {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    jobId: r.job_id,
    jobStepId: r.job_step_id,
    submittedBy: r.submitted_by,
    submittedAt: iso(r.submitted_at),
    policyVersionId: r.policy_version_id,
    policyKey: r.policy_key,
    // A decision the domain does not recognise would have to have got past the
    // CHECK, so this cannot happen — and if it ever does, "pending" is the safe
    // reading: it leaves the work waiting rather than treating an unknown state
    // as approval.
    decision: (isApprovalDecision(r.decision) ? r.decision : "pending") satisfies ApprovalDecision,
    notes: r.notes,
    decidedBy: r.decided_by,
    decidedAt: isoOrNull(r.decided_at),
  };
}

function toCheck(r: CheckRow): PendingCheck {
  return {
    approval: toApproval(r),
    jobId: r.job_id,
    stepKey: r.step_key,
    stepLabel: r.step_label,
    // The name, falling back to the address, falling back to nothing. Nothing is
    // a real answer — a step an agent committed unattended has no person behind
    // it, and "—" is the honest cell rather than an invented one.
    submittedByName: r.submitted_by_name ?? r.submitted_by_email,
    // The label is not stored on the approval and is not joined here: it lives
    // in the pinned config version, which the use case resolves per row because
    // two rows can legitimately be pinned to different versions of the same
    // rule.
    policyLabel: null,
    // The job's pinned process (T6.15), so the use case can say which review
    // points each row has without reading the job behind every row.
    templateVersionId: r.template_version_id,
  };
}

export class PostgresStepApprovalRepository implements StepApprovalRepository {
  constructor(private readonly app: Db) {}

  /**
   * Open a check, unless one is already open on this step.
   *
   * `ON CONFLICT DO NOTHING` against the unique partial index — the same shape
   * `createAllIfAbsent` uses, and for the same reason: everything around the
   * engine is at-least-once, and two requests arriving together must produce one
   * check rather than two people each approving the other's.
   *
   * Returns null when nothing was inserted, which the caller reads as "already
   * waiting" and not as an error.
   *
   * WITH `subStepKeys` (T6.15) the STEP's row is locked first and the check
   * opens only if the step is still waiting and every listed sub-step is
   * marked, read after the lock (`step-lines.ts`). The step was moved to
   * "submitted" by its own transition a moment earlier, and this is the write
   * that closes the list to marks, so this is where the list has to be true.
   */
  async openIfAbsent(approval: NewStepApproval, subStepKeys: readonly string[] = []): Promise<StepApproval | null> {
    return withTenant(this.app, approval.tenantId, async (db) => {
      if (
        subStepKeys.length > 0 &&
        !(await lockStepWithSubStepsSettled(db, approval.jobStepId, "blocked", subStepKeys))
      ) {
        return null;
      }
      const [row] = await db<ApprovalRow[]>`
        INSERT INTO delivery.step_approval
          (id, tenant_id, job_id, job_step_id, policy_version_id, policy_key)
        VALUES (
          ${approval.id}, ${approval.tenantId}, ${approval.jobId}, ${approval.jobStepId},
          ${approval.policyVersionId}, ${approval.policyKey}
        )
        ON CONFLICT DO NOTHING
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      return row ? toApproval(row) : null;
    });
  }

  async findOpenForStep(tenantId: string, jobStepId: string): Promise<StepApproval | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<ApprovalRow[]>`
        SELECT ${db.unsafe(COLUMNS)} FROM delivery.step_approval
        WHERE job_step_id = ${jobStepId} AND decision = 'pending'
      `;
      return row ? toApproval(row) : null;
    });
  }

  async findById(tenantId: string, approvalId: string): Promise<StepApproval | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<ApprovalRow[]>`
        SELECT ${db.unsafe(COLUMNS)} FROM delivery.step_approval WHERE id = ${approvalId}
      `;
      return row ? toApproval(row) : null;
    });
  }

  /**
   * Decide, only where nothing has been decided.
   *
   * `AND decision = 'pending'` is the concurrency guard and it is in the SQL for
   * `JobStepRepository.transition`'s reason: two people can be looking at the
   * same queue and both click. A blind UPDATE would let the second overwrite the
   * first's answer, and that answer is part of an audit record.
   *
   * Null means somebody got there first. Not an error — their decision stands.
   *
   * WITH `settled` (T6.15, Approve only) the CHECK's row is locked first, the
   * lock every review mark takes, and it is decided only if every listed
   * review point of this check and every listed sub-step of its step is
   * marked, read after the lock. The sub-steps cannot move while the check is
   * pending (their marks refuse a step with one), so that half is a wall under
   * a wall, for a mark written by something other than the service.
   */
  async decide(
    tenantId: string,
    approvalId: string,
    write: ApprovalDecisionWrite,
    settled?: { readonly reviewPointKeys: readonly string[]; readonly subStepKeys: readonly string[] },
  ): Promise<StepApproval | null> {
    return withTenant(this.app, tenantId, async (db) => {
      if (settled !== undefined && settled.reviewPointKeys.length + settled.subStepKeys.length > 0) {
        const [held] = await db<{ job_step_id: string }[]>`
          SELECT job_step_id FROM delivery.step_approval
          WHERE id = ${approvalId} AND decision = 'pending'
          FOR NO KEY UPDATE
        `;
        if (!held) return null;
        const open =
          (await openReviewPoints(db, approvalId, settled.reviewPointKeys)) +
          (await openSubSteps(db, held.job_step_id, settled.subStepKeys));
        if (open > 0) return null;
      }
      const [row] = await db<ApprovalRow[]>`
        UPDATE delivery.step_approval SET
          decision   = ${write.decision},
          notes      = ${write.notes},
          decided_by = ${write.decidedBy},
          decided_at = ${write.decidedAt}
        WHERE id = ${approvalId} AND decision = 'pending'
        RETURNING ${db.unsafe(COLUMNS)}
      `;
      return row ? toApproval(row) : null;
    });
  }

  async listPending(tenantId: string): Promise<readonly PendingCheck[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // OLDEST FIRST, by when the work was submitted. Not by a due date: the
      // firm has not given its internal turnaround times, and ordering by one
      // this code invented would be a priority the firm never set.
      //
      // The account is a LEFT join and stays one — a step an agent committed
      // unattended has no `submitted_by`, and an inner join would drop exactly
      // the rows a firm most wants a person to look at.
      const rows = await db<CheckRow[]>`
        SELECT a.id, a.tenant_id, a.job_id, a.job_step_id, a.submitted_by, a.submitted_at,
               a.policy_version_id, a.policy_key, a.decision, a.notes,
               a.decided_by, a.decided_at,
               s.step_key, s.label AS step_label,
               u.display_name AS submitted_by_name, u.email::text AS submitted_by_email,
               j.template_version_id
        FROM delivery.step_approval a
        JOIN delivery.job_step s ON s.id = a.job_step_id
        JOIN delivery.job j ON j.id = a.job_id
        LEFT JOIN tenancy.user_account u ON u.id = a.submitted_by
        WHERE a.decision = 'pending'
          -- A cancelled job's checks leave the queue (V2.4): its steps were
          -- withdrawn, so there is nothing left to check.
          AND j.status <> 'cancelled'
        ORDER BY a.submitted_at
      `;
      return rows.map(toCheck);
    });
  }

  async listForJob(tenantId: string, jobId: string): Promise<readonly PendingCheck[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // EVERY check, decided ones included, newest last. The rejections are the
      // point: "this took two goes" is visible nowhere else, and a list of only
      // open checks would make a step that was sent back twice look like one
      // that sailed through.
      const rows = await db<CheckRow[]>`
        SELECT a.id, a.tenant_id, a.job_id, a.job_step_id, a.submitted_by, a.submitted_at,
               a.policy_version_id, a.policy_key, a.decision, a.notes,
               a.decided_by, a.decided_at,
               s.step_key, s.label AS step_label,
               u.display_name AS submitted_by_name, u.email::text AS submitted_by_email,
               j.template_version_id
        FROM delivery.step_approval a
        JOIN delivery.job_step s ON s.id = a.job_step_id
        JOIN delivery.job j ON j.id = a.job_id
        LEFT JOIN tenancy.user_account u ON u.id = a.submitted_by
        WHERE a.job_id = ${jobId}
        ORDER BY a.submitted_at
      `;
      return rows.map(toCheck);
    });
  }

  /**
   * The steps sent back and not done again (CA#29), for a desk in one read:
   * per step, the latest DECIDED check, kept only when it was a send-back and
   * no check on the step is open.
   */
  async sentBackFor(tenantId: string, jobStepIds: readonly string[]): Promise<readonly StepSentBack[]> {
    if (jobStepIds.length === 0) return [];
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<
        { job_step_id: string; decision: string; notes: string | null; decided_at: string; decided_by_name: string | null }[]
      >`
        SELECT DISTINCT ON (a.job_step_id)
               a.job_step_id, a.decision, a.notes,
               ${db.unsafe(isoInstant("a.decided_at", "decided_at"))},
               u.display_name AS decided_by_name
        FROM delivery.step_approval a
        LEFT JOIN tenancy.user_account u ON u.id = a.decided_by
        WHERE a.job_step_id IN ${db(jobStepIds)}
          AND a.decision <> 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM delivery.step_approval o
             WHERE o.job_step_id = a.job_step_id AND o.tenant_id = a.tenant_id
               AND o.decision = 'pending')
        ORDER BY a.job_step_id, a.decided_at DESC, a.submitted_at DESC
      `;
      return rows
        .filter((r) => r.decision === "rejected")
        .map((r) => ({
          jobStepId: r.job_step_id,
          notes: r.notes,
          decidedAt: r.decided_at,
          decidedByName: r.decided_by_name,
        }));
    });
  }
}
