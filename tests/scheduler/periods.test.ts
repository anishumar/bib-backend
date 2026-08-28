// The date arithmetic the engine runs on (T2.6) — pure, and tested against the
// calendar rather than against a running worker.
//
// This is the half that is wrong in ways nobody notices. A quarter that starts
// in January instead of April is right three times out of four, and the fourth
// time it puts a filing in the wrong period — which surfaces as a penalty, not
// as an error. So there is no clock in this file: every case states its dates.
import { describe, expect, it } from "vitest";
import {
  addDays,
  dueDateFor,
  fiscalYearOf,
  internalTargetFor,
  monthsPerPeriod,
  periodsFrom,
  runnableAtFor,
} from "../../src/domain/scheduler/model";

const INDIA_FY_START = 4; // April

describe("the acceptance: a monthly obligation, twelve periods a year out", () => {
  it("produces twelve months, each covering its own month", () => {
    const periods = periodsFrom("2026-08-15", "monthly", 12);
    expect(periods).toHaveLength(12);
    // The FIRST period is the one CONTAINING the date, not the one after it. A
    // generator run on the 15th must produce August, or the current filing is
    // the one it silently skips.
    expect(periods[0]).toMatchObject({ start: "2026-08-01", end: "2026-08-31", label: "Aug 2026" });
    expect(periods[11]).toMatchObject({ start: "2027-07-01", end: "2027-07-31" });
  });

  it("covers a leap February exactly", () => {
    const [feb] = periodsFrom("2028-02-10", "monthly", 1);
    expect(feb?.end).toBe("2028-02-29");
  });

  it("never leaves a gap or an overlap across a year", () => {
    // The property that matters more than any single boundary: every day of the
    // year belongs to exactly one period. A month-arithmetic bug shows up here
    // even when each period looks right on its own.
    const periods = periodsFrom("2026-01-01", "monthly", 12);
    for (let i = 1; i < periods.length; i += 1) {
      const previous = periods[i - 1];
      const current = periods[i];
      if (!previous || !current) throw new Error("missing period");
      expect(addDays(previous.end, 1)).toBe(current.start);
    }
  });
});

describe("a quarter is aligned to the financial year, not to when you asked", () => {
  it("gives Apr–Jun for India, whatever month the generator runs in", () => {
    // THE bug this test exists for. Asked in August, a naive implementation
    // returns Aug–Oct: three months, looks plausible, and is not a quarter any
    // Indian filing recognises.
    const [first] = periodsFrom("2026-08-15", "quarterly", 1, INDIA_FY_START);
    expect(first).toMatchObject({ start: "2026-07-01", end: "2026-09-30", label: "Q2 FY2026-27" });
  });

  it("puts January in Q4 of the financial year that began the PREVIOUS April", () => {
    // The boundary that is wrong by a whole year if the fiscal offset is
    // ignored, and it is only ever exercised for three months out of twelve.
    // January 2027 belongs to FY2026-27 — the year that started in April 2026 —
    // and it is that year's FOURTH quarter, not its first.
    const [dec] = periodsFrom("2026-12-05", "quarterly", 1, INDIA_FY_START);
    expect(dec).toMatchObject({ start: "2026-10-01", end: "2026-12-31", label: "Q3 FY2026-27" });
    const [jan] = periodsFrom("2027-01-20", "quarterly", 1, INDIA_FY_START);
    expect(jan).toMatchObject({ start: "2027-01-01", end: "2027-03-31", label: "Q4 FY2026-27" });
    // And the next quarter after it opens a NEW financial year.
    const [apr] = periodsFrom("2027-04-02", "quarterly", 1, INDIA_FY_START);
    expect(apr).toMatchObject({ start: "2027-04-01", end: "2027-06-30", label: "Q1 FY2027-28" });
  });

  it("gives calendar quarters when the year starts in January", () => {
    const [q] = periodsFrom("2026-08-15", "quarterly", 1, 1);
    expect(q).toMatchObject({ start: "2026-07-01", end: "2026-09-30", label: "Q3 2026" });
  });

  it("names the financial year across both calendar years it spans", () => {
    // "2026" alone is ambiguous for a year running April to March, and a filing
    // labelled with the wrong one is filed against the wrong year.
    const [annual] = periodsFrom("2026-08-15", "annual", 1, INDIA_FY_START);
    expect(annual).toMatchObject({ start: "2026-04-01", end: "2027-03-31", label: "FY2026-27" });
  });

  it("agrees with monthsPerPeriod", () => {
    for (const [recurrence, months] of [
      ["monthly", 1],
      ["quarterly", 3],
      ["half_yearly", 6],
      ["annual", 12],
    ] as const) {
      const [period] = periodsFrom("2026-04-01", recurrence, 1, INDIA_FY_START);
      expect(monthsPerPeriod(recurrence)).toBe(months);
      expect(period?.start).toBe("2026-04-01");
    }
  });
});

