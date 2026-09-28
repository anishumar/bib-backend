// The two T6.15 routes, and the refusals they answer with, over HTTP (T6.15's
// review). `tests/orchestrator/step-checks.test.ts` proves what the service
// decides; this proves what a SCREEN is sent: the status each refusal maps to,
// the reason code the job page reads, the sentence it prints, the handler's
// field-by-field mapping of the answer, and that the marker is the session's
// user and never a body field.
//
// The router here is the orchestrator's own registrar on a bare app, with the
// router's error mapping and a principal standing in for the session guard.
// Gates 1 to 3 are proven elsewhere (`auth-coverage.test.ts` enumerates every
// route); this is about what happens once a request is through them.
import { describe, expect, it } from "vitest";
import { createOpenAPIApp } from "../../src/api/openapi";
import { mapError } from "../../src/api/domainerr";
import { toEnvelope } from "../../src/api/httpresp";
import { registerOrchestratorRoutes } from "../../src/api/handler/orchestrator";
import { OrchestratorService } from "../../src/usecase/orchestrator/service";
import { FakeJobRepo } from "../../src/testfakes/scheduler";
import {
  FakeAgentRunRepo,
  FakeAgentRuntime,
  FakeJobStepRepo,
  FakeJobSubjectSource,
  FakeStepCheckRepo,
  FakeStepDeskResolver,
  FakeTemplateSource,
  FakeTierSource,
  FakeJobTasks,
} from "../../src/testfakes/orchestrator";
import {
  FakeCheckerDirectory,
  FakeStepApprovalRepo,
  FakeVerificationPolicySource,
  FakeWorkPermissions,
} from "../../src/testfakes/verification";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { FakeIds } from "../../src/testfakes/ids";
import { FakeClock } from "../../src/testfakes/clock";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import { SUGGESTED_TIERS } from "../../src/domain/agent/model";
import type { TemplateStep } from "../../src/usecase/orchestrator/ports";

const TENANT = "00000000-0000-4000-8000-0000000001f1";
const JOB = "00000000-0000-4000-8000-0000000001f9";
const KAVYA = "00000000-0000-4000-8000-0000000001fa"; // Analyst: the doer, the SPOC
const ANAND = "00000000-0000-4000-8000-0000000001fc"; // Manager: the checker
const POLICY_KEY = "manager_review";

function step(over: Partial<TemplateStep> & { key: string }): TemplateStep {
  return {
    label: over.key,
    executor: "human",
    dependsOn: [],
    condition: null,
    verificationPolicyKey: null,
    performer: null,
    checklist: [],
    reviewPoints: [],
    ...over,
  };
}

const PROCESS: readonly TemplateStep[] = [
  step({
    key: "collect",
    label: "Collect source data",
    checklist: [
      { key: "s1", label: "Bank statements" },
      { key: "s2", label: "Sales data" },
    ],
  }),
  step({
    key: "review",
    label: "Manager review",
    dependsOn: ["collect"],
    verificationPolicyKey: POLICY_KEY,
    reviewPoints: [
      { key: "r1", label: "P&L movements" },
      { key: "r2", label: "Balance sheet movements" },
    ],
  }),
  // A machine's answer waiting for a person, with a list the person ticks first.
  step({ key: "draft", label: "Draft the MIS", executor: "agent_with_approval", checklist: [{ key: "s1", label: "Figures tied out" }] }),
];

