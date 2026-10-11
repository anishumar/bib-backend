// The words of a pattern finding (docs/FIN_BUILD_PLAN.md F5.3). Pure.
//
// A finding stores machine FACTS (pattern-checks.ts), never a sentence: the
// sentence is written here, at READ time, the way `renderNotification` writes
// a notification's (CLAUDE.md, "Notifications"). So a renamed vendor reads
// right in an old finding, and no name is stored: the counterparty's NAME is
// passed in by the reader, resolved from its key, because a vendor may be a
// person (a freelancer) and facts are never personal data.
//
// The spike reads exactly:
//   Vendor X: S$300,000 this month; usually S$21k–30k (median S$24.5k over
//   6 months), 12× normal
//
// ── HOW MONEY IS WRITTEN ─────────────────────────────────────────────────────
//
// The symbol: SGD → "S$", INR → "₹", USD → "US$" (ambiguity is the reason this
// product prints codes elsewhere; these three are unambiguous), any other
// currency its code and a space ("AED 5,000").
//
// IN FULL (the month's own amount): grouped in thousands (rupees in lakhs, as
// every rupee figure in this product is), minor units only when there are some
// ("S$7,516.64", "S$300,000"), rounded half away from zero on the digits.
//
// COMPACT (the baseline: the range, the median), on the exact digits, half away
// from zero, never through a float:
//   - under 1,000: whole units ("S$750"; S$999.50 becomes "S$1k");
//   - under a million: thousands to one decimal, a trailing ".0" dropped
//     ("S$21k", "S$24.5k", "S$999.9k"; S$999,950 becomes "S$1M");
//   - from a million: millions to two decimals, trailing zeros dropped
//     ("S$1M", "S$1.25M", "S$1,250M").
//   k and M for every currency, rupees included: lakh and crore are a later
//   refinement if 10x's Indian clients want them.
//
// The ratio: "12×" from ten up (whole), "3.4×" below (one decimal, ".0"
// dropped).
import type { FindingFact } from "./finding";
import { minorUnitsOf } from "../render/money";
import type { Micros } from "./pattern";
import { isMonth, monthIndex, toMicros } from "./pattern";

const SYMBOLS: Readonly<Record<string, string>> = { SGD: "S$", INR: "₹", USD: "US$" };

/** What goes before a figure: a symbol glued on, or a code and a space. */
export function currencyPrefix(currency: string): string {
  const code = currency.trim().toUpperCase();
  return SYMBOLS[code] ?? `${code} `;
}

const ONE = 1_000_000n;

function roundToUnit(abs: Micros, unit: Micros): Micros {
  return (abs + unit / 2n) / unit;
}

function thousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function lakhs(digits: string): string {
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${head},${digits.slice(-3)}`;
}

/** Micro-units as an exact decimal string with up to two places shown (trailing zeros dropped). */
function scaled(value: Micros, places: number): string {
  const digits = value.toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

/** An amount in full: "S$300,000", "S$7,516.64", "₹12,50,000". */
export function formatFull(amount: string, currency: string): string {
  const v = toMicros(amount);
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const places = minorUnitsOf(currency);
  const unit = ONE / 10n ** BigInt(places);
  const minor = roundToUnit(abs, unit);
  const text = minor.toString().padStart(places + 1, "0");
  const whole = text.slice(0, text.length - places);
  const fraction = places === 0 ? "" : text.slice(text.length - places);
  const grouped = currency.trim().toUpperCase() === "INR" ? lakhs(whole) : thousands(whole);
  const shown = /[1-9]/.test(fraction) ? `${grouped}.${fraction}` : grouped;
  return `${negative && minor !== 0n ? "-" : ""}${currencyPrefix(currency)}${shown}`;
}

/** An amount, compact: "S$24.5k", "S$1.25M", "S$750". `symbol: false` leaves
 *  the prefix off (the high end of a range). */
export function formatCompact(amount: string, currency: string, symbol = true): string {
  const v = toMicros(amount);
  const negative = v < 0n;
  const abs = negative ? -v : v;
  let body: string;
  const units = roundToUnit(abs, ONE);
  if (units < 1000n) {
    body = units.toString();
  } else {
    const tenthsOfK = roundToUnit(abs, 100n * ONE);
    if (tenthsOfK < 10_000n) {
      body = `${scaled(tenthsOfK, 1)}k`;
    } else {
      const hundredthsOfM = roundToUnit(abs, 10_000n * ONE);
      const text = scaled(hundredthsOfM, 2);
      const [whole = "0", fraction] = text.split(".");
      body = `${thousands(whole)}${fraction === undefined ? "" : `.${fraction}`}M`;
    }
  }
  const zero = body === "0";
  return `${negative && !zero ? "-" : ""}${symbol ? currencyPrefix(currency) : ""}${body}`;
}

/** "S$21k–30k", or one figure when both ends read the same. */
export function formatRange(low: string, high: string, currency: string): string {
  const a = formatCompact(low, currency);
  const b = formatCompact(high, currency, false);
  return a === formatCompact(high, currency) ? a : `${a}–${b}`;
}

/** "12×", "3.4×", "3×". */
export function formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) return "";
  if (ratio >= 10) return `${String(Math.round(ratio))}×`;
  const tenths = Math.round(ratio * 10);
  return `${tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1)}×`;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mar 2025". */
export function formatMonth(month: string): string {
  const i = monthIndex(month);
  return `${MONTH_NAMES[i % 12] ?? ""} ${String(Math.floor(i / 12))}`;
}

const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

// ── Reading facts back defensively ──────────────────────────────────────────
//
// Facts come back from a jsonb column. A fact that is missing or of the wrong
// type gives the check's plain sentence instead of a throw: the panel must
// render whatever an old row holds.

type Facts = Readonly<Record<string, FindingFact>>;

function amountFact(f: Facts, key: string): string | null {
  const v = f[key];
  if (typeof v !== "string") return null;
  try {
    toMicros(v);
    return v;
  } catch {
    return null;
  }
}

function numberFact(f: Facts, key: string): number | null {
  const v = f[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function textFact(f: Facts, key: string): string | null {
  const v = f[key];
  return typeof v === "string" && v !== "" ? v : null;
}

function monthFact(f: Facts, key: string): string | null {
  const v = textFact(f, key);
  return v !== null && isMonth(v) ? v : null;
}

export interface ExplainContext {
  /** The counterparty's display name, resolved from its key by the reader. */
  readonly counterpartyName: string;
  /** "6210 Office supplies", when the reader knows the account's name. */
  readonly accountName?: (code: string) => string | null;
}

/** The one sentence for a pattern finding, written now from its facts. */
export function explainPatternFinding(finding: { readonly checkKey: string; readonly facts: Facts }, ctx: ExplainContext): string {
  const f = finding.facts;
  const name = ctx.counterpartyName.trim() === "" ? "This vendor" : ctx.counterpartyName.trim();
  const currency = textFact(f, "currency") ?? "SGD";
  const account = (code: string): string => {
    const label = ctx.accountName?.(code) ?? null;
    return label === null || label.trim() === "" ? code : `${code} ${label.trim()}`;
  };

  switch (finding.checkKey) {
    case "pattern.spike": {
      const amount = amountFact(f, "amount");
      if (amount === null) return `${name}: unusually large this month against its own history`;
      const head = `${name}: ${formatFull(amount, currency)} this month`;
      if (textFact(f, "comparedWith") === "same_month_last_year") {
        const ly = amountFact(f, "lastYearAmount");
        const ratio = numberFact(f, "ratio");
        if (ly === null) return `${head}; much more than the same month last year`;
        return `${head}; ${formatCompact(ly, currency)} in the same month last year${ratio === null ? "" : `, ${formatRatio(ratio)} that`}`;
      }
      const low = amountFact(f, "usualLow");
      const high = amountFact(f, "usualHigh");
      const median = amountFact(f, "median");
      const months = numberFact(f, "baselineMonths");
      const ratio = numberFact(f, "ratio");
      const usual = low !== null && high !== null ? `usually ${formatRange(low, high, currency)}` : "well above usual";
      const basis =
        median !== null && months !== null ? ` (median ${formatCompact(median, currency)} over ${plural(months, "month", "months")})` : "";
      const times = ratio === null ? "" : `, ${formatRatio(ratio)} normal`;
      return `${head}; ${usual}${basis}${times}`;
    }
    case "pattern.new_vendor": {
      const amount = amountFact(f, "amount");
      const lines = numberFact(f, "lineCount");
      const months = numberFact(f, "historyMonths");
      if (amount === null) return `${name}: a new vendor this month`;
      const bills = lines === null ? "" : ` (${plural(lines, "bill", "bills")})`;
      const since = months === null ? "" : `; none in the previous ${plural(months, "month", "months")}`;
      return `${name}: new vendor, ${formatFull(amount, currency)} this month${bills}${since}`;
    }
    case "pattern.recurring_missing": {
      const cadence = textFact(f, "cadence");
      const last = monthFact(f, "lastSeen");
      const median = amountFact(f, "median");
      const how = cadence === "monthly" || cadence === "quarterly" ? `usually bills ${cadence}` : "usually bills regularly";
      const typical = median === null ? "" : ` (median ${formatCompact(median, currency)})`;
      const seen = last === null ? "" : `, last seen ${formatMonth(last)}`;
      return `${name}: no bill this month; ${how}${typical}${seen}`;
    }
    case "pattern.frequency_change": {
      const lines = numberFact(f, "lineCount");
      const usual = numberFact(f, "usualCount");
      const amount = amountFact(f, "amount");
      if (lines === null) return `${name}: more bills than usual this month`;
      const total = amount === null ? "" : ` (${formatFull(amount, currency)} in total)`;
      const was = usual === null ? "" : `; usually ${String(usual)} a month`;
      return `${name}: ${plural(lines, "bill", "bills")} this month${total}${was}`;
    }
    case "pattern.gl_drift": {
      const amount = amountFact(f, "amount");
      const to = textFact(f, "glAccount");
      const usual = textFact(f, "usualGlAccount");
      const usualMonths = numberFact(f, "usualMonths");
      const monthsSeen = numberFact(f, "monthsSeen");
      if (to === null || usual === null) return `${name}: coded to a different account than usual`;
      const money = amount === null ? "" : `${formatFull(amount, currency)} `;
      const share = usualMonths !== null && monthsSeen !== null ? ` (${String(usualMonths)} of ${plural(monthsSeen, "month", "months")})` : "";
      return `${name}: ${money}coded to ${account(to)} this month; usually coded to ${account(usual)}${share}`;
    }
    default:
      return `${name}: unusual against its own history this month`;
  }
}
