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
  | "OBLIGATION_NOT_FOUND"
  | "INVALID_WINDOW";

// ── the rule ───────────────────────────────────────────────────────────────

export class TemplateNotFound extends ObligationError {
  constructor(ref: string) {
    super("TEMPLATE_NOT_FOUND", `no compliance rule ${JSON.stringify(ref)} at this firm`);
  }
}

export class TemplateNameRequired extends ObligationError {
  constructor() {
    super(
      "TEMPLATE_NAME_REQUIRED",
      `a rule needs the name of the filing — "GSTR-3B", "TDS deposit", "AOC-4". It is what ` +
        `appears on the calendar and on the task raised from it.`,
    );
  }
}

export class InvalidJurisdiction extends ObligationError {
  constructor(value: string) {
    super(
      "INVALID_JURISDICTION",
      `jurisdiction ${JSON.stringify(value)} must be a two-letter ISO 3166-1 country code in ` +
        `upper case — "IN", "SG", "AE". It is matched exactly against the entity's own ` +
        `registered jurisdiction, so a mismatch means the rule reaches nobody.`,
    );
  }
}

export class InvalidRecurrence extends ObligationError {
  constructor(value: string) {
    super(
      "INVALID_RECURRENCE",
      `recurrence ${JSON.stringify(value)} must be one of monthly, quarterly, half_yearly, ` +
        `annual or event. "event" means the filing is triggered by something happening — a ` +
        `share allotment, a director change — and produces no calendar entries, because ` +
        `nothing in this system yet knows the event occurred.`,
    );
  }
}

export class InvalidFiscalYearStart extends ObligationError {
  constructor(month: number) {
    super(
      "INVALID_FISCAL_YEAR_START",
      `the financial year has to start in a month 1-12, not ${JSON.stringify(month)}. India is ` +
        `4 — and it matters: an Indian quarter runs Apr-Jun, so a rule left on 1 would put ` +
        `every quarterly filing in the wrong period.`,
    );
  }
}

export class InvalidDueRule extends ObligationError {
  constructor(value: string) {
    super(
      "INVALID_DUE_RULE",
      `due rule ${JSON.stringify(value)} must be "day_of_month" (so many months after the ` +
        `period ends, then a day of that month) or "days_after" (so many days after the ` +
        `period ends).`,
    );
  }
}

export class IncompleteDueRule extends ObligationError {
  constructor(kind: string, missing: string) {
    super(
      "INCOMPLETE_DUE_RULE",
      `a "${kind}" rule needs ${missing}. A half-stated rule cannot produce a date, and a ` +
        `rule that produces no date silently produces no calendar.`,
    );
  }
}

export class UnresolvedReasonRequired extends ObligationError {
  constructor() {
    super(
      "UNRESOLVED_REASON_REQUIRED",
      `a rule with no due formula needs a reason saying what is missing — "depends on the AGM ` +
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
      `this rule computes a date, so it cannot also carry a reason for not computing one. ` +
        `Clear the reason, or clear the due formula.`,
    );
  }
}

export class InvalidLeadTime extends ObligationError {
  constructor(days: number) {
    super(
      "INVALID_LEAD_TIME",
      `lead time ${JSON.stringify(days)} must be zero or more whole days. It is T-X: how long ` +
        `before the statutory date the firm wants the work to start, and it is the date the ` +
        `task appears on. Zero means the task appears on the statutory date itself.`,
    );
  }
}

export class InvalidRulePack extends ObligationError {
  constructor(value: string) {
    super(
      "INVALID_RULE_PACK",
      `rule pack ${JSON.stringify(value)} cannot be blank. It names the version of the rules ` +
        `this came from — "gst-in@2026.07" — and it is part of the rule's identity, so ` +
        `revising a rule means a new pack rather than an edit. Without it, "why was this due ` +
        `then?" has no answer.`,
    );
  }
}

