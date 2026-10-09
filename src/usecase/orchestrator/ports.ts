// The orchestrator's ports (T2.7); adapters in infrastructure/ implement them.
import type {
  CheckListKind,
  JobStep,
  MarkOutcome,
  StepCheckMark,
  StepStatus,
} from "../../domain/orchestrator/model";
import type {
  AgentDecision,
  ConfidenceTiers,
  ProposalOutcome,
} from "../../domain/agent/model";
import type { OwnerFacts, OwnerPerson } from "../../domain/workitem/model";
import type { Actor } from "../../domain/ledger/model";

export interface NewJobStep {
  readonly id: string;
  readonly tenantId: string;
  readonly jobId: string;
  readonly stepKey: string;
  readonly label: string;
  readonly executor: string;
  /** Whose desk it starts on, or null (0301). */
  readonly assigneeUserId: string | null;
}

/** What a step transition changes, written in one statement so the schema's CHECKs
 *  refuse an incoherent combination. */
export interface StepTransition {
  readonly status: StepStatus;
  readonly at: string;
  /** Required by the schema on `skipped` and `failed`, forbidden otherwise. */
  readonly outcomeNote?: string | undefined;
  /** The person. Null for an agent, and refused by the schema on a skip. */
  readonly performedBy?: string | undefined;
}

export interface JobStepRepository {
  /**
   * Create all of a job's steps in ONE statement (never half a process).
   * IDEMPOTENT: the engine is at-least-once, and `UNIQUE (job_id, step_key)` turns a
   * repeat into "already there". `created` says whether it inserted, so the caller
   * records an event only then.
   */
  createAllIfAbsent(
    steps: readonly NewJobStep[],
  ): Promise<{ readonly steps: readonly JobStep[]; readonly created: boolean }>;

  /** One job's steps, whole: the readiness rule is over the set. */
  listForJob(tenantId: string, jobId: string): Promise<readonly JobStep[]>;

  findByKey(tenantId: string, jobId: string, stepKey: string): Promise<JobStep | null>;

  /** By step id: how a check (which names its step) reaches its step. */
  findById(tenantId: string, stepId: string): Promise<JobStep | null>;

  /**
   * Move one step only if it is still in `expect`: two workers sweeping one job
   * must not both start it. Null = somebody else got there, not an error.
   *
   * `subStepKeys` (T6.15): moves only if every listed sub-step is marked, as read
   * AFTER the step's row is locked (mark writes take the same lock), so an untick
   * between the caller's read and this write cannot finish a step with a line open.
   * Empty means no guard.
   */
  transition(
    tenantId: string,
    stepId: string,
    expect: StepStatus,
    to: StepTransition,
    subStepKeys?: readonly string[],
  ): Promise<JobStep | null>;

  /** Move a step to a desk, or off every desk (null). Null back on a settled step,
   *  refused in SQL so a race with completion cannot reopen it. */
  assign(tenantId: string, stepId: string, assigneeUserId: string | null): Promise<JobStep | null>;

  /** Every open step on one person's desk, across jobs — "what is mine". */
  listOpenForUser(tenantId: string, userId: string): Promise<readonly JobStep[]>;
}

/** A job's tasks (V2.4): cancelling a job takes its work-item rows off every desk.
 *  Satisfied by `WorkItemService` in setup. */
export interface JobTasks {
  /** Move every open task of the job to the firm's cancelled state; returns how many.
   *  Refuses before moving anything (`NoCancelledState`) when the firm has none. */
  cancelOpenForJob(tenantId: string, jobId: string, actor: Actor): Promise<number>;
}

/**
 * The owner rule's facts for a job's steps (0301, 2026-09-27): the job's Dept, the
 * client's SPOCs for it, Key Manager and signing partner, in force on the day and
 * active. The RULE is the domain's `resolveOwner`, shared with the job's task.
 *
 * THE JOB'S DEPT is the split code when the firm splits by Dept (a team's SPOCs when
 * by team), else the Dept of the job's services (several = `several_depts`). Asking
 * only the split code sent every step to nobody at firms with no split.
 */
export interface StepDeskResolver {
  ownerFactsFor(tenantId: string, jobId: string, onDate: string): Promise<StepOwnerFacts>;
}

/**
 * The owner rule's facts plus who holds the job's TASK now. A month's task exists
 * from the period's start, its steps only from close of month; a Key Manager who
 * handed the task out meanwhile has decided, and the steps follow. `taskHolder` is
 * the one ACTIVE staff member every open task is on, else null (no open task, one
 * unassigned, or two desks).
 */
export interface StepOwnerFacts extends OwnerFacts {
  readonly taskHolder: OwnerPerson | null;
}

/**
 * A workflow template step, stated structurally (satisfied by the config adapter so
 * the use cases never import each other). `publishedTemplate` is what is IN FORCE,
 * asked once when a job starts; `pinnedTemplate` is what the job started on, asked
 * ever after, so editing a process never rewrites a job already walking it.
 */
