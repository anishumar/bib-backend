import { describe, expect, it } from "vitest";
import { longDay } from "../../src/domain/day";

describe("longDay", () => {
  it("writes a calendar day the way the rest of the product writes one", () => {
    expect(longDay("2026-08-12")).toBe("12 Aug 2026");
    expect(longDay("2019-06-11")).toBe("11 Jun 2019");
  });

  it("keeps the leading zero, because the front end does", () => {
    // `04 Sep 2026`, not `4 Sep 2026`. A refusal in one format beside a table in
    // another is a second date format, which is the thing this exists to stop.
    expect(longDay("2026-09-04")).toBe("04 Sep 2026");
  });

  it("NEVER builds a Date — the first of January survives every zone", () => {
    // `new Date("2026-01-01")` is UTC midnight and prints as 31 Dec west of
    // Greenwich. Splitting the string cannot have that bug, and three date
    // defects in this product came from not splitting it.
    expect(longDay("2026-01-01")).toBe("01 Jan 2026");
    expect(longDay("2026-12-31")).toBe("31 Dec 2026");
  });

  it("hands back anything that is not a plain calendar day, unchanged", () => {
    // These are ERROR MESSAGES. "already ended on Invalid Date" is worse than
    // "already ended on 2026-8-12" — the raw value at least says what arrived.
    for (const odd of ["", "2026-08", "12/08/2026", "2026-08-12T00:00:00Z", "tomorrow"]) {
      expect(longDay(odd)).toBe(odd);
    }
  });

  it("refuses a month that is not a month rather than inventing one", () => {
    expect(longDay("2026-13-01")).toBe("2026-13-01");
    expect(longDay("2026-00-01")).toBe("2026-00-01");
  });
});
