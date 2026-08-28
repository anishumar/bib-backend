// Sentinel errors — the closed vocabulary of ways quoting fails. Owned here in
// the domain; the api layer maps them to HTTP status codes (domainerr.ts).
// Match with `instanceof`, never by string.

export class ProposalError extends Error {
  constructor(
    readonly code: ProposalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type ProposalErrorCode =
  | "PROPOSAL_NOT_FOUND"
  | "LINE_NOT_FOUND"
  | "NOT_A_DRAFT"
  | "EMPTY_PROPOSAL"
  | "INVALID_TRANSITION"
  | "INVALID_DECISION"
  | "PROPOSAL_EXPIRED"
  | "DISCOUNT_NEEDS_APPROVAL"
  | "APPROVAL_NOT_NEEDED"
  | "ALREADY_APPROVED"
  | "NOT_A_SERVICE"
  | "SERVICE_NOT_FOUND"
  | "SERVICE_NOT_PUBLISHED"
  | "INVALID_QUANTITY"
  | "INVALID_UNIT_AMOUNT"
  | "INVALID_DISCOUNT"
  | "INVALID_FX_RATE"
  | "INVALID_CURRENCY";

export class ProposalNotFound extends ProposalError {
  constructor(id: string) {
    super("PROPOSAL_NOT_FOUND", `no proposal ${JSON.stringify(id)} at this firm`);
  }
}

export class LineNotFound extends ProposalError {
  constructor(id: string) {
    super("LINE_NOT_FOUND", `no line ${JSON.stringify(id)} on this proposal`);
  }
}

export class NotADraft extends ProposalError {
  constructor(status: string) {
    // The thing somebody actually wants to know is what to do instead, and for
    // a sent proposal the answer is never "edit it".
    super(
      "NOT_A_DRAFT",
      `this proposal is ${status}, and only a draft can be changed. The client has the document ` +
        `as it was sent; altering it now would leave no record of what they were shown. Draft a ` +
        `new proposal instead — the old one stays readable as what was actually offered.`,
    );
  }
}

export class EmptyProposal extends ProposalError {
  constructor() {
    super(
      "EMPTY_PROPOSAL",
      `a proposal with no lines offers nothing. Add at least one service before sending it.`,
    );
  }
}

export class InvalidTransition extends ProposalError {
  constructor(from: string, to: string) {
    super(
      "INVALID_TRANSITION",
      `a proposal cannot go from ${from} to ${to}. Sending is one-way, and accepted, rejected ` +
        `and expired are final: a client who comes back is a new quote, which is what keeps the ` +
        `old one readable as what they turned down.`,
    );
  }
}

export class InvalidDecision extends ProposalError {
  constructor(decision: string) {
    super(
      "INVALID_DECISION",
      `${JSON.stringify(decision)} is not a decision a recipient can give. Valid: accepted, ` +
        `rejected. Expiry is something that happens to a proposal, not something anyone decides.`,
    );
  }
}

export class ProposalExpired extends ProposalError {
  constructor(validUntil: string) {
    super(
      "PROPOSAL_EXPIRED",
      `this proposal was valid until ${validUntil} and has now been marked expired. Honouring it ` +
        `late is a commercial decision, not a data one — draft a new proposal, dated today.`,
    );
  }
}

export class DiscountNeedsApproval extends ProposalError {
  constructor(largest: string, limit: string | null) {
    super(
      "DISCOUNT_NEEDS_APPROVAL",
      limit === null
        ? `this proposal discounts a line by ${largest}%, and this firm has published no discount ` +
          `policy — so any discount at all needs sign-off from somebody holding ` +
          `"proposal:approve". Publish a policy with a maxDiscountPercent to set a limit.`
        : `this proposal discounts a line by ${largest}%, past this firm's published limit of ` +
          `${limit}%. Somebody holding "proposal:approve" has to sign it off before it can be sent.`,
    );
  }
}

export class ApprovalNotNeeded extends ProposalError {
  constructor(largest: string, limit: string) {
    // Refused rather than accepted as a no-op: an approval recorded against a
    // proposal that never needed one is a signature in the audit trail for a
    // decision nobody made.
    super(
      "APPROVAL_NOT_NEEDED",
      `nothing to approve: the largest discount on this proposal is ${largest}%, within the ` +
        `firm's limit of ${limit}%. Recording an approval here would put a sign-off in the audit ` +
        `trail for a decision that was never required.`,
    );
  }
}

export class AlreadyApproved extends ProposalError {
  constructor(approvedAt: string) {
    // Refused rather than repeated. A second sign-off records a second event
    // for one decision, and the log it lands in cannot be corrected — so the
    // audit trail would show two approvals where a person gave one.
    super(
      "ALREADY_APPROVED",
      `this proposal's discount was already approved at ${approvedAt}. Approving again would ` +
        `record a second sign-off for one decision in a log that cannot be corrected. If the ` +
        `discount has changed since, the quote has too — draft a new proposal.`,
    );
  }
}

export class ServiceNotFound extends ProposalError {
  constructor(versionId: string) {
    super(
      "SERVICE_NOT_FOUND",
      `no configuration version ${JSON.stringify(versionId)} at this firm. A proposal line is ` +
        `quoted from a catalogue version, and the id has to be one this firm published.`,
    );
  }
}

export class NotAService extends ProposalError {
  constructor(versionId: string, kind: string) {
    super(
      "NOT_A_SERVICE",
      `configuration version ${JSON.stringify(versionId)} is a ${kind}, not a service. A proposal ` +
        `line quotes something the firm sells.`,
    );
  }
}

export class ServiceNotPublished extends ProposalError {
  constructor(versionId: string) {
    // Archived is fine and deliberately so — that is what a pin resolves to
    // once the catalogue moves on. A DRAFT is not: it was never in force, so
    // quoting it would put a price on a document that the firm never agreed to.
    super(
      "SERVICE_NOT_PUBLISHED",
      `configuration version ${JSON.stringify(versionId)} is still a draft and was never in ` +
        `force, so it cannot be quoted. Publish it first. (A version that has since been ` +
        `superseded is fine — that is what a pinned quote is supposed to resolve to.)`,
    );
  }
}

export class InvalidQuantity extends ProposalError {
  constructor(quantity: string) {
    super(
      "INVALID_QUANTITY",
      `quantity ${JSON.stringify(quantity)} must be a positive decimal STRING with at most four ` +
        `decimal places — "1", "2.5". A number is refused for the same reason an amount is: a ` +
        `float does not hold it exactly.`,
    );
  }
}

export class InvalidUnitAmount extends ProposalError {
  constructor(amount: string) {
    super(
      "INVALID_UNIT_AMOUNT",
      `unit amount ${JSON.stringify(amount)} must be a non-negative decimal STRING with at most ` +
        `four decimal places — "25000", "1499.50" — never a number, because a float cannot hold ` +
        `1499.50 exactly and the error is invisible in one line and material in a total.`,
    );
  }
}

export class InvalidDiscount extends ProposalError {
  constructor(percent: string) {
    super(
      "INVALID_DISCOUNT",
      `discount ${JSON.stringify(percent)} must be a decimal STRING between "0" and "100".`,
    );
  }
}

export class InvalidFxRate extends ProposalError {
  constructor(rate: string) {
    super(
      "INVALID_FX_RATE",
      `exchange rate ${JSON.stringify(rate)} must be a positive decimal STRING. Quote in the ` +
        `firm's own currency and it is "1" — stored, not omitted, so that "did we convert this?" ` +
        `is never a question about a missing value.`,
    );
  }
}

export class InvalidQuoteCurrency extends ProposalError {
  constructor(currency: string) {
    super(
      "INVALID_CURRENCY",
      `quote currency ${JSON.stringify(currency)} is not an ISO 4217 code — three letters, like ` +
        `"INR" or "AED".`,
    );
  }
}
