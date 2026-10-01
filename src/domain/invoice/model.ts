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
  /** `INV/2026-27/0001`. Frozen by a trigger the moment the row exists. */
  readonly number: string;
  readonly financialYear: number;
  readonly sequenceNumber: number;
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
 * 1 APRIL IS HARDCODED and that is a real limit: right for India, wrong for the
 * UK (6 April), the US (varies) and the UAE (calendar). It is not read from
 * `core.legal_entity.financial_year_end` because doing so makes a series' year
 * depend on a mutable column — change the entity's year end and every FUTURE
 * number changes its prefix while issued ones keep theirs. That is a decision
 * about a legal document series, and it needs a firm to take it.
 */
export function financialYearOf(isoDate: string): number {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(isoDate);
  if (match === null) {
    throw new RangeError(`expected an ISO date (YYYY-MM-DD), got ${JSON.stringify(isoDate)}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  return month >= 4 ? year : year - 1;
}

/** `2026-27` — how a financial year is written on the document itself. Both
 *  halves, because "FY 2026" is ambiguous in exactly the countries this product
 *  serves. */
export function financialYearLabel(startYear: number): string {
  return `${String(startYear)}-${String((startYear + 1) % 100).padStart(2, "0")}`;
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
}): string {
  if (!Number.isInteger(input.sequence) || input.sequence < 1) {
    throw new RangeError(
      `an invoice sequence starts at 1, got ${String(input.sequence)}. A gapless series has no zeroth invoice.`,
    );
  }
  return [
    input.prefix,
    financialYearLabel(input.financialYear),
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
  | "bad_debt";

export const CREDIT_REASONS: readonly CreditReason[] = [
  "service_failure",
  "billing_error",
  "goodwill",
  "scope_change",
  "duplicate_invoice",
  "bad_debt",
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
