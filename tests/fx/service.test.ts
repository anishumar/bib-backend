// 0345 · the day's exchange rate: a read-through over the product's own
// table, the feed asked once and only when nothing recent is held.
import { describe, expect, it } from "vitest";
import { dailyRates, makeFxFakes } from "../../src/testfakes/fx";

const TENANT = "00000000-0000-0000-0000-0000000000aa";

describe("quoting a rate", () => {
  it("divides two rows of the same day exactly, to ten places", async () => {
    const f = makeFxFakes();
    await f.store.save(dailyRates("2026-10-04", { INR: "88.7512", AED: "3.6725" }));
    const q = await f.service.quote(TENANT, "aed", "2026-10-04");
    expect(q).toEqual({ currency: "AED", reporting: "INR", fxRate: "24.1664261402", fxRateDate: "2026-10-04", source: "Currency API" });
    expect(f.feed.calls).toBe(0);
  });

  it("answers one for the firm's own currency, without a table", async () => {
    const f = makeFxFakes();
    expect(await f.service.quote(TENANT, "INR", "2026-10-04")).toMatchObject({ fxRate: "1", source: "Same currency" });
    expect(f.feed.calls).toBe(0);
  });

  it("asks the feed once when nothing recent is held, and keeps what it said", async () => {
    const f = makeFxFakes();
    f.feed.latestRates = dailyRates("2026-10-04", { INR: "88", AED: "4" }, "ExchangeRate-API");
    expect((await f.service.quote(TENANT, "AED", "2026-10-04"))?.fxRate).toBe("22");
    expect(await f.service.quote(TENANT, "AED", "2026-10-04")).toMatchObject({ source: "ExchangeRate-API" });
    expect(f.feed.calls).toBe(1);
  });

  it("asks the feed for a past day, and never for a day after today", async () => {
    const f = makeFxFakes();
    f.feed.byDay.set("2025-04-01", dailyRates("2025-04-01", { INR: "85", AED: "3.4" }));
    expect(await f.service.quote(TENANT, "AED", "2025-04-01")).toMatchObject({ fxRate: "25", fxRateDate: "2025-04-01" });
    f.feed.latestRates = dailyRates("2026-10-04", { INR: "88", AED: "4" });
    expect(await f.service.quote(TENANT, "AED", "2027-01-01")).toMatchObject({ fxRateDate: "2026-10-04" });
  });

  it("falls back to the latest rate held when the feed is down, and leaves the feed alone a while", async () => {
    const f = makeFxFakes();
    await f.store.save(dailyRates("2026-09-30", { INR: "88", AED: "4" }));
    f.feed.down = true;
    expect(await f.service.quote(TENANT, "AED", "2026-10-04")).toMatchObject({ fxRate: "22", fxRateDate: "2026-09-30" });
    await f.service.quote(TENANT, "AED", "2026-10-04");
    expect(f.feed.calls).toBe(1);
  });

  it("answers the earliest rate after a day before the history begins", async () => {
    const f = makeFxFakes();
    await f.store.save(dailyRates("2024-03-02", { INR: "83", AED: "3.6725" }));
    expect(await f.service.quote(TENANT, "AED", "2019-04-01")).toMatchObject({ fxRateDate: "2024-03-02" });
  });

  it("answers null for a pair nobody publishes, and for a code that is not one", async () => {
    const f = makeFxFakes();
    expect(await f.service.quote(TENANT, "AED", "2026-10-04")).toBeNull();
    expect(await f.service.quote(TENANT, "dirham", "2026-10-04")).toBeNull();
  });
});

describe("the daily refresh", () => {
  it("keeps the feed's newest day, and a second run adds nothing", async () => {
    const f = makeFxFakes();
    f.feed.latestRates = dailyRates("2026-10-04", { INR: "88", AED: "4" });
    expect(await f.service.refresh()).toEqual({ day: "2026-10-04", source: "Currency API", saved: 3 });
    expect((await f.service.refresh()).saved).toBe(0);
  });

  it("reports a feed that is down instead of throwing", async () => {
    const f = makeFxFakes();
    f.feed.down = true;
    expect(await f.service.refresh()).toMatchObject({ day: null, saved: 0, failure: "feed down" });
  });
});
