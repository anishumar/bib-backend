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

/** An amount and what it is denominated in. Neither half means anything alone —
 *  which is why they are one type and never two loose fields. */
export interface Money {
  readonly amount: Amount;
  readonly currency: CurrencyCode;
}
