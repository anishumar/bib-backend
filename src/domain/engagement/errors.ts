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
  | "CLAUSE_LAW_NOT_ISSUERS"
  | "ISSUER_JURISDICTION_UNKNOWN"
  | "SERVICE_NOT_QUOTABLE"
  | "ADVANCE_NOT_REQUIRED"
  | "ADVANCE_ALREADY_RECORDED"
  | "ADVANCE_AMOUNT_REQUIRED"
  | "INVALID_AMOUNT"
  | "UNPRICED_LINE_NEEDS_REASON"
  | "UNPRICED_LINE_HAS_DISCOUNT"
  | "INVALID_BILLING_FREQUENCY"
  | "INVALID_OOP_ESTIMATE"
  | "INVALID_DATE"
  | "LETTER_NOT_SUPERSEDABLE"
  | "ALREADY_SUPERSEDED"
  | "ENGAGEMENT_NOT_FOUND"
  | "ENGAGEMENT_NOT_ACTIVE"
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
  | "LINE_NOT_PRICED";

/** The client, or the company a line is for, was archived (0305). A letter
 *  may not name a party the firm put away; restore it first. */
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

// ── Who a letter names, beside the client (F-10-1) ─────────────────────────
//
// Every reference below was checked for the FIRM only: any party of the firm
// could be named, including another client's company. Each refusal says what
// to do instead, because the fix is usually a fact to record, not a retry.

/** The company named as issuing the letter is not one of the firm's own. */
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

/** The quote named as the letter's origin was made to a different client. */
export class QuoteOfAnotherClient extends EngagementError {
  constructor(ref: string, quotedTo: string, letterFor: string) {
    super(
      "QUOTE_OF_ANOTHER_CLIENT",
      `${ref} is a quote to ${quotedTo}, and this letter is for ${letterFor}. A letter can only ` +
        `say it was drafted from a quote made to the same client.`,
    );
  }
}

/** A letter is addressed to a PERSON, care of the client. */
export class AddresseeNotAPerson extends EngagementError {
  constructor(displayName: string) {
    super(
      "ADDRESSEE_NOT_A_PERSON",
      `${displayName} is a company, and a letter is addressed to a person at the client. ` +
        `Leave "Addressed to" blank to address the letter to the company itself.`,
    );
  }
}

/** The person holds no recorded role at the client or any company under it. */
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

/** A line's company is not the client, and not recorded as one of its companies. */
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
      `An engagement letter with no lines commits the firm to nothing and the client to ` +
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
      `An engagement letter with no clauses has no terms — no scope, no liability limit, no ` +
        `termination. Signing one leaves the firm bound by whatever is read into it. Add at ` +
        `least one clause from the library first.`,
    );
  }
}

export class InvalidLetterTransition extends EngagementError {
  constructor(from: string, to: string) {
    super(
      "INVALID_LETTER_TRANSITION",
      `An engagement letter cannot go from ${from} to ${to}. Signing is final — the document ` +
        `freezes — and a withdrawn letter stays withdrawn, so that the interval in which it ` +
        `was off the table is still on the record.`,
    );
  }
}

