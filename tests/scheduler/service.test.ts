// The scheduler's business rules (T2.6), against in-memory fakes and a clock a
// test can move.
//
// Almost every test here is about the same property: EVERY TRIGGER IS
// AT-LEAST-ONCE. pg-boss redelivers on a crash, the ledger sweep re-reads
// events it has already seen, and a worker restart leaves a message
// unacknowledged. None of that may produce a second job — because a second job
// is a second set of tasks for staff, a second filing, and eventually a second
// invoice. That is not a rare edge case; it is the ordinary weather this engine
// runs in.
import { FakeClock } from "../../src/testfakes/clock";
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
import type { Activation, RecurringEngagement } from "../../src/usecase/scheduler/ports";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import { InvalidTransition, JobNotFound } from "../../src/domain/scheduler/errors";

const FIRM_A = "00000000-0000-4000-8000-0000000000a1";
const FIRM_B = "00000000-0000-4000-8000-0000000000a2";
const ENGAGEMENT_1 = "00000000-0000-4000-8000-0000000000e1";
const ENGAGEMENT_2 = "00000000-0000-4000-8000-0000000000e2";
const NOW = "2026-08-29T09:00:00.000Z";
const LETTER_1 = "00000000-0000-4000-8000-0000000000L1".replace("L", "b");
const ENTITY_1 = "00000000-0000-4000-8000-0000000000c1";
const ISSUER_1 = "00000000-0000-4000-8000-0000000000d1";

/** An activation with the grouping facts filled in (T2.7).
 *
 *  Defaults are the UNFILED, UNSPLIT case on purpose: no Dept, no team, no
 *  process. Every test written before the merge existed is asserting against a
 *  firm on `none`, and that must keep meaning exactly what it meant. A test
 *  about the merge says so by overriding. */
function activation(engagementId: string, occurredAt: string, over: Partial<Activation> = {}): Activation {
  return {
    engagementId,
    occurredAt,
    engagementLetterId: LETTER_1,
    entityPartyId: ENTITY_1,
    deptCode: null,
    teamCode: null,
    workflowKey: null,
    ...over,
  };
}

function engine(tenantIds: string[] = [FIRM_A]) {
  const jobs = new FakeJobRepo();
  const activations = new FakeActivationFeed();
  activations.jobs = jobs; // the anti-join, as the real query does it
  const events = new RecordingEventSink();
  const clock = new FakeClock(new Date(NOW));
  const split = new FakeWorkSplit();
  const workItems = new FakeWorkItemSpawner();
  const recurring = new FakeRecurringFeed();
  recurring.jobs = jobs; // the linked-periods anti-join, as the real query does it
  const policy = new FakeCompliancePolicy();
  const zone = new FakeFirmTimeZone();
  const service = new SchedulerService({
    jobs,
    activations,
    recurring,
    compliancePolicy: policy,
    timeZone: zone,
    tenants: new FakeTenantDirectory(tenantIds),
    splitAxis: split,
    // T3.1's seam. Recorded rather than performed: what the work-item service
    // does with these engagements is `tests/workitem/`'s business, and what
    // matters HERE is that a second sweep hands over nothing.
    workItems,
    ids: new FakeIds(),
    clock,
    events,
  });
  return { service, jobs, activations, events, clock, split, workItems, recurring, policy, zone };
}

