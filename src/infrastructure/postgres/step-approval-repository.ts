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
} from "../../usecase/verification/ports";

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
   */
  async openIfAbsent(approval: NewStepApproval): Promise<StepApproval | null> {
    return withTenant(this.app, approval.tenantId, async (db) => {
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
   */
  async decide(
    tenantId: string,
    approvalId: string,
    write: ApprovalDecisionWrite,
  ): Promise<StepApproval | null> {
    return withTenant(this.app, tenantId, async (db) => {
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
               u.display_name AS submitted_by_name, u.email::text AS submitted_by_email
        FROM delivery.step_approval a
        JOIN delivery.job_step s ON s.id = a.job_step_id
        LEFT JOIN tenancy.user_account u ON u.id = a.submitted_by
        WHERE a.decision = 'pending'
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
               u.display_name AS submitted_by_name, u.email::text AS submitted_by_email
        FROM delivery.step_approval a
        JOIN delivery.job_step s ON s.id = a.job_step_id
        LEFT JOIN tenancy.user_account u ON u.id = a.submitted_by
        WHERE a.job_id = ${jobId}
        ORDER BY a.submitted_at
      `;
      return rows.map(toCheck);
    });
  }
}
