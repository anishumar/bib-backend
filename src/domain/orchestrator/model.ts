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
  /** Whose desk it sits on — expected to do it, as distinct from `performedBy`,
   *  who did. Null: nobody in particular, anybody inside the band may take it. */
  readonly assigneeUserId: string | null;
}

/** The grade band a template step names, as this domain needs it — satisfied
 *  structurally by `StepPerformer` from the config domain. */
export interface StepBand {
  readonly minGradeRank: number | null;
  readonly minGradeCode: string | null;
  readonly maxGradeRank: number | null;
  readonly maxGradeCode: string | null;
}

/**
 * Whether somebody of this rank may do a step with this band.
 *
 * No band means anybody. An UNGRADED person meets no band at all, for the
 * reason the verification rule gives: a grade is the value that decides who
 * may do what, and a plausible invented rank is worse than a null. Ends are
 * inclusive; a null end is open.
 */
export function withinBand(gradeRank: number | null, band: StepBand | null): boolean {
  if (band === null) return true;
  if (gradeRank === null) return false;
  if (band.minGradeRank !== null && gradeRank < band.minGradeRank) return false;
  if (band.maxGradeRank !== null && gradeRank > band.maxGradeRank) return false;
  return true;
}

/** The band in words, for a refusal — "Analyst to Senior Associate", "Manager or above". */
export function bandLabel(band: StepBand): string {
  const lo = band.minGradeCode ?? (band.minGradeRank === null ? null : `rank ${String(band.minGradeRank)}`);
  const hi = band.maxGradeCode ?? (band.maxGradeRank === null ? null : `rank ${String(band.maxGradeRank)}`);
  if (lo !== null && hi !== null) return lo === hi ? lo : `${lo} to ${hi}`;
  if (lo !== null) return `${lo} or above`;
  if (hi !== null) return `${hi} or below`;
  return "anybody";
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

/**
 * Whether a MACHINE produces the output — regardless of who signs it off.
 *
 * Both agent kinds do, and keeping this separate from `waitsForAPerson` is
 * T2.8's correction. The orchestrator used to branch on that one predicate
 * alone, so `agent_with_approval` was blocked before `agents.run` was ever
 * reached: the machine produced nothing and the person had nothing to approve.
 * The kind's whole purpose is that BOTH happen.
 *
 * So the two questions are genuinely different and are asked separately now:
 * `runsAMachine` decides whether to run one, `waitsForAPerson` decides whether
 * its answer may ever stand unattended.
 */
export function runsAMachine(executor: string): boolean {
  return executor === "agent" || executor === "agent_with_approval";
}

// ── a step's own lists: sub-steps and review points (T6.15, 0307) ─────────────

/**
 * Which of a step's two lists a mark belongs to.
 *
 *   checklist   the SUB-STEPS, ticked by whoever does the step, and all of
 *               them before it can be marked done
 *   review      the REVIEW POINTS, ticked by whoever checks it, and all of them
 *               before it can be approved (never before it can be sent back)
 *
 * The storage words, matching the CHECK in 0307; the screens say "sub-steps"
 * and "review points".
 */
export type CheckListKind = "checklist" | "review";

/** How a line was settled. `not_applicable` always carries a reason: the
 *  firm's own lists say "payroll information WHERE INCLUDED", and without a
 *  way to say it did not apply an associate must tick something that did not
 *  happen, and the record lies. */
export type MarkOutcome = "done" | "not_applicable";

export const MARK_OUTCOMES: readonly MarkOutcome[] = ["done", "not_applicable"];

export function isMarkOutcome(v: string): v is MarkOutcome {
  return (MARK_OUTCOMES as readonly string[]).includes(v);
}

/** The longest reason a "not applicable" may carry, trimmed. The CHECK in 0307
 *  holds the same number. */
export const NOT_APPLICABLE_NOTE_MAX = 500;

/**
 * One mark on one line, as stored (`delivery.job_step_check`).
 *
 * A REVIEW mark carries the check it was made under (`stepApprovalId`), so the
 * second round after a send-back starts with every review point open, and
 * "this took two goes" keeps what each round's checker ticked. A sub-step mark
 * carries none: the doer's ticks survive a send-back, because the work behind
 * them is still the work, and the doer changes them if the reason for sending
 * it back touches one.
 */
export interface StepCheckMark {
  readonly id: string;
  readonly tenantId: string;
  readonly jobStepId: string;
  readonly stepApprovalId: string | null;
  readonly list: CheckListKind;
  readonly itemKey: string;
  /** Copied from the pinned template when the mark was made, so the row reads
   *  on its own. */
  readonly label: string;
  /** Null when the line was ticked and then unticked. */
  readonly outcome: MarkOutcome | null;
  /** The reason, on `not_applicable` only. */
  readonly note: string | null;
  readonly markedByUserId: string | null;
  /** The marker's name as the account reads NOW (a read-time join, like every
   *  other name on a read model here). */
  readonly markedByName: string | null;
  readonly markedAt: string | null;
}

/** How a list stands, for the transition events: counts, and never a label or a
 *  reason, because the log cannot be erased and both are prose about a
 *  client's work. */
export interface ListTally {
  readonly total: number;
  readonly done: number;
  readonly notApplicable: number;
}

/**
 * The lines of a list that nobody has settled, in the list's own order.
 *
 * Driven by the TEMPLATE's lines, never by the marks: a line with no row is
 * open, and a row whose key the pinned template does not name (which cannot
 * happen, the version is frozen) is simply not a line of this list.
 */
export function openLines(
  lines: readonly { readonly key: string; readonly label: string }[],
  marks: ReadonlyMap<string, MarkOutcome | null>,
): readonly { readonly key: string; readonly label: string }[] {
  return lines.filter((l) => (marks.get(l.key) ?? null) === null);
}

export function tallyOf(
  lines: readonly { readonly key: string }[],
  marks: ReadonlyMap<string, MarkOutcome | null>,
): ListTally {
  let done = 0;
  let notApplicable = 0;
  for (const l of lines) {
    const outcome = marks.get(l.key) ?? null;
    if (outcome === "done") done += 1;
    if (outcome === "not_applicable") notApplicable += 1;
  }
  return { total: lines.length, done, notApplicable };
}

/**
 * The open lines named in a sentence, capped: "bank statements, sales data and
 * payroll information", or the first five and "and 3 more". A refusal that
 * names every open line of a forty-line list is a paragraph nobody reads; one
 * that names none makes the person hunt for them.
 */
export function namedList(labels: readonly string[], cap = 5): string {
  if (labels.length === 0) return "";
  if (labels.length <= cap) {
    if (labels.length === 1) return labels[0] ?? "";
    return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1] ?? ""}`;
  }
  return `${labels.slice(0, cap).join(", ")} and ${String(labels.length - cap)} more`;
}
