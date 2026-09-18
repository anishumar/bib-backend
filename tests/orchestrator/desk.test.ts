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
  return { label: over.key, executor: "human", dependsOn: [], condition: null, verificationPolicyKey: null, performer: null, ...over };
}
const template = (steps: readonly TemplateStep[]): ResolvedTemplate => ({ versionId: "v1", label: "Monthly close", steps });

async function world(steps: readonly TemplateStep[], spoc: string | null) {
  const jobs = new FakeJobRepo();
  const stepRepo = new FakeJobStepRepo();
  const templates = new FakeTemplateSource();
  const subjects = new FakeJobSubjectSource();
  const events = new RecordingEventSink();
  const desks = new FakeStepDeskResolver();
  desks.spoc = spoc;
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
    desks, jobs, steps: stepRepo, templates, subjects,
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
