// The exchange-rate feed (0345, Q009) — no I/O of its own; the feed and the
// store arrive as ports.
//
// ── WHY A READ-THROUGH, AND WHY THE WORKER AS WELL ─────────────────────────
//
// The worker fetches the newest day once a day, before the firm's working day
// starts, so a person asking for a rate is answered from the table and never
// waits on the internet. But a fresh database, a feed that was down at 07:00,
// or a day in the past (a client imported with a letter signed in 2025) is
// asked of the feed at the moment it is needed, stored, and served. Either way
// the feed is called once per DAY for the whole product, not once per firm or
// per request.
//
// A feed that cannot be reached is never an error a person sees: the latest
// rate already held is the answer, and its own date says how old it is. A
// failure is remembered for a few minutes, so a feed that is down is not asked
// again by every screen that opens meanwhile.
import { addDays, isFreshFor, SAME_CURRENCY_SOURCE } from "../../domain/fx/model";
import type { DailyRates, FxQuote } from "../../domain/fx/model";
import { isCurrencyCode, normalizeCurrency } from "../../domain/money/model";
import type { Clock } from "../../platform/clock";
import type { FxRateFeed, FxRateStore, ReportingCurrencies } from "./ports";

export interface Deps {
  readonly feed: FxRateFeed;
  readonly rates: FxRateStore;
  readonly reporting: ReportingCurrencies;
  readonly clock: Clock;
}

/** How long a feed that failed is left alone before it is asked again. */
const RETRY_AFTER_MS = 10 * 60 * 1000;

export interface FxRefreshReport {
  /** The day the feed delivered, or null when it delivered nothing. */
  readonly day: string | null;
  readonly source: string | null;
  /** Rows that were new: zero when that day was already held. */
  readonly saved: number;
  readonly failure?: string;
}

export class FxService {
  /** What failed recently, by "latest" or the day asked, and when. */
  private readonly failedAt = new Map<string, number>();

  constructor(private readonly deps: Deps) {}

  /** The worker's daily run: fetch the newest day, keep it. */
  async refresh(): Promise<FxRefreshReport> {
    try {
      const rates = await this.deps.feed.latest();
      if (rates === null) return { day: null, source: null, saved: 0 };
      return { day: rates.day, source: rates.source, saved: await this.deps.rates.save(rates) };
    } catch (err) {
      return { day: null, source: null, saved: 0, failure: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * What one unit of `currency` is worth in the firm's own currency on `on`
   * (the caller's day): the suggestion a document's rate box shows, and the
   * rate an import strikes a letter at. Null only when no rate for the pair
   * is held at all and the feed could not supply one.
   */
  async quote(tenantId: string, currency: string, on: string): Promise<FxQuote | null> {
    return this.quotePair(currency, await this.deps.reporting.reportingCurrency(tenantId), on);
  }

  async quotePair(rawCurrency: string, reporting: string, on: string): Promise<FxQuote | null> {
    const currency = normalizeCurrency(rawCurrency);
    if (!isCurrencyCode(currency)) return null;
    if (currency === reporting) {
      return { currency, reporting, fxRate: "1", fxRateDate: on, source: SAME_CURRENCY_SOURCE };
    }
    // Never a rate from the future: a day after the feed's own today is
    // answered with today's.
    const today = this.deps.clock.now().toISOString().slice(0, 10);
    const day = on > today ? today : on;

    const held = await this.deps.rates.rateOn(currency, reporting, day);
    if (held !== null && isFreshFor(held.fxRateDate, day)) return held;

    // Nothing recent enough on file: ask the feed for that day, once.
    const recent = day >= addDays(today, -1);
    const fetched = await this.fetchOnce(recent ? "latest" : day, () =>
      recent ? this.deps.feed.latest() : this.deps.feed.on(day),
    );
    if (fetched !== null) {
      await this.deps.rates.save(fetched);
      const now = await this.deps.rates.rateOn(currency, reporting, day);
      if (now !== null) return now;
    }
    return held ?? (await this.deps.rates.rateAfter(currency, reporting, day));
  }

  private async fetchOnce(key: string, call: () => Promise<DailyRates | null>): Promise<DailyRates | null> {
    const failed = this.failedAt.get(key);
    if (failed !== undefined && this.deps.clock.now().getTime() - failed < RETRY_AFTER_MS) return null;
    try {
      const rates = await call();
      this.failedAt.delete(key);
      return rates;
    } catch {
      this.failedAt.set(key, this.deps.clock.now().getTime());
      return null;
    }
  }
}
