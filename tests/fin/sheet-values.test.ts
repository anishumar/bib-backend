// What a sheet's cells say (docs/FIN_BUILD_PLAN.md F2.6, F2.9, F2.11): header
// words, amounts in every style the training pack prints, days in every format
// it uses, payroll months, pass types, and the NRIC that is never stored whole.
import { describe, expect, it } from "vitest";
import {
  ageOn,
  detectDateFormat,
  isNric,
  maskNric,
  maskedNric,
  normaliseHeader,
  parseDay,
  parsePeriod,
  passTypeOf,
  periodInFilename,
  periodInText,
  readAmount,
} from "../../src/domain/fin/sheet-values";

describe("header words", () => {
  it.each([
    ["TxnDate", "txn date"],
    ["Transaction Date", "transaction date"],
    ["NRIC_FIN", "nric fin"],
    ["NRIC / FIN", "nric fin"],
    ["CPF (Employee)", "cpf employee"],
    ["EmployerUEN", "employer uen"],
    ["OrdinaryWages", "ordinary wages"],
    ["ServiceCharge10", "service charge 10"],
    ["GST9", "gst 9"],
    ["NETS_PayNow", "nets pay now"],
    ["No.", "no"],
    ["S/N", "s n"],
    ["﻿Account Name:", "account name"],
  ])("%s reads as %s", (cell, words) => {
    expect(normaliseHeader(cell)).toBe(words);
  });
});

describe("an amount cell", () => {
  const value = (raw: string) => {
    const a = readAmount(raw);
    return a.kind === "amount" ? a.value : a.kind;
  };

  it("reads a signed figure, with or without its plus", () => {
    expect(value("+52600.00")).toBe("52600.00");
    expect(value("-52511.84")).toBe("-52511.84");
    expect(value("7.45")).toBe("7.45");
  });

  it("reads thousands separators, quoted or not, and a currency mark", () => {
    expect(value("19,100.00")).toBe("19100.00");
    expect(value("139,425.66")).toBe("139425.66");
    expect(value("S$6,200.00")).toBe("6200.00");
    expect(value("SGD 1,000")).toBe("1000");
    expect(value("1,000.00 SGD")).toBe("1000.00");
  });

  it("reads brackets and a trailing minus as negative", () => {
    expect(value("(1,234.56)")).toBe("-1234.56");
    expect(value("120.00-")).toBe("-120.00");
    expect(value("−5.00")).toBe("-5.00");
  });

  it("signs a CR or DR after the digits the way a bank means it", () => {
    expect(readAmount("1,234.56 CR")).toEqual({ kind: "amount", value: "1234.56", suffix: "CR" });
    expect(readAmount("88.10 DR")).toEqual({ kind: "amount", value: "-88.10", suffix: "DR" });
    expect(readAmount("500.00Dr")).toEqual({ kind: "amount", value: "-500.00", suffix: "DR" });
  });

  it("turns a spreadsheet's float noise back into the figure on screen, and moves nothing typed", () => {
    expect(value("560.9299999999999")).toBe("560.93");
    expect(value("0.30000000000000004")).toBe("0.3");
    expect(value("2.5000")).toBe("2.5000");
    expect(value("0.000001")).toBe("0.000001");
  });

  it("says blank for an empty cell and the dashes banks print for nothing", () => {
    for (const raw of ["", "  ", "-", "—"]) expect(value(raw)).toBe("blank");
  });

  it("refuses what it cannot read rather than guessing", () => {
    // A decimal comma would move a figure by a thousand if guessed wrong.
    for (const raw of ["1.234,56", "12,34", "abc", "1 234.56", "--5", "(-5)", "CR"]) expect(value(raw)).toBe("bad");
  });

  it("never writes a negative zero", () => {
    expect(value("-0.00")).toBe("0.00");
    expect(value("(0)")).toBe("0");
  });
});

