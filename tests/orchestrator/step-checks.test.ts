// Sub-steps and review points (T6.15), end to end through the orchestrator,
// against in-memory fakes.
//
// The acceptance line, in the order a person meets it: the doer ticks each
// sub-step or marks it not applicable with a reason; Done is refused, in a
// sentence naming what is left, until every one is settled; once the work is
// submitted the ticks are locked; the checker ticks the review points and
// Approve is refused until they are settled, while Send back never is; after a
// send-back the doer may change their ticks and the next check starts with its
// review points empty; a process with no lists behaves exactly as before; every
// tick says who and when; and the ledger gets counts, never a label or reason.
//
// The database half (the CHECKs, the two partial unique keys, the tenant wall,
// no DELETE) is `step-checks.integration.test.ts`.
import { describe, expect, it } from "vitest";
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
import type { MarkOutcome } from "../../src/domain/orchestrator/model";
import {
  AwaitingCheck,
  NotApplicableNeedsAReason,
  NotYourStep,
  PerformerOutOfBand,
  StepNotWaiting,
  SubStepNotFound,
  SubStepsOpen,
} from "../../src/domain/orchestrator/errors";
import {
  NotEligibleToCheck,
  ReviewPointNotFound,
  ReviewPointsOpen,
} from "../../src/domain/verification/errors";

const TENANT = "00000000-0000-4000-8000-0000000000f1";
const JOB = "00000000-0000-4000-8000-0000000000f9";
const KAVYA = "00000000-0000-4000-8000-0000000000fa"; // Analyst, rank 1: the SPOC and the doer
const PRIYA = "00000000-0000-4000-8000-0000000000fb"; // Associate, rank 3: somebody else in the band
const ANAND = "00000000-0000-4000-8000-0000000000fc"; // Manager, rank 7: the checker
const RAJAT = "00000000-0000-4000-8000-0000000000fd"; // Director, rank 9: outside the doer's band
const ACTOR = SYSTEM_ACTOR;
const POLICY_KEY = "manager_review";
const POLICY_VERSION = "00000000-0000-4000-8000-0000000000fe";

const JUNIOR = { minGradeRank: 1, minGradeCode: "analyst", maxGradeRank: 4, maxGradeCode: "senior_associate" };

const COLLECT_LINES = [
  { key: "s1", label: "Bank statements" },
  { key: "s2", label: "Sales data" },
  { key: "s3", label: "Payroll information" },
];
const REVIEW_LINES = [
  { key: "r1", label: "P&L movements" },
  { key: "r2", label: "Balance sheet movements" },
];

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

/** The firm's close, cut to three steps: the doer's collection (sub-steps, no
 *  check), the review (a sub-step for the doer, review points for the manager),
 *  and the MIS, which has no lists and must behave exactly as before. */
const CLOSE: readonly TemplateStep[] = [
  step({ key: "collect", label: "Collect source data", performer: JUNIOR, checklist: COLLECT_LINES }),
  step({
    key: "review",
    label: "Manager review",
    dependsOn: ["collect"],
    verificationPolicyKey: POLICY_KEY,
    checklist: [{ key: "s1", label: "Close pack assembled" }],
    reviewPoints: REVIEW_LINES,
  }),
  step({ key: "mis", label: "Issue MIS", dependsOn: ["review"] }),
];