export interface TemplateStep {
  readonly key: string;
  readonly label: string;
  readonly executor: string;
  readonly dependsOn: readonly string[];
  /** When this step applies, or null for always. NORMALISED: an old `{ fact, equals }`
   *  body arrives as `op: "equals"`, so only one shape reaches here. */
  readonly condition: {
    readonly fact: string;
    readonly op: string;
    readonly value: string | readonly string[];
  } | null;
  /** The `verification_policy` key for who checks this step (T2.9); null = nobody
   *  checks, which is how every pre-T2.9 template reads. */
  readonly verificationPolicyKey: string | null;
  /** The grade band that may do this step (0301), or null for anybody. */
  readonly performer: {
    readonly minGradeRank: number | null;
    readonly minGradeCode: string | null;
    readonly maxGradeRank: number | null;
    readonly maxGradeCode: string | null;
  } | null;
  /** Sub-steps the doer ticks before done (T6.15); empty on older steps, which are
   *  ticked as a whole. */
  readonly checklist: readonly { readonly key: string; readonly label: string }[];
  /** Review points the CHECKER ticks before approve (T6.15); empty when no check. */
  readonly reviewPoints: readonly { readonly key: string; readonly label: string }[];
}

export interface ResolvedTemplate {
  /** The `config.version` id this came from — what the job pins. */
  readonly versionId: string;
  readonly label: string;
  readonly steps: readonly TemplateStep[];
}

export interface TemplateSource {
  /** The version in force, or null: the firm has not written this process yet. */
  publishedTemplate(tenantId: string, key: string): Promise<ResolvedTemplate | null>;
  /** The version this job pinned, whatever is in force now. Null when it no longer
   *  parses (reported as `TemplateUnreadable`, never swapped for today's process). */
  pinnedTemplate(tenantId: string, versionId: string): Promise<ResolvedTemplate | null>;
}

/**
 * What a job is FOR: the template key and the facts its conditions read, in one read
 * so they come from one state. Every null is a real state, never an error and never
 * defaulted (see `evaluateCondition`).
 */
export interface JobSubject {
  /** The `workflow_template` key from the service this job delivers. */
  readonly workflowTemplateKey: string | null;
  /** `ServiceBody.recurrence`: the `recurrence` fact. */
  readonly recurrence: string | null;
  /** The delivered-to entity's jurisdiction: the `jurisdiction` fact. */
  readonly jurisdiction: string | null;
}

export interface JobSubjectSource {
  /** Null when the cause cannot be resolved (engagement removed); not a reason to
   *  crash a sweep over every other firm's work. */
  subjectOf(tenantId: string, jobId: string): Promise<JobSubject | null>;
}

/**
 * The seam an agent runs behind (T2.7's half; T2.8 adds tiers and guardrails).
 * A process must not break because an agent has not been built: with no agent
 * (`canRun` false) the step waits `blocked` for a PERSON, visibly.
 */
export interface AgentOutcomeDone {
  readonly done: true;
  /** How sure the machine is, 0 to 1 (T2.8). NOT optional: unknown must not read as
   *  sure. An agent that cannot score itself reports 0 and is escalated. */
  readonly confidence: number;
  /** What it produced, verbatim, kept forever beside what was applied (`build2.md`
   *  §5.2): the only accuracy signal that could justify moving a threshold. */
  readonly proposed: Record<string, unknown>;
}
export interface AgentOutcomeFailed {
  readonly done: false;
  /** Why, in actionable words; stored on the step, which goes `failed`. A failure
   *  records no run (the table holds what a machine PRODUCED). */
  readonly note: string;
}
export type AgentOutcome = AgentOutcomeDone | AgentOutcomeFailed;

export interface AgentRuntime {
  /** Whether an agent exists for this step at all. */
  canRun(stepKey: string): boolean;
  /** The model and prompt version, asked of the runtime (a failed run records it
   *  too), so a regression has something to blame and revert. */
  provenance(): { readonly model: string; readonly promptVersion: string };
  run(input: {
    readonly tenantId: string;
    readonly jobId: string;
    readonly stepKey: string;
  }): Promise<AgentOutcome>;
}

/**
 * The firm's published confidence thresholds (T2.8). Null (none published) is the
 * ordinary state: the caller uses `ASK_A_PERSON` (never commit, always propose),
 * never invented numbers.
 */
export interface PublishedTiers {
  readonly tiers: ConfidenceTiers;
  /** The `config.version` the run PINS, so "why was this allowed" survives a raised bar. */
  readonly versionId: string;
}

export interface TierSource {
  publishedTiers(tenantId: string): Promise<PublishedTiers | null>;
}

