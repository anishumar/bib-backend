// The billing desk (auto-invoice, phase 1): what a manager does with a bill
// due. Raise it (the invoice is drafted from it), link it to an invoice raised
// by hand, or skip it with a reason; and set an engagement's schedule. Against
// fakes; the SQL half is `desk.integration.test.ts`.
import { describe, expect, it } from "vitest";
import { BillingDeskService } from "../../src/usecase/billing/desk";
import {
  FakeAutoBillingSetting,
  FakeBillingDueDesk,
  FakeBillingSchedules,
  FakeFiscalYearSource,
  FakeInvoiceDrafter,
} from "../../src/testfakes/billing";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import type { BillingDueRecord, ScheduleRecord } from "../../src/usecase/billing/ports";
import type { Actor } from "../../src/domain/ledger/model";

const FIRM = "00000000-0000-4000-8000-00000000c001";
const CLIENT = "00000000-0000-4000-8000-00000000c002";
const OTHER_CLIENT = "00000000-0000-4000-8000-00000000c003";
const ISSUER = "00000000-0000-4000-8000-00000000c004";
const ENG = "00000000-0000-4000-8000-00000000c005";
const ENG2 = "00000000-0000-4000-8000-00000000c006";
const GROUP = "00000000-0000-4000-8000-00000000c007";
const MANAGER = "00000000-0000-4000-8000-00000000c008";
const OTHER_MANAGER = "00000000-0000-4000-8000-00000000c009";
const DIRECTOR = "00000000-0000-4000-8000-00000000c00a";
const LETTER = "00000000-0000-4000-8000-00000000c00b";
const ME: Actor = { type: "human", id: MANAGER };

let dueN = 0;
function due(over: Partial<BillingDueRecord> = {}): BillingDueRecord {
  dueN += 1;
  return {
    id: `00000000-0000-4000-8000-0000000d${String(dueN).padStart(4, "0")}`,
    party: { id: CLIENT, displayName: "Kaveri Foods" },
    issuer: { id: ISSUER, displayName: "10x Global" },
    currency: "INR",
    engagementId: ENG,
    feeGroupId: null,
    engagementIds: [ENG],
    serviceName: "Bookkeeping",
    entityName: "Kaveri Foods",
    letter: { id: LETTER, ref: "EL-2026-0001", fxRate: "1.0000000000", fxRateDate: "2026-07-01" },
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    periodLabel: "Oct 2026",
    billOn: "2026-11-01",
    fullAmount: "25000.0000",
    amount: "25000.00",
    servedDays: 31,
    periodDays: 31,
    manager: { userId: MANAGER, displayName: "Meera", email: "meera@example.test" },
    managerHow: "spoc_manager",
    managerNote: null,
    managerReportsTo: { userId: DIRECTOR, displayName: "Dev", email: "dev@example.test" },
    status: "open",
    invoice: null,
    skipped: null,
    lastTaxPercent: "18.00",
    ...over,
  };
}

function schedule(over: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    engagementId: ENG,
    party: { id: CLIENT, displayName: "Kaveri Foods" },
    entityName: "Kaveri Foods",
    serviceName: "Bookkeeping",
    letterRef: "EL-2026-0001",
    status: "active",
    effectiveFrom: "2026-07-01",
    endsOn: null,
    billingFrequency: "monthly",
    feeGroup: null,
    billingFrom: null,
    firstInvoiceOn: null,
    ...over,
  };
}

function world(opts: { fiscalYear?: number | null } = {}) {
  const desk = new FakeBillingDueDesk();
  const invoices = new FakeInvoiceDrafter();
  const schedules = new FakeBillingSchedules();
  const setting = new FakeAutoBillingSetting();
  const events = new RecordingEventSink();
  const service = new BillingDeskService({
    desk,
    invoices,
    schedules,
    setting,
    fiscalYears: new FakeFiscalYearSource(opts.fiscalYear === undefined ? 4 : opts.fiscalYear),
    timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
    clock: new FakeClock(new Date("2026-12-05T06:00:00.000Z")),
    events,
  });
  return { desk, invoices, schedules, setting, events, service };
}