async function world() {
  const jobs = new FakeJobRepo();
  const steps = new FakeJobStepRepo();
  const templates = new FakeTemplateSource();
  const subjects = new FakeJobSubjectSource();
  const desks = new FakeStepDeskResolver();
  desks.spoc = KAVYA;
  const checkers = new FakeCheckerDirectory()
    .add({ userId: KAVYA, displayName: "Kavya Nair", gradeRank: 1, gradeName: "Analyst" })
    .add({ userId: ANAND, displayName: "Anand Rao", gradeRank: 7, gradeName: "Manager" });
  const checks = new FakeStepApprovalRepo();
  checks.steps = steps;
  checks.jobs = jobs;
  const stepChecks = new FakeStepCheckRepo(steps);
  stepChecks.directory = checkers;
  stepChecks.approvals = checks;
  checks.marks = stepChecks;
  await jobs.createIfAbsent({
    id: JOB, tenantId: TENANT, sourceKind: "engagement", sourceRef: "e1",
    runnableAt: "2026-09-01T00:00:00.000Z", splitAxis: "none" as const, splitCode: null,
  });
  subjects.set(JOB, { workflowTemplateKey: "close", recurrence: "monthly", jurisdiction: "IN" });
  templates.publish(TENANT, "close", { versionId: "v1", label: "Monthly close", steps: PROCESS });
  const service = new OrchestratorService({
    jobTasks: new FakeJobTasks(),
    timeZones: new FakeFirmTimeZone(),
    desks, jobs, steps, stepChecks, templates, subjects,
    tiers: new FakeTierSource().publish(SUGGESTED_TIERS),
    runs: new FakeAgentRunRepo(),
    agents: new FakeAgentRuntime().armWith("draft", 0.9, { total: "1200.00" }),
    checks,
    policies: new FakeVerificationPolicySource().publish({
      versionId: "00000000-0000-4000-8000-0000000001fe",
      key: POLICY_KEY,
      policy: { label: "Manager review", rule: "rank_threshold", minGradeRank: 7, minGradeCode: "manager" },
    }),
    checkers,
    permissions: new FakeWorkPermissions(),
    tenants: { activeTenantIds: () => Promise.resolve([TENANT]) },
    ids: new FakeIds(),
    clock: new FakeClock(new Date("2026-09-26T09:00:00.000Z")),
    events: new RecordingEventSink(),
  });
  await service.walkForTenant(TENANT, SYSTEM_ACTOR);

  const app = createOpenAPIApp();
  app.onError((err, c) => {
    const m = mapError(err);
    return c.json(toEnvelope(m), m.status);
  });
  // The session, as the guard would have resolved it. Whoever `as.user` names.
  const as = { user: KAVYA };
  app.use("*", async (c, next) => {
    c.set("principal", {
      userId: as.user,
      sessionId: "00000000-0000-4000-8000-0000000001de",
      tenantId: TENANT,
      audience: "STAFF",
      role: "member",
      commercialVisibility: false,
    });
    await next();
  });
  registerOrchestratorRoutes(app, { service, grades: { listGrades: () => Promise.resolve([]) }, jobs });

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const subStep = (stepKey: string, itemKey: string, body: unknown) =>
    call("PUT", `/api/v1/jobs/${JOB}/steps/${stepKey}/sub-steps/${itemKey}`, body);
  const openCheckId = async () => {
    const [c] = await checks.listPending(TENANT);
    if (!c) throw new Error("no check is open");
    return c.approval.id;
  };
  return { service, as, call, subStep, openCheckId, jobs };
}

const refusal = (r: { body: Record<string, unknown> }) => r.body["error"] as { code: string; reason?: string; message: string };

