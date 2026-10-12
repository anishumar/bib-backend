// F4.5: the payroll checks, each with the case it exists for, its boundaries
// and the near misses it must leave alone. The 2025 figures are the training
// pack's own rows (payroll_truth.csv), which recompute to the dollar.
import { describe, expect, it } from "vitest";
import { checkPayroll } from "../../src/domain/fin/checks-payroll";
import type { CheckedPayrollLine, ClientFacts, PayrollCheckInput } from "../../src/domain/fin/checks-input";
import { CheckInputInvalid } from "../../src/domain/fin/errors";
import { findingDraftProblem } from "../../src/domain/fin/finding";
import type { FindingDraft } from "../../src/domain/fin/finding";
import { RuleParameters } from "../../src/domain/fin/parameters";
import { SINGAPORE_PARAMETERS } from "../../src/testfakes/fin-findings";

const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const parameters = RuleParameters.from("SG", SINGAPORE_PARAMETERS);
const client: ClientFacts = { clientPartyId: CLIENT, gstRegisteredFrom: "2015-01-01", fiscalYearStartMonth: 1 };
const YEAR = { start: "2025-01-01", end: "2025-12-31" } as const;

let n = 0;
function pay(over: Partial<CheckedPayrollLine> = {}): CheckedPayrollLine {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
    clientPartyId: CLIENT,
    kind: "payroll",
    period: "2025-08",
    employeeRef: "E001",
    employeeName: null,
    passType: "citizen",
    age: 48,
    ordinaryWage: "12000.00",
    additionalWage: "0.00",
    grossPay: "12000.00",
    cpfEmployee: "1480.00",
    cpfEmployer: "1258.00",
    sdl: "11.25",
    fwl: "0.00",
    netPay: "10520.00",
    provenance: { documentVersionId: "00000000-0000-4000-8000-00000000f002", page: null, row: 4 },
    uncertain: [],
    ...over,
  };
}

function run(lines: readonly CheckedPayrollLine[], over: Partial<PayrollCheckInput> = {}): FindingDraft[] {
  return checkPayroll({ client, period: YEAR, lines, history: [], parameters, ...over });
}

const keys = (findings: readonly FindingDraft[]) => findings.map((f) => f.checkKey);

describe("a correct payroll raises nothing", () => {
  it.each([
    ["the Managing Director at the ceiling", pay()],
    ["under the ceiling", pay({ ordinaryWage: "3600.00", grossPay: "3600.00", cpfEmployee: "720.00", cpfEmployer: "612.00", sdl: "9.00" })],
    ["above 55 (age 56, 2025's 15.5/17)", pay({ age: 56, ordinaryWage: "3550.00", grossPay: "3550.00", cpfEmployee: "603.00", cpfEmployer: "551.00", sdl: "8.88" })],
    ["above 60 (age 61)", pay({ age: 61, ordinaryWage: "3600.00", additionalWage: "3600.00", grossPay: "7200.00", cpfEmployee: "828.00", cpfEmployer: "864.00", sdl: "11.25" })],
    ["a bonus month, Additional Wages counting in full", pay({ age: 57, ordinaryWage: "3475.00", additionalWage: "3475.00", grossPay: "6950.00", cpfEmployee: "1181.00", cpfEmployer: "1078.00", sdl: "11.25" })],
    ["a Work Permit holder with no CPF and the levy", pay({ passType: "work_permit", age: null, ordinaryWage: "1952.40", grossPay: "1952.40", cpfEmployee: "0.00", cpfEmployer: "0.00", sdl: "4.88" })],
  ] as const)("%s", (_label, line) => {
    expect(run([line])).toEqual([]);
  });
});

describe("CPF on somebody who is not a member", () => {
  it("a Work Permit holder (C-X05)", () => {
    const [f] = run([pay({ passType: "work_permit", age: null, ordinaryWage: "1952.40", grossPay: "1952.40", cpfEmployee: "390.00", cpfEmployer: "331.00", sdl: "4.88" })]);
    expect(f?.checkKey).toBe("payroll.cpf_work_permit");
    expect(f?.facts).toMatchObject({ passType: "work_permit", cpfEmployee: "390.00", cpfEmployer: "331.00" });
  });

  it("an Employment Pass holder (E-X03), and an S Pass holder", () => {
    expect(keys(run([pay({ passType: "employment_pass", ordinaryWage: "7000.00", grossPay: "7000.00", cpfEmployee: "1400.00", cpfEmployer: "1190.00" })]))).toEqual([
      "payroll.cpf_employment_pass",
    ]);
    expect(keys(run([pay({ passType: "s_pass", cpfEmployee: "0.00", cpfEmployer: "10.00" })]))).toEqual(["payroll.cpf_s_pass"]);
  });

  it("a pass type the sheet did not show is not judged", () => {
    expect(run([pay({ passType: null, cpfEmployee: "390.00" })])).toEqual([]);
  });
});

