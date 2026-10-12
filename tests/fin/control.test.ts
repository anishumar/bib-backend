// The control figures (docs/FIN_BUILD_PLAN.md F2.6, F2.9): whether a read's
// lines agree with what the file printed about itself, checked exactly.
import { describe, expect, it } from "vitest";
import { checkControl, sameDecimal, subtractDecimals, sumDecimals } from "../../src/domain/fin/control";
import type { LineDraft, ReadControl, StatementLineDraft } from "../../src/domain/fin/lines";
import { decideRead } from "../../src/domain/fin/read";

const V = "00000000-0000-4000-8000-0000000000a1";

function txn(amount: string, balance: string | null, row = 1): StatementLineDraft {
  return {
    kind: "statement",
    statementType: "bank",
    accountRef: null,
    txnDate: "2025-01-10",
    valueDate: null,
    narration: "TRANSFER",
    reference: null,
    amount,
    currency: "SGD",
    balance,
    originalCurrency: null,
    originalAmount: null,
    provenance: { documentVersionId: V, page: null, row },
    uncertain: [],
  };
}

function control(over: Partial<ReadControl> = {}): ReadControl {
  return { opening: null, closing: null, lineCount: null, declaredTotal: null, ...over };
}

describe("decimal arithmetic", () => {
  it("adds exactly, where a float would not", () => {
    expect(sumDecimals(["0.1", "0.2"])).toBe("0.3");
    expect(sumDecimals(["85000", "27800.00", "-27739.38"])).toBe("85060.62");
    expect(sumDecimals([])).toBe("0");
    expect(subtractDecimals("100.10", "100.00")).toBe("0.10");
    expect(sameDecimal("12.5", "12.50")).toBe(true);
    expect(sameDecimal("-0.00", "0")).toBe(true);
  });
});

describe("the control check", () => {
  it("checks nothing a file did not print, and says so", () => {
    expect(checkControl({ lines: [txn("5", null)], control: null })).toEqual({ ok: true, checked: [], problems: [] });
  });

  it("holds opening plus the lines to the closing", () => {
    const lines = [txn("27800.00", null), txn("-27739.38", null)];
    expect(checkControl({ lines, control: control({ opening: "85000", closing: "85060.62" }) })).toMatchObject({
      ok: true,
      checked: ["opening_closing"],
    });
    const off = checkControl({ lines, control: control({ opening: "85000", closing: "85060.00" }) });
    expect(off.ok).toBe(false);
    expect(off.problems).toEqual([{ check: "opening_closing", position: null, expected: "85060.00", actual: "85060.62" }]);
  });

  it("holds a running balance continuous, and names the line where it breaks", () => {
    const good = [txn("27800.00", "112800.00"), txn("-27739.38", "85060.62"), txn("107000.00", "192060.62")];
    expect(checkControl({ lines: good, control: control({ opening: "85000" }) })).toMatchObject({
      ok: true,
      checked: ["running_balance"],
    });
    const broken = [txn("27800.00", "112800.00"), txn("-27739.38", "85060.00"), txn("107000.00", "192060.00")];
    const result = checkControl({ lines: broken, control: null });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      { check: "running_balance", position: 2, expected: "85060.00", actual: "85060.62" },
    ]);
  });

  it("reads a statement listed newest first without calling it broken", () => {
    const newestFirst = [txn("107000.00", "192060.62"), txn("-27739.38", "85060.62"), txn("27800.00", "112800.00")];
    expect(checkControl({ lines: newestFirst, control: control({ opening: "85000", closing: "192060.62" }) })).toMatchObject({
      ok: true,
    });
  });

  it("holds the first balance to a printed opening and the last to a printed closing", () => {
    const lines = [txn("100", "1100"), txn("-50", "1050")];
    expect(checkControl({ lines, control: control({ opening: "1000", closing: "1050" }) }).ok).toBe(true);
    const wrongOpening = checkControl({ lines, control: control({ opening: "999" }) });
    expect(wrongOpening.problems).toEqual([{ check: "running_balance", position: 1, expected: "1100", actual: "1099" }]);
  });

  it("holds a printed line count", () => {
    expect(checkControl({ lines: [txn("1", null)], control: control({ lineCount: 1 }) }).ok).toBe(true);
    expect(checkControl({ lines: [txn("1", null)], control: control({ lineCount: 2 }) }).problems).toEqual([
      { check: "line_count", position: null, expected: "2", actual: "1" },
    ]);
  });

  it("holds a declared total to each kind's own amount", () => {
    const payroll: LineDraft[] = [
      {
        kind: "payroll",
        period: "2025-09",
        employeeRef: "*****916T",
        employeeName: "Goh Kai Xiang",
        passType: "citizen",
        age: null,
        ordinaryWage: null,
        additionalWage: null,
        grossPay: "9000",
        cpfEmployee: "1480",
        cpfEmployer: "1258",
        sdl: "11.25",
        fwl: "0",
        netPay: "7520",
        provenance: { documentVersionId: V, page: null, row: 5 },
        uncertain: [],
      },
    ];
    expect(checkControl({ lines: payroll, control: control({ declaredTotal: "9000.00" }) }).ok).toBe(true);
    const missingGross = [{ ...payroll[0], grossPay: null } as LineDraft];
    expect(checkControl({ lines: missingGross, control: control({ declaredTotal: "9000" }) }).problems).toEqual([
      { check: "declared_total", position: null, expected: "9000", actual: null },
    ]);
  });

  it("sends a mismatch to a person and KEEPS the read's lines, staging only what agrees", () => {
    const lines = [txn("1", "11"), txn("1", "13")];
    const decided = decideRead({ lines, control: null });
    expect(decided).toMatchObject({ status: "needs_person", problem: "control_mismatch", controlOk: false });
    expect(decided.control.problems).toHaveLength(1);
    expect(decideRead({ lines: [txn("1", "11"), txn("1", "12")], control: null })).toMatchObject({
      status: "staged",
      problem: null,
      controlOk: true,
    });
  });
});
