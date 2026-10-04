// What an invoice IS — nouns and pure rules. Stdlib only: nothing here reads a
// counter, a table or a clock.
//
// The one idea this file exists to hold: AN INVOICE NUMBER IS NOT A DOCUMENT
// REFERENCE. `domain/document/model.ts` formats `PR-2026-0007` and a gap in
// that series is honest — somebody abandoned a quote. A tax invoice series must
// be CONSECUTIVE, because an auditor who finds one missing is entitled to read
// it as a suppressed sale. The two therefore share no code, deliberately, and
// the difference is stated in both places rather than in neither.

/**
 * Where an invoice is in its short life.
 *
 * There is no `paid`. What has been paid is the sum of the payments against it
 * (T3.5), and a status column saying "paid" beside a balance that says
 * otherwise is the classic way those two disagree. Status is about the
 * DOCUMENT — has it gone out, has it been withdrawn — and money is arithmetic.
 */
export type InvoiceStatus = "draft" | "issued" | "cancelled";

export const INVOICE_STATUSES: readonly InvoiceStatus[] = ["draft", "issued", "cancelled"];

export function isInvoiceStatus(v: string): v is InvoiceStatus {
  return (INVOICE_STATUSES as readonly string[]).includes(v);
}

/**
 * The only moves there are.
 *
 * An issued invoice is never edited back to a draft: it has been sent to a
 * client as a demand for a specific sum, and in India a copy is registered with
 * the government. Getting it wrong is answered by CANCELLING it and issuing a
 * new one — which leaves both documents readable, which is the point.
 */
const TRANSITIONS: Readonly<Record<InvoiceStatus, readonly InvoiceStatus[]>> = {
  draft: ["issued", "cancelled"],
  issued: ["cancelled"],
  cancelled: [],
};

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface Invoice {
  readonly id: string;
  readonly tenantId: string;
  /** WHO IS BILLED — the client. Not the entity the work was delivered to. */
  readonly partyId: string;
  /** WHO IS CHARGING — one of the firm's own entities, and the owner of the
   *  series this number came from. */
  readonly entityPartyId: string;
  /** `INV/2026-27/0001`. Drawn from the series when the invoice is ISSUED
   *  (0322) and frozen by a trigger from then; null on a draft (and on a draft
   *  cancelled before issue). Drafts made before 0322 keep the number they drew. */
  readonly number: string | null;
  /** Which year's series the number is (or will be) drawn from: chosen at the
   *  draft ("which year's books"), and it does not move. */
  readonly financialYear: number;
  readonly sequenceNumber: number | null;
  readonly status: InvoiceStatus;
  readonly currency: string;
  readonly fxRate: string;
  readonly fxRateDate: string;
  readonly issuedOn: string | null;
  readonly dueOn: string | null;
  /** India's e-invoice reference, returned by the registry. Null until the
   *  invoice is registered, and unchangeable afterwards. */
  readonly irn: string | null;
  readonly irnRegisteredAt: string | null;
  readonly notes: string | null;
  /** Whose revenue this is (0318): set when raised from bill dues, frozen
   *  once issued. Null when nobody was named. */
  readonly managerUserId: string | null;
}

export interface InvoiceLine {
  readonly id: string;
  readonly tenantId: string;
  readonly invoiceId: string;
  /** What the work was, when it came from one. Null for the things a firm bills
   *  that never had an engagement — a one-off certificate, a recharge. */
  readonly engagementId: string | null;
  readonly description: string;
  readonly position: number;
  readonly quantity: string;
  /** NOT nullable, unlike a proposal line. A quote may say "as mutually
   *  agreed"; an invoice is a demand for a specific sum. */
  readonly unitAmount: string;
  readonly currency: string;
  readonly discountPercent: string;
  /** Per LINE, because it is per service: 18% on professional fees and 0% on an
   *  out-of-pocket recharge, on the same invoice. */
  readonly taxPercent: string;
}

/** Every figure computed by Postgres in `numeric`, never summed in TypeScript.
 *  `total` is what the client owes: net of discount, plus tax. */
