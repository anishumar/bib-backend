// The ports the orchestrator needs from the world — the seams (T2.7). Owned by
// this use case, stated in our vocabulary; adapters in infrastructure/ implement
// them.
import type { JobStep, StepStatus } from "../../domain/orchestrator/model";
import type {
  AgentDecision,
  ConfidenceTiers,
  ProposalOutcome,
} from "../../domain/agent/model";

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
   */
  transition(
    tenantId: string,
    stepId: string,
    expect: StepStatus,
    to: StepTransition,
  ): Promise<JobStep | null>;

  /** Move a step to somebody's desk, or off everybody's (null). Refused in
   *  SQL on a settled step — null back — so a race with a completion cannot
   *  re-open a finished row's desk. */
  assign(tenantId: string, stepId: string, assigneeUserId: string | null): Promise<JobStep | null>;

  /** Every open step on one person's desk, across jobs — "what is mine". */
  listOpenForUser(tenantId: string, userId: string): Promise<readonly JobStep[]>;
}

/**
 * Whose desk a job's steps default to (0301): the SPOC for the job's Dept on
 * the job's client, in force on the day. ONE user id or null — two SPOCs on a
 * Dept is a real state, and the default is then nobody's until a person
 * chooses. Read directly from the rows by the adapter rather than through the
 * work item use case, which owns the same lookup for the umbrella task: the
 * two use cases must not import each other.
 */
export interface StepDeskResolver {
  spocFor(tenantId: string, jobId: string, onDate: string): Promise<string | null>;
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
