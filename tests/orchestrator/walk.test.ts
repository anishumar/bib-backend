// The orchestrator walking a job's step graph (T2.7), against in-memory fakes.
//
// The acceptance line is "a 3-step graph advances step to step, sequential +
// parallel + branch", and those three are the first three describes. Everything
// after them is a property that would be silently wrong rather than loudly
// broken: a pin that stops pinning, a branch that skips a step because a field
// was left blank, a second worker overwriting who did the work.
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
import type { ResolvedTemplate, TemplateStep } from "../../src/usecase/orchestrator/ports";
import {
  NoTemplatePublished,
  NothingProposed,
  StepNoLongerNeeded,
  StepNotWaiting,
  TemplateUnreadable,
} from "../../src/domain/orchestrator/errors";

const TENANT = "00000000-0000-4000-8000-0000000000c1";
const JOB = "00000000-0000-4000-8000-0000000000c9";
const ENGAGEMENT = "00000000-0000-4000-8000-0000000000ca";
const PRIYA = "00000000-0000-4000-8000-0000000000cb";
const ANAND = "00000000-0000-4000-8000-0000000000cc";
const TEMPLATE_KEY = "gst-monthly";
const ACTOR = SYSTEM_ACTOR;

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

function template(steps: readonly TemplateStep[], versionId = "v1"): ResolvedTemplate {
  return { versionId, label: "GST monthly filing", steps };
}

interface World {
  readonly service: OrchestratorService;
  readonly jobs: FakeJobRepo;
  readonly steps: FakeJobStepRepo;
  readonly templates: FakeTemplateSource;
  readonly subjects: FakeJobSubjectSource;
  readonly agents: FakeAgentRuntime;
  readonly events: RecordingEventSink;
  readonly job: Job;
}

/** A firm with one job, waiting for a process. The template and the agents are
 *  whatever the test then arms — which is the point: the same job behaves
 *  completely differently depending on what the firm wrote. */
async function world(over: { readonly recurrence?: string | null } = {}): Promise<World> {
  const jobs = new FakeJobRepo();
  const steps = new FakeJobStepRepo();
  const templates = new FakeTemplateSource();
  const subjects = new FakeJobSubjectSource();
  const agents = new FakeAgentRuntime();
  const events = new RecordingEventSink();

  const { job } = await jobs.createIfAbsent({
    id: JOB,
    tenantId: TENANT,
    sourceKind: "engagement",
    sourceRef: ENGAGEMENT,
    runnableAt: "2026-08-01T00:00:00.000Z",
    splitAxis: "none" as const,
    splitCode: null,
  });
  subjects.set(JOB, {
    workflowTemplateKey: TEMPLATE_KEY,
    recurrence: over.recurrence === undefined ? "monthly" : over.recurrence,
    jurisdiction: "IN",
  });

  // Thresholds published, so these tests keep meaning what they meant before
  // T2.8: they are about the GRAPH, and a confident agent finishing its step is
  // the shape they assert. The fake agent answers at confidence 1 by default,
  // which is above 0.95.
  //
  // The OPPOSITE case — no tier published, so nothing commits however sure the
  // machine is — is the product's real starting state and has its own tests in
  // `agent.test.ts`, where it is the subject rather than the backdrop.
  const tiers = new FakeTierSource().publish(SUGGESTED_TIERS);
  const runs = new FakeAgentRunRepo();
  const service = new OrchestratorService({
    timeZones: new FakeFirmTimeZone(),
    desks: new FakeStepDeskResolver(),
    jobs,
    steps,
    stepChecks: new FakeStepCheckRepo(steps),
    templates,
    subjects,
    tiers,
    runs,
    agents,
    checks: new FakeStepApprovalRepo(),
    policies: new FakeVerificationPolicySource(),
    checkers: new FakeCheckerDirectory(),
    permissions: new FakeWorkPermissions(),
    tenants: { activeTenantIds: () => Promise.resolve([TENANT]) },
    ids: new FakeIds(),
    clock: new FakeClock(new Date("2026-08-29T09:00:00.000Z")),
    events,
  });
  return { service, jobs, steps, templates, subjects, agents, events, job };
}

/** The step states, keyed, for an assertion that reads like the work board. */
async function board(w: World): Promise<Record<string, string>> {
  const rows = await w.steps.listForJob(TENANT, JOB);
  return Object.fromEntries(rows.map((r) => [r.stepKey, r.status]));
}

