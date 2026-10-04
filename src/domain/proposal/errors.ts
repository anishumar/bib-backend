import type { ProposalDeletionBlock } from "./model";

// Sentinel errors — the closed vocabulary of ways quoting fails. Owned here in
// the domain; the api layer maps them to HTTP status codes (domainerr.ts).
// Match with `instanceof`, never by string.

import { longDay } from "../day";
import { countryCodeProblem } from "../country";
import { amountProblem } from "../money/model";

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
  | "NOT_CALLERS_TODAY"
  | "PROPOSAL_DELETED"
  | "PROPOSAL_NOT_DELETABLE"
  | "PROPOSAL_NOT_COPYABLE"
  | "PROPOSAL_CITED_BY_LETTER"
  | "LEAD_DELETED"
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
  | "SHARE_LINK_UNKNOWN"
  | "NOT_A_SERVICE"
  | "SERVICE_NOT_FOUND"
  | "SERVICE_NOT_PUBLISHED"
  | "INVALID_QUANTITY"
  | "INVALID_UNIT_AMOUNT"
  | "UNPRICED_LINE_NEEDS_REASON"
  | "SERVICE_HAS_NO_LIST_PRICE"
  | "UNPRICED_LINE_HAS_DISCOUNT"
  | "INVALID_BILLING_FREQUENCY"
  | "INVALID_LINE_JURISDICTION"
  | "INVALID_OOP_ESTIMATE"
  | "INVALID_DISCOUNT"
  | "INVALID_FX_RATE"
  | "INVALID_CURRENCY"
  | "PARTY_ARCHIVED"
  | "CLIENT_IS_OWN_COMPANY"
  | "ISSUER_NOT_A_FIRM_ENTITY"
  | "ADDRESSEE_NOT_A_PERSON"
  | "ADDRESSEE_NOT_LINKED"
  | "PREPARER_NOT_STAFF"
  | "NOTHING_TO_REVISE"
  | "NOTHING_TO_CHANGE_ON_LINE"
  | "CURRENCY_LOCKED_BY_LINES"
  | "INVALID_CURRENCY_CHANGE"
  | "PROSE_EDITED"
  | "INVALID_LINE_DESCRIPTION"
  | "INVALID_RECIPIENT"
  | "NOT_OUT_FOR_ANSWER"
  | "EMAIL_UNAVAILABLE"
  | "SIGNER_NAME_REQUIRED"
  | "ACCEPTANCE_NOT_CONFIRMED"
  | "ALREADY_ANSWERED";

// ── The proposal by email, and the client's own answer (0085) ────────────────
//
// The last three are read by a CLIENT, on the link's page, not by a colleague:
// they are written to the person holding the proposal, and say nothing about
// how the firm runs its records.

/** The address a colleague typed is not one. */
export class InvalidRecipient extends ProposalError {
  constructor(to: string) {
    super(
      "INVALID_RECIPIENT",
      `${JSON.stringify(to)} is not an email address. Type the client's address in full, like ` +
        `name@company.com.`,
    );
  }
}

/** Emailing again, or a new link, asks for a proposal that is still OUT. */
export class NotOutForAnswer extends ProposalError {
  constructor(status: string) {
    super(
      "NOT_OUT_FOR_ANSWER",
      `This proposal is ${status}. Only a sent proposal the client has not answered can be ` +
        `emailed again or given a new link.`,
    );
  }
}

/** The process this ran in holds no mailer — the worker, which never sends. */
export class EmailUnavailable extends ProposalError {
  constructor() {
    super(
      "EMAIL_UNAVAILABLE",
      "This process has no mail transport, so it cannot email a proposal. Sending is the " +
        "API's; the worker composes the proposal service only to read quotes.",
    );
  }
}

export class SignerNameRequired extends ProposalError {
  constructor() {
    super(
      "SIGNER_NAME_REQUIRED",
      "Type your full name. It is recorded with your answer, so the firm knows who gave it.",
    );
  }
}

export class AcceptanceNotConfirmed extends ProposalError {
  constructor() {
    super(
      "ACCEPTANCE_NOT_CONFIRMED",
      "Tick the box to confirm you accept this proposal on your company's behalf.",
    );
  }
}

/** A second answer. The first one stands — an answer is final. */
export class AlreadyAnswered extends ProposalError {
  constructor(status: "accepted" | "rejected") {
    super(
      "ALREADY_ANSWERED",
      `This proposal has already been ${status === "accepted" ? "accepted" : "declined"}, and ` +
        `that answer stands. If something has changed, reply to the firm's email.`,
    );
  }
}

