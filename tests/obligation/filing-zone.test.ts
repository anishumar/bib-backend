// Whose clock a filing is judged on (Q070 Part B, B1): the order, and the day.
import { describe, expect, it } from "vitest";
import {
  filingCountryZone,
  filingCountryZones,
  filingDay,
  filingZone,
} from "../../src/domain/obligation/filing-zone";

const firm = { firmZone: "Asia/Kolkata", firmCompanyZone: null, entityZone: null };

describe("the zone a filing's day is read in", () => {
  it("is the client entity's own zone first (the US taxpayer's-zone rule)", () => {
    expect(filingZone({ ...firm, jurisdiction: "US", entityZone: "America/Los_Angeles" })).toBe(
      "America/Los_Angeles",
    );
  });

  it("else the filing country's one zone, and New York for the United States", () => {
    expect(filingZone({ ...firm, jurisdiction: "AE" })).toBe("Asia/Dubai");
    expect(filingZone({ ...firm, jurisdiction: "SG" })).toBe("Asia/Singapore");
    expect(filingZone({ ...firm, jurisdiction: "IN" })).toBe("Asia/Kolkata");
    expect(filingZone({ ...firm, jurisdiction: "US" })).toBe("America/New_York");
  });

  it("else the firm's company in that country, else the firm's", () => {
    // Australia keeps several zones and has no fallback.
    expect(filingZone({ ...firm, jurisdiction: "AU", firmCompanyZone: "Australia/Sydney" })).toBe(
      "Australia/Sydney",
    );
    expect(filingZone({ ...firm, jurisdiction: "AU" })).toBe("Asia/Kolkata");
  });

  it("has one table for SQL, holding every single-zone country and the fallbacks", () => {
    const zones = filingCountryZones();
    expect(zones["AE"]).toBe("Asia/Dubai");
    expect(zones["US"]).toBe("America/New_York");
    expect(zones["AU"]).toBeUndefined();
    expect(filingCountryZone("us")).toBe("America/New_York");
    // Safe to inline as a SQL literal: zone names and country codes only.
    for (const [k, v] of Object.entries(zones)) {
      expect(k).toMatch(/^[A-Z]{2}$/);
      expect(v).toMatch(/^[A-Za-z0-9/_+-]+$/);
    }
  });
});

describe("the filing's day, from the firm's day at an instant", () => {
  it("is the firm's day when the zones agree", () => {
    expect(filingDay("2026-10-29", "2026-10-28T19:00:00Z", "Asia/Kolkata", "Asia/Kolkata")).toBe("2026-10-29");
  });

  it("is a day behind west of the firm, and a day ahead east of it, near midnight", () => {
    // 00:30 in India is 23:00 the day before in Dubai.
    expect(filingDay("2026-10-29", "2026-10-28T19:00:00Z", "Asia/Dubai", "Asia/Kolkata")).toBe("2026-10-28");
    // 22:30 in India is 01:00 the next day in Singapore.
    expect(filingDay("2026-10-28", "2026-10-28T17:00:00Z", "Asia/Singapore", "Asia/Kolkata")).toBe("2026-10-29");
    // Mid-afternoon everywhere agrees.
    expect(filingDay("2026-10-28", "2026-10-28T09:00:00Z", "Asia/Dubai", "Asia/Kolkata")).toBe("2026-10-28");
  });

  it("keeps a replayed day: the shift moves the day the caller named", () => {
    expect(filingDay("2026-11-05", "2026-10-28T19:00:00Z", "Asia/Dubai", "Asia/Kolkata")).toBe("2026-11-04");
  });
});
