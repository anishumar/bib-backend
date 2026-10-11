// A finding: something a check says a person should look at (docs/FIN_BUILD_PLAN.md
// F4.2, F5.2). Pure.
//
// Two lanes, never mixed: `rule` is a fixed rule broken (GST at the wrong rate,
// a duplicate invoice, CPF over the ceiling) and counts toward the exception
// score; `pattern` is a comparison with the client's own history (a vendor at
// twelve times its usual amount) and is shown in its own panel and NEVER counted
// in that score (F5).
//
// A finding is a machine saying "check this". Only a person decides what it
// means (ground rule 2), and that decision is `fin.finding_decision`.
import type { Day } from "./lines";

export type FindingLane = "rule" | "pattern";

/** A machine fact on a finding: an amount as a decimal string, a count, a day.
 *  Never a sentence, and never personal data. */
export type FindingFact = string | number | boolean | null;

/** What a check produces. The store turns it into a `fin.finding` row, once. */
export interface FindingDraft {
  readonly lane: FindingLane;
  /** Stable dotted key naming the check, e.g. `doc.duplicate_invoice`,
   *  `payroll.cpf_ow_ceiling`, `pattern.spike`. The screen's words are keyed
   *  on it. */
  readonly checkKey: string;
  readonly clientPartyId: string;
  /** The month (or other period) the finding belongs to. */
  readonly periodStart: Day;
  readonly periodEnd: Day;
  /** The lines it is about. May be empty (a recurring vendor that did NOT
   *  bill this month has no line). */
  readonly lineIds: readonly string[];
  readonly facts: Readonly<Record<string, FindingFact>>;
  /** Same finding on a re-run produces the same key, so it is raised once. */
  readonly dedupeKey: string;
}
