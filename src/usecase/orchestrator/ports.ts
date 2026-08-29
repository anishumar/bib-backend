// The ports the orchestrator needs from the world — the seams (T2.7). Owned by
// this use case, stated in our vocabulary; adapters in infrastructure/ implement
// them.
import type { JobStep, StepStatus } from "../../domain/orchestrator/model";

export interface NewJobStep {
  readonly id: string;
  readonly tenantId: string;
  readonly jobId: string;
  readonly stepKey: string;
  readonly label: string;
  readonly executor: string;
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
  readonly condition: { readonly fact: string; readonly equals: string } | null;
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
}
export interface AgentOutcomeFailed {
  readonly done: false;
  /** Why, in words somebody can act on. Stored on the step. */
  readonly note: string;
}
export type AgentOutcome = AgentOutcomeDone | AgentOutcomeFailed;

export interface AgentRuntime {
  /** Whether an agent exists for this step at all. */
  canRun(stepKey: string): boolean;
  run(input: {
    readonly tenantId: string;
    readonly jobId: string;
    readonly stepKey: string;
  }): Promise<AgentOutcome>;
}