async function world(
  steps: readonly TemplateStep[] = CLOSE,
  opts: { agents?: FakeAgentRuntime; recurrence?: string } = {},
) {
  const jobs = new FakeJobRepo();
  const stepRepo = new FakeJobStepRepo();
  const templates = new FakeTemplateSource();
  const subjects = new FakeJobSubjectSource();
  const events = new RecordingEventSink();
  const desks = new FakeStepDeskResolver();
  desks.spoc = KAVYA;
  const checkers = new FakeCheckerDirectory()
    .add({ userId: KAVYA, displayName: "Kavya Nair", gradeRank: 1, gradeName: "Analyst" })
    .add({ userId: PRIYA, displayName: "Priya Shah", gradeRank: 3, gradeName: "Associate" })
    .add({ userId: ANAND, displayName: "Anand Rao", gradeRank: 7, gradeName: "Manager" })
    .add({ userId: RAJAT, displayName: "Rajat Gupta", gradeRank: 9, gradeName: "Director" });
  const checks = new FakeStepApprovalRepo();
  checks.steps = stepRepo;
  checks.jobs = jobs;
  const stepChecks = new FakeStepCheckRepo(stepRepo);
  stepChecks.directory = checkers;
  const policies = new FakeVerificationPolicySource().publish({
    versionId: POLICY_VERSION,
    key: POLICY_KEY,
    policy: { label: "Manager review", rule: "rank_threshold", minGradeRank: 7, minGradeCode: "manager" },
  });
  const runs = new FakeAgentRunRepo();
  await jobs.createIfAbsent({
    id: JOB, tenantId: TENANT, sourceKind: "engagement", sourceRef: "e1",
    runnableAt: "2026-09-01T00:00:00.000Z", splitAxis: "none" as const, splitCode: null,
  });
  subjects.set(JOB, { workflowTemplateKey: "close", recurrence: opts.recurrence ?? "monthly", jurisdiction: "IN" });
  const template: ResolvedTemplate = { versionId: "v1", label: "Monthly close", steps };
  templates.publish(TENANT, "close", template);
  const clock = new FakeClock(new Date("2026-09-25T09:00:00.000Z"));
  const service = new OrchestratorService({
    timeZones: new FakeFirmTimeZone(),
    desks, jobs, steps: stepRepo, stepChecks, templates, subjects,
    tiers: new FakeTierSource().publish(SUGGESTED_TIERS),
    runs,
    agents: opts.agents ?? new FakeAgentRuntime(),
    checks,
    policies,
    checkers,
    permissions: new FakeWorkPermissions(),
    tenants: { activeTenantIds: () => Promise.resolve([TENANT]) },
    ids: new FakeIds(),
    clock,
    events,
  });
  await service.walkForTenant(TENANT, ACTOR);

  const tick = (stepKey: string, itemKey: string, outcome: MarkOutcome | null, by = KAVYA, note: string | null = null) =>
    service.markSubStep({ tenantId: TENANT, jobId: JOB, stepKey, itemKey, outcome, note }, ACTOR, by);
  const complete = (stepKey: string, by = KAVYA) =>
    service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey }, ACTOR, by);
  const describeFor = async (stepKey: string, viewer = KAVYA) =>
    (await service.describeSteps(TENANT, JOB, viewer)).find((d) => d.step.stepKey === stepKey);
  const openCheck = async () => {
    const [c] = await checks.listPending(TENANT);
    if (!c) throw new Error("no check is open");
    return c.approval.id;
  };
  const point = (approvalId: string, itemKey: string, outcome: MarkOutcome | null, by = ANAND, note: string | null = null) =>
    service.markReviewPoint({ tenantId: TENANT, approvalId, itemKey, outcome, note }, ACTOR, by);
  const decide = (approvalId: string, decision: "approved" | "rejected", by = ANAND, notes: string | null = null) =>
    service.decideCheck({ tenantId: TENANT, approvalId, decision, notes }, ACTOR, by);
  /** Collect is done and Review is waiting to be checked. */
  const toReview = async () => {
    for (const l of COLLECT_LINES) await tick("collect", l.key, "done");
    await complete("collect");
    await tick("review", "s1", "done");
    await complete("review");
    return openCheck();
  };
  const board = async () => Object.fromEntries((await stepRepo.listForJob(TENANT, JOB)).map((r) => [r.stepKey, r.status]));

  return { service, stepRepo, stepChecks, checks, events, runs, subjects, clock, tick, complete, describeFor, openCheck, point, decide, toReview, board };
}

