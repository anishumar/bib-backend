// Patterns against history, the arithmetic (docs/FIN_BUILD_PLAN.md F5.1):
// exact money, the median and the MAD (a past spike must not move the
// baseline), the robust z, the cadence and the profile row.
import { describe, expect, it } from "vitest";
import {
  NO_ADJUSTMENTS,
  addMonths,
  buildProfile,
  cadenceOf,
  fromMicros,
  lastDayOf,
  madOf,
  medianCount,
  medianOf,
  monthAt,
  monthIndex,
  monthOfDay,
  monthOfYear,
  ratioTo,
  robustZ,
  scaleMicros,
  toMicros,
  toProfileRow,
} from "../../src/domain/fin/pattern";
import type { MonthlySummary } from "../../src/domain/fin/pattern";

const m = (amounts: readonly string[]): bigint[] => amounts.map((a) => toMicros(a));
const dec = (v: bigint | null): string | null => (v === null ? null : fromMicros(v));

function history(byMonth: Record<string, string>): MonthlySummary[] {
  return Object.entries(byMonth).map(([month, amount]) => ({ month, amount, count: 1, lineIds: [`L-${month}`] }));
}

describe("months", () => {
  it("count, add and cut across a year end", () => {
    expect(monthIndex("2025-03") - monthIndex("2024-12")).toBe(3);
    expect(addMonths("2025-11", 3)).toBe("2026-02");
    expect(addMonths("2025-01", -1)).toBe("2024-12");
    expect(monthAt(monthIndex("2025-07"))).toBe("2025-07");
    expect(monthOfYear("2025-12")).toBe(12);
    expect(monthOfDay("2025-03-14")).toBe("2025-03");
  });

  it("know the last day, leap years included", () => {
    expect(lastDayOf("2024-02")).toBe("2024-02-29");
    expect(lastDayOf("2025-02")).toBe("2025-02-28");
    expect(lastDayOf("1900-02")).toBe("1900-02-28");
    expect(lastDayOf("2000-02")).toBe("2000-02-29");
    expect(lastDayOf("2025-04")).toBe("2025-04-30");
    expect(lastDayOf("2025-12")).toBe("2025-12-31");
  });

  it("refuse what is not a month, saying what one looks like", () => {
    expect(() => monthIndex("2025-13")).toThrow(/YYYY-MM/);
    expect(() => monthIndex("2025-3")).toThrow(/YYYY-MM/);
    expect(() => monthOfDay("14/03/2025")).toThrow(/YYYY-MM-DD/);
  });
});

describe("money stays exact (BigInt micro-units)", () => {
  it("round-trips decimal strings without a float", () => {
    expect(fromMicros(toMicros("1499.5"))).toBe("1499.50");
    expect(fromMicros(toMicros("-120"))).toBe("-120.00");
    expect(fromMicros(toMicros("0.0001"))).toBe("0.0001");
    // Fifteen digits: past what a JS number holds exactly in micro-units.
    expect(fromMicros(toMicros("999999999999999.99"))).toBe("999999999999999.99");
  });

  it("refuses a fifth decimal place rather than rounding it away", () => {
    expect(() => toMicros("1.23456")).toThrow(/4 after/);
    expect(() => toMicros("1,000")).toThrow(/decimal string/);
    expect(() => toMicros("")).toThrow();
  });

  it("raises a bar by a whole percentage exactly", () => {
    expect(fromMicros(scaleMicros(toMicros("1000.00"), 150))).toBe("1500.00");
    expect(fromMicros(scaleMicros(toMicros("0.0001"), 250))).toBe("0.00025");
  });
});