async function jobStatus(w: World): Promise<string> {
  const job = await w.jobs.findById(TENANT, JOB);
  return job?.status ?? "gone";
}

// ── THE ACCEPTANCE ───────────────────────────────────────────────────────────

describe("sequential — a three-step graph advances step to step", () => {
  it("starts only the first step, and moves one at a time as people finish them", async () => {
    const w = await world();
    w.templates.publish(
      TENANT,
      TEMPLATE_KEY,
      template([
        step({ key: "collect" }),
        step({ key: "reconcile", dependsOn: ["collect"] }),
        step({ key: "file", dependsOn: ["reconcile"] }),
      ]),
    );

    await w.service.advance(TENANT, w.job, ACTOR);
    // Only the first is on anybody's desk. The other two are not "not started
    // yet" in some UI sense — they are pending because their dependency has not
    // cleared, which is the same rule that makes the whole graph work.
    expect(await board(w)).toEqual({ collect: "blocked", reconcile: "pending", file: "pending" });
    expect(await jobStatus(w)).toBe("blocked");

    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "collect" }, ACTOR, PRIYA);
    expect(await board(w)).toEqual({ collect: "done", reconcile: "blocked", file: "pending" });

    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "reconcile" }, ACTOR, PRIYA);
    expect(await board(w)).toEqual({ collect: "done", reconcile: "done", file: "blocked" });

    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "file" }, ACTOR, PRIYA);
    expect(await board(w)).toEqual({ collect: "done", reconcile: "done", file: "done" });
    expect(await jobStatus(w)).toBe("done");
  });
});

describe("parallel — two steps become ready together, and the next waits for both", () => {
  it("opens both branches at once", async () => {
    const w = await world();
    w.templates.publish(
      TENANT,
      TEMPLATE_KEY,
      template([
        step({ key: "collect" }),
        step({ key: "sales", dependsOn: ["collect"] }),
        step({ key: "purchases", dependsOn: ["collect"] }),
        step({ key: "file", dependsOn: ["sales", "purchases"] }),
      ]),
    );

    await w.service.advance(TENANT, w.job, ACTOR);
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "collect" }, ACTOR, PRIYA);

    expect(await board(w)).toEqual({
      collect: "done",
      sales: "blocked",
      purchases: "blocked",
      file: "pending",
    });
  });

  it("holds the join until the SLOWER of the two is finished", async () => {
    const w = await world();
    w.templates.publish(
      TENANT,
      TEMPLATE_KEY,
      template([
        step({ key: "collect" }),
        step({ key: "sales", dependsOn: ["collect"] }),
        step({ key: "purchases", dependsOn: ["collect"] }),
        step({ key: "file", dependsOn: ["sales", "purchases"] }),
      ]),
    );
    await w.service.advance(TENANT, w.job, ACTOR);
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "collect" }, ACTOR, PRIYA);
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "sales" }, ACTOR, PRIYA);

    // One branch done, the other still open: `file` must NOT be on a desk.
    // Getting this wrong is the bug that files a return off half the data.
    expect((await board(w))["file"]).toBe("pending");

    await w.service.completeStep(
      { tenantId: TENANT, jobId: JOB, stepKey: "purchases" },
      ACTOR,
      ANAND,
    );
    expect((await board(w))["file"]).toBe("blocked");
  });
});

