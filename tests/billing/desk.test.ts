// The billing desk (auto-invoice, phase 1): what a manager does with a bill
// due. Raise it (the invoice is drafted from it), link it to an invoice raised
// by hand, or skip it with a reason; and set an engagement's schedule. Against
// fakes; the SQL half is `desk.integration.test.ts`.
import { describe, expect, it } from "vitest";
import { BillingDeskService } from "../../src/usecase/billing/desk";
import { InvalidBillingInput } from "../../src/domain/billing/errors";
import { GoLiveScheduler } from "../../src/usecase/billing/golive";
import {
  FakeAutoBillingSetting,
  FakeBillingDueDesk,
  FakeBillingSchedules,
  FakeFiscalYearSource,
  FakeInvoiceDrafter,
  FakeIssuerTaxDefaults,
  FakeAdvancePolicy,
} from "../../src/testfakes/billing";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeFirmEntities } from "../../src/testfakes/invoice";
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
const SPOC = "00000000-0000-4000-8000-00000000c00c";
const ADMIN = "00000000-0000-4000-8000-00000000c00d";
const TRC_SPOC = "00000000-0000-4000-8000-00000000c00e";
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
    deptCodes: ["FRC"],
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
    kind: "period",
    engagementLetterId: null,
    advancePool: null,
    advanceApplied: null,
    advanceHoldsWork: false,
    ...over,
  };
}

function schedule(over: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    engagementId: ENG,
    issuingEntityPartyId: ISSUER,
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
    billingTiming: null,
    billingOn: null,
    ...over,
  };
}

