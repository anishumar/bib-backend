// The words of a pattern finding (docs/FIN_BUILD_PLAN.md F5.3), written at READ
// time from the stored facts, never stored as a sentence.
import { describe, expect, it } from "vitest";
import type { KeyedSummary } from "../../src/domain/fin/pattern";
import { patternFindings } from "../../src/domain/fin/pattern-checks";
import { SUGGESTED_PATTERN_SETTINGS } from "../../src/domain/fin/pattern-settings";
import {
  currencyPrefix,
  explainPatternFinding,
  formatCompact,
  formatFull,
  formatMonth,
  formatRange,
  formatRatio,
} from "../../src/domain/fin/pattern-text";

const vendor = { counterpartyName: "Vendor X" };

describe("the spike sentence, end to end from summaries", () => {
  it("reads exactly as the plan writes it", () => {
    const months: Record<string, string> = {
      "2025-01": "21000",
      "2025-02": "23000",
      "2025-03": "24000",
      "2025-04": "25000",
      "2025-05": "27000",
      "2025-06": "30000",
      "2025-07": "300000",
    };
    const summaries: KeyedSummary[] = Object.entries(months).map(([month, amount]) => ({
      counterpartyKey: "201912345K",
      glAccount: "6100",
      month,
      amount,
      count: 1,
      lineIds: [month],
    }));
    const [f] = patternFindings({
      clientPartyId: "c",
      currency: "SGD",
      month: "2025-07",
      summaries,
      decisions: [],
      settings: SUGGESTED_PATTERN_SETTINGS,
    });
    expect(f).toBeDefined();
    expect(explainPatternFinding(f!, vendor)).toBe(
      "Vendor X: S$300,000 this month; usually S$21k–30k (median S$24.5k over 6 months), 12× normal",
    );
    // The name is the reader's: nothing in the facts carries it.
    expect(JSON.stringify(f!.facts)).not.toContain("Vendor X");
    // A rename reads right in the same finding.
    expect(explainPatternFinding(f!, { counterpartyName: "Vendor X (renamed)" })).toMatch(/^Vendor X \(renamed\): /);
  });
});

describe("the currency symbol", () => {
  it.each([
    ["SGD", "S$"],
    ["sgd", "S$"],
    ["INR", "₹"],
    ["USD", "US$"],
    ["AED", "AED "],
    ["EUR", "EUR "],
  ])("%s → %j", (code, prefix) => {
    expect(currencyPrefix(code)).toBe(prefix);
  });
});

describe("compact amounts", () => {
  it.each([
    ["0", "S$0"],
    ["0.40", "S$0"],
    ["0.50", "S$1"],
    ["750", "S$750"],
    ["999.49", "S$999"],
    ["999.50", "S$1k"],
    ["1000", "S$1k"],
    ["1049", "S$1k"],
    ["1050", "S$1.1k"],
    ["21000", "S$21k"],
    ["24500", "S$24.5k"],
    ["21340", "S$21.3k"],
    ["999940", "S$999.9k"],
    ["999950", "S$1M"],
    ["1000000", "S$1M"],
    ["1250000", "S$1.25M"],
    ["1255000", "S$1.26M"],
    ["12500000", "S$12.5M"],
    ["1250000000", "S$1,250M"],
    ["-1500", "-S$1.5k"],
  ])("%s → %s", (amount, text) => {
    expect(formatCompact(amount, "SGD")).toBe(text);
  });

  it("works on the exact digits, past what a float holds", () => {
    expect(formatCompact("999999999999999.99", "SGD")).toBe("S$1,000,000,000M");
  });

  it("leaves the prefix off the high end of a range, and gives one figure when both ends read the same", () => {
    expect(formatRange("21000", "30000", "SGD")).toBe("S$21k–30k");
    expect(formatRange("9800", "9800", "SGD")).toBe("S$9.8k");
    expect(formatRange("24990", "25010", "SGD")).toBe("S$25k");
    expect(formatRange("800", "1200", "AED")).toBe("AED 800–1.2k");
  });
});

describe("full amounts", () => {
  it.each([
    ["300000", "SGD", "S$300,000"],
    ["300000.00", "SGD", "S$300,000"],
    ["7516.64", "SGD", "S$7,516.64"],
    ["7516.645", "SGD", "S$7,516.65"],
    ["1250000", "INR", "₹12,50,000"],
    ["125000000.5", "INR", "₹12,50,00,000.50"],
    ["5000", "AED", "AED 5,000"],
    ["5000", "JPY", "JPY 5,000"],
    ["1.2345", "KWD", "KWD 1.235"],
    ["-120", "USD", "-US$120"],
    ["0.004", "SGD", "S$0"],
  ])("%s %s → %s", (amount, currency, text) => {
    expect(formatFull(amount, currency)).toBe(text);
  });
});