describe("the doer's sub-steps", () => {
  it("refuses Done while any sub-step is open, naming what is left", async () => {
    const w = await world();
    await w.tick("collect", "s1", "done");
    const err = await w.complete("collect").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubStepsOpen);
    expect((err as Error).message).toBe(
      "2 sub-steps of 'Collect source data' are not ticked yet: Sales data and Payroll information. " +
        "Tick each one, or mark it not applicable with a reason.",
    );
    // Nothing moved.
    expect((await w.board())["collect"]).toBe("blocked");
    expect(w.events.recorded.filter((e) => e.verb === "job.step_advanced" && e.payload["to"] === "done")).toEqual([]);
  });

  it("allows Done once every sub-step is ticked or not applicable, and the next step opens", async () => {
    const w = await world();
    await w.tick("collect", "s1", "done");
    await w.tick("collect", "s2", "done");
    await w.tick("collect", "s3", "not_applicable", KAVYA, "  No payroll this month  ");
    const done = await w.complete("collect");
    expect(done.status).toBe("done");
    expect(await w.board()).toMatchObject({ collect: "done", review: "blocked" });
  });

  it("caps the list in the refusal: five named, then how many more", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ key: `s${String(i + 1)}`, label: `Line ${String(i + 1)}` }));
    const w = await world([step({ key: "collect", label: "Collect", checklist: many })]);
    await expect(w.complete("collect")).rejects.toThrow(
      "8 sub-steps of 'Collect' are not ticked yet: Line 1, Line 2, Line 3, Line 4, Line 5 and 3 more.",
    );
  });

  it("refuses 'not applicable' with no reason, a blank one, or one too long to be a reason", async () => {
    const w = await world();
    await expect(w.tick("collect", "s3", "not_applicable")).rejects.toBeInstanceOf(NotApplicableNeedsAReason);
    await expect(w.tick("collect", "s3", "not_applicable", KAVYA, "   ")).rejects.toThrow(
      /Marking 'Payroll information' not applicable needs a short reason/,
    );
    await expect(w.tick("collect", "s3", "not_applicable", KAVYA, "x".repeat(501))).rejects.toThrow(
      /longer than 500 characters/,
    );
    expect(w.stepChecks.rows).toEqual([]);
  });

  it("stores the reason trimmed, and drops one sent with a plain tick", async () => {
    const w = await world();
    await w.tick("collect", "s3", "not_applicable", KAVYA, "  No payroll this month  ");
    await w.tick("collect", "s1", "done", KAVYA, "ignored");
    const by = new Map(w.stepChecks.rows.map((r) => [r.itemKey, r]));
    expect(by.get("s3")?.note).toBe("No payroll this month");
    expect(by.get("s1")?.note).toBeNull();
  });

  it("refuses somebody else's step, and somebody outside the band", async () => {
    const w = await world();
    // On Kavya's desk: Priya must take it first, as she would to tick the step.
    await expect(w.tick("collect", "s1", "done", PRIYA)).rejects.toBeInstanceOf(NotYourStep);
    // Released to nobody's desk, a Director is still outside Analyst to Senior Associate.
    await w.service.assignStep({ tenantId: TENANT, jobId: JOB, stepKey: "collect", assigneeUserId: null }, ACTOR, KAVYA);
    await expect(w.tick("collect", "s1", "done", RAJAT)).rejects.toBeInstanceOf(PerformerOutOfBand);
    // And Priya, inside the band, may tick it from nobody's desk.
    await expect(w.tick("collect", "s1", "done", PRIYA)).resolves.toBeTruthy();
  });

  it("refuses a line the pinned process does not have", async () => {
    const w = await world();
    await expect(w.tick("collect", "s9", "done")).rejects.toBeInstanceOf(SubStepNotFound);
  });

  it("refuses ticking a step that has not opened, and one that is done", async () => {
    const w = await world();
    // `review` depends on `collect`, so it is still pending.
    await expect(w.tick("review", "s1", "done")).rejects.toBeInstanceOf(StepNotWaiting);
    for (const l of COLLECT_LINES) await w.tick("collect", l.key, "done");
    await w.complete("collect");
    // Settled and locked: a done step's list is the record of how it was done.
    await expect(w.tick("collect", "s1", null)).rejects.toBeInstanceOf(StepNotWaiting);
  });

  it("locks the ticks while the work waits to be checked", async () => {
    const w = await world();
    await w.toReview();
    await expect(w.tick("review", "s1", null)).rejects.toBeInstanceOf(AwaitingCheck);
  });

  it("lets the doer take a tick back while the step is open", async () => {
    const w = await world();
    await w.tick("collect", "s1", "done");
    expect((await w.describeFor("collect"))?.subStepsOpen).toBe(2);
    await w.tick("collect", "s1", null);
    const d = await w.describeFor("collect");
    expect(d?.subStepsOpen).toBe(3);
    expect(d?.subSteps[0]).toEqual({ key: "s1", label: "Bank statements", outcome: null, note: null, markedBy: null, markedAt: null });
    await expect(w.complete("collect")).rejects.toBeInstanceOf(SubStepsOpen);
  });

  it("is idempotent: the same answer again keeps who ticked it and when", async () => {
    const w = await world();
    await w.service.assignStep({ tenantId: TENANT, jobId: JOB, stepKey: "collect", assigneeUserId: null }, ACTOR, KAVYA);
    await w.tick("collect", "s1", "done", KAVYA);
    w.clock.advanceMinutes(1);
    await w.tick("collect", "s1", "done", PRIYA);
    const [row] = w.stepChecks.rows;
    expect(row?.markedByUserId).toBe(KAVYA);
    expect(row?.markedAt).toBe("2026-09-25T09:00:00.000Z");
    expect(w.stepChecks.rows).toHaveLength(1);
  });

  it("shows every line in the process's order, with who and when on the settled ones", async () => {
    const w = await world();
    await w.tick("collect", "s2", "done");
    await w.tick("collect", "s3", "not_applicable", KAVYA, "No payroll this month");
    const d = await w.describeFor("collect");
    expect(d?.subSteps).toEqual([
      { key: "s1", label: "Bank statements", outcome: null, note: null, markedBy: null, markedAt: null },
      {
        key: "s2", label: "Sales data", outcome: "done", note: null,
        markedBy: { userId: KAVYA, displayName: "Kavya Nair" }, markedAt: "2026-09-25T09:00:00.000Z",
      },
      {
        key: "s3", label: "Payroll information", outcome: "not_applicable", note: "No payroll this month",
        markedBy: { userId: KAVYA, displayName: "Kavya Nair" }, markedAt: "2026-09-25T09:00:00.000Z",
      },
    ]);
    // `viewer.mayComplete` keeps its meaning (WHO); `subStepsOpen` says READY.
    expect(d?.viewer.mayComplete).toBe(true);
    expect(d?.subStepsOpen).toBe(1);
  });
});

