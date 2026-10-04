// The leadership figures (T3.7) — pure nouns and the one piece of arithmetic
// that is genuinely the domain's rather than the database's. Stdlib only.
//
// WHAT IS NOT HERE IS THE POINT: no MRR calculation, no ageing bucket rule. Both
// live in `crm.engagement_mrr` and `crm.receivable_ageing` (migration 0038),
// because both are aggregations over rows and the database is where aggregation
// belongs. Reimplementing either in TypeScript would give the product two
// answers to the same question, and the one a partner reads would depend on
// which code path they came through.
//
// DSO is the exception, and it is here for a reason stated below.

/** How overdue a receivable is. The buckets every ageing report in this industry
 *  uses, mirrored by the CASE in migration 0038 — the two must agree, and
 *  `tests/dashboard/model.test.ts` holds the build red if they drift. */
export type AgeingBucket = "current" | "d1_30" | "d31_60" | "d61_90" | "d90_plus" | "no_due_date";

export const AGEING_BUCKETS: readonly AgeingBucket[] = [
  "current",
  "d1_30",
  "d31_60",
  "d61_90",
  "d90_plus",
  "no_due_date",
];

/** Why a fee could not be counted as monthly recurring revenue. NULL-equivalent
 *  is "it counted"; every other value is shown to the firm beside its own
 *  headline number. Mirrors the CASE in migration 0038. */
export type MrrExclusion = "unpriced" | "no_frequency_stated" | "one_time" | "custom_frequency";

export const MRR_EXCLUSIONS: readonly MrrExclusion[] = [
  "unpriced",
  "no_frequency_stated",
  "one_time",
  "custom_frequency",
];

// AMOUNTS HERE ARE BARE DECIMAL STRINGS, and the currency is stated ONCE on the
// enclosing response rather than on every row.
//
// Two reasons, and the second is the load-bearing one. Every figure this module
// produces is already converted to the firm's single reporting currency, so
// repeating it per row is noise on a table where it can never differ. And a
// per-row currency field is a field an adapter has to fill before it knows the
// answer — which is how an empty string ends up standing in for one on the wire.
//
// String and never number, per `domain/money`: a float cannot hold 1499.50, and
// the error is invisible in one line and material in a total, which is exactly
// what this module produces.

/** One line of "and here is what the headline number could not count". */
export interface MrrGap {
  readonly reason: MrrExclusion;
  readonly engagementCount: number;
}

export interface MrrSummary {
  readonly monthly: string;
  /** Engagements whose fee IS counted in `monthly`. */
  readonly countedEngagements: number;
  /**
   * Everything the number could not include, by reason.
   *
   * Not optional and not hidden behind a flag. A firm reading MRR is entitled to
   * know that most of its engagements state no billing frequency — and the
   * first run of this against real data said exactly that, which is the whole
   * argument for the field.
   */
  readonly gaps: readonly MrrGap[];
}

/** One slice of a grouped figure — by client, by service, or by whoever owns it. */
export interface Slice {
  readonly key: string;
  /** The NAME, never the uuid. A read model carries names (CLAUDE.md). */
  readonly label: string;
  /** Decimal string, in the reporting currency named on the response. */
  readonly amount: string;
  readonly count: number;
}

export interface AgeingBand {
  readonly bucket: AgeingBucket;
  /** Decimal string, in the reporting currency named on the response. */
  readonly amount: string;
  readonly invoiceCount: number;
}

/**
 * Days Sales Outstanding, and the reason this one calculation is not SQL.
 *
 * DSO = (receivables ÷ credited sales over a period) × days in that period. The
 * two inputs are aggregates the database produces; the division is a DEFINITION,
 * and it is the definition that needs to be readable and tested rather than
 * buried in a view somebody would have to reverse-engineer.
 *
 * **It returns null rather than zero when there were no sales**, and that is the
 * whole care in this function. Dividing by zero sales gives either a crash or
 * Infinity, and "0 days" is the answer a firm would read as *excellent* when the
 * truth is *we billed nothing, ask a different question*. A null a screen must
 * render as "not enough billing to say" cannot be misread.
 *
 * Amounts arrive as decimal strings and are converted here — the one place a
 * float is acceptable, because the OUTPUT is a count of days rounded to one
 * decimal, not money. Nothing downstream adds it to anything.
 */
