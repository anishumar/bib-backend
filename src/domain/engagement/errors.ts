import type { LetterDeletionBlock } from "./model";
import { countryCodeProblem } from "../country";
import { amountProblem } from "../money/model";

// Sentinel errors for engagement letters; `api/domainerr.ts` maps them to HTTP. Match with
// `instanceof`, never by string.

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
  | "ORIGINATOR_NOT_STAFF"
  | "LETTER_DELETED"
  | "LETTER_NOT_DELETABLE"
  | "LETTER_NOT_COPYABLE"
  | "QUOTE_DELETED"
  | "LETTER_NOT_FOUND"
  | "LETTER_LINE_NOT_FOUND"
  | "LETTER_NOT_EDITABLE"
  | "LETTER_NOT_SIGNABLE"
  | "EMPTY_LETTER"
  | "NO_CLAUSES"
  | "LETTER_HAS_NO_BODY"
  | "INVALID_LETTER_TRANSITION"
  | "INVALID_JURISDICTION"
  | "CLAUSE_NOT_FOUND"
  | "NOT_A_CLAUSE"
  | "CLAUSE_NOT_PUBLISHED"
  | "CLAUSE_WRONG_JURISDICTION"
  | "CLAUSE_LAW_NOT_ISSUERS"
  | "ISSUER_JURISDICTION_UNKNOWN"
  | "SERVICE_NOT_QUOTABLE"
  | "ADVANCE_NOT_REQUIRED"
  | "ADVANCE_ALREADY_RECORDED"
  | "ADVANCE_AMOUNT_REQUIRED"
  | "INVALID_AMOUNT"
  | "UNPRICED_LINE_NEEDS_REASON"
  | "SERVICE_HAS_NO_LIST_PRICE"
  | "UNPRICED_LINE_HAS_DISCOUNT"
  | "INVALID_BILLING_FREQUENCY"
  | "INVALID_BILLING_TIMING"
  | "INVALID_LINE_ADVANCE"
  | "ONE_KIND_OF_ADVANCE"
  | "INVALID_OOP_ESTIMATE"
  | "INVALID_DATE"
  | "LETTER_NOT_SUPERSEDABLE"
  | "ALREADY_SUPERSEDED"
  | "ENGAGEMENT_NOT_FOUND"
  | "ENGAGEMENT_NOT_ACTIVE"
  | "ENGAGEMENT_ENDED"
  | "ENGAGEMENT_NOT_PAUSED"
  | "END_REASON_REQUIRED"
  | "INVALID_END_DATE"
  | "SIGNATURE_INCOMPLETE"
  | "SIGNER_UNAVAILABLE"
  | "SIGNATURE_REQUEST_NOT_PENDING"
  | "ENVELOPE_ALREADY_SIGNED"
  | "QUOTE_NOT_FOUND"
  | "QUOTE_NOT_ACCEPTED"
  | "QUOTE_HAS_NO_LINES"
  | "QUOTE_JURISDICTION_UNCLEAR"
  | "QUOTE_NAMES_NO_ENTITY"
  | "PARTY_ARCHIVED"
  | "COMPANY_NOT_REGISTERED"
  | "CLIENT_IS_OWN_COMPANY"
  | "ISSUER_NOT_A_FIRM_ENTITY"
  | "QUOTE_OF_ANOTHER_CLIENT"
  | "ADDRESSEE_NOT_A_PERSON"
  | "ADDRESSEE_NOT_LINKED"
  | "ENTITY_OUTSIDE_CLIENT"
  | "FEE_GROUP_NOT_FOUND"
  | "FEE_GROUP_TITLE_REQUIRED"
  | "FEE_GROUP_NOT_EMPTY"
  | "FEE_GROUP_EMPTY"
  | "GROUPED_LINE_PRICED"
  | "LINE_NOT_PRICED"
  | "NOTHING_TO_REVISE"
  | "NOTHING_TO_CHANGE_ON_LINE"
  | "INVALID_LINE_DESCRIPTION"
  | "INVALID_CURRENCY_CHANGE"
  | "CURRENCY_LOCKED_BY_LINES"
  | "CURRENCY_NEEDS_A_RATE"
  | "RATE_IN_USE"
  | "LINE_CURRENCY_IS_SECTIONS"
  | "RATE_FOR_MAIN_CURRENCY"
  | "PROSE_EDITED"
  | "TERMS_ON_LETTER"
  | "NOT_CALLERS_TODAY";

