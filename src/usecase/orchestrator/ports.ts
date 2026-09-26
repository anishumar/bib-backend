// The ports the orchestrator needs from the world — the seams (T2.7). Owned by
// this use case, stated in our vocabulary; adapters in infrastructure/ implement
// them.
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

/** What a step transition changes. Every field the schema's CHECKs care about
 *  moves together, so the adapter writes one statement and the database refuses
 *  an incoherent pair rather than storing it. */
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
   * Create a job's steps, all of them, in ONE statement.
   *
   * IDEMPOTENT BY CONTRACT. Everything the engine does is at-least-once — a
   * redelivered message, a worker restarted mid-sweep — and a second attempt
   * must find the steps already there and do nothing, rather than insert a
   * second copy of a process. `UNIQUE (job_id, step_key)` does the work; the
   * adapter turns the conflict into "already there".
   *
   * One statement rather than a loop, so a failure cannot leave a job holding
   * half a process — which would then run to completion looking finished.
   *
   * Returns whether it actually inserted, because the caller records an event
   * only when something happened.
   */
  createAllIfAbsent(
    steps: readonly NewJobStep[],
  ): Promise<{ readonly steps: readonly JobStep[]; readonly created: boolean }>;

  /** One job's steps, whole. Always read together — the readiness rule is over
   *  the set, not over a row. */
  listForJob(tenantId: string, jobId: string): Promise<readonly JobStep[]>;

  findByKey(tenantId: string, jobId: string, stepKey: string): Promise<JobStep | null>;

  /** By step id — how a check reaches its step. An approval names the step it
   *  is about, and the job and the key are facts ON that row rather than
   *  something the caller should have to carry back around. */
  findById(tenantId: string, stepId: string): Promise<JobStep | null>;

  /**
   * Move one step, only if it is still in the state the caller read.
   *
   * The `expect` is the whole point: two workers can sweep the same job at once,
   * and both can decide the same step is ready. A blind UPDATE would let both
   * start it and the second would overwrite the first's actor and timestamps.
   * Returns null when the row had already moved, which the caller reads as
   * "somebody else got there" and not as an error.
   *
   * `subStepKeys` (T6.15): the move is made only if every one of these
   * sub-steps is marked, done or not applicable, AS READ AFTER THE STEP'S ROW
   * IS LOCKED, and null comes back otherwise. The caller's own read of the
   * marks is for the sentence it shows; this is the one the move stands on,
   * because a tick taken back between that read and this write would otherwise
   * finish a step with a line open. Every mark write takes the same row lock
   * (`StepCheckRepository`), so the two cannot interleave. Empty means no
   * guard, and costs nothing.
   */
  transition(
    tenantId: string,
    stepId: string,
    expect: StepStatus,
    to: StepTransition,
    subStepKeys?: readonly string[],
  ): Promise<JobStep | null>;

  /** Move a step to somebody's desk, or off everybody's (null). Refused in
   *  SQL on a settled step — null back — so a race with a completion cannot
   *  re-open a finished row's desk. */
  assign(tenantId: string, stepId: string, assigneeUserId: string | null): Promise<JobStep | null>;

  /** Every open step on one person's desk, across jobs — "what is mine". */
  listOpenForUser(tenantId: string, userId: string): Promise<readonly JobStep[]>;
}

/**
 * What the owner rule needs to know about a job's steps (0301, then
 * 2026-09-27): the job's Dept, its client's SPOCs for that Dept, the client's
 * Key Manager and the person who signs for the firm, all in force on the day
 * and all active staff. The RULE is `resolveOwner` in the domain, the same
 * function the work item use case calls for the job's task, so a task and its
 * steps are always decided alike; this port only gathers the facts.
 *
 * THE JOB'S DEPT is the split code when the firm splits by Dept (or a team's
 * SPOCs when it splits by team), and otherwise the Dept of the job's
 * services: one Dept is that Dept, several is `several_depts`. Asking only the
 * split code was the bug that made this port change: a firm keeping a client's
 * work together has no split code, so every job's steps went to nobody while
 * its task went to the SPOC.
 */
export interface StepDeskResolver {
  ownerFactsFor(tenantId: string, jobId: string, onDate: string): Promise<StepOwnerFacts>;
}

