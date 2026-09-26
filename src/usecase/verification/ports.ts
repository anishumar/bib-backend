// The ports the verification queue needs from the world — the seams (T2.9).
// Owned by this use case, stated in our vocabulary; adapters in infrastructure/
// implement them.
import type { ApprovalDecision, StepApproval, VerificationPolicy } from "../../domain/verification/model";

export interface NewStepApproval {
  readonly id: string;
  readonly tenantId: string;
  readonly jobId: string;
  readonly jobStepId: string;
  /**
   * The policy version in force when the check was opened, PINNED here.
   *
   * Null when the step's template names no policy, or names one the firm has
   * since unpublished. Both are real states and neither is an error — the check
   * still happens, under maker != checker alone.
   *
   * Note what is NOT in this interface: `submittedBy`. The database derives it
   * from `job_step.performed_by` and freezes it (migration 0048), because a
   * maker a writer could choose is not a maker-checker control — the way past
   * the CHECK would be to name somebody else as the maker and approve it
   * yourself. This application cannot set it, and that is the point.
   */
  readonly policyVersionId: string | null;
  readonly policyKey: string | null;
}

export interface ApprovalDecisionWrite {
  readonly decision: Exclude<ApprovalDecision, "pending">;
  readonly notes: string | null;
  readonly decidedBy: string;
  readonly decidedAt: string;
}

/**
 * One step's check, as a row.
 *
 * A read model rather than the bare aggregate, for the reason CLAUDE.md states
 * about every list in this codebase: the queue screen renders WHO is waiting on
 * WHAT, and an aggregate carries three uuids and no names. Five lists shipped
 * here returning uuids before anything had to draw them.
 */
export interface PendingCheck {
  readonly approval: StepApproval;
  readonly jobId: string;
  readonly stepKey: string;
  readonly stepLabel: string;
  /** Who made it, by name. Null for a step an agent committed unattended — no
   *  person did, and "—" is the honest cell. */
  readonly submittedByName: string | null;
  /** The policy's own label, pinned with it, so a queue can say "Manager
   *  review" without resolving a config version per row. */
  readonly policyLabel: string | null;
  /** The process version the check's JOB is pinned to (T6.15), joined in the
   *  same query, so the queue can say which review points each check has
   *  without reading the job behind every row. Null for a job that has not
   *  pinned one, which a job with a check cannot be. */
  readonly templateVersionId: string | null;
}

export interface StepApprovalRepository {
  /**
   * Open a check on a finished step.
   *
   * The unique partial index (`decision = 'pending'`) is what makes this safe
   * against two requests arriving together; the adapter turns that conflict
   * into null, which the caller reads as "already open" rather than as an
   * error.
   *
   * `subStepKeys` (T6.15): opened only if the step is still `blocked` and
   * every one of these sub-steps is marked, as read after the STEP's row is
   * locked, the lock every sub-step mark takes too. Null otherwise, and the
   * caller tells the two nulls apart by looking for an open check. This is
   * what keeps a tick taken back between Done's own read and this insert from
   * reaching the checker as a list with a line open. Empty means no guard.
   */
  openIfAbsent(approval: NewStepApproval, subStepKeys?: readonly string[]): Promise<StepApproval | null>;

  /** The open check on this step, or null. */
  findOpenForStep(tenantId: string, jobStepId: string): Promise<StepApproval | null>;

  findById(tenantId: string, approvalId: string): Promise<StepApproval | null>;

  /**
   * Decide, only if it is still pending.
   *
   * Conditional in SQL for `AgentRunRepository.decide`'s reason: two people can
   * be looking at the same queue and both click. Null means somebody else got
   * there first, and their decision is the one that stands.
   *
   * `settled` (T6.15), passed on APPROVE only: decided only if every named
   * review point of THIS check and every named sub-step of its step is
   * marked, as read after the check's row is locked, the lock every review
   * mark takes too. Null otherwise; the caller reads the check again to tell
   * "somebody answered first" from "a point was taken back". Sending work back
   * is never guarded, and never passes this.
   */
  decide(
    tenantId: string,
    approvalId: string,
    write: ApprovalDecisionWrite,
    settled?: { readonly reviewPointKeys: readonly string[]; readonly subStepKeys: readonly string[] },
  ): Promise<StepApproval | null>;

  /** Everything waiting to be checked at this firm, oldest first — the queue. */
  listPending(tenantId: string): Promise<readonly PendingCheck[]>;

  /** Every check this job has ever had, including the ones that were sent back.
   *  The job screen's read; the rejections are the point. */
  listForJob(tenantId: string, jobId: string): Promise<readonly PendingCheck[]>;
}

/**
 * A firm's published answer to "who may check this kind of work".
 *
 * Two reads, and the difference is the whole of pinning — the same shape
 * `TemplateSource` has, for the same reason. `published` is asked ONCE, when a
 * check is opened; `pinned` is asked every time afterwards, so a firm raising
 * its review bar in April never restates who was allowed to approve something
 * in March.
 *
 * Narrow on purpose: this use case does not want to know what a config entry
 * is, only how to get a rule out of one. Satisfied by the config adapter, so
 * the two use cases never import each other — as `RoleDirectory` and
 * `AxisDirectory` already do.
 */
export interface ResolvedPolicy {
  /** The `config.version` id, which the approval pins. */
  readonly versionId: string;
  readonly key: string;
  readonly policy: VerificationPolicy;
}

export interface VerificationPolicySource {
  /** The version in force for this key, or null when the firm has published
   *  none. Null is a real answer — a step that names a rule the firm has not
   *  written, or has since withdrawn. */
  publishedPolicy(tenantId: string, key: string): Promise<ResolvedPolicy | null>;
  /** What that check was opened under, whatever is in force now. Null when the
   *  row no longer parses as a policy — history that fails to read is a fact
   *  about the past, not today's rule applied retroactively. */
  pinnedPolicy(tenantId: string, versionId: string): Promise<ResolvedPolicy | null>;
}

/**
 * Everybody at the firm who might check something, with the two facts the rules
 * compare: their rung, and who they report to.
 *
 * Read WHOLE, and that is deliberate rather than lazy. Both callers need it
 * that way — "who could check this" is asked for a screenful of steps at once,
 * and the ungraded/unreported cases are the ones a screen has to EXPLAIN, so
 * they must come back rather than being filtered out in SQL. A firm's staff
 * list is tens to low hundreds of rows.
 */
export interface StaffMember {
  readonly userId: string;
  readonly membershipId: string;
  readonly displayName: string;
  readonly role: string;
  readonly gradeRank: number | null;
  readonly gradeName: string | null;
  readonly reportsToUserId: string | null;
  readonly isActive: boolean;
}

export interface CheckerDirectory {
  /** Active STAFF only. A deactivated membership cannot check anything, and a
   *  portal contact is a client. */
  activeStaff(tenantId: string): Promise<readonly StaffMember[]>;
}

/**
 * The step being checked, as this use case needs to see it.
 *
 * Narrow, and satisfied by the orchestrator's own step repository — the two use
 * cases stay independent, and this one never learns what a `StepStatus` union
 * is. What it needs is: is the work finished, and who did it.
 */
export interface CheckableStep {
  readonly id: string;
  readonly jobId: string;
  readonly stepKey: string;
  readonly label: string;
  readonly status: string;
  readonly performedBy: string | null;
}

export interface CheckableStepSource {
  findStep(tenantId: string, jobId: string, stepKey: string): Promise<CheckableStep | null>;
  findStepById(tenantId: string, stepId: string): Promise<CheckableStep | null>;
}