// Revising a DRAFT letter (T6.18, S6): the builder edits a draft's head and lines in place; a
// sent letter is refused as LETTER_NOT_EDITABLE.

export class NothingToRevise extends EngagementError {
  constructor() {
    super(
      "NOTHING_TO_REVISE",
      `Nothing to change: send at least one of the letter's title, Background, addressee, ` +
        `dates, advance, country, issuer or currency.`,
    );
  }
}

export class NothingToChangeOnLetterLine extends EngagementError {
  constructor() {
    super(
      "NOTHING_TO_CHANGE_ON_LINE",
      `Nothing to change on this line: send at least one of its wording, company, quantity, ` +
        `fee, discount, billing frequency, pricing note, start date or scope texts.`,
    );
  }
}

export class InvalidLetterLineDescription extends EngagementError {
  constructor() {
    super(
      "INVALID_LINE_DESCRIPTION",
      `A service on a letter needs a name: it is what the client reads for it. Type the ` +
        `service's name, or press Escape to keep what it said.`,
    );
  }
}

export class LetterInvalidCurrencyChange extends EngagementError {
  constructor() {
    super(
      "INVALID_CURRENCY_CHANGE",
      `A currency change sends the currency, the exchange rate and the day of the rate ` +
        `together: a rate belongs to one currency on one day.`,
    );
  }
}

/** Every line and section fee is priced in the letter's currency by a composite key (0017,
 *  0083), and a line pulled off a draft still holds its row. */
export class LetterCurrencyLocked extends EngagementError {
  constructor(currency: string) {
    super(
      "CURRENCY_LOCKED_BY_LINES",
      `This letter prices services or sections in ${currency}, its main currency. Move them to ` +
        `another currency or remove them first, or keep ${currency}.`,
    );
  }
}

/** A new issuer or country would replace prose written for this client. */
export class LetterProseEdited extends EngagementError {
  constructor(
    readonly editedCount: number,
    issuerName: string,
  ) {
    super(
      "PROSE_EDITED",
      `${String(editedCount)} line${editedCount === 1 ? "" : "s"} of this letter's wording ` +
        `${editedCount === 1 ? "was" : "were"} edited or written for this client, and the change ` +
        `replaces the wording with ${issuerName}'s standard set. Send replaceEditedProse: true to ` +
        `replace ${editedCount === 1 ? "it" : "them"} anyway, or keep the letter as it is.`,
    );
  }
}

/** Each term was checked against the issuer's law and the letter's country when added (G1.8)
 *  and cannot come off, so moving either would leave terms naming the wrong law. */
export class TermsOnLetter extends EngagementError {
  constructor(termCount: number, issuerName: string) {
    super(
      "TERMS_ON_LETTER",
      `This letter already carries ${String(termCount)} term${termCount === 1 ? "" : "s"}, chosen ` +
        `for ${issuerName}'s law and courts. A term cannot be taken off a letter, so the company ` +
        `issuing it and its country stay as they are. To issue it from another company or for ` +
        `another country, delete this draft and start a new letter.`,
    );
  }
}

/** An archived client or line company (0305): restore it first. */
export class LetterPartyArchived extends EngagementError {
  constructor(displayName: string, as: "client" | "entity") {
    super(
      "PARTY_ARCHIVED",
      `${displayName} is archived, so ${as === "client" ? "a new engagement letter cannot be drafted for them" : "a letter line cannot be for them"}. ` +
        `If the firm is working with them again, restore them from their client page first: ` +
        `restoring is its own step, so that putting a client away is never undone without ` +
        `somebody seeing it.`,
    );
  }
}

/** A client company with no country (Q076): no new letter or line may name it. */
export class LetterCompanyNotRegistered extends EngagementError {
  constructor(displayName: string, as: "client" | "entity") {
    const what = as === "client" ? "an engagement letter cannot be drafted for it" : "a letter line cannot be for it";
    super("COMPANY_NOT_REGISTERED", `${displayName} has no country recorded, so ${what}. Record its country and company type on its client page first: without them no filing can be worked out for it and none of the firm's companies can be chosen to bill it.`);
  }
}

/** The firm does not sign a letter with itself, as an invoice cannot bill it. */
export class LetterClientIsOwnCompany extends EngagementError {
  constructor(displayName: string) {
    super(
      "CLIENT_IS_OWN_COMPANY",
      `${displayName} is one of your own companies, so it cannot be the client on an ` +
        `engagement letter. Choose the client the letter is for.`,
    );
  }
}

