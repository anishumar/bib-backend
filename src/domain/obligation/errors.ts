// Sentinel errors — the closed vocabulary of ways an obligation operation
// fails. They live in the domain so the meaning is owned here; the api layer
// maps them to HTTP status codes (domainerr.ts). Match with `instanceof`, never
// a string search.
//
// A new error FAMILY needs a line in `api/domainerr.ts` on the same commit —
// G3.3 shipped `StaffGradeError` without one and every refusal answered 500
// instead of 400/404/409, which unit tests cannot see.
//
// ── THE TONE THESE MESSAGES ARE WRITTEN IN ─────────────────────────────────
//
// A rule here is a statutory due date, and the person reading the refusal is a
// partner deciding what their clients owe. So every message says what is wrong
// AND what to do about it, in the firm's terms rather than the schema's — a
// refusal a partner cannot act on just becomes a support ticket.

import { longDay } from "../day";
import { countryCodeProblem } from "../country";

export class ObligationError extends Error {
  constructor(
    readonly code: ObligationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type ObligationErrorCode =
  | "TEMPLATE_NOT_FOUND"
  | "TEMPLATE_NAME_REQUIRED"
  | "INVALID_JURISDICTION"
  | "INVALID_RECURRENCE"
  | "INVALID_FISCAL_YEAR_START"
  | "INVALID_PERIOD_BASIS"
  | "INVALID_DUE_RULE"
  | "INCOMPLETE_DUE_RULE"
  | "UNRESOLVED_REASON_REQUIRED"
  | "UNRESOLVED_REASON_NOT_ALLOWED"
  | "INVALID_LEAD_TIME"
  | "INVALID_RULE_PACK"
  | "INVALID_RULE_STATUS"
  | "TEMPLATE_KEY_TAKEN"
  | "TEMPLATE_RETIRED"
  | "SERVICE_NOT_FOUND"
  | "EXCEPTION_NOT_FOUND"
  | "INVALID_PERIOD_END_MONTH"
  | "EXCEPTION_NOTE_REQUIRED"
  | "EXCEPTION_MONTH_TAKEN"
  | "EXCEPTION_ON_EVENT_RULE"
  | "NO_INITIAL_STATE"
  | "NO_FILED_STATE"
  | "NO_MISSED_STATE"
  | "NO_RESOLUTION_STATE"
  | "OBLIGATION_NOT_FOUND"
  | "INVALID_WINDOW"
  | "RESOLUTION_OPTION_NOT_FOUND"
  | "RESOLUTION_OPTION_RETIRED"
  | "RESOLUTION_REASON_REQUIRED"
  | "ALREADY_DECIDED"
  | "NOT_AWAITING_DECISION"
  | "INVALID_VOCABULARY_CODE"
  | "VOCABULARY_CODE_TAKEN"
  | "STATE_NOT_FOUND"
  | "CONFLICTING_STATE_FLAGS"
  | "LAST_INITIAL_STATE"
  | "LAST_DESTINATION_STATE"
  | "INVALID_SORT_ORDER"
  | "PERIOD_SHAPE_LOCKED"
  | "INVALID_CUTOVER"
  | "CUTOVER_BEFORE_START"
  | "ALREADY_SUPERSEDED"
  | "SUCCESSOR_NEEDS_ITS_OWN_PACK"
  | "FILING_NOT_LINKABLE";

// ── the rule ───────────────────────────────────────────────────────────────

export class TemplateNotFound extends ObligationError {
  constructor(ref: string) {
    super("TEMPLATE_NOT_FOUND", `No compliance rule ${JSON.stringify(ref)} at this firm`);
  }
}

export class TemplateNameRequired extends ObligationError {
  constructor() {
    super(
      "TEMPLATE_NAME_REQUIRED",
      `A rule needs the name of the filing: "GSTR-3B", "TDS deposit", "AOC-4". It is what ` +
        `appears on the calendar and on the task raised from it.`,
    );
  }
}

export class InvalidJurisdiction extends ObligationError {
  constructor(value: string) {
    super(
      "INVALID_JURISDICTION",
      countryCodeProblem(value),
    );
  }
}

export class InvalidRecurrence extends ObligationError {
  constructor(value: string) {
    super(
      "INVALID_RECURRENCE",
      `Recurrence ${JSON.stringify(value)} must be one of monthly, quarterly, half_yearly, ` +
        `annual or event. "event" means the filing is triggered by something happening (a ` +
        `share allotment, a director change) and produces no calendar entries, because ` +
        `nothing in this system yet knows the event occurred.`,
    );
  }
}

export class InvalidPeriodBasis extends ObligationError {
  constructor(value: string) {
    super(
      "INVALID_PERIOD_BASIS",
      `A filing's periods follow the rule's own year ("rule_calendar") or the client's year end ` +
        `("client_year_end"), not ${JSON.stringify(value)}.`,
    );
  }
}

export class InvalidFiscalYearStart extends ObligationError {
  constructor(month: number) {
    super(
      "INVALID_FISCAL_YEAR_START",
      `The financial year has to start in a month 1-12, not ${JSON.stringify(month)}. India is ` +
        `4, and it matters: an Indian quarter runs Apr-Jun, so a rule left on 1 would put ` +
        `every quarterly filing in the wrong period.`,
    );
  }
}

export class InvalidDueRule extends ObligationError {
  constructor(value: string) {
    super(
      "INVALID_DUE_RULE",
      `Due rule ${JSON.stringify(value)} must be "day_of_month" (so many months after the ` +
        `period ends, then a day of that month) or "days_after" (so many days after the ` +
        `period ends).`,
    );
  }
}

export class IncompleteDueRule extends ObligationError {
  constructor(kind: string, missing: string) {
    super(
      "INCOMPLETE_DUE_RULE",
      `A "${kind}" rule needs ${missing}. A half-stated rule cannot produce a date, and a ` +
        `rule that produces no date silently produces no calendar.`,
    );
  }
}

export class UnresolvedReasonRequired extends ObligationError {
  constructor() {
    super(
      "UNRESOLVED_REASON_REQUIRED",
      `A rule with no due formula needs a reason saying what is missing: "depends on the AGM ` +
        `date", "State-specific", "working days, and we hold no holiday calendar". The reason ` +
        `is what the rules screen shows in place of a date, so a partner can tell an ` +
        `unfinished rule from a broken system.`,
    );
  }
}

export class UnresolvedReasonNotAllowed extends ObligationError {
  constructor() {
    super(
      "UNRESOLVED_REASON_NOT_ALLOWED",
      `This rule computes a date, so it cannot also carry a reason for not computing one. ` +
        `Clear the reason, or clear the due formula.`,
    );
  }
}

export class InvalidLeadTime extends ObligationError {
  constructor(days: number) {
    super(
      "INVALID_LEAD_TIME",
      `Lead time ${JSON.stringify(days)} must be zero or more whole days. It is T-X: how long ` +
        `before the statutory date the firm wants the work to start, and it is the date the ` +
        `task appears on. Zero means the task appears on the statutory date itself.`,
    );
  }
}

export class InvalidRulePack extends ObligationError {
  constructor(value: string) {
    super(
      "INVALID_RULE_PACK",
      `Rule pack ${JSON.stringify(value)} cannot be blank. It names the version of the rules ` +
        `this came from: "gst-in@2026.07", and it is part of the rule's identity, so ` +
        `revising a rule means a new pack rather than an edit. Without it, "why was this due ` +
        `then?" has no answer.`,
    );
  }
}

export class InvalidRuleStatus extends ObligationError {
  constructor(value: string) {
    super(
      "INVALID_RULE_STATUS",
      `Status ${JSON.stringify(value)} must be "unconfirmed" or "confirmed". Confirming a rule ` +
        `is a partner saying they have checked this date against the statute: the shipped ` +
        `dates came from a document, not from the firm.`,
    );
  }
}

export class InvalidCutover extends ObligationError {
  constructor(value: string) {
    super(
      "INVALID_CUTOVER",
      `${JSON.stringify(value)} is not a day. The date a law changes must be written ` +
        `YYYY-MM-DD, because it is compared against the first day of a filing PERIOD: ` +
        `August's return is August's law even though it falls due in September.`,
    );
  }
}

export class CutoverBeforeStart extends ObligationError {
  constructor(cutover: string, start: string) {
    super(
      "CUTOVER_BEFORE_START",
      `This rule only began governing periods from ${start}, so a change taking effect ` +
        `${cutover} would leave it governing nothing at all. If the earlier rule was wrong, ` +
        `correct it rather than superseding it: its dates were never confirmed against the ` +
        `statute in the first place.`,
    );
  }
}

export class AlreadySuperseded extends ObligationError {
  constructor(name: string, endsOn: string) {
    super(
      "ALREADY_SUPERSEDED",
      `${name} already hands over on ${longDay(endsOn)}, so it is not the rule in force. Amend the ` +
        `one that governs periods from then on: superseding this row a second time would leave ` +
        `two successors covering the same periods, which is two filings for one return.`,
    );
  }
}

export class SuccessorNeedsItsOwnPack extends ObligationError {
  constructor(pack: string) {
    super(
      "SUCCESSOR_NEEDS_ITS_OWN_PACK",
      `The new rule needs a rule pack of its own: ${JSON.stringify(pack)} is the one it ` +
        `replaces. A pack is part of a rule's identity, which is what lets a filing made last ` +
        `year still name the version it was due under. Try dating it, as the shipped packs do.`,
    );
  }
}

export class PeriodShapeLocked extends ObligationError {
  constructor(field: string, instanceCount: number) {
    super(
      "PERIOD_SHAPE_LOCKED",
      `${field} decides where a period STARTS and ends, and this rule has already produced ` +
        `${String(instanceCount)} filing${instanceCount === 1 ? "" : "s"} that are keyed on ` +
        `those boundaries. Changing it now would orphan every one of them: last quarter's ` +
        `return would stop matching any quarter. Retire this rule and write a new one instead; ` +
        `the retired row goes on explaining the filings it produced.`,
    );
  }
}

/**
 * The same filing written twice.
 *
 * Until T6.16 this told the writer to revise under a new pack and retire the
 * old rule, which was library advice for a library screen. The catalogue's
 * "Write a new filing" reaches it now, and there the likeliest cause is a
 * partner writing, for a second service, a filing the firm already has, when
 * the dropdown beside the button offers it. Following the old advice would
 * have been worse than unhelpful: retiring the rule stops the filing on every
 * other service that carries it. So it names the filing and points at the
 * list, and keeps the law-changed route for the case that really is a
 * revision.
 */
export class TemplateKeyTaken extends ObligationError {
  constructor(jurisdiction: string, name: string, rulePack: string) {
    super(
      "TEMPLATE_KEY_TAKEN",
      `Your firm's library already holds a filing named ${JSON.stringify(name)} for ` +
        `${jurisdiction} companies, in pack ${JSON.stringify(rulePack)}. A filing is written ` +
        `once and can be on any number of services, so to put it on a service, choose it from ` +
        `"Add a filing" on that service in the Catalogue instead of writing it again. If the law ` +
        `changed, record it on the filing's row in the library with "The law changed", so the ` +
        `filings already made keep the dates they were made with.`,
    );
  }
}

export class TemplateRetired extends ObligationError {
  constructor(name: string) {
    super(
      "TEMPLATE_RETIRED",
      `Rule ${JSON.stringify(name)} has been retired and no longer generates. Reactivate it, ` +
        `or add its replacement under a new rule pack.`,
    );
  }
}

export class ServiceNotFound extends ObligationError {
  constructor(ref: string) {
    super(
      "SERVICE_NOT_FOUND",
      `No catalogue service ${JSON.stringify(ref)} at this firm. A compliance filing is added ` +
        `to a service the firm sells, so the calendar knows which clients owe it. Pick one of ` +
        `the services in the Catalogue, or define the service there first.`,
    );
  }
}

// ── the exception ──────────────────────────────────────────────────────────

export class ExceptionNotFound extends ObligationError {
  constructor(ref: string) {
    super("EXCEPTION_NOT_FOUND", `No exception ${JSON.stringify(ref)} on this rule`);
  }
}

export class InvalidPeriodEndMonth extends ObligationError {
  constructor(month: number) {
    super(
      "INVALID_PERIOD_END_MONTH",
      `An exception is keyed on the calendar month the filed PERIOD ends in, 1-12, not ` +
        `${JSON.stringify(month)}. March is 3: that is the month of the deduction, not the ` +
        `month it is due, because the due month is exactly what the exception changes.`,
    );
  }
}

export class ExceptionNoteRequired extends ObligationError {
  constructor() {
    super(
      "EXCEPTION_NOTE_REQUIRED",
      `An exception needs a note saying why this period is different: "March TDS is due 30 ` +
        `April by statute". Without it a partner checking the calendar against the statute ` +
        `cannot tell a real carve-out from somebody's typo.`,
    );
  }
}

export class ExceptionMonthTaken extends ObligationError {
  constructor(month: number) {
    super(
      "EXCEPTION_MONTH_TAKEN",
      `This rule already has an exception for periods ending in month ${month}. Two would make ` +
        `the due date depend on row order, which is not a rule at all: edit the existing one.`,
    );
  }
}

export class ExceptionOnEventRule extends ObligationError {
  constructor() {
    super(
      "EXCEPTION_ON_EVENT_RULE",
      `An event-driven rule has no periods, so there is no period-month for an exception to ` +
        `apply to.`,
    );
  }
}

// ── generating ─────────────────────────────────────────────────────────────

export class NoInitialState extends ObligationError {
  constructor() {
    super(
      "NO_INITIAL_STATE",
      `This firm has no obligation state marked as the starting one, so a generated filing has ` +
        `nowhere to begin. Every firm is seeded with one ("Pending") and the product refuses to ` +
        `unmark the last one, so this means the states were changed outside it: mark one as ` +
        `the starting state on the compliance vocabulary screen.`,
    );
  }
}

/**
 * Nowhere for a finished filing to land.
 *
 * Raised rather than swallowed, and that is the decision worth stating: the
 * alternative — quietly leaving the obligation open — is the silent failure
 * this whole module is built against, and it would be invisible on exactly the
 * rows a firm most needs to trust. A firm cannot reach this by accident: the
 * seed ships the state and the database allows at most one. Since T3.3 there IS
 * a screen — `/admin/obligation-vocabulary` — so the message may finally name
 * it, which it deliberately did not while there was none.
 */
export class NoFiledState extends ObligationError {
  constructor() {
    super(
      "NO_FILED_STATE",
      `This firm has no obligation state marked as the filed one, so a completed filing has ` +
        `nowhere to land and the calendar would keep showing it as open. Every firm is seeded ` +
        `with one ("Filed"): mark one of your compliance states as the filed one on the ` +
        `compliance vocabulary screen.`,
    );
  }
}

export class NoMissedState extends ObligationError {
  constructor() {
    super(
      "NO_MISSED_STATE",
      `This firm has no obligation state marked as the missed one, so a deadline that passes ` +
        `has nowhere to go and nothing would ever reach the decision queue. Every firm is ` +
        `seeded with one ("Missed"): mark one of your compliance states as the missed one on ` +
        `the compliance vocabulary screen. It has to be a state that needs a decision, which ` +
        `is what puts the filing in front of a partner rather than quietly filing it away.`,
    );
  }
}

export class NoResolutionState extends ObligationError {
  constructor() {
    super(
      "NO_RESOLUTION_STATE",
      `This firm has no obligation state marked as the resolution one, so a filing a partner ` +
        `has decided will never be made has nowhere to end. Every firm is seeded with one ` +
        `("Resolved"): mark one of your compliance states as the resolution one on the ` +
        `compliance vocabulary screen. Only a state that ends the matter can be it.`,
    );
  }
}

// ── the decision ───────────────────────────────────────────────────────────

export class ResolutionOptionNotFound extends ObligationError {
  constructor(ref: string) {
    super(
      "RESOLUTION_OPTION_NOT_FOUND",
      `No resolution option ${JSON.stringify(ref)} at this firm. The options are the firm's ` +
        `own list of answers to a passed deadline: file provisionally, accept the late fee, ` +
        `file a nil return, and they are edited on the compliance vocabulary screen.`,
    );
  }
}

export class ResolutionOptionRetired extends ObligationError {
  constructor(name: string) {
    super(
      "RESOLUTION_OPTION_RETIRED",
      `${JSON.stringify(name)} is no longer one of this firm's resolution options. Decisions ` +
        `already recorded against it stay exactly as they were: a retired option is one the ` +
        `firm has stopped choosing, not one it never chose. Pick a current option.`,
    );
  }
}

export class ResolutionReasonRequired extends ObligationError {
  constructor() {
    super(
      "RESOLUTION_REASON_REQUIRED",
      `Say why. In eighteen months nobody remembers why a late fee was accepted rather than a ` +
        `provisional filing made, and that is exactly the thing worth knowing: it is what ` +
        `answers the client who asks what the penalty was for. The option says what was done; ` +
        `this says why.`,
    );
  }
}

export class AlreadyDecided extends ObligationError {
  constructor() {
    super(
      "ALREADY_DECIDED",
      `Somebody has already decided what happens about this deadline. A decision is not ` +
        `overwritten: that would destroy the only record of what was originally chosen and ` +
        `why. If the decision needs to change, record the new one against the filing it ` +
        `produces.`,
    );
  }
}

export class NotAwaitingDecision extends ObligationError {
  constructor(stateName: string) {
    super(
      "NOT_AWAITING_DECISION",
      `This filing is ${JSON.stringify(stateName)}, which is not a state waiting on a ` +
        `decision. Only a deadline that has actually passed undischarged reaches the queue: ` +
        `if this one is late and is not here, the nightly sweep has not run yet.`,
    );
  }
}

// ── the firm's own vocabulary ──────────────────────────────────────────────

export class StateNotFound extends ObligationError {
  constructor(ref: string) {
    super("STATE_NOT_FOUND", `No obligation state ${JSON.stringify(ref)} at this firm`);
  }
}

export class InvalidVocabularyCode extends ObligationError {
  constructor(value: string) {
    super(
      "INVALID_VOCABULARY_CODE",
      `${JSON.stringify(value)} is not a usable handle. Use lower case letters, digits and ` +
        `underscores: "awaiting_client". It is the firm's stable handle for this row and is ` +
        `never shown to anybody; the NAME is what appears on screen and may be changed freely.`,
    );
  }
}

export class VocabularyCodeTaken extends ObligationError {
  constructor(what: string, code: string) {
    super(
      "VOCABULARY_CODE_TAKEN",
      `This firm already has ${what === "state" ? "an obligation state" : "a resolution option"} ` +
        `with the handle ${JSON.stringify(code)}. Rename the existing one, or bring it back if ` +
        `it was retired.`,
    );
  }
}

export class InvalidSortOrder extends ObligationError {
  constructor(value: number) {
    super(
      "INVALID_SORT_ORDER",
      `Sort order ${JSON.stringify(value)} must be a whole number. It only decides the order ` +
        `things appear in; gaps are fine and are the point: leave room to insert one later.`,
    );
  }
}

/**
 * Two flags that cannot both be true of one state.
 *
 * A single error carrying a SENTENCE rather than one class per pair. The pairs
 * are not interesting to a caller — the reason is, and every one of these
 * refusals is read by a partner rearranging their own vocabulary, who needs to
 * know which tick to move rather than which constraint fired.
 */
export class ConflictingStateFlags extends ObligationError {
  constructor(why: string) {
    super("CONFLICTING_STATE_FLAGS", why);
  }
}

/**
 * The firm is about to end up with nowhere for something to go.
 *
 * One error for the three destinations that are not `initial`, each carrying
 * its OWN consequence in the sentence — because "you cannot untick this" is
 * useless and "nothing would ever reach your decision queue again" is not. Each
 * of these silently disables a whole mechanism: a firm would see filings that
 * never close, or deadlines that pass and are never asked about, with no error
 * anywhere. The flag can still MOVE — marking another state clears this one in
 * the same statement — so this refuses only leaving the firm with none.
 */
export class LastDestinationState extends ObligationError {
  constructor(which: "filed" | "missed" | "resolution") {
    super(
      "LAST_DESTINATION_STATE",
      which === "filed"
        ? `this is the state a completed filing lands in, and a firm cannot have none: every ` +
            `filing your team finishes would stay showing as open on the calendar. Mark another ` +
            `state as the filed one first; that moves the flag in one step.`
        : which === "missed"
          ? `this is the state a passed deadline moves to, and a firm cannot have none: ` +
              `nothing would ever reach the decision queue again, and a missed filing would ` +
              `sit on the calendar with nobody asked about it. Mark another state as the ` +
              `missed one first; that moves the flag in one step.`
          : `this is the state a filing ends in when a partner decides it will never be made, ` +
              `and a firm cannot have none: that decision would have nowhere to land. Mark ` +
              `another state as the resolution one first; that moves the flag in one step.`,
    );
  }
}

export class LastInitialState extends ObligationError {
  constructor() {
    super(
      "LAST_INITIAL_STATE",
      `This is the state new filings start in, and a firm cannot have none: every obligation ` +
        `the calendar generates would have nowhere to begin. Mark another state as the ` +
        `starting one first; doing that moves the flag in one step, so there is never a moment ` +
        `with none.`,
    );
  }
}

export class ObligationNotFound extends ObligationError {
  constructor(ref: string) {
    super("OBLIGATION_NOT_FOUND", `No obligation ${JSON.stringify(ref)} at this firm`);
  }
}

export class InvalidWindow extends ObligationError {
  constructor(from: string, to: string) {
    super(
      "INVALID_WINDOW",
      `The window ${JSON.stringify(from)}..${JSON.stringify(to)} is not a pair of dates with ` +
        `the earlier one first. Dates are YYYY-MM-DD and name a day, never an instant.`,
    );
  }
}

/**
 * A task cannot be made the one that files this filing, or taken off it
 * (audit 2026-10-03, CA#36). The sentence says which of the reasons it is,
 * because each is fixed somewhere different.
 */
export class FilingNotLinkable extends ObligationError {
  constructor(why: string) {
    super("FILING_NOT_LINKABLE", why);
  }
}
