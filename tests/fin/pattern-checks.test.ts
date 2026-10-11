// The pattern checks (docs/FIN_BUILD_PLAN.md F5.2) and their gate (F5.5): one
// client's month against its own past, lane `pattern`, money facts as decimal
// strings, a dedupe key that a re-run reproduces.
import { describe, expect, it } from "vitest";
import type { FindingDraft } from "../../src/domain/fin/finding";
import type { KeyedSummary } from "../../src/domain/fin/pattern";
import { historyMonthsBefore, patternFindings } from "../../src/domain/fin/pattern-checks";
import type { PatternRun } from "../../src/domain/fin/pattern-checks";
import { SUGGESTED_PATTERN_SETTINGS, patternSettingsProblems } from "../../src/domain/fin/pattern-settings";
import type { PatternSettings } from "../../src/domain/fin/pattern-settings";

const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const S: PatternSettings = SUGGESTED_PATTERN_SETTINGS;

/** One key's summaries: `{ "2025-01": "100" }`, or `["100", 2]` for 2 bills. */
function key(counterpartyKey: string, glAccount: string, byMonth: Record<string, string | readonly [string, number]>): KeyedSummary[] {
  return Object.entries(byMonth).map(([month, v]) => {
    const [amount, count] = typeof v === "string" ? [v, 1] : v;
    return {
      counterpartyKey,
      glAccount,
      month,
      amount,
      count,
      lineIds: Array.from({ length: count }, (_, i) => `${counterpartyKey}-${month}-${String(i + 1)}`),
    };
  });
}

function check(summaries: readonly KeyedSummary[], month: string, over: Partial<PatternRun> = {}): FindingDraft[] {
  return patternFindings({ clientPartyId: CLIENT, currency: "SGD", month, summaries, decisions: [], settings: S, ...over });
}

const only = (findings: readonly FindingDraft[], checkKey: string): FindingDraft[] => findings.filter((f) => f.checkKey === checkKey);

/** Six calm months of Vendor X (S$21k–30k, median S$24.5k) and a steady rent. */
const vendorX = key("vendor-x", "6100", {
  "2025-01": "21000",
  "2025-02": "23000",
  "2025-03": "24000",
  "2025-04": "25000",
  "2025-05": "27000",
  "2025-06": "30000",
});
const MONTHS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];
/** A rent billed every month of the year (months after the one checked are ignored). */
const rent = key("landlord", "6110", Object.fromEntries(MONTHS.map((mm) => [`2025-${mm}`, "9800"])));
/** A flat retainer billed January to July only. */
const retainer = key("retainer", "6115", Object.fromEntries(MONTHS.slice(0, 7).map((mm) => [`2025-${mm}`, "9800"])));

describe("the gate (F5.5): nothing until 3 months of committed history", () => {
  const spikeIn = (month: string): KeyedSummary[] => [...key("vendor-x", "6100", { [month]: "300000" })];

  it("raises no pattern finding for a client with 2 months of history", () => {
    const summaries = [...key("vendor-x", "6100", { "2025-01": "25000", "2025-02": "25000" }), ...spikeIn("2025-03"), ...key("brand-new", "6200", { "2025-03": "50000" })];
    expect(historyMonthsBefore(summaries, "2025-03")).toBe(2);
    expect(check(summaries, "2025-03")).toEqual([]);
  });

  it("switches on with the third month (here: a new vendor; the key itself still needs 3 baseline months to spike)", () => {
    const summaries = [
      ...key("vendor-x", "6100", { "2025-01": "25000", "2025-02": "25000", "2025-03": "25000", "2025-04": "25000" }),
      ...key("brand-new", "6200", { "2025-04": "50000" }),
    ];
    expect(historyMonthsBefore(summaries, "2025-04")).toBe(3);
    expect(check(summaries, "2025-04").map((f) => f.checkKey)).toEqual(["pattern.new_vendor"]);
  });

  it("counts months with any committed line, not calendar months since the first", () => {
    const summaries = [...key("a", "6100", { "2025-01": "100", "2025-05": "100" }), ...key("b", "6100", { "2025-06": "5000" })];
    expect(historyMonthsBefore(summaries, "2025-06")).toBe(2);
    expect(check(summaries, "2025-06")).toEqual([]);
  });
});