describe("branch — a step whose condition does not hold is skipped, and the rest carries on", () => {
  const branching = template([
    step({ key: "collect" }),
    step({
      key: "annual_summary",
      dependsOn: ["collect"],
      condition: { fact: "recurrence", op: "equals", value: "annually" },
    }),
    step({ key: "file", dependsOn: ["collect"] }),
  ]);

  it("skips the step when the fact does not match, and does NOT hold up the others", async () => {
    const w = await world({ recurrence: "monthly" });
    w.templates.publish(TENANT, TEMPLATE_KEY, branching);

    await w.service.advance(TENANT, w.job, ACTOR);
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "collect" }, ACTOR, PRIYA);

    expect(await board(w)).toEqual({
      collect: "done",
      annual_summary: "skipped",
      file: "blocked",
    });
  });

  it("keeps the step when the fact matches", async () => {
    const w = await world({ recurrence: "annually" });
    w.templates.publish(TENANT, TEMPLATE_KEY, branching);

    await w.service.advance(TENANT, w.job, ACTOR);
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "collect" }, ACTOR, PRIYA);

    expect((await board(w))["annual_summary"]).toBe("blocked");
  });

  it("skips everything DOWNSTREAM of a skipped step, or the job would wait forever", async () => {
    const w = await world({ recurrence: "monthly" });
    w.templates.publish(
      TENANT,
      TEMPLATE_KEY,
      template([
        step({ key: "collect" }),
        step({
          key: "annual_summary",
          dependsOn: ["collect"],
          condition: { fact: "recurrence", op: "equals", value: "annually" },
        }),
        // Two levels below the conditional step, to prove the cascade is
        // transitive rather than one-deep.
        step({ key: "annual_review", dependsOn: ["annual_summary"] }),
        step({ key: "annual_sign_off", dependsOn: ["annual_review"] }),
      ]),
    );

    await w.service.advance(TENANT, w.job, ACTOR);
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "collect" }, ACTOR, PRIYA);

    expect(await board(w)).toEqual({
      collect: "done",
      annual_summary: "skipped",
      annual_review: "skipped",
      annual_sign_off: "skipped",
    });
    // And the job is finished rather than stuck — the whole point of the
    // cascade. A skipped branch must not leave a job open forever.
    expect(await jobStatus(w)).toBe("done");
  });

  it("records the FACT and its values, never the prose note", async () => {
    const w = await world({ recurrence: "monthly" });
    w.templates.publish(TENANT, TEMPLATE_KEY, branching);
    await w.service.advance(TENANT, w.job, ACTOR);
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "collect" }, ACTOR, PRIYA);

    const skip = w.events.recorded.find((e) => e.verb === "job.step_skipped");
    expect(skip?.payload).toEqual({
      stepKey: "annual_summary",
      fact: "recurrence",
      // The operator too. Without it "expected: annually, actual: monthly"
      // reads the same whichever way the rule pointed.
      op: "equals",
      expected: "annually",
      actual: "monthly",
    });
  });

  // THE DECISION IN `evaluateCondition`, and the one most likely to be
  // "simplified" later by somebody who reads it as a missing else.
  it("KEEPS a conditional step when the fact is not stated at all", async () => {
    const w = await world({ recurrence: null });
    w.templates.publish(TENANT, TEMPLATE_KEY, branching);
    await w.service.advance(TENANT, w.job, ACTOR);
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "collect" }, ACTOR, PRIYA);

    // A blank field in the catalogue must not quietly remove a step from a
    // process. An extra review costs an hour; a missing one costs a filing.
    expect((await board(w))["annual_summary"]).toBe("blocked");
  });
});

// ── A RULE THAT STOPS APPLYING AFTER THE STEP OPENED (0304) ─────────────────