describe("raising an invoice from bill dues", () => {
  it("drafts one invoice for the client, company, currency and manager, a line per due", async () => {
    const w = world();
    const oct = due();
    const nov = due({ periodStart: "2026-11-01", periodEnd: "2026-11-30", periodLabel: "Nov 2026", billOn: "2026-12-01" });
    w.desk.rows.push(oct, nov);

    const out = await w.service.raise(
      { tenantId: FIRM, dueIds: [nov.id, oct.id], lines: [{ dueId: oct.id, taxPercent: "18" }, { dueId: nov.id, taxPercent: "18" }] },
      ME,
    );

    const [invoice] = w.invoices.invoices;
    expect(invoice).toMatchObject({
      partyId: CLIENT,
      entityPartyId: ISSUER,
      currency: "INR",
      fxRate: "1.0000000000",
      fxRateDate: "2026-07-01",
      managerUserId: MANAGER,
    });
    // In period order, whatever order they were picked in.
    expect(invoice?.lines.map((l) => [l.description, l.unitAmount, l.taxPercent, l.engagementId])).toEqual([
      ["Bookkeeping, Oct 2026", "25000.00", "18", ENG],
      ["Bookkeeping, Nov 2026", "25000.00", "18", ENG],
    ]);
    expect(out).toMatchObject({ invoiceId: invoice?.id, conflicts: [] });
    expect((await w.desk.findMany(FIRM, [oct.id, nov.id])).map((d) => d.status)).toEqual(["drafted", "drafted"]);
    expect(w.events.verbs()).toEqual(["billing_due.invoiced", "billing_due.invoiced"]);
    expect(w.events.recorded[0]?.payload).toMatchObject({ invoiceId: invoice?.id, how: "raised" });
  });

  it("says when a period was billed for part of it", async () => {
    const w = world();
    const part = due({ servedDays: 61, periodDays: 92, periodLabel: "Q3 FY2026-27", amount: "19891.30" });
    w.desk.rows.push(part);
    await w.service.raise({ tenantId: FIRM, dueIds: [part.id], lines: [{ dueId: part.id, taxPercent: "18" }] }, ME);
    expect(w.invoices.invoices[0]?.lines[0]).toMatchObject({
      description: "Bookkeeping, Q3 FY2026-27 (61 of 92 days)",
      unitAmount: "19891.30",
    });
  });

  it("bills a fee group under its first engagement, so the invoice can name the letter", async () => {
    const w = world();
    const group = due({ engagementId: null, feeGroupId: GROUP, engagementIds: [ENG, ENG2], serviceName: "Retainer" });
    w.desk.rows.push(group);
    await w.service.raise({ tenantId: FIRM, dueIds: [group.id], lines: [{ dueId: group.id, taxPercent: "18" }] }, ME);
    expect(w.invoices.invoices[0]?.lines[0]?.engagementId).toBe(ENG);
  });

  it("needs an amount for a fee the letter did not fix, and takes the one typed", async () => {
    const w = world();
    const agreed = due({ fullAmount: null, amount: null });
    w.desk.rows.push(agreed);
    await expect(
      w.service.raise({ tenantId: FIRM, dueIds: [agreed.id], lines: [{ dueId: agreed.id, taxPercent: "18" }] }, ME),
    ).rejects.toMatchObject({ code: "DUE_NEEDS_AN_AMOUNT" });
    expect(w.invoices.invoices).toHaveLength(0);

    await w.service.raise(
      { tenantId: FIRM, dueIds: [agreed.id], lines: [{ dueId: agreed.id, amount: "12000", taxPercent: "18" }] },
      ME,
    );
    expect(w.invoices.invoices[0]?.lines[0]?.unitAmount).toBe("12000");
  });

  it("refuses dues of two clients, two currencies or two managers, before drawing a number", async () => {
    for (const [other, code] of [
      [due({ party: { id: OTHER_CLIENT, displayName: "Lotus" } }), "DUES_DO_NOT_SHARE_AN_INVOICE"],
      [due({ currency: "USD" }), "DUES_DO_NOT_SHARE_AN_INVOICE"],
      [due({ manager: { userId: OTHER_MANAGER, displayName: "Mohan", email: "m@example.test" } }), "DUES_OF_DIFFERENT_MANAGERS"],
    ] as const) {
      const w = world();
      const mine = due();
      w.desk.rows.push(mine, other);
      await expect(
        w.service.raise(
          {
            tenantId: FIRM,
            dueIds: [mine.id, other.id],
            lines: [{ dueId: mine.id, taxPercent: "18" }, { dueId: other.id, taxPercent: "18" }],
          },
          ME,
        ),
      ).rejects.toMatchObject({ code });
      expect(w.invoices.invoices).toHaveLength(0);
    }
  });

  it("refuses a due already on an invoice or skipped", async () => {
    const w = world();
    const done = due({ invoice: { id: "00000000-0000-4000-8000-00000000ffff", number: "INV/1", status: "issued" } });
    w.desk.rows.push(done);
    await expect(
      w.service.raise({ tenantId: FIRM, dueIds: [done.id], lines: [{ dueId: done.id, taxPercent: "18" }] }, ME),
    ).rejects.toMatchObject({ code: "BILLING_DUE_NOT_OPEN" });
  });

  it("asks for the rate when the dues come from letters struck at different rates", async () => {
    const w = world();
    const a = due({ currency: "USD", letter: { id: LETTER, ref: "EL-1", fxRate: "83.1000000000", fxRateDate: "2026-07-01" } });
    const b = due({ currency: "USD", letter: { id: LETTER, ref: "EL-2", fxRate: "84.0000000000", fxRateDate: "2026-08-01" } });
    w.desk.rows.push(a, b);
    const lines = [{ dueId: a.id, taxPercent: "0" }, { dueId: b.id, taxPercent: "0" }];
    await expect(w.service.raise({ tenantId: FIRM, dueIds: [a.id, b.id], lines }, ME)).rejects.toMatchObject({
      code: "FX_RATE_NEEDED",
    });
    await w.service.raise({ tenantId: FIRM, dueIds: [a.id, b.id], lines, fxRate: "84.5", fxRateDate: "2026-12-05" }, ME);
    expect(w.invoices.invoices[0]).toMatchObject({ fxRate: "84.5", fxRateDate: "2026-12-05" });
  });

  it("needs a tax rate on every line", async () => {
    const w = world();
    const d = due();
    w.desk.rows.push(d);
    await expect(w.service.raise({ tenantId: FIRM, dueIds: [d.id], lines: [] }, ME)).rejects.toMatchObject({
      code: "INVALID_BILLING_INPUT",
    });
  });
});

