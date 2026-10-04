// Recurring work is cut and opened on its ISSUING COMPANY's calendar (0337):
// a UAE company on a January year labels its October quarter "Q4 2026" and
// opens it at midnight in Dubai; the Indian company beside it, on the firm's
// April year, labels the same three months "Q3 FY2026-27".
import { describe, expect, it } from "vitest";
import { SchedulerService } from "../../src/usecase/scheduler/service";
import {
  FakeActivationFeed,
  FakeCompliancePolicy,
  FakeJobRepo,
  FakeRecurringFeed,
  FakeTenantDirectory,
  FakeWorkItemSpawner,
  FakeWorkSplit,
} from "../../src/testfakes/scheduler";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import type { RecurringEngagement } from "../../src/usecase/scheduler/ports";
import { systemIds } from "../../src/platform/ids";
import type { IdGen } from "../../src/platform/ids";

const FIRM = "00000000-0000-4000-8000-0000000000a1";
const UAE_CO = "00000000-0000-4000-8000-0000000000d1";
const IN_CO = "00000000-0000-4000-8000-0000000000d2";
const UAE_LETTER = "00000000-0000-4000-8000-0000000000b1";
const IN_LETTER = "00000000-0000-4000-8000-0000000000b2";
const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const UAE_WORK = "00000000-0000-4000-8000-0000000000e1";
const IN_WORK = "00000000-0000-4000-8000-0000000000e2";

function engine(now: string, firmYear: number | null, uaeOnItsOwn = true, ids: IdGen = new FakeIds()) {
  const jobs = new FakeJobRepo();
  const recurring = new FakeRecurringFeed();
  recurring.jobs = jobs;
  const policy = new FakeCompliancePolicy();
  policy.fiscalYear = firmYear;
  const zone = new FakeFirmTimeZone("Asia/Kolkata");
  if (uaeOnItsOwn) zone.setCompany(UAE_CO, { timeZone: "Asia/Dubai", fiscalYearStartMonth: 1 });
  const service = new SchedulerService({
    jobs,
    activations: new FakeActivationFeed(),
    recurring,
    compliancePolicy: policy,
    timeZone: zone,
    tenants: new FakeTenantDirectory([FIRM]),
    splitAxis: new FakeWorkSplit(),
    workItems: new FakeWorkItemSpawner(),
    ids,
    clock: new FakeClock(new Date(now)),
    events: new RecordingEventSink(),
  });
  return { service, jobs, recurring, zone };
}

function work(
  engagementId: string,
  letter: string,
  issuer: string,
  recurrence: string,
): Omit<RecurringEngagement, "linkedPeriods"> {
  return {
    engagementId,
    engagementLetterId: letter,
    entityPartyId: CLIENT,
    issuingEntityPartyId: issuer,
    deptCode: null,
    teamCode: null,
    workflowKey: null,
    effectiveFrom: "2026-04-01",
    recurrence,
    slaDays: 10,
    endsOn: null,
    resumedOn: null,
  };
}

const jobsOf = (jobs: FakeJobRepo, letterWork: string) =>
  jobs.rows.filter((j) => jobs.linksFor(FIRM, letterWork).some((l) => l.jobId === j.id));
const jobOf = (jobs: FakeJobRepo, letterWork: string) => jobsOf(jobs, letterWork)[0];

