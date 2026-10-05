// Q071 (2026-10-05): a yearly service is billed on its statutory filing's due
// date, and a period whose work is done may be billed before its date.
// The domain rule, the sweep and "Raise invoice now", against fakes; the SQL
// half (which filings belong to a service, finished work) is
// `yearly-bill-date.integration.test.ts`.
import { describe, expect, it } from "vitest";
import {
  billLabel,
  billingDues,
  isYearlyFiling,
  statutoryBillDay,
  type ServiceWindow,
  type StatutoryFiling,
} from "../../src/domain/billing/model";
import { BillingService } from "../../src/usecase/billing/service";
import { EarlyBiller } from "../../src/usecase/billing/early";
import {
  FakeAutoBillingFirms,
  FakeAutoBillingSetting,
  FakeBillingDueWriter,
  FakeBillingManagerFacts,
  FakeDoneWorkFacts,
  FakeFiscalYearSource,
} from "../../src/testfakes/billing";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeIds } from "../../src/testfakes/ids";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import type { BillingSubject } from "../../src/usecase/billing/ports";

const FIRM = "00000000-0000-4000-8000-00000000c001";
const CLIENT = "00000000-0000-4000-8000-00000000c002";
const ISSUER = "00000000-0000-4000-8000-00000000c003";
const ENG = "00000000-0000-4000-8000-00000000c004";
const SPOC = "00000000-0000-4000-8000-00000000c005";
const MANAGER = "00000000-0000-4000-8000-00000000c006";
const AUDIT = "00000000-0000-4000-8000-00000000c010";
const ITR = "00000000-0000-4000-8000-00000000c011";
const GSTR1 = "00000000-0000-4000-8000-00000000c012";
const JOB = "00000000-0000-4000-8000-00000000c020";

const FY27 = { start: "2026-04-01", end: "2027-03-31", label: "FY2026-27" };
const OPEN: ServiceWindow = { from: "2026-04-01", to: null, pausedFrom: null, pausedTo: null };

function filing(over: Partial<StatutoryFiling> = {}): StatutoryFiling {
  return {
    id: AUDIT,
    name: "Statutory audit",
    dueOn: "2026-09-30",
    periodStart: "2025-04-01",
    periodEnd: "2026-03-31",
    periodLabel: "FY2025-26",
    ...over,
  };
}

describe("the yearly bill's day (Q071 a)", () => {
  it("is the due date of the yearly filing that falls inside the billing year", () => {
    expect(statutoryBillDay(FY27, [filing()], "2026-04-01")?.dueOn).toBe("2026-09-30");
  });

  it("is the EARLIEST of several (audit 30 Sep before ITR 31 Oct), whatever their order", () => {
    const itr = filing({ id: ITR, name: "Income tax return", dueOn: "2026-10-31" });
    expect(statutoryBillDay(FY27, [itr, filing()], "2026-04-01")?.id).toBe(AUDIT);
  });

  it("ignores a monthly or quarterly filing: only a yearly one dates a yearly bill", () => {
    const monthly = filing({ id: GSTR1, dueOn: "2026-05-11", periodStart: "2026-04-01", periodEnd: "2026-04-30" });
    expect(isYearlyFiling(monthly)).toBe(false);
    expect(statutoryBillDay(FY27, [monthly], "2026-04-01")).toBeNull();
  });

  it("ignores a filing due before the work began, or outside the year", () => {
    expect(statutoryBillDay(FY27, [filing()], "2026-10-01")).toBeNull();
    expect(statutoryBillDay(FY27, [filing({ dueOn: "2027-09-30" })], "2026-04-01")).toBeNull();
  });

  it("bills a yearly arrears schedule on the filing's day, named for the filing's year", () => {
    const [due] = billingDues({
      periods: [FY27],
      spanMonths: 12,
      firstInvoiceOn: FY27.end,
      today: "2026-10-01",
      windows: [OPEN],
      filings: [filing()],
    });
    expect(due?.billOn).toBe("2026-09-30");
    expect(due?.datedBy?.id).toBe(AUDIT);
    expect(due === undefined ? null : billLabel(due)).toBe("FY2025-26");
    expect(due?.servedDays).toBe(due?.periodDays);
  });

  it("is not due before the filing's day", () => {
    const dues = billingDues({
      periods: [FY27],
      spanMonths: 12,
      firstInvoiceOn: FY27.end,
      today: "2026-09-29",
      windows: [OPEN],
      filings: [filing()],
    });
    expect(dues).toEqual([]);
  });

  it("keeps the year's last day with no filing, and the period's own label", () => {
    const [due] = billingDues({
      periods: [FY27],
      spanMonths: 12,
      firstInvoiceOn: FY27.end,
      today: "2027-03-31",
      windows: [OPEN],
      filings: [],
    });
    expect(due?.billOn).toBe("2027-03-31");
    expect(due?.datedBy).toBeNull();
    expect(due === undefined ? null : billLabel(due)).toBe("FY2026-27");
  });

  it("keeps a letter's own day: a person's 'Bill on 15 November' beats the filing", () => {
    const [due] = billingDues({
      periods: [FY27],
      spanMonths: 12,
      firstInvoiceOn: "2026-11-15",
      today: "2026-12-01",
      windows: [OPEN],
      filings: [filing()],
    });
    expect(due?.billOn).toBe("2026-11-15");
    expect(due?.datedBy).toBeNull();
  });

  it("keeps the year's start for an advance schedule", () => {
    const [due] = billingDues({
      periods: [FY27],
      spanMonths: 12,
      firstInvoiceOn: FY27.start,
      today: "2026-04-02",
      windows: [OPEN],
      filings: [filing()],
    });
    expect(due?.billOn).toBe("2026-04-01");
    expect(due?.datedBy).toBeNull();
  });

  it("never dates a monthly bill by a filing (Q071 c)", () => {
    const sep = { start: "2026-09-01", end: "2026-09-30", label: "Sep 2026" };
    const [due] = billingDues({
      periods: [sep],
      spanMonths: 1,
      firstInvoiceOn: sep.end,
      today: "2026-10-01",
      windows: [OPEN],
      filings: [filing({ dueOn: "2026-09-15" })],
    });
    expect(due?.billOn).toBe("2026-09-30");
  });
});

