// The orchestrator domain: what one job's steps HAVE DONE and which may move next.
// `domain/config` owns what a template SAYS (shape, keys, DAG); neither imports the
// other, so `ReadyInput` states structurally what a `WorkflowStep` must provide.

/**
 * What has happened to one step of one job.
 *
 *   pending   not ready, or ready and not started
 *   running   an executor has it
 *   blocked   waiting on a person, or on an output a person must accept
 *   done      finished
 *   skipped   its condition did not hold, or a dependency was skipped
 *   failed    the executor could not complete it
 *
 * The engine's own vocabulary, the same at every firm: a union + schema CHECK, not
 * firm-owned rows like T3.1's work-item states.
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

/** A step that will not move again. `skipped` is NOT `done`: merging them makes a
 *  missing review read as a completed one. */
const SETTLED: readonly StepStatus[] = ["done", "skipped", "failed"];

export function isSettled(status: StepStatus): boolean {
  return SETTLED.includes(status);
}

/** A step whose dependents may proceed. Not `failed`: a machine giving up does not
 *  release the work waiting on it. */
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
  /** Who is expected to do it (`performedBy` is who did). Null: anybody inside the band. */
  readonly assigneeUserId: string | null;
}

/** A template step's grade band; satisfied structurally by config's `StepPerformer`. */
export interface StepBand {
  readonly minGradeRank: number | null;
  readonly minGradeCode: string | null;
  readonly maxGradeRank: number | null;
  readonly maxGradeCode: string | null;
}

/**
 * Whether somebody of this rank may do a step with this band. No band means anybody;
 * an UNGRADED person meets no band (an invented rank is worse than a null). Ends are
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

/** What this domain needs of a step DEFINITION; satisfied structurally by `WorkflowStep`. */
export interface ReadyInput {
  readonly key: string;
  readonly dependsOn: readonly string[];
}

/**
 * Which steps may start now: `pending`, with every dependency `done` or `skipped`.
 * Sequential, parallel and branch shapes all fall out of that one rule; a skip clears
 * its dependents, a failure holds them.
 *
 * A dependency with no row on this job (template edited since the job was created)
 * means NOT ready: wait rather than run a step whose precondition nobody can find.
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
 * Steps to skip because a dependency was skipped, transitively; without this,
 * everything downstream of a skipped branch waits forever. Only `pending` steps are
 * taken: a running one belongs to its executor.
 */
export function cascadeSkips(
  defs: readonly ReadyInput[],
  steps: readonly JobStep[],
): readonly string[] {
  const byKey = new Map(steps.map((s) => [s.stepKey, s]));
  const skipped = new Set(steps.filter((s) => s.status === "skipped").map((s) => s.stepKey));

  // Loop to a fixpoint: one pass over unordered defs moves a skip only one level.
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
 * The JOB's status, derived from its steps (never tracked, so it cannot drift):
 * all settled -> done; nothing can move -> blocked (waiting on a person, or a failure
 * holding its dependents: either way a human must look); otherwise running.
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

/** Whether an executor kind hands over to a person: `human`, and `agent_with_approval`
 *  (the machine produces, a PERSON decides). Stated once so no caller disagrees. */
export function waitsForAPerson(executor: string): boolean {
  return executor === "human" || executor === "agent_with_approval";
}

/**
 * Whether a MACHINE produces the output, regardless of sign-off. Kept apart from
 * `waitsForAPerson` (T2.8): branching on that alone blocked `agent_with_approval`
 * before `agents.run`, leaving the person nothing to approve.
 */
export function runsAMachine(executor: string): boolean {
  return executor === "agent" || executor === "agent_with_approval";
}

// ── a step's own lists: sub-steps and review points (T6.15, 0307) ─────────────

/**
 * Which of a step's lists a mark belongs to (storage words, CHECK in 0307):
 *   checklist   SUB-STEPS, ticked by the doer; all settled before done
 *   review      REVIEW POINTS, ticked by the checker; all settled before approve
 *               (never required to send back)
 */
export type CheckListKind = "checklist" | "review";

/** How a line was settled. `not_applicable` always carries a reason: lists say
 *  "payroll information WHERE INCLUDED", and without it the record would lie. */
export type MarkOutcome = "done" | "not_applicable";

export const MARK_OUTCOMES: readonly MarkOutcome[] = ["done", "not_applicable"];

export function isMarkOutcome(v: string): v is MarkOutcome {
  return (MARK_OUTCOMES as readonly string[]).includes(v);
}

/** Longest trimmed "not applicable" reason; the CHECK in 0307 holds the same number. */
export const NOT_APPLICABLE_NOTE_MAX = 500;

/**
 * One mark on one line (`delivery.job_step_check`). A REVIEW mark carries its check
 * (`stepApprovalId`), so each round after a send-back starts open and keeps what each
 * checker ticked. A sub-step mark carries none: the doer's ticks survive a send-back.
 */
export interface StepCheckMark {
  readonly id: string;
  readonly tenantId: string;
  readonly jobStepId: string;
  readonly stepApprovalId: string | null;
  readonly list: CheckListKind;
  readonly itemKey: string;
  /** Copied from the pinned template at marking, so the row reads on its own. */
  readonly label: string;
  /** Null when the line was ticked and then unticked. */
  readonly outcome: MarkOutcome | null;
  /** The reason, on `not_applicable` only. */
  readonly note: string | null;
  readonly markedByUserId: string | null;
  /** Read-time join: the marker's name as the account reads NOW. */
  readonly markedByName: string | null;
  readonly markedAt: string | null;
}

/** How a list stands, for events: counts only, never a label or reason (the log is
 *  unerasable and both are prose about a client's work). */
export interface ListTally {
  readonly total: number;
  readonly done: number;
  readonly notApplicable: number;
}

/** Unsettled lines in list order. Driven by the TEMPLATE's lines, never the marks: a
 *  line with no row is open; a mark the pinned template does not name is ignored. */
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

/** Open lines as a capped sentence for a refusal: "a, b and c", or the first five
 *  and "and 3 more". */
export function namedList(labels: readonly string[], cap = 5): string {
  if (labels.length === 0) return "";
  if (labels.length <= cap) {
    if (labels.length === 1) return labels[0] ?? "";
    return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1] ?? ""}`;
  }
  return `${labels.slice(0, cap).join(", ")} and ${String(labels.length - cap)} more`;
}
