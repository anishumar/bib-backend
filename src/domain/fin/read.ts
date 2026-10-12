// A read: what became of one file fin took in (docs/FIN_BUILD_PLAN.md F2.5,
// "Reading flow" in the wave 3 contract). Pure.
//
// One row per intake item (`fin.read`, 0386), in one of three states:
//
//   staged        its lines wait for a person to commit them (F2.8). Nothing
//                 counts until somebody does.
//   needs_person  a person must read it, and `problem` says why: no reader
//                 fits, a sheet layout nobody can map without guessing, a file
//                 the reader could not open, or figures that do not add up
//                 (`control_mismatch`: the lines are KEPT, so the person sees
//                 exactly what the machine read and where it disagrees).
//   failed        a reader threw on the file. A reader given the same bytes
//                 throws the same way, so the file is not offered again: it is
//                 on a person's desk instead of in a loop.
//
// A reader that answers `later` (the AI reader with no key) writes no row at
// all, so the next run offers the file again.
import { checkControl } from "./control";
import type { ControlCheck, ControlProblem } from "./control";
import type { ReadControl, ReadDraft, ReadProblem } from "./lines";

export type ReadStatus = "staged" | "needs_person" | "failed";

export const READ_STATUSES: readonly ReadStatus[] = ["staged", "needs_person", "failed"];

/** A line's own state. Every line starts `staged`; F2.8's commit and reject
 *  move it, with their own grant. */
export type LineStatus = "staged" | "committed" | "rejected";

export const LINE_STATUSES: readonly LineStatus[] = ["staged", "committed", "rejected"];

/** What `fin.read.control` holds: what the file printed, and what the check
 *  made of it. */
export interface StoredControl {
  readonly printed: ReadControl | null;
  readonly checked: readonly ControlCheck[];
  readonly problems: readonly ControlProblem[];
}

export interface ReadDecision {
  readonly status: Extract<ReadStatus, "staged" | "needs_person">;
  readonly problem: Extract<ReadProblem, "control_mismatch"> | null;
  readonly control: StoredControl;
  readonly controlOk: boolean;
}

/** Where a reader's draft goes: to staging when its own figures agree, to a
 *  person when they do not. Decided before anything is written, so the row
 *  is written once. */
export function decideRead(draft: Pick<ReadDraft, "lines" | "control">): ReadDecision {
  const result = checkControl(draft);
  return {
    status: result.ok ? "staged" : "needs_person",
    problem: result.ok ? null : "control_mismatch",
    control: { printed: draft.control, checked: result.checked, problems: result.problems },
    controlOk: result.ok,
  };
}