export function daysSalesOutstanding(input: {
  readonly receivables: string;
  readonly creditSales: string;
  readonly periodDays: number;
}): number | null {
  const sales = Number(input.creditSales);
  if (!Number.isFinite(sales) || sales <= 0) return null;
  if (input.periodDays <= 0) return null;
  const receivables = Number(input.receivables);
  if (!Number.isFinite(receivables)) return null;
  return Math.round((receivables / sales) * input.periodDays * 10) / 10;
}

export function isAgeingBucket(value: string): value is AgeingBucket {
  return (AGEING_BUCKETS as readonly string[]).includes(value);
}

export function isMrrExclusion(value: string): value is MrrExclusion {
  return (MRR_EXCLUSIONS as readonly string[]).includes(value);
}

// ── Billing by company (Wave 5) ─────────────────────────────────────────────

/** How many months the billing chart may ask for, and how many it gets. */
export const BILLING_MONTHS_DEFAULT = 12;
export const BILLING_MONTHS_MAX = 24;

/**
 * The last `count` calendar months up to and including the one `today` falls
 * in, oldest first, as `YYYY-MM`, with the window as two DAYS: `from` its
 * first day, `until` the first day AFTER it (exclusive), so a query needs no
 * idea of how long a month is.
 *
 * `today` is the FIRM's day (T6.14's cut: `dayInZone(now, the firm's zone)`),
 * never the server's: at 01:00 IST on 1 October the server's UTC day is still
 * 30 September, and a firm looking at its October billing would be shown a
 * window that ends in September. String arithmetic on the day, no `Date`.
 */