/** One attempt a machine made at one step, as it is written down. */
export interface NewAgentRun {
  readonly id: string;
  readonly tenantId: string;
  readonly jobId: string;
  readonly jobStepId: string;
  readonly confidence: number;
  /** The thresholds that APPLIED, copied: a CHECK cannot read config, and the bar moves. */
  readonly autoCommitAt: number;
  readonly reviewAt: number;
  readonly tierVersionId: string | null;
  readonly decision: AgentDecision;
  /** The template's `agent_with_approval`: a person regardless of the numbers. The
   *  guardrail CHECK reads it; "unsure" and "always checked" are different reasons. */
  readonly approvalRequired: boolean;
  readonly proposed: Record<string, unknown>;
  /** Equal to `proposed` on a commit; null while nobody has decided. */
  readonly applied: Record<string, unknown> | null;
  readonly model: string;
  readonly promptVersion: string;
}

export interface AgentRun extends NewAgentRun {
  readonly outcome: ProposalOutcome | null;
  readonly rejectedReason: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly createdAt: string;
}

/** What a person decided about a proposal. */
export interface RunDecision {
  readonly outcome: ProposalOutcome;
  /** What stands: equals the proposal for `accepted`, differs for `corrected`, absent
   *  for `rejected` (CHECKs, so the accuracy figure can be trusted). */
  readonly applied: Record<string, unknown> | null;
  readonly rejectedReason: string | null;
  readonly decidedBy: string;
  readonly decidedAt: string;
}

export interface AgentRunRepository {
  /** Write the run in one statement; the guardrail is a CHECK on this insert. */
  record(run: NewAgentRun): Promise<AgentRun>;
  /** The undecided run for a step, if any (the job screen; T2.9's queue). */
  openForStep(tenantId: string, jobStepId: string): Promise<AgentRun | null>;
  /** Every undecided run in one job, keyed by step id: one query, not one per row. */
  openForJob(tenantId: string, jobId: string): Promise<ReadonlyMap<string, AgentRun>>;
  /** Record a decision only where none exists (in SQL), so two clicks cannot
   *  overwrite each other. Null = already decided, not an error. */
  decide(tenantId: string, runId: string, decision: RunDecision): Promise<AgentRun | null>;
}

/**
 * The firm's time zone, which cuts a sweep's "today" (0071): the server's UTC day is
 * yesterday in India until 05:30. Satisfied by `PostgresFirmTimeZone`/`FakeFirmTimeZone`.
 */
export interface FirmTimeZone {
  timeZoneFor(tenantId: string): Promise<string>;
}

/** One mark to write (T6.15). `outcome` is never null: unticking is `clear`, which
 *  never INSERTS (absent and cleared rows both read as open). */
export interface NewStepCheckMark {
  readonly id: string;
  readonly tenantId: string;
  readonly jobStepId: string;
  /** The check a REVIEW mark is made under; null for a sub-step. */
  readonly stepApprovalId: string | null;
  readonly list: CheckListKind;
  readonly itemKey: string;
  /** Copied from the pinned template, so the row reads on its own. */
  readonly label: string;
  readonly outcome: MarkOutcome;
  /** The reason, on `not_applicable` only; null on `done`. */
  readonly note: string | null;
  readonly markedByUserId: string;
  readonly markedAt: string;
}

/** The line a clear is about: a step's sub-step, or one check's review point. */
export interface StepCheckLineRef {
  readonly tenantId: string;
  readonly list: CheckListKind;
  readonly jobStepId: string;
  readonly stepApprovalId: string | null;
  readonly itemKey: string;
}

/**
 * The marks on a step's two lists (T6.15, `delivery.job_step_check`). Reads are
 * whole (per job, per set of checks: no per-row lookup) and carry the marker's name.
 * No delete, and no DELETE grant: unticking nulls the outcome.
 *
 * A WRITE CARRIES ITS OWN PRECONDITION: Done or Approve can land between the
 * service's check and the write, so each write re-checks under a row lock (sub-step:
 * the step's row; review: the check's row), the same rows `JobStepRepository.transition`,
 * `StepApprovalRepository.openIfAbsent` and `decide` lock. A closed list writes nothing.
 */
export interface StepCheckRepository {
  /** Every mark on one job: both lists, every round of every check. */
  listForJob(tenantId: string, jobId: string): Promise<readonly StepCheckMark[]>;
  /** Every review mark under these checks, for the firm-wide queue. */
  listForApprovals(tenantId: string, approvalIds: readonly string[]): Promise<readonly StepCheckMark[]>;
  /**
   * Write or overwrite a line's mark. IDEMPOTENT: the same outcome and reason change
   * nothing, not even who marked it and when. Null (nothing written) when the list is
   * closed: a sub-step whose step is no longer waiting, is awaiting its check or was
   * just approved; a review point whose check is decided.
   */
  upsert(mark: NewStepCheckMark): Promise<StepCheckMark | null>;
  /** Untick: outcome, reason, marker and time back to null; no row or already open is
   *  left alone. False, nothing written, on the lists `upsert` answers null for. */
  clear(ref: StepCheckLineRef): Promise<boolean>;
}
