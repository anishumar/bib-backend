// The values a statement prints, read: amounts and days (docs/FIN_BUILD_PLAN.md
// F2.9, F2.10). Pure, and the smallest layer of the PDF statement parser
// (`statement-pdf.ts`).
//
// ── AN AMOUNT IS READ AS DIGITS, NEVER AS A NUMBER ───────────────────────────
//
// "178,407.41 CR" becomes 17840741 minor units and a mark, held as a BigInt, and
// leaves as the decimal string "178407.41". A JS number never holds it: the
// house rule (CLAUDE.md, "Domain non-negotiables") and the only way a sum of a
// hundred card settlements comes out to the cent. The parser needs arithmetic
// in exactly one place, deciding the sign of an unsigned amount from the
// printed running balance, and BigInt is exact there.
//
// Exactly two decimals. Every statement in the pack, and every SGD, INR, AED or
// USD statement, prints cents; a statement in yen prints none, reads as no
// amounts at all, and goes to a person as an unrecognised layout. That is the
// honest failure: a guessed scale would move every amount by a factor of 100.
//
// ── A DAY IS SPLIT, NEVER PARSED BY `Date` ───────────────────────────────────
//
// `domain/day.ts`'s rule. And a statement's days are worse than most: "03 Feb"
// has no year (the statement period says which), "13/01" has no year and no
// order (Singapore writes the day first, the US the month), and "10-Feb-25" has
// a two-digit year. Each token is read into its parts here; which order and
// which year are decided once per statement (`resolveDays`), from all its days
// together and the period it prints, never one token at a time.

/** A printed amount: absolute minor units (cents) and the marks around it. */
export interface PrintedAmount {
  readonly cents: bigint;
  /** An explicit sign: a leading "+" or "-", a trailing "-", or parentheses
   *  (read as "-"). Null when the amount carries none. */
  readonly sign: "+" | "-" | null;
  /** A "CR" / "DR" suffix, upper-cased. */
  readonly suffix: "CR" | "DR" | null;
}

const AMOUNT =
  /^(?<lead>[+-])?\s*(?<open>\()?\s*(?<int>\d{1,3}(?:,\d{3})+|\d+)\.(?<frac>\d{2})\s*(?<close>\))?(?<trail>-)?\s*(?<suffix>CR|DR|Cr|Dr|cr|dr)?$/u;

/** Reads "1,234.56", "-392.40", "+2,178.63", "(25.00)", "25.00-", "5,803.11 CR".
 *  Null for anything else, including an amount with no cents. */
export function readAmount(text: string): PrintedAmount | null {
  const m = AMOUNT.exec(text.trim());
  const g = m?.groups;
  if (g === undefined) return null;
  const { lead, open, int, frac, close, trail, suffix } = g;
  if (int === undefined || frac === undefined) return null;
  if ((open === undefined) !== (close === undefined)) return null;
  const signs = [lead, open === undefined ? undefined : "-", trail].filter((s) => s !== undefined);
  if (signs.length > 1) return null;
  const sign = signs[0] === "+" ? "+" : signs[0] === "-" ? "-" : null;
  return {
    cents: BigInt(int.replace(/,/gu, "") + frac),
    sign,
    suffix: suffix === undefined ? null : suffix.toUpperCase() === "CR" ? "CR" : "DR",
  };
}

/** Whether a text run is an amount on its own, or a bare "CR"/"DR" mark that
 *  belongs to the amount printed just left of it. */
export function isSuffixMark(text: string): boolean {
  return /^(CR|DR|Cr|Dr)$/u.test(text.trim());
}

