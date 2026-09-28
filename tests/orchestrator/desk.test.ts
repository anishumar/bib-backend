// Whose desk a step sits on (0301): the band on the template step, the
// assignee on the job step, the SPOC as the default, and the two refusals —
// somebody else's step, and a step the process says is not yours to do.
import { describe, expect, it } from "vitest";
import { OrchestratorService } from "../../src/usecase/orchestrator/service";
import { FakeJobRepo } from "../../src/testfakes/scheduler";
import {
  FakeAgentRunRepo,
  FakeAgentRuntime,
  FakeJobStepRepo,
  FakeJobSubjectSource,
  FakeStepDeskResolver,
  FakeTemplateSource,
  FakeTierSource,
  FakeStepCheckRepo,
  FakeJobTasks,
} from "../../src/testfakes/orchestrator";
import { SUGGESTED_TIERS } from "../../src/domain/agent/model";
import { FakeIds } from "../../src/testfakes/ids";
import { FakeClock } from "../../src/testfakes/clock";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import {
  FakeCheckerDirectory,
  FakeStepApprovalRepo,
  FakeVerificationPolicySource,
  FakeWorkPermissions,
} from "../../src/testfakes/verification";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import type { ResolvedTemplate, TemplateStep } from "../../src/usecase/orchestrator/ports";
import { NotYourStep, PerformerOutOfBand } from "../../src/domain/orchestrator/errors";
import { validateBody } from "../../src/domain/config/model";

const TENANT = "00000000-0000-4000-8000-0000000000d1";
const JOB = "00000000-0000-4000-8000-0000000000d9";
const ROHAN = "00000000-0000-4000-8000-0000000000da"; // Senior Associate, rank 4 — the SPOC
const KAVYA = "00000000-0000-4000-8000-0000000000db"; // Analyst, rank 1
const RAJAT = "00000000-0000-4000-8000-0000000000dc"; // Director, rank 9
const ACTOR = SYSTEM_ACTOR;

const JUNIOR = { minGradeRank: 1, minGradeCode: "analyst", maxGradeRank: 4, maxGradeCode: "senior_associate" };
const MANAGER_UP = { minGradeRank: 7, minGradeCode: "manager", maxGradeRank: null, maxGradeCode: null };

function step(over: Partial<TemplateStep> & { key: string }): TemplateStep {
  return { label: over.key, executor: "human", dependsOn: [], condition: null, verificationPolicyKey: null, performer: null, checklist: [], reviewPoints: [], ...over };
}
const template = (steps: readonly TemplateStep[]): ResolvedTemplate => ({ versionId: "v1", label: "Monthly close", steps });

interface Rungs {
  readonly keyManager?: { userId: string; displayName: string | null };
  readonly partner?: { userId: string; displayName: string | null };
  readonly noLookup?: FakeStepDeskResolver["noLookup"];
  readonly taskHolder?: { userId: string; displayName: string | null };
}

