// One firm's broken job must not stop task movement anywhere else (audit
// 2026-10-03, B11). `sweep()` walked every firm with no catch, and
// `walkForTenant` re-threw anything but the two expected refusals, so a single
// unexpected error in firm #3 left firms #4..N with no step moved on every
// five-minute tick until somebody fixed firm #3, and pg-boss retried the whole
// sweep. The failure must be REPORTED (the worker logs it), never swallowed.
import { describe, expect, it } from "vitest";
import { OrchestratorService } from "../../src/usecase/orchestrator/service";
import { FakeJobRepo } from "../../src/testfakes/scheduler";
import {
  FakeAgentRunRepo,
  FakeAgentRuntime,
  FakeJobStepRepo,
  FakeJobSubjectSource,
  FakeTemplateSource,
  FakeTierSource,
  FakeStepDeskResolver,
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
import type { Job } from "../../src/domain/scheduler/model";

const BROKEN = "00000000-0000-4000-8000-0000000000b1";
const HEALTHY = "00000000-0000-4000-8000-0000000000b2";

/** Firm BROKEN's job list cannot even be read; every other firm's can. */
class OneBrokenFirm extends FakeJobRepo {
  override listRunnable(tenantId: string, asOf: string, limit: number): Promise<readonly Job[]> {
    if (tenantId === BROKEN) return Promise.reject(new Error("could not read firm BROKEN's jobs"));
    return super.listRunnable(tenantId, asOf, limit);
  }
}

function build(jobs: FakeJobRepo, tenants: readonly string[]) {
  const steps = new FakeJobStepRepo();
  const templates = new FakeTemplateSource();
  const subjects = new FakeJobSubjectSource();
  const service = new OrchestratorService({
    jobTasks: new FakeJobTasks(),
    timeZones: new FakeFirmTimeZone(),
    desks: new FakeStepDeskResolver(),
    jobs,
    steps,
    stepChecks: new FakeStepCheckRepo(steps),
    templates,
    subjects,
    tiers: new FakeTierSource().publish(SUGGESTED_TIERS),
    runs: new FakeAgentRunRepo(),
    agents: new FakeAgentRuntime(),
    checks: new FakeStepApprovalRepo(),
    policies: new FakeVerificationPolicySource(),
    checkers: new FakeCheckerDirectory(),
    permissions: new FakeWorkPermissions(),
    tenants: { activeTenantIds: () => Promise.resolve(tenants) },
    ids: new FakeIds(),
    clock: new FakeClock(new Date("2026-10-03T09:00:00.000Z")),
    events: new RecordingEventSink(),
  });
  return { service, steps, templates, subjects };
}

async function jobFor(jobs: FakeJobRepo, tenantId: string, id: string): Promise<Job> {
  const { job } = await jobs.createIfAbsent({
    id,
    tenantId,
    sourceKind: "engagement",
    sourceRef: `00000000-0000-4000-8000-${id.slice(-12)}`,
    runnableAt: "2026-10-01T00:00:00.000Z",
    splitAxis: "none" as const,
    splitCode: null,
  });
  return job;
}

const step = (key: string) => ({
  key,
  label: key,
  executor: "human" as const,
  dependsOn: [],
  condition: null,
  verificationPolicyKey: null,
  performer: null,
  checklist: [],
  reviewPoints: [],
});

describe("the orchestrator sweep, with one firm broken (B11)", () => {
  it("still walks every firm after it, and reports the broken one", async () => {
    const jobs = new OneBrokenFirm();
    const w = build(jobs, [BROKEN, HEALTHY]);
    const job = await jobFor(jobs, HEALTHY, "00000000-0000-4000-8000-0000000000d1");
    w.subjects.set(job.id, { workflowTemplateKey: "gst", recurrence: "monthly", jurisdiction: "IN" });
    w.templates.publish(HEALTHY, "gst", { versionId: "v1", label: "GST", steps: [step("collect")] });

    const reports = await w.service.sweep(SYSTEM_ACTOR);

    expect(reports.map((r) => r.tenantId)).toEqual([BROKEN, HEALTHY]);
    expect(reports[0]).toMatchObject({ tenantId: BROKEN, started: 0, failure: expect.stringContaining("BROKEN") });
    expect(reports[1]).toMatchObject({ tenantId: HEALTHY, started: 1 });
    expect(reports[1]?.failure).toBeUndefined();
    expect((await w.steps.listForJob(HEALTHY, job.id)).map((s) => s.stepKey)).toEqual(["collect"]);
  });

  it("walks a firm's other jobs past one that throws, and says which job failed", async () => {
    const jobs = new FakeJobRepo();
    const w = build(jobs, [HEALTHY]);
    const bad = await jobFor(jobs, HEALTHY, "00000000-0000-4000-8000-0000000000d2");
    const good = await jobFor(jobs, HEALTHY, "00000000-0000-4000-8000-0000000000d3");
    // Reading the bad job's subject throws something the walk does not
    // expect; the good one is ordinary.
    w.subjects.set(good.id, { workflowTemplateKey: "gst", recurrence: "monthly", jurisdiction: "IN" });
    w.templates.publish(HEALTHY, "gst", { versionId: "v1", label: "GST", steps: [step("collect")] });
    const subjects = w.subjects;
    const original = subjects.subjectOf.bind(subjects);
    subjects.subjectOf = (tenantId: string, jobId: string) =>
      jobId === bad.id ? Promise.reject(new Error("a row nobody expected")) : original(tenantId, jobId);

    const [report] = await w.service.sweep(SYSTEM_ACTOR);

    expect(report).toMatchObject({ tenantId: HEALTHY, started: 1, failed: 1 });
    expect(report?.failure).toContain(bad.id);
    expect((await w.steps.listForJob(HEALTHY, good.id)).map((s) => s.stepKey)).toEqual(["collect"]);
  });
});
