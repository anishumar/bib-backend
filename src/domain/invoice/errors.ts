// Sentinel errors — the closed vocabulary of ways invoicing fails. Owned in the
// domain; `api/domainerr.ts` maps them to HTTP status codes. Match with
// `instanceof`, never by string.

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
  | "DUNNING_ACTION_NOT_FOUND"
  | "DUNNING_NOT_AWAITING_APPROVAL"
  | "DUNNING_ALREADY_DECIDED"
  | "NOT_CALLERS_TODAY"
  | "ISSUER_NOT_A_FIRM_ENTITY"
  | "BILLS_THE_FIRM"
  | "PARTY_ARCHIVED"
  | "ENGAGEMENT_NOT_FOUND"
  | "ENGAGEMENT_OF_ANOTHER_CLIENT"
  | "ENGAGEMENT_OF_ANOTHER_ISSUER";

/** `asOf` is the caller's TODAY, not a date to choose (see `isCallersToday`).
 *  A document that genuinely belongs to another day has its own field. */
export class NotCallersToday extends InvoiceError {
  constructor(given: string, firmDay: string) {
    super(
      "NOT_CALLERS_TODAY",
      `The day sent as asOf, ${JSON.stringify(given)}, cannot be today where you are: the firm's ` +
        `day is ${firmDay}, and anywhere in the world today is that day or the one either side. ` +
        `To put an invoice in another year's books use seriesDate; a credit note takes issuedOn.`,
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
        `change. Cancel it and issue a new one — both stay readable, which is the point.`,
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

export class InvalidInvoiceAmount extends InvoiceError {
  constructor(field: string, given: string) {
    super(
      "INVALID_INVOICE_AMOUNT",
      `${field} must be a decimal STRING, and ${JSON.stringify(given)} is not one. Amounts ` +
        `cross the wire as strings because a float cannot hold 1499.50 exactly and the error ` +
        `is invisible in one line and material in a total.`,
    );
  }
}

export class InvalidSeriesPrefix extends InvoiceError {
  constructor(given: string) {
    super(
      "INVALID_SERIES_PREFIX",
      `${JSON.stringify(given)} is not a series prefix. Up to twelve characters, upper-case ` +
        `letters, digits, "-" and "/", starting with a letter or digit — it prints on a legal ` +
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
      `Crediting ${requested} against invoice ${JSON.stringify(id)} would exceed it — only ` +
        `${remaining} of it is uncredited. Credit the remainder, or check whether this belongs ` +
        `against a different invoice.`,
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
