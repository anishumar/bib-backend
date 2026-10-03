// The billing sweep (auto-invoice, phase 1), against in-memory fakes. The SQL
// half — which engagements are offered, the anti-join and the unique keys on a
// real database — is `sweep.integration.test.ts`.
import { describe, expect, it } from "vitest";
import { BillingService } from "../../src/usecase/billing/service";
import {
  FakeAutoBillingFirms,
  FakeBillingDueWriter,
  FakeBillingManagerFacts,
  FakeFiscalYearSource,
} from "../../src/testfakes/billing";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeIds } from "../../src/testfakes/ids";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import type { BilledEngagement, BillingSubject } from "../../src/usecase/billing/ports";

const FIRM = "00000000-0000-4000-8000-00000000b001";
const OTHER_FIRM = "00000000-0000-4000-8000-00000000b002";
const CLIENT = "00000000-0000-4000-8000-00000000b003";
const ISSUER = "00000000-0000-4000-8000-00000000b004";
const ENG = "00000000-0000-4000-8000-00000000b005";
const ENG2 = "00000000-0000-4000-8000-00000000b006";
const GROUP = "00000000-0000-4000-8000-00000000b007";
const SPOC = "00000000-0000-4000-8000-00000000b008";
const MANAGER = "00000000-0000-4000-8000-00000000b009";
const KEY_MANAGER = "00000000-0000-4000-8000-00000000b00a";

function engagement(over: Partial<BilledEngagement> = {}): BilledEngagement {
  return {
    engagementId: ENG,
    status: "active",
    effectiveFrom: "2026-10-01",
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
    issuingEntityPartyId: ISSUER,
    currency: "INR",
    billingFrequency: "monthly",
    billingFrom: "2026-10-01",
    firstInvoiceOn: "2026-11-01",
    fullAmount: "25000.0000",
    engagements: [engagement()],
    ...over,
  };
}

function world(opts: { now?: string; zone?: string; fiscalYear?: number | null; firms?: string[] } = {}) {
  const dues = new FakeBillingDueWriter();
  const managers = new FakeBillingManagerFacts();
  managers.spocs.set(`${CLIENT}|FRC`, [{ userId: SPOC, managerUserId: MANAGER, managerName: "Meera" }]);
  managers.keyManagers.set(CLIENT, { userId: KEY_MANAGER, displayName: "Kavya" });
  const events = new RecordingEventSink();
  const timeZones = new FakeFirmTimeZone(opts.zone ?? "UTC");
  const service = new BillingService({
    dues,
    managers,
    firms: new FakeAutoBillingFirms(opts.firms ?? [FIRM]),
    fiscalYears: new FakeFiscalYearSource(opts.fiscalYear === undefined ? 4 : opts.fiscalYear),
    timeZones,
    ids: new FakeIds(),
    clock: new FakeClock(new Date(opts.now ?? "2026-12-05T06:00:00.000Z")),
    events,
  });
  return { dues, managers, events, service };
}

