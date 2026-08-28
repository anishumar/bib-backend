// Sentinel errors — the closed vocabulary of ways engagement letters fail.
// Owned here in the domain; the api layer maps them to HTTP status codes.
// Match with `instanceof`, never by string.

export class EngagementError extends Error {
  constructor(
    readonly code: EngagementErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type EngagementErrorCode =
  | "LETTER_NOT_FOUND"
  | "LETTER_LINE_NOT_FOUND"
  | "LETTER_NOT_EDITABLE"
  | "LETTER_NOT_SIGNABLE"
  | "EMPTY_LETTER"
  | "NO_CLAUSES"
  | "INVALID_LETTER_TRANSITION"
  | "INVALID_JURISDICTION"
  | "CLAUSE_NOT_FOUND"
  | "NOT_A_CLAUSE"
  | "CLAUSE_NOT_PUBLISHED"
  | "CLAUSE_WRONG_JURISDICTION"
  | "SERVICE_NOT_QUOTABLE"
  | "ADVANCE_NOT_REQUIRED"
  | "ADVANCE_ALREADY_RECORDED"
  | "ADVANCE_AMOUNT_REQUIRED"
  | "INVALID_AMOUNT"
  | "INVALID_DATE"
  | "LETTER_NOT_SUPERSEDABLE"
  | "ALREADY_SUPERSEDED"
  | "ENGAGEMENT_NOT_FOUND"
  | "ENGAGEMENT_NOT_ACTIVE"
  | "SIGNATURE_INCOMPLETE";

export class LetterNotFound extends EngagementError {
  constructor(id: string) {
    super("LETTER_NOT_FOUND", `no engagement letter ${JSON.stringify(id)} at this firm`);
  }
}

export class LetterLineNotFound extends EngagementError {
  constructor(id: string) {
    super("LETTER_LINE_NOT_FOUND", `no line ${JSON.stringify(id)} on this engagement letter`);
  }
}

export class LetterNotEditable extends EngagementError {
  constructor(status: string) {
    super(
      "LETTER_NOT_EDITABLE",
      status === "signed"
        ? `this letter is signed, and a signed letter never changes — the database refuses it, ` +
          `not just this code. It is the record of what the client agreed to. Draft a new ` +
          `letter that supersedes it; the old one stays readable as what was actually signed.`
        : `this letter is ${status}, and only a draft can be changed. The client has it as it ` +
          `was sent; altering it now would leave no record of what they were asked to sign.`,
    );
  }
}

export class EmptyLetter extends EngagementError {
  constructor() {
    super(
      "EMPTY_LETTER",
      `an engagement letter with no lines commits the firm to nothing and the client to ` +
        `nothing. Add at least one service before sending it.`,
    );
  }
}

export class NoClauses extends EngagementError {
  constructor() {
    // Refused rather than allowed, because the failure is silent and expensive:
    // a signed contract with no terms is enforceable as whatever a court reads
    // into it.
    super(
      "NO_CLAUSES",
      `an engagement letter with no clauses has no terms — no scope, no liability limit, no ` +
        `termination. Signing one leaves the firm bound by whatever is read into it. Add at ` +
        `least one clause from the library first.`,
    );
  }
}

export class InvalidLetterTransition extends EngagementError {
  constructor(from: string, to: string) {
    super(
      "INVALID_LETTER_TRANSITION",
      `an engagement letter cannot go from ${from} to ${to}. Signing is final — the document ` +
        `freezes — and a withdrawn letter stays withdrawn, so that the interval in which it ` +
        `was off the table is still on the record.`,
    );
  }
}

export class InvalidJurisdiction extends EngagementError {
  constructor(value: string) {
    super(
      "INVALID_JURISDICTION",
      `jurisdiction ${JSON.stringify(value)} is not an ISO 3166 country code — two letters, ` +
        `like "IN" or "AE". The letter records the jurisdiction it was WRITTEN for, which is ` +
        `not always the client's or the firm's, so it has to be stated rather than inferred.`,
    );
  }
}

export class ClauseNotFound extends EngagementError {
  constructor(versionId: string) {
    super(
      "CLAUSE_NOT_FOUND",
      `no configuration version ${JSON.stringify(versionId)} at this firm. A letter's terms ` +
        `come from the clause library, and the id has to be one this firm published.`,
    );
  }
}

export class NotAClause extends EngagementError {
  constructor(versionId: string, kind: string) {
    super(
      "NOT_A_CLAUSE",
      `configuration version ${JSON.stringify(versionId)} is a ${kind}, not a clause.`,
    );
  }
}

export class ClauseNotPublished extends EngagementError {
  constructor(versionId: string) {
    // Archived is fine and deliberately so: that is what a pin resolves to once
    // the library moves on. A DRAFT was never in force, so putting it in a
    // contract binds the client to wording the firm never adopted.
    super(
      "CLAUSE_NOT_PUBLISHED",
      `clause version ${JSON.stringify(versionId)} is still a draft and was never in force, so ` +
        `it cannot be put in a contract. Publish it first. (A version that has since been ` +
        `superseded is fine — that is what a pinned clause is supposed to resolve to.)`,
    );
  }
}

export class ClauseWrongJurisdiction extends EngagementError {
  constructor(title: string, clauseJurisdictions: readonly string[], letter: string) {
    super(
      "CLAUSE_WRONG_JURISDICTION",
      `the clause ${JSON.stringify(title)} applies in ${clauseJurisdictions.join(", ")} and this ` +
        `letter is written for ${letter}. A term drafted for another jurisdiction may be ` +
        `unenforceable or simply wrong here, so it is refused rather than quietly included.`,
    );
  }
}

export class ServiceNotQuotable extends EngagementError {
  constructor(versionId: string, reason: string) {
    super("SERVICE_NOT_QUOTABLE", `service version ${JSON.stringify(versionId)}: ${reason}`);
  }
}

export class AdvanceNotRequired extends EngagementError {
  constructor() {
    super(
      "ADVANCE_NOT_REQUIRED",
      `this letter does not require an advance, so there is nothing to record. Recording one ` +
        `would put a receipt in the audit trail for money nobody asked for.`,
    );
  }
}

export class AdvanceAlreadyRecorded extends EngagementError {
  constructor(at: string) {
    super(
      "ADVANCE_ALREADY_RECORDED",
      `the advance on this letter was already recorded at ${at}. Recording it twice would show ` +
        `two receipts in a log that cannot be corrected for one payment.`,
    );
  }
}

export class AdvanceAmountRequired extends EngagementError {
  constructor() {
    super(
      "ADVANCE_AMOUNT_REQUIRED",
      `a letter that requires an advance has to say how much. "An advance is required" with no ` +
        `figure is a gate nobody can pass.`,
    );
  }
}

export class InvalidAmount extends EngagementError {
  constructor(field: string, value: string) {
    super(
      "INVALID_AMOUNT",
      `${field} ${JSON.stringify(value)} must be a non-negative decimal STRING with at most ` +
        `four decimal places — "25000", "1499.50" — never a number, because a float cannot ` +
        `hold 1499.50 exactly.`,
    );
  }
}

export class InvalidDate extends EngagementError {
  constructor(field: string, value: string) {
    super(
      "INVALID_DATE",
      `${field} ${JSON.stringify(value)} must be a calendar day as YYYY-MM-DD — "2026-10-01". ` +
        `A day, not an instant: an engagement that begins on 1 October begins on the client's ` +
        `1 October, and midnight UTC is somebody else's evening.`,
    );
  }
}

export class LetterNotSupersedable extends EngagementError {
  constructor(status: string) {
    // The rule the freeze's own message has been giving for three tasks, now
    // with somewhere to record it — and with the two cases it does NOT cover
    // named, because those are the ones somebody reaches for it by mistake.
    super(
      "LETTER_NOT_SUPERSEDABLE",
      `only a SIGNED letter can be superseded, and this one is ${status}. A draft is edited in ` +
        `place; a letter that went out and was never signed is withdrawn. Superseding exists for ` +
        `the agreement the client actually made, which is the one thing that can never be edited.`,
    );
  }
}

export class AlreadySuperseded extends EngagementError {
  constructor(ref: string) {
    super(
      "ALREADY_SUPERSEDED",
      `${ref} already supersedes that letter. Two live letters replacing one agreement leaves ` +
        `nobody able to say which is in force. Withdraw ${ref} first if it is the wrong ` +
        `replacement, or amend it while it is still a draft.`,
    );
  }
}

export class EngagementNotFound extends EngagementError {
  constructor(id: string) {
    super("ENGAGEMENT_NOT_FOUND", `no engagement ${JSON.stringify(id)} at this firm`);
  }
}

export class SignatureIncomplete extends EngagementError {
  constructor(missing: string) {
    super(
      "SIGNATURE_INCOMPLETE",
      `a signature needs ${missing}. A letter recorded as signed with any of it missing is one ` +
        `nobody can verify, which is worse than an unsigned one because it claims otherwise.`,
    );
  }
}
