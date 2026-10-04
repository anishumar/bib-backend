// The exchange-rate feeds (0345, Q009): ExchangeRate-API first, the
// fawazahmed0 Currency API when it fails or has no answer.
//
// Chosen 2026-10-04 (Shrestha), on the free plans' own terms:
//   · ExchangeRate-API, free plan: a key, 1,500 calls a month (this product
//     makes about 30: one a day for every firm), commercial use allowed, no
//     attribution required, daily rates, no history.
//   · Currency API (github.com/fawazahmed0/exchange-api): CC0, no key, daily,
//     with history by date, served from jsDelivr and mirrored on Cloudflare
//     Pages. It also lists crypto and metals, which are filtered out here.
// Open Exchange Rates was dropped: its terms are unclear on business use of
// the free plan.
//
// ── EXACT DIGITS ────────────────────────────────────────────────────────────
//
// Both publish rates as JSON NUMBERS, and `JSON.parse` turns a number into a
// float. A rate is not money, but it multiplies money, so it is read here as
// the TEXT the feed wrote (the reviver's `source`, Node 21+) and stays a
// string to the database's `numeric`.
import type { DailyRates } from "../../domain/fx/model";
import type { FxRateFeed } from "../../usecase/fx/ports";

/** GET a URL and answer its status and body. Injected so tests never touch
 *  the network. */
export type GetText = (url: string) => Promise<{ readonly status: number; readonly body: string }>;

/** Node's fetch with a deadline: the worker and a person's screen both wait on
 *  this, and a feed having a bad day must not hold either indefinitely. */
export function fetchText(timeoutMs: number): GetText {
  return async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: response.status, body: await response.text() };
  };
}

/** A rate as the feed wrote it: digits, maybe a point, maybe an exponent. */
const DECIMAL = /^\d+(\.\d+)?([eE][-+]?\d+)?$/;

/** ISO 4217 codes the runtime knows, so a feed's crypto ("btc") and metals
 *  ("xau" is ISO, kept) never become a "currency" on a document. */
let iso: ReadonlySet<string> | null = null;
function isIsoCurrency(code: string): boolean {
  if (iso === null) {
    try {
      iso = new Set(Intl.supportedValuesOf("currency"));
    } catch {
      iso = new Set();
    }
  }
  return iso.size === 0 ? /^[A-Z]{3}$/.test(code) : iso.has(code);
}

/** JSON with every number kept as the text it was written as. */
export function parseKeepingDigits(body: string): unknown {
  const reviver = (_key: string, value: unknown, context?: { source?: string }): unknown =>
    typeof value === "number" && context?.source !== undefined ? context.source : value;
  return JSON.parse(body, reviver);
}

/** Codes upper-cased, only ISO currencies, only positive decimals; USD is one. */
function ratesFrom(table: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [raw, value] of Object.entries(table)) {
    const code = raw.toUpperCase();
    if (!/^[A-Z]{3}$/.test(code) || !isIsoCurrency(code)) continue;
    if (typeof value !== "string" || !DECIMAL.test(value) || /^0+(\.0+)?([eE].*)?$/.test(value)) continue;
    out.set(code, value);
  }
  out.set("USD", "1");
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** ExchangeRate-API, free plan: `latest` only, against the US dollar. */
export class ExchangeRateApiFeed implements FxRateFeed {
  static readonly SOURCE = "ExchangeRate-API";

  constructor(
    private readonly apiKey: string,
    private readonly get: GetText,
    private readonly base = "https://v6.exchangerate-api.com/v6",
  ) {}

  async latest(): Promise<DailyRates | null> {
    const reply = await this.get(`${this.base}/${encodeURIComponent(this.apiKey)}/latest/USD`);
    if (reply.status !== 200) throw new Error(`ExchangeRate-API answered ${String(reply.status)}`);
    const json = parseKeepingDigits(reply.body);
    if (!isRecord(json) || json["result"] !== "success" || !isRecord(json["conversion_rates"])) {
      const why = isRecord(json) && typeof json["error-type"] === "string" ? json["error-type"] : "an unexpected body";
      throw new Error(`ExchangeRate-API sent ${why}`);
    }
    // The day the rates are FOR, from its own update time (UTC).
    const unix = Number(json["time_last_update_unix"]);
    if (!Number.isFinite(unix)) throw new Error("ExchangeRate-API sent no update time");
    return {
      day: new Date(unix * 1000).toISOString().slice(0, 10),
      source: ExchangeRateApiFeed.SOURCE,
      perUsd: ratesFrom(json["conversion_rates"]),
    };
  }

  /** The free plan keeps no history. */
  on(): Promise<DailyRates | null> {
    return Promise.resolve(null);
  }
}

/** The fawazahmed0 Currency API: latest and any past day, two mirrors. */
export class CurrencyApiFeed implements FxRateFeed {
  static readonly SOURCE = "Currency API";

  constructor(private readonly get: GetText) {}

  latest(): Promise<DailyRates | null> {
    return this.read("latest");
  }

  on(day: string): Promise<DailyRates | null> {
    return this.read(day);
  }

  private async read(version: string): Promise<DailyRates | null> {
    const urls = [
      `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${version}/v1/currencies/usd.json`,
      `https://${version}.currency-api.pages.dev/v1/currencies/usd.json`,
    ];
    let failure: Error | null = null;
    for (const url of urls) {
      try {
        const reply = await this.get(url);
        // No such day on that mirror: the other may still have it.
        if (reply.status === 404) continue;
        if (reply.status !== 200) throw new Error(`Currency API answered ${String(reply.status)}`);
        const json = parseKeepingDigits(reply.body);
        if (!isRecord(json) || typeof json["date"] !== "string" || !isRecord(json["usd"])) {
          throw new Error("Currency API sent an unexpected body");
        }
        return { day: json["date"], source: CurrencyApiFeed.SOURCE, perUsd: ratesFrom(json["usd"]) };
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
      }
    }
    if (failure !== null) throw failure;
    return null;
  }
}

/** Each feed in turn: the first to answer is the answer. Only when every one
 *  throws does this throw, with every reason. */
export class FirstFeedThatAnswers implements FxRateFeed {
  constructor(private readonly feeds: readonly FxRateFeed[]) {}

  latest(): Promise<DailyRates | null> {
    return this.first((f) => f.latest());
  }

  on(day: string): Promise<DailyRates | null> {
    return this.first((f) => f.on(day));
  }

  private async first(ask: (f: FxRateFeed) => Promise<DailyRates | null>): Promise<DailyRates | null> {
    const failures: string[] = [];
    for (const feed of this.feeds) {
      try {
        const rates = await ask(feed);
        if (rates !== null && rates.perUsd.size > 1) return rates;
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (failures.length === this.feeds.length && failures.length > 0) throw new Error(failures.join("; "));
    return null;
  }
}

/** `BIB_FX_FEED=off`: never touches the network, and has nothing to say. */
export class NoFeed implements FxRateFeed {
  latest(): Promise<DailyRates | null> {
    return Promise.resolve(null);
  }

  on(): Promise<DailyRates | null> {
    return Promise.resolve(null);
  }
}