describe("spike", () => {
  it("flags Vendor X at S$300k against S$21k–30k, with exact facts", () => {
    const [f, ...rest] = check([...vendorX, ...key("vendor-x", "6100", { "2025-07": "300000" })], "2025-07");
    expect(rest).toEqual([]);
    expect(f).toEqual({
      lane: "pattern",
      checkKey: "pattern.spike",
      clientPartyId: CLIENT,
      periodStart: "2025-07-01",
      periodEnd: "2025-07-31",
      lineIds: ["vendor-x-2025-07-1"],
      facts: {
        counterpartyKey: "vendor-x",
        glAccount: "6100",
        month: "2025-07",
        currency: "SGD",
        thresholdLevel: 0,
        amount: "300000.00",
        lineCount: 1,
        comparedWith: "baseline",
        lastYearAmount: null,
        median: "24500.00",
        mad: "2000.00",
        usualLow: "21000.00",
        usualHigh: "30000.00",
        baselineMonths: 6,
        ratio: 12.24,
        robustZ: 92.9,
      },
      dedupeKey: `pattern.spike:${CLIENT}:2025-07:vendor-x:6100`,
    });
  });

  it("fires on the ratio alone (> 3× the median) when the spread is wide", () => {
    const wide = key("wide", "5000", { "2025-01": "1000", "2025-02": "9000", "2025-03": "5000", "2025-04": "2000", "2025-05": "8000" });
    const [f] = check([...wide, ...key("wide", "5000", { "2025-06": "16000" })], "2025-06");
    expect(f?.checkKey).toBe("pattern.spike");
    expect(f?.facts.ratio).toBe(3.2);
    expect(f?.facts.robustZ).toBeLessThan(6);
  });

  it("fires on the z alone (> 6) when the months are tight", () => {
    const tight = key("tight", "6120", { "2025-01": "10000", "2025-02": "10100", "2025-03": "9900", "2025-04": "10000", "2025-05": "10050" });
    // σ is floored at 0.1 × 10,000 = 1,000: S$17,000 is z 7, 1.7× the median.
    const [f] = check([...tight, ...key("tight", "6120", { "2025-06": "17000" })], "2025-06");
    expect(f?.checkKey).toBe("pattern.spike");
    expect(f?.facts.robustZ).toBe(7);
    expect(f?.facts.ratio).toBe(1.7);
  });

  it("does not fire within normal variation, on a drop, or below materiality", () => {
    expect(check([...vendorX, ...key("vendor-x", "6100", { "2025-07": "32000" })], "2025-07")).toEqual([]);
    expect(check([...vendorX, ...key("vendor-x", "6100", { "2025-07": "1500" })], "2025-07")).toEqual([]);
    const small = key("small", "6120", { "2025-01": "90", "2025-02": "95", "2025-03": "92", "2025-04": "900" });
    expect(only(check(small, "2025-04"), "pattern.spike")).toEqual([]);
    expect(only(check(small, "2025-04", { settings: { ...S, materiality: "500.00" } }), "pattern.spike")).toHaveLength(1);
  });

  it("needs 3 baseline months for the KEY, even once the client is past the gate", () => {
    const summaries = [...rent, ...key("young", "6200", { "2025-05": "1000", "2025-06": "1000", "2025-07": "50000" })];
    expect(only(check(summaries, "2025-07"), "pattern.spike")).toEqual([]);
    const older = [...rent, ...key("young", "6200", { "2025-04": "1000", "2025-05": "1000", "2025-06": "1000", "2025-07": "50000" })];
    expect(only(check(older, "2025-07"), "pattern.spike")).toHaveLength(1);
  });

  it("is not moved by a past spike: the next one is still flagged, against the calm months", () => {
    const withPast = key("v", "6100", { "2025-01": "24000", "2025-02": "24500", "2025-03": "300000", "2025-04": "25000", "2025-05": "25000", "2025-06": "26000" });
    const [f] = check([...withPast, ...key("v", "6100", { "2025-07": "300000" })], "2025-07");
    expect(f?.checkKey).toBe("pattern.spike");
    expect(f?.facts.median).toBe("25000.00");
    expect([f?.facts.usualLow, f?.facts.usualHigh]).toEqual(["24000.00", "26000.00"]);
  });

  it("a flat retainer is not flagged for a small change (the σ floor), only for a big one", () => {
    expect(check([...retainer, ...key("retainer", "6115", { "2025-08": "10500" })], "2025-08")).toEqual([]);
    const [f] = check([...retainer, ...key("retainer", "6115", { "2025-08": "17000" })], "2025-08");
    expect(f?.checkKey).toBe("pattern.spike");
    expect(f?.facts.mad).toBe("0.00");
  });
});