describe("ratios and months", () => {
  it.each([
    [12.24, "12×"],
    [10, "10×"],
    [9.96, "10×"],
    [3.45, "3.5×"],
    [3, "3×"],
    [1.7, "1.7×"],
  ])("%d → %s", (ratio, text) => {
    expect(formatRatio(ratio)).toBe(text);
  });

  it("writes a month the way a person reads it", () => {
    expect(formatMonth("2025-03")).toBe("Mar 2025");
    expect(formatMonth("2026-12")).toBe("Dec 2026");
  });
});

describe("a sentence per check", () => {
  const base = { counterpartyKey: "k", month: "2025-08", currency: "SGD", thresholdLevel: 0 };

  it("spike against the same month last year", () => {
    const facts = { ...base, glAccount: "5000", amount: "30000.00", comparedWith: "same_month_last_year", lastYearAmount: "9000.00", ratio: 3.33 };
    expect(explainPatternFinding({ checkKey: "pattern.spike", facts }, { counterpartyName: "Harbour Caterers" })).toBe(
      "Harbour Caterers: S$30,000 this month; S$9k in the same month last year, 3.3× that",
    );
  });

  it("new vendor", () => {
    const facts = { ...base, glAccount: "6130", amount: "12129.00", lineCount: 1, glAccountCount: 1, historyMonths: 3 };
    expect(explainPatternFinding({ checkKey: "pattern.new_vendor", facts }, { counterpartyName: "DevForge Licences Pte Ltd" })).toBe(
      "DevForge Licences Pte Ltd: new vendor, S$12,129 this month (1 bill); none in the previous 3 months",
    );
  });

  it("recurring vendor missing", () => {
    const facts = { ...base, glAccount: "6220", cadence: "monthly", lastSeen: "2025-05", lastAmount: "2053.00", median: "1851.00", monthsSeen: 5, dueGap: 1 };
    expect(explainPatternFinding({ checkKey: "pattern.recurring_missing", facts }, { counterpartyName: "Zenith Forklift Rentals" })).toBe(
      "Zenith Forklift Rentals: no bill this month; usually bills monthly (median S$1.9k), last seen May 2025",
    );
  });

  it("frequency change", () => {
    const facts = { ...base, glAccount: "5100", amount: "107246.00", lineCount: 2, usualCount: 1, cadence: "monthly", median: "64082.00" };
    expect(explainPatternFinding({ checkKey: "pattern.frequency_change", facts }, { counterpartyName: "Apex Civil" })).toBe(
      "Apex Civil: 2 bills this month (S$107,246 in total); usually 1 a month",
    );
  });

  it("GL drift, with the account's name when the reader knows it", () => {
    const facts = { ...base, glAccount: "6210", amount: "4200.00", lineCount: 1, usualGlAccount: "6100", usualMonths: 8, monthsSeen: 9, monthsOnThisAccount: 0 };
    const names: Record<string, string> = { "6100": "Rent", "6210": "Office supplies and pantry" };
    expect(explainPatternFinding({ checkKey: "pattern.gl_drift", facts }, { counterpartyName: "Landlord", accountName: (c) => names[c] ?? null })).toBe(
      "Landlord: S$4,200 coded to 6210 Office supplies and pantry this month; usually coded to 6100 Rent (8 of 9 months)",
    );
    expect(explainPatternFinding({ checkKey: "pattern.gl_drift", facts }, { counterpartyName: "Landlord" })).toBe(
      "Landlord: S$4,200 coded to 6210 this month; usually coded to 6100 (8 of 9 months)",
    );
  });

  it("an old row with missing or wrong facts still reads, never throws", () => {
    expect(explainPatternFinding({ checkKey: "pattern.spike", facts: { amount: 300000 } }, vendor)).toBe(
      "Vendor X: unusually large this month against its own history",
    );
    expect(explainPatternFinding({ checkKey: "pattern.spike", facts: { amount: "300000.00", currency: "SGD" } }, vendor)).toBe(
      "Vendor X: S$300,000 this month; well above usual",
    );
    expect(explainPatternFinding({ checkKey: "pattern.gl_drift", facts: {} }, vendor)).toBe("Vendor X: coded to a different account than usual");
    expect(explainPatternFinding({ checkKey: "pattern.something_new", facts: {} }, { counterpartyName: "  " })).toBe(
      "This vendor: unusual against its own history this month",
    );
  });

  it("writes rupees in lakhs and other currencies by code", () => {
    const facts = { ...base, currency: "INR", glAccount: "6100", amount: "1250000.00", lineCount: 1, glAccountCount: 1, historyMonths: 6 };
    expect(explainPatternFinding({ checkKey: "pattern.new_vendor", facts }, { counterpartyName: "Kavya Tech" })).toBe(
      "Kavya Tech: new vendor, ₹12,50,000 this month (1 bill); none in the previous 6 months",
    );
  });
});
