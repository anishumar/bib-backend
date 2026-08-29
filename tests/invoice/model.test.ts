// The invoice domain — the pure parts, and the one thing that must not drift.
//
// `financialYearOf` exists TWICE: here, and as `crm.financial_year_of(date)` in
// migration 0027. Both are needed — a CHECK constraint cannot call TypeScript,
// and the application composes the number before it writes the row — and two
// copies of a rule is exactly how a boundary case ends up answered differently
// on the two sides. `tests/invoice/numbering.integration.test.ts` asks Postgres
// the same questions this file asks the TypeScript, on the same dates.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERIES_PREFIX,
  INVOICE_STATUSES,
  canTransition,
  financialYearLabel,
  financialYearOf,
  formatInvoiceNumber,
  isInvoiceStatus,
  isSeriesPrefix,
} from "../../src/domain/invoice/model";

describe("the financial year a date falls in", () => {
  // The boundary is the whole function. Half the cases below are wrong under a
  // calendar year, which is what makes this worth a function at all.
  it.each([
    ["2026-04-01", 2026],
    ["2026-03-31", 2025],
    ["2026-12-31", 2026],
    ["2026-01-01", 2025],
    ["2027-03-31", 2026],
  ])("%s is FY %i", (date, year) => {
    expect(financialYearOf(date)).toBe(year);
  });

  it("refuses anything that is not an ISO date", () => {
    // An instant is the dangerous input: a UTC `Date` moves 1 April by a day
    // for anyone east or west of Greenwich, which is exactly the boundary
    // above. Refusing the string form is how that never gets a chance.
    expect(() => financialYearOf("2026-04-01T00:00:00Z")).toThrow(RangeError);
    expect(() => financialYearOf("01/04/2026")).toThrow(RangeError);
  });

  it("writes the year as a firm writes it", () => {
    // "FY 2026" is ambiguous in exactly the countries this product serves.
    expect(financialYearLabel(2026)).toBe("2026-27");
    expect(financialYearLabel(2029)).toBe("2029-30");
    expect(financialYearLabel(2099)).toBe("2099-00");
  });
});

describe("the number", () => {
  it("reads as an invoice number, not a document reference", () => {
    expect(formatInvoiceNumber({ prefix: "INV", financialYear: 2026, sequence: 1 })).toBe(
      "INV/2026-27/0001",
    );
    expect(formatInvoiceNumber({ prefix: "10XUS", financialYear: 2026, sequence: 41 })).toBe(
      "10XUS/2026-27/0041",
    );
  });

  it("gets a fifth digit rather than a collision", () => {
    expect(formatInvoiceNumber({ prefix: "INV", financialYear: 2026, sequence: 10000 })).toBe(
      "INV/2026-27/10000",
    );
  });

  it("has no zeroth invoice", () => {
    // A gapless series starts at 1. A zero here would be a counter that had
    // never been incremented being formatted as though it had.
    expect(() => formatInvoiceNumber({ prefix: "INV", financialYear: 2026, sequence: 0 })).toThrow(
      RangeError,
    );
  });

  it.each([
    ["INV", true],
    ["10XUS", true],
    ["INV/A", true],
    ["inv", false],
    ["", false],
    ["THIRTEENCHARS", false],
    ["/INV", false],
  ])("%j is a series prefix: %s", (prefix, ok) => {
    expect(isSeriesPrefix(prefix)).toBe(ok);
  });

  it("defaults to something a firm recognises", () => {
    expect(isSeriesPrefix(DEFAULT_SERIES_PREFIX)).toBe(true);
  });
});

describe("the states an invoice has", () => {
  it("has no `paid`, deliberately", () => {
    // What has been paid is the sum of the payments against it. A status saying
    // "paid" beside a balance saying otherwise is the classic way those two
    // disagree, and only one of them is arithmetic.
    expect(INVOICE_STATUSES).toEqual(["draft", "issued", "cancelled"]);
    expect(isInvoiceStatus("paid")).toBe(false);
  });

  it("never returns an issued invoice to draft", () => {
    // A copy has left the building, and in India a copy is registered with the
    // government. Getting it wrong is answered by cancelling and reissuing.
    expect(canTransition("draft", "issued")).toBe(true);
    expect(canTransition("draft", "cancelled")).toBe(true);
    expect(canTransition("issued", "cancelled")).toBe(true);
    expect(canTransition("issued", "draft")).toBe(false);
    expect(canTransition("cancelled", "draft")).toBe(false);
    expect(canTransition("cancelled", "issued")).toBe(false);
  });
});