/** The client, or the company a line is for, was archived (0305). Restore it
 *  first; a new document may not name a party the firm put away. */
export class ProposalPartyArchived extends ProposalError {
  constructor(displayName: string, as: "client" | "entity") {
    super(
      "PARTY_ARCHIVED",
      `${displayName} is archived, so ${as === "client" ? "a new proposal cannot be drafted for them" : "a proposal line cannot be for them"}. ` +
        `If the firm is working with them again, restore them from their client page first: ` +
        `restoring is its own step, so that putting a client away is never undone without ` +
        `somebody seeing it.`,
    );
  }
}

/** The client is one of the firm's own companies: an invoice cannot bill one
 *  (`BILLS_THE_FIRM`), and a quote cannot be made to one either. */
export class ProposalClientIsOwnCompany extends ProposalError {
  constructor(displayName: string) {
    super(
      "CLIENT_IS_OWN_COMPANY",
      `${displayName} is one of your own companies, so it cannot be the client on a proposal. ` +
        `Choose the client the quote is for.`,
    );
  }
}

/** "Prepared for" names a PERSON at the client (0084) — the letter's rule. */
export class ProposalAddresseeNotAPerson extends ProposalError {
  constructor(displayName: string) {
    super(
      "ADDRESSEE_NOT_A_PERSON",
      `${displayName} is a company, and a proposal is prepared for a person at the client. ` +
        `Leave "Prepared for" blank to prepare it for the company itself.`,
    );
  }
}

/** The person holds no recorded role at the client or any company under it —
 *  the same structure read the letter's addressee is held to (F-10-1). */
export class ProposalAddresseeNotLinked extends ProposalError {
  constructor(person: string, client: string) {
    super(
      "ADDRESSEE_NOT_LINKED",
      `${person} has no recorded role at ${client} or any of its companies, so the proposal ` +
        `cannot be prepared for them. Record them on ${client}'s client page as a director, ` +
        `authorised signatory, employee or shareholder first, or choose somebody who is.`,
    );
  }
}

/** "Prepared by" is a colleague: an active STAFF member of this firm. The key
 *  points at a GLOBAL account table, so the database would accept a stranger. */
export class PreparerNotStaff extends ProposalError {
  constructor(userId: string) {
    super(
      "PREPARER_NOT_STAFF",
      `The account ${userId} is not an active member of staff at this firm, so the proposal ` +
        `cannot say they prepared it. Choose a colleague from the firm's roster.`,
    );
  }
}

/** A revision that names nothing to change — refused rather than recorded as
 *  an edit that changed nothing. */
export class NothingToRevise extends ProposalError {
  constructor() {
    super(
      "NOTHING_TO_REVISE",
      "Nothing to change: send at least one of title, validUntil, background, " +
        "addressedToPartyId or preparedByUserId.",
    );
  }
}

/** A line edit that names nothing to change (T6.18) — refused rather than
 *  answered as an edit that changed nothing. */
export class NothingToChangeOnLine extends ProposalError {
  constructor() {
    super(
      "NOTHING_TO_CHANGE_ON_LINE",
      "Nothing to change on this line: send at least one of description, quantity, unitAmount, " +
        "discountPercent, billingFrequency, pricingNote, jurisdiction, oopEstimate, " +
        "scopeOverride, clientObligationsOverride, volumeLimitsOverride or exclusionsOverride.",
    );
  }
}

/**
 * A draft's currency changes only while it quotes nothing (T6.18, D1): every
 * line is priced in the document's currency and held to it by a key, so a new
 * currency under live lines would relabel their prices without converting them.
 */
export class CurrencyLockedByLines extends ProposalError {
  constructor(lineCount: number, currency: string) {
    super(
      "CURRENCY_LOCKED_BY_LINES",
      `This draft already quotes ${String(lineCount)} service${lineCount === 1 ? "" : "s"} in ` +
        `${currency}, and every line is priced in the document's currency. Remove ` +
        `${lineCount === 1 ? "it" : "them"} first, then change the currency and quote again, or ` +
        `keep ${currency}.`,
    );
  }
}

