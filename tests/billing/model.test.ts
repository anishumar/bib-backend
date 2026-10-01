// The billing schedule's arithmetic (auto-invoice, phase 1) — pure, and
// tested against the calendar. No clock: every case states its dates.
//
// What is decided here, each by the firm (Ashish, 2026-10-01):
//   - the schedule is a FIRST INVOICE DATE plus the line's frequency, so
//     arrears (Oct's work billed 1 Nov), advance (billed 1 Oct) and a yearly
//     audit billed in October are one rule;
//   - a period cut short by the start, an end or a pause is billed PRO-RATA BY
//     DAYS, so the rule reports days served and days in the period and the
//     database does the money;
//   - revenue belongs to the manager of the client's SPOC for that service.
import { describe, expect, it } from "vitest";
import {
  addMonthsClamped,
  billingDues,
  goesLiveFrom,
  resolveBillingManager,
  scheduleFor,
  servedDays,
  serviceWindowOf,
} from "../../src/domain/billing/model";

const oct = { start: "2026-10-01", end: "2026-10-31", label: "Oct 2026" };
const nov = { start: "2026-11-01", end: "2026-11-30", label: "Nov 2026" };
const dec = { start: "2026-12-01", end: "2026-12-31", label: "Dec 2026" };
const q3 = { start: "2026-10-01", end: "2026-12-31", label: "Q3 FY2026-27" };

const open = { from: "2026-10-01", to: null, pausedFrom: null, pausedTo: null };

describe("addMonthsClamped: the bill date of a later period", () => {
  it("moves a date by whole months", () => {
    expect(addMonthsClamped("2026-11-01", 1)).toBe("2026-12-01");
    expect(addMonthsClamped("2026-11-01", 3)).toBe("2027-02-01");
    expect(addMonthsClamped("2026-10-15", 12)).toBe("2027-10-15");
  });

  it("clamps to the last day of a shorter month rather than spilling into the next", () => {
    expect(addMonthsClamped("2027-01-31", 1)).toBe("2027-02-28");
    expect(addMonthsClamped("2028-01-31", 1)).toBe("2028-02-29");
  });
});

describe("servedDays: how much of a period the firm actually served", () => {
  it("is the whole period when the engagement runs through it", () => {
    expect(servedDays(oct, open)).toBe(31);
  });

  it("starts on the engagement's first day, not the period's", () => {
    expect(servedDays(oct, { ...open, from: "2026-10-15" })).toBe(17);
  });

  it("stops on the last day served, which is inclusive", () => {
    expect(servedDays(q3, { ...open, to: "2026-11-30" })).toBe(61);
  });

  it("leaves out a pause that ended on the resume day", () => {
    // Paused from 15 Nov, resumed 15 Jan: Oct and 1–14 Nov were served.
    const window = { ...open, pausedFrom: "2026-11-15", pausedTo: "2027-01-15" };
    expect(servedDays(q3, window)).toBe(31 + 14);
    expect(servedDays(dec, window)).toBe(0);
  });

  it("treats a pause with no resume yet as running to the end of time", () => {
    expect(servedDays(nov, { ...open, pausedFrom: "2026-11-11" })).toBe(10);
  });

  it("is zero for a period entirely before the start or after the end", () => {
    expect(servedDays(oct, { ...open, from: "2026-11-01" })).toBe(0);
    expect(servedDays(dec, { ...open, to: "2026-11-30" })).toBe(0);
  });
});