describe("the median and the MAD", () => {
  it("take the middle of an odd count and half the two middles of an even one, exactly", () => {
    expect(dec(medianOf(m(["30", "10", "20"])))).toBe("20.00");
    expect(dec(medianOf(m(["21000", "23000", "24000", "25000", "27000", "30000"])))).toBe("24500.00");
    // Half a cent: cents could not hold it, micro-units do.
    expect(dec(medianOf(m(["100.01", "100.02"])))).toBe("100.015");
  });

  it("the MAD is the median distance from the median, exactly", () => {
    const values = m(["21000", "23000", "24000", "25000", "27000", "30000"]);
    // Distances 3500 1500 500 500 2500 5500 → the middle two are 1500 and 2500.
    expect(dec(madOf(values, medianOf(values)))).toBe("2000.00");
    const cents = m(["100.01", "100.02"]);
    expect(dec(madOf(cents, medianOf(cents)))).toBe("0.005");
  });

  it("a past spike does NOT move the baseline (where a mean would be dragged)", () => {
    const calm = m(["24000", "24500", "25000", "25000", "26000"]);
    const withSpike = [...calm, toMicros("300000")];
    expect(medianOf(withSpike)).toBe(medianOf(calm));
    // The MAD moves by the width of one ordinary month at most: 500 → 750.
    expect(dec(madOf(calm, medianOf(calm)))).toBe("500.00");
    expect(dec(madOf(withSpike, medianOf(withSpike)))).toBe("750.00");
    // A mean would have jumped to S$70,750 and hidden the next spike.
    const mean = withSpike.reduce((a, b) => a + b, 0n) / BigInt(withSpike.length);
    expect(fromMicros(mean)).toBe("70750.00");
  });

  it("refuses a median that is not exact (raw values not from toMicros)", () => {
    expect(() => medianOf([1n, 2n])).toThrow(/not exact/);
    expect(() => medianOf([])).toThrow(/no months/);
  });

  it("counts lines with an ordinary median, which may be a half", () => {
    expect(medianCount([1, 1, 2])).toBe(1);
    expect(medianCount([1, 2])).toBe(1.5);
    expect(medianCount([])).toBeNull();
  });
});

