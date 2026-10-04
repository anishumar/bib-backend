// The billing sweep cuts each company's periods on ITS OWN calendar (0337):
// a calendar-year UAE company bills its yearly service January to December
// while the firm's year starts in April, and a New York company's November
// bill does not fall due while it is still 31 October in New York.
import { describe, expect, it } from "vitest";
import { BillingService } from "../../src/usecase/billing/service";
import { BillingDeskService } from "../../src/usecase/billing/desk";
import { GoLiveScheduler } from "../../src/usecase/billing/golive";
import { FinalBiller } from "../../src/usecase/billing/final";
import {
  FakeAdvancePolicy,
  FakeAutoBillingFirms,
  FakeAutoBillingSetting,
  FakeBillingDueDesk,
  FakeBillingDueWriter,
  FakeBillingManagerFacts,
  FakeBillingSchedules,
  FakeFinalBillFacts,
  FakeFiscalYearSource,
  FakeInvoiceDrafter,
  FakeIssuerTaxDefaults,
} from "../../src/testfakes/billing";
import { FakeFirmEntities } from "../../src/testfakes/invoice";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeIds } from "../../src/testfakes/ids";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import type { BilledEngagement, BillingSubject, FinalBillSubject, ScheduleRecord } from "../../src/usecase/billing/ports";

const FIRM = "00000000-0000-4000-8000-00000000c001";
const CLIENT = "00000000-0000-4000-8000-00000000c003";
const IN_CO = "00000000-0000-4000-8000-00000000c004";
const AE_CO = "00000000-0000-4000-8000-00000000c014";
const US_CO = "00000000-0000-4000-8000-00000000c024";
const ENG = "00000000-0000-4000-8000-00000000c005";

function engagement(over: Partial<BilledEngagement> = {}): BilledEngagement {
  return {
    engagementId: ENG,
    status: "active",
    effectiveFrom: "2026-01-01",
    endsOn: null,
    pausedOn: null,
    resumedOn: null,
    deptCode: "FRC",
    ...over,
  };
}

function subject(over: Partial<BillingSubject> = {}): Omit<BillingSubject, "duePeriodStarts"> {
  return {
    engagementId: ENG,
    feeGroupId: null,
    partyId: CLIENT,
    issuingEntityPartyId: IN_CO,
    currency: "INR",
    billingFrequency: "monthly",
    billingFrom: "2026-10-01",
    firstInvoiceOn: "2026-11-01",
    fullAmount: "25000.0000",
    engagements: [engagement()],
    ...over,
  };
}

/** A firm on India's clock; its UAE company on Dubai's clock and a calendar
 *  year; its US company on New York's clock. */
function world(opts: { now: string; firmYear?: number | null }) {
  const dues = new FakeBillingDueWriter();
  const timeZones = new FakeFirmTimeZone("Asia/Kolkata");
  timeZones.setCompany(AE_CO, { timeZone: "Asia/Dubai", fiscalYearStartMonth: 1 });
  timeZones.setCompany(US_CO, { timeZone: "America/New_York" });
  const service = new BillingService({
    dues,
    managers: new FakeBillingManagerFacts(),
    firms: new FakeAutoBillingFirms([FIRM]),
    fiscalYears: new FakeFiscalYearSource(opts.firmYear === undefined ? 4 : opts.firmYear),
    timeZones,
    ids: new FakeIds(),
    clock: new FakeClock(new Date(opts.now)),
    events: new RecordingEventSink(),
  });
  return { dues, service };
}

