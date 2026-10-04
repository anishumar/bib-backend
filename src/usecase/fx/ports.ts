// Ports for the exchange-rate feed (0345, Q009).
import type { CurrencyCode } from "../../domain/money/model";
import type { DailyRates, FxQuote } from "../../domain/fx/model";

/** Somewhere that publishes a day's rates: an HTTP feed in production, a fake
 *  in tests. Null when it has nothing for that day; it throws when it could
 *  not be reached, and the service decides what that means. */
export interface FxRateFeed {
  /** The newest day it has. */
  latest(): Promise<DailyRates | null>;
  /** A past day. Null when it keeps no history (ExchangeRate-API's free
   *  plan) or has none that far back. */
  on(day: string): Promise<DailyRates | null>;
}

/** The product's own copy of the feed, one table for every firm. */
export interface FxRateStore {
  /** Store a day's rates. A day already held is kept as it was (the first
   *  feed to deliver it wins), so this never rewrites history. Answers how
   *  many rows were new. */
  save(rates: DailyRates): Promise<number>;
  /** The rate on the latest day ON OR BEFORE `day` that has both currencies. */
  rateOn(currency: CurrencyCode, reporting: CurrencyCode, day: string): Promise<FxQuote | null>;
  /** The rate on the EARLIEST day after `day`: for a day before the history. */
  rateAfter(currency: CurrencyCode, reporting: CurrencyCode, day: string): Promise<FxQuote | null>;
}

/** The currency a firm keeps its books in. */
export interface ReportingCurrencies {
  reportingCurrency(tenantId: string): Promise<CurrencyCode>;
}
