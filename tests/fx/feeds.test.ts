// 0345 · the two feeds, against canned bodies: the digits stay as written,
// crypto never becomes a currency, a mirror covers for the other.
import { describe, expect, it } from "vitest";
import {
  CurrencyApiFeed,
  ExchangeRateApiFeed,
  FirstFeedThatAnswers,
  parseKeepingDigits,
} from "../../src/infrastructure/fx/feeds";
import type { GetText } from "../../src/infrastructure/fx/feeds";

const replies =
  (map: Record<string, { status: number; body: string } | Error>): GetText & { asked: string[] } => {
    const asked: string[] = [];
    const get = (url: string) => {
      asked.push(url);
      const hit = Object.entries(map).find(([k]) => url.includes(k))?.[1];
      if (hit === undefined) return Promise.resolve({ status: 404, body: "" });
      return hit instanceof Error ? Promise.reject(hit) : Promise.resolve(hit);
    };
    return Object.assign(get, { asked });
  };

describe("reading a feed's numbers", () => {
  it("keeps every digit the feed wrote, never a float", () => {
    expect(parseKeepingDigits('{"a": 22.701234567890123456, "b": 1e-7}')).toEqual({ a: "22.701234567890123456", b: "1e-7" });
  });
});

describe("ExchangeRate-API", () => {
  it("reads the day from its own update time and the rates against the dollar", async () => {
    const get = replies({
      "/latest/USD": {
        status: 200,
        body: '{"result":"success","time_last_update_unix":1759536001,"base_code":"USD","conversion_rates":{"USD":1,"INR":88.7512,"AED":3.6725}}',
      },
    });
    const rates = await new ExchangeRateApiFeed("k3y", get).latest();
    expect(rates?.day).toBe("2025-10-04");
    expect(rates?.source).toBe("ExchangeRate-API");
    expect(Object.fromEntries(rates?.perUsd ?? [])).toEqual({ USD: "1", INR: "88.7512", AED: "3.6725" });
    expect(get.asked[0]).toContain("/k3y/latest/USD");
  });

  it("throws its own error type on a refused key, so the next feed is tried", async () => {
    const get = replies({ "/latest/USD": { status: 200, body: '{"result":"error","error-type":"invalid-key"}' } });
    await expect(new ExchangeRateApiFeed("bad", get).latest()).rejects.toThrow(/invalid-key/);
  });
});

describe("the Currency API", () => {
  it("keeps ISO currencies only, upper-cased", async () => {
    const get = replies({
      "currency-api@latest": { status: 200, body: '{"date":"2026-10-04","usd":{"inr":88.75,"aed":3.6725,"btc":0.0000083,"1inch":3.2}}' },
    });
    const rates = await new CurrencyApiFeed(get).latest();
    expect(rates?.day).toBe("2026-10-04");
    expect(Object.fromEntries(rates?.perUsd ?? [])).toEqual({ INR: "88.75", AED: "3.6725", USD: "1" });
  });

  it("tries the second mirror when the first fails, and asks for the day by date", async () => {
    const get = replies({
      "cdn.jsdelivr.net": new Error("timeout"),
      "2025-04-01.currency-api.pages.dev": { status: 200, body: '{"date":"2025-04-01","usd":{"inr":85.5}}' },
    });
    const rates = await new CurrencyApiFeed(get).on("2025-04-01");
    expect(rates?.perUsd.get("INR")).toBe("85.5");
    expect(get.asked).toHaveLength(2);
  });

  it("answers null for a day neither mirror has", async () => {
    expect(await new CurrencyApiFeed(replies({})).on("2001-01-01")).toBeNull();
  });
});

describe("the first feed that answers", () => {
  it("falls through a feed that fails or has no history", async () => {
    const primary = new ExchangeRateApiFeed("k", replies({ "/latest/USD": new Error("down") }));
    const fallback = new CurrencyApiFeed(
      replies({ "currency-api@latest": { status: 200, body: '{"date":"2026-10-04","usd":{"inr":88}}' } }),
    );
    const feed = new FirstFeedThatAnswers([primary, fallback]);
    expect((await feed.latest())?.source).toBe("Currency API");
    expect(await feed.on("2026-01-01")).toBeNull();
  });

  it("throws only when every feed failed, naming each", async () => {
    const feed = new FirstFeedThatAnswers([
      new ExchangeRateApiFeed("k", replies({ "/latest/USD": new Error("one") })),
      new CurrencyApiFeed(replies({ jsdelivr: new Error("two"), "pages.dev": new Error("three") })),
    ]);
    await expect(feed.latest()).rejects.toThrow(/one.*three/);
  });
});