describe("the billing sweep follows each company's year (0337)", () => {
  const yearly = (issuer: string, billingFrom: string, firstInvoiceOn: string) =>
    subject({ issuingEntityPartyId: issuer, billingFrequency: "annually", billingFrom, firstInvoiceOn });

  it("cuts a calendar-year company's yearly service January to December", async () => {
    const w = world({ now: "2027-01-02T06:00:00Z" });
    w.dues.add(FIRM, yearly(AE_CO, "2026-01-01", "2027-01-01"));
    await w.service.sweep();
    expect(w.dues.dues.map((d) => [d.periodStart, d.periodEnd, d.billOn])).toEqual([
      ["2026-01-01", "2026-12-31", "2027-01-01"],
    ]);
  });

  it("cuts the Indian company's yearly service on the firm's April year", async () => {
    const w = world({ now: "2027-04-02T06:00:00Z" });
    w.dues.add(FIRM, yearly(IN_CO, "2026-04-01", "2027-04-01"));
    await w.service.sweep();
    expect(w.dues.dues.map((d) => [d.periodStart, d.periodEnd])).toEqual([["2026-04-01", "2027-03-31"]]);
  });

  it("bills a quarter for a company with its own year at a firm that has set none", async () => {
    const w = world({ now: "2027-01-02T06:00:00Z", firmYear: null });
    w.dues.add(FIRM, subject({
      issuingEntityPartyId: AE_CO,
      billingFrequency: "quarterly",
      billingFrom: "2026-10-01",
      firstInvoiceOn: "2027-01-01",
    }));
    const [report] = await w.service.sweep();
    expect(report?.awaitingFiscalYear).toBe(0);
    expect(w.dues.dues.map((d) => [d.periodStart, d.periodEnd])).toEqual([["2026-10-01", "2026-12-31"]]);
  });

  it("still waits for a year when neither the company nor the firm has one", async () => {
    const w = world({ now: "2027-01-02T06:00:00Z", firmYear: null });
    w.dues.add(FIRM, subject({ billingFrequency: "quarterly", firstInvoiceOn: "2027-01-01" }));
    const [report] = await w.service.sweep();
    expect(report?.awaitingFiscalYear).toBe(1);
    expect(w.dues.dues).toEqual([]);
  });
});

describe("the billing sweep's today is each company's (0337)", () => {
  // 02:00 UTC on 1 November: 07:30 on 1 November in India, 22:00 on
  // 31 October in New York.
  const AT = "2026-11-01T02:00:00Z";

  it("does not bill the US company's October before New York's 1 November", async () => {
    const w = world({ now: AT });
    w.dues.add(FIRM, subject({ issuingEntityPartyId: US_CO }));
    await w.service.sweep();
    expect(w.dues.dues).toEqual([]);
  });

  it("bills the Indian company's October on India's 1 November", async () => {
    const w = world({ now: AT });
    w.dues.add(FIRM, subject({ issuingEntityPartyId: IN_CO }));
    await w.service.sweep();
    expect(w.dues.dues.map((d) => [d.periodLabel, d.billOn])).toEqual([["Oct 2026", "2026-11-01"]]);
  });
});

// ── Setting billing up: the suggestion, a typed schedule, the letter's own ──

const ME = { type: "human" as const, id: "00000000-0000-4000-8000-00000000c0ff" };

function schedule(over: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    engagementId: ENG,
    issuingEntityPartyId: IN_CO,
    party: { id: CLIENT, displayName: "Kaveri Foods" },
    entityName: "Kaveri Foods",
    serviceName: "Statutory audit",
    letterRef: "EL-2026-0001",
    status: "active",
    effectiveFrom: "2026-07-01",
    endsOn: null,
    billingFrequency: "annually",
    feeGroup: null,
    billingFrom: null,
    firstInvoiceOn: null,
    billingTiming: null,
    billingOn: null,
    ...over,
  };
}

/** The desk on 5 December 2026, the firm on an April year, the UAE company
 *  on a calendar year. */
function deskWorld() {
  const timeZones = new FakeFirmTimeZone("Asia/Kolkata");
  timeZones.setCompany(AE_CO, { timeZone: "Asia/Dubai", fiscalYearStartMonth: 1 });
  const schedules = new FakeBillingSchedules();
  const setting = new FakeAutoBillingSetting();
  const fiscalYears = new FakeFiscalYearSource(4);
  const events = new RecordingEventSink();
  const desk = new BillingDeskService({
    desk: new FakeBillingDueDesk(),
    invoices: new FakeInvoiceDrafter(),
    schedules,
    setting,
    fiscalYears,
    timeZones,
    clock: new FakeClock(new Date("2026-12-05T06:00:00.000Z")),
    events,
    taxDefaults: new FakeIssuerTaxDefaults(),
    policy: new FakeAdvancePolicy(),
    firmEntities: new FakeFirmEntities(),
  });
  const goLive = new GoLiveScheduler({ schedules, setting, fiscalYears, calendars: timeZones, events });
  return { schedules, setting, desk, goLive };
}

