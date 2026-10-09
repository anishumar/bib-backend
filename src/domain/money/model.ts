// Money primitives. Money is amount + currency + FX rate + rate date, stored as
// `numeric`, never a float. A firm's reporting currency (0009) is what every rate
// converts TO. Since 0344 a document's rate is per CURRENCY: its head holds the
// main currency's, a `CurrencyRate` row each other one's.

/**
 * An ISO 4217 code, uppercase ("INR"). Not a closed list, so a new currency needs
 * no deploy (whether an FX source quotes it is the adapter's question); still
 * validated, so "inr", "Rs" or "" never reach the database and split a firm's totals.
 */
export type CurrencyCode = string;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Call on the NORMALISED string: `normalizeCurrency` first. */
export function isCurrencyCode(v: string): boolean {
  return CURRENCY_PATTERN.test(v);
}

/** Trimmed, uppercase: "inr" and "INR" differ to Postgres and would split a total
 *  grouped by currency. Normalise at the boundary, as tenancy does with email. */
export function normalizeCurrency(raw: string): CurrencyCode {
  return raw.trim().toUpperCase();
}

/**
 * A decimal STRING ("1499.50"): a float cannot hold 1499.50 exactly, and only the
 * database adds amounts up. Stored as written, not reformatted: rewriting "1499.5"
 * in a frozen config body would edit something published.
 */
export type Amount = string;

/** Four: minor units run 0 (JPY) to 3 (KWD, BHD), and unit rates (per page) need a fourth. */
export const MAX_AMOUNT_SCALE = 4;

const AMOUNT_PATTERN = /^\d{1,15}(?:\.\d{1,4})?$/;

/** Non-negative on purpose: this validates PRICES; a "-500" list price would make a
 *  discount representable in two places. */
export function isAmount(v: string): boolean {
  return AMOUNT_PATTERN.test(v);
}

/**
 * Ten, not four: `fx_rate` is `numeric(20,10)` (since 0011) on a proposal, letter and
 * invoice, and Postgres prints it at full scale ("1.0000000000"), so validating a rate
 * with `isAmount` refused a stored rate fed back into a write (first hit by T3.5b,
 * quote to letter). Four places also loses real money on JPY->INR (0.5567).
 */
export const MAX_RATE_SCALE = 10;

const RATE_PATTERN = /^\d{1,10}(?:\.\d{1,10})?$/;

/** Positivity is checked by the callers, with its own message. */
export function isExchangeRate(v: string): boolean {
  return RATE_PATTERN.test(v);
}


const SIGNED_AMOUNT_PATTERN = /^-?\d{1,15}(?:\.\d{1,4})?$/;

/** An amount that MAY be negative: use ONLY where a negative is a business fact, e.g. a
 *  payment reversal (see `Payment` in domain/invoice/model.ts). Prices use `isAmount`. */
export function isSignedAmount(v: string): boolean {
  return SIGNED_AMOUNT_PATTERN.test(v);
}

/**
 * Compare two decimal strings EXACTLY (-1/0/1), as BigInt at a common scale, never a
 * `number`. The credit-note cap once used `Number(a) - Number(b)`: 100.10 - 100.00 is
 * 0.0999... in floating point, refusing the last 0.10 of a valid credit. Postgres does
 * SUMs; this compares a value the caller just sent against one already computed.
 */
