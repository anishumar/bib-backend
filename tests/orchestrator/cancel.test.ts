// Cancelling a job (V2.4): its open steps leave every desk, its tasks close,
// and the one event says what was withdrawn. Against the in-memory fakes.
import { describe, expect, it } from "vitest";
import { OrchestratorService, JOB_CANCELLED_NOTE } from "../../src/usecase/orchestrator/service";
import { FakeJobRepo } from "../../src/testfakes/scheduler";
import {
  FakeAgentRunRepo,
  FakeAgentRuntime,
  FakeJobStepRepo,
  FakeJobSubjectSource,
  FakeJobTasks,
  FakeStepCheckRepo,
  FakeStepDeskResolver,
  FakeTemplateSource,
  FakeTierSource,
} from "../../src/testfakes/orchestrator";
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
import type { TemplateStep } from "../../src/usecase/orchestrator/ports";

const TENANT = "00000000-0000-4000-8000-0000000000c1";
const JOB = "00000000-0000-4000-8000-0000000000c9";
const ENGAGEMENT = "00000000-0000-4000-8000-0000000000ca";
const KEY = "monthly-close";
const NOW = "2026-09-29T09:00:00.000Z";

function human(key: string, dependsOn: readonly string[] = []): TemplateStep {
  return {
    key,
    label: key,
    executor: "human",
    dependsOn,
    condition: null,
    verificationPolicyKey: null,
    performer: null,
    checklist: [],
    reviewPoints: [],
  };
}

async function world(openTasks = 1) {
  const jobs = new FakeJobRepo();
  const steps = new FakeJobStepRepo();
  const templates = new FakeTemplateSource();
  const subjects = new FakeJobSubjectSource();
  const events = new RecordingEventSink();
  const jobTasks = new FakeJobTasks(new Map([[JOB, openTasks]]));
  await jobs.createIfAbsent({
    id: JOB,
    tenantId: TENANT,
    sourceKind: "engagement",
    sourceRef: ENGAGEMENT,
    runnableAt: "2026-09-01T00:00:00.000Z",
    splitAxis: "none" as const,
    splitCode: null,
  });
  subjects.set(JOB, { workflowTemplateKey: KEY, recurrence: "monthly", jurisdiction: "IN" });
  // Three steps: collect and review in sequence, and a letter beside them.
  templates.publish(TENANT, KEY, {
    versionId: "v1",
    label: "Monthly close",
    steps: [human("collect"), human("review", ["collect"]), human("letter")],
  });
  const service = new OrchestratorService({
    jobTasks,
    timeZones: new FakeFirmTimeZone(),
    desks: new FakeStepDeskResolver(),
    jobs,
    steps,
    stepChecks: new FakeStepCheckRepo(steps),
    templates,
    subjects,
    tiers: new FakeTierSource(),
    runs: new FakeAgentRunRepo(),
    agents: new FakeAgentRuntime(),
    checks: new FakeStepApprovalRepo(),
    policies: new FakeVerificationPolicySource(),
    checkers: new FakeCheckerDirectory(),
    permissions: new FakeWorkPermissions(),
    tenants: { activeTenantIds: () => Promise.resolve([TENANT]) },
    ids: new FakeIds(),
    clock: new FakeClock(new Date(NOW)),
    events,
  });
  // Walk it once: collect and letter wait for a person, review waits on collect.
  await service.walkForTenant(TENANT);
  return { service, jobs, steps, events, jobTasks };
}

async function board(steps: FakeJobStepRepo): Promise<Record<string, string>> {
  const rows = await steps.listForJob(TENANT, JOB);
  return Object.fromEntries(rows.map((r) => [r.stepKey, r.status]));
}

describe("cancelling a job (V2.4)", () => {
  it("withdraws every open step, keeps the finished one, closes its tasks and says so once", async () => {
    const w = await world(2);
    const letter = (await w.steps.listForJob(TENANT, JOB)).find((s) => s.stepKey === "letter");
    if (!letter) throw new Error("the walk did not open the letter step");
    // The letter was already done: that work happened, and stays.
    await w.steps.transition(TENANT, letter.id, letter.status, {
      status: "done",
      at: NOW,
      performedBy: "00000000-0000-4000-8000-0000000000cb",
    });
    expect(await board(w.steps)).toMatchObject({ collect: "blocked", review: "pending", letter: "done" });

    const out = await w.service.cancelJob({ tenantId: TENANT, jobId: JOB }, SYSTEM_ACTOR);

    expect(out).toMatchObject({ stepsWithdrawn: 2, tasksCancelled: 2 });
    expect(out.job.status).toBe("cancelled");
    expect(await board(w.steps)).toEqual({ collect: "skipped", review: "skipped", letter: "done" });
    const rows = await w.steps.listForJob(TENANT, JOB);
    // The note says why; the step that had opened keeps the day it opened (0304).
    const collect = rows.find((r) => r.stepKey === "collect");
    expect(collect?.outcomeNote).toBe(JOB_CANCELLED_NOTE);
    expect(collect?.startedAt).not.toBeNull();
    expect(collect?.finishedAt).toBeNull();
    expect(w.jobTasks.calls).toEqual([{ tenantId: TENANT, jobId: JOB }]);

    const cancelled = w.events.recorded.filter((e) => e.verb === "job.cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.payload).toEqual({
      from: "blocked",
      stepKeys: ["collect", "review"],
      stepsWithdrawn: 2,
      tasksCancelled: 2,
    });
  });

  it("refuses a job that is already cancelled, and touches nothing the second time", async () => {
    const w = await world();
    await w.service.cancelJob({ tenantId: TENANT, jobId: JOB }, SYSTEM_ACTOR);
    await expect(
      w.service.cancelJob({ tenantId: TENANT, jobId: JOB }, SYSTEM_ACTOR),
    ).rejects.toMatchObject({ code: "JOB_CLOSED" });
    expect(w.jobTasks.calls).toHaveLength(1);
  });

  it("refuses a job this firm does not have", async () => {
    const w = await world();
    await expect(
      w.service.cancelJob({ tenantId: TENANT, jobId: ENGAGEMENT }, SYSTEM_ACTOR),
    ).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
  });

  it("is never walked again: the sweep leaves a cancelled job alone", async () => {
    const w = await world();
    await w.service.cancelJob({ tenantId: TENANT, jobId: JOB }, SYSTEM_ACTOR);
    const report = await w.service.walkForTenant(TENANT);
    expect(report).toMatchObject({ started: 0, advanced: 0 });
    expect(await board(w.steps)).toEqual({ collect: "skipped", review: "skipped", letter: "skipped" });
  });
});
