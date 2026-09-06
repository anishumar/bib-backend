// The exact-decimal comparison the credit-note cap now uses.
//
// It exists because the cap was written in JavaScript floats — the one rule
// this codebase states about money, broken on the one check that decides
// whether money may leave a firm. The first case below is the one the audit
// found; the rest are the neighbours that would have hidden it.
import { describe, expect, it } from "vitest";
import { compareAmounts, subtractAmounts } from "../../src/domain/money/model";

describe("subtractAmounts", () => {
  it("does not lose the last paisa the way binary floating point does", () => {
    // 100.10 - 100.00 is 0.09999999999999432 as a JS number, which made a
    // credit note for the whole remaining 0.10 fail its own cap.
    expect(subtractAmounts("100.10", "100.00")).toBe("0.10");
    expect(Number("100.10") - Number("100.00")).not.toBe(0.1);
  });

  it("keeps the wider of the two scales", () => {
    expect(subtractAmounts("10", "0.0001")).toBe("9.9999");
    expect(subtractAmounts("10.5", "0.25")).toBe("10.25");
  });

  it("reads what Postgres prints, not only what a person types", () => {
    // `numeric(15,4)` comes back at full scale: 1 reads as "1.0000".
    expect(subtractAmounts("1.0000", "0.5")).toBe("0.5000");
  });

  it("subtracts to nothing exactly", () => {
    expect(subtractAmounts("0.1", "0.1")).toBe("0.0");
    expect(subtractAmounts("3", "3")).toBe("0");
  });

  it("carries a sign when the answer is negative", () => {
    expect(subtractAmounts("1.00", "1.50")).toBe("-0.50");
  });

  it("holds fifteen integer digits, which is what isAmount allows", () => {
    expect(subtractAmounts("999999999999999.9999", "0.0001")).toBe("999999999999999.9998");
  });
});

describe("compareAmounts", () => {
  it("says equal for the same value written two ways", () => {
    expect(compareAmounts("1499.5", "1499.50")).toBe(0);
    expect(compareAmounts("1", "1.0000")).toBe(0);
  });

  it("orders values a float would tie or invert", () => {
    expect(compareAmounts("0.1", "0.10")).toBe(0);
    expect(compareAmounts("0.3", "0.1")).toBe(1);
    expect(compareAmounts("0.1", "0.3")).toBe(-1);
  });

  it("is exact at the far end of the range", () => {
    // Two amounts a double cannot tell apart: 2^53 is 9007199254740992, so
    // these are the same `number` and different money.
    expect(compareAmounts("900719925474099.2", "900719925474099.3")).toBe(-1);
  });
});