async function world(steps: readonly TemplateStep[], spoc: string | null, rungs: Rungs = {}) {
  const jobs = new FakeJobRepo();
  const stepRepo = new FakeJobStepRepo();
  const templates = new FakeTemplateSource();
  const subjects = new FakeJobSubjectSource();
  const events = new RecordingEventSink();
  const desks = new FakeStepDeskResolver();
  desks.spoc = spoc;
  desks.keyManager = rungs.keyManager ?? null;
  desks.partner = rungs.partner ?? null;
  desks.noLookup = rungs.noLookup ?? null;
  desks.taskHolder = rungs.taskHolder ?? null;
  const checkers = new FakeCheckerDirectory()
    .add({ userId: ROHAN, displayName: "Rohan Mehta", gradeRank: 4, gradeName: "Senior Associate" })
    .add({ userId: KAVYA, displayName: "Kavya Nair", gradeRank: 1, gradeName: "Analyst" })
    .add({ userId: RAJAT, displayName: "Rajat Gupta", gradeRank: 9, gradeName: "Director" });
  await jobs.createIfAbsent({
    id: JOB, tenantId: TENANT, sourceKind: "engagement", sourceRef: "e1",
    runnableAt: "2026-09-01T00:00:00.000Z", splitAxis: "dept" as const, splitCode: "FRC",
  });
  subjects.set(JOB, { workflowTemplateKey: "close", recurrence: "monthly", jurisdiction: "IN" });
  templates.publish(TENANT, "close", template(steps));
  const service = new OrchestratorService({
    jobTasks: new FakeJobTasks(),
    timeZones: new FakeFirmTimeZone(),
    desks, jobs, steps: stepRepo, stepChecks: new FakeStepCheckRepo(stepRepo), templates, subjects,
    tiers: new FakeTierSource().publish(SUGGESTED_TIERS),
    runs: new FakeAgentRunRepo(),
    agents: new FakeAgentRuntime(),
    checks: new FakeStepApprovalRepo(),
    policies: new FakeVerificationPolicySource(),
    checkers,
    permissions: new FakeWorkPermissions(),
    tenants: { activeTenantIds: () => Promise.resolve([TENANT]) },
    ids: new FakeIds(),
    clock: new FakeClock(new Date("2026-09-17T09:00:00.000Z")),
    events,
  });
  await service.walkForTenant(TENANT, ACTOR);
  return { service, stepRepo, events };
}

describe("whose desk a step starts on", () => {
  it("puts every human step inside its band on the Dept SPOC, and leaves the rest on nobody's", async () => {
    const w = await world(
      [step({ key: "open", performer: JUNIOR }), step({ key: "review", performer: MANAGER_UP, dependsOn: ["open"] }), step({ key: "mis", dependsOn: ["review"] })],
      ROHAN,
    );
    const by = new Map(w.stepRepo.rows.map((r) => [r.stepKey, r.assigneeUserId]));
    expect(by.get("open")).toBe(ROHAN);
    // A Senior Associate is not "Manager or above" — routing it to him anyway
    // would put work on a desk the firm's own process says may not do it.
    expect(by.get("review")).toBeNull();
    expect(by.get("mis")).toBe(ROHAN);
    const assigned = w.events.recorded.filter((e) => e.verb === "job.step_assigned");
    expect(assigned).toHaveLength(2);
    expect(assigned[0]?.payload).toMatchObject({ how: "spoc", assigneeUserId: ROHAN });
  });

  it("leaves everything unassigned when the client has no single SPOC", async () => {
    const w = await world([step({ key: "open", performer: JUNIOR })], null);
    expect(w.stepRepo.rows[0]?.assigneeUserId).toBeNull();
    expect(w.events.verbs()).not.toContain("job.step_assigned");
  });
});

