// Sentinel errors — the closed vocabulary of ways invoicing fails. Owned in the
// domain; `api/domainerr.ts` maps them to HTTP status codes. Match with
// `instanceof`, never by string.
import { amountProblem } from "../money/model";
import type { NumberOutOfOrder } from "./model";

export class InvoiceError extends Error {
  constructor(
    readonly code: InvoiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type InvoiceErrorCode =
  | "INVOICE_NOT_FOUND"
  | "INVOICE_LINE_NOT_FOUND"
  | "INVOICE_NOT_EDITABLE"
  | "EMPTY_INVOICE"
  | "INVALID_INVOICE_TRANSITION"
  | "INVALID_INVOICE_CURRENCY"
  | "INVALID_INVOICE_AMOUNT"
  | "INVALID_SERIES_PREFIX"
  | "INVALID_INVOICE_DATE"
  | "IRN_ALREADY_REGISTERED"
  | "INVALID_PAYMENT_METHOD"
  | "INVALID_CREDIT_REASON"
  | "INVOICE_NOT_ISSUED"
  | "CREDIT_EXCEEDS_INVOICE"
  | "REVERSAL_EXCEEDS_PAID"
  | "DUNNING_ACTION_NOT_FOUND"
  | "DUNNING_NOT_AWAITING_APPROVAL"
  | "DUNNING_ALREADY_DECIDED"
  | "NOT_CALLERS_TODAY"
  | "ISSUER_NOT_A_FIRM_ENTITY"
  | "BILLS_THE_FIRM"
  | "PARTY_ARCHIVED"
  | "ENGAGEMENT_NOT_FOUND"
  | "ENGAGEMENT_OF_ANOTHER_CLIENT"
  | "ENGAGEMENT_OF_ANOTHER_ISSUER"
  | "ENGAGEMENT_IN_ANOTHER_CURRENCY"
  | "MANAGER_NOT_STAFF"
  | "INVOICE_MANAGER_FROZEN"
  | "CREDIT_NOTE_DATE_OUT_OF_RANGE"
  | "INVOICE_HAS_PAYMENTS"
  | "INVOICE_ADVANCE_MAPPED"
  | "DUNNING_NOTHING_OWED"
  | "CREDIT_EXCEEDS_UNUSED_ADVANCE"
  | "FX_RATE_REQUIRED"
  | "FX_RATE_NOT_ONE"
  | "DUE_DATE_IN_THE_PAST"
  | "DUE_BEFORE_ISSUE"
  | "INVOICE_NUMBER_OUT_OF_ORDER"
  | "INVALID_SAC"
  | "INVALID_PLACE_OF_SUPPLY"
  | "INVALID_TDS"
  | "PLACE_OF_SUPPLY_UNKNOWN"
  | "INVOICE_LINE_NEEDS_SAC"
  | "INVALID_COMPANY_INVOICING"
  | "COMPANY_RECORD_NOT_FOUND"
  | "CLIENT_NOT_FOUND";

/** `asOf` is the caller's TODAY, not a date to choose (see `isCallersToday`).
 *  A document that genuinely belongs to another day has its own field. */
export class NotCallersToday extends InvoiceError {
  constructor(given: string, firmDay: string) {
    super(
      "NOT_CALLERS_TODAY",
      `The day sent as asOf, ${JSON.stringify(given)}, cannot be today where you are: the firm's ` +
        `day is ${firmDay}, and anywhere in the world today is that day or the one either side. ` +
        `An invoice is dated the day it is issued; a credit note may take its own issuedOn.`,
    );
  }
}

// ── Who an invoice names (F-10-1) ──────────────────────────────────────────
//
// Each of these was checked for the FIRM only. An invoice's issuer opens a
// numbered GST series in its own name, so naming a client there cannot be
// undone; the other three put the wrong client on a tax document.

/** "Charged by" must be one of the firm's own companies. */
export class InvoiceIssuerNotAFirmEntity extends InvoiceError {
  constructor(displayName: string) {
    super(
      "ISSUER_NOT_A_FIRM_ENTITY",
      `${displayName} is not one of the firm's own companies, so it cannot issue an invoice. ` +
        `Under "Charged by", choose the firm's company that is charging.`,
    );
  }
}

/** "Bill to" must not be one of the firm's own companies. */
export class InvoiceBillsTheFirm extends InvoiceError {
  constructor(displayName: string) {
    super(
      "BILLS_THE_FIRM",
      `${displayName} is one of the firm's own companies, so an invoice cannot bill it. ` +
        `Under "Bill to", choose the client.`,
    );
  }
}

/** An archived client gains no new invoice, as it gains no new letter (0305). */
export class InvoicePartyArchived extends InvoiceError {
  constructor(displayName: string) {
    super(
      "PARTY_ARCHIVED",
      `${displayName} is archived, so a new invoice cannot be raised for them. If the firm is ` +
        `working with them again, restore them from their client page first.`,
    );
  }
}

export class InvoiceEngagementNotFound extends InvoiceError {
  constructor(id: string) {
    super("ENGAGEMENT_NOT_FOUND", `No engagement ${JSON.stringify(id)} at this firm.`);
  }
}

/**
 * The company that signed the letter charges for its work (2026-09-28).
 *
 * An invoice's number comes from its issuer's gapless series, so a line for
 * work another of the firm's companies contracted puts that sale in the wrong
 * company's GST books, and a number cannot be taken back: the invoice can only
 * be cancelled. The answer is a different invoice, not a different line.
 */
export class EngagementOfAnotherIssuer extends InvoiceError {
  constructor(letterRef: string, letterIssuer: string, invoiceIssuer: string) {
    super(
      "ENGAGEMENT_OF_ANOTHER_ISSUER",
      `That engagement is under ${letterRef}, which ${letterIssuer} signed, and this invoice is ` +
        `charged by ${invoiceIssuer}. Bill it on an invoice charged by ${letterIssuer}.`,
    );
  }
}

/**
 * An engagement is billed in the currency its letter priced it in (2026-09-28).
 *
 * A line takes the invoice's currency, so a letter priced at USD 3,000 a month
 * added to an INR invoice became ₹3,000, refused by nothing. One company signs
 * letters in several currencies (an Indian company billing an export client in
 * USD), so the issuer check does not cover it.
 */
export class EngagementInAnotherCurrency extends InvoiceError {
  constructor(letterRef: string, letterCurrency: string, invoiceCurrency: string) {
    super(
      "ENGAGEMENT_IN_ANOTHER_CURRENCY",
      `${letterRef} is priced in ${letterCurrency} and this invoice is in ${invoiceCurrency}. ` +
        `Bill this work on an invoice in ${letterCurrency}.`,
    );
  }
}

/** A line bills an engagement of the client the invoice is for, never another's. */
export class EngagementOfAnotherClient extends InvoiceError {
  constructor(engagementClient: string, invoiceClient: string) {
    super(
      "ENGAGEMENT_OF_ANOTHER_CLIENT",
      `That engagement is ${engagementClient}'s work, and this invoice bills ${invoiceClient}. ` +
        `A line can only bill an engagement of the client the invoice is for.`,
    );
  }
}

export class InvoiceNotFound extends InvoiceError {
  constructor(id: string) {
    super("INVOICE_NOT_FOUND", `No invoice ${JSON.stringify(id)} at this firm.`);
  }
}

export class InvoiceLineNotFound extends InvoiceError {
  constructor(id: string) {
    super("INVOICE_LINE_NOT_FOUND", `No line ${JSON.stringify(id)} on this invoice.`);
  }
}

/**
 * An issued invoice is not edited. It is CANCELLED and reissued.
 *
 * The database says the same thing in a trigger, and both are wanted: the
 * trigger is what an import or a psql session meets, and this is what gives a
 * screen an answer it can render.
 */
export class InvoiceNotEditable extends InvoiceError {
  constructor(id: string, status: string) {
    super(
      "INVOICE_NOT_EDITABLE",
      `Invoice ${JSON.stringify(id)} is ${status}, so what it says the client owes cannot ` +
        `change. Cancel it and issue a new one: both stay readable, which is the point.`,
    );
  }
}

/** An invoice with no lines is a demand for nothing. */
export class EmptyInvoice extends InvoiceError {
  constructor(id: string) {
    super(
      "EMPTY_INVOICE",
      `Invoice ${JSON.stringify(id)} has no lines, so it asks the client for nothing. Add a ` +
        `line before issuing it.`,
    );
  }
}

export class InvalidInvoiceTransition extends InvoiceError {
  constructor(from: string, to: string) {
    super(
      "INVALID_INVOICE_TRANSITION",
      `An invoice cannot go from ${from} to ${to}. An issued invoice is cancelled, never ` +
        `returned to draft: a copy has left the building.`,
    );
  }
}

export class InvalidInvoiceCurrency extends InvoiceError {
  constructor(given: string) {
    super(
      "INVALID_INVOICE_CURRENCY",
      `${JSON.stringify(given)} is not an ISO 4217 currency code.`,
    );
  }
}

/** What each field is called on the invoice screens, for the refusal (F12). */
const INVOICE_AMOUNT_LABELS: Readonly<Record<string, { label: string; percent?: boolean; places?: number }>> = {
  amount: { label: "The amount" },
  fxRate: { label: "The exchange rate", places: 10 },
  quantity: { label: "The quantity" },
  unitAmount: { label: "The rate" },
  discountPercent: { label: "The discount", percent: true },
  taxPercent: { label: "The tax rate", percent: true },
};

export class InvalidInvoiceAmount extends InvoiceError {
  constructor(
    /** The API field, kept for logs and for the label. */
    readonly field: string,
    given: string,
  ) {
    const known = INVOICE_AMOUNT_LABELS[field];
    super(
      "INVALID_INVOICE_AMOUNT",
      amountProblem(known?.label ?? `The ${field}`, given, {
        ...(known?.percent === true ? { percent: true } : {}),
        ...(known?.places === undefined ? {} : { places: known.places }),
      }),
    );
  }
}

export class InvalidSeriesPrefix extends InvoiceError {
  constructor(given: string) {
    super(
      "INVALID_SERIES_PREFIX",
      `${JSON.stringify(given)} is not a series prefix. Up to twelve characters, upper-case ` +
        `letters, digits, "-" and "/", starting with a letter or digit: it prints on a legal ` +
        `document.`,
    );
  }
}

export class InvalidInvoiceDate extends InvoiceError {
  constructor(field: string, given: string) {
    super("INVALID_INVOICE_DATE", `${field} must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(given)}.`);
  }
}

/**
 * The IRN is the government registry's identifier for this document, not ours.
 * A registration that has happened cannot un-happen, so it is set once.
 */
export class IrnAlreadyRegistered extends InvoiceError {
  constructor(id: string, irn: string) {
    super(
      "IRN_ALREADY_REGISTERED",
      `Invoice ${JSON.stringify(id)} is already registered as IRN ${JSON.stringify(irn)}. ` +
        `That is the registry's identifier for this document and cannot be replaced.`,
    );
  }
}

// ── Money against an invoice (T3.5) ────────────────────────────────────────

export class InvalidPaymentMethod extends InvoiceError {
  constructor(given: string, valid: readonly string[]) {
    super(
      "INVALID_PAYMENT_METHOD",
      `${JSON.stringify(given)} is not a payment method. Valid: ${valid.join(", ")}. It is a ` +
        `closed set because reconciling against a bank feed groups by it, and free text does ` +
        `not group.`,
    );
  }
}

export class InvalidCreditReason extends InvoiceError {
  constructor(given: string, valid: readonly string[]) {
    super(
      "INVALID_CREDIT_REASON",
      `${JSON.stringify(given)} is not a credit reason. Valid: ${valid.join(", ")}. A reason is ` +
        `mandatory and closed: without it the numbers always reconcile and WHY money came off ` +
        `an invoice does not, which is how revenue leakage becomes invisible.`,
    );
  }
}

/**
 * Money can only be applied to a document that has actually been sent.
 *
 * Against a DRAFT there is nothing to settle — nobody has been asked for
 * anything. Against a CANCELLED invoice it is a refund or a reallocation, and
 * recording it here would quietly reduce the balance on a withdrawn document.
 * The database refuses this again in a trigger.
 */
export class InvoiceNotIssued extends InvoiceError {
  constructor(id: string, status: string) {
    super(
      "INVOICE_NOT_ISSUED",
      `Invoice ${JSON.stringify(id)} is ${status}, so money cannot be applied to it. A draft ` +
        `has asked the client for nothing; a cancelled invoice is a refund or a reallocation, ` +
        `not a settlement.`,
    );
  }
}

/**
 * A firm cannot credit more than it billed.
 *
 * Not a database CHECK, and the reason is worth stating: the limit depends on
 * the SUM of every other credit note against the invoice, which a row-level
 * constraint cannot see. It is enforced here and asserted in an integration
 * test; making it structural would need an exclusion constraint or a trigger
 * summing siblings, and that is a heavier mechanism than the risk earns while
 * issuing a credit note is a deliberate, permissioned act.
 */
export class CreditExceedsInvoice extends InvoiceError {
  constructor(id: string, requested: string, remaining: string) {
    super(
      "CREDIT_EXCEEDS_INVOICE",
      `A credit of ${requested} is more than is left on invoice ${JSON.stringify(id)}: only ` +
        `${remaining} of it has not been credited already. Credit at most that, or check whether ` +
        `this belongs against a different invoice.`,
    );
  }
}

/**
 * A REVERSAL TAKES BACK NO MORE THAN WAS RECEIVED (audit 2026-10-03). A
 * payment above what is owed stays allowed on purpose: a client rounds up or
 * settles two invoices with one transfer, and the firm records what arrived;
 * the screens call the difference a credit. A reversal beyond what was paid
 * records money that never came in.
 */
export class ReversalExceedsPaid extends InvoiceError {
  constructor(number: string | null, requested: string, paid: string, currency: string) {
    super(
      "REVERSAL_EXCEEDS_PAID",
      `${number ?? "This invoice"} has ${moneyInWords(paid, currency)} received on it, so a reversal of ` +
        `${moneyInWords(requested, currency)} would take back more than was paid. Reverse at most that.`,
    );
  }
}

// ── The dunning ladder (T3.5) ──────────────────────────────────────────────

export class DunningActionNotFound extends InvoiceError {
  constructor(id: string) {
    super("DUNNING_ACTION_NOT_FOUND", `No dunning action ${JSON.stringify(id)} at this firm.`);
  }
}

/**
 * Only the two terminal rungs are ever gated, and only a person decides them.
 *
 * A reminder that sat waiting for a partner would be a ladder that never
 * climbs; and a `system` or `agent` actor reaching the decision would mean the
 * gate had been routed around, which is the one thing the rung exists to
 * prevent.
 */
export class DunningNotAwaitingApproval extends InvoiceError {
  constructor(id: string, action: string) {
    super(
      "DUNNING_NOT_AWAITING_APPROVAL",
      `Dunning action ${JSON.stringify(id)} is a ${JSON.stringify(action)} and is not waiting ` +
        `for anybody. Only credit hold and legal action need a partner, and only a person may ` +
        `decide one.`,
    );
  }
}

/**
 * A decision about a client is final.
 *
 * Reversing "we put them on credit hold" by editing the row would leave no
 * trace that it ever happened, and the ladder's whole value is that it records
 * what the firm did. The next move is the next step, not a rewrite of the last.
 */
export class DunningAlreadyDecided extends InvoiceError {
  constructor(id: string, state: string) {
    super(
      "DUNNING_ALREADY_DECIDED",
      `Dunning action ${JSON.stringify(id)} was already ${state}, and a decision about a client ` +
        `is not editable. Take the next step instead.`,
    );
  }
}

/**
 * The manager a person named is not on this firm's staff today (auto-invoice
 * T4). The column's foreign key reaches `tenancy.user_account`, which every
 * firm shares, so without this an id from another firm, or a client's portal
 * login, could be credited with this firm's revenue.
 */
export class ManagerNotStaff extends InvoiceError {
  constructor(userId: string) {
    super(
      "MANAGER_NOT_STAFF",
      `User ${JSON.stringify(userId)} is not active staff at this firm, so an invoice cannot be ` +
        `put in their revenue. Choose somebody from the firm's people, or leave the manager blank.`,
    );
  }
}

/** Whose revenue an invoice is was fixed when it was issued (0318's trigger
 *  says the same). A draft can still change hands. */
export class InvoiceManagerFrozen extends InvoiceError {
  constructor(id: string, status: string) {
    super(
      "INVOICE_MANAGER_FROZEN",
      `Invoice ${JSON.stringify(id)} is ${status}, so whose revenue it is was fixed when it was ` +
        `issued. Only a draft's manager can change.`,
    );
  }
}

/** "10 July 2026": a day as a person reads it, for a refusal. ISO in, words
 *  out, no `Date` (a day is a calendar fact, not an instant). */
export function dayInWords(iso: string): string {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August",
    "September", "October", "November", "December"];
  const [y, m, d] = iso.split("-");
  const month = months[Number(m) - 1];
  return month === undefined || d === undefined || y === undefined ? iso : `${String(Number(d))} ${month} ${y}`;
}

/**
 * A credit note is dated inside the life of the invoice it credits (audit
 * 2026-10-03, B45): not before the invoice was issued, and not after today.
 * Its date also decides its series' year, so a free date could put it in any
 * year's series.
 */
export class CreditNoteDateOutOfRange extends InvoiceError {
  constructor(given: string, invoiceIssuedOn: string | null, today: string) {
    super(
      "CREDIT_NOTE_DATE_OUT_OF_RANGE",
      given > today
        ? `A credit note cannot be dated ${dayInWords(given)}, which is after today (${dayInWords(today)}). ` +
            `Date it today or earlier.`
        : `A credit note cannot be dated ${dayInWords(given)}, which is before the invoice it credits was ` +
            `issued${invoiceIssuedOn === null ? "" : ` (${dayInWords(invoiceIssuedOn)})`}. Date it on or after that day.`,
    );
  }
}

/** "INR 4,000.00": an amount as a person reads it, for a refusal. On the
 *  STRING, never through a number; lakh grouping for INR, thousands otherwise. */
export function moneyInWords(amount: string, currency: string): string {
  const negative = amount.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? amount.slice(1) : amount).split(".");
  const cents = (fraction + "00").slice(0, 2);
  const digits = whole.replace(/^0+(?=\d)/, "");
  let grouped: string;
  if (currency.toUpperCase() === "INR" && digits.length > 3) {
    const head = digits.slice(0, -3);
    grouped = `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${digits.slice(-3)}`;
  } else {
    grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  return `${currency.toUpperCase()} ${negative ? "-" : ""}${grouped}.${cents}`;
}

/**
 * An issued invoice with money received against it is not cancelled (audit
 * 2026-10-03, B05). The receivables and every list drop a cancelled invoice,
 * so the payment would be attached to nothing, and the bill behind it would
 * re-open to be raised again. The database refuses it too.
 */
export class InvoiceHasPayments extends InvoiceError {
  constructor(number: string | null, paid: string, currency: string) {
    super(
      "INVOICE_HAS_PAYMENTS",
      `${number ?? "This invoice"} has ${moneyInWords(paid, currency)} of payments recorded against it, so it ` +
        `cannot be cancelled: that money would be attached to nothing. To take money off what the client ` +
        `owes, issue a credit note. If a payment was recorded by mistake, record a refund of the same ` +
        `amount first, then cancel.`,
    );
  }
}

/**
 * An advance raised before the letter (0363) with part of it mapped to work:
 * cancelling its invoice would take that money from under the bills that use
 * it. The mappings are ended first, which frees what bills have not taken.
 */
export class InvoiceAdvanceMapped extends InvoiceError {
  constructor(number: string | null, mapped: string, currency: string) {
    super(
      "INVOICE_ADVANCE_MAPPED",
      `${number ?? "This advance"} has ${moneyInWords(mapped, currency)} mapped to services, so it cannot be ` +
        `cancelled. On Invoices, Advances to be adjusted, end those mappings first; to give the money back, ` +
        `issue a credit note.`,
    );
  }
}

/**
 * A credit hold or legal action is approved only over money still owed (audit
 * 2026-10-03, B22). The queue showed a cancelled invoice's full total as owed,
 * and a partner could approve a hold over a withdrawn bill. Rejecting the step
 * is always possible: it records that the firm looked and chose not to.
 */
export class DunningNothingOwed extends InvoiceError {
  constructor(number: string | null, why: "cancelled" | "settled") {
    super(
      "DUNNING_NOTHING_OWED",
      `${number ?? "This invoice"} ${why === "cancelled" ? "was cancelled" : "is paid in full"}, so nothing is ` +
        `owed on it and this step cannot be approved. Reject it instead; the rejection is kept on record.`,
    );
  }
}

/**
 * A credit note on an ADVANCE invoice gives back only what later bills have
 * not already taken from it (audit 2026-10-03, B06). The plain route capped a
 * credit at invoiced less credited, so a client was credited the whole advance
 * after part of it had paid for October: the advance went to -10,000.
 */
export class CreditExceedsUnusedAdvance extends InvoiceError {
  constructor(number: string | null, takenByBills: string, maxCredit: string, currency: string) {
    super(
      "CREDIT_EXCEEDS_UNUSED_ADVANCE",
      `${number ?? "This invoice"} is an advance, and ${moneyInWords(takenByBills, currency)} of it (with its tax) ` +
        `has already been taken off later bills. At most ${moneyInWords(maxCredit, currency)} can be credited ` +
        `on it now. To give back more, credit the later invoices that took it.`,
    );
  }
}

/**
 * An invoice in another currency than the firm's reporting one needs the rate
 * a person typed (audit 2026-10-03, B07). It defaulted to 1, so USD 10,000
 * counted as INR 10,000 in what is owed, the dashboard and revenue.
 */
export class FxRateRequired extends InvoiceError {
  constructor(currency: string, reportingCurrency: string) {
    super(
      "FX_RATE_REQUIRED",
      `This invoice is in ${currency} and the firm reports in ${reportingCurrency}, so it needs the rate: how ` +
        `many ${reportingCurrency} one ${currency} was worth on the invoice date. Type the rate and the date it is from.`,
    );
  }
}

/** An invoice in the firm's own currency is converted at exactly 1 (B07). */
export class FxRateNotOne extends InvoiceError {
  constructor(currency: string, given: string) {
    super(
      "FX_RATE_NOT_ONE",
      `This invoice is in ${currency}, the firm's own currency, so its rate is 1, not ${given}. Leave the rate empty.`,
    );
  }
}

/** A due date set on a draft is today or later (audit 2026-10-03, B20/F35). */
export class DueDateInThePast extends InvoiceError {
  constructor(given: string, today: string) {
    super(
      "DUE_DATE_IN_THE_PAST",
      `${dayInWords(given)} has already passed (today is ${dayInWords(today)}). Choose today or a later day ` +
        `as the due date, or leave it empty.`,
    );
  }
}

/**
 * An invoice is not issued with a due date before its own date (B21). A draft
 * raised on 1 October due 8 October and issued on 20 October went out already
 * twelve days overdue, and the next sweep fired every reminder at once.
 */
export class DueBeforeIssue extends InvoiceError {
  constructor(dueOn: string, issuedOn: string) {
    super(
      "DUE_BEFORE_ISSUE",
      `This invoice is due on ${dayInWords(dueOn)}, which is before today's issue date, ${dayInWords(issuedOn)}. ` +
        `Change the due date on the draft, then issue it.`,
    );
  }
}

/**
 * A draft numbered before 0322 whose number would now issue out of order (B51;
 * the user decided 2026-10-03: never renumber). See `preDrawnNumberOrder` for
 * what "out of order" means. The way out is the one a person can take: cancel
 * the draft (its number stays in the series, marked cancelled, which is how an
 * auditor accounts for it) and raise it again; the new draft is numbered when
 * it is issued.
 */
export class InvoiceNumberOutOfOrder extends InvoiceError {
  constructor(
    readonly number: string,
    readonly order: NumberOutOfOrder,
    /** How the year of today's issue date is written, e.g. "2026-27". */
    issueYearLabel: string,
  ) {
    super(
      "INVOICE_NUMBER_OUT_OF_ORDER",
      (order.why === "later_number_issued"
        ? `${number} was numbered when the draft was made, and ${order.laterNumber} has already been ` +
          `issued, so issuing this one now would put the invoices out of order. `
        : `${number} was numbered in another financial year's series when the draft was made, and an ` +
          `invoice issued today belongs to ${issueYearLabel}. `) +
        `Cancel this draft and raise it again: the new draft is numbered when it is issued.`,
    );
  }
}

// ── The GST tax invoice (Q056, Q057, S5) ───────────────────────────────────

/** A SAC is chapter 99, six digits. */
export class InvalidSac extends InvoiceError {
  constructor(given: string) {
    super(
      "INVALID_SAC",
      `${JSON.stringify(given)} is not a SAC. A service's SAC is six digits starting 99, like 998222 for ` +
        `accounting and bookkeeping.`,
    );
  }
}

/** A place of supply is one of India's GST state codes. */
export class InvalidPlaceOfSupply extends InvoiceError {
  constructor(given: string) {
    super(
      "INVALID_PLACE_OF_SUPPLY",
      `${JSON.stringify(given)} is not a GST state code. Choose the state from the list (27 is Maharashtra).`,
    );
  }
}

/** A client's TDS: the section as the Act writes it, and a rate above 0. */
export class InvalidTds extends InvoiceError {
  constructor(problem: string) {
    super("INVALID_TDS", problem);
  }
}

/**
 * An Indian GST invoice whose place of supply cannot be read: the client has an
 * address on record, but no GSTIN and no state that names one.
 */
export class PlaceOfSupplyUnknown extends InvoiceError {
  constructor(clientName: string) {
    super(
      "PLACE_OF_SUPPLY_UNKNOWN",
      `A GST invoice names the place of supply, and ${clientName}'s address does not say which state it is ` +
        `in. Choose the state on this invoice, or add the state (or the client's GSTIN) to the client.`,
    );
  }
}

/** Rule 46(f): every line of a GST invoice carries its service's SAC. */
export class InvoiceLineNeedsSac extends InvoiceError {
  constructor(readonly descriptions: readonly string[]) {
    super(
      "INVOICE_LINE_NEEDS_SAC",
      `A GST invoice prints each service's SAC, and ${descriptions.length === 1 ? "this line has" : "these lines have"} ` +
        `none: ${descriptions.map((d) => `"${d}"`).join(", ")}. Add the SAC on the line, or to the service in ` +
        `the catalogue.`,
    );
  }
}

/** A company's bank account or LUT (0369) that cannot be stored, in words
 *  for the person who typed it. */
export class InvalidCompanyInvoicing extends InvoiceError {
  constructor(problem: string) {
    super("INVALID_COMPANY_INVOICING", problem);
  }
}

/** A bank account or LUT the request named that is not this company's live one. */
export class CompanyRecordNotFound extends InvoiceError {
  constructor(what: string, id: string) {
    super("COMPANY_RECORD_NOT_FOUND", `There is no ${what} ${id} on this company.`);
  }
}

/** A client the request named that this firm does not have. */
export class InvoiceClientNotFound extends InvoiceError {
  constructor(partyId: string) {
    super("CLIENT_NOT_FOUND", `There is no client ${partyId} at this firm.`);
  }
}
