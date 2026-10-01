// The advance and the final bill (auto-invoice, phase 2, 0320) — pure rules,
// tested without a clock or a database.
//
// What is decided here, by the firm and the user (2026-10-01):
//   - every advance is a GST tax invoice: one for the whole letter, or one per
//     service, never both on one letter;
//   - the work starts when the advance invoice is PAID IN FULL; a part payment
//     starts it only when an admin approves;
//   - a one-time service is billed when its job is done, for the BALANCE after
//     the advance; a letter-wide advance comes off the earliest bills first,
//     monthly ones included, BEFORE tax;
//   - an advance left over once the work it covered is finished is given back.
import { describe, expect, it } from "vitest";
import {
  advanceStartState,
  advancesOwed,
  amountInWords,
  billLineText,
  finalBillReady,
  mayBillNow,
  shouldRefund,
  takeFromAdvance,
} from "../../src/domain/billing/advance";

describe("advancesOwed: the advance bills a signed letter owes", () => {
  const lines = [
    { engagementId: "e1", advanceAmount: null, deptCode: "FRC" },
    { engagementId: "e2", advanceAmount: null, deptCode: "TRC" },
  ];

  it("one bill for the whole letter, covering every service's Dept", () => {
    expect(advancesOwed({ advanceRequired: true, advanceAmount: "50000.0000", lines })).toEqual([
      { engagementId: null, amount: "50000.0000", deptCodes: ["FRC", "TRC"] },
    ]);
  });

  it("one bill per service that has its own advance, and none for the others", () => {
    const perService = [
      { engagementId: "e1", advanceAmount: "10000.0000", deptCode: "FRC" },
      { engagementId: "e2", advanceAmount: null, deptCode: "TRC" },
      { engagementId: "e3", advanceAmount: "5000.0000", deptCode: null },
    ];
    expect(advancesOwed({ advanceRequired: false, advanceAmount: null, lines: perService })).toEqual([
      { engagementId: "e1", amount: "10000.0000", deptCodes: ["FRC"] },
      { engagementId: "e3", amount: "5000.0000", deptCodes: [] },
    ]);
  });

  it("nothing when the letter asks for no advance", () => {
    expect(advancesOwed({ advanceRequired: false, advanceAmount: null, lines })).toEqual([]);
  });
});

describe("takeFromAdvance: FIFO, before tax", () => {
  it("takes the whole bill when the advance covers it", () => {
    expect(takeFromAdvance("50000.0000", "30000.00")).toEqual({
      applied: "30000.00",
      balance: "0.00",
      remaining: "20000.0000",
    });
  });

  it("takes what is left and bills the balance", () => {
    expect(takeFromAdvance("20000.0000", "100000.0000")).toEqual({
      applied: "20000.0000",
      balance: "80000.0000",
      remaining: "0.0000",
    });
  });

  it("takes nothing from an advance already used up", () => {
    expect(takeFromAdvance("0.0000", "30000.00")).toEqual({
      applied: "0",
      balance: "30000.00",
      remaining: "0.0000",
    });
  });

  it("is exact on the digits, never a float", () => {
    expect(takeFromAdvance("100.10", "100.00").remaining).toBe("0.10");
  });
});

describe("advanceStartState: has the work been allowed to start", () => {
  const base = { invoiceStatus: "issued" as const, paid: "0", outstanding: "59000.00", releasedAt: null };

  it("no invoice yet, or only a cancelled one", () => {
    expect(advanceStartState({ ...base, invoiceStatus: null, paid: null, outstanding: null })).toBe("not_raised");
    expect(advanceStartState({ ...base, invoiceStatus: "cancelled" })).toBe("not_raised");
  });

  it("raised but not issued", () => {
    expect(advanceStartState({ ...base, invoiceStatus: "draft" })).toBe("on_draft");
  });

  it("issued and nothing paid", () => {
    expect(advanceStartState(base)).toBe("unpaid");
  });

  it("part paid: an admin decides", () => {
    expect(advanceStartState({ ...base, paid: "20000.00", outstanding: "39000.00" })).toBe("part_paid");
  });

  it("paid in full, or overpaid", () => {
    expect(advanceStartState({ ...base, paid: "59000.00", outstanding: "0.00" })).toBe("paid");
    expect(advanceStartState({ ...base, paid: "60000.00", outstanding: "-1000.00" })).toBe("paid");
  });

  it("started wins over everything: a bounced cheque after the start does not stop the work", () => {
    expect(advanceStartState({ ...base, releasedAt: "2026-10-05T10:00:00.000Z" })).toBe("started");
  });
});