describe("ticking a step", () => {
  it("refuses somebody else's step until it is taken, then records the taking", async () => {
    const w = await world([step({ key: "open", performer: JUNIOR })], ROHAN);
    await expect(
      w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "open" }, ACTOR, KAVYA),
    ).rejects.toBeInstanceOf(NotYourStep);

    const taken = await w.service.assignStep({ tenantId: TENANT, jobId: JOB, stepKey: "open", assigneeUserId: KAVYA }, ACTOR, KAVYA);
    expect(taken.assigneeUserId).toBe(KAVYA);
    const last = w.events.recorded.filter((e) => e.verb === "job.step_assigned").at(-1);
    expect(last?.payload).toMatchObject({ how: "taken", assigneeUserId: KAVYA, previousAssigneeUserId: ROHAN });

    const done = await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "open" }, ACTOR, KAVYA);
    expect(done.status).toBe("done");
    expect(done.performedBy).toBe(KAVYA);
  });

  it("refuses a person outside the band, whether ticking or being handed the step", async () => {
    const w = await world([step({ key: "review", performer: MANAGER_UP })], null);
    await expect(
      w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "review" }, ACTOR, KAVYA),
    ).rejects.toBeInstanceOf(PerformerOutOfBand);
    await expect(
      w.service.assignStep({ tenantId: TENANT, jobId: JOB, stepKey: "review", assigneeUserId: KAVYA }, ACTOR, RAJAT),
    ).rejects.toBeInstanceOf(PerformerOutOfBand);
    // The Director may, and a hand-over from a third person is recorded as one.
    const handed = await w.service.assignStep({ tenantId: TENANT, jobId: JOB, stepKey: "review", assigneeUserId: RAJAT }, ACTOR, ROHAN);
    expect(handed.assigneeUserId).toBe(RAJAT);
    expect(w.events.recorded.at(-1)?.payload).toMatchObject({ how: "handover" });
    expect(await w.service.myOpenSteps(TENANT, RAJAT)).toHaveLength(1);
  });

  it("tells the viewer, per step, whether the button is theirs — the same answer the refusal gives", async () => {
    const w = await world([step({ key: "open", performer: JUNIOR }), step({ key: "review", performer: MANAGER_UP })], ROHAN);
    const forKavya = await w.service.describeSteps(TENANT, JOB, KAVYA);
    expect(forKavya.find((d) => d.step.stepKey === "open")?.viewer).toEqual({ mayComplete: false, reason: "ON_ANOTHER_DESK" });
    expect(forKavya.find((d) => d.step.stepKey === "review")?.viewer).toEqual({ mayComplete: false, reason: "OUTSIDE_BAND" });
    const forRajat = await w.service.describeSteps(TENANT, JOB, RAJAT);
    expect(forRajat.find((d) => d.step.stepKey === "review")?.viewer).toEqual({ mayComplete: true, reason: null });
    // On Rohan's desk AND outside Rajat's grade: the band wins, because taking
    // it would be refused too — "on another desk" would offer a Take button.
    expect(forRajat.find((d) => d.step.stepKey === "open")?.viewer).toEqual({ mayComplete: false, reason: "OUTSIDE_BAND" });
    expect(forRajat.find((d) => d.step.stepKey === "open")?.assignee).toEqual({ userId: ROHAN, displayName: "Rohan Mehta" });
    const who = await w.service.performersFor(TENANT, JOB, "review");
    expect(who.map((p) => p.userId)).toEqual([RAJAT]);
  });
});

describe("the band on a template step", () => {
  const body = (performer: unknown) => ({
    label: "Close",
    steps: [{ key: "open", label: "Open", executor: "human", dependsOn: [], condition: null, verificationPolicyKey: null, performer }],
  });
  it("accepts a band, an open-ended band, and null", () => {
    expect(validateBody("workflow_template", body(JUNIOR))).toBeNull();
    expect(validateBody("workflow_template", body(MANAGER_UP))).toBeNull();
    expect(validateBody("workflow_template", body(null))).toBeNull();
  });
  it("refuses an upside-down band, half a pair, and a band that means anybody", () => {
    expect(validateBody("workflow_template", body({ ...JUNIOR, minGradeRank: 9, minGradeCode: "director" }))).toMatch(/lower rank goes first/);
    expect(validateBody("workflow_template", body({ minGradeRank: 1, minGradeCode: null, maxGradeRank: null, maxGradeCode: null }))).toMatch(/go together/);
    expect(validateBody("workflow_template", body({ minGradeRank: null, minGradeCode: null, maxGradeRank: null, maxGradeCode: null }))).toMatch(/both ends open/);
  });
});