describe("the financial year a date falls in", () => {
  it("runs April to March for India", () => {
    expect(fiscalYearOf("2026-04-01", INDIA_FY_START)).toBe(2026);
    expect(fiscalYearOf("2027-03-31", INDIA_FY_START)).toBe(2026);
    expect(fiscalYearOf("2026-03-31", INDIA_FY_START)).toBe(2025);
  });

  it("is the calendar year when the year starts in January", () => {
    expect(fiscalYearOf("2026-08-15", 1)).toBe(2026);
  });
});

describe("due dates are data, not a formula", () => {
  it("resolves GST's rule: the 20th of the month after the period", () => {
    const [august] = periodsFrom("2026-08-01", "monthly", 1);
    if (!august) throw new Error("no period");
    expect(dueDateFor(august, { kind: "dayOfMonth", monthOffset: 1, day: 20 })).toBe("2026-09-20");
  });

  it("clamps a day that the target month does not have", () => {
    // "The 31st" of a 30-day month must be the 30th, not the 1st of the month
    // after. Rolling over makes a deadline a day late and looks like arithmetic
    // working.
    const [september] = periodsFrom("2026-09-01", "monthly", 1);
    if (!september) throw new Error("no period");
    expect(dueDateFor(september, { kind: "dayOfMonth", monthOffset: 1, day: 31 })).toBe("2026-10-31");
    const [october] = periodsFrom("2026-10-01", "monthly", 1);
    if (!october) throw new Error("no period");
    expect(dueDateFor(october, { kind: "dayOfMonth", monthOffset: 1, day: 31 })).toBe("2026-11-30");
  });

  it("resolves a days-after rule across a month boundary", () => {
    const [march] = periodsFrom("2027-03-01", "monthly", 1);
    if (!march) throw new Error("no period");
    expect(dueDateFor(march, { kind: "daysAfter", days: 30 })).toBe("2027-04-30");
  });
});

describe("T–X — the firm's own date, ahead of the law's", () => {
  it("is the lead time before the statutory date", () => {
    expect(internalTargetFor("2026-09-20", 10)).toBe("2026-09-10");
  });

  it("never lands after the statutory date", () => {
    // A negative or zero lead time must collapse to the statutory date rather
    // than quietly moving the firm's own deadline past the law's.
    expect(internalTargetFor("2026-09-20", 0)).toBe("2026-09-20");
    expect(internalTargetFor("2026-09-20", -5)).toBe("2026-09-20");
  });

  it("crosses a month and a year correctly", () => {
    expect(internalTargetFor("2027-01-05", 10)).toBe("2026-12-26");
  });

  it("opens a job's window before its internal target", () => {
    // The calendar is materialised a year ahead so it can be SEEN; a job becomes
    // runnable only when its own window opens, or twelve months of work lands on
    // somebody's desk this morning.
    expect(runnableAtFor("2026-09-10", 5)).toBe("2026-09-05");
    expect(runnableAtFor("2026-09-10", 0)).toBe("2026-09-10");
  });
});

describe("date arithmetic has no timezone in it", () => {
  it("crosses a leap day", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
  });

  it("crosses a year in both directions", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  });

  it("is stable regardless of the machine's offset", () => {
    // Strings in, strings out. A `Date`-based implementation shifts a period
    // boundary by a day for anyone east or west of UTC, and the test that
    // catches it only fails on their machine.
    const periods = periodsFrom("2026-08-01", "monthly", 3);
    expect(periods.map((p) => p.start)).toEqual(["2026-08-01", "2026-09-01", "2026-10-01"]);
  });
});
