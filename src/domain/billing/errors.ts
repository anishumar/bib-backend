// Sentinel errors: the closed vocabulary of ways billing a due fails (0318).
// Owned in the domain; `api/domainerr.ts` maps them to HTTP status codes.
// Match with `instanceof`, never by string. Every sentence says what to do.

export class BillingError extends Error {
  constructor(
    readonly code: BillingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type BillingErrorCode =
  | "BILLING_DUE_NOT_FOUND"
  | "BILLING_DUE_NOT_OPEN"
  | "DUES_DO_NOT_SHARE_AN_INVOICE"
  | "DUES_OF_DIFFERENT_MANAGERS"
  | "DUE_NEEDS_AN_AMOUNT"
  | "INVALID_BILLING_INPUT"
  | "FX_RATE_NEEDED"
  | "BILLING_INVOICE_NOT_FOUND"
  | "INVOICE_DOES_NOT_FIT_DUE"
  | "BILLING_ENGAGEMENT_NOT_FOUND"
  | "NOT_BILLED_ON_A_SCHEDULE"
  | "FISCAL_YEAR_NEEDED"
  | "ADVANCE_NOT_SKIPPABLE"
  | "START_NOT_APPROVABLE"
  | "BILL_NOW_REFUSED"
  | "AUTO_BILLING_OFF"
  | "NOTHING_TO_REFUND";

/** An advance bill is how the work it holds gets started (0320): skipping it
 *  would leave that work waiting for good. */
export class AdvanceNotSkippable extends BillingError {
  constructor() {
    super(
      "ADVANCE_NOT_SKIPPABLE",
      "An advance bill cannot be skipped: the work it holds starts only when it is paid. " +
        "Raise it (or link the invoice already raised); once part of it is paid, an admin can approve the start.",
    );
  }
}

/** Approve start is for an advance invoice that is issued and part paid (or
 *  paid, if the start did not happen by itself), and not started yet. */
export class StartNotApprovable extends BillingError {
  constructor(state: string) {
    const why: Record<string, string> = {
      not_raised: "its invoice has not been raised yet",
      on_draft: "its invoice is still a draft: issue it first",
      unpaid: "nothing has been paid on its invoice yet",
      started: "the work has already started",
    };
    super(
      "START_NOT_APPROVABLE",
      `This advance cannot be approved to start: ${why[state] ?? state}. ` +
        "Approve start is for an advance invoice with part of it paid.",
    );
  }
}

/** "Bill it now" (0320): only a one-time service with no process. */
export class BillNowRefused extends BillingError {
  constructor(reason: string) {
    super("BILL_NOW_REFUSED", reason);
  }
}

/** Final bills and refunds are automatic billing: the firm's switch must be on. */
export class AutoBillingOff extends BillingError {
  constructor() {
    super(
      "AUTO_BILLING_OFF",
      "Automatic billing is off for this firm, so final bills are raised by hand. " +
        "Turn it on in Your firm, Automatic billing, to bill a one-time service from here.",
    );
  }
}

/** The advance has nothing left to give back, or what it covered is not
 *  finished yet. */
export class NothingToRefund extends BillingError {
  constructor(why: string) {
    super("NOTHING_TO_REFUND", `There is nothing to refund on this advance: ${why}`);
  }
}

export class BillingDueNotFound extends BillingError {
  constructor(id: string) {
    super("BILLING_DUE_NOT_FOUND", `No bill due ${id} at this firm.`);
  }
}

/** Already raised, linked or skipped: two people on one list is the likely
 *  cause, and the answer is to reload it. */
export class BillingDueNotOpen extends BillingError {
  constructor(what: string, status: string) {
    super(
      "BILLING_DUE_NOT_OPEN",
      `${what} is already ${status === "skipped" ? "skipped" : "on an invoice"}. Reload the list to see what changed.`,
    );
  }
}

/** One invoice bills one client, from one of the firm's companies, in one
 *  currency (0027, F-10-1). */
export class DuesDoNotShareAnInvoice extends BillingError {
  constructor(what: "client" | "company" | "currency") {
    super(
      "DUES_DO_NOT_SHARE_AN_INVOICE",
      what === "client"
        ? "These bills are for different clients. Raise one invoice per client."
        : what === "company"
          ? "These bills are charged by different companies of the firm. Raise one invoice per company."
          : "These bills are in different currencies. Raise one invoice per currency.",
    );
  }
}

/** Revenue is counted per manager, so one invoice belongs to one. */
export class DuesOfDifferentManagers extends BillingError {
  constructor() {
    super(
      "DUES_OF_DIFFERENT_MANAGERS",
      "These bills belong to different managers, and an invoice counts in one manager's revenue. Raise one invoice per manager.",
    );
  }
}

/** The letter names no price for this one ("as mutually agreed"). */
export class DueNeedsAnAmount extends BillingError {
  constructor(what: string) {
    super("DUE_NEEDS_AN_AMOUNT", `${what} has no fixed fee in the engagement letter. Enter the amount to bill.`);
  }
}

export class InvalidBillingInput extends BillingError {
  constructor(message: string) {
    super("INVALID_BILLING_INPUT", message);
  }
}

/** The bills come from letters struck at different rates, and nothing says
 *  which one this invoice uses. */
export class FxRateNeeded extends BillingError {
  constructor() {
    super(
      "FX_RATE_NEEDED",
      "These bills come from letters with different exchange rates. Enter the rate and its date for this invoice.",
    );
  }
}

export class BillingInvoiceNotFound extends BillingError {
  constructor(id: string) {
    super("BILLING_INVOICE_NOT_FOUND", `No invoice ${id} at this firm.`);
  }
}

/** Linking a due to an invoice that could not have billed it. */
export class InvoiceDoesNotFitDue extends BillingError {
  constructor(reason: string) {
    super("INVOICE_DOES_NOT_FIT_DUE", `That invoice cannot be this bill: ${reason}`);
  }
}

export class BillingEngagementNotFound extends BillingError {
  constructor(id: string) {
    super("BILLING_ENGAGEMENT_NOT_FOUND", `No engagement ${id} at this firm.`);
  }
}

/** One-time and custom work is not billed on a schedule. */
export class NotBilledOnASchedule extends BillingError {
  constructor(frequency: string) {
    super(
      "NOT_BILLED_ON_A_SCHEDULE",
      `This service is billed ${frequency === "one_time" ? "once" : `"${frequency}"`}, not monthly, quarterly or yearly, so it has no billing schedule. Raise its invoice by hand.`,
    );
  }
}

/** A quarter or a year is cut on the firm's financial year (T6.13). */
export class FiscalYearNeeded extends BillingError {
  constructor() {
    super(
      "FISCAL_YEAR_NEEDED",
      "Quarterly and yearly billing follow the firm's financial year, and the firm has not said when its year starts. Set it in the compliance settings first.",
    );
  }
}