// Who a letter names beside the client (F-10-1): each reference must belong to this client or
// the firm, not merely the firm. Refusals say which fact to record, not "retry".

export class IssuerNotAFirmEntity extends EngagementError {
  constructor(displayName: string) {
    super(
      "ISSUER_NOT_A_FIRM_ENTITY",
      `${displayName} is not one of the firm's own companies, so it cannot issue this letter. ` +
        `Choose one of the firm's companies, or leave "Issued by" blank and the firm's rule ` +
        `for the letter's country picks it.`,
    );
  }
}

export class QuoteOfAnotherClient extends EngagementError {
  constructor(ref: string, quotedTo: string, letterFor: string) {
    super(
      "QUOTE_OF_ANOTHER_CLIENT",
      `${ref} is a quote to ${quotedTo}, and this letter is for ${letterFor}. A letter can only ` +
        `say it was drafted from a quote made to the same client.`,
    );
  }
}

export class AddresseeNotAPerson extends EngagementError {
  constructor(displayName: string) {
    super(
      "ADDRESSEE_NOT_A_PERSON",
      `${displayName} is a company, and a letter is addressed to a person at the client. ` +
        `Leave "Addressed to" blank to address the letter to the company itself.`,
    );
  }
}

export class AddresseeNotLinked extends EngagementError {
  constructor(person: string, client: string) {
    super(
      "ADDRESSEE_NOT_LINKED",
      `${person} has no recorded role at ${client} or any of its companies, so the letter ` +
        `cannot be addressed to them. Record them on ${client}'s client page as a director, ` +
        `authorised signatory, employee or shareholder first, or choose somebody who is.`,
    );
  }
}

export class EntityOutsideClient extends EngagementError {
  constructor(entity: string, client: string) {
    super(
      "ENTITY_OUTSIDE_CLIENT",
      `${entity} is not ${client} and is not recorded as one of its companies, so this letter ` +
        `cannot cover work for it. Record the link on ${client}'s client page first (a ` +
        `subsidiary, or a company ${client} holds shares in or is a director of), or put this ` +
        `work on a letter to ${entity}'s own client.`,
    );
  }
}

export class LetterNotFound extends EngagementError {
  constructor(id: string) {
    super("LETTER_NOT_FOUND", `No engagement letter ${JSON.stringify(id)} at this firm`);
  }
}

export class LetterLineNotFound extends EngagementError {
  constructor(id: string) {
    super("LETTER_LINE_NOT_FOUND", `No line ${JSON.stringify(id)} on this engagement letter`);
  }
}

export class LetterNotEditable extends EngagementError {
  constructor(status: string) {
    super(
      "LETTER_NOT_EDITABLE",
      status === "signed"
        ? `this letter is signed, and a signed letter never changes: the database refuses it, ` +
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
      `An engagement letter with no lines commits the firm to nothing and the client to ` +
        `nothing. Add at least one service before sending it.`,
    );
  }
}

export class NoClauses extends EngagementError {
  constructor() {
    super(
      "NO_CLAUSES",
      `An engagement letter with no clauses has no terms: no scope, no liability limit, no ` +
        `termination. Signing one leaves the firm bound by whatever is read into it. Add at ` +
        `least one clause from the library first.`,
    );
  }
}

/** CA#2 (audit 2026-10-03): a new firm has no standard opening, so its first letter went out
 *  with nothing between greeting and sign-off. The product writes no letter prose (0083). */
export class LetterHasNoBody extends EngagementError {
  constructor() {
    super(
      "LETTER_HAS_NO_BODY",
      `This letter has no opening text: page 1 goes from the greeting straight to "Yours ` +
        `sincerely,". Write a few lines under Cover letter before sending it. Once the firm's ` +
        `standard opening is set in Standard wording, every new letter starts with it.`,
    );
  }
}

export class InvalidLetterTransition extends EngagementError {
  constructor(from: string, to: string) {
    super(
      "INVALID_LETTER_TRANSITION",
      `An engagement letter cannot go from ${from} to ${to}. Signing is final: the document ` +
        `freezes, and a withdrawn letter stays withdrawn, so that the interval in which it ` +
        `was off the table is still on the record.`,
    );
  }
}

export class InvalidJurisdiction extends EngagementError {
  constructor(value: string) {
    super(
      "INVALID_JURISDICTION",
      countryCodeProblem(value),
    );
  }
}