describe("PUT /jobs/{jobId}/steps/{stepKey}/sub-steps/{itemKey}", () => {
  it("answers the step, mapped, with the SESSION's user as the marker and a missing note read as none", async () => {
    const w = await world();
    const r = await w.subStep("collect", "s1", { outcome: "done" });
    expect(r.status).toBe(200);
    expect(r.body["subStepsOpen"]).toBe(1);
    expect(r.body["subSteps"]).toEqual([
      {
        key: "s1", label: "Bank statements", outcome: "done", note: null,
        markedBy: { userId: KAVYA, displayName: "Kavya Nair" }, markedAt: "2026-09-26T09:00:00.000Z",
      },
      { key: "s2", label: "Sales data", outcome: null, note: null, markedBy: null, markedAt: null },
    ]);
  });

  it("refuses 'not applicable' with a blank reason as a 400 that says what to send", async () => {
    const w = await world();
    const r = await w.subStep("collect", "s2", { outcome: "not_applicable", note: "  " });
    expect(r.status).toBe(400);
    expect(refusal(r)).toMatchObject({ code: "VALIDATION", reason: "NOT_APPLICABLE_NEEDS_A_REASON" });
    expect(refusal(r).message).toMatch(/^Marking 'Sales data' not applicable needs a short reason/);
  });

  it("refuses a line the pinned process does not have as a 404", async () => {
    const w = await world();
    const r = await w.subStep("collect", "s9", { outcome: "done" });
    expect(r.status).toBe(404);
    expect(refusal(r)).toMatchObject({ code: "NOT_FOUND", reason: "SUB_STEP_NOT_FOUND" });
  });

  it("refuses a tick on a finished step as a 409: its list is the record of how it was done", async () => {
    const w = await world();
    await w.subStep("collect", "s1", { outcome: "done" });
    await w.subStep("collect", "s2", { outcome: "done" });
    const done = await w.call("POST", `/api/v1/jobs/${JOB}/steps/collect/complete`);
    expect(done.body["status"]).toBe("done");
    const r = await w.subStep("collect", "s1", { outcome: null });
    expect(r.status).toBe(409);
    expect(refusal(r)).toMatchObject({ code: "CONFLICT", reason: "STEP_NOT_WAITING" });
  });

  it("keeps the undecided machine answer on the step it answers with", async () => {
    // The job page swaps the whole step for this answer. When the answer said
    // `proposal: null`, the first tick took Accept, Correct and Reject off the
    // screen and offered a Done the API then refused.
    const w = await world();
    const before = await w.call("GET", `/api/v1/jobs/${JOB}/steps`);
    const listed = (before.body["steps"] as { stepKey: string; proposal: unknown }[]).find((s) => s.stepKey === "draft");
    expect(listed?.proposal).not.toBeNull();

    const r = await w.subStep("draft", "s1", { outcome: "done" });
    expect(r.status).toBe(200);
    expect(r.body["proposal"]).toMatchObject({ decision: "queued", proposed: { total: "1200.00" } });
    expect(r.body["subStepsOpen"]).toBe(0);

    // Handing the step over answered the same way, and had the same bug.
    const handed = await w.call("PUT", `/api/v1/jobs/${JOB}/steps/draft/assignee`, { userId: null });
    expect(handed.status).toBe(200);
    expect(handed.body["proposal"]).not.toBeNull();
  });
});

describe("POST /jobs/{jobId}/steps/{stepKey}/complete with a sub-step open", () => {
  it("is a 409 naming what is left", async () => {
    const w = await world();
    await w.subStep("collect", "s1", { outcome: "done" });
    const r = await w.call("POST", `/api/v1/jobs/${JOB}/steps/collect/complete`);
    expect(r.status).toBe(409);
    expect(refusal(r)).toMatchObject({ code: "CONFLICT", reason: "SUB_STEPS_OPEN" });
    expect(refusal(r).message).toBe(
      "1 sub-step of 'Collect source data' is not ticked yet: Sales data. Tick it, or mark it not " +
        "applicable with a reason.",
    );
  });
});