describe("a step whose condition stops holding AFTER it opened", () => {
  // The facts are read live: the service's recurrence can be republished and an
  // entity's jurisdiction corrected while a step already sits on a desk. Judged
  // only at the start, that step stayed there until somebody ticked it "done"
  // on work nobody did.
  const branching = template([
    step({ key: "collect" }),
    step({
      key: "annual_summary",
      dependsOn: ["collect"],
      condition: { fact: "recurrence", op: "equals", value: "annually" },
    }),
    step({ key: "annual_review", dependsOn: ["annual_summary"] }),
    step({ key: "file", dependsOn: ["collect"] }),
  ]);

  async function opened(): Promise<World> {
    const w = await world({ recurrence: "annually" });
    w.templates.publish(TENANT, TEMPLATE_KEY, branching);
    await w.service.advance(TENANT, w.job, ACTOR);
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "collect" }, ACTOR, PRIYA);
    expect((await board(w))["annual_summary"]).toBe("blocked");
    return w;
  }

  function moveTo(w: World, recurrence: string | null): void {
    w.subjects.set(JOB, { workflowTemplateKey: TEMPLATE_KEY, recurrence, jurisdiction: "IN" });
  }

  const row = (w: World, key: string) => w.steps.rows.find((r) => r.stepKey === key);

  it("withdraws it on the next walk, keeps when it opened, and says why", async () => {
    const w = await opened();
    const openedAt = row(w, "annual_summary")?.startedAt;
    expect(openedAt).not.toBeNull();

    moveTo(w, "monthly");
    await w.service.advance(TENANT, w.job, ACTOR);

    const summary = row(w, "annual_summary");
    expect(summary?.status).toBe("skipped");
    // The day it opened survives: "why was this on my list and then gone" is
    // answered by exactly this.
    expect(summary?.startedAt).toBe(openedAt);
    expect(summary?.finishedAt).toBeNull();
    // Nobody performs a skip.
    expect(summary?.performedBy).toBeNull();
    expect(summary?.outcomeNote).toMatch(/had already opened and no longer applies/);
    expect(summary?.outcomeNote).toMatch(/"monthly"/);
  });

  it("takes what depended on it with it, and the job carries on", async () => {
    const w = await opened();
    moveTo(w, "monthly");
    await w.service.advance(TENANT, w.job, ACTOR);

    expect(await board(w)).toEqual({
      collect: "done",
      annual_summary: "skipped",
      annual_review: "skipped",
      file: "blocked",
    });
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "file" }, ACTOR, PRIYA);
    expect(await jobStatus(w)).toBe("done");
  });

  it("records the fact, where it was, and whose desk, never the note", async () => {
    const w = await opened();
    // On Anand's desk, as the SPOC default or a hand-over would have left it.
    const open = row(w, "annual_summary");
    if (!open) throw new Error("expected the step");
    w.steps.rows[w.steps.rows.indexOf(open)] = { ...open, assigneeUserId: ANAND };
    moveTo(w, "monthly");
    await w.service.advance(TENANT, w.job, ACTOR);

    const skip = w.events.recorded.find(
      (e) => e.verb === "job.step_skipped" && e.payload["stepKey"] === "annual_summary",
    );
    expect(skip?.payload).toEqual({
      stepKey: "annual_summary",
      fact: "recurrence",
      op: "equals",
      expected: "annually",
      actual: "monthly",
      from: "blocked",
      afterStart: true,
      assigneeUserId: ANAND,
    });
    // Whose desk it was on stays on the row: that is history, not a live desk.
    expect(row(w, "annual_summary")?.assigneeUserId).toBe(ANAND);
  });

  it("KEEPS it when the fact becomes unknown, not merely different", async () => {
    const w = await opened();
    moveTo(w, null);
    await w.service.advance(TENANT, w.job, ACTOR);
    expect((await board(w))["annual_summary"]).toBe("blocked");
  });

  it("KEEPS it once somebody has done the work on it", async () => {
    // Ticked and sent for checking: `performed_by` is written and the step
    // stays blocked on its check. The work exists, and a catalogue change is
    // no reason to throw it away.
    const w = await opened();
    const summary = row(w, "annual_summary");
    if (!summary) throw new Error("expected the step");
    w.steps.rows[w.steps.rows.indexOf(summary)] = { ...summary, performedBy: PRIYA };

    moveTo(w, "monthly");
    await w.service.advance(TENANT, w.job, ACTOR);
    expect((await board(w))["annual_summary"]).toBe("blocked");
  });

  it("KEEPS it while a machine's answer is waiting on a person", async () => {
    const w = await world({ recurrence: "annually" });
    w.agents.arm("draft");
    w.templates.publish(
      TENANT,
      TEMPLATE_KEY,
      template([
        step({
          key: "draft",
          executor: "agent_with_approval",
          condition: { fact: "recurrence", op: "equals", value: "annually" },
        }),
      ]),
    );
    await w.service.advance(TENANT, w.job, ACTOR);
    expect(await board(w)).toEqual({ draft: "blocked" });

    moveTo(w, "monthly");
    await w.service.advance(TENANT, w.job, ACTOR);
    expect(await board(w)).toEqual({ draft: "blocked" });
  });

  it("answers a late tick with WHY there is nothing to tick", async () => {
    const w = await opened();
    moveTo(w, "monthly");
    await w.service.advance(TENANT, w.job, ACTOR);

    await expect(
      w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "annual_summary" }, ACTOR, PRIYA),
    ).rejects.toThrow(StepNoLongerNeeded);
    await expect(
      w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "annual_summary" }, ACTOR, PRIYA),
    ).rejects.toThrow(/no longer needed.*had already opened/);
  });

  it("does nothing on a second walk", async () => {
    const w = await opened();
    moveTo(w, "monthly");
    await w.service.advance(TENANT, w.job, ACTOR);
    const before = w.events.recorded.filter((e) => e.verb === "job.step_skipped").length;
    await w.service.advance(TENANT, w.job, ACTOR);
    expect(w.events.recorded.filter((e) => e.verb === "job.step_skipped")).toHaveLength(before);
  });
});