describe("payroll.cpf_ow_ceiling", () => {
  it("employer CPF worked out on S$12,000, the S$7,400 ceiling ignored (A-X05)", () => {
    const [f] = run([pay({ cpfEmployer: "2960.00" })]);
    expect(f?.checkKey).toBe("payroll.cpf_ow_ceiling");
    expect(f?.facts).toMatchObject({
      owCeiling: "7400.00",
      cpfEmployee: "1480.00",
      cpfEmployer: "2960.00",
      expectedEmployee: "1480.00",
      expectedEmployer: "1258.00",
      period: "2025-08",
      employeeRef: "E001",
    });
  });

  it("both shares on the whole wage is the same finding", () => {
    expect(keys(run([pay({ cpfEmployee: "2400.00", cpfEmployer: "2040.00" })]))).toEqual(["payroll.cpf_ow_ceiling"]);
  });

  it("the ceiling's own boundaries: S$7,400 in December 2025, S$8,000 in January 2026", () => {
    // S$8,000 in December 2025: 37% of 7,400 is right, of 8,000 is the finding.
    expect(run([pay({ period: "2025-12", ordinaryWage: "8000.00", grossPay: "8000.00" })])).toEqual([]);
    expect(keys(run([pay({ period: "2025-12", ordinaryWage: "8000.00", grossPay: "8000.00", cpfEmployee: "1600.00", cpfEmployer: "1360.00" })]))).toEqual([
      "payroll.cpf_ow_ceiling",
    ]);
    // January 2026: the ceiling is S$8,000, so 20% of 8,000 is S$1,600 and right.
    const january = { start: "2026-01-01", end: "2026-01-31" };
    expect(run([pay({ period: "2026-01", ordinaryWage: "8000.00", grossPay: "8000.00", cpfEmployee: "1600.00", cpfEmployer: "1360.00" })], { period: january })).toEqual([]);
    expect(keys(run([pay({ period: "2026-01", ordinaryWage: "8000.00", grossPay: "8000.00" })], { period: january }))).toEqual([
      "payroll.cpf_amount",
    ]);
  });
});

describe("payroll.cpf_age_band", () => {
  it("an employee above 60 charged at the 55-and-below rates (B-X05)", () => {
    const [f] = run([pay({ age: 60, ordinaryWage: "3600.00", grossPay: "3600.00", cpfEmployee: "720.00", cpfEmployer: "612.00", sdl: "9.00" })]);
    expect(f?.checkKey).toBe("payroll.cpf_age_band");
    expect(f?.facts).toMatchObject({ bandAboveAge: 60, appliedBandAboveAge: 0, expectedEmployee: "414.00", expectedEmployer: "432.00" });
  });

  it("the band turns the month AFTER the birthday month: 59 is the band above 55, 60 is above 60", () => {
    const at = (age: number, ee: string, er: string) =>
      run([pay({ age, ordinaryWage: "3600.00", grossPay: "3600.00", cpfEmployee: ee, cpfEmployer: er, sdl: "9.00" })]);
    // 32.5% of 3,600 = 1,170; 17% = 612 → employer 558.
    expect(at(59, "612.00", "558.00")).toEqual([]);
    expect(keys(at(60, "612.00", "558.00"))).toEqual(["payroll.cpf_age_band"]);
    // 23.5% of 3,600 = 846; 11.5% = 414 → employer 432.
    expect(at(60, "414.00", "432.00")).toEqual([]);
    // 55 and below at 54; above 55 at 55.
    expect(at(54, "720.00", "612.00")).toEqual([]);
    expect(keys(at(55, "720.00", "612.00"))).toEqual(["payroll.cpf_age_band"]);
  });

  it("2026's rates for the same employee are 2026's", () => {
    const january = { start: "2026-01-01", end: "2026-01-31" };
    // Above 60 in 2026: 25% of 3,600 = 900; 12.5% = 450.
    expect(run([pay({ period: "2026-01", age: 61, ordinaryWage: "3600.00", grossPay: "3600.00", cpfEmployee: "450.00", cpfEmployer: "450.00", sdl: "9.00" })], { period: january })).toEqual([]);
    // 2025's band for him (414/432) matches no band of 2026's table: that is
    // CPF at an old rate, not at another age's, and says so.
    expect(keys(run([pay({ period: "2026-01", age: 61, ordinaryWage: "3600.00", grossPay: "3600.00", cpfEmployee: "414.00", cpfEmployer: "432.00", sdl: "9.00" })], { period: january }))).toEqual([
      "payroll.cpf_amount",
    ]);
    expect(keys(run([pay({ period: "2026-01", age: 61, ordinaryWage: "3600.00", grossPay: "3600.00", cpfEmployee: "720.00", cpfEmployer: "612.00", sdl: "9.00" })], { period: january }))).toEqual([
      "payroll.cpf_age_band",
    ]);
  });
});

