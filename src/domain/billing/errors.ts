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
  | "BILL_EARLY_REFUSED"
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
  | "NOTHING_TO_REFUND"
  | "BILL_BUSY"
  | "ADVANCE_LINK_NEEDS_ADMIN"
  | "PRICE_NOT_VISIBLE"
  // The ad-hoc advance (0363).
  | "ADVANCE_NOT_FOUND"
  | "ALLOCATION_NOT_FOUND"
  | "ADVANCE_NOT_ISSUED"
  | "ADVANCE_OVER_MAPPED"
  | "ADVANCE_IN_ANOTHER_CURRENCY"
  | "ADVANCE_OF_ANOTHER_ISSUER"
  | "ADVANCE_OF_ANOTHER_CLIENT"
  | "ADVANCE_TARGET_NOT_LIVE"
  | "ADVANCE_JOB_NOT_OF_SERVICE"
  | "ALLOCATION_USED_UP"
  | "ALLOCATION_ENDED"
  | "ADVANCE_FEES_NOT_VISIBLE";

/** An advance bill is how the work it holds gets started (0320): skipping it
 *  while that work still waits would leave it waiting for good. Once nothing
 *  waits (the engagement ended before it started, 0321), it may be skipped. */
export class AdvanceNotSkippable extends BillingError {
  constructor() {
    super(
      "ADVANCE_NOT_SKIPPABLE",
      "This advance bill cannot be skipped while work still waits for it: that work starts only when it is paid. " +
        "Raise it; once part of it is paid, an admin can approve the start. End the engagement first if the client is not going ahead.",
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

/** "Raise invoice now" (Q071 b) refused: the period is billed already, its
 *  work is not done, or there is no such period to bill. */
export class BillEarlyRefused extends BillingError {
  constructor(reason: string) {
    super("BILL_EARLY_REFUSED", reason);
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

/** Somebody else is settling one of these bills, or using the same advance,
 *  right now (0321). Refused before an invoice number is drawn. */
export class BillBusy extends BillingError {
  constructor(what: string) {
    super(
      "BILL_BUSY",
      `Somebody else is working on ${what} right now. Wait a moment and try again; the list will show what they did.`,
    );
  }
}

/** Linking an advance bill to an invoice already raised starts the work it
 *  holds when that invoice is paid, so it is an admin's act, as Approve start
 *  is (0321). */
export class AdvanceLinkNeedsAdmin extends BillingError {
  constructor() {
    super(
      "ADVANCE_LINK_NEEDS_ADMIN",
      "Only an admin can link an advance to an invoice already raised, because a paid invoice starts the work. " +
        "Raise the advance from the bill instead, or ask an admin.",
    );
  }
}

/** A login that does not see fees cannot bill a figure other than the
 *  letter's: it would be changing a price it is not allowed to read (0321). */
export class PriceNotVisible extends BillingError {
  constructor(what: string) {
    super(
      "PRICE_NOT_VISIBLE",
      `The letter fixes the price of ${what}, and this login does not see fees, so it cannot bill a different amount. ` +
        "Leave the amount empty to bill the letter's price, or ask somebody who sees fees.",
    );
  }
}

// ── The ad-hoc advance (0363, Q044-Q048) ───────────────────────────────────

export class AdvanceNotFound extends BillingError {
  constructor(id: string) {
    super("ADVANCE_NOT_FOUND", `No advance ${id} at this firm.`);
  }
}

export class AllocationNotFound extends BillingError {
  constructor(id: string) {
    super("ALLOCATION_NOT_FOUND", `No mapping ${id} on this advance.`);
  }
}

/** A draft has no number and asks the client for nothing yet: there is no
 *  money to point at work until it is issued. */
export class AdvanceNotIssued extends BillingError {
  constructor(status: string) {
    super(
      "ADVANCE_NOT_ISSUED",
      status === "cancelled"
        ? "This advance's invoice was cancelled, so there is nothing to map."
        : "This advance's invoice is still a draft. Issue it first; then map it to the services it pays for.",
    );
  }
}

export class AdvanceOverMapped extends BillingError {
  constructor(asked: string, unmapped: string, currency: string) {
    super(
      "ADVANCE_OVER_MAPPED",
      `That maps ${currency} ${asked}, and only ${currency} ${unmapped} of this advance is not mapped yet. ` +
        "Map less, or free part of an earlier mapping first.",
    );
  }
}

/** Never converted: an AED advance is not taken off an INR service's bills. */
export class AdvanceInAnotherCurrency extends BillingError {
  constructor(service: string, serviceCurrency: string, advanceCurrency: string) {
    super(
      "ADVANCE_IN_ANOTHER_CURRENCY",
      `${service} is billed in ${serviceCurrency} and this advance is in ${advanceCurrency}. ` +
        "An advance comes off bills in its own currency only. Map it to a service billed in " +
        `${advanceCurrency}, or give it back.`,
    );
  }
}

/** The advance is in its issuing company's tax books: another company's
 *  invoice cannot take it. */
export class AdvanceOfAnotherIssuer extends BillingError {
  constructor(service: string, serviceCompany: string, advanceCompany: string) {
    super(
      "ADVANCE_OF_ANOTHER_ISSUER",
      `${service} is under a letter of ${serviceCompany}, and this advance was invoiced by ${advanceCompany}. ` +
        "An advance comes off the bills of the company that invoiced it.",
    );
  }
}

export class AdvanceOfAnotherClient extends BillingError {
  constructor(service: string) {
    super("ADVANCE_OF_ANOTHER_CLIENT", `${service} is another client's work. An advance is mapped to its own client's services.`);
  }
}

export class AdvanceTargetNotLive extends BillingError {
  constructor(service: string, status: string) {
    super(
      "ADVANCE_TARGET_NOT_LIVE",
      `${service} is ${status.replace("_", " ")}, so no bill of it will take this advance. Map it to live work.`,
    );
  }
}

export class AdvanceJobNotOfService extends BillingError {
  constructor() {
    super("ADVANCE_JOB_NOT_OF_SERVICE", "That job is not one of this service's jobs.");
  }
}

/** Every rupee of it is on bills already: nothing is left to move. */
export class AllocationUsedUp extends BillingError {
  constructor() {
    super(
      "ALLOCATION_USED_UP",
      "Bills of this service have already taken all of this mapping, so there is nothing left to move. " +
        "Cancel the invoice that took it first if it was wrong.",
    );
  }
}

export class AllocationEnded extends BillingError {
  constructor() {
    super("ALLOCATION_ENDED", "This mapping was already ended. Reload the list to see what changed.");
  }
}

/** An advance IS an amount: a login that does not see fees cannot raise or
 *  map one. */
export class AdvanceFeesNotVisible extends BillingError {
  constructor() {
    super(
      "ADVANCE_FEES_NOT_VISIBLE",
      "An advance is an amount of money, and your login is not set to see fees. Ask somebody who can see fees.",
    );
  }
}
