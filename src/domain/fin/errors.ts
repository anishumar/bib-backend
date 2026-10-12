// Sentinel errors for FinCompliance. They live in the domain so the meaning is
// owned here; `api/domainerr.ts` maps them to HTTP status codes. Match with
// `instanceof`, never a string search.
//
// Every code added here is a COMPILE error until `api/domainerr.ts` maps it.

export class FinError extends Error {
  constructor(
    readonly code: FinErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type FinErrorCode =
  | "FIN_NOT_ENABLED"
  // Findings and the rule checks (F4.1, F4.2), appended for wave 3.
  | "FIN_FINDING_NOT_FOUND"
  | "FIN_DISMISSAL_NEEDS_REASON"
  | "FIN_OTHER_NEEDS_WORDS"
  | "FIN_REASON_ONLY_ON_DISMISSAL"
  | "FIN_REASON_TOO_LONG"
  | "FIN_ASK_NOT_WIRED"
  | "FIN_DECIDER_NOT_STAFF"
  | "FIN_FINDING_DRAFT_INVALID"
  | "FIN_CHECK_INPUT_INVALID"
  | "FIN_PARAMETER_UNREADABLE";

/** Fin is switched off for this firm. A 404, as the plan says: to a firm
 *  without it, fin's routes are not there — and a 403 would read as "you lack
 *  a permission", which no role change can fix. */
export class FinNotEnabled extends FinError {
  constructor() {
    super(
      "FIN_NOT_ENABLED",
      "FinCompliance is not switched on for this firm. It is enabled per firm by the platform " +
        "(tenancy.tenant.fin_enabled_since); nothing under /api/v1/fin answers until it is.",
    );
  }
}

// ── Findings (F4.2) ─────────────────────────────────────────────────────────

/** No finding by that id at this firm. One answer for "not there" and "another
 *  firm's", so a guessed id learns nothing. */
export class FindingNotFound extends FinError {
  constructor(readonly findingId: string) {
    super("FIN_FINDING_NOT_FOUND", "This finding could not be found, or you do not have access to it.");
  }
}

/** A dismissal with no reason code. The CHECK in 0387 refuses it too; this is
 *  what a person is told before they meet it. */
export class DismissalNeedsReason extends FinError {
  constructor() {
    super(
      "FIN_DISMISSAL_NEEDS_REASON",
      "Dismissing a finding needs a reason: a price change, a one-off, seasonal, expected, or " +
        "another reason in your own words.",
    );
  }
}

/** `other` with no words. */
export class OtherNeedsWords extends FinError {
  constructor() {
    super("FIN_OTHER_NEEDS_WORDS", "Say in a few words why this finding is dismissed.");
  }
}

/** A reason sent with "ask the client" or "correct". A reason explains a
 *  dismissal and nothing else, so it is refused rather than dropped. */
export class ReasonOnlyOnDismissal extends FinError {
  constructor() {
    super(
      "FIN_REASON_ONLY_ON_DISMISSAL",
      "A reason is given only when a finding is dismissed. Leave it out to ask the client or to correct it.",
    );
  }
}

export class ReasonTooLong extends FinError {
  constructor(readonly max: number) {
    super("FIN_REASON_TOO_LONG", `Keep the reason to ${String(max)} characters.`);
  }
}

/**
 * "Ask the client" is refused honestly: raising the portal ask from a finding is
 * F4.6, through a port to the client-ask module, and it is not built. Recording
 * the decision without the ask would tell the person the client had been asked
 * when nobody had.
 */
export class AskClientNotWired extends FinError {
  constructor() {
    super(
      "FIN_ASK_NOT_WIRED",
      "Asking the client from a finding is not built yet. Raise the request from the client's " +
        "task for now, then correct or dismiss this finding once you have the answer.",
    );
  }
}

/** The person deciding is not an active member of this firm's staff. The route
 *  is behind a staff session, so this is the wall for any other caller. */
export class DeciderNotStaff extends FinError {
  constructor(readonly userId: string) {
    super("FIN_DECIDER_NOT_STAFF", "Only an active member of the firm's staff can decide a finding.");
  }
}

/** A check produced a finding the store cannot hold. The fin job's own bug,
 *  never a person's, so it answers as an internal error and names the field. */
export class FindingDraftInvalid extends FinError {
  constructor(readonly problem: string) {
    super("FIN_FINDING_DRAFT_INVALID", `A check produced a finding that cannot be stored: ${problem}`);
  }
}

/** The rule checks were handed something they cannot check: a period that is
 *  not two real days in order, or a line of another client. A caller's bug. */
export class CheckInputInvalid extends FinError {
  constructor(readonly problem: string) {
    super("FIN_CHECK_INPUT_INVALID", `The rule checks were given input they cannot check: ${problem}`);
  }
}

/** A dated value in fin.rule_parameter does not read as its key says it
 *  should. A migration's bug: it names the row so it can be fixed forward. */
export class RuleParameterUnreadable extends FinError {
  constructor(readonly key: string, readonly validFrom: string, readonly problem: string) {
    super(
      "FIN_PARAMETER_UNREADABLE",
      `The dated value ${key} in force from ${validFrom} cannot be read: ${problem}`,
    );
  }
}