describe("skipping and linking", () => {
  it("skips a due with a reason, which stays off the ledger", async () => {
    const w = world();
    const d = due();
    w.desk.rows.push(d);
    await w.service.skip({ tenantId: FIRM, dueId: d.id, reason: "  Waived for the festival month.  " }, ME);
    const [after] = await w.desk.findMany(FIRM, [d.id]);
    expect(after).toMatchObject({ status: "skipped", skipped: { reason: "Waived for the festival month." } });
    expect(w.events.verbs()).toEqual(["billing_due.skipped"]);
    expect(JSON.stringify(w.events.recorded[0])).not.toContain("festival");
  });

  it("refuses a skip with no reason", async () => {
    const w = world();
    const d = due();
    w.desk.rows.push(d);
    await expect(w.service.skip({ tenantId: FIRM, dueId: d.id, reason: "   " }, ME)).rejects.toMatchObject({
      code: "INVALID_BILLING_INPUT",
    });
  });

  it("links a due to an invoice raised by hand for the same client, company and currency", async () => {
    const w = world();
    const d = due();
    w.desk.rows.push(d);
    const manual = await w.invoices.raise(
      { tenantId: FIRM, partyId: CLIENT, entityPartyId: ISSUER, currency: "INR", fxRate: "1", fxRateDate: "2026-11-01" },
      ME,
    );
    await w.service.link({ tenantId: FIRM, dueId: d.id, invoiceId: manual.id }, ME);
    expect((await w.desk.findMany(FIRM, [d.id]))[0]?.status).toBe("drafted");
    expect(w.events.recorded[0]?.payload).toMatchObject({ invoiceId: manual.id, invoiceLineId: null, how: "linked" });
  });

  it("refuses to link an invoice of another client, or one that was cancelled", async () => {
    const w = world();
    const d = due();
    w.desk.rows.push(d);
    const theirs = await w.invoices.raise(
      { tenantId: FIRM, partyId: OTHER_CLIENT, entityPartyId: ISSUER, currency: "INR", fxRate: "1", fxRateDate: "2026-11-01" },
      ME,
    );
    await expect(w.service.link({ tenantId: FIRM, dueId: d.id, invoiceId: theirs.id }, ME)).rejects.toMatchObject({
      code: "INVOICE_DOES_NOT_FIT_DUE",
    });
    const cancelled = await w.invoices.raise(
      { tenantId: FIRM, partyId: CLIENT, entityPartyId: ISSUER, currency: "INR", fxRate: "1", fxRateDate: "2026-11-01" },
      ME,
    );
    const row = w.invoices.invoices.find((i) => i.id === cancelled.id);
    if (row) row.status = "cancelled";
    await expect(w.service.link({ tenantId: FIRM, dueId: d.id, invoiceId: cancelled.id }, ME)).rejects.toMatchObject({
      code: "INVOICE_DOES_NOT_FIT_DUE",
    });
  });

  it("reopens a due whose invoice was cancelled", async () => {
    const w = world();
    const d = due({ invoice: { id: "00000000-0000-4000-8000-00000000eeee", number: "INV/9", status: "issued" } });
    w.desk.rows.push(d);
    w.desk.invoiceStatus.set("00000000-0000-4000-8000-00000000eeee", "cancelled");
    expect((await w.service.list({ tenantId: FIRM })).dues[0]?.status).toBe("open");
  });
});