function world(opts: { fiscalYear?: number | null } = {}) {
  const fiscalYears = new FakeFiscalYearSource(opts.fiscalYear === undefined ? 4 : opts.fiscalYear);
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
    fiscalYears,
    timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
    clock: new FakeClock(new Date("2026-12-05T06:00:00.000Z")),
    events,
    taxDefaults: new FakeIssuerTaxDefaults(),
    policy: new FakeAdvancePolicy(),
    firmEntities: new FakeFirmEntities(),
  });
  return { desk, invoices, schedules, setting, events, fiscalYears, service };
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
    const manual = await w.invoices.prepareDraft(
      { tenantId: FIRM, partyId: CLIENT, entityPartyId: ISSUER, currency: "INR", fxRate: "1", fxRateDate: "2026-11-01" },
    );
    await w.service.link({ tenantId: FIRM, dueId: d.id, invoiceId: manual.id }, ME);
    expect((await w.desk.findMany(FIRM, [d.id]))[0]?.status).toBe("drafted");
    expect(w.events.recorded[0]?.payload).toMatchObject({ invoiceId: manual.id, invoiceLineId: null, how: "linked" });
  });

  it("refuses to link an invoice of another client, or one that was cancelled", async () => {
    const w = world();
    const d = due();
    w.desk.rows.push(d);
    const theirs = await w.invoices.prepareDraft(
      { tenantId: FIRM, partyId: OTHER_CLIENT, entityPartyId: ISSUER, currency: "INR", fxRate: "1", fxRateDate: "2026-11-01" },
    );
    await expect(w.service.link({ tenantId: FIRM, dueId: d.id, invoiceId: theirs.id }, ME)).rejects.toMatchObject({
      code: "INVOICE_DOES_NOT_FIT_DUE",
    });
    const cancelled = await w.invoices.prepareDraft(
      { tenantId: FIRM, partyId: CLIENT, entityPartyId: ISSUER, currency: "INR", fxRate: "1", fxRateDate: "2026-11-01" },
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

  // Ashish (2026-10-01): a bill the letter fixed no price for is reminded to the
  // SPOC, the manager and the administrators, in the app, every week.
  it("puts a bill with no price on the SPOC's and every administrator's desk as well", async () => {
    const w = world();
    const noPrice = due({ fullAmount: null, amount: null, billOn: "2026-12-01" });
    const priced = due({ billOn: "2026-12-01" });
    w.desk.rows.push(noPrice, priced);
    w.desk.spocs.push({ userId: SPOC, clientPartyId: CLIENT, deptCode: "FRC" });
    w.desk.spocs.push({ userId: TRC_SPOC, clientPartyId: CLIENT, deptCode: "TRC" });

    const spoc = await w.service.list({ tenantId: FIRM, mineFor: SPOC });
    expect(spoc.dues.map((d) => d.id)).toEqual([noPrice.id]);
    expect(spoc.dues[0]?.priced).toBe(false);
    const admin = await w.service.list({ tenantId: FIRM, mineFor: ADMIN, mineIsAdmin: true });
    expect(admin.dues.map((d) => d.id)).toEqual([noPrice.id]);
    // The SPOC of another Dept, and an administrator's flag on somebody else, see nothing.
    expect((await w.service.list({ tenantId: FIRM, mineFor: TRC_SPOC })).dues).toEqual([]);
    expect((await w.service.list({ tenantId: FIRM, mineFor: ADMIN })).dues).toEqual([]);
    // The manager still sees both.
    expect((await w.service.list({ tenantId: FIRM, mineFor: MANAGER })).dues).toHaveLength(2);
  });

  it("reads who the SPOC is on the firm's own day", async () => {
    const w = world();
    w.desk.rows.push(due({ fullAmount: null, amount: null }));
    await w.service.list({ tenantId: FIRM, mineFor: SPOC });
    // 06:00 UTC on 5 December is 11:30 the same day in Kolkata.
    expect(w.desk.mineAskedOn).toEqual([{ userId: SPOC, onDate: "2026-12-05" }]);
  });

  it("stops reminding the SPOC and the administrators once an amount is on a draft", async () => {
    const w = world();
    const drafted = due({
      fullAmount: null,
      amount: null,
      invoice: { id: "00000000-0000-4000-8000-00000000eeee", number: "INV/2026-27/0001", status: "draft" },
    });
    w.desk.rows.push(drafted);
    w.desk.spocs.push({ userId: SPOC, clientPartyId: CLIENT, deptCode: "FRC" });
    expect((await w.service.list({ tenantId: FIRM, mineFor: SPOC })).dues).toEqual([]);
    expect((await w.service.list({ tenantId: FIRM, mineFor: ADMIN, mineIsAdmin: true })).dues).toEqual([]);
    // The manager still has a draft to issue.
    expect((await w.service.list({ tenantId: FIRM, mineFor: MANAGER })).dues[0]?.status).toBe("drafted");
  });

  it("says a bill is priced, which is not an amount and never hidden", async () => {
    const w = world();
    w.desk.rows.push(due(), due({ fullAmount: null, amount: null }));
    expect((await w.service.list({ tenantId: FIRM })).dues.map((d) => d.priced)).toEqual([true, false]);
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
      how: "by_hand",
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

  it("refuses a first invoice dated before the period it bills, and a year typed wrong (0321)", async () => {
    const w = world();
    w.schedules.rows.push(schedule());
    // Before October begins: every later bill would fall due a period early.
    await expect(
      w.service.setSchedule({ tenantId: FIRM, engagementId: ENG, billingFrom: "2026-10-01", firstInvoiceOn: "2026-09-30" }, ME),
    ).rejects.toMatchObject({ code: "INVALID_BILLING_INPUT" });
    for (const day of ["1900-01-01", "9999-12-31"]) {
      await expect(
        w.service.setSchedule({ tenantId: FIRM, engagementId: ENG, billingFrom: "2026-10-01", firstInvoiceOn: day }, ME),
      ).rejects.toMatchObject({ code: "INVALID_BILLING_INPUT" });
    }
    expect(w.events.recorded).toEqual([]);
  });

  it("clears it, which stops billing that engagement", async () => {
    const w = world();
    w.schedules.rows.push(schedule({ billingFrom: "2026-10-01", firstInvoiceOn: "2026-11-01" }));
    await w.service.setSchedule({ tenantId: FIRM, engagementId: ENG, billingFrom: null, firstInvoiceOn: null }, ME);
    expect(w.schedules.rows[0]).toMatchObject({ billingFrom: null, firstInvoiceOn: null });
  });

  it("lists what has no schedule yet, suggesting this period billed on its last day (Q042)", async () => {
    const w = world();
    w.schedules.rows.push(schedule(), schedule({ engagementId: ENG2, billingFrequency: "one_time" }));
    const rows = await w.service.unscheduled(FIRM);
    expect(rows.map((r) => [r.engagementId, r.suggestion])).toEqual([
      [ENG, { billingFrom: "2026-12-01", firstInvoiceOn: "2026-12-31", periodLabel: "Dec 2026" }],
    ]);
  });

  it("suggests what the letter says: its first day for an advance, its own date for on_date", async () => {
    const w = world();
    w.schedules.rows.push(
      schedule({ billingTiming: "advance" }),
      schedule({ engagementId: ENG2, billingTiming: "on_date", billingOn: "2026-12-05" }),
    );
    const by = new Map((await w.service.unscheduled(FIRM)).map((r) => [r.engagementId, r.suggestion?.firstInvoiceOn]));
    expect(by.get(ENG)).toBe("2026-12-01");
    expect(by.get(ENG2)).toBe("2026-12-05");
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

  it("starts from the first of this month when no month is given (0321, Q027)", async () => {
    const w = world();
    await w.service.setAutoBilling(FIRM, true, ME);
    expect(w.setting.sinceDays.get(FIRM)).toBe("2026-12-01");
    expect(w.events.recorded[0]).toMatchObject({ payload: { from: false, to: true, startsOn: "2026-12-01" } });
    expect((await w.service.settings(FIRM)).autoBillingFrom).toBe("2026-12-01");
  });

  it("starts from the go-live month the firm chose, past or a few months ahead (Q027)", async () => {
    const w = world();
    await w.service.setAutoBilling(FIRM, true, ME, "2026-10");
    expect(w.setting.sinceDays.get(FIRM)).toBe("2026-10-01");
    const later = world();
    await later.service.setAutoBilling(FIRM, true, ME, "2027-02");
    expect(later.setting.sinceDays.get(FIRM)).toBe("2027-02-01");
  });

  it("refuses a month that is not one, or more than a year ahead, and writes nothing", async () => {
    for (const bad of ["2026-13", "Oct 2026", "2026-1", "2028-01", "1999-12"]) {
      const w = world();
      await expect(w.service.setAutoBilling(FIRM, true, ME, bad)).rejects.toBeInstanceOf(InvalidBillingInput);
      expect(await w.service.autoBilling(FIRM)).toBe(false);
      expect(w.events.recorded).toEqual([]);
    }
  });

  it("moves the month while on, recording both sides, and refuses it while off", async () => {
    const w = world();
    await expect(w.service.setAutoBillingFrom(FIRM, "2026-11", ME)).rejects.toBeInstanceOf(InvalidBillingInput);
    await w.service.setAutoBilling(FIRM, true, ME, "2026-10");
    await w.service.setAutoBillingFrom(FIRM, "2026-11", ME);
    expect(w.setting.sinceDays.get(FIRM)).toBe("2026-11-01");
    expect(w.events.recorded.at(-1)).toMatchObject({
      verb: "tenant.auto_billing_from_set",
      payload: { from: "2026-10-01", to: "2026-11-01" },
    });
    // The same month again changes nothing and records nothing.
    const before = w.events.recorded.length;
    await w.service.setAutoBillingFrom(FIRM, "2026-11", ME);
    expect(w.events.recorded).toHaveLength(before);
    // Sent with the switch already on, the month alone moves.
    await w.service.setAutoBilling(FIRM, true, ME, "2026-12");
    expect(w.setting.sinceDays.get(FIRM)).toBe("2026-12-01");
  });
});

// ── Phase 1b (0319): the letter sets the schedule when the work goes live ────

describe("the schedule an engagement starts with, from its letter", () => {
  const live = (w: ReturnType<typeof world>, engagementIds: readonly string[], liveOn = "2026-10-15") =>
    new GoLiveScheduler({
      schedules: w.schedules,
      setting: w.setting,
      fiscalYears: w.fiscalYears,
      calendars: new FakeFirmTimeZone("Asia/Kolkata"),
      events: w.events,
    }).scheduleActivated({ tenantId: FIRM, engagementIds, liveOn }, ME);

  it("sets it from the letter's timing once the firm bills automatically", async () => {
    const w = world();
    await w.setting.set(FIRM, true);
    w.schedules.rows.push(schedule({ billingTiming: "advance" }));
    await live(w, [ENG]);
    // From 1 Jul, live 15 Oct: October is the first period billed, on its first day.
    expect(w.schedules.rows[0]).toMatchObject({ billingFrom: "2026-10-01", firstInvoiceOn: "2026-10-01" });
    expect(w.events.verbs()).toEqual(["engagement.billing_scheduled"]);
    expect(w.events.recorded[0]?.payload).toMatchObject({
      billingFrom: "2026-10-01",
      firstInvoiceOn: "2026-10-01",
      previousBillingFrom: null,
      how: "from_letter",
    });
  });

  it("bills in arrears when the letter said nothing, and on the letter's date when it chose one", async () => {
    const w = world();
    await w.setting.set(FIRM, true);
    w.schedules.rows.push(
      schedule(),
      schedule({ engagementId: ENG2, billingFrequency: "annually", billingTiming: "on_date", billingOn: "2026-11-15" }),
    );
    await live(w, [ENG, ENG2]);
    // Arrears on the period's last day (Q042).
    expect(w.schedules.rows[0]).toMatchObject({ billingFrom: "2026-10-01", firstInvoiceOn: "2026-10-31" });
    expect(w.schedules.rows[1]).toMatchObject({ billingFrom: "2026-04-01", firstInvoiceOn: "2026-11-15" });
  });

  it("starts from the engagement's own first day when that is later than going live", async () => {
    const w = world();
    await w.setting.set(FIRM, true);
    w.schedules.rows.push(schedule({ effectiveFrom: "2026-12-10" }));
    await live(w, [ENG]);
    expect(w.schedules.rows[0]).toMatchObject({ billingFrom: "2026-12-01", firstInvoiceOn: "2026-12-31" });
  });

  it("sets nothing while the firm's switch is off: those go to Billing not set up", async () => {
    const w = world();
    w.schedules.rows.push(schedule());
    await live(w, [ENG]);
    expect(w.schedules.rows[0]?.billingFrom).toBeNull();
    expect(w.events.verbs()).toEqual([]);
  });

  it("leaves alone a schedule already set, a one-off, and a quarter with no financial year", async () => {
    const w = world({ fiscalYear: null });
    await w.setting.set(FIRM, true);
    const ENG3 = "00000000-0000-4000-8000-00000000c0f3";
    w.schedules.rows.push(
      schedule({ billingFrom: "2026-08-01", firstInvoiceOn: "2026-09-01" }),
      schedule({ engagementId: ENG2, billingFrequency: "one_time" }),
      schedule({ engagementId: ENG3, billingFrequency: "quarterly" }),
    );
    await live(w, [ENG, ENG2, ENG3]);
    expect(w.schedules.rows.map((r) => r.billingFrom)).toEqual(["2026-08-01", null, null]);
    expect(w.events.verbs()).toEqual([]);
  });

  it("sets a fee group once, for every engagement in it, from the group's timing", async () => {
    const w = world();
    await w.setting.set(FIRM, true);
    const group = { id: GROUP, title: "Retainer" };
    w.schedules.rows.push(
      schedule({ feeGroup: group, billingTiming: "advance" }),
      schedule({ engagementId: ENG2, feeGroup: group, billingTiming: "advance" }),
    );
    w.schedules.groups.set(GROUP, [ENG, ENG2]);
    await live(w, [ENG, ENG2]);
    expect(w.schedules.rows.map((r) => r.firstInvoiceOn)).toEqual(["2026-10-01", "2026-10-01"]);
    expect(w.events.verbs()).toHaveLength(2);
  });
});

describe("the firm's own payment terms (B20, audit 2026-10-03)", () => {
  it("has none until the firm sets one, and never a guessed number", async () => {
    const w = world();
    expect((await w.service.settings(FIRM)).invoiceDueDays).toBeNull();
    await w.service.setInvoiceDueDays(FIRM, 15, ME);
    expect((await w.service.settings(FIRM)).invoiceDueDays).toBe(15);
    expect(w.events.recorded.at(-1)).toMatchObject({ verb: "tenant.invoice_due_days_set", payload: { from: null, to: 15 } });
    await w.service.setInvoiceDueDays(FIRM, null, ME);
    expect((await w.service.settings(FIRM)).invoiceDueDays).toBeNull();
  });

  it("refuses a number of days outside 0 to 365", async () => {
    const w = world();
    await expect(w.service.setInvoiceDueDays(FIRM, 400, ME)).rejects.toMatchObject({ code: "INVALID_BILLING_INPUT" });
    await expect(w.service.setInvoiceDueDays(FIRM, -1, ME)).rejects.toMatchObject({ code: "INVALID_BILLING_INPUT" });
  });
});

describe("a schedule set before the work started says so (CA#35)", () => {
  it("answers with a plain-words notice, and saves what was asked", async () => {
    const w = world();
    w.schedules.rows.push(schedule({ effectiveFrom: "2026-10-03" }));
    const saved = await w.service.setSchedule(
      { tenantId: FIRM, engagementId: ENG, billingFrom: "2026-09-01", firstInvoiceOn: "2026-10-01" },
      ME,
    );
    expect(saved.billingFrom).toBe("2026-09-01");
    expect(saved.notice).toContain("nothing before 3 October 2026 is billed");
    const later = await w.service.setSchedule(
      { tenantId: FIRM, engagementId: ENG, billingFrom: "2026-10-01", firstInvoiceOn: "2026-11-01" },
      ME,
    );
    expect(later.notice).toContain("nothing before 3 October 2026");
    const clean = await w.service.setSchedule(
      { tenantId: FIRM, engagementId: ENG, billingFrom: "2026-11-01", firstInvoiceOn: "2026-12-01" },
      ME,
    );
    expect(clean.notice).toBeNull();
  });
});