/**
 * The owner rule's facts, and who holds the job's TASK now.
 *
 * A month's task is created when its period's job is (the period's start) and
 * the job's steps only when the job becomes runnable (its end: "comes after
 * close of month"). A Key Manager who hands the task out in between has
 * already decided who does the month, and the steps must follow that decision
 * rather than re-run the ladder and land back on the Key Manager. So the one
 * ACTIVE member of staff every open task of the job is on, or null when there
 * is no open task, one is on nobody's desk, or two are on different desks.
 */
export interface StepOwnerFacts extends OwnerFacts {
  readonly taskHolder: OwnerPerson | null;
}

/**
 * The workflow template a job should walk, and the version it is pinned to.
 *
 * Two reads, deliberately, and the difference is the whole of pinning:
 *
 *   `publishedTemplate` is what is IN FORCE — asked once, when a job starts.
 *   `pinnedTemplate` is what that job actually started on — asked every time
 *   afterwards, so editing a process never rewrites a job already walking it.
 *
 * Narrow on purpose: the orchestrator does not want to know what a config entry
 * is, only how to get a process out of one. Satisfied by the config adapter,
 * which is where that lives — so the two use cases never import each other, as
 * `RoleDirectory` and `AxisDirectory` already do.
 */
export interface TemplateStep {
  readonly key: string;
  readonly label: string;
  readonly executor: string;
  readonly dependsOn: readonly string[];
  /**
   * When this step applies at all, or null for always.
   *
   * Stated structurally rather than imported from `domain/config`, like every
   * other field here — but note it is the NORMALISED shape: a template body
   * published before operators existed carries `{ fact, equals }`, and the
   * config reader turns that into `op: "equals"` before it ever reaches this
   * port. The orchestrator only ever sees one shape.
   */
  readonly condition: {
    readonly fact: string;
    readonly op: string;
    readonly value: string | readonly string[];
  } | null;
  /** The `verification_policy` key that governs who checks this step once it is
   *  done, or null for a step nobody checks (T2.9). Every template published
   *  before T2.9 reads as null here, which is exactly what those processes
   *  meant. */
  readonly verificationPolicyKey: string | null;
  /** The grade band that may do this step (0301), or null for anybody. The
   *  config domain's `StepPerformer`, stated structurally like everything here. */
  readonly performer: {
    readonly minGradeRank: number | null;
    readonly minGradeCode: string | null;
    readonly maxGradeRank: number | null;
    readonly maxGradeCode: string | null;
  } | null;
  /** The step's sub-steps, ticked by whoever does it before it can be marked
   *  done (T6.15). Empty for every step published before the field existed,
   *  which is what those processes meant: the step is ticked as a whole. */
  readonly checklist: readonly { readonly key: string; readonly label: string }[];
  /** The step's review points, ticked by whoever CHECKS it before it can be
   *  approved (T6.15). Empty on a step that names no check. */
  readonly reviewPoints: readonly { readonly key: string; readonly label: string }[];
}

export interface ResolvedTemplate {
  /** The `config.version` id this came from — what the job pins. */
  readonly versionId: string;
  readonly label: string;
  readonly steps: readonly TemplateStep[];
}

export interface TemplateSource {
  /** The version in force for this key, or null when the firm has published
   *  none. Null is a real answer — a firm that has not written its process yet. */
  publishedTemplate(tenantId: string, key: string): Promise<ResolvedTemplate | null>;
  /** The version this job pinned, whatever is in force now. Null when the row
   *  no longer parses as a template — see `TemplateUnreadable` for why that is
   *  reported rather than papered over with today's process. */
  pinnedTemplate(tenantId: string, versionId: string): Promise<ResolvedTemplate | null>;
}

/**
 * What a job is FOR — the facts a template's conditions are evaluated against,
 * and the template key to use.
 *
 * One read rather than several, because a job resolves all of this at once when
 * it starts, and three round trips would be three chances to see a different
 * state than the first.
 *
 * Every field is nullable and every null is a real state: a service with no
 * process written, an entity whose jurisdiction was never registered, a service
 * that does not say how often it recurs. None of them is an error, and none of
 * them may be defaulted — see `evaluateCondition`.
 */
export interface JobSubject {
  /** The `workflow_template` key from the service this job delivers. */
  readonly workflowTemplateKey: string | null;
  /** `ServiceBody.recurrence` — the `recurrence` fact. */
  readonly recurrence: string | null;
  /** The delivered-to entity's jurisdiction — the `jurisdiction` fact. */
  readonly jurisdiction: string | null;
}

export interface JobSubjectSource {
  /** What this job is for, or null when its cause cannot be resolved — a job
   *  whose engagement was removed, which should not happen and is not a reason
   *  to crash a sweep over every other firm's work. */
  subjectOf(tenantId: string, jobId: string): Promise<JobSubject | null>;
}