describe("the list a manager works from", () => {
  it("counts the days since each bill fell due, on the firm's calendar", async () => {
    const w = world();
    w.desk.rows.push(due());
    const { dues } = await w.service.list({ tenantId: FIRM });
    // 5 December in Kolkata, bill date 1 November.
    expect(dues[0]?.daysSinceBillOn).toBe(34);
  });

  it("shows a manager their own dues, and their reports' dues once a week has passed", async () => {
    const w = world();
    const fresh = due({ billOn: "2026-12-01", manager: { userId: OTHER_MANAGER, displayName: "Mohan", email: "m@x" }, managerReportsTo: { userId: DIRECTOR, displayName: "Dev", email: "d@x" } });
    const stale = due({ billOn: "2026-11-01", manager: { userId: OTHER_MANAGER, displayName: "Mohan", email: "m@x" }, managerReportsTo: { userId: DIRECTOR, displayName: "Dev", email: "d@x" } });
    w.desk.rows.push(fresh, stale);
    const director = await w.service.list({ tenantId: FIRM, mineFor: DIRECTOR });
    expect(director.dues.map((d) => d.id)).toEqual([stale.id]);
    expect(director.dues[0]?.escalated).toBe(true);
    const mohan = await w.service.list({ tenantId: FIRM, mineFor: OTHER_MANAGER });
    expect(mohan.dues).toHaveLength(2);
  });
});

