// The verification queue end to end through the orchestrator (T2.9), against
// in-memory fakes.
//
// The acceptance line is "the actor who produced an output cannot be its
// approver, and the DB rejects it". The DB half is
// `maker-checker.integration.test.ts`. These are the half that decides whether
// the product is USABLE: work that goes to somebody's desk instead of finishing,
// a job that does not advance until it is checked, a rejection that is a second
// attempt rather than an overwrite, and a person who is told WHY.
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
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import type { TemplateStep } from "../../src/usecase/orchestrator/ports";
import type { VerificationPolicy } from "../../src/domain/verification/model";
import {
  ApprovalAlreadyDecided,
  NotEligibleToCheck,
  RejectionNeedsAReason,
} from "../../src/domain/verification/errors";
import { AwaitingCheck } from "../../src/domain/orchestrator/errors";

const TENANT = "00000000-0000-4000-8000-0000000000d1";
const JOB = "00000000-0000-4000-8000-0000000000d9";
const PRIYA = "00000000-0000-4000-8000-0000000000db";
const ANAND = "00000000-0000-4000-8000-0000000000dc";
const SIDHARTH = "00000000-0000-4000-8000-0000000000dd";
const TEMPLATE_KEY = "gst-monthly";
const POLICY_KEY = "manager_review";
const POLICY_VERSION = "00000000-0000-4000-8000-0000000000de";

const MANAGER_OR_ABOVE: VerificationPolicy = {
  label: "Manager review",
  rule: "rank_threshold",
  minGradeRank: 7,
  minGradeCode: "manager",
};

function step(over: Partial<TemplateStep> & { key: string }): TemplateStep {
  return {
    label: over.key,
    executor: "human",
    dependsOn: [],
    condition: null,
    verificationPolicyKey: null,
    performer: null,
    ...over,
  };
}

/**
 * A firm with one job, one process, and a roster.
 *
 * `prepare` is checked by a Manager; `file` is not — so every test here also
 * asserts, by construction, that a step naming no policy behaves exactly as it
 * did before T2.9. That is the case that must not regress: every template
 * published until now names no policy at all.
 */
async function world(policy: VerificationPolicy | null = MANAGER_OR_ABOVE) {
  const jobs = new FakeJobRepo();
  const steps = new FakeJobStepRepo();
  const templates = new FakeTemplateSource();
  const subjects = new FakeJobSubjectSource();
  const events = new RecordingEventSink();
  const checks = new FakeStepApprovalRepo();
  checks.steps = steps;

  const policies = new FakeVerificationPolicySource();
  if (policy) policies.publish({ versionId: POLICY_VERSION, key: POLICY_KEY, policy });

  const checkers = new FakeCheckerDirectory()
    // Priya does the work. An Associate — rank 3, below the bar.
    .add({ userId: PRIYA, displayName: "Priya", gradeRank: 3, gradeName: "Associate" })
    // Anand is a Manager, and Priya reports to him.
    .add({ userId: ANAND, displayName: "Anand", gradeRank: 7, gradeName: "Manager" })
    // Sidharth is a Partner and nobody's manager here.
    .add({ userId: SIDHARTH, displayName: "Sidharth", gradeRank: 10, gradeName: "Partner" });
  const priya = checkers.rows.find((r) => r.userId === PRIYA);
  if (priya) checkers.rows[checkers.rows.indexOf(priya)] = { ...priya, reportsToUserId: ANAND };

  const { job } = await jobs.createIfAbsent({
    id: JOB,
    tenantId: TENANT,
    sourceKind: "engagement",
    sourceRef: "00000000-0000-4000-8000-0000000000da",
    runnableAt: "2026-08-01T00:00:00.000Z",
    splitAxis: "none" as const,
    splitCode: null,
  });
  subjects.set(JOB, {
    workflowTemplateKey: TEMPLATE_KEY,
    recurrence: "monthly",
    jurisdiction: "IN",
  });
  templates.publish(TENANT, TEMPLATE_KEY, {
    versionId: "v1",
    label: "GST monthly filing",
    steps: [
      step({ key: "prepare", verificationPolicyKey: POLICY_KEY }),
      step({ key: "file", dependsOn: ["prepare"] }),
    ],
  });

  const service = new OrchestratorService({
    desks: new FakeStepDeskResolver(),
    jobs,
    steps,
    templates,
    subjects,
    agents: new FakeAgentRuntime(),
    tiers: new FakeTierSource(),
    runs: new FakeAgentRunRepo(),
    checks,
    policies,
    checkers,
    permissions: new FakeWorkPermissions(),
    tenants: { activeTenantIds: () => Promise.resolve([TENANT]) },
    ids: new FakeIds(),
    clock: new FakeClock(new Date("2026-08-30T09:00:00.000Z")),
    events,
  });

  await service.advance(TENANT, job, SYSTEM_ACTOR);
  return { service, jobs, steps, checks, checkers, policies, events, job };
}

