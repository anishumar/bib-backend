// The rule checks' arithmetic (docs/FIN_BUILD_PLAN.md F4): cents as BigInt,
// rates as exact fractions, and every rounding named.
import { describe, expect, it } from "vitest";
import {
  addRates,
  divide,
  fromCents,
  impliedRateMatches,
  percentOf,
  percentOfInDollars,
  rateText,
  sameRate,
  toCents,
  toRate,
} from "../../src/domain/fin/checks-money";

describe("amounts as cents", () => {
  it.each([
    ["46.00", 4600n],
    ["46.0", 4600n],
    ["46", 4600n],
    ["0.05", 5n],
    ["-3488.00", -348800n],
    ["7400.000", 740000n],
    [" 12.5 ", 1250n],
  ] as const)("%s is %s cents", (text, cents) => {
    expect(toCents(text)).toBe(cents);
  });

  it("refuses what cannot be compared to the cent, rather than rounding it", () => {
    expect(toCents("6.625")).toBeNull();
    expect(toCents("1,000.00")).toBeNull();
    expect(toCents("S$5")).toBeNull();
    expect(toCents("")).toBeNull();
    expect(toCents(null)).toBeNull();
  });

  it("writes cents back as the product's decimal string", () => {
    expect(fromCents(4600n)).toBe("46.00");
    expect(fromCents(5n)).toBe("0.05");
    expect(fromCents(-348800n)).toBe("-3488.00");
    expect(fromCents(-5n)).toBe("-0.05");
    expect(fromCents(0n)).toBe("0.00");
  });

  it("adds exactly where floating point does not", () => {
    // 0.1 + 0.2 in a JS number is 0.30000000000000004.
    expect(fromCents((toCents("0.10") ?? 0n) + (toCents("0.20") ?? 0n))).toBe("0.30");
  });
});

describe("rates in percent, exactly", () => {
  it("reads and writes a percentage", () => {
    expect(toRate("9")).toEqual({ units: 9n, scale: 0 });
    expect(toRate("15.5")).toEqual({ units: 155n, scale: 1 });
    expect(toRate("9.00")).toEqual({ units: 9n, scale: 0 });
    expect(toRate("0.25")).toEqual({ units: 25n, scale: 2 });
    expect(toRate("-9")).toBeNull();
    expect(toRate("nine")).toBeNull();
    expect(rateText({ units: 155n, scale: 1 })).toBe("15.5");
    expect(rateText({ units: 25n, scale: 2 })).toBe("0.25");
    expect(rateText({ units: 9n, scale: 0 })).toBe("9");
  });

  it("compares and adds at a common scale", () => {
    const nine = toRate("9");
    const ninePoint = toRate("9.0");
    if (nine === null || ninePoint === null) throw new Error("unreadable");
    expect(sameRate(nine, ninePoint)).toBe(true);
    expect(sameRate(nine, { units: 8n, scale: 0 })).toBe(false);
    expect(rateText(addRates({ units: 155n, scale: 1 }, { units: 17n, scale: 0 }))).toBe("32.5");
  });
});

describe("rounding, named every time", () => {
  it("half away from zero, both signs", () => {
    expect(divide(5n, 2n, "half_away_from_zero")).toBe(3n);
    expect(divide(-5n, 2n, "half_away_from_zero")).toBe(-3n);
    expect(divide(4n, 3n, "half_away_from_zero")).toBe(1n);
    expect(divide(-4n, 3n, "half_away_from_zero")).toBe(-1n);
  });

  it("down, toward minus infinity", () => {
    expect(divide(5n, 2n, "down")).toBe(2n);
    expect(divide(-5n, 2n, "down")).toBe(-3n);
  });

  it("refuses a divisor that is not positive", () => {
    expect(() => divide(1n, 0n, "down")).toThrow(RangeError);
  });

  it("GST to the cent: the pack's own figures", () => {
    const nine = { units: 9n, scale: 0 };
    expect(fromCents(percentOf(57500n, nine, "half_away_from_zero"))).toBe("51.75");
    // A restaurant bill: 9% of the subtotal PLUS service charge.
    expect(fromCents(percentOf(16877n, nine, "half_away_from_zero"))).toBe("15.19");
    // A credit note, negative.
    expect(fromCents(percentOf(-320000n, nine, "half_away_from_zero"))).toBe("-288.00");
  });

  it("CPF to the dollar: the total rounded, the employee's share down", () => {
    // 37% of S$7,400 is S$2,738; 20% is S$1,480.
    expect(fromCents(percentOfInDollars(740000n, { units: 37n, scale: 0 }, "half_away_from_zero"))).toBe("2738.00");
    // 32.5% of S$3,550 is S$1,153.75: S$1,154. 17% is S$603.50: S$603.
    expect(fromCents(percentOfInDollars(355000n, { units: 325n, scale: 1 }, "half_away_from_zero"))).toBe("1154.00");
    expect(fromCents(percentOfInDollars(355000n, { units: 17n, scale: 0 }, "down"))).toBe("603.00");
    // Exactly fifty cents is an additional dollar.
    expect(fromCents(percentOfInDollars(150n, { units: 100n, scale: 0 }, "half_away_from_zero"))).toBe("2.00");
  });
});

describe("a summary's rate, to a hundredth of a percent", () => {
  const nine = { units: 9n, scale: 0 };
  it("holds a day's POS whose GST drifted by cents", () => {
    // C-POS-2025-01: 11,638.43 on 129,315.82 is 9.00001%.
    expect(impliedRateMatches(1163843n, 12931582n, nine)).toBe(true);
    expect(impliedRateMatches(1266334n, 14070407n, nine)).toBe(true);
  });

  it("does not hold 8% charged, or a rate a hundredth out", () => {
    expect(impliedRateMatches(1034526n, 12931582n, nine)).toBe(false);
    // 9.01% on 100,000.00
    expect(impliedRateMatches(901000n, 10000000n, nine)).toBe(false);
  });

  it("answers a zero base only for zero GST", () => {
    expect(impliedRateMatches(0n, 0n, nine)).toBe(true);
    expect(impliedRateMatches(100n, 0n, nine)).toBe(false);
  });
});
