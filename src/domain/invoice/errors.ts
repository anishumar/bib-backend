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
  | "CREDIT_EXCEEDS_INVOICE";

export class InvoiceNotFound extends InvoiceError {
  constructor(id: string) {
    super("INVOICE_NOT_FOUND", `no invoice ${JSON.stringify(id)} at this firm.`);
  }
}

export class InvoiceLineNotFound extends InvoiceError {
  constructor(id: string) {
    super("INVOICE_LINE_NOT_FOUND", `no line ${JSON.stringify(id)} on this invoice.`);
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
      `invoice ${JSON.stringify(id)} is ${status}, so what it says the client owes cannot ` +
        `change. Cancel it and issue a new one — both stay readable, which is the point.`,
    );
  }
}

/** An invoice with no lines is a demand for nothing. */
export class EmptyInvoice extends InvoiceError {
  constructor(id: string) {
    super(
      "EMPTY_INVOICE",
      `invoice ${JSON.stringify(id)} has no lines, so it asks the client for nothing. Add a ` +
        `line before issuing it.`,
    );
  }
}

export class InvalidInvoiceTransition extends InvoiceError {
  constructor(from: string, to: string) {
    super(
      "INVALID_INVOICE_TRANSITION",
      `an invoice cannot go from ${from} to ${to}. An issued invoice is cancelled, never ` +
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
      `invoice ${JSON.stringify(id)} is already registered as IRN ${JSON.stringify(irn)}. ` +
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
      `invoice ${JSON.stringify(id)} is ${status}, so money cannot be applied to it. A draft ` +
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
      `crediting ${requested} against invoice ${JSON.stringify(id)} would exceed it — only ` +
        `${remaining} of it is uncredited. Credit the remainder, or check whether this belongs ` +
        `against a different invoice.`,
    );
  }
}