/** The step states, keyed, so an assertion reads like the work board. */
async function board(w: Awaited<ReturnType<typeof world>>): Promise<Record<string, string>> {
  const rows = await w.steps.listForJob(TENANT, JOB);
  return Object.fromEntries(rows.map((r) => [r.stepKey, r.status]));
}

describe("work that somebody has to check does not just finish", () => {
  it("holds the step, records who made it, and opens a check", async () => {
    const w = await world();
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "prepare" }, SYSTEM_ACTOR, PRIYA);

    // NOT done. This is the whole feature: a review that does not hold the work
    // up is a review nobody has to do.
    expect(await board(w)).toEqual({ prepare: "blocked", file: "pending" });

    const [check] = await w.checks.listPending(TENANT);
    expect(check?.stepKey).toBe("prepare");
    // Derived from the step by the fake, exactly as the trigger derives it.
    expect(check?.approval.submittedBy).toBe(PRIYA);
    expect(check?.approval.policyVersionId).toBe(POLICY_VERSION);
  });

  it("leaves a step naming no policy behaving exactly as it did before T2.9", async () => {
    const w = await world();
    // `file` depends on `prepare`, so get there the long way — approve first.
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "prepare" }, SYSTEM_ACTOR, PRIYA);
    const [check] = await w.checks.listPending(TENANT);
    if (!check) throw new Error("no check opened");
    await w.service.decideCheck(
      { tenantId: TENANT, approvalId: check.approval.id, decision: "approved", notes: null },
      SYSTEM_ACTOR,
      ANAND,
    );
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "file" }, SYSTEM_ACTOR, PRIYA);

    expect(await board(w)).toEqual({ prepare: "done", file: "done" });
    // And no check was opened for it, so nothing is waiting on anybody.
    expect(await w.checks.listPending(TENANT)).toEqual([]);
  });

  it("refuses the maker ticking the same step off a second time", async () => {
    // Almost always a screen that had not refreshed. Without the guard the
    // second click finds a check already open and silently does nothing — a
    // button that looks like it worked and did not.
    const w = await world();
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "prepare" }, SYSTEM_ACTOR, PRIYA);
    await expect(
      w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "prepare" }, SYSTEM_ACTOR, PRIYA),
    ).rejects.toThrow(AwaitingCheck);
  });
});