export interface InvoiceTotals {
  readonly lineCount: number;
  readonly gross: string;
  readonly discount: string;
  readonly net: string;
  readonly tax: string;
  readonly total: string;
  readonly currency: string;
}

/**
 * The financial year a date falls in — the year it STARTS in.
 *
 * `2026-03-31` → 2025 · `2026-04-01` → 2026.
 *
 * DUPLICATED from `crm.financial_year_of(date)` in migration 0027 on purpose,
 * and `tests/invoice/model.test.ts` holds the build red until the two agree
 * against real Postgres. The SQL copy exists because a CHECK constraint cannot
 * call TypeScript; this copy exists because the application composes the number
 * before it writes the row. One of them alone would mean either a constraint
 * that cannot be enforced or a round trip to format a string.
 *
 * ISO STRINGS, NO `Date`. A financial year is a calendar fact in a
 * jurisdiction, not an instant — the same rule `domain/scheduler/model.ts`
 * states — and a UTC `Date` moves 1 April by a day for anyone east or west of
 * Greenwich, which is exactly the boundary this function exists to find.
 *
 * 1 APRIL IS THE DEFAULT, NOT THE ONLY ANSWER (audit 2026-10-03, B03). An
 * invoice's year is decided when it is ISSUED, from its issue date, in the
 * firm's own financial year when the firm has said when that starts (its
 * compliance policy's `fiscalYearStartMonth`), else 1 April as before. It is
 * read at issue, so changing the setting moves only numbers not yet drawn,
 * never an issued one. The SQL copy keeps 1 April: nothing constrains on it.
 */
