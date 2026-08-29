// In-memory port fakes for the verification queue (T2.9). Each `implements` the
// port its Postgres counterpart does, so a compile error here is the same
// compile error production would get.
//
// ── THE ONE THING THIS FAKE MODELS ON PURPOSE ───────────────────────────────
//
// `submitted_by` is DERIVED, not supplied. In Postgres a trigger reads it from
// `job_step.performed_by` and freezes it, because maker != checker compares two
// columns and a rule whose left-hand side the writer chooses is not a rule. A
// fake that let the caller set it would make every maker-checker unit test pass
// by construction — which is exactly the failure the demo warned about, one
// level up. So this fake reads the step too.
//
// It does NOT restate the CHECK constraint. The wall is the database's, proven
// as the OWNER role in `tests/verification/maker-checker.integration.test.ts`,
// going round the application entirely. Restating it here would let a green unit
// suite stand in for the thing that actually holds.
import type { StepApproval } from "../domain/verification/model";
import type {
  ApprovalDecisionWrite,
  CheckerDirectory,
  NewStepApproval,
  PendingCheck,
  ResolvedPolicy,
  StaffMember,
  StepApprovalRepository,
  VerificationPolicySource,
} from "../usecase/verification/ports";
import type { FakeJobStepRepo } from "./orchestrator";
import type { Permission } from "../domain/authz/model";
import type { PermissionSource } from "../usecase/authz/ports";

export class FakeStepApprovalRepo implements StepApprovalRepository {
  readonly rows: StepApproval[] = [];

  /** The steps behind the approvals, so `submitted_by` can be derived the way
   *  the trigger derives it. Set by the test that wires both. */
  steps: FakeJobStepRepo | null = null;

  constructor(private readonly now: () => string = () => "2026-08-30T09:00:00.000Z") {}

  openIfAbsent(approval: NewStepApproval): Promise<StepApproval | null> {
    // The unique partial index, modelled: one OPEN check per step. A decided one
    // does not block a second attempt, because a step sent back and redone opens
    // a second row on purpose.
    const open = this.rows.find(
      (r) => r.jobStepId === approval.jobStepId && r.decision === "pending",
    );
    if (open) return Promise.resolve(null);

    const step = this.steps?.rows.find((s) => s.id === approval.jobStepId) ?? null;
    const row: StepApproval = {
      id: approval.id,
      tenantId: approval.tenantId,
      jobId: approval.jobId,
      jobStepId: approval.jobStepId,
      // DERIVED. See the note at the top of this file.
      submittedBy: step?.performedBy ?? null,
      submittedAt: this.now(),
      policyVersionId: approval.policyVersionId,
      policyKey: approval.policyKey,
      decision: "pending",
      notes: null,
      decidedBy: null,
      decidedAt: null,
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  findOpenForStep(tenantId: string, jobStepId: string): Promise<StepApproval | null> {
    return Promise.resolve(
      this.rows.find(
        (r) => r.tenantId === tenantId && r.jobStepId === jobStepId && r.decision === "pending",
      ) ?? null,
    );
  }

  findById(tenantId: string, approvalId: string): Promise<StepApproval | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.id === approvalId) ?? null,
    );
  }

  decide(
    tenantId: string,
    approvalId: string,
    write: ApprovalDecisionWrite,
  ): Promise<StepApproval | null> {
    const index = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === approvalId);
    const current = this.rows[index];
    // The `AND decision = 'pending'` guard, modelled faithfully — it is what
    // makes the second of two people clicking at once lose, and a fake that
    // ignored it would make every concurrency test pass by construction.
    if (!current || current.decision !== "pending") return Promise.resolve(null);
    const next: StepApproval = {
      ...current,
      decision: write.decision,
      notes: write.notes,
      decidedBy: write.decidedBy,
      decidedAt: write.decidedAt,
    };
    this.rows[index] = next;
    return Promise.resolve(next);
  }

  listPending(tenantId: string): Promise<readonly PendingCheck[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.tenantId === tenantId && r.decision === "pending")
        .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
        .map((r) => this.toCheck(r)),
    );
  }

  listForJob(tenantId: string, jobId: string): Promise<readonly PendingCheck[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.tenantId === tenantId && r.jobId === jobId)
        .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
        .map((r) => this.toCheck(r)),
    );
  }

  private toCheck(r: StepApproval): PendingCheck {
    const step = this.steps?.rows.find((s) => s.id === r.jobStepId) ?? null;
    return {
      approval: r,
      jobId: r.jobId,
      stepKey: step?.stepKey ?? "(unknown)",
      stepLabel: step?.label ?? "(unknown)",
      submittedByName: r.submittedBy,
      policyLabel: null,
    };
  }
}

/** A firm's published verification rules, in memory. Two reads, and the
 *  difference between them IS pinning — a published policy that is later
 *  replaced still resolves BY VERSION, which is what an approval pins. */
export class FakeVerificationPolicySource implements VerificationPolicySource {
  private readonly published = new Map<string, ResolvedPolicy>();
  private readonly byVersion = new Map<string, ResolvedPolicy>();

  publish(policy: ResolvedPolicy): this {
    this.published.set(policy.key, policy);
    this.byVersion.set(policy.versionId, policy);
    return this;
  }

  /** Withdraw what is in force WITHOUT forgetting the version — the state a
   *  firm reaches by unpublishing a rule a template still names, and the one
   *  that must leave already-open checks readable. */
  withdraw(key: string): this {
    this.published.delete(key);
    return this;
  }

  publishedPolicy(_tenantId: string, key: string): Promise<ResolvedPolicy | null> {
    return Promise.resolve(this.published.get(key) ?? null);
  }

  pinnedPolicy(_tenantId: string, versionId: string): Promise<ResolvedPolicy | null> {
    return Promise.resolve(this.byVersion.get(versionId) ?? null);
  }
}

/** The firm's staff, in memory. Active STAFF only is the ADAPTER's filter, so
 *  this holds only rows a test means to be checkable. */
export class FakeCheckerDirectory implements CheckerDirectory {
  readonly rows: StaffMember[] = [];

  add(member: Partial<StaffMember> & { readonly userId: string }): this {
    this.rows.push({
      membershipId: `m-${member.userId}`,
      displayName: member.userId,
      role: "member",
      gradeRank: null,
      gradeName: null,
      reportsToUserId: null,
      isActive: true,
      ...member,
    });
    return this;
  }

  activeStaff(_tenantId: string): Promise<readonly StaffMember[]> {
    return Promise.resolve(this.rows.filter((r) => r.isActive));
  }
}

/**
 * Role -> permissions, in memory.
 *
 * Grants `work:write` to every role by DEFAULT, and that default is chosen so
 * that a test which says nothing about permissions gets the behaviour the
 * product had before T2.9 — the permission floor is invisible until a test
 * makes it visible. `deny` is how a test makes it visible, and
 * `tests/verification/eligibility.test.ts` is where that matters: it is the
 * demo's open Q41, a read-only membership holding a senior grade.
 */
export class FakeWorkPermissions implements PermissionSource {
  private readonly denied = new Set<string>();

  deny(role: string): this {
    this.denied.add(role);
    return this;
  }

  permissionsFor(_tenantId: string, role: string): Promise<readonly Permission[]> {
    return Promise.resolve(this.denied.has(role) ? ["party:read"] : ["party:read", "work:write"]);
  }

  knownRoles(_tenantId: string): Promise<readonly string[]> {
    return Promise.resolve(["member"]);
  }
}
