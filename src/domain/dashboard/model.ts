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
