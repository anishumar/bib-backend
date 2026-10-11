// Patterns against history: the arithmetic (docs/FIN_BUILD_PLAN.md F5.1). Pure.
//
// Lane B (`pattern` in finding.ts) compares a client with ITS OWN past: "this
// vendor is normally S$20–30k a month, this month it is S$300k". Its unit is
// one client × counterparty key × GL account, built from MONTHLY SUMMARIES of
// committed lines (nothing a person has not committed counts, F2.8). This file
// is the arithmetic only: months, exact money, the median, the MAD, the robust
// z, the cadence, and the profile row (`fin.counterparty_profile`, stored from
// the next wave). The checks are `pattern-checks.ts`, what a person's decisions
// teach is `pattern-learning.ts`, and the words are `pattern-text.ts`.
//
// Rules and arithmetic decide; no AI is involved anywhere in this lane. A
// pattern finding is a machine saying "check this", shown in its own panel and
// NEVER counted in the exception score.
//
// ── MONEY IS EXACT: BigInt MICRO-UNITS, NOT CENTS ────────────────────────────
//
// Amounts arrive and leave as decimal strings (CLAUDE.md, "Domain
// non-negotiables"). In between, every sum, median and MAD is a BigInt count of
// MILLIONTHS of the currency unit, and nothing is ever rounded:
//
//   - cents are not enough: an amount this product admits may carry FOUR
//     places (`MAX_AMOUNT_SCALE`), and the median of 100.01 and 100.02 is
//     100.015. A median or a MAD of an even count needs at most ONE place more
//     than its inputs (a deviation from a half-unit median is an odd number of
//     half-units, and two of them add up to whole ones), so five places hold
//     every value exactly; millionths are the round unit above that, and no
//     value here is ever rounded;
//   - BigInt, not a safe integer: 2^53 micro-units is only about S$9 billion,
//     which a year of one large vendor's bills (or a rupee ledger) can reach,
//     and a silent precision loss in a baseline is the error this rule exists
//     to prevent. BigInt has no ceiling.
//
// Ratios and z-scores are plain numbers: they are not money, nobody adds them
// up, and they are rounded only when stored as facts.
//
// ── MEDIAN AND MAD ───────────────────────────────────────────────────────────
//
// The baseline is the MEDIAN of the key's monthly amounts, and its spread the
// MAD (median absolute deviation from that median). Both ignore a freak month:
// one past S$300k spike among S$25k months moves neither, where a mean and a
// standard deviation would both be dragged, and would then hide the next spike.
//
// The robust z is (x − median) / σ, where σ = 1.4826 × MAD: 1.4826 is 1/Φ⁻¹(¾),
// the constant that makes the MAD estimate the standard deviation when the
// months are roughly normal, so "z > 6" reads like six standard deviations
// (the usual statistical convention, e.g. Iglewicz–Hoaglin's modified z uses
// the equivalent 0.6745 = 1/1.4826).
//
// σ has a FLOOR, `minSpreadRatio` × |median| (a setting): a retainer billed at
// exactly S$9,800 eleven months running has a MAD of zero, and without a floor
// any change at all, even S$9,850, would be an infinite z. With a floor of 0.1
// the z route needs a move of more than 60% of the median before it fires.
import type { Day } from "./lines";

// ── Months ───────────────────────────────────────────────────────────────────

/** `YYYY-MM`. A calendar month, the period a pattern is judged on. */
export type Month = string;

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isMonth(v: string): boolean {
  return MONTH_PATTERN.test(v);
}

/** Months since year 0, so two months subtract to the gap between them. */
export function monthIndex(month: Month): number {
  const m = MONTH_PATTERN.exec(month);
  if (m === null) throw new RangeError(`a month is written YYYY-MM (2025-03), not ${JSON.stringify(month)}`);
  return Number(m[1]) * 12 + Number(m[2]) - 1;
}

export function monthAt(index: number): Month {
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`a month index is a non-negative integer, not ${String(index)}`);
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

export function addMonths(month: Month, n: number): Month {
  return monthAt(monthIndex(month) + n);
}

/** 1 (January) to 12. */
export function monthOfYear(month: Month): number {
  return (monthIndex(month) % 12) + 1;
}