describe("setting billing up follows the letter's company's year (0337)", () => {
  it("suggests the UAE company's calendar year, and the Indian company's April year", async () => {
    const w = deskWorld();
    w.schedules.rows.push(
      schedule({ engagementId: "e-ae", issuingEntityPartyId: AE_CO }),
      schedule({ engagementId: "e-in", issuingEntityPartyId: IN_CO }),
    );
    const rows = await w.desk.unscheduled(FIRM);
    const by = new Map(rows.map((r) => [r.engagementId, r.suggestion]));
    expect(by.get("e-ae")).toMatchObject({ billingFrom: "2026-01-01", firstInvoiceOn: "2027-01-01" });
    expect(by.get("e-in")).toMatchObject({ billingFrom: "2026-04-01", firstInvoiceOn: "2027-04-01" });
    // Each named in its own company's year.
    expect(by.get("e-ae")?.periodLabel).not.toBe(by.get("e-in")?.periodLabel);
  });

  it("aligns a typed first period to the UAE company's year", async () => {
    const w = deskWorld();
    w.schedules.rows.push(schedule({ issuingEntityPartyId: AE_CO }));
    await w.desk.setSchedule(
      { tenantId: FIRM, engagementId: ENG, billingFrom: "2026-06-15", firstInvoiceOn: "2027-01-01" },
      ME,
    );
    expect(w.schedules.rows[0]).toMatchObject({ billingFrom: "2026-01-01", firstInvoiceOn: "2027-01-01" });
  });

  it("sets a signed letter's schedule on its company's year", async () => {
    const w = deskWorld();
    await w.setting.set(FIRM, true);
    w.schedules.rows.push(schedule({ issuingEntityPartyId: AE_CO }));
    await w.goLive.scheduleActivated({ tenantId: FIRM, engagementIds: [ENG], liveOn: "2026-10-15" }, ME);
    expect(w.schedules.rows[0]).toMatchObject({ billingFrom: "2026-01-01", firstInvoiceOn: "2027-01-01" });
  });
});

// ── Bill it now: the bill is dated on the company's day ──

describe("Bill it now is dated on the company's day (0337)", () => {
  it("dates the US company's final bill on New York's 31 October", async () => {
    const dues = new FakeBillingDueWriter();
    const facts = new FakeFinalBillFacts(dues);
    const setting = new FakeAutoBillingSetting();
    await setting.set(FIRM, true);
    const timeZones = new FakeFirmTimeZone("Asia/Kolkata");
    timeZones.setCompany(US_CO, { timeZone: "America/New_York" });
    const subject: FinalBillSubject & { tenantId: string; jobIds: string[] } = {
      tenantId: FIRM,
      jobIds: [],
      engagementId: ENG,
      feeGroupId: null,
      partyId: CLIENT,
      issuingEntityPartyId: US_CO,
      currency: "USD",
      billingFrequency: "one_time",
      fullAmount: "5000.0000",
      effectiveFrom: "2026-10-05",
      engagements: [
        { engagementId: ENG, status: "active", deptCode: "FRC", job: { status: "pending", hasProcess: false, doneOn: null } },
      ],
      hasFinalBill: false,
      billedByHand: false,
      autoBillingSince: null,
    };
    facts.subjects.push(subject);
    const biller = new FinalBiller({
      facts,
      dues,
      managers: new FakeBillingManagerFacts(),
      setting,
      firms: new FakeAutoBillingFirms([FIRM]),
      timeZones,
      // 02:00 UTC on 1 November: 22:00 on 31 October in New York.
      clock: new FakeClock(new Date("2026-11-01T02:00:00Z")),
      ids: new FakeIds(),
      events: new RecordingEventSink(),
    });
    await biller.billNow({ tenantId: FIRM, engagementId: ENG }, ME);
    expect(dues.dues[0]).toMatchObject({ kind: "final", billOn: "2026-10-31", periodEnd: "2026-10-31" });
  });
});