describe("an engagement's billing schedule", () => {
  it("sets it from the first period billed, snapped to that period's first day", async () => {
    const w = world();
    w.schedules.rows.push(schedule());
    await w.service.setSchedule(
      { tenantId: FIRM, engagementId: ENG, billingFrom: "2026-10-15", firstInvoiceOn: "2026-11-01" },
      ME,
    );
    expect(w.schedules.rows[0]).toMatchObject({ billingFrom: "2026-10-01", firstInvoiceOn: "2026-11-01" });
    expect(w.events.verbs()).toEqual(["engagement.billing_scheduled"]);
    expect(w.events.recorded[0]?.payload).toEqual({
      billingFrom: "2026-10-01",
      firstInvoiceOn: "2026-11-01",
      previousBillingFrom: null,
      previousFirstInvoiceOn: null,
    });
  });

  it("sets every engagement a fee group prices, together", async () => {
    const w = world();
    w.schedules.rows.push(
      schedule({ feeGroup: { id: GROUP, title: "Retainer" } }),
      schedule({ engagementId: ENG2, feeGroup: { id: GROUP, title: "Retainer" } }),
    );
    w.schedules.groups.set(GROUP, [ENG, ENG2]);
    await w.service.setSchedule(
      { tenantId: FIRM, engagementId: ENG2, billingFrom: "2026-10-01", firstInvoiceOn: "2026-11-01" },
      ME,
    );
    expect(w.schedules.rows.map((r) => r.firstInvoiceOn)).toEqual(["2026-11-01", "2026-11-01"]);
    expect(w.events.verbs()).toEqual(["engagement.billing_scheduled", "engagement.billing_scheduled"]);
  });

  it("refuses one-time work, and a quarter while the firm's year is not set", async () => {
    const once = world();
    once.schedules.rows.push(schedule({ billingFrequency: "one_time" }));
    await expect(
      once.service.setSchedule({ tenantId: FIRM, engagementId: ENG, billingFrom: "2026-10-01", firstInvoiceOn: "2026-11-01" }, ME),
    ).rejects.toMatchObject({ code: "NOT_BILLED_ON_A_SCHEDULE" });

    const noYear = world({ fiscalYear: null });
    noYear.schedules.rows.push(schedule({ billingFrequency: "quarterly" }));
    await expect(
      noYear.service.setSchedule({ tenantId: FIRM, engagementId: ENG, billingFrom: "2026-10-01", firstInvoiceOn: "2027-01-01" }, ME),
    ).rejects.toMatchObject({ code: "FISCAL_YEAR_NEEDED" });
  });

  it("clears it, which stops billing that engagement", async () => {
    const w = world();
    w.schedules.rows.push(schedule({ billingFrom: "2026-10-01", firstInvoiceOn: "2026-11-01" }));
    await w.service.setSchedule({ tenantId: FIRM, engagementId: ENG, billingFrom: null, firstInvoiceOn: null }, ME);
    expect(w.schedules.rows[0]).toMatchObject({ billingFrom: null, firstInvoiceOn: null });
  });

  it("lists what has no schedule yet, suggesting this period billed after it ends", async () => {
    const w = world();
    w.schedules.rows.push(schedule(), schedule({ engagementId: ENG2, billingFrequency: "one_time" }));
    const rows = await w.service.unscheduled(FIRM);
    expect(rows.map((r) => [r.engagementId, r.suggestion])).toEqual([
      [ENG, { billingFrom: "2026-12-01", firstInvoiceOn: "2027-01-01", periodLabel: "Dec 2026" }],
    ]);
  });
});

describe("the firm's switch", () => {
  it("turns auto-billing on and off, recording both sides", async () => {
    const w = world();
    expect(await w.service.autoBilling(FIRM)).toBe(false);
    await w.service.setAutoBilling(FIRM, true, ME);
    expect(await w.service.autoBilling(FIRM)).toBe(true);
    expect(w.events.recorded[0]).toMatchObject({ verb: "tenant.auto_billing_set", payload: { from: false, to: true } });
  });
});