export function compareAmounts(a: Amount, b: Amount): -1 | 0 | 1 {
  const [ai, af] = splitDecimal(a);
  const [bi, bf] = splitDecimal(b);
  const scale = Math.max(af.length, bf.length);
  const left = BigInt(ai + af.padEnd(scale, "0"));
  const right = BigInt(bi + bf.padEnd(scale, "0"));
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** `a - b` exactly, at the wider scale. Trailing zeros kept: it prints in a refusal and
 *  should match the invoice screen ("at most 0.1000"). */
export function subtractAmounts(a: Amount, b: Amount): string {
  const [ai, af] = splitDecimal(a);
  const [bi, bf] = splitDecimal(b);
  const scale = Math.max(af.length, bf.length);
  const difference = BigInt(ai + af.padEnd(scale, "0")) - BigInt(bi + bf.padEnd(scale, "0"));
  const negative = difference < 0n;
  const digits = (negative ? -difference : difference).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale === 0 ? "" : `.${digits.slice(digits.length - scale)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/** (signed integer part, fraction digits). Tolerates Postgres's full-scale print
 *  ("1.0000", "1.0000000000"). */
function splitDecimal(value: string): [string, string] {
  const trimmed = value.trim();
  const dot = trimmed.indexOf(".");
  if (dot === -1) return [trimmed === "" ? "0" : trimmed, ""];
  const whole = trimmed.slice(0, dot);
  return [whole === "" || whole === "-" ? `${whole}0` : whole, trimmed.slice(dot + 1)];
}

/** One type, never two loose fields: neither half means anything alone. */
export interface Money {
  readonly amount: Amount;
  readonly currency: CurrencyCode;
}

/** The rate of one OTHER currency a document's lines or groups use (0344): reporting-
 *  currency units per unit of `currency` as of `fxRateDate`, frozen with the document.
 *  The MAIN currency's rate sits on the document's head. */
export interface CurrencyRate {
  readonly currency: CurrencyCode;
  readonly fxRate: Amount;
  readonly fxRateDate: string;
  /** "typed" when a person entered it; otherwise the rate service's name. */
  readonly source: string;
}

/** The head's rate for the main currency, a rate row's for any other; null when none
 *  (0344's invariant refuses that for a live line's or group's currency). */
export function rateFor(
  doc: { readonly currency: CurrencyCode; readonly fxRate: Amount; readonly fxRateDate: string; readonly rates: readonly CurrencyRate[] },
  currency: CurrencyCode,
): { readonly fxRate: Amount; readonly fxRateDate: string } | null {
  if (currency === doc.currency) return { fxRate: doc.fxRate, fxRateDate: doc.fxRateDate };
  return doc.rates.find((r) => r.currency === currency) ?? null;
}

/** Why a typed amount (0, -5, 120%) was refused, in the person's words, not the wire
 *  format's (audit 2026-10-03, F12). */
export function amountProblem(
  label: string,
  given: string,
  opts: { readonly percent?: boolean; readonly places?: number } = {},
): string {
  const trimmed = given.trim();
  const looksNumeric = /^-?\d+(?:\.\d+)?$/.test(trimmed);
  const places = opts.places ?? MAX_AMOUNT_SCALE;
  if (looksNumeric) {
    const decimals = trimmed.split(".")[1]?.length ?? 0;
    if (/^-?0+(?:\.0+)?$/.test(trimmed)) return `${label} cannot be 0.`;
    if (trimmed.startsWith("-")) return `${label} cannot be less than 0.`;
    if (opts.percent === true && Number(trimmed) > 100) return `${label} cannot be more than 100%.`;
    if (decimals <= places) return `${label} cannot be ${trimmed}.`;
  }
  return (
    `${label} ${JSON.stringify(given)} is not a number. Use digits, with up to ${String(places)} ` +
    `decimal places, e.g. 1499.50.`
  );
}

/** As screens write it: INR in lakhs ("INR 1,18,000"), others in thousands, no ".00" on a
 *  whole amount. Grouped by hand: a small-ICU Node answers `en-IN` as en-US. Intl formats
 *  the decimal string exactly, never a JS number. */
export function displayMoney(amount: string, currency: string): string {
  const whole = /^-?\d+(\.0+)?$/.test(amount);
  const western = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(amount as unknown as number);
  if (currency !== "INR") return `${currency} ${western}`;
  const negative = western.startsWith("-");
  const [integer = "", fraction] = (negative ? western.slice(1) : western).split(".");
  const digits = integer.replace(/,/g, "");
  const last = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const pairs = rest.length === 0 ? [] : (rest.match(/(\d{1,2})(?=(\d{2})*$)/g) ?? []);
  return `INR ${negative ? "-" : ""}${[...pairs, last].join(",")}${fraction === undefined ? "" : `.${fraction}`}`;
}
