// The advance and the final bill (auto-invoice, phase 2, 0320) — pure rules,
// tested without a clock or a database.
//
// What is decided here, by the firm and the user (2026-10-01 and 10-02):
//   - every advance is a GST tax invoice: one for the whole letter, or one per
//     service, never both on one letter;
//   - the advance holds NO work (0322): signing starts it, and the advance is
//     chased by reminders (overdue after the firm's days, escalated a week
//     after signing) and a weekly summary at the firm's own weekday and hour;
//   - a one-time service is billed when its job is done, for the BALANCE after
//     the advance; a letter-wide advance comes off the earliest bills first,
//     monthly ones included, BEFORE tax;
//   - an advance left over once the work it covered is finished is given back.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADVANCE_POLICY,
  advancePolicyProblem,
  advanceReminder,
  advanceStage,
  advancesOwed,
  billLineText,
  digestDueOn,
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

describe("advanceStage: where an advance stands", () => {
  const base = { invoiceStatus: "issued" as const, paid: "0", outstanding: "59000.00" };

  it("no invoice yet, or only a cancelled one", () => {
    expect(advanceStage({ ...base, invoiceStatus: null, paid: null, outstanding: null })).toBe("not_raised");
    expect(advanceStage({ ...base, invoiceStatus: "cancelled" })).toBe("not_raised");
  });

  it("drafted but not issued", () => {
    expect(advanceStage({ ...base, invoiceStatus: "draft" })).toBe("on_draft");
  });

  it("issued and nothing paid", () => {
    expect(advanceStage(base)).toBe("unpaid");
  });

  it("a credit note that zeroes it with nothing paid is not a payment (0321)", () => {
    expect(advanceStage({ ...base, paid: "0", outstanding: "0" })).toBe("unpaid");
    expect(advanceStage({ ...base, paid: null, outstanding: "-1.00" })).toBe("unpaid");
    // A correction by credit note, then the rest paid: paid in full.
    expect(advanceStage({ ...base, paid: "53100.00", outstanding: "0" })).toBe("paid");
  });

  it("part paid", () => {
    expect(advanceStage({ ...base, paid: "20000.00", outstanding: "39000.00" })).toBe("part_paid");
  });

  it("paid in full, or overpaid", () => {
    expect(advanceStage({ ...base, paid: "59000.00", outstanding: "0.00" })).toBe("paid");
    expect(advanceStage({ ...base, paid: "60000.00", outstanding: "-1000.00" })).toBe("paid");
  });
});

describe("advanceReminder: when an advance turns overdue, and when the admins hear (0322)", () => {
  // The user's answers for the first firm: a draft after 3 days, unpaid after 15.
  const policy = DEFAULT_ADVANCE_POLICY;
  const signed = "2026-10-05";

  it("a draft counts from signing, and is overdue on the third day", () => {
    const at = (today: string) => advanceReminder({ stage: "on_draft", billOn: signed, issuedOn: null, today, policy });
    expect(at("2026-10-05")).toMatchObject({ pending: true, pendingSince: signed, daysPending: 0, overdue: false });
    expect(at("2026-10-07")).toMatchObject({ daysPending: 2, overdue: false });
    expect(at("2026-10-08")).toMatchObject({ daysPending: 3, overdue: true });
    // My day dates the reminder by the day it turns Overdue.
    expect(at("2026-10-05").overdueOn).toBe("2026-10-08");
  });

  it("no invoice yet reads like a draft: it waits for a person since signing", () => {
    expect(advanceReminder({ stage: "not_raised", billOn: signed, issuedOn: null, today: "2026-10-08", policy })).toMatchObject({
      pendingSince: signed,
      overdue: true,
    });
  });

  it("unpaid counts from the ISSUE, and is overdue on the fifteenth day (Ashish: it comes in 5 to 15 days)", () => {
    const at = (today: string) =>
      advanceReminder({ stage: "unpaid", billOn: signed, issuedOn: "2026-10-07", today, policy });
    expect(at("2026-10-21")).toMatchObject({ pendingSince: "2026-10-07", daysPending: 14, overdue: false });
    expect(at("2026-10-22")).toMatchObject({ daysPending: 15, overdue: true, overdueOn: "2026-10-22" });
    expect(advanceReminder({ stage: "part_paid", billOn: signed, issuedOn: "2026-10-07", today: "2026-10-22", policy }).overdue).toBe(true);
  });

  it("escalates to the admins a week after SIGNING, whatever the step", () => {
    const at = (today: string) =>
      advanceReminder({ stage: "unpaid", billOn: signed, issuedOn: "2026-10-07", today, policy });
    expect(at("2026-10-11").escalated).toBe(false);
    expect(at("2026-10-12").escalated).toBe(true);
  });

  it("a paid advance is not chased", () => {
    expect(advanceReminder({ stage: "paid", billOn: signed, issuedOn: "2026-10-07", today: "2026-12-01", policy })).toEqual({
      pending: false,
      pendingSince: null,
      daysPending: null,
      overdue: false,
      overdueOn: null,
      escalated: false,
    });
  });

  it("follows the firm's own days, not the first firm's", () => {
    const strict = { ...policy, draftOverdueDays: 1, unpaidOverdueDays: 7 };
    expect(advanceReminder({ stage: "on_draft", billOn: signed, issuedOn: null, today: "2026-10-06", policy: strict }).overdue).toBe(true);
    expect(advanceReminder({ stage: "unpaid", billOn: signed, issuedOn: signed, today: "2026-10-12", policy: strict }).overdue).toBe(true);
  });
});