export function financialYearOf(isoDate: string, startMonth: number = INDIAN_FY_START_MONTH): number {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(isoDate);
  if (match === null) {
    throw new RangeError(`expected an ISO date (YYYY-MM-DD), got ${JSON.stringify(isoDate)}`);
  }
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
    throw new RangeError(`a financial year starts in a month from 1 to 12, got ${String(startMonth)}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  return month >= startMonth ? year : year - 1;
}

/** 1 April: India's financial year, and the year every series used before a
 *  firm could say otherwise. */
export const INDIAN_FY_START_MONTH = 4;

/** `2026-27` — how a financial year is written on the document itself. Both
 *  halves, because "FY 2026" is ambiguous in exactly the countries this product
 *  serves. A year that starts in January is one calendar year and is written
 *  as one: `2026`. */
export function financialYearLabel(startYear: number, startMonth: number = INDIAN_FY_START_MONTH): string {
  if (startMonth === 1) return String(startYear);
  return `${String(startYear)}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/**
 * The series year a number is drawn in (0337, final review): the year of its
 * date on the company's calendar, but never one OLDER than the newest series
 * the company has already drawn a number in.
 *
 * Moving a company's year start later (January to April, April to July)
 * would otherwise put the weeks after the change back into the series that
 * closed before it: `INV/2026/0101` dated February 2027 after
 * `INV/2027/0005`. Numbers are frozen and gapless, so that cannot be undone.
 * Instead the series in progress carries on, a transition period, until the
 * company's own year reaches a newer one.
 */
export function seriesYearFor(dateYear: number, newestNumbered: number | null): number {
  return newestNumbered !== null && newestNumbered > dateYear ? newestNumbered : dateYear;
}

/**
 * The year label a number was drawn under (0337): `INV/2026-27/0001` ->
 * `2026-27`, `INV/2027/0001` -> `2027`. Read OFF the number because the number
 * is frozen and was formatted from its series' own start month; working the
 * label out again from today's setting is how a screen came to print `2026-27`
 * for a company on a calendar year. Counted from the end, since a prefix may
 * hold a slash. Null for a draft (no number) or a shape it does not know.
 */
export function financialYearLabelOfNumber(number: string | null): string | null {
  if (number === null) return null;
  const parts = number.split("/");
  const label = parts.length >= 3 ? parts[parts.length - 2] : undefined;
  return label !== undefined && /^\d{4}(-\d{2})?$/.test(label) ? label : null;
}

/**
 * `INV/2026-27/0001`.
 *
 * Slashes rather than the hyphens `PR-2026-0007` uses, and that is not
 * decoration: it is the shape Indian tax invoice numbers are written in, it is
 * what the firm's own existing series looks like, and the visible difference
 * between the two formats is a reminder that one may gap and the other may not.
 *
 * Padded to four digits so a year's invoices sort and read as a column, and NOT
 * truncated past that — the ten-thousandth invoice of a year gets five digits
 * rather than a collision.
 */
export function formatInvoiceNumber(input: {
  readonly prefix: string;
  readonly financialYear: number;
  readonly sequence: number;
  /** The month the year starts in; 1 April when absent. */
  readonly startMonth?: number | undefined;
}): string {
  if (!Number.isInteger(input.sequence) || input.sequence < 1) {
    throw new RangeError(
      `an invoice sequence starts at 1, got ${String(input.sequence)}. A gapless series has no zeroth invoice.`,
    );
  }
  return [
    input.prefix,
    financialYearLabel(input.financialYear, input.startMonth),
    String(input.sequence).padStart(4, "0"),
  ].join("/");
}

/** The shape a firm may give its own series. Upper case and short, because it
 *  prints on a document and is compared. */
const PREFIX_PATTERN = /^[A-Z0-9][A-Z0-9/-]{0,11}$/;

export function isSeriesPrefix(v: string): boolean {
  return PREFIX_PATTERN.test(v);
}

export const DEFAULT_SERIES_PREFIX = "INV";

// ── A number drawn before 0322 (audit 2026-10-03, B51) ─────────────────────

/**
 * Whether a draft that ALREADY HOLDS A NUMBER may still be issued with it.
 *
 * Before 0322 the number was drawn when the draft was made, and those drafts
 * keep it: NEVER RENUMBERED (the user, 2026-10-03), because taking a drawn
 * number away leaves the gap the series exists to prevent. But issuing one
 * late can put the series out of order, and that is refused instead.
 *
 * A SERIES is one company's invoices for one financial year, counted 1, 2, 3
 * in the order they are issued (`crm.invoice_series`, keyed on the entity and
 * the year). A drawn number is OUT OF ORDER when either:
 *
 *  1. A LATER NUMBER OF ITS SERIES HAS ALREADY BEEN ISSUED: an invoice of the
 *     same company and year with a higher sequence number carries an issue
 *     date. Issued and cancelled since counts (it went out with that number);
 *     a later draft cancelled before it was issued does not (it never went out).
 *     Issuing 7 after 9 would date 7 later than 9.
 *  2. ITS SERIES IS NOT THE YEAR OF THE ISSUE DATE: an invoice dated in one
 *     financial year with a number from another year's series. B03 (0326) made
 *     the issue date decide the year; a drawn number cannot follow it.
 *
 * Otherwise it is IN ORDER and issues as it is. The adapter asks this under the
 * series' row lock, so a later number cannot be issued between the check and
 * the write.
 */
export type PreDrawnNumberOrder =
  | { readonly inOrder: true }
  | { readonly inOrder: false; readonly why: "later_number_issued"; readonly laterNumber: string }
  | { readonly inOrder: false; readonly why: "another_year"; readonly issueFinancialYear: number };

export type NumberOutOfOrder = Exclude<PreDrawnNumberOrder, { readonly inOrder: true }>;

export function preDrawnNumberOrder(input: {
  /** The draft's series year and its place in that series. */
  readonly draft: { readonly financialYear: number; readonly sequenceNumber: number };
  /** The financial year of the day it would be issued on. */
  readonly issueFinancialYear: number;
  /** The highest-numbered invoice of the draft's series that carries an issue
   *  date, other than the draft itself. Null when none has. */
  readonly latestIssued: { readonly number: string; readonly sequenceNumber: number } | null;
}): PreDrawnNumberOrder {
  if (input.latestIssued !== null && input.latestIssued.sequenceNumber > input.draft.sequenceNumber) {
    return { inOrder: false, why: "later_number_issued", laterNumber: input.latestIssued.number };
  }
  if (input.issueFinancialYear !== input.draft.financialYear) {
    return { inOrder: false, why: "another_year", issueFinancialYear: input.issueFinancialYear };
  }
  return { inOrder: true };
}

// ── Money against an invoice (T3.5) ────────────────────────────────────────

/**
 * How a payment arrived. A CLOSED SET, because a firm reconciling against a
 * bank feed (T7.4) groups by it, and free text does not group.
 */
export type PaymentMethod = "bank_transfer" | "cheque" | "cash" | "card" | "upi" | "other";

export const PAYMENT_METHODS: readonly PaymentMethod[] = [
  "bank_transfer",
  "cheque",
  "cash",
  "card",
  "upi",
  "other",
];

export function isPaymentMethod(v: string): v is PaymentMethod {
  return (PAYMENT_METHODS as readonly string[]).includes(v);
}

/**
 * A payment, and it is SIGNED.
 *
 * A bounced cheque or a reversed transfer is a NEGATIVE payment with its own
 * date and its own reason — two rows that tell the story — rather than the
 * original row edited into something that never happened. `bib_app` holds no
 * DELETE grant, so this is the only way to express it, which is the intended
 * pressure rather than a limitation worked around.
 */
export interface Payment {
  readonly id: string;
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly amount: string;
  readonly currency: string;
  readonly receivedOn: string;
  readonly method: PaymentMethod;
  /** The counterparty's own reference — a UTR, a cheque number. Free text on
   *  purpose: normalising somebody else's identifier is how it stops matching
   *  theirs. */
  readonly reference: string | null;
  readonly note: string | null;
}

/**
 * WHY money came off an invoice. Mandatory and closed, and that is the whole
 * value of the field.
 *
 * The demo's hardest-won finding about revenue: without it, "revenue leakage
 * becomes invisible — the numbers always reconcile; WHY forty thousand came off
 * does not." Free text would satisfy NOT NULL and would not GROUP BY, which is
 * the only thing anybody ever wants to do with it. "How much did we write off
 * to service failures last year" is the question this exists to answer.
 */
export type CreditReason =
  | "service_failure"
  | "billing_error"
  | "goodwill"
  | "scope_change"
  | "duplicate_invoice"
  | "bad_debt"
  /** An advance left over once the work it covered is finished, or a client
   *  who left early, given back (0320). */
  | "advance_refund";

export const CREDIT_REASONS: readonly CreditReason[] = [
  "service_failure",
  "billing_error",
  "goodwill",
  "scope_change",
  "duplicate_invoice",
  "bad_debt",
  "advance_refund",
];

export function isCreditReason(v: string): v is CreditReason {
  return (CREDIT_REASONS as readonly string[]).includes(v);
}

/** A credit note: its OWN document, with its own consecutive series. Not an
 *  invoice with a minus sign — under Indian GST it is a separate document type,
 *  and interleaving the two series is worse than a gap. */
export interface CreditNote {
  readonly id: string;
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly entityPartyId: string;
  readonly number: string;
  readonly financialYear: number;
  readonly sequenceNumber: number;
  readonly amount: string;
  readonly currency: string;
  readonly issuedOn: string;
  readonly reason: CreditReason;
  readonly note: string | null;
}

/**
 * What an invoice still owes: invoiced − paid − credited.
 *
 * DERIVED, never stored. A `paid` flag and an `amount_paid` column are both
 * caches of this addition and both drift the first time a payment is corrected,
 * leaving an invoice that says "paid" beside arithmetic that says otherwise —
 * and only one of them is evidence.
 */
export interface InvoiceBalance {
  readonly invoiceId: string;
  readonly partyId: string;
  readonly status: InvoiceStatus;
  readonly currency: string;
  readonly dueOn: string | null;
  readonly invoiced: string;
  readonly paid: string;
  readonly credited: string;
  readonly outstanding: string;
}

/** The `document_type` half of a series key. Two legal series that must not
 *  interleave — 0028's correction to 0027. */
export type SeriesDocumentType = "invoice" | "credit_note";

/** Credit notes read as `CN/...` by default, so the two series are
 *  distinguishable on sight as well as by their key. */
export const DEFAULT_CREDIT_NOTE_PREFIX = "CN";