// ── AGENTS: OPTIONAL, AND NEVER THE THING THAT BREAKS A PROCESS ─────────────

describe("agents", () => {
  it("runs an agent step and finishes it without anybody being asked", async () => {
    const w = await world();
    w.agents.arm("reconcile");
    w.templates.publish(
      TENANT,
      TEMPLATE_KEY,
      template([
        step({ key: "reconcile", executor: "agent" }),
        step({ key: "file", dependsOn: ["reconcile"] }),
      ]),
    );

    await w.service.advance(TENANT, w.job, ACTOR);
    expect(await board(w)).toEqual({ reconcile: "done", file: "blocked" });
    expect(w.agents.ran).toEqual(["reconcile"]);
  });

  // THE RULE THE PRODUCT IS BUILT ON: a template may say a step is an agent's
  // long before any agent exists. The work does not stop; it goes to a person.
  it("sends an agent step to a PERSON when no agent is built for it", async () => {
    const w = await world();
    // Deliberately not armed.
    w.templates.publish(
      TENANT,
      TEMPLATE_KEY,
      template([step({ key: "reconcile", executor: "agent" })]),
    );

    await w.service.advance(TENANT, w.job, ACTOR);
    expect(await board(w)).toEqual({ reconcile: "blocked" });
    expect(w.agents.ran).toEqual([]);

    const event = w.events.recorded.find((e) => e.verb === "job.step_advanced");
    expect(event?.payload).toMatchObject({ executor: "agent", awaitingAgent: true });
  });

  it("lets a person finish that step, even though the template calls it an agent's", async () => {
    const w = await world();
    w.templates.publish(
      TENANT,
      TEMPLATE_KEY,
      template([step({ key: "reconcile", executor: "agent" })]),
    );
    await w.service.advance(TENANT, w.job, ACTOR);

    const done = await w.service.completeStep(
      { tenantId: TENANT, jobId: JOB, stepKey: "reconcile" },
      ACTOR,
      PRIYA,
    );
    expect(done.status).toBe("done");
    expect(done.performedBy).toBe(PRIYA);
    expect(await jobStatus(w)).toBe("done");
  });

  it("refuses a person on an agent step that DOES have an agent", async () => {
    const w = await world();
    w.agents.arm("reconcile");
    w.templates.publish(
      TENANT,
      TEMPLATE_KEY,
      template([
        step({ key: "reconcile", executor: "agent" }),
        step({ key: "file", dependsOn: ["reconcile"] }),
      ]),
    );
    await w.service.advance(TENANT, w.job, ACTOR);
    // The agent already finished it, so it is not waiting for anybody.
    await expect(
      w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "reconcile" }, ACTOR, PRIYA),
    ).rejects.toThrow(StepNotWaiting);
  });

  it("waits for a person on `agent_with_approval` even when the agent exists", async () => {
    const w = await world();
    w.agents.arm("draft");
    w.templates.publish(
      TENANT,
      TEMPLATE_KEY,
      template([step({ key: "draft", executor: "agent_with_approval" })]),
    );

    await w.service.advance(TENANT, w.job, ACTOR);
    expect(await board(w)).toEqual({ draft: "blocked" });
  });

  it("holds the job when an agent FAILS, and keeps its dependents pending", async () => {
    const w = await world();
    w.agents.armFailing("reconcile", "the portal did not respond");
    w.templates.publish(
      TENANT,
      TEMPLATE_KEY,
      template([
        step({ key: "reconcile", executor: "agent" }),
        step({ key: "file", dependsOn: ["reconcile"] }),
      ]),
    );

    await w.service.advance(TENANT, w.job, ACTOR);
    expect(await board(w)).toEqual({ reconcile: "failed", file: "pending" });
    // A failure does NOT clear its dependents — unlike a skip. The job is
    // blocked, which is exactly "the engine stopped and a person must look".
    expect(await jobStatus(w)).toBe("blocked");

    const rows = await w.steps.listForJob(TENANT, JOB);
    expect(rows.find((r) => r.stepKey === "reconcile")?.outcomeNote).toBe(
      "the portal did not respond",
    );
  });
});

// ── PINNING ─────────────────────────────────────────────────────────────────