describe("billingDues: which periods are due to be billed by today", () => {
  it("bills each month on the first invoice date plus one month per period (arrears)", () => {
    const dues = billingDues({
      periods: [oct, nov, dec],
      spanMonths: 1,
      firstInvoiceOn: "2026-11-01",
      today: "2026-12-05",
      windows: [open],
    });
    expect(dues.map((d) => [d.period.label, d.billOn])).toEqual([
      ["Oct 2026", "2026-11-01"],
      ["Nov 2026", "2026-12-01"],
    ]);
  });

  it("bills at the start of each month when the first invoice is on the first day (advance)", () => {
    const dues = billingDues({
      periods: [oct, nov, dec],
      spanMonths: 1,
      firstInvoiceOn: "2026-10-01",
      today: "2026-11-01",
      windows: [open],
    });
    expect(dues.map((d) => d.period.label)).toEqual(["Oct 2026", "Nov 2026"]);
  });

  it("writes nothing before the first invoice date, which is the client's go-live", () => {
    const dues = billingDues({
      periods: [oct, nov],
      spanMonths: 1,
      firstInvoiceOn: "2026-11-01",
      today: "2026-10-31",
      windows: [open],
    });
    expect(dues).toEqual([]);
  });

  it("reports a full period as full and a cut-short one with its days, for pro-rata", () => {
    const dues = billingDues({
      periods: [oct, nov],
      spanMonths: 1,
      firstInvoiceOn: "2026-11-01",
      today: "2026-12-01",
      windows: [{ ...open, from: "2026-10-15" }],
    });
    expect(dues[0]).toMatchObject({ servedDays: 17, periodDays: 31 });
    expect(dues[1]).toMatchObject({ servedDays: 30, periodDays: 30 });
  });

  it("skips a period nothing was served in: wholly inside a pause, or after the end", () => {
    const dues = billingDues({
      periods: [oct, nov, dec],
      spanMonths: 1,
      firstInvoiceOn: "2026-11-01",
      today: "2027-02-01",
      windows: [{ ...open, to: "2026-11-30" }],
    });
    expect(dues.map((d) => d.period.label)).toEqual(["Oct 2026", "Nov 2026"]);
  });

  it("bills one fee for several services by the service served longest in the period", () => {
    // A fee group: one engagement ran all October, the other started on the
    // 20th. The group's fee was earned for the whole month.
    const dues = billingDues({
      periods: [oct],
      spanMonths: 1,
      firstInvoiceOn: "2026-11-01",
      today: "2026-11-01",
      windows: [open, { ...open, from: "2026-10-20" }],
    });
    expect(dues[0]).toMatchObject({ servedDays: 31, periodDays: 31 });
  });

  it("bills a quarter a quarter apart", () => {
    const q4 = { start: "2027-01-01", end: "2027-03-31", label: "Q4 FY2026-27" };
    const dues = billingDues({
      periods: [q3, q4],
      spanMonths: 3,
      firstInvoiceOn: "2027-01-01",
      today: "2027-04-01",
      windows: [open],
    });
    expect(dues.map((d) => d.billOn)).toEqual(["2027-01-01", "2027-04-01"]);
  });
});

describe("resolveBillingManager: whose kitty a bill goes in", () => {
  const km = { userId: "km", displayName: "Kavya" };

  it("is the manager the client's SPOC reports to", () => {
    const m = resolveBillingManager({
      deptCodes: ["FRC"],
      spocs: [{ userId: "s1", managerUserId: "m1", managerName: "Meera" }],
      keyManager: km,
    });
    expect(m).toEqual({ userId: "m1", how: "spoc_manager", note: null });
  });

  it("is one manager when two SPOCs report to the same person", () => {
    const m = resolveBillingManager({
      deptCodes: ["FRC"],
      spocs: [
        { userId: "s1", managerUserId: "m1", managerName: "Meera" },
        { userId: "s2", managerUserId: "m1", managerName: "Meera" },
      ],
      keyManager: km,
    });
    expect(m.userId).toBe("m1");
  });

  it("falls to the Key Manager, saying why, when the SPOC has nobody above them", () => {
    const m = resolveBillingManager({
      deptCodes: ["FRC"],
      spocs: [{ userId: "s1", managerUserId: null, managerName: null }],
      keyManager: km,
    });
    expect(m).toMatchObject({ userId: "km", how: "key_manager" });
    expect(m.note).toMatch(/reports to/i);
  });

  it("falls to the Key Manager when there is no SPOC for the Dept", () => {
    const m = resolveBillingManager({ deptCodes: ["TRC"], spocs: [], keyManager: km });
    expect(m).toMatchObject({ userId: "km", how: "key_manager" });
    expect(m.note).toMatch(/SPOC/);
  });

  it("falls to the Key Manager when two SPOCs report to different managers", () => {
    const m = resolveBillingManager({
      deptCodes: ["FRC"],
      spocs: [
        { userId: "s1", managerUserId: "m1", managerName: "Meera" },
        { userId: "s2", managerUserId: "m2", managerName: "Mohan" },
      ],
      keyManager: km,
    });
    expect(m).toMatchObject({ userId: "km", how: "key_manager" });
    expect(m.note).toContain("Meera");
    expect(m.note).toContain("Mohan");
  });

  it("falls to the Key Manager when one fee covers services of several Depts", () => {
    const m = resolveBillingManager({
      deptCodes: ["FRC", "TRC"],
      spocs: [{ userId: "s1", managerUserId: "m1", managerName: "Meera" }],
      keyManager: km,
    });
    expect(m).toMatchObject({ userId: "km", how: "key_manager" });
  });

  it("falls to the Key Manager when the service is filed under no Dept", () => {
    const m = resolveBillingManager({ deptCodes: [], spocs: [], keyManager: km });
    expect(m).toMatchObject({ userId: "km", how: "key_manager" });
  });

  it("is nobody, and says so, when there is no Key Manager either", () => {
    const m = resolveBillingManager({ deptCodes: ["FRC"], spocs: [], keyManager: null });
    expect(m).toMatchObject({ userId: null, how: "none" });
    expect(m.note).toMatch(/Key Manager/);
  });
});