export class ClauseNotFound extends EngagementError {
  constructor(versionId: string) {
    super(
      "CLAUSE_NOT_FOUND",
      `No configuration version ${JSON.stringify(versionId)} at this firm. A letter's terms ` +
        `come from the clause library, and the id has to be one this firm published.`,
    );
  }
}

export class NotAClause extends EngagementError {
  constructor(versionId: string, kind: string) {
    super(
      "NOT_A_CLAUSE",
      `Configuration version ${JSON.stringify(versionId)} is a ${kind}, not a clause.`,
    );
  }
}

export class ClauseNotPublished extends EngagementError {
  constructor(versionId: string) {
    // A superseded (archived) version is fine: that is what a pin resolves to.
    super(
      "CLAUSE_NOT_PUBLISHED",
      `Clause version ${JSON.stringify(versionId)} is still a draft and was never in force, so ` +
        `it cannot be put in a contract. Publish it first. (A version that has since been ` +
        `superseded is fine: that is what a pinned clause is supposed to resolve to.)`,
    );
  }
}

export class ClauseWrongJurisdiction extends EngagementError {
  constructor(title: string, clauseJurisdictions: readonly string[], letter: string) {
    super(
      "CLAUSE_WRONG_JURISDICTION",
      `The clause ${JSON.stringify(title)} applies in ${clauseJurisdictions.join(", ")} and this ` +
        `letter is written for ${letter}. A term drafted for another jurisdiction may be ` +
        `unenforceable or simply wrong here, so it is refused rather than quietly included.`,
    );
  }
}

/**
 * G1.8: a letter issued by the US entity cannot print Indian governing law. The real letter did
 * (US entity, US client, Indian law, Delhi courts); the firm: "For US it's US. For UAE it's DIFC
 * in Dubai." Unlike `ClauseWrongJurisdiction` (where a clause may be USED), this checks what it
 * SAYS against who contracts. `term` names which failed, law or forum.
 */
export class ClauseLawNotIssuers extends EngagementError {
  constructor(title: string, term: "governing law" | "courts", named: string, issuer: string) {
    super(
      "CLAUSE_LAW_NOT_ISSUERS",
      `The clause ${JSON.stringify(title)} names ${named} as its ${term}, and this letter is ` +
        `issued by an entity registered in ${issuer}. A document cannot put another country's ` +
        `${term} on the firm's own counterparty, so it is refused rather than printed. Use a ` +
        `clause whose ${term} is ${issuer}, or issue the letter from the ${named} entity.`,
    );
  }
}

/**
 * The check above with nothing to check against: `seedFirmEntity` writes no `core.legal_entity`
 * row (no country is known at `createTenant`), so a firm's default issuer is unregistered until
 * somebody registers it. Fail-closed on purpose, as that is where the bug lived; a clause naming
 * no law is untouched.
 */
export class IssuerJurisdictionUnknown extends EngagementError {
  constructor(title: string, entityName: string) {
    super(
      "ISSUER_JURISDICTION_UNKNOWN",
      `The clause ${JSON.stringify(title)} names a governing law or a forum, and this letter is ` +
        `issued by ${JSON.stringify(entityName)}, which has no registered jurisdiction, so ` +
        `there is nothing to check the term against. Register that entity (its jurisdiction, ` +
        `entity type and incorporation) and the clause goes on, or use a clause that names ` +
        `neither term.`,
    );
  }
}

export class ServiceNotQuotable extends EngagementError {
  constructor(versionId: string, reason: string) {
    super("SERVICE_NOT_QUOTABLE", `Service version ${JSON.stringify(versionId)}: ${reason}`);
  }
}

export class AdvanceNotRequired extends EngagementError {
  constructor() {
    super(
      "ADVANCE_NOT_REQUIRED",
      `This letter does not require an advance, so there is nothing to record. Recording one ` +
        `would put a receipt in the audit trail for money nobody asked for.`,
    );
  }
}

export class AdvanceAlreadyRecorded extends EngagementError {
  constructor(at: string) {
    super(
      "ADVANCE_ALREADY_RECORDED",
      `The advance on this letter was already recorded at ${at}. Recording it twice would show ` +
        `two receipts in a log that cannot be corrected for one payment.`,
    );
  }
}

export class AdvanceAmountRequired extends EngagementError {
  constructor() {
    super(
      "ADVANCE_AMOUNT_REQUIRED",
      `A letter that requires an advance has to say how much. "An advance is required" with no ` +
        `figure is a gate nobody can pass.`,
    );
  }
}