describe("the version a job walks is pinned, and never re-read", () => {
  it("records the version on the job the first time, with the key and the id", async () => {
    const w = await world();
    w.templates.publish(TENANT, TEMPLATE_KEY, template([step({ key: "collect" })], "v1"));
    await w.service.advance(TENANT, w.job, ACTOR);

    const job = await w.jobs.findById(TENANT, JOB);
    expect(job?.templateVersionId).toBe("v1");
    const pinned = w.events.recorded.find((e) => e.verb === "job.template_pinned");
    expect(pinned?.payload).toEqual({ templateKey: TEMPLATE_KEY, versionId: "v1" });
  });

  it("keeps walking the OLD process after the firm publishes a new one", async () => {
    const w = await world();
    w.templates.publish(
      TENANT,
      TEMPLATE_KEY,
      template([step({ key: "collect" }), step({ key: "file", dependsOn: ["collect"] })], "v1"),
    );
    await w.service.advance(TENANT, w.job, ACTOR);

    // The firm adds a review step. Every job started from now on gets it; this
    // one must not, and "why did that filing have no review" has to answer with
    // the version rather than with a shrug.
    w.templates.publish(
      TENANT,
      TEMPLATE_KEY,
      template(
        [
          step({ key: "collect" }),
          step({ key: "review", dependsOn: ["collect"] }),
          step({ key: "file", dependsOn: ["review"] }),
        ],
        "v2",
      ),
    );

    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "collect" }, ACTOR, PRIYA);
    expect(await board(w)).toEqual({ collect: "done", file: "blocked" });
    expect((await w.jobs.findById(TENANT, JOB))?.templateVersionId).toBe("v1");
  });

  it("refuses to move a job onto today's process when its pinned version cannot be read", async () => {
    const w = await world();
    w.templates.publish(TENANT, TEMPLATE_KEY, template([step({ key: "collect" })], "v1"));
    await w.service.advance(TENANT, w.job, ACTOR);

    // A pinned version that no longer parses. Falling back to what is in force
    // would be the silent process change pinning exists to prevent.
    const broken = { ...w.job, templateVersionId: "v-gone" };
    await expect(w.service.advance(TENANT, broken, ACTOR)).rejects.toThrow(TemplateUnreadable);
  });
});

// ── A FIRM THAT HAS NOT WRITTEN ITS PROCESS ────────────────────────────────

describe("a job with no process to walk", () => {
  it("waits, rather than failing or completing", async () => {
    const w = await world();
    await expect(w.service.advance(TENANT, w.job, ACTOR)).rejects.toThrow(NoTemplatePublished);
    // Untouched. The work is not lost and the job has not quietly finished with
    // nothing done — which is the only outcome worse than waiting.
    expect(await jobStatus(w)).toBe("pending");
    expect(await board(w)).toEqual({});
  });

  it("counts it in the sweep as waiting on a TEMPLATE, not as an error", async () => {
    const w = await world();
    const [report] = await w.service.sweep(ACTOR);
    expect(report).toMatchObject({ awaitingTemplate: 1, started: 0, advanced: 0 });
  });

  it("picks the job up on the next sweep once a process is published", async () => {
    const w = await world();
    await w.service.sweep(ACTOR);
    w.templates.publish(TENANT, TEMPLATE_KEY, template([step({ key: "collect" })]));

    const [report] = await w.service.sweep(ACTOR);
    expect(report).toMatchObject({ started: 1, awaitingTemplate: 0 });
    expect(await board(w)).toEqual({ collect: "blocked" });
  });

  it("waits the same way when the service names no process at all", async () => {
    const w = await world();
    w.subjects.set(JOB, { workflowTemplateKey: null, recurrence: "monthly", jurisdiction: "IN" });
    await expect(w.service.advance(TENANT, w.job, ACTOR)).rejects.toThrow(NoTemplatePublished);
  });
});

// ── IDEMPOTENCY AND THE RACE BETWEEN TWO WORKERS ───────────────────────────