/** The month a calendar day falls in. */
export function monthOfDay(day: Day): Month {
  const m = /^(\d{4}-\d{2})-\d{2}$/.exec(day);
  const month = m?.[1];
  if (month === undefined || !isMonth(month)) throw new RangeError(`a day is written YYYY-MM-DD, not ${JSON.stringify(day)}`);
  return month;
}

export function firstDayOf(month: Month): Day {
  monthIndex(month);
  return `${month}-01`;
}

export function lastDayOf(month: Month): Day {
  const index = monthIndex(month);
  const year = Math.floor(index / 12);
  const m = (index % 12) + 1;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = m === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;
  return `${month}-${String(days)}`;
}

// ── Exact money ──────────────────────────────────────────────────────────────

/** Millionths of the currency unit. See the file header for why not cents. */
export type Micros = bigint;

const SCALE = 6;
const ONE_UNIT = 1_000_000n;

/** What `toMicros` accepts: the product's signed amount, at most four places
 *  (`isSignedAmount` in domain/money). */
const INPUT_AMOUNT = /^(-?)(\d{1,15})(?:\.(\d{1,4}))?$/;

/**
 * A decimal string as micro-units, exactly. Refuses more than four decimal
 * places rather than rounding them away: a summary is the database's SUM
 * rounded to the currency's minor unit, so a fifth place is a caller's bug.
 */
export function toMicros(amount: string, what = "amount"): Micros {
  const m = INPUT_AMOUNT.exec(amount.trim());
  if (m === null) {
    throw new RangeError(
      `${what} must be a decimal string with at most 15 digits before the point and 4 after ` +
        `("1499.50", "-120"), not ${JSON.stringify(amount)}`,
    );
  }
  const value = BigInt((m[2] ?? "0") + (m[3] ?? "").padEnd(SCALE, "0"));
  return m[1] === "-" ? -value : value;
}

/** Micro-units as a decimal string: at least two places, more only when the
 *  value has them ("24500.00", "100.015"). Never a float on the way. */