describe("new vendor", () => {
  it("flags a counterparty never seen, above materiality, once across its accounts", () => {
    const summaries = [...rent, ...key("devforge", "6130", { "2025-08": "8000" }), ...key("devforge", "1600", { "2025-08": "4129" })];
    const [f, ...rest] = check(summaries, "2025-08");
    expect(rest).toEqual([]);
    expect(f?.checkKey).toBe("pattern.new_vendor");
    expect(f?.facts).toMatchObject({ counterpartyKey: "devforge", glAccount: null, amount: "12129.00", lineCount: 2, glAccountCount: 2, historyMonths: 7 });
    expect(f?.lineIds).toEqual(["devforge-2025-08-1", "devforge-2025-08-1"]);
    expect(f?.dedupeKey).toBe(`pattern.new_vendor:${CLIENT}:2025-08:devforge:*`);
  });

  it("names the account when there is one, and stays quiet below materiality", () => {
    const [f] = check([...rent, ...key("shield", "6170", { "2025-08": "3125" })], "2025-08");
    expect(f?.facts.glAccount).toBe("6170");
    expect(check([...rent, ...key("taxi", "6190", { "2025-08": "27.27" })], "2025-08")).toEqual([]);
  });

  it("a vendor last seen before the lookback window is new again", () => {
    const summaries = [...key("old", "6100", { "2024-01": "5000" }), ...rent, ...key("old", "6100", { "2025-08": "5000" })];
    expect(check(summaries, "2025-08").map((f) => f.checkKey)).toEqual(["pattern.new_vendor"]);
  });
});

describe("recurring vendor missing", () => {
  const telecom = key("telco", "6120", { "2025-01": "1500", "2025-02": "1600", "2025-03": "1550", "2025-04": "1500" });

  it("flags a monthly biller with no bill this month, with no line ids", () => {
    const [f] = check([...rent, ...telecom], "2025-05");
    expect(f).toMatchObject({
      checkKey: "pattern.recurring_missing",
      lineIds: [],
      facts: { counterpartyKey: "telco", glAccount: "6120", cadence: "monthly", lastSeen: "2025-04", lastAmount: "1500.00", median: "1525.00", monthsSeen: 4, dueGap: 1 },
    });
  });

  it("flags once per stop, not every month after", () => {
    expect(only(check([...rent, ...telecom], "2025-06"), "pattern.recurring_missing")).toEqual([]);
  });

  it("judges a quarterly biller on its own cadence, with grace when asked", () => {
    const pest = key("pest", "6300", { "2024-10": "1420", "2025-01": "1420", "2025-04": "1420" });
    const summaries = [...rent, ...pest];
    expect(only(check(summaries, "2025-06"), "pattern.recurring_missing")).toEqual([]);
    expect(only(check(summaries, "2025-07"), "pattern.recurring_missing")).toHaveLength(1);
    const graced = { settings: { ...S, missingGraceMonths: 1 } };
    expect(only(check(summaries, "2025-07", graced), "pattern.recurring_missing")).toEqual([]);
    expect(only(check(summaries, "2025-08", graced), "pattern.recurring_missing")).toHaveLength(1);
  });

  it("is not raised for an irregular vendor, a small one, or one that billed on another account", () => {
    const irregular = key("ad-hoc", "6150", { "2025-01": "5000", "2025-03": "5000", "2025-06": "5000" });
    expect(only(check([...rent, ...irregular], "2025-07"), "pattern.recurring_missing")).toEqual([]);
    const tiny = key("gateway", "6270", { "2025-01": "90", "2025-02": "95", "2025-03": "92", "2025-04": "93" });
    expect(only(check([...rent, ...tiny], "2025-05"), "pattern.recurring_missing")).toEqual([]);
    const moved = [...rent, ...telecom, ...key("telco", "6130", { "2025-05": "1500" })];
    expect(check(moved, "2025-05").map((f) => f.checkKey)).toEqual(["pattern.gl_drift"]);
  });
});

describe("frequency change", () => {
  it("flags two bills in a month from a vendor who bills once a month", () => {
    const summaries = [...rent, ...key("apex", "5100", { "2025-05": "60000", "2025-06": "62000", "2025-07": "61000", "2025-08": ["120000", 2] })];
    const found = check(summaries, "2025-08");
    const [f] = only(found, "pattern.frequency_change");
    expect(f?.facts).toMatchObject({ lineCount: 2, usualCount: 1, cadence: "monthly", amount: "120000.00", median: "61000.00" });
    expect(f?.lineIds).toEqual(["apex-2025-08-1", "apex-2025-08-2"]);
  });

  it("does not flag a vendor who usually bills twice, nor an irregular one", () => {
    const twice = key("produce", "5000", { "2025-01": ["2800", 2], "2025-02": ["2500", 2], "2025-03": ["2600", 2], "2025-04": ["4200", 3] });
    expect(only(check(twice, "2025-04"), "pattern.frequency_change")).toEqual([]);
    const irregular = key("ad-hoc", "6150", { "2025-01": "5000", "2025-03": "5000", "2025-06": "5000", "2025-08": ["10000", 2] });
    expect(only(check([...rent, ...irregular], "2025-08"), "pattern.frequency_change")).toEqual([]);
  });
});