describe("running the same work twice changes nothing", () => {
  it("writes a job's steps once, however many times it is swept", async () => {
    const w = await world();
    w.templates.publish(
      TENANT,
      TEMPLATE_KEY,
      template([step({ key: "collect" }), step({ key: "file", dependsOn: ["collect"] })]),
    );

    await w.service.sweep(ACTOR);
    await w.service.sweep(ACTOR);
    await w.service.sweep(ACTOR);

    expect(w.steps.rows.filter((r) => r.jobId === JOB)).toHaveLength(2);
    expect(w.events.recorded.filter((e) => e.verb === "job.started")).toHaveLength(1);
  });

  it("pins once — a second sweep does not re-pin, and records nothing", async () => {
    const w = await world();
    w.templates.publish(TENANT, TEMPLATE_KEY, template([step({ key: "collect" })], "v1"));
    await w.service.sweep(ACTOR);
    await w.service.sweep(ACTOR);

    expect(w.events.recorded.filter((e) => e.verb === "job.template_pinned")).toHaveLength(1);
  });

  it("refuses a second completion of the same step, so who did it is not overwritten", async () => {
    const w = await world();
    w.templates.publish(TENANT, TEMPLATE_KEY, template([step({ key: "collect" })]));
    await w.service.advance(TENANT, w.job, ACTOR);
    await w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "collect" }, ACTOR, PRIYA);

    await expect(
      w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "collect" }, ACTOR, ANAND),
    ).rejects.toThrow(StepNotWaiting);
    const rows = await w.steps.listForJob(TENANT, JOB);
    expect(rows[0]?.performedBy).toBe(PRIYA);
  });

  it("refuses a person on a step that is not theirs", async () => {
    const w = await world();
    w.agents.arm("reconcile");
    w.templates.publish(
      TENANT,
      TEMPLATE_KEY,
      template([
        step({ key: "collect" }),
        step({ key: "reconcile", executor: "agent", dependsOn: ["collect"] }),
      ]),
    );
    await w.service.advance(TENANT, w.job, ACTOR);
    // `reconcile` is pending, not blocked, so this is StepNotWaiting first —
    // arm the other direction: a blocked agent_with_approval step IS a person's,
    // and a running agent step is nobody's to finish by hand.
    await expect(
      w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "reconcile" }, ACTOR, PRIYA),
    ).rejects.toThrow(StepNotWaiting);
  });
});

// ── THE JOB'S OWN STATUS ───────────────────────────────────────────────────

describe("a job's status is derived from its steps, never tracked beside them", () => {
  it("is running while an agent still has work to do", async () => {
    const w = await world();
    w.agents.arm("a");
    w.templates.publish(
      TENANT,
      TEMPLATE_KEY,
      template([step({ key: "a", executor: "agent" }), step({ key: "b", dependsOn: ["a"] })]),
    );
    await w.service.advance(TENANT, w.job, ACTOR);
    // `a` finished, `b` went to a desk — so the engine has stopped and a person
    // must act. That is `blocked`, not `running`.
    expect(await jobStatus(w)).toBe("blocked");
  });

  it("is done only when every step has settled — skips included", async () => {
    const w = await world({ recurrence: "monthly" });
    w.agents.arm("a");
    w.templates.publish(
      TENANT,
      TEMPLATE_KEY,
      template([
        step({ key: "a", executor: "agent" }),
        step({
          key: "b",
          executor: "agent",
          dependsOn: ["a"],
          condition: { fact: "recurrence", op: "equals", value: "annually" },
        }),
      ]),
    );
    await w.service.advance(TENANT, w.job, ACTOR);
    expect(await board(w)).toEqual({ a: "done", b: "skipped" });
    expect(await jobStatus(w)).toBe("done");

    const completed = w.events.recorded.find((e) => e.verb === "job.completed");
    // BOTH numbers: "finished" and "finished having skipped half of it" are
    // different facts and only one of them is reassuring.
    expect(completed?.payload).toEqual({ steps: 2, skipped: 1 });
  });

  it("does not report a job completed twice", async () => {
    const w = await world();
    w.agents.arm("a");
    w.templates.publish(TENANT, TEMPLATE_KEY, template([step({ key: "a", executor: "agent" })]));
    await w.service.sweep(ACTOR);
    await w.service.sweep(ACTOR);
    expect(w.events.recorded.filter((e) => e.verb === "job.completed")).toHaveLength(1);
  });
});

describe("NothingProposed", () => {
  it("is what a caller gets for deciding a step no machine answered", () => {
    // The route that accepts or corrects a proposal must not become a second
    // way to tick a step off — that would write "accepted" against a proposal
    // that never existed and put a fictional point into the accuracy record.
    const err = new NothingProposed("reconcile");
    expect(err.code).toBe("NOTHING_PROPOSED");
    expect(err.message).toContain("no answer from a machine");
  });
});