describe("recurring work follows its company's calendar (0337)", () => {
  it("labels and opens a quarter on each company's own year and clock", async () => {
    const { service, jobs, recurring } = engine("2026-11-15T09:00:00Z", 4);
    recurring.add(FIRM, work(UAE_WORK, UAE_LETTER, UAE_CO, "quarterly"));
    recurring.add(FIRM, work(IN_WORK, IN_LETTER, IN_CO, "quarterly"));

    await service.sweepActivations();

    expect(jobOf(jobs, UAE_WORK)).toMatchObject({
      periodStart: "2026-10-01",
      periodEnd: "2026-12-31",
      periodLabel: "Q4 2026",
      // Midnight on 1 January in Dubai (UTC+4).
      runnableAt: "2026-12-31T20:00:00.000Z",
    });
    expect(jobOf(jobs, IN_WORK)).toMatchObject({
      periodStart: "2026-10-01",
      periodEnd: "2026-12-31",
      periodLabel: "Q3 FY2026-27",
      runnableAt: "2026-12-31T18:30:00.000Z",
    });
  });

  it("cuts a company's quarter on its own year when the firm has published none", async () => {
    const { service, jobs, recurring } = engine("2026-11-15T09:00:00Z", null);
    recurring.add(FIRM, work(UAE_WORK, UAE_LETTER, UAE_CO, "quarterly"));
    recurring.add(FIRM, work(IN_WORK, IN_LETTER, IN_CO, "quarterly"));

    const [report] = await service.sweepActivations();

    expect(report).toMatchObject({ periodsSpawned: 1, awaitingFiscalYear: 1 });
    expect(jobOf(jobs, UAE_WORK)?.periodLabel).toBe("Q4 2026");
  });

  it("opens the month under way on the company's own today", async () => {
    // 19:00 UTC on 30 September: already 1 October in Delhi, still 30 September in Dubai.
    const { service, jobs, recurring } = engine("2026-09-30T19:00:00Z", 4);
    recurring.add(FIRM, work(UAE_WORK, UAE_LETTER, UAE_CO, "monthly"));
    recurring.add(FIRM, work(IN_WORK, IN_LETTER, IN_CO, "monthly"));

    await service.sweepActivations();

    // September's books are still owed in both; October has begun only in Delhi.
    expect(jobsOf(jobs, UAE_WORK).map((j) => j.periodLabel)).toEqual(["Sep 2026"]);
    expect(jobsOf(jobs, IN_WORK).map((j) => j.periodLabel)).toEqual(["Sep 2026", "Oct 2026"]);
  });

  // FINAL REVIEW #2: a company's year change must not re-cut work already
  // under way. The engagement keeps the year its first period was cut on.
  it("pins the year on the first period, and keeps it after the company changes year", async () => {
    const { service, jobs, recurring, zone } = engine("2026-11-15T09:00:00Z", 4);
    recurring.add(FIRM, work(UAE_WORK, UAE_LETTER, UAE_CO, "annually"));
    await service.sweepActivations();
    expect(recurring.pins.get(UAE_WORK)).toBe(1);
    expect(jobsOf(jobs, UAE_WORK).map((j) => j.periodLabel)).toEqual(["2026"]);

    zone.setCompany(UAE_CO, { timeZone: "Asia/Dubai", fiscalYearStartMonth: 4 });
    await service.sweepActivations();
    // No April-cut "FY2026-27" job beside the open "2026" one.
    expect(jobsOf(jobs, UAE_WORK).map((j) => j.periodLabel)).toEqual(["2026"]);
  });

  it("cuts an engagement already pinned on its pinned year", async () => {
    const { service, jobs, recurring } = engine("2026-11-15T09:00:00Z", 4);
    recurring.add(FIRM, { ...work(UAE_WORK, UAE_LETTER, UAE_CO, "annually"), yearStartMonth: 4 });
    await service.sweepActivations();
    expect(jobsOf(jobs, UAE_WORK).map((j) => j.periodLabel)).toEqual(["FY2026-27"]);
  });

  it("leaves an Indian job's identity exactly as it was before companies had calendars", async () => {
    // The real derived ids: a job's identity is a pure function of its key.
    const before = engine("2026-11-15T09:00:00Z", 4, false, systemIds);
    before.recurring.add(FIRM, work(IN_WORK, IN_LETTER, IN_CO, "quarterly"));
    await before.service.sweepActivations();
    const after = engine("2026-11-15T09:00:00Z", 4, true, systemIds);
    after.recurring.add(FIRM, work(UAE_WORK, UAE_LETTER, UAE_CO, "quarterly"));
    after.recurring.add(FIRM, work(IN_WORK, IN_LETTER, IN_CO, "quarterly"));
    await after.service.sweepActivations();

    expect(jobOf(after.jobs, IN_WORK)?.sourceRef).toBe(jobOf(before.jobs, IN_WORK)?.sourceRef);
  });
});
