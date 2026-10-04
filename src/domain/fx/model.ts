// Exchange rates from a feed (0345, Q009). Nouns and pure rules only.
//
// A document's rate is the record (0344): what a client was quoted at, or
// signed at, does not move. What this domain adds is the day's rate a feed
// publishes, used two ways and only two: as the SUGGESTION a person sees when
// a document needs a rate, and to value a report "at today's rate" beside the
// rate the document was struck at. That is what Zoho Books, Xero, QuickBooks
// and NetSuite do with their feeds too.
import type { Amount, CurrencyCode } from "../money/model";

/** One day's rates as a feed publishes them: units of each currency for ONE
 *  US dollar, as decimal strings exactly as the feed wrote them. */
export interface DailyRates {
  /** The day the feed says the rates are for (UTC), `YYYY-MM-DD`. */
  readonly day: string;
  /** Who published them: "ExchangeRate-API", "Currency API". */
  readonly source: string;
  readonly perUsd: ReadonlyMap<CurrencyCode, string>;
}

/** What one unit of `currency` is worth in `reporting`, on a day. */
export interface FxQuote {
  readonly currency: CurrencyCode;
  readonly reporting: CurrencyCode;
  /** Ten decimal places at most, the scale of a document's rate. */
  readonly fxRate: Amount;
  /** The day of the rate actually used, which may be earlier than the day
   *  asked for (a weekend, a feed that was down), or later (before the feed's
   *  history begins). Always shown beside the rate, so nobody mistakes it. */
  readonly fxRateDate: string;
  readonly source: string;
}

/** The answer for a currency against itself: one, by definition. */
export const SAME_CURRENCY_SOURCE = "Same currency";

/** A calendar day `n` days from `day`, both `YYYY-MM-DD`. */
export function addDays(day: string, n: number): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Whether a stored rate is recent enough for `day` that asking the feed again
 * would be wasted: the feed publishes once a day, so the day itself or the one
 * before it is as fresh as a rate gets.
 */
export function isFreshFor(rateDay: string, day: string): boolean {
  return rateDay >= addDays(day, -1);
}