describe("the billing sweep", () => {
  it("writes a due for each period whose bill date has come, in arrears", async () => {
    const w = world();
    w.dues.add(FIRM, subject());

    const [report] = await w.service.sweep();

    expect(report).toMatchObject({ tenantId: FIRM, created: 2, awaitingFiscalYear: 0 });
    expect(w.dues.dues.map((d) => [d.periodLabel, d.periodStart, d.periodEnd, d.billOn])).toEqual([
      ["Oct 2026", "2026-10-01", "2026-10-31", "2026-11-01"],
      ["Nov 2026", "2026-11-01", "2026-11-30", "2026-12-01"],
    ]);
    expect(w.dues.dues[0]).toMatchObject({
      partyId: CLIENT,
      issuingEntityPartyId: ISSUER,
      currency: "INR",
      engagementId: ENG,
      feeGroupId: null,
      fullAmount: "25000.0000",
      servedDays: 31,
      periodDays: 31,
      managerUserId: MANAGER,
      managerHow: "spoc_manager",
      managerNote: null,
    });
  });

  it("records one event per due, by the system, carrying ids and days only", async () => {
    const w = world();
    w.dues.add(FIRM, subject());
    await w.service.sweep();
    expect(w.events.verbs()).toEqual(["billing_due.created", "billing_due.created"]);
    const [first] = w.events.recorded;
    expect(first?.actorType).toBe("system");
    expect(first?.payload).toEqual({
      partyId: CLIENT,
      engagementId: ENG,
      feeGroupId: null,
      periodStart: "2026-10-01",
      billOn: "2026-11-01",
      managerHow: "spoc_manager",
    });
  });

  it("writes nothing and records nothing the second time (idempotent)", async () => {
    const w = world();
    w.dues.add(FIRM, subject());
    await w.service.sweep();
    const [again] = await w.service.sweep();
    expect(again).toMatchObject({ created: 0 });
    expect(w.dues.dues).toHaveLength(2);
    expect(w.events.recorded).toHaveLength(2);
  });

  it("bills nothing before billingFrom, however long ago the engagement began", async () => {
    // An existing client since 2024, set up to bill from October 2026: the
    // months before were billed by hand and must raise nothing.
    const w = world({ now: "2026-11-02T06:00:00.000Z" });
    w.dues.add(FIRM, subject({ engagements: [engagement({ effectiveFrom: "2024-04-01" })] }));
    await w.service.sweep();
    expect(w.dues.dues.map((d) => d.periodLabel)).toEqual(["Oct 2026"]);
  });

  it("cuts today on the firm's own calendar", async () => {
    // 20:00 UTC on 31 October is 01:30 on 1 November in Kolkata: October's
    // bill is due there and not yet in London.
    const kolkata = world({ now: "2026-10-31T20:00:00.000Z", zone: "Asia/Kolkata" });
    kolkata.dues.add(FIRM, subject());
    await kolkata.service.sweep();
    expect(kolkata.dues.dues).toHaveLength(1);

    const utc = world({ now: "2026-10-31T20:00:00.000Z", zone: "UTC" });
    utc.dues.add(FIRM, subject());
    await utc.service.sweep();
    expect(utc.dues.dues).toHaveLength(0);
  });

  it("pro-rates the last period by the days served when the engagement ended mid-way", async () => {
    const w = world({ now: "2027-01-05T06:00:00.000Z" });
    w.dues.add(
      FIRM,
      subject({
        billingFrequency: "quarterly",
        firstInvoiceOn: "2027-01-01",
        engagements: [engagement({ status: "completed", endsOn: "2026-11-30" })],
      }),
    );
    await w.service.sweep();
    expect(w.dues.dues).toHaveLength(1);
    expect(w.dues.dues[0]).toMatchObject({ periodLabel: expect.stringContaining("Q3") as string, servedDays: 61, periodDays: 92 });
  });

  it("counts and skips a quarterly bill while the firm has not said when its year starts", async () => {
    const w = world({ fiscalYear: null, now: "2027-01-05T06:00:00.000Z" });
    w.dues.add(FIRM, subject({ billingFrequency: "quarterly", firstInvoiceOn: "2027-01-01" }));
    const [report] = await w.service.sweep();
    expect(report).toMatchObject({ created: 0, awaitingFiscalYear: 1 });
    expect(w.dues.dues).toEqual([]);
  });

  it("leaves a frequency it cannot schedule alone", async () => {
    const w = world();
    w.dues.add(FIRM, subject({ billingFrequency: "custom" }));
    await w.service.sweep();
    expect(w.dues.dues).toEqual([]);
  });

  it("gives a fee covering two Depts to the Key Manager, saying why", async () => {
    const w = world({ now: "2026-11-02T06:00:00.000Z" });
    w.dues.add(
      FIRM,
      subject({
        engagementId: null,
        feeGroupId: GROUP,
        engagements: [engagement(), engagement({ engagementId: ENG2, deptCode: "TRC" })],
      }),
    );
    await w.service.sweep();
    expect(w.dues.dues[0]).toMatchObject({ feeGroupId: GROUP, managerUserId: KEY_MANAGER, managerHow: "key_manager" });
    expect(w.dues.dues[0]?.managerNote).toMatch(/several Depts/);
  });

  it("visits only firms that turned auto-billing on, and one firm's failure stops no other", async () => {
    const w = world({ firms: [OTHER_FIRM, FIRM] });
    w.dues.add(FIRM, subject());
    const broken = w.dues.subjectsFor.bind(w.dues);
    w.dues.subjectsFor = (tenantId: string) =>
      tenantId === OTHER_FIRM ? Promise.reject(new Error("boom")) : broken(tenantId);

    const reports = await w.service.sweep();

    expect(reports.map((r) => [r.tenantId, r.created, r.failure ?? null])).toEqual([
      [OTHER_FIRM, 0, "boom"],
      [FIRM, 2, null],
    ]);
  });
});

describe("a long schedule pages forward (B23, audit 2026-10-03)", () => {
  // Periods were always counted from `billingFrom` and capped at 60, so a
  // monthly engagement got no bill from month 61 (five years) on, silently.
  it("writes at most 60 bills a pass and carries on from the last one the next pass", async () => {
    const w = world({ now: "2026-12-05T06:00:00.000Z" });
    w.dues.add(
      FIRM,
      subject({
        billingFrom: "2020-01-01",
        firstInvoiceOn: "2020-02-01",
        engagements: [engagement({ effectiveFrom: "2020-01-01" })],
      }),
    );
    // January 2020 to November 2026: 83 months whose bill date has come.
    expect((await w.service.sweep())[0]?.created).toBe(60);
    expect((await w.service.sweep())[0]?.created).toBe(23);
    expect((await w.service.sweep())[0]?.created).toBe(0);
    const starts = w.dues.dues.map((d) => d.periodStart).sort();
    expect(starts[0]).toBe("2020-01-01");
    expect(starts.at(-1)).toBe("2026-11-01");
    expect(new Set(starts).size).toBe(83);
    // Each bill is dated the month after its period, wherever the page began.
    expect(w.dues.dues.find((d) => d.periodStart === "2026-11-01")?.billOn).toBe("2026-12-01");
  });
});