/**
 * The seam an agent runs behind — the SMALL half of it. T2.8 is the agent
 * runtime proper (confidence tiers, guardrails, no auto-commit above a tier);
 * this is only what T2.7 needs to walk a graph that has agent steps in it.
 *
 * `canRun` exists because of a decision worth keeping: **a process must not
 * break because an agent has not been built.** A template may say a step is an
 * agent's before any agent exists for it — that is the ordinary state of this
 * product for a long while — and when it happens the step waits for a PERSON
 * rather than failing the job. The firm's work continues; the gap is visible
 * (an `agent` step sitting `blocked` is exactly that fact) and nobody has to
 * rewrite a template to keep working.
 */
export interface AgentOutcomeDone {
  readonly done: true;
  /**
   * How sure the machine is, 0 to 1 (T2.8).
   *
   * NOT optional, and that is the decision: a runtime that could omit it would
   * make "we do not know how sure it was" indistinguishable from "it was sure",
   * and the whole guardrail hangs off this number. An agent that genuinely
   * cannot score itself reports 0 and is escalated, which is the honest answer.
   */
  readonly confidence: number;
  /**
   * What it produced, verbatim, in whatever shape that agent's work has.
   *
   * Kept forever alongside what a person ended up applying — `build2.md` §5.2
   * names this as one of the demo's hardest-won rules: keeping only the
   * corrected value throws away the entire accuracy signal, which is the only
   * evidence that could ever justify moving a threshold.
   */
  readonly proposed: Record<string, unknown>;
}
export interface AgentOutcomeFailed {
  readonly done: false;
  /** Why, in words somebody can act on. Stored on the step.
   *
   *  A failure records no run: this table holds what a machine PRODUCED, and a
   *  machine that gave up produced nothing. The step goes `failed` with this
   *  note, exactly as it did before T2.8. */
  readonly note: string;
}
export type AgentOutcome = AgentOutcomeDone | AgentOutcomeFailed;

export interface AgentRuntime {
  /** Whether an agent exists for this step at all. */
  canRun(stepKey: string): boolean;
  /** What produced the answer — the model and the prompt version, together.
   *
   *  Asked of the runtime rather than carried on each outcome, because it is a
   *  property of the runtime and a failed run has to record it too. "Extraction
   *  got worse in March" needs something to blame and something to revert. */
  provenance(): { readonly model: string; readonly promptVersion: string };
  run(input: {
    readonly tenantId: string;
    readonly jobId: string;
    readonly stepKey: string;
  }): Promise<AgentOutcome>;
}

/**
 * The firm's confidence thresholds, as published (T2.8).
 *
 * Null when the firm has published none, which is the ordinary state and NOT an
 * error: the caller falls back to `ASK_A_PERSON` — never commit, always
 * propose — rather than to numbers this code invented. Same shape the discount
 * policy takes, and the reason turning T2.8 on changes no firm's behaviour.
 */
export interface PublishedTiers {
  readonly tiers: ConfidenceTiers;
  /** The `config.version` this came from — what the run PINS, so "why was this
   *  allowed" survives the firm raising its bar next quarter. */
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
  /** The thresholds that APPLIED, copied — see the migration. A CHECK cannot
   *  read config, and the firm's bar moves. */
  readonly autoCommitAt: number;
  readonly reviewAt: number;
  readonly tierVersionId: string | null;
  readonly decision: AgentDecision;
  /** Whether the firm asked for a person on this step whatever the numbers said
   *  — the template's `agent_with_approval`. Recorded because the guardrail
   *  CHECK needs it, and because "unsure" and "always checked" are different
   *  reasons for the same queue. */
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
  /** What actually stands. Must equal the proposal for `accepted`, differ for
   *  `corrected`, and be absent for `rejected` — enforced by CHECKs, because an
   *  accuracy figure nobody can trust is worse than no figure. */
  readonly applied: Record<string, unknown> | null;
  readonly rejectedReason: string | null;
  readonly decidedBy: string;
  readonly decidedAt: string;
}