describe("shouldRefund: an advance left over", () => {
  it("is given back once everything it covered is finished", () => {
    expect(shouldRefund({ remaining: "20000.0000", finished: true, waived: false })).toBe(true);
  });

  it("is not while the work goes on: a later bill may still use it", () => {
    expect(shouldRefund({ remaining: "20000.0000", finished: false, waived: false })).toBe(false);
  });

  it("is not when nothing is left, or the firm kept it", () => {
    expect(shouldRefund({ remaining: "0.0000", finished: true, waived: false })).toBe(false);
    expect(shouldRefund({ remaining: "-0.0100", finished: true, waived: false })).toBe(false);
    expect(shouldRefund({ remaining: "20000.0000", finished: true, waived: true })).toBe(false);
  });
});

describe("finalBillReady: a one-time service's final bill", () => {
  it("when its job is done", () => {
    expect(finalBillReady({ billingFrequency: "one_time", jobStatuses: ["done"] })).toBe(true);
  });

  it("not before, and not for recurring work", () => {
    expect(finalBillReady({ billingFrequency: "one_time", jobStatuses: ["running"] })).toBe(false);
    expect(finalBillReady({ billingFrequency: "one_time", jobStatuses: [] })).toBe(false);
    expect(finalBillReady({ billingFrequency: "monthly", jobStatuses: ["done"] })).toBe(false);
  });

  it("a one-time fee group when EVERY service in it is done", () => {
    expect(finalBillReady({ billingFrequency: "one_time", jobStatuses: ["done", "running"] })).toBe(false);
    expect(finalBillReady({ billingFrequency: "one_time", jobStatuses: ["done", "done"] })).toBe(true);
  });
});

describe("mayBillNow: a one-time service with no process", () => {
  const ok = { billingFrequency: "one_time", status: "active", job: null, hasFinalBill: false };

  it("is allowed when no job exists, or its job has no process", () => {
    expect(mayBillNow(ok)).toBeNull();
    expect(mayBillNow({ ...ok, job: { hasProcess: false } })).toBeNull();
  });

  it("is refused when the job has a process: the bill comes when it is done", () => {
    expect(mayBillNow({ ...ok, job: { hasProcess: true } })).toMatch(/process/);
  });

  it("is refused for recurring work, before the advance, or twice", () => {
    expect(mayBillNow({ ...ok, billingFrequency: "monthly" })).toMatch(/one-time/);
    expect(mayBillNow({ ...ok, status: "pending_advance" })).toMatch(/advance/);
    expect(mayBillNow({ ...ok, hasFinalBill: true })).toMatch(/already/);
  });
});

describe("amountInWords: money in an invoice line's text", () => {
  it("groups rupees the Indian way", () => {
    expect(amountInWords("INR", "100000.0000")).toBe("INR 1,00,000.00");
    expect(amountInWords("INR", "1234567.5")).toBe("INR 12,34,567.50");
  });

  it("groups other currencies in thousands", () => {
    expect(amountInWords("USD", "1234567.0000")).toBe("USD 1,234,567.00");
  });

  it("keeps digits beyond two decimals rather than rounding money away", () => {
    expect(amountInWords("USD", "10.1250")).toBe("USD 10.125");
  });
});

describe("billLineText: what the invoice line says", () => {
  const base = {
    serviceName: "Statutory audit FY 2025-26",
    periodLabel: "Final",
    servedDays: 1,
    periodDays: 1,
    letterRef: "EL-2026-0007",
    currency: "INR",
    perService: true,
    advance: null,
  };

  it("a period bill, as phase 1 wrote it", () => {
    expect(
      billLineText({ ...base, kind: "period", serviceName: "Bookkeeping", periodLabel: "Oct 2026", servedDays: 17, periodDays: 31 }),
    ).toBe("Bookkeeping, Oct 2026 (17 of 31 days)");
  });

  it("an advance, for the letter or for one service", () => {
    expect(billLineText({ ...base, kind: "advance", perService: false })).toBe("Advance under EL-2026-0007");
    expect(billLineText({ ...base, kind: "advance" })).toBe("Advance for Statutory audit FY 2025-26 (EL-2026-0007)");
  });

  it("a final bill, and the advance it was reduced by", () => {
    expect(billLineText({ ...base, kind: "final" })).toBe("Statutory audit FY 2025-26, final bill");
    expect(
      billLineText({
        ...base,
        kind: "final",
        advance: { fee: "100000.0000", applied: "50000.0000", invoiceNumber: "INV/2026-27/0003" },
      }),
    ).toBe(
      "Statutory audit FY 2025-26, final bill: fee INR 1,00,000.00 less advance INR 50,000.00 (INV/2026-27/0003)",
    );
  });
});