describe("a released contract becomes a job", () => {
  it("spawns one job per activation, and records it", async () => {
    const { service, jobs, activations, events } = engine();
    activations.add(FIRM_A, activation(ENGAGEMENT_1, "2026-08-28T10:00:00.000Z"));

    const [report] = await service.sweepActivations();
    expect(report).toMatchObject({ tenantId: FIRM_A, spawned: 1, alreadySpawned: 0 });
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]).toMatchObject({
      sourceKind: "engagement",
      sourceRef: ENGAGEMENT_1,
      status: "pending",
    });
    expect(events.verbs()).toEqual(["job.spawned"]);
  });

  it("records WHEN THE CONTRACT ACTIVATED, not when the cron noticed", async () => {
    // The fact is that a contract became active. That a sweep happened to run
    // an hour later is an implementation detail of ours, and a timeline built
    // from these events should read as the business rather than as our cadence.
    const { service, events, activations, clock } = engine();
    activations.add(FIRM_A, activation(ENGAGEMENT_1, "2026-08-28T10:00:00.000Z"));

    // A whole day passes before the sweep runs — a worker that was down, or an
    // hourly cadence over a weekend.
    clock.set("2026-08-29T09:00:00.000Z");
    await service.sweepActivations();

    expect(events.recorded[0]?.payload).toMatchObject({
      activatedAt: "2026-08-28T10:00:00.000Z",
      sourceRef: ENGAGEMENT_1,
    });
  });

  it("makes the work runnable immediately — a client is already waiting", async () => {
    // An engagement carries no lead time of its own, unlike an obligation whose
    // whole point is to open T–X before a statutory date.
    const { service, jobs, activations } = engine();
    activations.add(FIRM_A, activation(ENGAGEMENT_1, "2026-08-28T10:00:00.000Z"));
    await service.sweepActivations();
    expect(jobs.rows[0]?.runnableAt).toBe(NOW);
  });
});