describe("serviceWindowOf: the days an engagement was served, from its row", () => {
  const base = {
    status: "active",
    effectiveFrom: "2026-07-01",
    endsOn: null,
    pausedOn: null,
    resumedOn: null,
  };

  it("runs from the first day with no end while active", () => {
    expect(serviceWindowOf(base)).toEqual({ from: "2026-07-01", to: null, pausedFrom: null, pausedTo: null });
  });

  it("ends on the last day served once ended", () => {
    expect(serviceWindowOf({ ...base, status: "completed", endsOn: "2026-11-30" }).to).toBe("2026-11-30");
  });

  it("leaves the pause open while it is paused", () => {
    const w = serviceWindowOf({ ...base, status: "paused", pausedOn: "2026-11-15", resumedOn: "2026-08-01" });
    expect(w).toMatchObject({ pausedFrom: "2026-11-15", pausedTo: null });
  });

  it("closes the pause on the resume day once resumed", () => {
    const w = serviceWindowOf({ ...base, pausedOn: "2026-11-15", resumedOn: "2027-01-15" });
    expect(w).toMatchObject({ pausedFrom: "2026-11-15", pausedTo: "2027-01-15" });
  });

  it("keeps the pause open to the end when it was ended while paused", () => {
    // Resumed once in August, paused again in November and then ended: the
    // August resume says nothing about the November pause.
    const w = serviceWindowOf({
      ...base,
      status: "completed",
      endsOn: "2026-12-31",
      pausedOn: "2026-11-15",
      resumedOn: "2026-08-01",
    });
    expect(w).toMatchObject({ pausedFrom: "2026-11-15", pausedTo: null });
  });

  it("has no pause when none was ever recorded", () => {
    expect(serviceWindowOf({ ...base, resumedOn: "2026-08-01" })).toMatchObject({ pausedFrom: null, pausedTo: null });
  });
});

describe("scheduleFor: the schedule an engagement gets when it goes live (0319)", () => {
  it("bills the period after it ends by default, and when the letter said nothing", () => {
    expect(scheduleFor(oct, "arrears", null)).toEqual({ billingFrom: "2026-10-01", firstInvoiceOn: "2026-11-01" });
    expect(scheduleFor(oct, null, null)).toEqual({ billingFrom: "2026-10-01", firstInvoiceOn: "2026-11-01" });
  });

  it("bills the period on its first day when the letter says in advance", () => {
    expect(scheduleFor(q3, "advance", null)).toEqual({ billingFrom: "2026-10-01", firstInvoiceOn: "2026-10-01" });
  });

  it("bills on the letter's own date when it chose one", () => {
    expect(scheduleFor(oct, "on_date", "2026-11-15")).toEqual({ billingFrom: "2026-10-01", firstInvoiceOn: "2026-11-15" });
  });

  it("rolls over a year end", () => {
    expect(scheduleFor(dec, "arrears", null).firstInvoiceOn).toBe("2027-01-01");
  });
});

describe("goesLiveFrom: which day the first billed period must contain", () => {
  it("is the later of the engagement's first day and the day billing went live", () => {
    // A letter backdated to July, signed in October: July to September were
    // billed by hand, so October is the first period billed.
    expect(goesLiveFrom("2026-07-01", "2026-10-15")).toBe("2026-10-15");
    // Signed ahead of a start in December.
    expect(goesLiveFrom("2026-12-01", "2026-10-15")).toBe("2026-12-01");
  });
});
