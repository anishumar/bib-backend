// The two zone conversions the per-period spawn needs (T6.13), measured
// against real zones rather than reasoned about.
//
// Every case here is a day bug this product has already had, or its mirror.
// Kolkata is the firm this was built for; New York is the entity it has on the
// other side of Greenwich; the DST case is the one a single-pass offset
// calculation gets wrong once a year, silently.
import { describe, expect, it } from "vitest";
import { dayInZone, isCallersToday, startOfDayInZone } from "../../src/domain/scheduler/zone";

describe("the instant a firm's day begins", () => {
  it("is the previous evening in UTC for a firm east of Greenwich", () => {
    // September's books open when OCTOBER starts for the firm — 18:30 UTC on
    // the 30th, not midnight UTC on the 1st, which would be five and a half
    // hours late in Kolkata.
    expect(startOfDayInZone("2026-10-01", "Asia/Kolkata")).toBe("2026-09-30T18:30:00.000Z");
  });

  it("is midnight UTC for a firm on UTC", () => {
    expect(startOfDayInZone("2026-10-01", "UTC")).toBe("2026-10-01T00:00:00.000Z");
  });

  it("is the same morning, later, for a firm west of Greenwich", () => {
    // 1 November 2026 is the day US daylight time ends, at 02:00 local. At
    // midnight it is still in force, so the offset is -4 and not -5 — the case
    // a one-pass calculation reads from the wrong side of the transition.
    expect(startOfDayInZone("2026-11-01", "America/New_York")).toBe("2026-11-01T04:00:00.000Z");
    expect(startOfDayInZone("2026-11-02", "America/New_York")).toBe("2026-11-02T05:00:00.000Z");
  });

  it("refuses a value that is not a calendar day", () => {
    expect(() => startOfDayInZone("2026-10-01T00:00:00Z", "UTC")).toThrow(RangeError);
    expect(() => startOfDayInZone("October 1", "UTC")).toThrow(RangeError);
  });

  it("refuses a zone the runtime does not know", () => {
    expect(() => startOfDayInZone("2026-10-01", "Mars/Olympus")).toThrow(RangeError);
  });
});

describe("the day an instant falls on, for a firm", () => {
  it("is already the 1st in Kolkata while it is still the 30th in UTC", () => {
    // An hourly sweep at 20:30 UTC on 30 September must create October's job
    // for an Indian firm on THAT pass — the month has begun where they are.
    expect(dayInZone("2026-09-30T20:30:00.000Z", "Asia/Kolkata")).toBe("2026-10-01");
    expect(dayInZone("2026-09-30T20:30:00.000Z", "UTC")).toBe("2026-09-30");
  });

  it("is still the 30th in New York when it is the 1st in UTC", () => {
    expect(dayInZone("2026-10-01T02:00:00.000Z", "America/New_York")).toBe("2026-09-30");
  });

  it("round-trips with the start of that day", () => {
    const start = startOfDayInZone("2026-10-01", "Asia/Kolkata");
    expect(dayInZone(start, "Asia/Kolkata")).toBe("2026-10-01");
  });

  it("refuses a value that is not an instant", () => {
    expect(() => dayInZone("2026-10-01", "UTC")).not.toThrow();
    expect(() => dayInZone("not a moment", "UTC")).toThrow(RangeError);
  });
});

describe("a caller's today, against the firm's", () => {
  // Every inhabited zone is within a day of every other, so a browser's today
  // is the firm's day or one either side — and anything else is a CHOSEN date.
  it("takes the firm's day and the day either side", () => {
    expect(isCallersToday("2026-09-25", "2026-09-25")).toBe(true);
    expect(isCallersToday("2026-09-24", "2026-09-25")).toBe(true);
    expect(isCallersToday("2026-09-26", "2026-09-25")).toBe(true);
    // Across a month and a year boundary, by the calendar, not the string.
    expect(isCallersToday("2026-09-30", "2026-10-01")).toBe(true);
    expect(isCallersToday("2027-01-01", "2026-12-31")).toBe(true);
  });

  it("refuses a day further away: that is a date chosen, not today", () => {
    expect(isCallersToday("2026-09-23", "2026-09-25")).toBe(false);
    expect(isCallersToday("2025-09-25", "2026-09-25")).toBe(false);
  });

  it("refuses what is not a real calendar day", () => {
    expect(isCallersToday("2026-02-30", "2026-03-01")).toBe(false);
    expect(isCallersToday("25-09-2026", "2026-09-25")).toBe(false);
    expect(isCallersToday("", "2026-09-25")).toBe(false);
  });
});
