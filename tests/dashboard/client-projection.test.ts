// The projection: the billing sweep's rule run forward over the months to
// come. The bill dates and part periods are `billingDues`'s (proven in the
// billing tests); this proves which bills count, their month, their amount,
// and the rows they make.
import { describe, expect, it } from "vitest";
import { DashboardService, projectionMonths } from "../../src/usecase/dashboard/service";
import type { BillingSubject } from "../../src/usecase/billing/ports";
import { FakeDashboardRepo } from "../../src/testfakes/dashboard";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { FakeFiscalYearSource } from "../../src/testfakes/billing";
import { FakeClock } from "../../src/testfakes/clock";

const SUNRISE = "00000000-0000-4000-8000-00000000c001";
const GREENLEAF = "00000000-0000-4000-8000-00000000c002";
const MONA = "00000000-0000-4000-8000-00000000e001";
const RAVI = "00000000-0000-4000-8000-00000000e002";
const NEHA = "00000000-0000-4000-8000-00000000e003";
const ISSUER = "00000000-0000-4000-8000-00000000f001";

const window = (over: Partial<BillingSubject["engagements"][number]> = {}) => ({
  engagementId: "e1",
  status: "active",
  effectiveFrom: "2026-07-01",
  endsOn: null,
  pausedOn: null,
  resumedOn: null,
  deptCode: "FRC",
  ...over,
});

/** Monthly, billed at each month's end from July; July to September written. */
const subject = (over: Partial<BillingSubject> = {}): BillingSubject => ({
  engagementId: "e1",
  feeGroupId: null,
  partyId: SUNRISE,
  issuingEntityPartyId: ISSUER,
  currency: "INR",
  billingFrequency: "monthly",
  billingFrom: "2026-07-01",
  firstInvoiceOn: "2026-07-31",
  fullAmount: "25000.0000",
  engagements: [window()],
  duePeriodStarts: ["2026-07-01", "2026-08-01", "2026-09-01"],
  ...over,
});

function world(subjects: BillingSubject[], fiscalYear: number | null = 4) {
  const repo = new FakeDashboardRepo();
  repo.subjects = {
    engagements: [
      { engagementId: "e1", partyName: "Sunrise Textiles", entryKey: "acc", name: "Bookkeeping", deptCode: "FRC" },
      { engagementId: "e2", partyName: "Sunrise Textiles", entryKey: "gst", name: "GST returns", deptCode: "TRC" },
      { engagementId: "e3", partyName: "Sunrise Textiles", entryKey: "pay", name: "Payroll", deptCode: "FRC" },
      { engagementId: "e9", partyName: "Greenleaf Organics", entryKey: "gst", name: "GST returns", deptCode: "TRC" },
    ],
    feeGroups: [
      {
        feeGroupId: "g1",
        partyName: "Greenleaf Organics",
        title: "Accounting and Compliance",
        services: ["Bookkeeping", "GST returns"],
        deptCodes: ["FRC", "TRC"],
      },
    ],
  };
  repo.teams = {
    people: [
      { clientPartyId: SUNRISE, role: "key_manager", userId: MONA, name: "Mona", deptCode: null },
      { clientPartyId: SUNRISE, role: "spoc", userId: RAVI, name: "Ravi", deptCode: "FRC" },
      { clientPartyId: SUNRISE, role: "spoc", userId: NEHA, name: "Neha", deptCode: "TRC" },
      { clientPartyId: GREENLEAF, role: "key_manager", userId: RAVI, name: "Ravi", deptCode: null },
      { clientPartyId: GREENLEAF, role: "spoc", userId: NEHA, name: "Neha", deptCode: "TRC" },
    ],
    depts: [
      { code: "FRC", name: "Financial Reporting" },
      { code: "TRC", name: "Tax" },
    ],
  };
  const service = new DashboardService({
    dashboards: repo,
    timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
    fiscalYears: new FakeFiscalYearSource(fiscalYear),
    clock: new FakeClock(new Date("2026-10-15T06:00:00.000Z")),
    billing: {
      schedules: { subjectsFor: () => Promise.resolve(subjects) },
      calendars: { companyCalendars: () => Promise.resolve(new Map()) },
    },
  });
  return { repo, service };
}

const lineOf = (r: Awaited<ReturnType<DashboardService["projection"]>>, client: string, name: string) =>
  r.clients.find((c) => c.partyId === client)?.lines.find((l) => l.name === name);