describe("advancePolicyProblem: a firm's numbers", () => {
  it("accepts the defaults and refuses what is out of range", () => {
    expect(advancePolicyProblem(DEFAULT_ADVANCE_POLICY)).toBeNull();
    expect(advancePolicyProblem({ ...DEFAULT_ADVANCE_POLICY, draftOverdueDays: 0 })).toMatch(/draft/);
    expect(advancePolicyProblem({ ...DEFAULT_ADVANCE_POLICY, unpaidOverdueDays: 2.5 })).toMatch(/unpaid/);
    expect(advancePolicyProblem({ ...DEFAULT_ADVANCE_POLICY, digestWeekday: 8 })).toMatch(/Monday/);
    expect(advancePolicyProblem({ ...DEFAULT_ADVANCE_POLICY, digestHour: 24 })).toMatch(/hour/);
  });
});

describe("digestDueOn: is the weekly summary due now, and for which day", () => {
  // Monday 10:00 in Kolkata is 04:30 UTC. 2026-10-05 is a Monday.
  const ist = { timeZone: "Asia/Kolkata", weekday: 1, hour: 10 };

  it("on the firm's day once its hour has come, for the rest of that day", () => {
    expect(digestDueOn({ ...ist, now: "2026-10-05T04:30:00.000Z" })).toBe("2026-10-05");
    expect(digestDueOn({ ...ist, now: "2026-10-05T18:00:00.000Z" })).toBe("2026-10-05");
  });

  it("not before the hour, and not on another day (a missed day is not sent late)", () => {
    expect(digestDueOn({ ...ist, now: "2026-10-05T04:29:00.000Z" })).toBeNull();
    expect(digestDueOn({ ...ist, now: "2026-10-06T06:00:00.000Z" })).toBeNull();
    // 18:30 UTC on Monday is already Tuesday in Kolkata.
    expect(digestDueOn({ ...ist, now: "2026-10-05T18:30:00.000Z" })).toBeNull();
  });

  it("is cut on the firm's day, not Greenwich's", () => {
    // Sunday 20:00 UTC is Monday 01:30 in Kolkata: the day, before the hour.
    expect(digestDueOn({ ...ist, now: "2026-10-04T20:00:00.000Z" })).toBeNull();
    // A firm in New York: Monday at 10:00 there is 14:00 UTC.
    expect(digestDueOn({ timeZone: "America/New_York", weekday: 1, hour: 10, now: "2026-10-05T14:00:00.000Z" })).toBe("2026-10-05");
    expect(digestDueOn({ timeZone: "America/New_York", weekday: 1, hour: 10, now: "2026-10-05T13:59:00.000Z" })).toBeNull();
  });

  it("a firm that chose Friday at 17:00", () => {
    // 2026-10-09 is a Friday; 17:00 in Kolkata is 11:30 UTC.
    expect(digestDueOn({ timeZone: "Asia/Kolkata", weekday: 5, hour: 17, now: "2026-10-09T11:30:00.000Z" })).toBe("2026-10-09");
    expect(digestDueOn({ timeZone: "Asia/Kolkata", weekday: 5, hour: 17, now: "2026-10-12T05:00:00.000Z" })).toBeNull();
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

  it("leaves a cancelled job out (review item 11)", () => {
    // The rest of a group done: billed. Before, one cancelled job stopped the
    // final bill for good.
    expect(finalBillReady({ billingFrequency: "one_time", jobStatuses: ["done", "cancelled"] })).toBe(true);
    expect(finalBillReady({ billingFrequency: "one_time", jobStatuses: ["running", "cancelled"] })).toBe(false);
    // Nothing delivered: never billed automatically (Bill it now decides).
    expect(finalBillReady({ billingFrequency: "one_time", jobStatuses: ["cancelled"] })).toBe(false);
  });
});

describe("mayBillNow: a one-time service with no process", () => {
  const ok = { billingFrequency: "one_time", status: "active", job: null, hasFinalBill: false };

  it("is allowed when no job exists, or its job has no process", () => {
    expect(mayBillNow(ok)).toBeNull();
    expect(mayBillNow({ ...ok, job: { hasProcess: false } })).toBeNull();
  });

  it("is refused when the job has a live process: the bill comes when it is done", () => {
    expect(mayBillNow({ ...ok, job: { hasProcess: true } })).toMatch(/process/);
    expect(mayBillNow({ ...ok, job: { hasProcess: true, cancelled: false } })).toMatch(/process/);
  });

  it("is allowed when every job with a process was cancelled (review item 11)", () => {
    expect(mayBillNow({ ...ok, job: { hasProcess: true, cancelled: true } })).toBeNull();
  });

  it("is refused for recurring work, ended work, or twice; the advance no longer holds it (0322)", () => {
    expect(mayBillNow({ ...ok, billingFrequency: "monthly" })).toMatch(/one-time/);
    expect(mayBillNow({ ...ok, status: "cancelled" })).toMatch(/cancelled/);
    expect(mayBillNow({ ...ok, hasFinalBill: true })).toMatch(/already/);
    expect(mayBillNow({ ...ok, status: "pending_advance" })).toBeNull();
  });
});

describe("billLineText: what the invoice line says", () => {
  const base = {
    serviceName: "Statutory audit FY 2025-26",
    periodLabel: "Final",
    servedDays: 1,
    periodDays: 1,
    letterRef: "EL-2026-0007",
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

  it("a final bill, and the advance it was reduced by, with no amount in the words (0321)", () => {
    expect(billLineText({ ...base, kind: "final" })).toBe("Statutory audit FY 2025-26, final bill");
    const text = billLineText({ ...base, kind: "final", advance: { invoiceNumber: "INV/2026-27/0003" } });
    expect(text).toBe("Statutory audit FY 2025-26, final bill, less advance (INV/2026-27/0003)");
    // The description is read by logins the fee axis hides prices from.
    expect(text).not.toMatch(/\d{1,3}(,\d{2,3})+|\d+\.\d{2}/);
  });
});