describe("a day", () => {
  it.each([
    ["2025-03-15", "iso", "2025-03-15"],
    ["2025/3/5", "iso", "2025-03-05"],
    ["2025-03-15 00:00:00", "iso", "2025-03-15"],
    ["15/03/2025", "dmy", "2025-03-15"],
    ["15-03-2025", "dmy", "2025-03-15"],
    ["03/15/2025", "mdy", "2025-03-15"],
    ["15/03/25", "dmy_short", "2025-03-15"],
    ["15 Mar 2025", "d_mon_y", "2025-03-15"],
    ["11-Apr-25", "d_mon_y", "2025-04-11"],
    ["1 September 2025", "d_mon_y", "2025-09-01"],
    ["Mar 15, 2025", "mon_d_y", "2025-03-15"],
    ["10012025", "ddmmyyyy", "2025-01-10"],
    ["20250110", "yyyymmdd", "2025-01-10"],
  ] as const)("%s in %s is %s", (raw, format, day) => {
    expect(parseDay(raw, format)).toBe(day);
  });

  it("refuses a day that does not exist", () => {
    expect(parseDay("30/02/2025", "dmy")).toBeNull();
    expect(parseDay("2025-13-01", "iso")).toBeNull();
    expect(parseDay("31 Sept 2025", "d_mon_y")).toBeNull();
  });

  it("finds the one format a column is written in", () => {
    expect(detectDateFormat(["10/01/2025", "14/01/2025", "31/01/2025"])).toEqual({ kind: "found", format: "dmy" });
    expect(detectDateFormat(["11-Apr-25", "30-Apr-25"])).toEqual({ kind: "found", format: "d_mon_y" });
    expect(detectDateFormat(["10012025", "31012025"])).toEqual({ kind: "found", format: "ddmmyyyy" });
  });

  it("leaves a label in the date column to the caller", () => {
    expect(detectDateFormat(["Opening Balance", "10/01/2025", "", "14/01/2025"])).toEqual({ kind: "found", format: "dmy" });
  });

  it("says ambiguous, never picks, when every day reads both ways", () => {
    expect(detectDateFormat(["03/04/2025", "05/04/2025"])).toEqual({ kind: "ambiguous", formats: ["dmy", "mdy"] });
  });

  it("says none when nothing is a day", () => {
    expect(detectDateFormat(["", "TOTAL"])).toEqual({ kind: "none" });
  });
});

describe("a payroll's month", () => {
  it.each([
    ["2025-08", "2025-08"],
    ["2025-08-01", "2025-08"],
    ["Jun-25", "2025-06"],
    ["Aug 2025", "2025-08"],
    ["August 2025", "2025-08"],
    ["08/2025", "2025-08"],
    ["202508", "2025-08"],
  ])("%s is %s", (raw, period) => {
    expect(parsePeriod(raw)).toBe(period);
  });

  it("is read from a sheet's title", () => {
    expect(periodInText("Lumen Cloudworks Pte Ltd - Payroll for August 2025")).toBe("2025-08");
    expect(periodInText("SALARY SHEET - SEPTEMBER 2025")).toBe("2025-09");
    expect(periodInText("HARBOURLINE TRADING PTE LTD")).toBeNull();
  });

  it("is read from a file name, as the last resort", () => {
    expect(periodInFilename("Payroll_Aug2025.xlsx")).toBe("2025-08");
    expect(periodInFilename("SALARY Sep 25.xlsx")).toBe("2025-09");
    expect(periodInFilename("Wages_2025_03.xlsx")).toBe("2025-03");
    expect(periodInFilename("PR_register_2025-10.xlsx")).toBe("2025-10");
    expect(periodInFilename("salary jun.xlsx")).toBeNull();
    expect(periodInFilename("7306_0125.csv")).toBeNull();
    // A month inside another word is not a month.
    expect(periodInFilename("summary 2025.csv")).toBeNull();
  });
});

describe("an NRIC/FIN", () => {
  it("is recognised by its shape", () => {
    expect(isNric("S4597193L")).toBe(true);
    expect(isNric("f3405778g")).toBe(true);
    expect(isNric("E001")).toBe(false);
    expect(isNric("202134890G")).toBe(false);
  });

  it("is kept only as its last four characters", () => {
    expect(maskedNric("S4597193L")).toBe("*****193L");
    expect(maskNric("PAYNOW TO S4597193L SALARY")).toBe("PAYNOW TO *****193L SALARY");
    // A company's UEN is not a person's number and stays.
    expect(maskNric("UEN 202134890G")).toBe("UEN 202134890G");
  });
});

describe("pass types and ages", () => {
  it.each([
    ["SC", "citizen"],
    ["Citizen", "citizen"],
    ["PR", "pr"],
    ["EP", "employment_pass"],
    ["S Pass", "s_pass"],
    ["WP", "work_permit"],
    ["Work Permit", "work_permit"],
  ] as const)("%s is %s", (raw, pass) => {
    expect(passTypeOf(raw)).toBe(pass);
  });

  it("names nothing it does not know", () => {
    expect(passTypeOf("EP - no CPF")).toBeNull();
    expect(passTypeOf("DP")).toBeNull();
  });

  it("counts whole years to a day", () => {
    expect(ageOn("1976-11-14", "2025-01-01")).toBe(48);
    expect(ageOn("1964-11-11", "2025-11-01")).toBe(60);
    expect(ageOn("1964-11-11", "2025-11-11")).toBe(61);
    expect(ageOn("2030-01-01", "2025-01-01")).toBeNull();
  });
});