describe("a process with no lists", () => {
  it("behaves exactly as before: Done needs nothing, and nothing is read or recorded about lists", async () => {
    const w = await world([step({ key: "open" }), step({ key: "file", dependsOn: ["open"] })]);
    const d = await w.describeFor("open");
    expect(d?.subSteps).toEqual([]);
    expect(d?.subStepsOpen).toBe(0);
    await expect(w.complete("open")).resolves.toMatchObject({ status: "done" });
    const advanced = w.events.recorded.find((e) => e.verb === "job.step_advanced" && e.payload["to"] === "done");
    expect(advanced?.payload).toEqual({ stepKey: "open", from: "blocked", to: "done", executor: "human" });
    expect(w.stepChecks.rows).toEqual([]);
  });
});

describe("the checker's review points", () => {
  it("refuses Approve while any review point is open, and names what is left", async () => {
    const w = await world();
    const id = await w.toReview();
    await w.point(id, "r1", "done");
    const err = await w.decide(id, "approved").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReviewPointsOpen);
    expect((err as Error).message).toBe(
      "1 review point of 'Manager review' is not ticked yet: Balance sheet movements. Tick it, or mark " +
        "it not applicable with a reason, before approving. Sending the work back is always allowed.",
    );
    expect((await w.board())["review"]).toBe("blocked");
  });

  it("approves once every point is ticked or not applicable, and the job moves on", async () => {
    const w = await world();
    const id = await w.toReview();
    await w.point(id, "r1", "done");
    await w.point(id, "r2", "not_applicable", ANAND, "No balance sheet this month");
    await w.decide(id, "approved");
    expect(await w.board()).toMatchObject({ review: "done", mis: "blocked" });
  });

  it("never lets the MAKER tick their own review points", async () => {
    const w = await world();
    const id = await w.toReview();
    const err = await w.point(id, "r1", "done", KAVYA).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotEligibleToCheck);
    expect((err as NotEligibleToCheck).reason).toBe("IS_THE_MAKER");
    // Nor somebody below the firm's bar.
    await expect(w.point(id, "r1", "done", PRIYA)).rejects.toBeInstanceOf(NotEligibleToCheck);
    expect(w.stepChecks.rows.filter((r) => r.list === "review")).toEqual([]);
  });

  it("refuses a point the pinned step does not have, and 'not applicable' with no reason", async () => {
    const w = await world();
    const id = await w.toReview();
    await expect(w.point(id, "r9", "done")).rejects.toBeInstanceOf(ReviewPointNotFound);
    await expect(w.point(id, "r1", "not_applicable")).rejects.toBeInstanceOf(NotApplicableNeedsAReason);
  });

  it("allows Send back with every review point open", async () => {
    const w = await world();
    const id = await w.toReview();
    await expect(w.decide(id, "rejected", ANAND, "Bank reconciliation is a month out.")).resolves.toMatchObject({
      status: "blocked",
    });
  });

  it("returns the check with its points, and the job's checks read carries them", async () => {
    const w = await world();
    const id = await w.toReview();
    const row = await w.point(id, "r1", "done");
    expect(row.reviewPointsOpen).toBe(1);
    expect(row.reviewPoints.map((l) => [l.key, l.outcome, l.markedBy?.displayName ?? null])).toEqual([
      ["r1", "done", "Anand Rao"],
      ["r2", null, null],
    ]);
    const [queued] = await w.service.pendingChecks(TENANT, ANAND);
    expect(queued?.reviewPointsOpen).toBe(1);
    const [onJob] = await w.service.checksForJob(TENANT, JOB, ANAND);
    expect(onJob?.reviewPoints.map((l) => l.outcome)).toEqual(["done", null]);
  });
});