function yearly(over: Partial<BillingSubject> = {}): Omit<BillingSubject, "duePeriodStarts"> {
  return {
    engagementId: ENG,
    feeGroupId: null,
    partyId: CLIENT,
    issuingEntityPartyId: ISSUER,
    currency: "INR",
    billingFrequency: "annually",
    billingFrom: "2026-04-01",
    firstInvoiceOn: "2027-03-31",
    fullAmount: "150000.0000",
    engagements: [
      {
        engagementId: ENG,
        status: "active",
        effectiveFrom: "2026-04-01",
        endsOn: null,
        pausedOn: null,
        resumedOn: null,
        deptCode: "FRC",
      },
    ],
    statutoryFilings: [filing()],
    ...over,
  };
}

function world(now: string) {
  const dues = new FakeBillingDueWriter();
  const managers = new FakeBillingManagerFacts();
  managers.spocs.set(`${CLIENT}|FRC`, [{ userId: SPOC, managerUserId: MANAGER, managerName: "Meera" }]);
  const events = new RecordingEventSink();
  const clock = new FakeClock(new Date(now));
  const setting = new FakeAutoBillingSetting();
  void setting.set(FIRM, true);
  const work = new FakeDoneWorkFacts();
  const common = {
    dues,
    managers,
    fiscalYears: new FakeFiscalYearSource(4),
    timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
    ids: new FakeIds(),
    clock,
    events,
  };
  const sweep = new BillingService({ ...common, firms: new FakeAutoBillingFirms([FIRM]) });
  const early = new EarlyBiller({ ...common, work, setting });
  return { dues, events, clock, setting, work, sweep, early };
}

describe("the sweep bills a yearly statutory service on its due date", () => {
  it("writes nothing the day before, and the bill ON the due date, named for the filing's year", async () => {
    const w = world("2026-09-29T06:00:00.000Z");
    w.dues.add(FIRM, yearly());
    expect((await w.sweep.sweepTenant(FIRM)).created).toBe(0);

    w.clock.set(new Date("2026-09-30T06:00:00.000Z"));
    expect((await w.sweep.sweepTenant(FIRM)).created).toBe(1);
    const [due] = w.dues.dues;
    expect(due?.billOn).toBe("2026-09-30");
    expect(due?.periodStart).toBe("2026-04-01");
    expect(due?.periodLabel).toBe("FY2025-26");
    expect(due?.datedByFilingId).toBe(AUDIT);
    expect(w.events.recorded[0]?.payload).toMatchObject({ datedByFilingId: AUDIT, billOn: "2026-09-30" });

    // The year's last day writes no second bill for the same year.
    w.clock.set(new Date("2027-03-31T06:00:00.000Z"));
    expect((await w.sweep.sweepTenant(FIRM)).created).toBe(0);
  });

  it("bills on the year's last day when the service carries no filing", async () => {
    const w = world("2026-09-30T06:00:00.000Z");
    w.dues.add(FIRM, yearly({ statutoryFilings: [] }));
    expect((await w.sweep.sweepTenant(FIRM)).created).toBe(0);
    w.clock.set(new Date("2027-03-31T06:00:00.000Z"));
    expect((await w.sweep.sweepTenant(FIRM)).created).toBe(1);
    expect(w.dues.dues[0]?.billOn).toBe("2027-03-31");
    expect(w.dues.dues[0]?.periodLabel).toBe("FY2026-27");
    expect(w.dues.dues[0]?.datedByFilingId ?? null).toBeNull();
  });
});

