// A firm company's own year and clock (0337), the pure half: a year stored by
// its last day and read by its first month, and "the company's, else the
// firm's" decided in one place.
import { describe, expect, it } from "vitest";
import {
  isYearStartMonth,
  startMonthOfYearEnd,
  yearEndOfStartMonth,
  yearStartOfCompany,
  zoneOfCompany,
} from "../../src/domain/calendar/model";

describe("a company's financial year, stored as its last day", () => {
  it("starts the month after it ends", () => {
    expect(startMonthOfYearEnd("03-31")).toBe(4);
    expect(startMonthOfYearEnd("12-31")).toBe(1);
    expect(startMonthOfYearEnd("06-30")).toBe(7);
    expect(startMonthOfYearEnd("02-28")).toBe(3);
    expect(startMonthOfYearEnd("02-29")).toBe(3);
  });

  it("reads nothing it cannot read", () => {
    expect(startMonthOfYearEnd(null)).toBeNull();
    expect(startMonthOfYearEnd("13-31")).toBeNull();
    expect(startMonthOfYearEnd("00-31")).toBeNull();
    expect(startMonthOfYearEnd("3/31")).toBeNull();
    expect(startMonthOfYearEnd("")).toBeNull();
  });

  it("writes the last day of the month before the start, February as 28", () => {
    expect(yearEndOfStartMonth(4)).toBe("03-31");
    expect(yearEndOfStartMonth(1)).toBe("12-31");
    expect(yearEndOfStartMonth(3)).toBe("02-28");
    expect(yearEndOfStartMonth(7)).toBe("06-30");
    for (let m = 1; m <= 12; m++) expect(startMonthOfYearEnd(yearEndOfStartMonth(m))).toBe(m);
  });

  it("refuses to write a month that is not one", () => {
    expect(() => yearEndOfStartMonth(0)).toThrow(RangeError);
    expect(() => yearEndOfStartMonth(13)).toThrow(RangeError);
  });

  it("knows a start month when it sees one", () => {
    expect(isYearStartMonth(1)).toBe(true);
    expect(isYearStartMonth(12)).toBe(true);
    expect(isYearStartMonth(0)).toBe(false);
    expect(isYearStartMonth(13)).toBe(false);
    expect(isYearStartMonth(4.5)).toBe(false);
    expect(isYearStartMonth("4")).toBe(false);
    expect(isYearStartMonth(null)).toBe(false);
  });
});

describe("the company's, else the firm's", () => {
  const cals = new Map([
    ["ae", { timeZone: "Asia/Dubai", fiscalYearStartMonth: 1 }],
    ["us", { timeZone: null, fiscalYearStartMonth: 1 }],
    ["sg", { timeZone: "Asia/Singapore", fiscalYearStartMonth: null }],
  ]);

  it("zone", () => {
    expect(zoneOfCompany(cals, "ae", "Asia/Kolkata")).toBe("Asia/Dubai");
    expect(zoneOfCompany(cals, "us", "Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(zoneOfCompany(cals, "in", "Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(zoneOfCompany(cals, null, "UTC")).toBe("UTC");
  });

  it("year start", () => {
    expect(yearStartOfCompany(cals, "ae", 4)).toBe(1);
    expect(yearStartOfCompany(cals, "sg", 4)).toBe(4);
    expect(yearStartOfCompany(cals, "in", 4)).toBe(4);
    expect(yearStartOfCompany(cals, "in", null)).toBeNull();
    expect(yearStartOfCompany(cals, "ae", null)).toBe(1);
    expect(yearStartOfCompany(cals, null, 4)).toBe(4);
  });
});
