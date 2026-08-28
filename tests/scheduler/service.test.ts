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
  FakeJobRepo,
  FakeTenantDirectory,
} from "../../src/testfakes/scheduler";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import { InvalidTransition, JobNotFound } from "../../src/domain/scheduler/errors";

const FIRM_A = "00000000-0000-4000-8000-0000000000a1";
const FIRM_B = "00000000-0000-4000-8000-0000000000a2";
const ENGAGEMENT_1 = "00000000-0000-4000-8000-0000000000e1";
const ENGAGEMENT_2 = "00000000-0000-4000-8000-0000000000e2";
const NOW = "2026-08-29T09:00:00.000Z";

function engine(tenantIds: string[] = [FIRM_A]) {
  const jobs = new FakeJobRepo();
  const activations = new FakeActivationFeed();
  activations.jobs = jobs; // the anti-join, as the real query does it
  const events = new RecordingEventSink();
  const clock = new FakeClock(new Date(NOW));
  const service = new SchedulerService({
    jobs,
    activations,
    tenants: new FakeTenantDirectory(tenantIds),
    ids: new FakeIds(),
    clock,
    events,
  });
  return { service, jobs, activations, events, clock };
}

describe("a released contract becomes a job", () => {
  it("spawns one job per activation, and records it", async () => {
    const { service, jobs, activations, events } = engine();
    activations.add(FIRM_A, { engagementId: ENGAGEMENT_1, occurredAt: "2026-08-28T10:00:00.000Z" });

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
    activations.add(FIRM_A, { engagementId: ENGAGEMENT_1, occurredAt: "2026-08-28T10:00:00.000Z" });

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
    activations.add(FIRM_A, { engagementId: ENGAGEMENT_1, occurredAt: "2026-08-28T10:00:00.000Z" });
    await service.sweepActivations();
    expect(jobs.rows[0]?.runnableAt).toBe(NOW);
  });
});

describe("at-least-once: the same trigger twice does nothing twice", () => {
  it("spawns nothing on a second sweep", async () => {
    const { service, jobs, events, activations } = engine();
    activations.add(FIRM_A, { engagementId: ENGAGEMENT_1, occurredAt: "2026-08-28T10:00:00.000Z" });

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
    a.activations.add(FIRM_A, { engagementId: ENGAGEMENT_1, occurredAt: "2026-08-28T10:00:00.000Z" });
    b.activations.add(FIRM_A, { engagementId: ENGAGEMENT_1, occurredAt: "2026-08-28T10:00:00.000Z" });
    await a.service.sweepActivations();
    await b.service.sweepActivations();
    expect(a.jobs.rows[0]?.id).toBe(b.jobs.rows[0]?.id);
  });
});

describe("the sweep walks firms, one context at a time", () => {
  it("spawns for each firm independently", async () => {
    const { service, jobs, activations } = engine([FIRM_A, FIRM_B]);
    activations.add(FIRM_A, { engagementId: ENGAGEMENT_1, occurredAt: "2026-08-28T10:00:00.000Z" });
    activations.add(FIRM_B, { engagementId: ENGAGEMENT_2, occurredAt: "2026-08-28T11:00:00.000Z" });

    const reports = await service.sweepActivations();
    expect(reports.map((r) => r.spawned)).toEqual([1, 1]);
    expect(jobs.rows.map((j) => j.tenantId).sort()).toEqual([FIRM_A, FIRM_B]);
  });

  it("gives one firm's job the other firm's tenant on neither", async () => {
    const { service, jobs, activations } = engine([FIRM_A, FIRM_B]);
    activations.add(FIRM_A, { engagementId: ENGAGEMENT_1, occurredAt: "2026-08-28T10:00:00.000Z" });
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
    activations.add(FIRM_A, { engagementId: ENGAGEMENT_1, occurredAt: "2026-08-28T10:00:00.000Z" });
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
    e.activations.add(FIRM_A, {
      engagementId: ENGAGEMENT_1,
      occurredAt: "2026-08-28T10:00:00.000Z",
    });
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
    activations.add(FIRM_A, { engagementId: ENGAGEMENT_1, occurredAt: "2026-08-28T10:00:00.000Z" });
    await service.sweepActivations(SYSTEM_ACTOR);
    expect(events.recorded[0]?.actorType).toBe("system");
    expect(events.recorded[0]?.actorId).toBeNull();
  });
});