export interface AgentRunRepository {
  /** Write the run and what it was allowed to do, in one statement. The
   *  guardrail is a CHECK on this insert, not a rule this code remembers. */
  record(run: NewAgentRun): Promise<AgentRun>;
  /** The undecided run for a step, if there is one — what the job screen shows
   *  a person and what T2.9's queue will route. */
  openForStep(tenantId: string, jobStepId: string): Promise<AgentRun | null>;
  /** Every undecided run in one job, keyed by step id. One query for the page,
   *  not one per row — the lookup-per-row "lists return read models" exists to
   *  prevent, and a job's steps are rendered together. */
  openForJob(tenantId: string, jobId: string): Promise<ReadonlyMap<string, AgentRun>>;
  /**
   * Record what a person decided.
   *
   * Only where nothing has been decided yet, in SQL, so two people clicking at
   * once cannot overwrite each other's answer — the guard `pinTemplate` makes
   * for the same reason. Returns null when somebody got there first, which the
   * caller reads as "already decided" and not as an error.
   */
  decide(tenantId: string, runId: string, decision: RunDecision): Promise<AgentRun | null>;
}

/**
 * Which calendar this firm's days are cut on (0071).
 *
 * A sweep has no caller to send its day, and the server's UTC day is
 * yesterday in India until 05:30 — a T-X task raised five and a half hours
 * late, a rung fired a day late. "Today" for a firm's own sweep is the day in
 * the firm's zone, the same answer the per-period spawn and the chaser give.
 * Structural: satisfied by `PostgresFirmTimeZone` and `FakeFirmTimeZone`.
 */
export interface FirmTimeZone {
  timeZoneFor(tenantId: string): Promise<string>;
}

/**
 * One mark to write on one line of a step's list (T6.15).
 *
 * `outcome` is never null here: unticking is `clear`, which never INSERTS a row
 * (an absent row and a cleared one both read as open, and a row for a line
 * nobody touched would be a record of nothing).
 */
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

/** Which line a clear is about: a sub-step of a step, or a review point of one
 *  check. */
export interface StepCheckLineRef {
  readonly tenantId: string;
  readonly list: CheckListKind;
  readonly jobStepId: string;
  readonly stepApprovalId: string | null;
  readonly itemKey: string;
}

/**
 * The marks on a step's two lists (T6.15, `delivery.job_step_check`).
 *
 * The READS are whole: every mark on a job in one query, and every mark on a
 * set of checks in one query, because the job page and the checks queue render
 * a screenful at once and a lookup per step or per check is the per-row read
 * this codebase has been caught by six times. Each mark carries the marker's
 * name from the same query.
 *
 * There is no delete, and `bib_app` holds no DELETE grant on the table:
 * unticking is a row whose outcome is null again, never a row removed, the
 * arrangement every other record of who-did-what in this schema has.
 *
 * ── A WRITE CARRIES ITS OWN PRECONDITION ────────────────────────────────────
 *
 * The service checks that a list is open to marks (the step waiting, nothing
 * waiting to be checked; the check still pending) and then writes, in a later
 * transaction. Between the two, somebody can press Done, or Approve, and a
 * mark landing after that would change a list somebody else has already
 * judged. So both writes check again, in their own transaction, under a row
 * lock: a SUB-STEP mark locks its step's row, and a REVIEW mark locks its
 * check's row, which are the rows the moves that read those lists lock too
 * (`JobStepRepository.transition`, `StepApprovalRepository.openIfAbsent` and
 * `decide`). A write that finds the list closed writes nothing and says so,
 * and the service then says why in words.
 */
export interface StepCheckRepository {
  /** Every mark on every step of one job, both lists, every round of every
   *  check. */
  listForJob(tenantId: string, jobId: string): Promise<readonly StepCheckMark[]>;
  /** Every review mark made under these checks. For the firm-wide queue, whose
   *  rows belong to many jobs. */
  listForApprovals(tenantId: string, approvalIds: readonly string[]): Promise<readonly StepCheckMark[]>;
  /**
   * Write a mark, or overwrite the one already on that line.
   *
   * IDEMPOTENT: writing the outcome and the reason the line already has
   * changes nothing, including who marked it and when. A second click must not
   * move the record of who ticked it to whoever clicked last.
   *
   * Null when the list is no longer open to marks: a sub-step whose step is
   * not waiting any more or is waiting to be checked (or has just been
   * approved), a review point whose check is decided. Nothing was written.
   */
  upsert(mark: NewStepCheckMark): Promise<StepCheckMark | null>;
  /** Untick a line: outcome, reason, marker and time all back to null. A line
   *  with no row, or one already open, is left as it is. False, with nothing
   *  written, on the same closed lists `upsert` answers null for. */
  clear(ref: StepCheckLineRef): Promise<boolean>;
}