describe("who may check it", () => {
  it("refuses the person who did the work, in words", async () => {
    const w = await world();
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "prepare" }, SYSTEM_ACTOR, PRIYA);
    const [check] = await w.checks.listPending(TENANT);
    if (!check) throw new Error("no check opened");

    // THE ACCEPTANCE LINE, at the service. The database refuses it too, and that
    // is proven separately as the owner role — this is what a PERSON is told,
    // because a bare constraint violation reaches a browser as "internal error".
    await expect(
      w.service.decideCheck(
        { tenantId: TENANT, approvalId: check.approval.id, decision: "approved", notes: null },
        SYSTEM_ACTOR,
        PRIYA,
      ),
    ).rejects.toThrow(NotEligibleToCheck);

    // And the step did not move.
    expect(await board(w)).toEqual({ prepare: "blocked", file: "pending" });
  });

  it("refuses somebody below the firm's bar", async () => {
    const w = await world();
    // Anand does the work this time, so Priya is not the maker — she is simply
    // an Associate, and the bar is Manager.
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "prepare" }, SYSTEM_ACTOR, ANAND);
    const [check] = await w.checks.listPending(TENANT);
    if (!check) throw new Error("no check opened");
    await expect(
      w.service.decideCheck(
        { tenantId: TENANT, approvalId: check.approval.id, decision: "approved", notes: null },
        SYSTEM_ACTOR,
        PRIYA,
      ),
    ).rejects.toThrow(NotEligibleToCheck);
  });

  it("names everybody and says why each one can or cannot", async () => {
    // The whole roster with a verdict, not a filtered list: "why can Priya not
    // approve this" is the question somebody asks, and the answer is the thing
    // that then gets fixed.
    const w = await world();
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "prepare" }, SYSTEM_ACTOR, PRIYA);
    const [check] = await w.checks.listPending(TENANT);
    if (!check) throw new Error("no check opened");

    const verdicts = await w.service.eligibleCheckers(TENANT, check.approval.id);
    expect(
      Object.fromEntries(verdicts.map((v) => [v.displayName, v.reason ?? "eligible"])),
    ).toEqual({
      Priya: "IS_THE_MAKER",
      Anand: "eligible",
      Sidharth: "eligible",
    });
  });

  it("applies a reporting_line rule to the MAKER's manager, not to anybody senior", async () => {
    // The bug an earlier draft of the domain had: comparing the candidate to the
    // maker instead of to the maker's manager, which would have made exactly one
    // person eligible — the one who is always forbidden.
    const w = await world({
      label: "Engagement manager review",
      rule: "reporting_line",
      minGradeRank: null,
      minGradeCode: null,
    });
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "prepare" }, SYSTEM_ACTOR, PRIYA);
    const [check] = await w.checks.listPending(TENANT);
    if (!check) throw new Error("no check opened");

    const verdicts = await w.service.eligibleCheckers(TENANT, check.approval.id);
    expect(
      Object.fromEntries(verdicts.map((v) => [v.displayName, v.reason ?? "eligible"])),
    ).toEqual({
      Priya: "IS_THE_MAKER",
      // Priya reports to Anand.
      Anand: "eligible",
      // A Partner, and refused — which is the whole difference from a threshold.
      Sidharth: "NOT_THE_MAKERS_MANAGER",
    });
  });
});

describe("approving", () => {
  it("finishes the step, advances the job, and keeps the MAKER on the record", async () => {
    const w = await world();
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "prepare" }, SYSTEM_ACTOR, PRIYA);
    const [check] = await w.checks.listPending(TENANT);
    if (!check) throw new Error("no check opened");

    await w.service.decideCheck(
      { tenantId: TENANT, approvalId: check.approval.id, decision: "approved", notes: null },
      SYSTEM_ACTOR,
      ANAND,
    );

    // `file` became ready in the same call — a reviewer who approves something
    // and watches the job sit still concludes it did not go through.
    expect(await board(w)).toEqual({ prepare: "done", file: "blocked" });

    const prepare = (await w.steps.listForJob(TENANT, JOB)).find((s) => s.stepKey === "prepare");
    // PRIYA, not Anand. This column answers "who did the work", and overwriting
    // it with the approver would erase the left-hand side of the rule that was
    // just enforced.
    expect(prepare?.performedBy).toBe(PRIYA);
  });

  it("writes output.approved — a verb that had no writer until now", async () => {
    const w = await world();
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "prepare" }, SYSTEM_ACTOR, PRIYA);
    const [check] = await w.checks.listPending(TENANT);
    if (!check) throw new Error("no check opened");
    await w.service.decideCheck(
      { tenantId: TENANT, approvalId: check.approval.id, decision: "approved", notes: null },
      SYSTEM_ACTOR,
      ANAND,
    );
    expect(w.events.verbs()).toContain("output.approved");
  });

  it("refuses a second decision, so the first one stands", async () => {
    const w = await world();
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "prepare" }, SYSTEM_ACTOR, PRIYA);
    const [check] = await w.checks.listPending(TENANT);
    if (!check) throw new Error("no check opened");
    await w.service.decideCheck(
      { tenantId: TENANT, approvalId: check.approval.id, decision: "approved", notes: null },
      SYSTEM_ACTOR,
      ANAND,
    );
    await expect(
      w.service.decideCheck(
        { tenantId: TENANT, approvalId: check.approval.id, decision: "rejected", notes: "no" },
        SYSTEM_ACTOR,
        SIDHARTH,
      ),
    ).rejects.toThrow(ApprovalAlreadyDecided);
  });
});

