// In-memory exchange-rate feed and store (0345), for tests. The store divides
// exactly as `fx.rate_on` does: on scaled bigints, rounded half up to ten
// places, never through a JS number.
import type { DailyRates, FxQuote } from "../domain/fx/model";
import type { FxRateFeed, FxRateStore, ReportingCurrencies } from "../usecase/fx/ports";
import { FxService } from "../usecase/fx/service";
import { FakeClock } from "./clock";

/** A feed that answers what a test told it, and counts how often it was asked. */
export class FakeFxFeed implements FxRateFeed {
  latestRates: DailyRates | null = null;
  readonly byDay = new Map<string, DailyRates>();
  /** Throw on every call: a feed that cannot be reached. */
  down = false;
  calls = 0;

  latest(): Promise<DailyRates | null> {
    this.calls += 1;
    if (this.down) return Promise.reject(new Error("feed down"));
    return Promise.resolve(this.latestRates);
  }

  on(day: string): Promise<DailyRates | null> {
    this.calls += 1;
    if (this.down) return Promise.reject(new Error("feed down"));
    return Promise.resolve(this.byDay.get(day) ?? null);
  }
}

const SCALE = 10n ** 20n;

function scaled(v: string): bigint {
  const [whole = "0", fraction = ""] = v.split(".");
  return BigInt(whole) * SCALE + BigInt((fraction + "0".repeat(20)).slice(0, 20));
}

/** round(a / b, 10), half up, as Postgres rounds a positive numeric. */
function divide(a: string, b: string): string {
  const q = (scaled(a) * 10n ** 11n) / scaled(b);
  const rounded = (q + 5n) / 10n;
  const whole = rounded / 10n ** 10n;
  const fraction = (rounded % 10n ** 10n).toString().padStart(10, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole.toString()}.${fraction}`;
}

export class FakeFxRateStore implements FxRateStore, ReportingCurrencies {
  /** `${currency}|${day}` -> per USD and source. */
  readonly rows = new Map<string, { perUsd: string; source: string }>();
  readonly reportingByTenant = new Map<string, string>();

  save(rates: DailyRates): Promise<number> {
    let n = 0;
    for (const [currency, perUsd] of rates.perUsd) {
      const k = `${currency}|${rates.day}`;
      if (this.rows.has(k)) continue;
      this.rows.set(k, { perUsd, source: rates.source });
      n += 1;
    }
    return Promise.resolve(n);
  }

  rateOn(currency: string, reporting: string, day: string): Promise<FxQuote | null> {
    return Promise.resolve(this.pick(currency, reporting, (d) => d <= day, "desc"));
  }

  rateAfter(currency: string, reporting: string, day: string): Promise<FxQuote | null> {
    return Promise.resolve(this.pick(currency, reporting, (d) => d > day, "asc"));
  }

  reportingCurrency(tenantId: string): Promise<string> {
    return Promise.resolve(this.reportingByTenant.get(tenantId) ?? "INR");
  }

  private pick(currency: string, reporting: string, ok: (d: string) => boolean, order: "asc" | "desc"): FxQuote | null {
    const days = [...this.rows.keys()]
      .filter((k) => k.startsWith(`${currency}|`))
      .map((k) => k.slice(4))
      .filter((d) => ok(d) && this.rows.has(`${reporting}|${d}`))
      .sort();
    const day = order === "desc" ? days[days.length - 1] : days[0];
    if (day === undefined) return null;
    const c = this.rows.get(`${currency}|${day}`);
    const r = this.rows.get(`${reporting}|${day}`);
    if (c === undefined || r === undefined) return null;
    return { currency, reporting, fxRate: divide(r.perUsd, c.perUsd), fxRateDate: day, source: c.source };
  }
}

/** A day's rates for a test: units per US dollar. */
export function dailyRates(day: string, perUsd: Record<string, string>, source = "Currency API"): DailyRates {
  return { day, source, perUsd: new Map([["USD", "1"], ...Object.entries(perUsd)]) };
}

export function makeFxFakes(now = new Date("2026-10-04T08:00:00.000Z")) {
  const feed = new FakeFxFeed();
  const store = new FakeFxRateStore();
  const clock = new FakeClock(now);
  return { feed, store, clock, service: new FxService({ feed, rates: store, reporting: store, clock }) };
}