describe("after a send-back", () => {
  it("unlocks the doer's ticks, and the next check starts with its review points empty", async () => {
    const w = await world();
    const first = await w.toReview();
    await w.point(first, "r1", "done");
    await w.decide(first, "rejected", ANAND, "Close pack is missing the fixed asset register.");

    // The doer may change their ticks again; the send-back did not clear them.
    const before = await w.describeFor("review");
    expect(before?.subStepsOpen).toBe(0);
    await w.tick("review", "s1", null);
    await w.tick("review", "s1", "done");
    await w.complete("review");

    const second = await w.openCheck();
    expect(second).not.toBe(first);
    const checks = await w.service.checksForJob(TENANT, JOB, ANAND);
    const round1 = checks.find((c) => c.approval.id === first);
    const round2 = checks.find((c) => c.approval.id === second);
    // The first round's ticks are kept with the first round...
    expect(round1?.reviewPoints.map((l) => l.outcome)).toEqual(["done", null]);
    // ...and the second round starts with every point open.
    expect(round2?.reviewPointsOpen).toBe(2);
    await expect(w.decide(second, "approved")).rejects.toBeInstanceOf(ReviewPointsOpen);
  });
});

describe("a machine's answer, accepted by a person", () => {
  it("is held to the sub-steps, and the proposal stays undecided while it is refused", async () => {
    const agents = new FakeAgentRuntime().armWith("draft", 0.99, { total: "1200.00" });
    const w = await world(
      [step({ key: "draft", label: "Draft the reconciliation", executor: "agent_with_approval", checklist: COLLECT_LINES.slice(0, 2) })],
      { agents },
    );
    expect((await w.board())["draft"]).toBe("blocked");
    const accept = () =>
      w.service.decideProposal(
        { tenantId: TENANT, jobId: JOB, stepKey: "draft", outcome: "accepted", applied: null, rejectedReason: null },
        ACTOR,
        KAVYA,
      );
    await expect(accept()).rejects.toBeInstanceOf(SubStepsOpen);
    // Refused BEFORE the verdict was written: nothing says the machine was right.
    expect(w.runs.rows[0]?.outcome).toBeNull();
    // A rejection is never gated: throwing an answer away finishes nothing.
    // (Not exercised here, so the accept below can run on the same proposal.)
    await w.tick("draft", "s1", "done");
    await w.tick("draft", "s2", "done");
    await expect(accept()).resolves.toMatchObject({ status: "done" });
    expect(w.runs.rows[0]?.outcome).toBe("accepted");
  });

  it("lets a person reject the machine's answer with the sub-steps open", async () => {
    const agents = new FakeAgentRuntime().armWith("draft", 0.99);
    const w = await world([step({ key: "draft", executor: "agent_with_approval", checklist: COLLECT_LINES })], { agents });
    await expect(
      w.service.decideProposal(
        { tenantId: TENANT, jobId: JOB, stepKey: "draft", outcome: "rejected", applied: null, rejectedReason: "wrong month" },
        ACTOR,
        KAVYA,
      ),
    ).resolves.toMatchObject({ status: "blocked" });
  });

  it("never finishes a step with sub-steps unattended, even when a body reaches the engine unvalidated", async () => {
    // The validator refuses sub-steps on an `agent` step (the config test);
    // this is the second wall. A fake template skips the validator, the machine
    // is sure, the firm's tiers would commit it, and still a person is asked.
    const agents = new FakeAgentRuntime().armWith("draft", 0.99);
    const w = await world([step({ key: "draft", executor: "agent", checklist: COLLECT_LINES })], { agents });
    expect((await w.board())["draft"]).toBe("blocked");
    expect(w.runs.rows[0]?.decision).toBe("queued");
    expect(w.runs.rows[0]?.approvalRequired).toBe(true);
  });
});