describe("the owner rule on a job's steps: SPOC, then Key Manager, then the signing partner (2026-09-27)", () => {
  const steps3 = () => [
    step({ key: "open", performer: JUNIOR }),
    step({ key: "review", performer: MANAGER_UP, dependsOn: ["open"] }),
    step({ key: "mis", dependsOn: ["review"] }),
  ];

  it("puts the steps on the Key Manager when there is no SPOC and they are inside the band", async () => {
    const w = await world(steps3(), null, { keyManager: { userId: KAVYA, displayName: "Kavya Nair" } });
    const by = new Map(w.stepRepo.rows.map((r) => [r.stepKey, r.assigneeUserId]));
    expect(by.get("open")).toBe(KAVYA);
    expect(by.get("review")).toBeNull();
    expect(by.get("mis")).toBe(KAVYA);
    const assigned = w.events.recorded.filter((e) => e.verb === "job.step_assigned");
    expect(assigned.map((e) => e.payload)).toEqual([
      expect.objectContaining({ stepKey: "open", how: "key_manager" }),
      expect.objectContaining({ stepKey: "mis", how: "key_manager" }),
    ]);
  });

  it("leaves a step on nobody's desk when the owner is outside its band: they hold the TASK, not the step", async () => {
    const w = await world([step({ key: "open", performer: JUNIOR })], null, {
      keyManager: { userId: RAJAT, displayName: "Rajat Gupta" },
    });
    expect(w.stepRepo.rows[0]?.assigneeUserId).toBeNull();
  });

  it("falls to the person who signs for the firm when there is no Key Manager either", async () => {
    const w = await world([step({ key: "open", performer: JUNIOR })], null, {
      partner: { userId: ROHAN, displayName: "Rohan Mehta" },
    });
    expect(w.stepRepo.rows[0]?.assigneeUserId).toBe(ROHAN);
    expect(w.events.recorded.find((e) => e.verb === "job.step_assigned")?.payload).toMatchObject({ how: "partner" });
  });

  it("never asks one Dept's SPOC about a job that holds several Depts' work", async () => {
    const w = await world([step({ key: "open", performer: JUNIOR })], ROHAN, {
      noLookup: { kind: "several_depts", names: ["FRC", "TRC"] },
      keyManager: { userId: KAVYA, displayName: "Kavya Nair" },
    });
    expect(w.stepRepo.rows[0]?.assigneeUserId).toBe(KAVYA);
  });
});