describe("the projection", () => {
  it("runs from today to the end of the third month after this one", () => {
    expect(projectionMonths("2026-10-15", 3)).toEqual([
      { key: "2026-10", label: "Oct 2026", from: "2026-10-15", to: "2026-10-31" },
      { key: "2026-11", label: "Nov 2026", from: "2026-11-01", to: "2026-11-30" },
      { key: "2026-12", label: "Dec 2026", from: "2026-12-01", to: "2026-12-31" },
      { key: "2027-01", label: "Jan 2027", from: "2027-01-01", to: "2027-01-31" },
    ]);
    expect(projectionMonths("2026-12-31", 1).map((m) => m.key)).toEqual(["2026-12", "2027-01"]);
  });

  it("a service with no end runs on: one bill a month, by the month it falls due", async () => {
    const r = await world([subject()]).service.projection("t1", {});
    const line = lineOf(r, SUNRISE, "Bookkeeping");
    expect(line?.months).toEqual(["25000.00", "25000.00", "25000.00", "25000.00"]);
    expect(line?.total).toBe("100000.00");
    expect(r.currencies).toEqual([
      { currency: "INR", months: ["25000.00", "25000.00", "25000.00", "25000.00"], total: "100000.00" },
    ]);
  });

  it("an ended service bills its last part month and nothing after", async () => {
    const ended = subject({
      engagementId: "e2",
      fullAmount: "8000.0000",
      engagements: [window({ engagementId: "e2", status: "completed", endsOn: "2026-11-15", deptCode: "TRC" })],
    });
    const r = await world([ended]).service.projection("t1", {});
    expect(lineOf(r, SUNRISE, "GST returns")?.months).toEqual(["8000.00", "4000.00", "0", "0"]);
  });

  it("a paused service bills nothing while it is paused", async () => {
    const paused = subject({
      engagementId: "e3",
      engagements: [window({ engagementId: "e3", status: "paused", pausedOn: "2026-10-01", deptCode: "FRC" })],
    });
    const r = await world([paused]).service.projection("t1", {});
    expect(r.clients).toEqual([]);
  });

  it("leaves out a bill already written, and one whose date has passed (that is To raise's)", async () => {
    // Billed at each month's START: October's fell due on the 1st and is behind us;
    // November's was raised early, so it is written already.
    const advance = subject({
      firstInvoiceOn: "2026-07-01",
      duePeriodStarts: ["2026-07-01", "2026-08-01", "2026-09-01", "2026-11-01"],
    });
    const r = await world([advance]).service.projection("t1", {});
    expect(lineOf(r, SUNRISE, "Bookkeeping")?.months).toEqual(["0", "0", "25000.00", "25000.00"]);
  });

  it("a section is one row at its one fee, with its services and Depts' SPOCs", async () => {
    const group = subject({
      engagementId: null,
      feeGroupId: "g1",
      partyId: GREENLEAF,
      fullAmount: "40000.0000",
      engagements: [window({ engagementId: "e7" }), window({ engagementId: "e8", deptCode: "TRC" })],
    });
    const r = await world([group]).service.projection("t1", {});
    const line = lineOf(r, GREENLEAF, "Accounting and Compliance");
    expect(line?.kind).toBe("section");
    expect(line?.months).toEqual(["40000.00", "40000.00", "40000.00", "40000.00"]);
    expect(line?.services).toEqual(["Bookkeeping", "GST returns"]);
    expect(line?.spocs.map((s) => `${s.name}:${s.deptCode}`)).toEqual(["Neha:TRC"]);
    expect(r.clients[0]?.keyManager).toEqual({ userId: RAVI, name: "Ravi" });
  });

  it("a letter with no price counts its bills, at no amount", async () => {
    const r = await world([subject({ fullAmount: null })]).service.projection("t1", {});
    const line = lineOf(r, SUNRISE, "Bookkeeping");
    expect(line?.unpriced).toBe(4);
    expect(line?.total).toBe("0");
  });

  it("a quarterly service waits for the firm's financial year", async () => {
    const quarterly = subject({ billingFrequency: "quarterly", firstInvoiceOn: "2026-09-30", duePeriodStarts: ["2026-07-01"] });
    const none = await world([quarterly], null).service.projection("t1", {});
    expect(none.awaitingFiscalYear).toBe(1);
    expect(none.clients).toEqual([]);
    const april = await world([quarterly], 4).service.projection("t1", {});
    expect(lineOf(april, SUNRISE, "Bookkeeping")?.months).toEqual(["0", "0", "25000.00", "0"]);
  });

  it("filters by Key Manager, by SPOC (the Dept of the work), and by client", async () => {
    const subjects = [
      subject(),
      subject({ engagementId: "e2", engagements: [window({ engagementId: "e2", deptCode: "TRC" })] }),
      subject({ engagementId: "e9", partyId: GREENLEAF, engagements: [window({ engagementId: "e9", deptCode: "TRC" })] }),
    ];
    const w = world(subjects);
    const mona = await w.service.projection("t1", { keyManagerUserId: MONA });
    expect(mona.clients.map((c) => c.partyId)).toEqual([SUNRISE]);
    const ravi = await w.service.projection("t1", { spocUserId: RAVI });
    expect(ravi.clients.flatMap((c) => c.lines.map((l) => l.name))).toEqual(["Bookkeeping"]);
    const neha = await w.service.projection("t1", { spocUserId: NEHA });
    expect(neha.clients.flatMap((c) => c.lines.map((l) => `${c.name}:${l.name}`)).sort()).toEqual([
      "Greenleaf Organics:GST returns",
      "Sunrise Textiles:GST returns",
    ]);
    const one = await w.service.projection("t1", { partyId: GREENLEAF });
    expect(one.clients.map((c) => c.name)).toEqual(["Greenleaf Organics"]);
    expect(one.currencies[0]?.total).toBe("100000.00");
  });
});