describe("a ticked sub-step is work recorded (0304)", () => {
  const conditional = [
    step({
      key: "annual",
      label: "Annual summary",
      condition: { fact: "recurrence", op: "equals", value: "monthly" },
      checklist: COLLECT_LINES,
    }),
  ];

  it("withdraws an opened step whose rule stopped applying when nothing is ticked", async () => {
    const w = await world(conditional);
    expect((await w.board())["annual"]).toBe("blocked");
    w.subjects.set(JOB, { workflowTemplateKey: "close", recurrence: "quarterly", jurisdiction: "IN" });
    await w.service.walkForTenant(TENANT, ACTOR);
    expect((await w.board())["annual"]).toBe("skipped");
  });

  it("keeps it when any sub-step is ticked, or marked not applicable", async () => {
    for (const [outcome, note] of [["done", null], ["not_applicable", "Not relevant"]] as const) {
      const w = await world(conditional);
      await w.tick("annual", "s2", outcome, KAVYA, note);
      w.subjects.set(JOB, { workflowTemplateKey: "close", recurrence: "quarterly", jurisdiction: "IN" });
      await w.service.walkForTenant(TENANT, ACTOR);
      expect((await w.board())["annual"]).toBe("blocked");
    }
  });

  it("withdraws it again once the only tick is taken back", async () => {
    const w = await world(conditional);
    await w.tick("annual", "s2", "done");
    await w.tick("annual", "s2", null);
    w.subjects.set(JOB, { workflowTemplateKey: "close", recurrence: "quarterly", jurisdiction: "IN" });
    await w.service.walkForTenant(TENANT, ACTOR);
    expect((await w.board())["annual"]).toBe("skipped");
  });
});

