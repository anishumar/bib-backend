// The orchestrator domain — what a job's steps ARE, and which of them may move
// next. Pure nouns and pure rules; imports nothing internal and nothing beyond
// the standard library (enforced by the arch test).
//
// ── WHAT THIS OWNS, AND WHAT IT DOES NOT ────────────────────────────────────
//
// `domain/config` owns what a template SAYS — its shape, its keys, that its
// dependencies form a DAG. This owns what one job's steps HAVE DONE, and the
// single rule that decides what happens next.
//
// The two never import each other; the arch wall forbids it and it would be
// wrong anyway. Instead `ReadyInput` below states, structurally, the little it
// needs to know about a step definition — a key and a dependency list — so a
// `WorkflowStep` from the config domain satisfies it without either side
// knowing about the other. TypeScript is structural; this is what that is for.

/**
 * What has happened to one step of one job.
 *
 *   pending   not ready, or ready and not started
 *   running   an executor has it
 *   blocked   waiting on a person, or on an output a person must accept
 *   done      finished
 *   skipped   its condition did not hold, or something it depends on was
 *             skipped
 *   failed    the executor could not complete it
 *
 * The engine's own vocabulary, identical at every firm — which is why it is a
 * union here and a CHECK in the schema rather than the rows T3.1's work-item
 * states are. A firm renaming `blocked` would be renaming something it does not
 * own.
 */
export type StepStatus = "pending" | "running" | "blocked" | "done" | "skipped" | "failed";

export const STEP_STATUSES: readonly StepStatus[] = [
  "pending",
  "running",
  "blocked",
  "done",
  "skipped",
  "failed",
];

export function isStepStatus(v: string): v is StepStatus {
  return (STEP_STATUSES as readonly string[]).includes(v);
}

/**
 * A step that will not move again.
 *
 * `skipped` is terminal and is NOT `done`, and keeping them apart is the point:
 * "we did not do this, and here is why" is a different fact from "we did this".
 * Collapsing them is how a missing review reads as a completed one a year later.
 */
const SETTLED: readonly StepStatus[] = ["done", "skipped", "failed"];

export function isSettled(status: StepStatus): boolean {
  return SETTLED.includes(status);
}

/** A step whose dependents may proceed. `failed` deliberately is not one: a
 *  machine giving up does not release the work that was waiting on it. */
const CLEARS_DEPENDENTS: readonly StepStatus[] = ["done", "skipped"];

export function clearsDependents(status: StepStatus): boolean {
  return CLEARS_DEPENDENTS.includes(status);
}

/** One step of one job, as this domain needs to reason about it. */
export interface JobStep {
  readonly id: string;
  readonly tenantId: string;
  readonly jobId: string;
  readonly stepKey: string;
  readonly label: string;
  readonly executor: string;
  readonly status: StepStatus;
  readonly outcomeNote: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly performedBy: string | null;
}

/** The little this domain needs to know about a step DEFINITION — satisfied
 *  structurally by `WorkflowStep` from the config domain, without either
 *  importing the other. */
export interface ReadyInput {
  readonly key: string;
  readonly dependsOn: readonly string[];
}

/**
 * Which steps may start now.
 *
 * A step is ready when it is `pending` and every step it depends on has SETTLED
 * in a way that clears its dependents — `done` or `skipped`. That one sentence
 * is the whole engine, and all three shapes the acceptance asks for fall out of
 * it rather than being special cases:
 *
 *   SEQUENTIAL  B depends on A, so B waits until A is done
 *   PARALLEL    B and C both depend on A, so both become ready together, and D
 *               depending on both waits for the slower one
 *   BRANCH      a skipped step CLEARS its dependents, so the rest of the graph
 *               carries on around it — which is why `skipped` and `failed` are
 *               different states. A failure holds its dependents; a skip does
 *               not.
 *
 * A step naming a dependency this job has no row for is NOT ready. That should
 * be impossible — the config validator refuses a template whose dependency does
 * not exist — but "impossible" and "cannot happen to a job created a year ago
 * against a template since edited" are different claims, and the safe direction
 * is to wait rather than to run a step whose precondition nobody can find.
 */
export function readySteps(
  defs: readonly ReadyInput[],
  steps: readonly JobStep[],
): readonly string[] {
  const byKey = new Map(steps.map((s) => [s.stepKey, s]));
  const ready: string[] = [];

  for (const def of defs) {
    const step = byKey.get(def.key);
    if (!step || step.status !== "pending") continue;

    const blocked = def.dependsOn.some((dep) => {
      const upstream = byKey.get(dep);
      return !upstream || !clearsDependents(upstream.status);
    });
    if (!blocked) ready.push(def.key);
  }
  return ready;
}

/**
 * Steps that must be skipped because something they depend on was skipped —
 * transitively.
 *
 * The other half of a branch, and the half that is easy to forget. Skipping the
 * conditional step alone leaves everything downstream of it waiting forever on a
 * step that will never be `done`, and a job that sits half-finished with nothing
 * saying why is exactly what this whole table exists to prevent.
 *
 * Only `pending` steps are taken: one already running has an executor holding
 * it, and yanking it out from under them is a decision nobody has taken.
 */
export function cascadeSkips(
  defs: readonly ReadyInput[],
  steps: readonly JobStep[],
): readonly string[] {
  const byKey = new Map(steps.map((s) => [s.stepKey, s]));
  const skipped = new Set(steps.filter((s) => s.status === "skipped").map((s) => s.stepKey));

  // Repeat until nothing new is found: a skip propagates down a chain, and one
  // pass over an arbitrarily ordered array only moves it one level.
  let changed = true;
  const cascaded: string[] = [];
  while (changed) {
    changed = false;
    for (const def of defs) {
      if (skipped.has(def.key)) continue;
      const step = byKey.get(def.key);
      if (!step || step.status !== "pending") continue;
      if (def.dependsOn.some((d) => skipped.has(d))) {
        skipped.add(def.key);
        cascaded.push(def.key);
        changed = true;
      }
    }
  }
  return cascaded;
}

/**
 * What the JOB's status should be, given its steps.
 *
 * Derived rather than tracked, because two places holding the same fact is two
 * places that drift — and the one that drifts is always the summary, which is
 * the one people read.
 *
 *   every step settled            -> done
 *   nothing can move, but not all settled -> blocked
 *   otherwise                     -> running
 *
 * "Nothing can move" covers both the ordinary case (everything open is waiting
 * on a person) and the unpleasant one (a step failed and its dependents can
 * never clear). Both are exactly the state where the engine has stopped and a
 * human has to look, which is what `blocked` means.
 */
export function jobStatusFrom(
  defs: readonly ReadyInput[],
  steps: readonly JobStep[],
): "running" | "blocked" | "done" {
  if (steps.length > 0 && steps.every((s) => isSettled(s.status))) return "done";
  if (steps.some((s) => s.status === "running")) return "running";
  if (readySteps(defs, steps).length > 0) return "running";
  return "blocked";
}

/**
 * Whether an executor kind finishes by itself or hands over to a person.
 *
 * `human` obviously waits. `agent_with_approval` waits too, and that is the
 * point of it being its own kind: the machine produces the output and a PERSON
 * decides whether it stands.
 *
 * Stated here, once, so the orchestrator, the API and any later routing rule
 * cannot disagree about it — the same argument `needsApproval` makes for the
 * dunning ladder.
 */
export function waitsForAPerson(executor: string): boolean {
  return executor === "human" || executor === "agent_with_approval";
}