/** The currency, its rate and the rate's day travel together. */
export class InvalidCurrencyChange extends ProposalError {
  constructor() {
    super(
      "INVALID_CURRENCY_CHANGE",
      "Send currency, fxRate and fxRateDate together: the rate back to the firm's reporting " +
        "currency belongs to one currency on one day, and half of it is not a rate.",
    );
  }
}

/**
 * Changing the issuer replaces the draft's prose with the new company's
 * standard set (T6.18, D9), and some of the lines it would replace were
 * written for this client. Asked first, never done silently.
 */
export class ProseEdited extends ProposalError {
  constructor(
    readonly editedCount: number,
    issuerName: string,
  ) {
    super(
      "PROSE_EDITED",
      `${String(editedCount)} line${editedCount === 1 ? "" : "s"} of this proposal's exclusions, ` +
        `commercials or team ${editedCount === 1 ? "was" : "were"} edited or written for this ` +
        `client, and ` +
        `changing the issuer replaces the prose with ${issuerName}'s standard set. Send ` +
        `replaceEditedProse: true to replace ${editedCount === 1 ? "it" : "them"} anyway, or keep ` +
        `the issuer.`,
    );
  }
}

/** A line's description is what the client reads for it, so it cannot be blank. */
export class InvalidLineDescription extends ProposalError {
  constructor() {
    super(
      "INVALID_LINE_DESCRIPTION",
      "A line's description is what the client reads for it, so it cannot be blank. Type what " +
        "the work is, or leave the description out of the change to keep it as it is.",
    );
  }
}

/** The company named as offering the quote is not one of the firm's own
 *  (F-10-1): any party of the firm could be named, a client included. */
export class ProposalIssuerNotAFirmEntity extends ProposalError {
  constructor(displayName: string) {
    super(
      "ISSUER_NOT_A_FIRM_ENTITY",
      `${displayName} is not one of the firm's own companies, so it cannot offer this quote. ` +
        `Choose one of the firm's companies, or leave it out and the firm's rule for the ` +
        `client's country picks it.`,
    );
  }
}

export class ProposalNotFound extends ProposalError {
  constructor(id: string) {
    super("PROPOSAL_NOT_FOUND", `No proposal ${JSON.stringify(id)} at this firm`);
  }
}

export class LineNotFound extends ProposalError {
  constructor(id: string) {
    super("LINE_NOT_FOUND", `No line ${JSON.stringify(id)} on this proposal`);
  }
}

export class NotADraft extends ProposalError {
  constructor(status: string) {
    // The thing somebody actually wants to know is what to do instead, and for
    // a sent proposal the answer is never "edit it".
    super(
      "NOT_A_DRAFT",
      `This proposal is ${status}, and only a draft can be changed. The client has the document ` +
        `as it was sent; altering it now would leave no record of what they were shown. Draft a ` +
        `new proposal instead: the old one stays readable as what was actually offered.`,
    );
  }
}

export class EmptyProposal extends ProposalError {
  constructor() {
    super(
      "EMPTY_PROPOSAL",
      `A proposal with no lines offers nothing. Add at least one service before sending it.`,
    );
  }
}