describe("what the ledger is told", () => {
  it("puts the counts on the transitions, and never a label or a reason", async () => {
    const w = await world();
    await w.tick("collect", "s1", "done");
    await w.tick("collect", "s2", "done");
    await w.tick("collect", "s3", "not_applicable", KAVYA, "No payroll this month");
    await w.complete("collect");
    await w.tick("review", "s1", "done");
    await w.complete("review");
    const id = await w.openCheck();
    await w.point(id, "r1", "done");
    await w.decide(id, "rejected", ANAND, "Balance sheet does not tie.");
    await w.complete("review");
    const second = await w.openCheck();
    await w.point(second, "r1", "done");
    await w.point(second, "r2", "not_applicable", ANAND, "No balance sheet this month");
    await w.decide(second, "approved");

    const advanced = w.events.recorded.filter((e) => e.verb === "job.step_advanced");
    const collectDone = advanced.find((e) => e.payload["stepKey"] === "collect" && e.payload["to"] === "done");
    expect(collectDone?.payload["subSteps"]).toEqual({ total: 3, done: 2, notApplicable: 1 });
    const sentForChecking = advanced.find((e) => e.payload["stepKey"] === "review" && e.payload["awaitingCheck"] === true);
    expect(sentForChecking?.payload["subSteps"]).toEqual({ total: 1, done: 1, notApplicable: 0 });
    const approvedDone = advanced.find((e) => e.payload["stepKey"] === "review" && e.payload["checked"] === true);
    expect(approvedDone?.payload["subSteps"]).toEqual({ total: 1, done: 1, notApplicable: 0 });

    const rejected = w.events.recorded.find((e) => e.verb === "output.rejected");
    expect(rejected?.payload["reviewPoints"]).toEqual({ total: 2, done: 1, notApplicable: 0 });
    const approved = w.events.recorded.find((e) => e.verb === "output.approved");
    expect(approved?.payload["reviewPoints"]).toEqual({ total: 2, done: 1, notApplicable: 1 });

    // Not one tick wrote an event of its own, and no payload carries prose.
    const all = JSON.stringify(w.events.recorded.map((e) => e.payload));
    for (const prose of ["Bank statements", "Payroll information", "No payroll this month", "P&L movements", "No balance sheet this month"]) {
      expect(all).not.toContain(prose);
    }
  });

  it("says nothing about lists on the transitions of a step that has none", async () => {
    // `mis` has no sub-steps, and this process's check on `prepare` names no
    // review points: neither transition mentions a list at all.
    const w = await world([
      step({ key: "prepare", verificationPolicyKey: POLICY_KEY }),
      step({ key: "mis", dependsOn: ["prepare"] }),
    ]);
    await w.complete("prepare");
    await w.decide(await w.openCheck(), "approved");
    await w.complete("mis");
    const payloads = w.events.recorded
      .filter((e) => e.verb === "job.step_advanced" || e.verb === "output.approved")
      .map((e) => e.payload);
    expect(payloads.length).toBeGreaterThan(0);
    for (const p of payloads) {
      expect(p).not.toHaveProperty("subSteps");
      expect(p).not.toHaveProperty("reviewPoints");
    }
  });
});