export class InvalidJurisdiction extends EngagementError {
  constructor(value: string) {
    super(
      "INVALID_JURISDICTION",
      `Jurisdiction ${JSON.stringify(value)} is not an ISO 3166 country code — two letters, ` +
        `like "IN" or "AE". The letter records the jurisdiction it was WRITTEN for, which is ` +
        `not always the client's or the firm's, so it has to be stated rather than inferred.`,
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
    // Archived is fine and deliberately so: that is what a pin resolves to once
    // the library moves on. A DRAFT was never in force, so putting it in a
    // contract binds the client to wording the firm never adopted.
    super(
      "CLAUSE_NOT_PUBLISHED",
      `Clause version ${JSON.stringify(versionId)} is still a draft and was never in force, so ` +
        `it cannot be put in a contract. Publish it first. (A version that has since been ` +
        `superseded is fine — that is what a pinned clause is supposed to resolve to.)`,
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
 * G1.8's acceptance, as a refusal: a letter issued by the US entity cannot
 * print Indian governing law.
 *
 * The sharpest finding of the project this product was designed against. The
 * real engagement letter was issued by the firm's US entity to a US client and
 * its standard terms named Indian law and Delhi courts. The firm's verdict was
 * flat — "No. This is wrong. For US it's US. For UAE it's DIFC in Dubai."
 *
 * `ClauseWrongJurisdiction` above could not have caught it and is a different
 * question: it asks where a clause may be USED, and the clause that went out
 * was applicable everywhere, which was true. This asks what the clause SAYS,
 * against who is actually contracting.
 *
 * The term names WHICH of the two failed — a letter can carry the right law and
 * the wrong forum, and half the bug the firm caught was the courts.
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
 * The check above, when there is nothing to check AGAINST.
 *
 * `seedFirmEntity` writes an organization and no `core.legal_entity` row, because
 * nothing knows the firm's country at `createTenant` — so every firm's default
 * issuing entity is unregistered until somebody registers it. That is ordinary,
 * and it is also exactly the position from which the original letter went out.
 *
 * REFUSED rather than allowed, and the choice is worth stating because it is
 * fail-closed on purpose. An unverifiable law is the state the bug lived in; if
 * this passed silently the check would be absent precisely where it is needed,
 * and present only for firms that had already done the work that makes them
 * safe. It costs nothing to any existing flow — a clause naming a law is
 * refused, a clause naming none is untouched, and `governingLaw` was added
 * yesterday, so no letter anywhere pins a clause this can refuse.
 */
export class IssuerJurisdictionUnknown extends EngagementError {
  constructor(title: string, entityName: string) {
    super(
      "ISSUER_JURISDICTION_UNKNOWN",
      `The clause ${JSON.stringify(title)} names a governing law or a forum, and this letter is ` +
        `issued by ${JSON.stringify(entityName)}, which has no registered jurisdiction — so ` +
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
      `${field} ${JSON.stringify(value)} must be a non-negative decimal STRING with at most ` +
        `four decimal places — "25000", "1499.50" — never a number, because a float cannot ` +
        `hold 1499.50 exactly.`,
    );
  }
}

export class UnpricedLineNeedsReason extends EngagementError {
  constructor() {
    super(
      "UNPRICED_LINE_NEEDS_REASON",
      `A line with no unit amount has to say WHY — "As mutually agreed". Send a "pricingNote" ` +
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

export class InvalidOutOfPocketEstimate extends EngagementError {
  constructor(reason: string) {
    super(
      "INVALID_OOP_ESTIMATE",
      `Out-of-pocket estimate: ${reason}. It is a RANGE in its own currency — ` +
        `{"min": "5000", "max": "6000", "currency": "USD"} — reimbursed at actuals and separate ` +
        `from the fee, so all three travel together or none of them do.`,
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

export class SignatureIncomplete extends EngagementError {
  constructor(missing: string) {
    super(
      "SIGNATURE_INCOMPLETE",
      `A signature needs ${missing}. A letter recorded as signed with any of it missing is one ` +
        `nobody can verify, which is worse than an unsigned one because it claims otherwise.`,
    );
  }
}

/**
 * The e-signature provider could not be asked. Not a SignatureIncomplete: the
 * person may have typed a perfectly good envelope id, and nothing about this
 * letter is wrong. The system BEHIND this one (a token refused, an account
 * that would not discover, a non-JSON answer) is what failed, and the caller
 * is told that in the provider's own words rather than "internal error".
 * The message is the detail verbatim; this class only names its kind.
 */
export class SignerUnavailable extends EngagementError {
  constructor(detail: string) {
    super("SIGNER_UNAVAILABLE", detail);
  }
}

/**
 * A retry of a signature request that has nothing left to retry: the letter
 * was never sent through a provider, or its envelope is already out.
 * A CONFLICT rather than a validation failure — the request is well formed and
 * what refuses it is the state the letter is in.
 */
export class SignatureRequestNotPending extends EngagementError {
  constructor(letterId: string, why: string) {
    super(
      "SIGNATURE_REQUEST_NOT_PENDING",
      `Letter ${JSON.stringify(letterId)} has no signature request waiting to be raised: ${why}.`,
    );
  }
}

/**
 * The firm pressed withdraw on a letter the client has, in fact, already
 * signed through the provider — the sweep has not caught up yet. Withdrawing
 * would throw away a real signature, and a signed letter is superseded, never
 * withdrawn.
 */
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

// ── DRAFTING A LETTER FROM AN ACCEPTED QUOTE (T3.5b) ───────────────────────
//
// Five refusals, and every one of them is a question only a person can answer.
// The alternative to each is this product GUESSING a term of a contract — which
// company the work is for, which country's law governs it — and a guessed term
// is indistinguishable, on the signed page, from one somebody agreed.

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
        `Record the acceptance first — that is the act that turns an offer into something to ` +
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
            `whole document — it settles governing law, the courts, and which of the firm's own ` +
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

// ── Fee groups — one fee for several services (0083) ───────────────────────

export class FeeGroupNotFound extends EngagementError {
  constructor(id: string) {
    super("FEE_GROUP_NOT_FOUND", `No fee group ${JSON.stringify(id)} on this engagement letter`);
  }
}

export class FeeGroupTitleRequired extends EngagementError {
  constructor() {
    super(
      "FEE_GROUP_TITLE_REQUIRED",
      `A fee group needs a title — "Ongoing recurring services". It is the heading of its ` +
        `section of the letter and the name its row in the Summary of Fees goes by.`,
    );
  }
}

/** Striking out a group that still prices services would leave them with no
 *  price and no reason — the trigger in 0083 refuses it too. */
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
      `A service covered by a fee group has no price or discount of its own — the group's fee ` +
        `pays for it, and a price on both would charge the client twice. Leave "unitAmount" ` +
        `out and send a discount of "0", or take the service out of the group.`,
    );
  }
}

/** A line priced on its own needs a price or a reason — 0023's rule for any
 *  line with no amount, met again when a service leaves its fee group. */
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