describe("the robust z and the ratio (plain numbers, not money)", () => {
  it("scales the MAD by 1.4826 so z reads like standard deviations", () => {
    const median = toMicros("24500");
    const mad = toMicros("2000");
    // σ = 1.4826 × 2000 = 2965.2 (the floor, 0.1 × 24500 = 2450, is lower).
    expect(robustZ(toMicros("30000"), median, mad, 0.1)).toBeCloseTo(5500 / 2965.2, 6);
  });

  it("floors σ at a share of the median, so a flat retainer is not infinitely sensitive", () => {
    const flat = toMicros("9800");
    expect(robustZ(toMicros("9850"), flat, 0n, 0.1)).toBeCloseTo(50 / 980, 6);
    // Without a floor, any move at all is infinite.
    expect(robustZ(toMicros("9850"), flat, 0n, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(robustZ(flat, flat, 0n, 0)).toBe(0);
    expect(robustZ(0n, 0n, 0n, 0.1)).toBe(0);
  });

  it("the ratio needs a positive median", () => {
    expect(ratioTo(toMicros("300000"), toMicros("24500"))).toBeCloseTo(12.2449, 3);
    expect(ratioTo(toMicros("100"), 0n)).toBeNull();
    expect(ratioTo(toMicros("100"), toMicros("-50"))).toBeNull();
  });
});

describe("the cadence, from the months seen", () => {
  it.each([
    [["2025-01", "2025-02", "2025-03"], "monthly"],
    [["2025-01", "2025-02", "2025-03", "2025-05", "2025-06", "2025-07", "2025-08"], "monthly"],
    [["2025-01", "2025-04", "2025-07", "2025-10"], "quarterly"],
    [["2025-01", "2025-04", "2025-08"], "irregular"],
    [["2025-01", "2025-03", "2025-05", "2025-07"], "irregular"],
    [["2025-01", "2025-02"], "irregular"],
    [["2025-01", "2025-02", "2025-05"], "irregular"],
  ] as const)("%j → %s", (months, cadence) => {
    expect(cadenceOf(months)).toBe(cadence);
  });

  it("is the same whatever order the months come in, and counts a month once", () => {
    expect(cadenceOf(["2025-03", "2025-01", "2025-02", "2025-02"])).toBe("monthly");
  });
});

describe("the profile (one client × counterparty × GL account)", () => {
  const base = {
    counterpartyKey: "acme",
    glAccount: "6100",
    asOf: "2025-06",
    lookbackMonths: 12,
    minSpreadRatio: 0.1,
    adjustments: NO_ADJUSTMENTS,
  };

  it("holds the monthly amounts, median, MAD, cadence, first and last seen and the count", () => {
    const p = buildProfile({ ...base, history: history({ "2025-01": "21000", "2025-02": "23000", "2025-03": "24000", "2025-04": "25000", "2025-05": "27000", "2025-06": "30000" }) });
    expect(p).not.toBeNull();
    const row = toProfileRow("client-1", "SGD", p!);
    expect(row).toMatchObject({
      clientPartyId: "client-1",
      counterpartyKey: "acme",
      glAccount: "6100",
      currency: "SGD",
      asOf: "2025-06",
      baselineMonths: 6,
      median: "24500.00",
      mad: "2000.00",
      usualLow: "21000.00",
      usualHigh: "30000.00",
      usualCount: 1,
      cadence: "monthly",
      firstSeen: "2025-01",
      lastSeen: "2025-06",
      monthsSeen: 6,
      lineCount: 6,
      baselineFrom: null,
    });
    expect(row.months[0]).toEqual({ month: "2025-01", amount: "21000.00", count: 1, leftOut: null });
  });

  it("keeps a past spike out of the USUAL range it shows, without dropping it from the history", () => {
    const p = buildProfile({ ...base, history: history({ "2025-01": "24000", "2025-02": "24500", "2025-03": "300000", "2025-04": "25000", "2025-05": "25000", "2025-06": "26000" }) });
    expect(dec(p!.median)).toBe("25000.00");
    expect([dec(p!.usualLow), dec(p!.usualHigh)]).toEqual(["24000.00", "26000.00"]);
    expect(p!.monthsSeen).toBe(6);
  });

  it("looks back only `lookbackMonths`, and adds two summaries of one month together", () => {
    const p = buildProfile({
      ...base,
      lookbackMonths: 3,
      history: [
        ...history({ "2025-02": "999", "2025-04": "100", "2025-05": "200", "2025-06": "300" }),
        { month: "2025-06", amount: "50.50", count: 2, lineIds: ["L-extra"] },
      ],
    });
    expect(p!.months.map((x) => [x.month, fromMicros(x.amount), x.count])).toEqual([
      ["2025-04", "100.00", 1],
      ["2025-05", "200.00", 1],
      ["2025-06", "350.50", 3],
    ]);
    expect(p!.months[2]?.lineIds).toEqual(["L-2025-06", "L-extra"]);
  });

  it("is null for a key with nothing in the window", () => {
    expect(buildProfile({ ...base, history: history({ "2023-01": "100" }) })).toBeNull();
  });

  it("applies a person's adjustments: before a price change, one-offs, seasonal months", () => {
    const p = buildProfile({
      ...base,
      asOf: "2025-12",
      history: history({ "2025-01": "100", "2025-02": "100", "2025-03": "200", "2025-04": "200", "2025-05": "900", "2025-06": "200", "2025-12": "800" }),
      adjustments: { baselineFrom: "2025-03", oneOffMonths: ["2025-05"], seasonalMonthsOfYear: [12] },
    });
    expect(p!.months.map((x) => [x.month, x.leftOut])).toEqual([
      ["2025-01", "before_price_change"],
      ["2025-02", "before_price_change"],
      ["2025-03", null],
      ["2025-04", null],
      ["2025-05", "one_off"],
      ["2025-06", null],
      ["2025-12", "seasonal"],
    ]);
    expect(p!.baseline.map((v) => fromMicros(v))).toEqual(["200.00", "200.00", "200.00"]);
    expect(dec(p!.median)).toBe("200.00");
    expect(toProfileRow("c", "SGD", p!).baselineFrom).toBe("2025-03");
  });
});