export class InvalidRuleStatus extends ObligationError {
  constructor(value: string) {
    super(
      "INVALID_RULE_STATUS",
      `status ${JSON.stringify(value)} must be "unconfirmed" or "confirmed". Confirming a rule ` +
        `is a partner saying they have checked this date against the statute — the shipped ` +
        `dates came from a document, not from the firm.`,
    );
  }
}

export class TemplateKeyTaken extends ObligationError {
  constructor(jurisdiction: string, name: string, rulePack: string) {
    super(
      "TEMPLATE_KEY_TAKEN",
      `this firm already has a ${jurisdiction} rule named ${JSON.stringify(name)} in pack ` +
        `${JSON.stringify(rulePack)}. To revise it, add it under a NEW rule pack and retire ` +
        `the old one — the old row stays readable, which is what lets a filing made last year ` +
        `still explain its own due date.`,
    );
  }
}

export class TemplateRetired extends ObligationError {
  constructor(name: string) {
    super(
      "TEMPLATE_RETIRED",
      `rule ${JSON.stringify(name)} has been retired and no longer generates. Reactivate it, ` +
        `or add its replacement under a new rule pack.`,
    );
  }
}

export class ServiceNotFound extends ObligationError {
  constructor(ref: string) {
    super(
      "SERVICE_NOT_FOUND",
      `no catalogue service ${JSON.stringify(ref)} at this firm. A rule names the service the ` +
        `firm sells, so the calendar knows which clients it reaches; leave it empty for a rule ` +
        `that applies to an entity regardless of what it bought.`,
    );
  }
}

// ── the exception ──────────────────────────────────────────────────────────

export class ExceptionNotFound extends ObligationError {
  constructor(ref: string) {
    super("EXCEPTION_NOT_FOUND", `no exception ${JSON.stringify(ref)} on this rule`);
  }
}

export class InvalidPeriodEndMonth extends ObligationError {
  constructor(month: number) {
    super(
      "INVALID_PERIOD_END_MONTH",
      `an exception is keyed on the calendar month the filed PERIOD ends in, 1-12, not ` +
        `${JSON.stringify(month)}. March is 3 — that is the month of the deduction, not the ` +
        `month it is due, because the due month is exactly what the exception changes.`,
    );
  }
}

export class ExceptionNoteRequired extends ObligationError {
  constructor() {
    super(
      "EXCEPTION_NOTE_REQUIRED",
      `an exception needs a note saying why this period is different — "March TDS is due 30 ` +
        `April by statute". Without it a partner checking the calendar against the statute ` +
        `cannot tell a real carve-out from somebody's typo.`,
    );
  }
}

export class ExceptionMonthTaken extends ObligationError {
  constructor(month: number) {
    super(
      "EXCEPTION_MONTH_TAKEN",
      `this rule already has an exception for periods ending in month ${month}. Two would make ` +
        `the due date depend on row order, which is not a rule at all — edit the existing one.`,
    );
  }
}

export class ExceptionOnEventRule extends ObligationError {
  constructor() {
    super(
      "EXCEPTION_ON_EVENT_RULE",
      `an event-driven rule has no periods, so there is no period-month for an exception to ` +
        `apply to.`,
    );
  }
}

// ── generating ─────────────────────────────────────────────────────────────

export class NoInitialState extends ObligationError {
  constructor() {
    super(
      "NO_INITIAL_STATE",
      `this firm has no obligation state marked as the starting one, so a generated filing has ` +
        `nowhere to begin. Mark one on the compliance vocabulary screen — "Pending" is what a ` +
        `new firm ships with.`,
    );
  }
}

export class ObligationNotFound extends ObligationError {
  constructor(ref: string) {
    super("OBLIGATION_NOT_FOUND", `no obligation ${JSON.stringify(ref)} at this firm`);
  }
}

export class InvalidWindow extends ObligationError {
  constructor(from: string, to: string) {
    super(
      "INVALID_WINDOW",
      `the window ${JSON.stringify(from)}..${JSON.stringify(to)} is not a pair of dates with ` +
        `the earlier one first. Dates are YYYY-MM-DD and name a day, never an instant.`,
    );
  }
}
