// Money — the primitives every priced thing in the product is built from.
// Pure, stdlib only, like every domain module.
//
// It starts with the currency CODE alone, because that is what the schema
// needed first: a firm's reporting currency (migration 0009) has to exist
// before any amount does, since an FX rate stored without knowing what it
// converts TO is not a fact. Amounts, rates and the composite Money value join
// it with T2.2, when there is a priced line to model them against.
//
// CLAUDE.md's rule for this area, restated here because this is where it will
// be enforced: money is amount + currency + FX rate + rate date, stored as
// `numeric`, never a float.

/**
 * An ISO 4217 alphabetic code, uppercase: "INR", "AED", "SGD".
 *
 * A plain string alias rather than an enum or a closed list, and both halves of
 * that are deliberate:
 *
 *   not a list — onboarding a firm that bills in a currency we have not seen
 *   before must not require a deploy. The check that would actually be worth
 *   making is whether an FX source quotes the pair, and that is a question for
 *   an adapter at the moment of conversion, not for the domain.
 *
 *   still validated — three uppercase letters, so "inr", "Rs" and "" cannot
 *   reach the database, where they would compare unequal to the real code and
 *   quietly split a firm's totals in two.
 */
export type CurrencyCode = string;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Whether a value is a well-formed currency code. Call it on the NORMALISED
 *  string — `normalizeCurrency` first, then this. */
export function isCurrencyCode(v: string): boolean {
  return CURRENCY_PATTERN.test(v);
}

/**
 * The form a currency code is stored and compared in: trimmed, uppercase.
 *
 * Comparison is the reason. "inr" and "INR" are the same currency to a person
 * and two different strings to Postgres, so a total grouped by currency would
 * split silently. Normalise at the boundary, exactly as tenancy does with
 * email, and everything downstream compares plain strings safely.
 */
export function normalizeCurrency(raw: string): CurrencyCode {
  return raw.trim().toUpperCase();
}

/**
 * An amount, as a decimal STRING: "25000", "1499.50", "0".
 *
 * A string because the alternative is a float, and a float cannot hold 1499.50
 * exactly — the error is invisible in one line and material in a total. Postgres
 * `numeric` and this string are the same value; a JavaScript `number` in between
 * is where the precision goes. So amounts arrive as strings, are stored as
 * strings or `numeric`, and are only ever added up by the database.
 *
 * Stored as written rather than reformatted: "1499.5" and "1499.50" are the same
 * price, and rewriting one into the other in a frozen config body would be an
 * edit to something published.
 */
export type Amount = string;

/** Four, not two. Minor units run from 0 (JPY) to 3 (KWD, BHD), and unit rates
 *  — a per-page or per-transaction charge — routinely need a fourth. */
export const MAX_AMOUNT_SCALE = 4;

const AMOUNT_PATTERN = /^\d{1,15}(?:\.\d{1,4})?$/;

/**
 * Whether a string is an amount this product will store.
 *
 * Non-negative on purpose: this validates PRICES. A credit or an adjustment is a
 * different thing with its own sign and its own reason, and letting "-500" pass
 * as a list price would make a discount representable in two places.
 */
export function isAmount(v: string): boolean {
  return AMOUNT_PATTERN.test(v);
}

/**
 * The scale an EXCHANGE RATE is stored at — ten, not four.
 *
 * ── AND THE BUG THIS EXISTS TO END ────────────────────────────────────────
 *
 * `fx_rate` is `numeric(20,10)` on a proposal, an engagement letter and an
 * invoice, and every one of those routes validated it with `isAmount`, which
 * allows FOUR. So the API refused a value its own database had just handed
 * back: Postgres prints a `numeric(20,10)` at full scale, so a rate stored as
 * "1" reads as "1.0000000000" and re-submitting it answered *"must be a
 * non-negative decimal STRING with at most four decimal places"*.
 *
 * It never bit while every rate was typed by a person, because a person could
 * only ever type four. Writing a quote up as a letter (T3.5b) is the first
 * thing in this product that feeds a STORED rate back into a write, and it
 * failed on the first real click.
 *
 * A rate is not a price and four places is a PRICE's rule — minor units run
 * from 0 to 3, and a unit charge wants a fourth. A rate genuinely needs more:
 * JPY→INR is 0.5567 to four places and loses real money on a large invoice.
 * The column has said ten since 0011; this makes the door as wide as the room.
 */