describe("sending work back", () => {
  it("leaves the step waiting and keeps the reason", async () => {
    const w = await world();
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "prepare" }, SYSTEM_ACTOR, PRIYA);
    const [check] = await w.checks.listPending(TENANT);
    if (!check) throw new Error("no check opened");

    await w.service.decideCheck(
      {
        tenantId: TENANT,
        approvalId: check.approval.id,
        decision: "rejected",
        notes: "The March input credit is on the wrong period.",
      },
      SYSTEM_ACTOR,
      ANAND,
    );

    // Rejecting is not doing the work. Somebody still has to.
    expect(await board(w)).toEqual({ prepare: "blocked", file: "pending" });
    expect(w.events.verbs()).toContain("output.rejected");
    const rows = await w.checks.listForJob(TENANT, JOB);
    expect(rows[0]?.approval.notes).toContain("wrong period");
  });

  it("refuses a rejection with no reason", async () => {
    // The one a PERSON hits, by clicking Send back and typing nothing. The
    // database refuses it too; this is what they are told.
    const w = await world();
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "prepare" }, SYSTEM_ACTOR, PRIYA);
    const [check] = await w.checks.listPending(TENANT);
    if (!check) throw new Error("no check opened");
    await expect(
      w.service.decideCheck(
        { tenantId: TENANT, approvalId: check.approval.id, decision: "rejected", notes: "   " },
        SYSTEM_ACTOR,
        ANAND,
      ),
    ).rejects.toThrow(RejectionNeedsAReason);
  });

  it("opens a SECOND check when the work is redone, so 'it took two goes' survives", async () => {
    const w = await world();
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "prepare" }, SYSTEM_ACTOR, PRIYA);
    const [first] = await w.checks.listPending(TENANT);
    if (!first) throw new Error("no check opened");
    await w.service.decideCheck(
      { tenantId: TENANT, approvalId: first.approval.id, decision: "rejected", notes: "wrong period" },
      SYSTEM_ACTOR,
      ANAND,
    );

    // Priya redoes it and submits again.
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "prepare" }, SYSTEM_ACTOR, PRIYA);

    const all = await w.checks.listForJob(TENANT, JOB);
    expect(all).toHaveLength(2);
    expect(all.map((c) => c.approval.decision)).toEqual(["rejected", "pending"]);
  });
});

describe("the queue itself", () => {
  it("shows the whole firm's work with the viewer's own verdict on each row", async () => {
    // Not filtered to what the viewer may take: a queue that hides what you
    // cannot act on also hides that work has been sitting for a week because
    // nobody senior enough has looked.
    const w = await world();
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "prepare" }, SYSTEM_ACTOR, PRIYA);

    const asPriya = await w.service.pendingChecks(TENANT, PRIYA);
    expect(asPriya).toHaveLength(1);
    expect(asPriya[0]?.viewer).toEqual({ eligible: false, reason: "IS_THE_MAKER" });
    expect(asPriya[0]?.rule).toBe("rank_threshold");

    const asAnand = await w.service.pendingChecks(TENANT, ANAND);
    expect(asAnand[0]?.viewer).toEqual({ eligible: true, reason: null });
  });

  it("empties when the work is approved", async () => {
    const w = await world();
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "prepare" }, SYSTEM_ACTOR, PRIYA);
    const [check] = await w.checks.listPending(TENANT);
    if (!check) throw new Error("no check opened");
    await w.service.decideCheck(
      { tenantId: TENANT, approvalId: check.approval.id, decision: "approved", notes: null },
      SYSTEM_ACTOR,
      ANAND,
    );
    expect(await w.service.pendingChecks(TENANT, ANAND)).toEqual([]);
  });
});

describe("a rule the firm has withdrawn", () => {
  it("still opens the check, under maker != checker alone", async () => {
    // The firm said this step is reviewed. Unpublishing the rule about WHO does
    // it is not the same as saying nobody does — and falling through to "no
    // check" would silently stop reviewing filings the day somebody tidied up
    // the config screen.
    const w = await world();
    w.policies.withdraw(POLICY_KEY);
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "prepare" }, SYSTEM_ACTOR, PRIYA);

    const [check] = await w.checks.listPending(TENANT);
    expect(check?.approval.policyVersionId).toBeNull();
    expect(check?.approval.policyKey).toBe(POLICY_KEY);

    // Anybody but the maker.
    const verdicts = await w.service.eligibleCheckers(TENANT, check?.approval.id ?? "");
    expect(
      Object.fromEntries(verdicts.map((v) => [v.displayName, v.reason ?? "eligible"])),
    ).toEqual({ Priya: "IS_THE_MAKER", Anand: "eligible", Sidharth: "eligible" });
  });
});