export class InvalidAmount extends EngagementError {
  constructor(field: string, value: string) {
    super(
      "INVALID_AMOUNT",
      amountProblem(`The ${field}`, value, {
        ...(field === "discount" ? { percent: true } : {}),
        ...(field === "exchange rate" ? { places: 10 } : {}),
      }),
    );
  }
}

/** No fee, no reason, and no catalogue list price in the letter's currency (B09, audit
 *  2026-10-03). With a list price the line takes it, which is how a login that cannot see fees
 *  adds a priced service. */
export class ServiceHasNoListPrice extends EngagementError {
  constructor(serviceName: string, currency: string) {
    super(
      "SERVICE_HAS_NO_LIST_PRICE",
      `${serviceName} has no list price in ${currency} in the catalogue. ` +
        "Enter the fee, or say why there is no fixed fee.",
    );
  }
}

export class UnpricedLineNeedsReason extends EngagementError {
  constructor() {
    super(
      "UNPRICED_LINE_NEEDS_REASON",
      `A line with no unit amount has to say WHY: "As mutually agreed". Send a "pricingNote" ` +
        `with it. On a letter this is a TERM: the signature commits to it, and a blank where a ` +
        `price belongs is a term nobody can read afterwards.`,
    );
  }
}

export class UnpricedLineHasDiscount extends EngagementError {
  constructor(percent: string) {
    super(
      "UNPRICED_LINE_HAS_DISCOUNT",
      `A line with no unit amount cannot carry a discount of ${JSON.stringify(percent)}: a ` +
        `percentage off "as mutually agreed" is not a number. Price the line, or send "0".`,
    );
  }
}

export class InvalidLineBillingFrequency extends EngagementError {
  constructor(value: string, allowed: readonly string[]) {
    super(
      "INVALID_BILLING_FREQUENCY",
      `Billing frequency ${JSON.stringify(value)} must be one of ${allowed.join(", ")}. It is ` +
        `how often this DEAL is invoiced, which is not how often the work comes round.`,
    );
  }
}

/** Billing timing (0319): one of three words, a date only with "on_date", per-period fees only. */
export class InvalidLetterBillingTiming extends EngagementError {
  constructor(reason: string) {
    super(
      "INVALID_BILLING_TIMING",
      `Billing timing: ${reason}. Send "arrears" (on each period's last day), "advance" (at its start) ` +
        `or "on_date" with "billingOn" (YYYY-MM-DD), for a monthly, quarterly or yearly fee only.`,
    );
  }
}

/** A service's own advance (0320): above zero, before tax, on a line priced on its own. */
export class InvalidLineAdvance extends EngagementError {
  constructor(reason: string) {
    super(
      "INVALID_LINE_ADVANCE",
      `Advance: ${reason}. Send "advanceAmount" as a decimal string above zero (at most four decimals, ` +
        `before tax), or null for none. A service in a fee group has no advance of its own: ` +
        `ask for one advance for the whole letter instead.`,
    );
  }
}

/** One advance for the whole letter or one per service, never both (the user, 2026-10-01): two
 *  would hold a service's work for two payments. */
export class OneKindOfAdvance extends EngagementError {
  constructor(has: "letter" | "services") {
    super(
      "ONE_KIND_OF_ADVANCE",
      has === "letter"
        ? `This letter already asks for one advance for the whole letter, so a service cannot have ` +
            `its own as well. Turn the letter's advance off first, or keep it and leave the services without one.`
        : `Some services on this letter have their own advance, so the letter cannot also ask for one ` +
            `for the whole of it. Clear the services' advances first, or keep them.`,
    );
  }
}

export class InvalidOutOfPocketEstimate extends EngagementError {
  constructor(reason: string) {
    super(
      "INVALID_OOP_ESTIMATE",
      `Out-of-pocket estimate: ${reason}. It is a RANGE in its own currency: ` +
        `{"min": "5000", "max": "6000", "currency": "USD"}, reimbursed at actuals and separate ` +
        `from the fee, so all three travel together or none of them do.`,
    );
  }
}

export class InvalidDate extends EngagementError {
  constructor(field: string, value: string) {
    super(
      "INVALID_DATE",
      `${field} ${JSON.stringify(value)} must be a calendar day as YYYY-MM-DD: "2026-10-01". ` +
        `A day, not an instant: an engagement that begins on 1 October begins on the client's ` +
        `1 October, and midnight UTC is somebody else's evening.`,
    );
  }
}