describe("Raise invoice now (Q071 b)", () => {
  const doneJob = {
    tenantId: FIRM,
    partyId: CLIENT,
    kind: "job" as const,
    id: JOB,
    jobId: JOB,
    name: null,
    engagementIds: [ENG],
    periodStart: "2026-04-01",
    periodEnd: "2027-03-31",
    doneOn: "2026-08-20",
  };

  it("offers a year whose work is done before its bill date, and bills it today, once", async () => {
    const w = world("2026-08-21T06:00:00.000Z");
    w.dues.add(FIRM, yearly());
    w.work.work.push(doneJob);

    const [offer, ...rest] = await w.early.candidates(FIRM, { jobId: JOB });
    expect(rest).toEqual([]);
    expect(offer?.plannedBillOn).toBe("2026-09-30");
    expect(offer?.period).toEqual({ start: "2026-04-01", end: "2027-03-31", label: "FY2025-26" });
    expect(offer?.datedByFiling?.id).toBe(AUDIT);
    expect(offer?.manager.userId).toBe(MANAGER);

    const { dueId } = await w.early.billEarly(
      { tenantId: FIRM, subjectKey: `e:${ENG}`, periodStart: "2026-04-01" },
      { type: "human", id: SPOC },
    );
    const [due] = w.dues.dues;
    expect(due?.id).toBe(dueId);
    expect(due?.billOn).toBe("2026-08-21");
    expect(due?.periodLabel).toBe("FY2025-26");
    expect(w.events.recorded.at(-1)?.payload).toMatchObject({ how: "billed_early", plannedBillOn: "2026-09-30", workId: JOB });

    // Never twice: not offered again, refused if asked, and the sweep on the
    // due date writes no second bill for the year.
    expect(await w.early.candidates(FIRM, {})).toEqual([]);
    await expect(
      w.early.billEarly({ tenantId: FIRM, subjectKey: `e:${ENG}`, periodStart: "2026-04-01" }, { type: "human", id: SPOC }),
    ).rejects.toMatchObject({ code: "BILL_EARLY_REFUSED" });
    w.clock.set(new Date("2026-09-30T06:00:00.000Z"));
    expect((await w.sweep.sweepTenant(FIRM)).created).toBe(0);
    expect(w.dues.dues).toHaveLength(1);
  });

  it("offers the filing that dates the bill once it is filed, with no process at all", async () => {
    const w = world("2026-09-10T06:00:00.000Z");
    w.dues.add(FIRM, yearly());
    w.work.work.push({
      tenantId: FIRM,
      partyId: CLIENT,
      kind: "filing",
      id: AUDIT,
      jobId: null,
      name: "Statutory audit",
      engagementIds: [ENG],
      periodStart: "2025-04-01",
      periodEnd: "2026-03-31",
      doneOn: "2026-09-08",
    });
    const [offer] = await w.early.candidates(FIRM, {});
    expect(offer?.work).toMatchObject({ kind: "filing", id: AUDIT });
  });

  it("offers nothing while the work is not done, and refuses to bill it", async () => {
    const w = world("2026-08-21T06:00:00.000Z");
    w.dues.add(FIRM, yearly());
    expect(await w.early.candidates(FIRM, {})).toEqual([]);
    await expect(
      w.early.billEarly({ tenantId: FIRM, subjectKey: `e:${ENG}`, periodStart: "2026-04-01" }, { type: "human", id: SPOC }),
    ).rejects.toMatchObject({ code: "BILL_EARLY_REFUSED" });
  });

  it("offers nothing once the bill date has come: the daily run writes it", async () => {
    const w = world("2026-09-30T06:00:00.000Z");
    w.dues.add(FIRM, yearly());
    w.work.work.push(doneJob);
    expect(await w.early.candidates(FIRM, {})).toEqual([]);
  });

  it("offers nothing with automatic billing off, and refuses in words", async () => {
    const w = world("2026-08-21T06:00:00.000Z");
    w.dues.add(FIRM, yearly());
    w.work.work.push(doneJob);
    await w.setting.set(FIRM, false);
    expect(await w.early.candidates(FIRM, {})).toEqual([]);
    await expect(
      w.early.billEarly({ tenantId: FIRM, subjectKey: `e:${ENG}`, periodStart: "2026-04-01" }, { type: "human", id: SPOC }),
    ).rejects.toMatchObject({ code: "AUTO_BILLING_OFF" });
  });

  it("narrows to the bills whose manager is the caller (My day)", async () => {
    const w = world("2026-08-21T06:00:00.000Z");
    w.dues.add(FIRM, yearly());
    w.work.work.push(doneJob);
    expect(await w.early.candidates(FIRM, { managerUserId: MANAGER })).toHaveLength(1);
    expect(await w.early.candidates(FIRM, { managerUserId: SPOC })).toEqual([]);
  });

  it("offers a monthly period finished before its last day", async () => {
    const w = world("2026-10-20T06:00:00.000Z");
    w.dues.add(
      FIRM,
      yearly({ billingFrequency: "monthly", billingFrom: "2026-10-01", firstInvoiceOn: "2026-10-31", statutoryFilings: [] }),
    );
    w.work.work.push({ ...doneJob, periodStart: "2026-10-01", periodEnd: "2026-10-31", doneOn: "2026-10-18" });
    const [offer] = await w.early.candidates(FIRM, {});
    expect(offer?.plannedBillOn).toBe("2026-10-31");
    expect(offer?.period.label).toBe("Oct 2026");
  });
});