describe("at-least-once: the same trigger twice does nothing twice", () => {
  it("spawns nothing on a second sweep", async () => {
    const { service, jobs, events, activations } = engine();
    activations.add(FIRM_A, activation(ENGAGEMENT_1, "2026-08-28T10:00:00.000Z"));

    await service.sweepActivations();
    const [second] = await service.sweepActivations();

    expect(second).toMatchObject({ spawned: 0 });
    expect(jobs.rows).toHaveLength(1);
    // ONE event, not two. A duplicate here is permanent — the log cannot be
    // corrected — and it would make "how many jobs did this contract create"
    // unanswerable from the trail.
    expect(events.verbs()).toEqual(["job.spawned"]);
  });

  it("refuses a second job even when the id is minted differently", async () => {
    // The unique key is on (tenant, kind, ref), NOT on the id. A caller that
    // generated a fresh uuid — a different worker version, a hand-run script —
    // must still lose, or idempotency would depend on everyone deriving ids the
    // same way forever.
    const { jobs } = engine();
    const base = {
      tenantId: FIRM_A,
      sourceKind: "engagement" as const,
      sourceRef: ENGAGEMENT_1,
      runnableAt: NOW,
      splitAxis: "none" as const,
      splitCode: null,
    };
    const first = await jobs.createIfAbsent({ ...base, id: "00000000-0000-4000-8000-00000000f001" });
    const second = await jobs.createIfAbsent({ ...base, id: "00000000-0000-4000-8000-00000000f002" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(jobs.rows).toHaveLength(1);
  });

  it("derives the same job id for the same engagement on every replay", async () => {
    // Belt to the unique key's braces: a replay mints the id it minted before,
    // so the second insert conflicts on the primary key too.
    const a = engine();
    const b = engine();
    a.activations.add(FIRM_A, activation(ENGAGEMENT_1, "2026-08-28T10:00:00.000Z"));
    b.activations.add(FIRM_A, activation(ENGAGEMENT_1, "2026-08-28T10:00:00.000Z"));
    await a.service.sweepActivations();
    await b.service.sweepActivations();
    expect(a.jobs.rows[0]?.id).toBe(b.jobs.rows[0]?.id);
  });
});

describe("the sweep walks firms, one context at a time", () => {
  it("spawns for each firm independently", async () => {
    const { service, jobs, activations } = engine([FIRM_A, FIRM_B]);
    activations.add(FIRM_A, activation(ENGAGEMENT_1, "2026-08-28T10:00:00.000Z"));
    activations.add(FIRM_B, activation(ENGAGEMENT_2, "2026-08-28T11:00:00.000Z"));

    const reports = await service.sweepActivations();
    expect(reports.map((r) => r.spawned)).toEqual([1, 1]);
    expect(jobs.rows.map((j) => j.tenantId).sort()).toEqual([FIRM_A, FIRM_B]);
  });

  it("gives one firm's job the other firm's tenant on neither", async () => {
    const { service, jobs, activations } = engine([FIRM_A, FIRM_B]);
    activations.add(FIRM_A, activation(ENGAGEMENT_1, "2026-08-28T10:00:00.000Z"));
    await service.sweepActivations();
    expect(jobs.rows.every((j) => j.tenantId === FIRM_A)).toBe(true);
  });

  it("reports a firm with nothing to do as nothing to do", async () => {
    const { service } = engine([FIRM_A, FIRM_B]);
    const reports = await service.sweepActivations();
    expect(reports).toHaveLength(2);
    expect(reports.every((r) => r.spawned === 0 && r.alreadySpawned === 0)).toBe(true);
  });
});

describe("what is runnable, and when", () => {
  it("returns nothing before a job's window opens", async () => {
    const { service, jobs, clock } = engine();
    await jobs.createIfAbsent({
      id: "00000000-0000-4000-8000-00000000f010",
      tenantId: FIRM_A,
      sourceKind: "obligation",
      sourceRef: ENGAGEMENT_2,
      splitAxis: "none" as const,
      splitCode: null,
      // T–X: a filing due next month, materialised now and not yet runnable.
      runnableAt: "2026-09-10T00:00:00.000Z",
    });
    expect(await service.runnableJobs(FIRM_A)).toHaveLength(0);

    clock.set("2026-09-10T06:00:00.000Z");
    expect(await service.runnableJobs(FIRM_A)).toHaveLength(1);
  });

  it("returns the oldest first, so a backlog is worked in the order it was owed", async () => {
    const { service, jobs } = engine();
    for (const [id, ref, at] of [
      ["00000000-0000-4000-8000-00000000f021", ENGAGEMENT_1, "2026-08-27T00:00:00.000Z"],
      ["00000000-0000-4000-8000-00000000f022", ENGAGEMENT_2, "2026-08-25T00:00:00.000Z"],
    ] as const) {
      await jobs.createIfAbsent({
        id,
        tenantId: FIRM_A,
        sourceKind: "engagement",
        sourceRef: ref,
        runnableAt: at,
        splitAxis: "none" as const,
        splitCode: null,
      });
    }
    const runnable = await service.runnableJobs(FIRM_A);
    expect(runnable.map((j) => j.runnableAt)).toEqual([
      "2026-08-25T00:00:00.000Z",
      "2026-08-27T00:00:00.000Z",
    ]);
  });

  it("stops offering a job once it is finished", async () => {
    const { service, jobs, activations } = engine();
    activations.add(FIRM_A, activation(ENGAGEMENT_1, "2026-08-28T10:00:00.000Z"));
    await service.sweepActivations();
    const job = jobs.rows[0];
    if (!job) throw new Error("no job");

    await service.transition(FIRM_A, job.id, "running");
    expect(await service.runnableJobs(FIRM_A)).toHaveLength(1);
    await service.transition(FIRM_A, job.id, "done");
    expect(await service.runnableJobs(FIRM_A)).toHaveLength(0);
  });
});

describe("a finished job is finished", () => {
  async function spawned() {
    const e = engine();
    e.activations.add(FIRM_A, activation(ENGAGEMENT_1, "2026-08-28T10:00:00.000Z"));
    await e.service.sweepActivations();
    const job = e.jobs.rows[0];
    if (!job) throw new Error("no job");
    return { ...e, job };
  }

  it("refuses to restart work that already completed", async () => {
    // THE guard. A redelivered message for a done job is not a harmless retry —
    // it is a second filing and a second task on somebody's desk.
    const { service, job } = await spawned();
    await service.transition(FIRM_A, job.id, "running");
    await service.transition(FIRM_A, job.id, "done");
    await expect(service.transition(FIRM_A, job.id, "running")).rejects.toBeInstanceOf(
      InvalidTransition,
    );
  });

  it("refuses to reopen a cancelled job too", async () => {
    const { service, job } = await spawned();
    await service.transition(FIRM_A, job.id, "cancelled");
    await expect(service.transition(FIRM_A, job.id, "pending")).rejects.toBeInstanceOf(
      InvalidTransition,
    );
  });

  it("records nothing when the status is already the one asked for", async () => {
    const { service, events, job } = await spawned();
    await service.transition(FIRM_A, job.id, "running");
    const before = events.verbs().length;
    await service.transition(FIRM_A, job.id, "running");
    expect(events.verbs()).toHaveLength(before);
  });

  it("keeps the moment it FIRST started across a block and a resume", async () => {
    const { service, job } = await spawned();
    const started = await service.transition(FIRM_A, job.id, "running");
    await service.transition(FIRM_A, job.id, "blocked");
    const resumed = await service.transition(FIRM_A, job.id, "running");
    expect(resumed.startedAt).toBe(started.startedAt);
  });

  it("names the terminal move differently from an intermediate one", async () => {
    const { service, events, job } = await spawned();
    await service.transition(FIRM_A, job.id, "running");
    await service.transition(FIRM_A, job.id, "done");
    expect(events.verbs()).toEqual(["job.spawned", "job.step_advanced", "job.completed"]);
  });

  it("refuses a job that is not this firm's", async () => {
    const { service, job } = await spawned();
    await expect(service.transition(FIRM_B, job.id, "running")).rejects.toBeInstanceOf(
      JobNotFound,
    );
  });
});

describe("the actor on a spawned job", () => {
  it("is the system, because a clock did it", async () => {
    // Nobody spawned this. The trail has to be able to say so rather than
    // attributing a cron to whoever happened to sign the letter.
    const { service, events, activations } = engine();
    activations.add(FIRM_A, activation(ENGAGEMENT_1, "2026-08-28T10:00:00.000Z"));
    await service.sweepActivations(SYSTEM_ACTOR);
    expect(events.recorded[0]?.actorType).toBe("system");
    expect(events.recorded[0]?.actorId).toBeNull();
  });
});

describe("one firm's failure must not stop the others", () => {
  // THE COMMENT SAID THIS FROM T2.6 AND THE CODE DID NOT DO IT. A throw in
  // `spawnForTenant` propagated straight out of the loop, so every firm after
  // it in the list was skipped, silently, until somebody read a worker log.
  //
  // T3.1 is what found it: one firm with no work-item states stopped the
  // calendar for every client of every firm on the box. These two tests are
  // what stop it coming back.

  it("carries on to the next firm, and REPORTS the one it skipped", async () => {
    const jobs = new FakeJobRepo();
    const activations = new FakeActivationFeed();
    activations.jobs = jobs;
    activations.add(FIRM_A, activation(ENGAGEMENT_1, "2026-08-28T10:00:00.000Z"));
    activations.add(FIRM_B, activation(ENGAGEMENT_2, "2026-08-28T10:00:00.000Z"));

    const service = new SchedulerService({
      jobs,
      // Firm A's read throws; firm B's is fine. A is first in the list, which
      // is the ordering that used to lose B entirely.
      activations: {
        unspawnedActivations: (tenantId, limit) => {
          if (tenantId === FIRM_A) throw new Error("this firm's feed is broken");
          return activations.unspawnedActivations(tenantId, limit);
        },
      },
      recurring: new FakeRecurringFeed(),
      compliancePolicy: new FakeCompliancePolicy(),
      timeZone: new FakeFirmTimeZone(),
      tenants: new FakeTenantDirectory([FIRM_A, FIRM_B]),
      splitAxis: new FakeWorkSplit(),
      workItems: new FakeWorkItemSpawner(),
      ids: new FakeIds(),
      clock: new FakeClock(new Date(NOW)),
      events: new RecordingEventSink(),
    });

    const reports = await service.sweepActivations();

    // Both firms are reported, and the broken one SAYS so. A silently skipped
    // firm is a calendar that stops without anybody being told.
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({ tenantId: FIRM_A, spawned: 0 });
    expect(reports[0]?.failure).toContain("broken");
    expect(reports[1]).toMatchObject({ tenantId: FIRM_B, spawned: 1 });
    // Asserted separately: `toMatchObject` treats an `undefined` value as a key
    // that must be PRESENT, and the healthy report deliberately omits it.
    expect(reports[1]?.failure).toBeUndefined();
  });

  it("keeps the JOB when the TASK cannot be created, and counts it", async () => {
    // Two separate facts, and the second must never undo the first. A job is
    // the record that work is OWED; a task is whose desk it lands on. Losing
    // the job because a task could not be routed would lose the work entirely.
    const jobs = new FakeJobRepo();
    const activations = new FakeActivationFeed();
    activations.jobs = jobs;
    activations.add(FIRM_A, activation(ENGAGEMENT_1, "2026-08-28T10:00:00.000Z"));

    const service = new SchedulerService({
      jobs,
      activations,
      recurring: new FakeRecurringFeed(),
      compliancePolicy: new FakeCompliancePolicy(),
      timeZone: new FakeFirmTimeZone(),
      tenants: new FakeTenantDirectory([FIRM_A]),
      splitAxis: new FakeWorkSplit(),
      workItems: {
        spawnForEngagements: () => {
          throw new Error("this firm has no starting state for work items");
        },
      },
      ids: new FakeIds(),
      clock: new FakeClock(new Date(NOW)),
      events: new RecordingEventSink(),
    });

    const [report] = await service.sweepActivations();

    expect(jobs.rows).toHaveLength(1);
    expect(report).toMatchObject({ spawned: 1, tasksFailed: 1 });
    expect(report?.failure).toBeUndefined();
  });
});

// ── T6.13: a recurring engagement is owed a job PER PERIOD ──────────────────

/** A monthly engagement as the feed reports it: bookkeeping since April, ten
 *  days' turnaround. Defaults are the unsplit, unfiled case, like
 *  `activation()` above, and for the same reason. */
function monthly(
  engagementId: string,
  over: Partial<Omit<RecurringEngagement, "linkedPeriods">> = {},
): Omit<RecurringEngagement, "linkedPeriods"> {
  return {
    engagementId,
    engagementLetterId: LETTER_1,
    entityPartyId: ENTITY_1,
    // A company that set no calendar of its own (0337): the firm's.
    issuingEntityPartyId: ISSUER_1,
    deptCode: null,
    teamCode: null,
    workflowKey: null,
    effectiveFrom: "2026-04-01",
    recurrence: "monthly",
    slaDays: 10,
    endsOn: null,
    resumedOn: null,
    ...over,
  };
}

describe("a recurring engagement gets a job PER PERIOD, not one at activation", () => {
  // NOW is 29 August. With no floor the firm went live today, so August's
  // books — begun, due 10 September — are the first period this product owns.

  it("spawns the job for the month under way, carrying its period", async () => {
    const { service, jobs, recurring, workItems, events } = engine();
    recurring.add(FIRM_A, monthly(ENGAGEMENT_1));

    const [report] = await service.sweepActivations();

    expect(report).toMatchObject({ spawned: 0, periodsSpawned: 1, awaitingFiscalYear: 0 });
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]).toMatchObject({
      sourceKind: "engagement_period",
      status: "pending",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      periodLabel: "Aug 2026",
      // The day AFTER the period ends, at the start of that day on UTC — the
      // fake firm's zone. "Comes after close of month", in the firm's words.
      runnableAt: "2026-09-01T00:00:00.000Z",
    });
    // The link carries the period, which is what makes the key per period.
    expect(jobs.linksFor(FIRM_A, ENGAGEMENT_1)).toEqual([
      expect.objectContaining({ periodStart: "2026-08-01" }),
    ]);
    // And the work-item side is told WHICH month, so the umbrella task is
    // named for it and dated from its end.
    expect(workItems.calls).toEqual([
      expect.objectContaining({
        engagementIds: [ENGAGEMENT_1],
        period: { label: "Aug 2026", start: "2026-08-01", end: "2026-08-31" },
      }),
    ]);
    expect(events.verbs()).toEqual(["job.spawned"]);
    expect(events.recorded[0]?.payload).toMatchObject({
      sourceKind: "engagement_period",
      periodStart: "2026-08-01",
      periodLabel: "Aug 2026",
      engagementIds: [ENGAGEMENT_1],
    });
  });

  it("reaches back to the firm's floor, one job per month, and no further", async () => {
    const { service, jobs, recurring, policy } = engine();
    recurring.add(FIRM_A, monthly(ENGAGEMENT_1));
    policy.floor = "2026-07-01";

    const [report] = await service.sweepActivations();

    expect(report?.periodsSpawned).toBe(3);
    expect(jobs.rows.map((j) => j.periodLabel)).toEqual(["Jun 2026", "Jul 2026", "Aug 2026"]);
  });

  it("does it ONCE, however many times the sweep runs", async () => {
    const { service, jobs, recurring, events } = engine();
    recurring.add(FIRM_A, monthly(ENGAGEMENT_1));

    await service.sweepActivations();
    const [second] = await service.sweepActivations();
    const [third] = await service.sweepActivations();

    expect(second).toMatchObject({ periodsSpawned: 0, periodsExtended: 0 });
    expect(third).toMatchObject({ periodsSpawned: 0, periodsExtended: 0 });
    expect(jobs.rows).toHaveLength(1);
    // ONE event. The log cannot be corrected, and "how many months did we
    // owe this client" has to be answerable from it.
    expect(events.verbs()).toEqual(["job.spawned"]);
  });

  it("opens the day after the period ends WHERE THE FIRM IS", async () => {
    const { service, jobs, recurring, zone } = engine();
    zone.set("Asia/Kolkata");
    recurring.add(FIRM_A, monthly(ENGAGEMENT_1));

    await service.sweepActivations();

    // 1 September, 00:00 in Kolkata — which is 18:30 UTC on the 31st. Midnight
    // UTC would open the job five and a half hours late for the firm this was
    // built for.
    expect(jobs.rows[0]?.runnableAt).toBe("2026-08-31T18:30:00.000Z");
  });

  it("a quarterly service waits for the firm's financial year, and SAYS so", async () => {
    const { service, jobs, recurring, policy } = engine();
    recurring.add(FIRM_A, monthly(ENGAGEMENT_1, { recurrence: "quarterly" }));

    const [before] = await service.sweepActivations();
    expect(before).toMatchObject({ periodsSpawned: 0, awaitingFiscalYear: 1 });
    expect(jobs.rows).toHaveLength(0);

    // The firm answers: April. The quarter under way is Jul–Sep.
    policy.fiscalYear = 4;
    const [after] = await service.sweepActivations();
    expect(after).toMatchObject({ periodsSpawned: 1, awaitingFiscalYear: 0 });
    expect(jobs.rows[0]).toMatchObject({
      periodStart: "2026-07-01",
      periodEnd: "2026-09-30",
      periodLabel: "Q2 FY2026-27",
    });
  });

  it("a service that names no period produces nothing here, never a guessed calendar", async () => {
    // Belt and braces: the real feed never offers a `custom` service, but a
    // fake that did must still produce nothing.
    const { service, jobs, recurring } = engine();
    recurring.add(FIRM_A, monthly(ENGAGEMENT_1, { recurrence: "custom" }));
    const [report] = await service.sweepActivations();
    expect(report?.periodsSpawned).toBe(0);
    expect(jobs.rows).toHaveLength(0);
  });

  it("cuts a month's work with the SAME rule that cuts a letter's", async () => {
    // Split by Dept: two monthly services on one letter, both FRC, one
    // process — ONE August checklist, exactly as their activations would
    // have been one job.
    const { service, jobs, recurring, split, workItems } = engine();
    split.axis = "dept";
    recurring.add(FIRM_A, monthly(ENGAGEMENT_1, { deptCode: "FRC", workflowKey: "monthly-books" }));
    recurring.add(FIRM_A, monthly(ENGAGEMENT_2, { deptCode: "FRC", workflowKey: "monthly-books" }));

    const [report] = await service.sweepActivations();

    expect(report?.periodsSpawned).toBe(1);
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]).toMatchObject({ splitAxis: "dept", splitCode: "FRC" });
    expect(workItems.calls[0]?.engagementIds).toEqual([ENGAGEMENT_1, ENGAGEMENT_2]);
  });

  it("under `none`, two monthly services on one letter are two checklists a month", async () => {
    const { service, jobs, recurring } = engine();
    recurring.add(FIRM_A, monthly(ENGAGEMENT_1));
    recurring.add(FIRM_A, monthly(ENGAGEMENT_2));

    const [report] = await service.sweepActivations();

    expect(report?.periodsSpawned).toBe(2);
    expect(jobs.rows).toHaveLength(2);
    expect(new Set(jobs.rows.map((j) => j.sourceRef)).size).toBe(2);
  });

  it("a service arriving after the month's checklist exists JOINS it, and says so", async () => {
    const { service, jobs, recurring, split, events } = engine();
    split.axis = "dept";
    recurring.add(FIRM_A, monthly(ENGAGEMENT_1, { deptCode: "FRC", workflowKey: "monthly-books" }));
    await service.sweepActivations();

    recurring.add(FIRM_A, monthly(ENGAGEMENT_2, { deptCode: "FRC", workflowKey: "monthly-books" }));
    const [report] = await service.sweepActivations();

    expect(report).toMatchObject({ periodsSpawned: 0, periodsExtended: 1 });
    expect(jobs.rows).toHaveLength(1);
    expect(events.verbs()).toEqual(["job.spawned", "job.scope_extended"]);
    expect(events.recorded[1]?.payload).toMatchObject({
      engagementIds: [ENGAGEMENT_2],
      periodLabel: "Aug 2026",
    });
  });

  it("runs beside the one-time spawn, and neither touches the other", async () => {
    const { service, jobs, activations, recurring } = engine();
    activations.add(FIRM_A, activation(ENGAGEMENT_1, "2026-08-28T10:00:00.000Z"));
    recurring.add(FIRM_A, monthly(ENGAGEMENT_2));

    const [report] = await service.sweepActivations();

    expect(report).toMatchObject({ spawned: 1, periodsSpawned: 1 });
    expect(jobs.rows.map((j) => j.sourceKind).sort()).toEqual(["engagement", "engagement_period"]);
  });

  it("is on the BOARD as upcoming, and NOT in the orchestrator's hands until its window opens", async () => {
    const { service, recurring } = engine();
    recurring.add(FIRM_A, monthly(ENGAGEMENT_1));
    await service.sweepActivations();

    // The month is under way: a partner plans from this row.
    expect(await service.openJobs(FIRM_A)).toHaveLength(1);
    // But nothing may start walking it until 1 September.
    expect(await service.runnableJobs(FIRM_A)).toHaveLength(0);
  });

  it("keeps the period JOB when its TASK cannot be created, and counts it", async () => {
    const jobs = new FakeJobRepo();
    const activations = new FakeActivationFeed();
    activations.jobs = jobs;
    const recurring = new FakeRecurringFeed();
    recurring.jobs = jobs;
    recurring.add(FIRM_A, monthly(ENGAGEMENT_1));

    const service = new SchedulerService({
      jobs,
      activations,
      recurring,
      compliancePolicy: new FakeCompliancePolicy(),
      timeZone: new FakeFirmTimeZone(),
      tenants: new FakeTenantDirectory([FIRM_A]),
      splitAxis: new FakeWorkSplit(),
      workItems: {
        spawnForEngagements: () => {
          throw new Error("this firm has no starting state for work items");
        },
      },
      ids: new FakeIds(),
      clock: new FakeClock(new Date(NOW)),
      events: new RecordingEventSink(),
    });

    const [report] = await service.sweepActivations();

    expect(report).toMatchObject({ periodsSpawned: 1, tasksFailed: 1 });
    expect(jobs.rows).toHaveLength(1);
  });
});