/** `asOf` is the caller's TODAY (see `isCallersToday`); another day goes in `issuedOn` or
 *  `effectiveFrom`. */
export class LetterNotCallersToday extends EngagementError {
  constructor(given: string, firmDay: string) {
    super(
      "NOT_CALLERS_TODAY",
      `The day sent as asOf, ${JSON.stringify(given)}, cannot be today where you are: the firm's ` +
        `day is ${firmDay}, and anywhere in the world today is that day or the one either side. ` +
        `To date a letter or start its work on another day, set its issuedOn or effectiveFrom.`,
    );
  }
}

export class LetterNotSupersedable extends EngagementError {
  constructor(status: string) {
    super(
      "LETTER_NOT_SUPERSEDABLE",
      `Only a SIGNED letter can be superseded, and this one is ${status}. A draft is edited in ` +
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
    super("ENGAGEMENT_NOT_FOUND", `No engagement ${JSON.stringify(id)} at this firm`);
  }
}

/** Already ended (V2.3): a returning client signs a new letter. */
export class EngagementEnded extends EngagementError {
  constructor(endsOn: string | null) {
    super(
      "ENGAGEMENT_ENDED",
      `This engagement has already ended${endsOn === null ? "" : ` (last day ${endsOn})`}. ` +
        `To take the client back, sign a new engagement letter.`,
    );
  }
}

/** Only running work can be paused (V2.3). */
export class EngagementNotActive extends EngagementError {
  constructor(status: string) {
    super(
      "ENGAGEMENT_NOT_ACTIVE",
      status === "paused"
        ? "This engagement is already paused."
        : "This engagement has not started: it is waiting for its advance. Record the advance " +
            "first, or end it.",
    );
  }
}

export class EngagementNotPaused extends EngagementError {
  constructor() {
    super("ENGAGEMENT_NOT_PAUSED", "This engagement is not paused, so there is nothing to resume.");
  }
}

export class EndReasonRequired extends EngagementError {
  constructor(max: number) {
    super(
      "END_REASON_REQUIRED",
      `Say why the engagement is ending, in up to ${String(max)} characters.`,
    );
  }
}

export class InvalidEndDate extends EngagementError {
  constructor(value: string) {
    super(
      "INVALID_END_DATE",
      `${JSON.stringify(value)} is not a calendar day. Give the last day you serve the client, ` +
        `as YYYY-MM-DD.`,
    );
  }
}

export class SignatureIncomplete extends EngagementError {
  constructor(missing: string) {
    super(
      "SIGNATURE_INCOMPLETE",
      `A signature needs ${missing}. A letter recorded as signed with any of it missing is one ` +
        `nobody can verify, which is worse than an unsigned one because it claims otherwise.`,
    );
  }
}

/** The e-signature provider failed (token refused, account not discovered, non-JSON answer), not
 *  the letter: the caller gets the provider's detail verbatim, not "internal error". */
export class SignerUnavailable extends EngagementError {
  constructor(detail: string) {
    super("SIGNER_UNAVAILABLE", detail);
  }
}

/** Nothing left to retry (never sent via a provider, or the envelope is out). A CONFLICT: the
 *  letter's state refuses it, not the request's form. */
export class SignatureRequestNotPending extends EngagementError {
  constructor(letterId: string, why: string) {
    super(
      "SIGNATURE_REQUEST_NOT_PENDING",
      `Letter ${JSON.stringify(letterId)} has no signature request waiting to be raised: ${why}.`,
    );
  }
}

/** Withdraw pressed on a letter the client already signed via the provider, before the sweep
 *  caught up: withdrawing would discard a real signature. */
export class EnvelopeAlreadySigned extends EngagementError {
  constructor(envelopeId: string) {
    super(
      "ENVELOPE_ALREADY_SIGNED",
      `The client has already finished signing envelope ${envelopeId}, so this letter cannot ` +
        `be withdrawn. It will be recorded as signed on the next signature check. To change ` +
        `the terms now, draft a letter that supersedes it.`,
    );
  }
}

// Drafting a letter from an accepted quote (T3.5b). Each refusal is a question only a person can
// answer: a guessed contract term (whose company, whose law) would look agreed on the signed page.

export class QuoteNotFound extends EngagementError {
  constructor(id: string) {
    super("QUOTE_NOT_FOUND", `No proposal ${JSON.stringify(id)} at this firm.`);
  }
}

export class QuoteNotAccepted extends EngagementError {
  constructor(ref: string, status: string) {
    super(
      "QUOTE_NOT_ACCEPTED",
      `${ref} is ${status}, and a letter is drafted from a quote the client has ACCEPTED. ` +
        `Record the acceptance first: that is the act that turns an offer into something to ` +
        `write up. A quote that was rejected or has expired is not re-opened: a client who ` +
        `comes back is a new quote.`,
    );
  }
}

export class QuoteHasNoLines extends EngagementError {
  constructor(ref: string) {
    super(
      "QUOTE_HAS_NO_LINES",
      `${ref} has no lines, so there is nothing to carry across. Drafting an empty letter ` +
        `would spend a reference number on a document with no terms in it.`,
    );
  }
}

export class QuoteJurisdictionUnclear extends EngagementError {
  constructor(ref: string, found: readonly string[]) {
    super(
      "QUOTE_JURISDICTION_UNCLEAR",
      found.length === 0
        ? `no line on ${ref} says which country the work is in, and a letter states one for the ` +
            `whole document: it settles governing law, the courts, and which of the firm's own ` +
            `companies contracts. Say which.`
        : `${ref} quotes work in ${found.join(", ")}, and a letter states ONE country for the ` +
            `whole document because that is what decides its governing law. Say which this ` +
            `letter is under, or write one letter per country.`,
    );
  }
}

export class QuoteNamesNoEntity extends EngagementError {
  constructor(ref: string, lineCount: number) {
    super(
      "QUOTE_NAMES_NO_ENTITY",
      `Not one line on ${ref} names the company the work is for, so nothing can be carried ` +
        `across: a proposal may quote a prospect that holds no entity yet, and every letter ` +
        `line must name one because signing it creates an engagement, which is one service ` +
        `for one legal entity. Name the company ${lineCount === 1 ? "that line" : "those lines"} ` +
        `is for, or add the lines by hand.`,
    );
  }
}

// Fee groups: one fee for several services (0083).

export class FeeGroupNotFound extends EngagementError {
  constructor(id: string) {
    super("FEE_GROUP_NOT_FOUND", `No fee group ${JSON.stringify(id)} on this engagement letter`);
  }
}

export class FeeGroupTitleRequired extends EngagementError {
  constructor() {
    super(
      "FEE_GROUP_TITLE_REQUIRED",
      `A fee group needs a title: "Ongoing recurring services". It is the heading of its ` +
        `section of the letter and the name its row in the Summary of Fees goes by.`,
    );
  }
}

/** The 0083 trigger refuses it too: its services would have no price and no reason. */
export class FeeGroupNotEmpty extends EngagementError {
  constructor(title: string, serviceCount: number) {
    super(
      "FEE_GROUP_NOT_EMPTY",
      `"${title}" still covers ${String(serviceCount)} service${serviceCount === 1 ? "" : "s"} ` +
        `on this letter. Move ${serviceCount === 1 ? "it" : "them"} into another group, give ` +
        `${serviceCount === 1 ? "it a price" : "them prices"} of ${serviceCount === 1 ? "its" : "their"} ` +
        `own, or remove ${serviceCount === 1 ? "it" : "them"} from the letter first: struck out, ` +
        `the group would leave ${serviceCount === 1 ? "it" : "them"} with no price at all.`,
    );
  }
}

/** A fee for nothing is not a term anybody can read — refused at send. */
export class FeeGroupEmpty extends EngagementError {
  constructor(title: string) {
    super(
      "FEE_GROUP_EMPTY",
      `The fee group "${title}" covers no services, so the letter would charge its fee for ` +
        `nothing it names. Put the services it pays for into it, or strike it out, before ` +
        `sending the letter.`,
    );
  }
}

/** A grouped line carrying its own price would be counted twice. */
export class GroupedLinePriced extends EngagementError {
  constructor() {
    super(
      "GROUPED_LINE_PRICED",
      `A service covered by a fee group has no price or discount of its own: the group's fee ` +
        `pays for it, and a price on both would charge the client twice. Leave "unitAmount" ` +
        `out and send a discount of "0", or take the service out of the group.`,
    );
  }
}

/** 0023's rule (a price or a reason), met again when a service leaves its fee group. */
export class LineNotPriced extends EngagementError {
  constructor(description: string) {
    super(
      "LINE_NOT_PRICED",
      `Priced on its own, "${description}" needs a price: send its "unitAmount", or a ` +
        `"pricingNote" saying why it has none ("As mutually agreed"). Outside a fee group ` +
        `nothing else on the letter says what it costs.`,
    );
  }
}

// Deleting a draft made by mistake (0086).

/** A deleted draft is final: every change, a second delete or a withdrawal lands here. */
export class LetterDeleted extends EngagementError {
  constructor(ref: string) {
    super(
      "LETTER_DELETED",
      `${ref} was deleted as made by mistake, and a deleted draft is final: nothing about it ` +
        `changes again. If the engagement is real after all, draft a new letter.`,
    );
  }
}

/** Only a withdrawn letter is copied into a new draft (0316). */
export class LetterNotCopyable extends EngagementError {
  constructor(ref: string, status: string) {
    super(
      "LETTER_NOT_COPYABLE",
      `${ref} is ${status}. Only a withdrawn letter is copied into a new draft. ` +
        (status === "draft"
          ? `This one is still a draft, so change it directly.`
          : status === "sent"
            ? `The client still has this one; withdraw it first if the terms have to change.`
            : `A signed letter is changed by drafting a new letter that supersedes it.`),
    );
  }
}

export class LetterNotDeletable extends EngagementError {
  constructor(ref: string, status: string) {
    super(
      "LETTER_NOT_DELETABLE",
      status === "signed"
        ? `${ref} is signed, and a signed letter is the record of what the client agreed to, so ` +
          `it is never deleted. Draft a new letter that supersedes it instead.`
        : `${ref} is ${status}, and only a draft that never went out can be deleted. ` +
          (status === "sent"
            ? `The client has it; withdraw it instead, which keeps the record that it was offered.`
            : `It stays on record as ${status}.`),
    );
  }
}

/** A deleted proposal (0086) was never offered, so no letter may cite it. */
export class QuoteDeleted extends EngagementError {
  constructor(ref: string) {
    super(
      "QUOTE_DELETED",
      `${ref} was deleted as made by mistake, so a letter cannot be drafted from it or cite it. ` +
        `Draft the letter on its own, or from the quote that was really offered.`,
    );
  }
}

/** One sentence for both the refused DELETE and the letter page, where the button would be. */
export function letterDeletionRefusal(ref: string, block: LetterDeletionBlock): EngagementError {
  switch (block.kind) {
    case "deleted":
      return new LetterDeleted(ref);
    case "not_draft":
      return new LetterNotDeletable(ref, block.status);
  }
}

/** A fee in a currency with no rate on the document (0344): without one it would drop out of
 *  every figure converted to the firm's reporting currency. */
export class CurrencyNeedsARate extends EngagementError {
  constructor(currency: string) {
    super(
      "CURRENCY_NEEDS_A_RATE",
      `Give ${currency} an exchange rate on this letter first, then price services in it.`,
    );
  }
}

/** A rate still in use by live services or sections cannot be taken off. */
export class RateInUse extends EngagementError {
  constructor(currency: string, count: number) {
    super(
      "RATE_IN_USE",
      `${String(count)} ${count === 1 ? "fee is" : "fees are"} in ${currency}. Move ` +
        `${count === 1 ? "it" : "them"} to another currency or remove ${count === 1 ? "it" : "them"} ` +
        `first, then remove the rate.`,
    );
  }
}

/** A sectioned service is priced in the section's currency (0344): the key onto it carries it. */
export class LineCurrencyFollowsSection extends EngagementError {
  constructor(section: string, currency: string) {
    super(
      "LINE_CURRENCY_IS_SECTIONS",
      `This service is priced by the section "${section}", which is in ${currency}. Change the ` +
        `section's currency, or take the service out of the section first.`,
    );
  }
}

/** The main currency's rate is the document's own; it has no second one. */
export class RateIsMainCurrency extends EngagementError {
  constructor(currency: string) {
    super(
      "RATE_FOR_MAIN_CURRENCY",
      `${currency} is this letter's main currency. Change its rate with the currency on step 1.`,
    );
  }
}

/** The originator must be active staff of this firm (0355, Q049): the key reaches the global
 *  user account, so another firm's person could otherwise be credited with this revenue. */
export class OriginatorNotStaff extends EngagementError {
  constructor() {
    super(
      "ORIGINATOR_NOT_STAFF",
      "That person is not active staff of this firm, so the work cannot be credited to them. Pick a colleague from the list.",
    );
  }
}