/** Minor units to the decimal string the line drafts carry: "-1234.50". */
export function centsToDecimal(cents: bigint): string {
  const negative = cents < 0n;
  const digits = (negative ? -cents : cents).toString().padStart(3, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

// ── Days ─────────────────────────────────────────────────────────────────────

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/** A day as printed, before the statement says which year or which order. */
export type DayToken =
  /** The month is a word ("03 Feb", "04FEB25", "Feb 3, 2025"): no doubt
   *  about the order. */
  | { readonly kind: "named"; readonly day: number; readonly month: number; readonly year: number | null }
  /** All numbers ("03/02/2025", "13/01"): day-first or month-first is the
   *  statement's to say. */
  | { readonly kind: "numeric"; readonly first: number; readonly second: number; readonly year: number | null }
  /** "2025-02-03": the one order nobody misreads. */
  | { readonly kind: "iso"; readonly day: number; readonly month: number; readonly year: number };

/** A two-digit year is this century's: a statement from 1925 is not a file a
 *  client sends to fin. */
function fullYear(text: string | undefined): number | null {
  if (text === undefined) return null;
  const n = Number(text);
  return text.length === 2 ? 2000 + n : n;
}

/** Reads one date-shaped run, or null. "03 Feb", "03 Feb 2025", "10-Feb-25",
 *  "04FEB25", "3 February 2025", "Feb 3, 2025", "03/02/2025", "13/01",
 *  "03.02.2025", "2025-02-03". */
export function readDayToken(text: string): DayToken | null {
  const t = text.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(t);
  if (iso !== null) {
    return { kind: "iso", year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  }
  const dayFirst = /^(\d{1,2})[\s.-]?([A-Za-z]{3,9})\.?(?:[\s.,-]{0,2}(\d{4}|\d{2}))?$/u.exec(t);
  if (dayFirst !== null) {
    const month = MONTHS[(dayFirst[2] ?? "").toLowerCase()];
    if (month === undefined) return null;
    return { kind: "named", day: Number(dayFirst[1]), month, year: fullYear(dayFirst[3]) };
  }
  const monthFirst = /^([A-Za-z]{3,9})\.?\s(\d{1,2}),?(?:\s(\d{4}))?$/u.exec(t);
  if (monthFirst !== null) {
    const month = MONTHS[(monthFirst[1] ?? "").toLowerCase()];
    if (month === undefined) return null;
    return { kind: "named", day: Number(monthFirst[2]), month, year: fullYear(monthFirst[3]) };
  }
  const numeric = /^(\d{1,2})([/.-])(\d{1,2})(?:\2(\d{4}|\d{2}))?$/u.exec(t);
  if (numeric !== null) {
    return {
      kind: "numeric",
      first: Number(numeric[1]),
      second: Number(numeric[3]),
      year: fullYear(numeric[4]),
    };
  }
  return null;
}

/** A calendar day's parts. */
export interface DayParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Whether these parts name a real day (2025-02-29 does not). */
export function isRealDay(p: DayParts): boolean {
  return (
    Number.isInteger(p.year) &&
    p.year >= 1900 &&
    p.year <= 2999 &&
    p.month >= 1 &&
    p.month <= 12 &&
    p.day >= 1 &&
    p.day <= daysInMonth(p.year, p.month)
  );
}

/** Days since 1970-01-01 for a real day: the civil-from-days count, so two days
 *  can be compared and subtracted with no `Date` and no zone. */
export function dayNumber(p: DayParts): number {
  const y = p.month <= 2 ? p.year - 1 : p.year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (p.month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + p.day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** `YYYY-MM-DD`. */
export function isoOf(p: DayParts): string {
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Which order an all-numbers day is printed in. */
export type NumericOrder = "day_first" | "month_first";

/** What a statement says about its own dates: the period it covers, when it
 *  prints one. The END decides the year of a day printed without one. */
export interface StatementWindow {
  readonly start: DayParts | null;
  readonly end: DayParts;
}

/**
 * The year a day printed without one belongs to: the window's end year, or the
 * year before when that would put the day more than a month after the window
 * ends. A January statement's "26 Dec" is last December, and so is a statement
 * running 15 Dec to 14 Jan's.
 */
function withYear(month: number, day: number, window: StatementWindow): DayParts {
  const same = { year: window.end.year, month, day };
  const tooLate = isRealDay(same) && dayNumber(same) > dayNumber(window.end) + 31;
  return tooLate ? { year: window.end.year - 1, month, day } : same;
}

function partsUnder(token: DayToken, order: NumericOrder, window: StatementWindow | null): DayParts | null {
  if (token.kind === "iso") return token;
  const [month, day, year] =
    token.kind === "named"
      ? [token.month, token.day, token.year]
      : order === "day_first"
        ? [token.second, token.first, token.year]
        : [token.first, token.second, token.year];
  if (year !== null) return { year, month, day };
  if (window === null) return null;
  return withYear(month, day, window);
}

/** Whether a day sits where a statement's own window says its days are: inside
 *  it, give or take a fortnight for a card's post dates. */
function nearWindow(p: DayParts, window: StatementWindow): boolean {
  const n = dayNumber(p);
  const from = window.start === null ? dayNumber(window.end) - 62 : dayNumber(window.start);
  return n >= from - 45 && n <= dayNumber(window.end) + 15;
}

export type ResolvedDays =
  | { readonly ok: true; readonly days: readonly string[]; readonly order: NumericOrder }
  | { readonly ok: false; readonly why: string };

/**
 * Turns every day token on a statement into a `YYYY-MM-DD`, deciding the
 * numeric order ONCE for the whole statement.
 *
 * An order is possible when it makes every token a real day; when the statement
 * prints its window, it must also put every day near it (that is what tells
 * "02/03" in a February statement from the same text in a March one). Day-first
 * wins a tie: Singapore, India, the UAE and the UK all write the day first, and
 * a statement whose days are all 12 or under reads the same either way only in
 * the rare month where it does not matter. Neither order possible, or a day
 * with no year and no window to take one from, is an unreadable layout.
 */
export function resolveDays(tokens: readonly DayToken[], window: StatementWindow | null): ResolvedDays {
  const orders: NumericOrder[] = ["day_first", "month_first"];
  const needsOrder = tokens.some((t) => t.kind === "numeric");
  const candidates = needsOrder ? orders : ["day_first" as const];
  let lastWhy = "no dates";
  for (const order of candidates) {
    const parts = tokens.map((t) => partsUnder(t, order, window));
    if (parts.some((p) => p === null)) {
      lastWhy = "a date has no year and the statement prints no period to take one from";
      continue;
    }
    const real = parts as DayParts[];
    if (!real.every(isRealDay)) {
      lastWhy = `dates are not real days when read ${order.replace("_", "-")}`;
      continue;
    }
    if (window !== null && needsOrder && !real.every((p) => nearWindow(p, window))) {
      lastWhy = `dates fall outside the statement period when read ${order.replace("_", "-")}`;
      continue;
    }
    return { ok: true, days: real.map(isoOf), order };
  }
  return { ok: false, why: lastWhy };
}

/** A full day (a statement period's ends, a statement date): year required. */
export function fullDayOf(text: string, order: NumericOrder = "day_first"): DayParts | null {
  const token = readDayToken(text);
  if (token === null) return null;
  const parts = partsUnder(token, order, null);
  return parts !== null && isRealDay(parts) ? parts : null;
}