export const MAX_RATE_SCALE = 10;

const RATE_PATTERN = /^\d{1,10}(?:\.\d{1,10})?$/;

/**
 * Whether a string is an exchange rate this product will store.
 *
 * Positivity is NOT checked here — the callers do it, because "must be greater
 * than zero" is a different sentence from "is not a decimal string" and each
 * deserves its own. Same shape as `isAmount` above it.
 */
export function isExchangeRate(v: string): boolean {
  return RATE_PATTERN.test(v);
}


const SIGNED_AMOUNT_PATTERN = /^-?\d{1,15}(?:\.\d{1,4})?$/;

/**
 * Whether a string is an amount that MAY be negative.
 *
 * The narrower `isAmount` above validates PRICES and is right to refuse a minus
 * sign — a list price of "-500" would make a discount representable in two
 * places. But a PAYMENT is signed, and deliberately: a bounced cheque or a
 * reversed transfer is a negative payment with its own date and its own reason,
 * two rows that tell the story, rather than the original row edited into
 * something that never happened. `bib_app` holds no DELETE grant, so a signed
 * amount is the only honest way to express a reversal.
 *
 * Use this ONLY where a negative is a real business fact. Anywhere it is not,
 * `isAmount` is the check, and the difference between the two functions is the
 * decision about which of the two a field is.
 */
export function isSignedAmount(v: string): boolean {
  return SIGNED_AMOUNT_PATTERN.test(v);
}

/**
 * Compare two decimal strings EXACTLY. -1, 0 or 1, like every comparator.
 *
 * -- WHY THIS EXISTS AND WHY IT IS NOT `Number(a) - Number(b)` ---------------
 *
 * The credit-note cap — the one check in the product that decides whether money
 * may leave — was written as `Number(balance.invoiced) - Number(balance.credited)`
 * and compared against `Number(input.amount)`. That is the exact thing this
 * module's own header forbids, on the one calculation where it matters most.
 * The failure is not theoretical: an invoice of 100.10 with 100.00 credited
 * leaves 0.10, and in binary floating point `100.10 - 100.00` is
 * 0.09999999999999432, so the last ten paise of a legitimate credit note were
 * refused with a message printing "0.1000".
 *
 * So the comparison is done on the digits. Both sides are padded to the same
 * scale and compared as BigInt, which is exact for any value these patterns
 * admit — fifteen integer digits and four decimal places is far inside what
 * BigInt holds — and no intermediate is ever a `number`.
 *
 * Postgres would answer this too, in `numeric`, and for a SUM it must. This is
 * for the case the database cannot answer alone: comparing a value the caller
 * just sent against one it has already computed.
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

/**
 * `a - b`, exactly, as a decimal string at the wider of the two scales.
 *
 * Trailing zeros are kept rather than trimmed: the result of this is printed in
 * a refusal ("you may credit at most X"), and 0.1000 and 0.1 are the same
 * number but "at most 0.1000" is the one that matches what the invoice screen
 * already shows.
 */
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

/**
 * A decimal string as (integer part with its sign, fractional digits).
 *
 * Deliberately tolerant of what Postgres hands back: `numeric` prints at the
 * column's full scale, so an amount stored as 1 reads as "1.0000" and a rate as
 * "1.0000000000". Neither is a different number and neither should take a
 * different code path.
 */
function splitDecimal(value: string): [string, string] {
  const trimmed = value.trim();
  const dot = trimmed.indexOf(".");
  if (dot === -1) return [trimmed === "" ? "0" : trimmed, ""];
  const whole = trimmed.slice(0, dot);
  return [whole === "" || whole === "-" ? `${whole}0` : whole, trimmed.slice(dot + 1)];
}

/** An amount and what it is denominated in. Neither half means anything alone —
 *  which is why they are one type and never two loose fields. */
export interface Money {
  readonly amount: Amount;
  readonly currency: CurrencyCode;
}