describe("GL drift", () => {
  it("flags a vendor coded to an account it was never coded to", () => {
    const summaries = [...rent, ...key("landlord", "6210", { "2025-08": "4200" })];
    const [f] = only(check(summaries, "2025-08"), "pattern.gl_drift");
    expect(f?.facts).toMatchObject({
      counterpartyKey: "landlord",
      glAccount: "6210",
      usualGlAccount: "6110",
      usualMonths: 7,
      monthsSeen: 7,
      monthsOnThisAccount: 0,
      amount: "4200.00",
    });
    expect(f?.dedupeKey).toBe(`pattern.gl_drift:${CLIENT}:2025-08:landlord:6210`);
  });

  it("flags a second miscoding to the same account again, until the account is usual (3 months)", () => {
    const once = [...rent, ...key("landlord", "6210", { "2025-03": "4200", "2025-08": "4200" })];
    expect(only(check(once, "2025-08"), "pattern.gl_drift")[0]?.facts.monthsOnThisAccount).toBe(1);
    const usual = [...rent, ...key("landlord", "6210", { "2025-03": "4200", "2025-04": "4200", "2025-05": "4200", "2025-08": "4200" })];
    expect(only(check(usual, "2025-08"), "pattern.gl_drift")).toEqual([]);
  });

  it("needs an established coding (3 months on one account) before anything is a drift", () => {
    const young = [...rent, ...key("newish", "6100", { "2025-06": "3000", "2025-07": "3000" }), ...key("newish", "6200", { "2025-08": "3000" })];
    expect(only(check(young, "2025-08"), "pattern.gl_drift")).toEqual([]);
  });
});

describe("every finding", () => {
  const busy = [
    ...vendorX,
    ...key("vendor-x", "6100", { "2025-07": "300000" }),
    ...rent,
    ...key("devforge", "6130", { "2025-07": "12129" }),
    ...key("telco", "6120", { "2025-01": "1500", "2025-02": "1600", "2025-03": "1550", "2025-04": "1500", "2025-05": "1500", "2025-06": "1500" }),
    ...key("landlord", "6210", { "2025-07": "4200" }),
  ];

  it("is in the pattern lane, with money facts as decimal strings", () => {
    const found = check(busy, "2025-07");
    expect(found.length).toBeGreaterThan(3);
    for (const f of found) {
      expect(f.lane).toBe("pattern");
      for (const k of ["amount", "median", "mad", "usualLow", "usualHigh", "lastAmount", "lastYearAmount"]) {
        const v = f.facts[k];
        if (v !== undefined && v !== null) expect(v).toMatch(/^-?\d+\.\d{2,6}$/);
      }
    }
  });

  it("comes out in a fixed order, and a re-run gives the same findings and keys", () => {
    const a = check(busy, "2025-07");
    const b = check([...busy].reverse(), "2025-07");
    expect(b).toEqual(a);
    expect(a.map((f) => f.checkKey)).toEqual(["pattern.spike", "pattern.new_vendor", "pattern.recurring_missing", "pattern.gl_drift"]);
    expect(new Set(a.map((f) => f.dedupeKey)).size).toBe(a.length);
  });

  it("ignores months after the one checked, so a replay may pass the whole year", () => {
    const later = [...busy, ...key("future", "6100", { "2025-09": "999999" })];
    expect(check(later, "2025-07")).toEqual(check(busy, "2025-07"));
  });

  it("escapes a colon in a key, so two findings cannot share a dedupe key", () => {
    const summaries = [...rent, ...key("a:b", "6100", { "2025-08": "5000" }), ...key("a", "b:6100", { "2025-08": "5000" })];
    const keys = check(summaries, "2025-08").map((f) => f.dedupeKey);
    expect(keys).toContain(`pattern.new_vendor:${CLIENT}:2025-08:a%3Ab:6100`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("the settings", () => {
  it("the suggested ones are usable", () => {
    expect(patternSettingsProblems(SUGGESTED_PATTERN_SETTINGS)).toEqual([]);
  });

  it("a bad value is refused by name, with what is allowed", () => {
    const bad = { ...S, materiality: "1,000", spikeRatio: 1, learning: { ...S.learning, raiseAtShare: 0.4 } };
    const problems = patternSettingsProblems(bad);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/^materiality is "1,000"; it must be a non-negative decimal string/);
    expect(() => patternFindings({ clientPartyId: CLIENT, currency: "SGD", month: "2025-07", summaries: busyless(), decisions: [], settings: bad })).toThrow(
      /pattern settings refused: materiality/,
    );
  });
});

function busyless(): KeyedSummary[] {
  return [...rent];
}
