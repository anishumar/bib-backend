// Periods the tax authority assigned (Q073, 0359): the cut, the label, and the
// import cell that records them.
import { describe, expect, it } from "vitest";
import { periodsBetween } from "../../src/domain/obligation/model";
import { assignedQuarterLabel, periodCutFor, returnPeriodProblem } from "../../src/domain/obligation/period-basis";
import { readReturnPeriods } from "../../src/domain/clientimport/model";

const VAT = { recurrence: "quarterly" as const, fiscalYearStartMonth: 1, periodBasis: "authority_assigned" as const, module: "VAT" };

describe("the cut for a client on an assigned period", () => {
  it("is its own stagger, its monthly period, or nothing at all", () => {
    expect(periodCutFor(VAT, { financialYearEnd: null, returnPeriods: [{ tax: "VAT", frequency: "quarterly", firstMonth: 2 }] }))
      .toEqual({ recurrence: "quarterly", startMonth: 2, basis: "authority_assigned" });
    expect(periodCutFor(VAT, { financialYearEnd: null, returnPeriods: [{ tax: "vat", frequency: "monthly", firstMonth: null }] }))
      .toEqual({ recurrence: "monthly", startMonth: 1, basis: "authority_assigned" });
    // A period for another tax is not this one's; none recorded is no filing.
    expect(periodCutFor(VAT, { financialYearEnd: "12-31", returnPeriods: [{ tax: "EXCISE", frequency: "monthly", firstMonth: null }] })).toBeNull();
    expect(periodCutFor(VAT, { financialYearEnd: null, returnPeriods: [] })).toBeNull();
  });

  it("cuts the February stagger Feb-Apr, May-Jul, Aug-Oct, Nov-Jan, and says so", () => {
    const quarters = periodsBetween("quarterly", 2, "2026-01-01", "2026-12-31").map(assignedQuarterLabel);
    expect(quarters).toEqual(["Nov 2025-Jan 2026", "Feb-Apr 2026", "May-Jul 2026", "Aug-Oct 2026", "Nov 2026-Jan 2027"]);
  });

  it("refuses a period that cannot be cut", () => {
    expect(returnPeriodProblem({ tax: "VAT", frequency: "quarterly", firstMonth: 4 })).toMatch(/Jan, Feb or Mar/);
    expect(returnPeriodProblem({ tax: "VAT", frequency: "monthly", firstMonth: 2 })).toMatch(/no quarter months/);
    expect(returnPeriodProblem({ tax: "", frequency: "monthly", firstMonth: null })).toMatch(/e\.g\. VAT/);
    expect(returnPeriodProblem({ tax: "VAT", frequency: "quarterly", firstMonth: 3 })).toBeNull();
  });
});

describe("the import's Tax Return Period cell", () => {
  it("reads the three staggers, monthly, and several taxes", () => {
    expect(readReturnPeriods("VAT quarterly Feb").periods).toEqual([{ tax: "VAT", frequency: "quarterly", firstMonth: 2 }]);
    // A later month of the same stagger is the same stagger.
    expect(readReturnPeriods("vat Quarterly May").periods).toEqual([{ tax: "VAT", frequency: "quarterly", firstMonth: 2 }]);
    expect(readReturnPeriods("VAT monthly; Excise quarterly March").periods).toEqual([
      { tax: "VAT", frequency: "monthly", firstMonth: null },
      { tax: "EXCISE", frequency: "quarterly", firstMonth: 3 },
    ]);
  });

  it("refuses in words, never guesses", () => {
    expect(readReturnPeriods("VAT quarterly").problems[0]).toMatch(/e\.g\. VAT quarterly Feb/);
    expect(readReturnPeriods("VAT quarterly Smarch").problems[0]).toMatch(/Jan, Feb or Mar/);
    expect(readReturnPeriods("VAT monthly; VAT quarterly Jan").problems).toContain("Tax Return Period names the same tax twice");
  });
});