describe("payroll.cpf_amount, and what is not judged", () => {
  it("CPF that matches no rule's arithmetic", () => {
    expect(keys(run([pay({ cpfEmployee: "1480.00", cpfEmployer: "1000.00" })]))).toEqual(["payroll.cpf_amount"]);
  });

  it("wages of S$750 or less are graduated rates, not seeded, and not judged", () => {
    expect(run([pay({ ordinaryWage: "750.00", grossPay: "750.00", cpfEmployee: "0.00", cpfEmployer: "0.00", sdl: "2.00" })])).toEqual([]);
    expect(keys(run([pay({ ordinaryWage: "750.01", grossPay: "750.01", cpfEmployee: "0.00", cpfEmployer: "0.00", sdl: "2.00" })]))).toEqual([
      "payroll.cpf_amount",
    ]);
  });

  it("no age, no CPF figures read, or a month no rate covers: not judged", () => {
    expect(run([pay({ age: null, cpfEmployer: "2960.00" })])).toEqual([]);
    expect(run([pay({ cpfEmployer: null })])).toEqual([]);
    expect(run([pay({ period: "2024-08", cpfEmployer: "9.00" })], { period: { start: "2024-01-01", end: "2024-12-31" } })).toEqual([]);
  });

  it("a bonus past the year's ceiling counts only up to it", () => {
    // S$7,400 a month all year and a S$20,000 bonus in December: only
    // 102,000 - 88,800 = 13,200 of it counts. 37% of 20,600 = 7,622; 20% = 4,120.
    const history = Array.from({ length: 11 }, (_, i) =>
      pay({ period: `2025-${String(i + 1).padStart(2, "0")}`, ordinaryWage: "7400.00", grossPay: "7400.00" }),
    );
    const december = pay({ period: "2025-12", ordinaryWage: "7400.00", additionalWage: "20000.00", grossPay: "27400.00", cpfEmployee: "4120.00", cpfEmployer: "3502.00" });
    expect(run([december], { history })).toEqual([]);
  });
});

describe("the Skills Development Levy", () => {
  it("none shown for an employee (D-X04)", () => {
    const [f] = run([pay({ ordinaryWage: "5800.00", grossPay: "5800.00", cpfEmployee: "1160.00", cpfEmployer: "986.00", sdl: "0.00" })]);
    expect(f?.checkKey).toBe("payroll.sdl_missing");
    expect(f?.facts).toMatchObject({ wages: "5800.00", expectedSdl: "11.25" });
  });

  it("its bounds: S$2 at the least, S$11.25 at the most, 0.25% between", () => {
    const at = (wage: string, sdl: string) =>
      run([pay({ passType: "work_permit", age: null, ordinaryWage: wage, grossPay: wage, cpfEmployee: "0.00", cpfEmployer: "0.00", sdl })]);
    expect(at("600.00", "2.00")).toEqual([]);
    expect(at("4500.00", "11.25")).toEqual([]);
    expect(at("9000.00", "11.25")).toEqual([]);
    expect(at("2000.00", "5.00")).toEqual([]);
    expect(keys(at("600.00", "1.50"))).toEqual(["payroll.sdl_amount"]);
    expect(keys(at("9000.00", "22.50"))).toEqual(["payroll.sdl_amount"]);
  });

  it("a half cent may go either way; a cent and a half may not", () => {
    const at = (sdl: string) =>
      run([pay({ passType: "work_permit", age: null, ordinaryWage: "2650.00", grossPay: "2650.00", cpfEmployee: "0.00", cpfEmployer: "0.00", sdl })]);
    // 0.25% of 2,650 is 6.625.
    expect(at("6.62")).toEqual([]);
    expect(at("6.63")).toEqual([]);
    expect(keys(at("6.60"))).toEqual(["payroll.sdl_amount"]);
  });

  it("a levy the sheet did not show is not judged", () => {
    expect(run([pay({ sdl: null })])).toEqual([]);
  });
});

describe("findings the store can keep, raised once", () => {
  it("one per employee per month, on that month", () => {
    const [f] = run([pay({ cpfEmployer: "2960.00" })]);
    expect(f).toMatchObject({ periodStart: "2025-08-01", periodEnd: "2025-08-31", lane: "rule" });
    expect(f === undefined ? "missing" : findingDraftProblem(f)).toBeNull();
    expect(run([pay({ cpfEmployer: "2960.00", id: "00000000-0000-4000-8000-00000000abcd" })])[0]?.dedupeKey).toBe(
      "payroll.cpf_ow_ceiling:00000000-0000-4000-8000-00000000abcd",
    );
  });

  it("refuses a line whose month is not a month", () => {
    expect(() => run([pay({ period: "2025-13" })])).toThrow(CheckInputInvalid);
  });
});
