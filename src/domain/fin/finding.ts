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

// ── What a person decides (F4.2) ─────────────────────────────────────────────
//
// Added by the findings store (wave 3, agent C). `FindingDraft` above is the
// contract and is unchanged.

/** Ask the client, correct the line, or dismiss the finding. */
export type FindingDecision = "ask_client" | "correct" | "dismiss";

export const FINDING_DECISIONS: readonly FindingDecision[] = ["ask_client", "correct", "dismiss"];

/** Why a finding was dismissed. Codes rather than prose, so "how many did we
 *  call seasonal this year" is a count, and so F5.4 can learn from them. */
export type DismissReason = "price_change" | "one_off" | "seasonal" | "expected" | "other";

export const DISMISS_REASONS: readonly DismissReason[] = [
  "price_change",
  "one_off",
  "seasonal",
  "expected",
  "other",
];

/** A finding's status is its LATEST decision, and `open` while it has none. */
export type FindingStatus = "open" | FindingDecision;

export const FINDING_STATUSES: readonly FindingStatus[] = ["open", "ask_client", "correct", "dismiss"];

export const FINDING_LANES: readonly FindingLane[] = ["rule", "pattern"];

/** Longest reason a person may write; 0387's CHECK says the same. */
export const REASON_TEXT_MAX = 2000;

/** Longest dedupe key; 0387's CHECK says the same. */
export const DEDUPE_KEY_MAX = 500;

/** `doc.duplicate_invoice`: dotted, lower case, at least two parts. 0387's
 *  CHECK on `check_key` is the same pattern. */
export const CHECK_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export interface DecisionInput {
  readonly decision: FindingDecision;
  readonly reasonCode: DismissReason | null;
  readonly reasonText: string | null;
}

export type DecisionProblem =
  | "dismissal_needs_reason"
  | "other_needs_words"
  | "reason_only_on_dismissal"
  | "reason_too_long";

/** "Blank" is the whitespace JavaScript's `trim()` strips: 0308's definition,
 *  which 0387's CHECK spells as code points. */
export function isBlank(text: string): boolean {
  return text.trim() === "";
}

/** The decision as it is stored: the reason trimmed, and a blank one read as
 *  none. */
export function normaliseDecision(input: DecisionInput): DecisionInput {
  const text = input.reasonText === null ? null : input.reasonText.trim();
  return { ...input, reasonText: text === null || text === "" ? null : text };
}

/**
 * What is wrong with a decision, or null. Read on the NORMALISED input. Mirrors
 * 0387's two CHECKs exactly: a dismissal names a code and nothing else does,
 * `other` says why in words, and words come only with a dismissal.
 */
export function decisionProblem(input: DecisionInput): DecisionProblem | null {
  if (input.decision === "dismiss") {
    if (input.reasonCode === null) return "dismissal_needs_reason";
    if (input.reasonCode === "other" && input.reasonText === null) return "other_needs_words";
  } else if (input.reasonCode !== null || input.reasonText !== null) {
    return "reason_only_on_dismissal";
  }
  if (input.reasonText !== null && input.reasonText.length > REASON_TEXT_MAX) return "reason_too_long";
  return null;
}

/** The status a list of decisions gives a finding, newest first. */
export function statusOf(decisionsNewestFirst: readonly { readonly decision: FindingDecision }[]): FindingStatus {
  return decisionsNewestFirst[0]?.decision ?? "open";
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What is wrong with a draft the store is asked to keep, as a sentence naming
 * the field, or null. A check that produces one of these has a bug; the store
 * refuses it rather than writing a row the screen cannot read.
 */
export function findingDraftProblem(d: FindingDraft): string | null {
  if (!FINDING_LANES.includes(d.lane)) return `lane "${d.lane}" is not rule or pattern`;
  if (!CHECK_KEY_PATTERN.test(d.checkKey)) return `checkKey "${d.checkKey}" is not a dotted lower-case key`;
  if (d.clientPartyId.trim() === "") return "clientPartyId is empty";
  if (!DAY.test(d.periodStart) || !DAY.test(d.periodEnd)) {
    return `the period ${d.periodStart} to ${d.periodEnd} is not two days`;
  }
  if (d.periodEnd < d.periodStart) return `the period ends (${d.periodEnd}) before it starts (${d.periodStart})`;
  if (d.dedupeKey.length === 0 || d.dedupeKey.length > DEDUPE_KEY_MAX) {
    return `dedupeKey is ${String(d.dedupeKey.length)} characters; it must be 1 to ${String(DEDUPE_KEY_MAX)}`;
  }
  for (const [key, value] of Object.entries(d.facts)) {
    const kind = typeof value;
    if (value !== null && kind !== "string" && kind !== "number" && kind !== "boolean") {
      return `fact "${key}" is a ${kind}; a fact is a string, a number, a boolean or null`;
    }
    if (kind === "number" && !Number.isFinite(value)) return `fact "${key}" is not a finite number`;
  }
  return null;
}