describe("PUT /checks/{approvalId}/review-points/{itemKey}, and Approve", () => {
  async function toReview() {
    const w = await world();
    await w.subStep("collect", "s1", { outcome: "done" });
    await w.subStep("collect", "s2", { outcome: "done" });
    await w.call("POST", `/api/v1/jobs/${JOB}/steps/collect/complete`);
    await w.call("POST", `/api/v1/jobs/${JOB}/steps/review/complete`);
    w.as.user = ANAND;
    return { w, id: await w.openCheckId() };
  }

  it("answers the check, mapped, with the checker as the marker", async () => {
    const { w, id } = await toReview();
    const r = await w.call("PUT", `/api/v1/checks/${id}/review-points/r1`, { outcome: "not_applicable", note: " No P&L this month " });
    expect(r.status).toBe(200);
    expect(r.body["reviewPointsOpen"]).toBe(1);
    expect((r.body["reviewPoints"] as unknown[])[0]).toEqual({
      key: "r1", label: "P&L movements", outcome: "not_applicable", note: "No P&L this month",
      markedBy: { userId: ANAND, displayName: "Anand Rao" }, markedAt: "2026-09-26T09:00:00.000Z",
    });
  });

  it("refuses a point the pinned step does not have as a 404", async () => {
    const { w, id } = await toReview();
    const r = await w.call("PUT", `/api/v1/checks/${id}/review-points/r9`, { outcome: "done" });
    expect(r.status).toBe(404);
    expect(refusal(r)).toMatchObject({ code: "NOT_FOUND", reason: "REVIEW_POINT_NOT_FOUND" });
  });

  it("refuses the maker as a 403", async () => {
    const { w, id } = await toReview();
    w.as.user = KAVYA;
    const r = await w.call("PUT", `/api/v1/checks/${id}/review-points/r1`, { outcome: "done" });
    expect(r.status).toBe(403);
    expect(refusal(r)).toMatchObject({ code: "FORBIDDEN", reason: "NOT_ELIGIBLE_TO_CHECK" });
  });

  it("refuses Approve with a point open as a 409 naming it, and takes Send back", async () => {
    const { w, id } = await toReview();
    await w.call("PUT", `/api/v1/checks/${id}/review-points/r1`, { outcome: "done" });
    const r = await w.call("POST", `/api/v1/checks/${id}/decide`, { decision: "approved", notes: null });
    expect(r.status).toBe(409);
    expect(refusal(r)).toMatchObject({ code: "CONFLICT", reason: "REVIEW_POINTS_OPEN" });
    expect(refusal(r).message).toMatch(/^1 review point of 'Manager review' is not ticked yet: Balance sheet movements\./);
    const back = await w.call("POST", `/api/v1/checks/${id}/decide`, { decision: "rejected", notes: "Does not tie." });
    expect(back.status).toBe(200);
  });

  it("refuses a point on a decided check as a 409", async () => {
    const { w, id } = await toReview();
    await w.call("PUT", `/api/v1/checks/${id}/review-points/r1`, { outcome: "done" });
    await w.call("POST", `/api/v1/checks/${id}/decide`, { decision: "rejected", notes: "Does not tie." });
    const r = await w.call("PUT", `/api/v1/checks/${id}/review-points/r1`, { outcome: null });
    expect(r.status).toBe(409);
    expect(refusal(r)).toMatchObject({ code: "CONFLICT", reason: "APPROVAL_ALREADY_DECIDED" });
  });
});

describe("GET /my-steps and GET /checks name the job each row belongs to (V2.1)", () => {
  const ENGAGEMENT = "00000000-0000-4000-8000-0000000001e1";
  const CLIENT = "00000000-0000-4000-8000-0000000001c1";

  async function named() {
    const w = await world();
    await w.jobs.linkEngagements(TENANT, JOB, [ENGAGEMENT]);
    w.jobs.serviceNames.set(ENGAGEMENT, "Monthly bookkeeping");
    w.jobs.clientNames.set(ENGAGEMENT, "Kaveri Foods");
    w.jobs.entityNames.set(ENGAGEMENT, "Kaveri Foods Private Limited");
    w.jobs.clientPartyIds.set(JOB, CLIENT);
    w.jobs.dueOns.set(JOB, "2026-10-10");
    return w;
  }

  it("gives a step on the caller's desk its client, by id, and the day it is due", async () => {
    const w = await named();
    const r = await w.call("GET", "/api/v1/my-steps");
    expect(r.status).toBe(200);
    const [step] = r.body["steps"] as Record<string, unknown>[];
    expect(step?.["job"]).toEqual({
      clientPartyId: CLIENT,
      clientName: "Kaveri Foods",
      entityPartyId: null,
      entityName: "Kaveri Foods Private Limited",
      periodLabel: null,
      services: ["Monthly bookkeeping"],
      dueOn: "2026-10-10",
    });
  });

  it("gives a check in the queue the same, so a checker's list can link the client", async () => {
    const w = await named();
    await w.subStep("collect", "s1", { outcome: "done" });
    await w.subStep("collect", "s2", { outcome: "done" });
    await w.call("POST", `/api/v1/jobs/${JOB}/steps/collect/complete`);
    await w.call("POST", `/api/v1/jobs/${JOB}/steps/review/complete`);
    w.as.user = ANAND;
    const r = await w.call("GET", "/api/v1/checks");
    expect(r.status).toBe(200);
    const [check] = r.body["checks"] as Record<string, unknown>[];
    expect(check?.["job"]).toMatchObject({ clientPartyId: CLIENT, clientName: "Kaveri Foods", dueOn: "2026-10-10" });
  });

  it("says null, not a blank client, for a job linked to no engagement", async () => {
    const w = await world();
    const r = await w.call("GET", "/api/v1/my-steps");
    const [step] = r.body["steps"] as Record<string, unknown>[];
    expect(step?.["job"]).toBeNull();
  });
});