describe("a job's steps follow its task (2026-09-27)", () => {
  it("moves every unheld step inside the new owner's band, and records each as going with the task", async () => {
    // The Key Manager is a Director: outside the Analyst's band on "open", so
    // that step starts on nobody's desk, and inside "review" (Manager or
    // above) and "mis" (anybody), so those start on his.
    const w = await world(
      [step({ key: "open", performer: JUNIOR }), step({ key: "review", performer: MANAGER_UP, dependsOn: ["open"] }), step({ key: "mis", dependsOn: ["review"] })],
      null,
      { keyManager: { userId: RAJAT, displayName: "Rajat Gupta" } },
    );
    const before = new Map(w.stepRepo.rows.map((r) => [r.stepKey, r.assigneeUserId]));
    expect([before.get("open"), before.get("review"), before.get("mis")]).toEqual([null, RAJAT, RAJAT]);

    // Handing the task to Kavya hands her the job, as far as her grade goes.
    const moved = await w.service.adoptUnheldSteps(TENANT, JOB, RAJAT, KAVYA, ACTOR);

    expect(moved).toBe(2);
    const by = new Map(w.stepRepo.rows.map((r) => [r.stepKey, r.assigneeUserId]));
    expect(by.get("open")).toBe(KAVYA);
    expect(by.get("mis")).toBe(KAVYA);
    // An Analyst is not "Manager or above": that step stays with Rajat.
    expect(by.get("review")).toBe(RAJAT);
    const withTask = w.events.recorded.filter((e) => e.verb === "job.step_assigned" && e.payload["how"] === "with_task");
    expect(withTask).toHaveLength(2);
    expect(withTask.map((e) => e.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepKey: "open", assigneeUserId: KAVYA, previousAssigneeUserId: null }),
        expect.objectContaining({ stepKey: "mis", assigneeUserId: KAVYA, previousAssigneeUserId: RAJAT }),
      ]),
    );
  });

  it("moves a step the task's previous owner held, and leaves one a colleague took", async () => {
    const w = await world([step({ key: "open", performer: JUNIOR }), step({ key: "mis", performer: JUNIOR })], ROHAN);
    // Kavya took "mis" herself; "open" is still on the SPOC's desk.
    await w.service.assignStep({ tenantId: TENANT, jobId: JOB, stepKey: "mis", assigneeUserId: KAVYA }, ACTOR, KAVYA);

    // The task goes from Rohan to... Kavya is already on "mis"; hand it to a
    // third person in the band: Rohan's steps move, Kavya's stays hers.
    const moved = await w.service.adoptUnheldSteps(TENANT, JOB, ROHAN, KAVYA, ACTOR);
    expect(moved).toBe(1);
    expect(w.stepRepo.rows.find((r) => r.stepKey === "open")?.assigneeUserId).toBe(KAVYA);
    expect(w.stepRepo.rows.find((r) => r.stepKey === "mis")?.assigneeUserId).toBe(KAVYA);

    const other = await world([step({ key: "open", performer: JUNIOR })], null);
    await other.service.assignStep({ tenantId: TENANT, jobId: JOB, stepKey: "open", assigneeUserId: ROHAN }, ACTOR, ROHAN);
    expect(await other.service.adoptUnheldSteps(TENANT, JOB, RAJAT, KAVYA, ACTOR)).toBe(0);
    expect(other.stepRepo.rows[0]?.assigneeUserId).toBe(ROHAN);
  });

  it("does not move a finished step, and moves nothing for somebody who is not staff here", async () => {
    const w = await world([step({ key: "open", performer: JUNIOR }), step({ key: "mis", performer: JUNIOR, dependsOn: ["open"] })], ROHAN);
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "open" }, ACTOR, ROHAN);

    expect(await w.service.adoptUnheldSteps(TENANT, JOB, ROHAN, KAVYA, ACTOR)).toBe(1);
    expect(w.stepRepo.rows.find((r) => r.stepKey === "open")?.assigneeUserId).toBe(ROHAN);
    expect(await w.service.adoptUnheldSteps(TENANT, JOB, KAVYA, "00000000-0000-4000-8000-0000000000ff", ACTOR)).toBe(0);
  });
});

describe("steps follow whoever already holds the job's task (2026-09-27)", () => {
  it("puts the steps on the task's holder, not back on the ladder's pick, when the task was handed out first", async () => {
    // A month's task exists from the period's start and its steps from the
    // period's end. The Key Manager (a Director) handed the task to Kavya in
    // between; the steps are hers, recorded as going with the task.
    const w = await world([step({ key: "open", performer: JUNIOR })], null, {
      keyManager: { userId: RAJAT, displayName: "Rajat Gupta" },
      taskHolder: { userId: KAVYA, displayName: "Kavya Nair" },
    });
    expect(w.stepRepo.rows[0]?.assigneeUserId).toBe(KAVYA);
    expect(w.events.recorded.find((e) => e.verb === "job.step_assigned")?.payload).toMatchObject({ how: "with_task" });
  });

  it("records the ladder's own rung when the task's holder IS the ladder's pick", async () => {
    const w = await world([step({ key: "open", performer: JUNIOR })], ROHAN, {
      taskHolder: { userId: ROHAN, displayName: "Rohan Mehta" },
    });
    expect(w.stepRepo.rows[0]?.assigneeUserId).toBe(ROHAN);
    expect(w.events.recorded.find((e) => e.verb === "job.step_assigned")?.payload).toMatchObject({ how: "spoc" });
  });

  it("still keeps a step off a holder outside its band", async () => {
    const w = await world([step({ key: "open", performer: JUNIOR })], ROHAN, {
      taskHolder: { userId: RAJAT, displayName: "Rajat Gupta" },
    });
    expect(w.stepRepo.rows[0]?.assigneeUserId).toBeNull();
  });
});