export function billingWindow(
  today: string,
  count: number,
): { readonly months: readonly string[]; readonly from: string; readonly until: string } {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(today);
  if (!m) throw new RangeError(`not a calendar day: ${JSON.stringify(today)}`);
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`a billing window is at least one whole month, not ${String(count)}`);
  }
  // Months counted from year 0, so stepping back never has to think about
  // January.
  const current = Number(m[1]) * 12 + (Number(m[2]) - 1);
  const label = (index: number): string =>
    `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
  const months: string[] = [];
  for (let i = current - count + 1; i <= current; i += 1) months.push(label(i));
  return { months, from: `${label(current - count + 1)}-01`, until: `${label(current + 1)}-01` };
}

/**
 * One company's billing in one month.
 *
 * BILLED is the definition the chart is drawn from, and the API states it:
 * ISSUED invoices only (a draft was never sent, a cancelled one was
 * withdrawn), by the month they were issued, BEFORE TAX (net of discount),
 * less the credit notes issued that month, each at its pre-tax share of the
 * invoice it credits. A credit note reverses tax in the same proportion as
 * the value, so taking its whole amount off a pre-tax figure would take the
 * tax off twice.
 */
export interface MonthBilling {
  readonly month: string;
  /** In the company's own currency. A decimal string, never a number. */
  readonly billed: string;
  /** In the firm's reporting currency, each document at its OWN stored rate. */
  readonly billedReporting: string;
  /** Invoices counted in `billed` that month. */
  readonly invoiceCount: number;
}

export interface CompanyBilling {
  readonly partyId: string;
  readonly name: string;
  readonly jurisdiction: string | null;
  /** The currency it bills in: `defaultCurrencyFor` its registration (D1). */
  readonly currency: string;
  readonly months: readonly MonthBilling[];
  /**
   * Invoices it issued in the window in ANOTHER currency, which `billed`
   * cannot hold without a rate between the two that nothing stores. They are
   * in `billedReporting` (every document carries its rate to the reporting
   * currency), and a company that bills in the reporting currency has none
   * here, because for it the stored rate IS the conversion.
   */
  readonly otherCurrencyInvoices: number;
}

// ── Revenue by manager (auto-invoice T4) ────────────────────────────────────

/**
 * One manager's month, in the firm's REPORTING currency, every document at the
 * rate stored on it.
 *
 * BILLED is exactly `MonthBilling`'s definition (issued invoices, by issue
 * month, before tax, less credit notes at their pre-tax share), grouped by the
 * invoice's `manager_user_id` instead of its company: Ashish's "revenue is
 * tracked by manager", and the user's definition (2026-10-01).
 *
 * COLLECTED is the cash that came in that month on the manager's issued
 * invoices, by the payment's `received_on`, WITH tax (what reached the bank).
 * A bounced cheque or a refund is a negative payment and comes off the month it
 * is dated. Payments on an invoice cancelled since are left out with it, as
 * every other figure leaves a cancelled invoice out.
 */
export interface ManagerMonth {
  readonly month: string;
  readonly billed: string;
  readonly collected: string;
  /** Invoices issued that month (credit notes and payments are not invoices). */
  readonly invoiceCount: number;
}

export interface ManagerRevenue {
  /** Null: the invoices that name nobody, one row so the table adds up to the
   *  firm. */
  readonly userId: string | null;
  /** Null for the no-manager row, and for an id this firm's roster cannot name. */
  readonly name: string | null;
  /** On the firm's staff today. False for somebody who has left: their
   *  revenue stays theirs. */
  readonly activeStaff: boolean;
  readonly months: readonly ManagerMonth[];
  /**
   * What the manager's issued invoices are owed NOW, with tax: `crm.receivable_ageing`,
   * the very rows "Owed to the firm" sums, so the managers add up to it.
   * Not cut by month: a balance is a state, not a flow.
   */
  readonly outstanding: string;
  readonly outstandingInvoices: number;
}

// ── Recurring fees by currency (0345, Q009) ─────────────────────────────────
//
// MRR is struck at the rate each letter was SIGNED at, and stays so: a
// contract's value to the firm is what it agreed. Beside it, as Zoho Books,
// Xero and QuickBooks show foreign balances, the same fees valued at TODAY's
// rate, with the rate's date and source, so a partner sees what the dirham
// work is worth this morning without the MRR figure moving under them.

/** Today's rate for one currency, or why there is none. */
export interface TodaysRate {
  readonly fxRate: string;
  readonly fxRateDate: string;
  readonly source: string;
}

/** One currency's recurring fees, a month. */
export interface CurrencyMrr {
  readonly currency: string;
  /** In `currency` itself. */
  readonly monthly: string;
  /** In the reporting currency, at each letter's own rate (what MRR counts). */
  readonly atSignedRates: string;
  /** In the reporting currency at today's rate; null with no rate held. */
  readonly atTodaysRate: string | null;
  /** Null with no rate held; the reporting currency's own row has rate 1. */
  readonly todaysRate: TodaysRate | null;
  readonly engagements: number;
}

/** One client's recurring fees in one currency. */
export interface ClientCurrencyMrr {
  readonly partyId: string;
  readonly name: string;
  readonly currency: string;
  readonly monthly: string;
  readonly atSignedRates: string;
  readonly atTodaysRate: string | null;
}

export interface MrrByCurrency {
  readonly reportingCurrency: string;
  /** The firm's day the rates are "today" for. */
  readonly asOf: string;
  /** The reporting currency first, then by code. */
  readonly currencies: readonly CurrencyMrr[];
  /** Biggest first by the signed-rate figure. */
  readonly clients: readonly ClientCurrencyMrr[];
  /** Equals the MRR card's figure. */
  readonly totalAtSignedRates: string;
  /** Null when any currency has no rate today. */
  readonly totalAtTodaysRate: string | null;
}