export class InvalidTransition extends ProposalError {
  constructor(from: string, to: string) {
    super(
      "INVALID_TRANSITION",
      `A proposal cannot go from ${from} to ${to}. Sending is one-way, and accepted, rejected ` +
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

/** `asOf` is the recorder's TODAY, not a date to choose (see `isCallersToday`),
 *  held to the issuing company's day or one either side (0337). */
export class ProposalNotCallersToday extends ProposalError {
  constructor(given: string, companyDay: string) {
    super(
      "NOT_CALLERS_TODAY",
      `The day sent as asOf, ${JSON.stringify(given)}, cannot be today where you are: the issuing ` +
        `company's day is ${companyDay}, and anywhere in the world today is that day or the one ` +
        `either side.`,
    );
  }
}

export class ProposalExpired extends ProposalError {
  constructor(validUntil: string) {
    super(
      "PROPOSAL_EXPIRED",
      `This proposal was valid until ${longDay(validUntil)} and has now been marked expired. ` +
        `Honouring it late is a commercial decision, not a data one: draft a new proposal, dated today.`,
    );
  }
}

export class DiscountNeedsApproval extends ProposalError {
  constructor(largest: string, limit: string | null) {
    super(
      "DISCOUNT_NEEDS_APPROVAL",
      limit === null
        ? `this proposal discounts a line by ${largest}%, and this firm has published no discount ` +
          `policy, so any discount at all needs sign-off from somebody holding ` +
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
      `Nothing to approve: the largest discount on this proposal is ${largest}%, within the ` +
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
      `This proposal's discount was already approved at ${approvedAt}. Approving again would ` +
        `record a second sign-off for one decision in a log that cannot be corrected. If the ` +
        `discount has changed since, the quote has too: draft a new proposal.`,
    );
  }
}

export class ServiceNotFound extends ProposalError {
  constructor(versionId: string) {
    super(
      "SERVICE_NOT_FOUND",
      `No configuration version ${JSON.stringify(versionId)} at this firm. A proposal line is ` +
        `quoted from a catalogue version, and the id has to be one this firm published.`,
    );
  }
}

export class NotAService extends ProposalError {
  constructor(versionId: string, kind: string) {
    super(
      "NOT_A_SERVICE",
      `Configuration version ${JSON.stringify(versionId)} is a ${kind}, not a service. A proposal ` +
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
      `Configuration version ${JSON.stringify(versionId)} is still a draft and was never in ` +
        `force, so it cannot be quoted. Publish it first. (A version that has since been ` +
        `superseded is fine: that is what a pinned quote is supposed to resolve to.)`,
    );
  }
}

export class ShareLinkUnknown extends ProposalError {
  constructor() {
    // ONE message for a malformed token, an unknown one, and one whose proposal
    // has gone. Telling them apart would let somebody probing learn which firms
    // exist and which links used to, and the recipient of a real link cannot
    // act on the distinction anyway.
    super(
      "SHARE_LINK_UNKNOWN",
      `This link is not one we recognise. It may have been mistyped, or the proposal may have ` +
        `been withdrawn: ask whoever sent it for a new one.`,
    );
  }
}

export class InvalidQuantity extends ProposalError {
  constructor(quantity: string) {
    super(
      "INVALID_QUANTITY",
      amountProblem("The quantity", quantity),
    );
  }
}

export class InvalidUnitAmount extends ProposalError {
  constructor(amount: string) {
    super(
      "INVALID_UNIT_AMOUNT",
      amountProblem("The fee", amount),
    );
  }
}

/**
 * A line with neither a fee nor a reason, for a service the catalogue has no
 * list price for in this proposal's currency (B09, audit 2026-10-03). Such a
 * line is quoted at the list price when there is one, which is how a login
 * that cannot see fees adds a priced service without being shown the price;
 * with none, it has to be told what to send.
 */
export class ServiceHasNoListPrice extends ProposalError {
  constructor(serviceName: string, currency: string) {
    super(
      "SERVICE_HAS_NO_LIST_PRICE",
      `${serviceName} has no list price in ${currency} in the catalogue. ` +
        "Enter the fee, or say why there is no fixed fee.",
    );
  }
}

export class UnpricedLineNeedsReason extends ProposalError {
  constructor() {
    super(
      "UNPRICED_LINE_NEEDS_REASON",
      `A line with no unit amount has to say WHY: "As mutually agreed", "Quoted on receipt of ` +
        `the registrar's schedule". Send a "pricingNote" with it. Leaving a price blank with no ` +
        `reason is indistinguishable on the client's document from a figure somebody forgot to ` +
        `type, and quoting it as "0" says something different again.`,
    );
  }
}

export class UnpricedLineHasDiscount extends ProposalError {
  constructor(percent: string) {
    super(
      "UNPRICED_LINE_HAS_DISCOUNT",
      `A line with no unit amount cannot carry a discount of ${JSON.stringify(percent)}: a ` +
        `percentage off "as mutually agreed" is not a number. It would also count towards the ` +
        `largest discount on the proposal and hold it at the approval gate over a discount that ` +
        `does not exist. Price the line, or send "0".`,
    );
  }
}

export class InvalidLineBillingFrequency extends ProposalError {
  constructor(value: string, allowed: readonly string[]) {
    super(
      "INVALID_BILLING_FREQUENCY",
      `Billing frequency ${JSON.stringify(value)} must be one of ${allowed.join(", ")}. It is ` +
        `how often this DEAL is invoiced, which is not how often the work comes round: a ` +
        `monthly service billed quarterly is why it is a field at all.`,
    );
  }
}

export class InvalidLineJurisdiction extends ProposalError {
  constructor(value: string) {
    super(
      "INVALID_LINE_JURISDICTION",
      countryCodeProblem(value),
    );
  }
}

export class InvalidOutOfPocketEstimate extends ProposalError {
  constructor(reason: string) {
    super(
      "INVALID_OOP_ESTIMATE",
      `Out-of-pocket estimate: ${reason}. It is a RANGE in its own currency: ` +
        `{"min": "5000", "max": "6000", "currency": "USD"}, reimbursed at actuals and separate ` +
        `from the fee, so all three travel together or none of them do. Its currency need not be ` +
        `the document's: a client quoted in INR still faces a filing fee in USD.`,
    );
  }
}

export class InvalidDiscount extends ProposalError {
  constructor(percent: string) {
    super(
      "INVALID_DISCOUNT",
      amountProblem("The discount", percent, { percent: true }),
    );
  }
}

export class InvalidFxRate extends ProposalError {
  constructor(rate: string) {
    super(
      "INVALID_FX_RATE",
      // Quote in the firm's own currency and it is "1", stored, not omitted.
      amountProblem("The exchange rate", rate, { places: 10 }),
    );
  }
}

export class InvalidQuoteCurrency extends ProposalError {
  constructor(currency: string) {
    super(
      "INVALID_CURRENCY",
      `Quote currency ${JSON.stringify(currency)} is not an ISO 4217 code: three letters, like ` +
        `"INR" or "AED".`,
    );
  }
}

// ── Deleting a draft made by mistake (0086) ──────────────────────────────────

/** A deleted draft is final. Every change to one lands here, and so does a
 *  second delete. */
export class ProposalDeleted extends ProposalError {
  constructor(ref: string) {
    super(
      "PROPOSAL_DELETED",
      `${ref} was deleted as made by mistake, and a deleted draft is final: nothing about it ` +
        `changes again. If the work is real after all, draft a new proposal.`,
    );
  }
}

export class ProposalNotDeletable extends ProposalError {
  constructor(ref: string, status: string) {
    super(
      "PROPOSAL_NOT_DELETABLE",
      `${ref} is ${status}, and only a draft that never went out can be deleted. The client has ` +
        `the document as it was sent, so it stays on record as what they were shown` +
        (status === "sent" ? `; record their answer, or let it expire.` : `.`),
    );
  }
}

/** Only a closed proposal is copied into a new draft (0316). Each answer
 *  says what to do instead of copying. */
export class ProposalNotCopyable extends ProposalError {
  constructor(ref: string, status: string) {
    super(
      "PROPOSAL_NOT_COPYABLE",
      `${ref} is ${status}. Only a proposal the client turned down, or one that expired, is ` +
        `copied into a new draft. ` +
        (status === "draft"
          ? `This one is still a draft, so change it directly.`
          : status === "sent"
            ? `The client still has this one; record their answer first, or let it expire.`
            : `An accepted proposal goes on to an engagement letter instead.`),
    );
  }
}

export class ProposalCitedByLetter extends ProposalError {
  constructor(readonly letterRefs: readonly string[]) {
    super(
      "PROPOSAL_CITED_BY_LETTER",
      (letterRefs.length === 1
        ? `Engagement letter ${letterRefs.join("")} cites this proposal, `
        : `Engagement letters ${letterRefs.join(", ")} cite this proposal, `) +
        `so it cannot be deleted while ${letterRefs.length === 1 ? "that letter stands" : "they stand"}. ` +
        `If ${letterRefs.length === 1 ? "the letter was" : "they were"} a mistake too, delete ` +
        `${letterRefs.length === 1 ? "it" : "them"} first, from the letter's own page.`,
    );
  }
}

/** A proposal may not be drafted from a lead that was deleted (0086) — there
 *  was never a prospect for it to be offered to. */
export class ProposalLeadDeleted extends ProposalError {
  constructor() {
    super(
      "LEAD_DELETED",
      `That lead was deleted as entered by mistake, so a proposal cannot be drafted from it. ` +
        `If the prospect is real, capture a new lead, or draft the proposal without one.`,
    );
  }
}

/**
 * The refusal a block means — ONE sentence for the DELETE that is refused and
 * for the proposal's page, which shows it where the button would be.
 */
export function proposalDeletionRefusal(
  ref: string,
  block: ProposalDeletionBlock,
): ProposalError {
  switch (block.kind) {
    case "deleted":
      return new ProposalDeleted(ref);
    case "not_draft":
      return new ProposalNotDeletable(ref, block.status);
    case "letters":
      return new ProposalCitedByLetter(block.refs);
  }
}