export function fromMicros(value: Micros): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(SCALE + 1, "0");
  const whole = digits.slice(0, -SCALE);
  const fraction = digits.slice(-SCALE).replace(/0+$/, "").padEnd(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** For a ratio or a z-score only: NOT money once converted. */
export function microsToNumber(value: Micros): number {
  return Number(value) / Number(ONE_UNIT);
}

/** `value × percent / 100`, exact for anything `toMicros` produced (a multiple
 *  of 100 micro-units). Used to raise a materiality bar by a whole percentage. */
export function scaleMicros(value: Micros, percent: number): Micros {
  if (!Number.isInteger(percent) || percent < 0) throw new RangeError(`a percentage here is a non-negative integer, not ${String(percent)}`);
  return (value * BigInt(percent)) / 100n;
}

function compareMicros(a: Micros, b: Micros): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function at<T>(values: readonly T[], i: number): T {
  const v = values[i];
  if (v === undefined) throw new RangeError(`index ${String(i)} is outside a list of ${String(values.length)}`);
  return v;
}

// ── Robust statistics ────────────────────────────────────────────────────────

/** σ ≈ 1.4826 × MAD for normally distributed months. See the file header. */
export const MAD_TO_SIGMA = 1.4826;

/**
 * The median, exactly: the middle value, or half the sum of the two middle
 * values for an even count. Exact for amounts from `toMicros` and for their
 * deviations from such a median (see the file header); anything else that
 * would need rounding is refused rather than rounded.
 */
export function medianOf(values: readonly Micros[]): Micros {
  if (values.length === 0) throw new RangeError("the median of no months is undefined: check there is history first");
  const sorted = [...values].sort(compareMicros);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return at(sorted, mid);
  const sum = at(sorted, mid - 1) + at(sorted, mid);
  if (sum % 2n !== 0n) {
    throw new RangeError(`the median of ${String(sum)} / 2 micro-units is not exact: pass amounts from toMicros`);
  }
  return sum / 2n;
}

/** Median absolute deviation from `median`, exactly. */
export function madOf(values: readonly Micros[], median: Micros): Micros {
  return medianOf(values.map((v) => (v >= median ? v - median : median - v)));
}

/** σ for the robust z: 1.4826 × MAD, but never below `minSpreadRatio` of the
 *  median's size (a flat retainer has a MAD of zero). */
export function spreadOf(median: Micros, mad: Micros, minSpreadRatio: number): number {
  return Math.max(MAD_TO_SIGMA * microsToNumber(mad), minSpreadRatio * Math.abs(microsToNumber(median)));
}

/**
 * (x − median) / σ. A plain number, not money. ±Infinity when σ is zero and x
 * differs from the median (every past month exactly zero), 0 when x equals it.
 */
export function robustZ(x: Micros, median: Micros, mad: Micros, minSpreadRatio: number): number {
  const sigma = spreadOf(median, mad, minSpreadRatio);
  const delta = microsToNumber(x - median);
  if (sigma === 0) return delta === 0 ? 0 : delta > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  return delta / sigma;
}

/** x as a multiple of the median; null when the median is not positive (a
 *  baseline of credit notes has no meaningful "times normal"). */
export function ratioTo(x: Micros, median: Micros): number | null {
  if (median <= 0n) return null;
  return microsToNumber(x) / microsToNumber(median);
}

/** The median of plain counts (lines per month). May be a half. */
export function medianCount(counts: readonly number[]): number | null {
  if (counts.length === 0) return null;
  const sorted = [...counts].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? at(sorted, mid) : (at(sorted, mid - 1) + at(sorted, mid)) / 2;
}

// ── Cadence ──────────────────────────────────────────────────────────────────

/**
 * How often a key bills, judged from the months it appeared in:
 *
 *   - `monthly`: at least three appearances, at least three quarters of the
 *     gaps between them are one month, and none is longer than two (one
 *     skipped month does not make a monthly biller irregular);
 *   - `quarterly`: at least three appearances, at least three quarters of the
 *     gaps are three months, and every gap is two to four;
 *   - `irregular`: anything else, including a vendor seen once or twice, and a
 *     two-monthly biller (the pack has several). Irregular keys are never
 *     "missing" and never have a "frequency change".
 *
 * These are definitions, not per-firm thresholds: a firm tunes how loud the
 * checks are (`PatternSettings`), not what "monthly" means.
 */
export type Cadence = "monthly" | "quarterly" | "irregular";

export const CADENCES: readonly Cadence[] = ["monthly", "quarterly", "irregular"];

export const CADENCE_MIN_APPEARANCES = 3;
const CADENCE_REGULAR_SHARE = 0.75;

/** The usual gap, in months, of a regular cadence. */
export function cadenceGap(cadence: Cadence): number | null {
  return cadence === "monthly" ? 1 : cadence === "quarterly" ? 3 : null;
}

export function cadenceOf(monthsSeen: readonly Month[]): Cadence {
  const indexes = [...new Set(monthsSeen.map(monthIndex))].sort((a, b) => a - b);
  if (indexes.length < CADENCE_MIN_APPEARANCES) return "irregular";
  const gaps = indexes.slice(1).map((v, i) => v - at(indexes, i));
  const share = (gap: number): number => gaps.filter((g) => g === gap).length / gaps.length;
  if (share(1) >= CADENCE_REGULAR_SHARE && gaps.every((g) => g <= 2)) return "monthly";
  if (share(3) >= CADENCE_REGULAR_SHARE && gaps.every((g) => g >= 2 && g <= 4)) return "quarterly";
  return "irregular";
}

// ── The check keys ───────────────────────────────────────────────────────────

/** The pattern checks (F5.2). The screen's words are keyed on these. */
export type PatternCheckKey =
  | "pattern.spike"
  | "pattern.new_vendor"
  | "pattern.recurring_missing"
  | "pattern.frequency_change"
  | "pattern.gl_drift";

export const PATTERN_CHECK_KEYS: readonly PatternCheckKey[] = [
  "pattern.spike",
  "pattern.new_vendor",
  "pattern.recurring_missing",
  "pattern.frequency_change",
  "pattern.gl_drift",
];

export function isPatternCheckKey(v: string): v is PatternCheckKey {
  return (PATTERN_CHECK_KEYS as readonly string[]).includes(v);
}

// ── Monthly summaries: the input ─────────────────────────────────────────────

/**
 * One key's committed lines in one month: what the database hands the profile.
 * The amount is in the CLIENT'S base currency, the SUM rounded to its minor
 * unit, at most four places, signed (a credit note nets it down).
 */
export interface MonthlySummary {
  readonly month: Month;
  readonly amount: string;
  /** How many BILLS made it. A credit note is in the amount and the line ids
   *  but not in the count: an invoice and its credit note is not "two bills". */
  readonly count: number;
  readonly lineIds: readonly string[];
}

/** A summary with the key it belongs to. The client is the caller's. */
export interface KeyedSummary extends MonthlySummary {
  /** The counterparty key of F3.2 (UEN, else GST number, else normalised
   *  name): an identifier, never a display name. */
  readonly counterpartyKey: string;
  readonly glAccount: string;
}

// ── The profile ──────────────────────────────────────────────────────────────

/** Why a month that happened is left out of the baseline (F5.4). */
export type LeftOutBecause = "before_price_change" | "one_off" | "seasonal";

/** What a person's decisions changed about one key's baseline
 *  (`pattern-learning.ts` derives it; the profile only applies it). */
export interface ProfileAdjustments {
  /** A `price_change`: the baseline restarts at this month. */
  readonly baselineFrom: Month | null;
  /** `one_off`: these months are left out of the baseline. */
  readonly oneOffMonths: readonly Month[];
  /** `seasonal`: these months of the year (1–12) are left out of the ordinary
   *  baseline and judged against the same month a year earlier. */
  readonly seasonalMonthsOfYear: readonly number[];
}

export const NO_ADJUSTMENTS: ProfileAdjustments = { baselineFrom: null, oneOffMonths: [], seasonalMonthsOfYear: [] };

export interface ProfileMonthFigures {
  readonly month: Month;
  readonly amount: Micros;
  readonly count: number;
  readonly lineIds: readonly string[];
  readonly leftOut: LeftOutBecause | null;
}

/** A key's history as the checks use it: exact figures, oldest month first. */
export interface Profile {
  readonly counterpartyKey: string;
  readonly glAccount: string;
  /** The last month the profile includes. A profile `asOf` March judges April. */
  readonly asOf: Month;
  /** Every month the key appeared in within the lookback window. */
  readonly months: readonly ProfileMonthFigures[];
  /** The amounts of the months in the baseline (not left out), oldest first. */
  readonly baseline: readonly Micros[];
  readonly median: Micros | null;
  readonly mad: Micros | null;
  /** The lowest and highest ordinary baseline months: those within 3.5 σ of
   *  the median (Iglewicz–Hoaglin's outlier cut), so one past spike does not
   *  stretch "usually S$21k–30k" to "S$21k–300k". */
  readonly usualLow: Micros | null;
  readonly usualHigh: Micros | null;
  /** The median number of lines in a baseline month. */
  readonly usualCount: number | null;
  readonly cadence: Cadence;
  readonly firstSeen: Month;
  readonly lastSeen: Month;
  /** Months the key appeared in, within the window (baseline or not). */
  readonly monthsSeen: number;
  readonly lineCount: number;
  readonly adjustments: ProfileAdjustments;
}

/** A month whose robust z is above this is not "usual" for the range shown. */
export const USUAL_BAND_Z = 3.5;

export interface ProfileInput {
  readonly counterpartyKey: string;
  readonly glAccount: string;
  /** The key's summaries. Months outside the window are ignored; two
   *  summaries of one month are added together. */
  readonly history: readonly MonthlySummary[];
  readonly asOf: Month;
  /** How many months back from `asOf` (inclusive) the profile looks. */
  readonly lookbackMonths: number;
  readonly minSpreadRatio: number;
  readonly adjustments: ProfileAdjustments;
}

/** The profile of one key, or null when it has no month in the window. */
export function buildProfile(input: ProfileInput): Profile | null {
  const last = monthIndex(input.asOf);
  const first = last - input.lookbackMonths + 1;
  const merged = new Map<number, { amount: Micros; count: number; lineIds: string[] }>();
  for (const s of input.history) {
    const i = monthIndex(s.month);
    if (i < first || i > last) continue;
    const prior = merged.get(i);
    const amount = toMicros(s.amount, `the ${s.month} amount of ${input.counterpartyKey} / ${input.glAccount}`);
    if (prior === undefined) merged.set(i, { amount, count: s.count, lineIds: [...s.lineIds] });
    else merged.set(i, { amount: prior.amount + amount, count: prior.count + s.count, lineIds: [...prior.lineIds, ...s.lineIds] });
  }
  if (merged.size === 0) return null;

  const adj = input.adjustments;
  const from = adj.baselineFrom === null ? null : monthIndex(adj.baselineFrom);
  const oneOff = new Set(adj.oneOffMonths.map(monthIndex));
  const seasonal = new Set(adj.seasonalMonthsOfYear);
  const months: ProfileMonthFigures[] = [...merged.entries()]
    .sort(([a], [b]) => a - b)
    .map(([i, v]) => {
      const month = monthAt(i);
      const leftOut: LeftOutBecause | null =
        from !== null && i < from ? "before_price_change" : oneOff.has(i) ? "one_off" : seasonal.has(monthOfYear(month)) ? "seasonal" : null;
      return { month, amount: v.amount, count: v.count, lineIds: [...v.lineIds].sort(), leftOut };
    });

  const inBaseline = months.filter((m) => m.leftOut === null);
  const baseline = inBaseline.map((m) => m.amount);
  const median = baseline.length === 0 ? null : medianOf(baseline);
  const mad = median === null ? null : madOf(baseline, median);
  let usualLow: Micros | null = null;
  let usualHigh: Micros | null = null;
  if (median !== null && mad !== null) {
    for (const v of baseline) {
      if (Math.abs(robustZ(v, median, mad, input.minSpreadRatio)) > USUAL_BAND_Z) continue;
      if (usualLow === null || v < usualLow) usualLow = v;
      if (usualHigh === null || v > usualHigh) usualHigh = v;
    }
  }

  return {
    counterpartyKey: input.counterpartyKey,
    glAccount: input.glAccount,
    asOf: input.asOf,
    months,
    baseline,
    median,
    mad,
    usualLow,
    usualHigh,
    usualCount: medianCount(inBaseline.map((m) => m.count)),
    cadence: cadenceOf(months.map((m) => m.month)),
    firstSeen: at(months, 0).month,
    lastSeen: at(months, months.length - 1).month,
    monthsSeen: months.length,
    lineCount: months.reduce((n, m) => n + m.count, 0),
    adjustments: adj,
  };
}

/**
 * One row of `fin.counterparty_profile` (F5.1; the table arrives next wave):
 * one per client × counterparty key × GL account, rebuilt after each commit.
 * Money is a decimal string; `months` is the jsonb history the screen draws.
 * It is a CACHE for the panel: the checks recompute from the summaries, so a
 * stale row can never cause or hide a finding.
 */
export interface ProfileRow {
  readonly clientPartyId: string;
  readonly counterpartyKey: string;
  readonly glAccount: string;
  /** The client's base currency, which every amount here is in. */
  readonly currency: string;
  readonly asOf: Month;
  readonly months: readonly { readonly month: Month; readonly amount: string; readonly count: number; readonly leftOut: LeftOutBecause | null }[];
  readonly baselineMonths: number;
  readonly median: string | null;
  readonly mad: string | null;
  readonly usualLow: string | null;
  readonly usualHigh: string | null;
  readonly usualCount: number | null;
  readonly cadence: Cadence;
  readonly firstSeen: Month;
  readonly lastSeen: Month;
  readonly monthsSeen: number;
  readonly lineCount: number;
  readonly baselineFrom: Month | null;
}

const maybe = (v: Micros | null): string | null => (v === null ? null : fromMicros(v));

export function toProfileRow(clientPartyId: string, currency: string, p: Profile): ProfileRow {
  return {
    clientPartyId,
    counterpartyKey: p.counterpartyKey,
    glAccount: p.glAccount,
    currency,
    asOf: p.asOf,
    months: p.months.map((m) => ({ month: m.month, amount: fromMicros(m.amount), count: m.count, leftOut: m.leftOut })),
    baselineMonths: p.baseline.length,
    median: maybe(p.median),
    mad: maybe(p.mad),
    usualLow: maybe(p.usualLow),
    usualHigh: maybe(p.usualHigh),
    usualCount: p.usualCount,
    cadence: p.cadence,
    firstSeen: p.firstSeen,
    lastSeen: p.lastSeen,
    monthsSeen: p.monthsSeen,
    lineCount: p.lineCount,
    baselineFrom: p.adjustments.baselineFrom,
  };
}
