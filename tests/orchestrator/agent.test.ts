// The guardrail (T2.8) — what a machine is allowed to do with what it produced.
//
// Its own file, because it answers a different question from `walk.test.ts`.
// That file is about the GRAPH: which step is ready, what a skip clears, when a
// job is done. This one is about PERMISSION, and it is worth keeping separate
// for the reason the task exists at all — there are no agents yet, so every
// assertion here is about a rule holding before there is anything to hold it
// against. That is the only order in which such a rule gets written honestly.
//
// The acceptance the board states: a fake executor commits above 0.95, queues
// between 0.70 and 0.95, and escalates below 0.70.
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { FakeJobRepo } from "../../src/testfakes/scheduler";
import {
  FakeAgentRunRepo,
  FakeAgentRuntime,
  FakeJobStepRepo,
  FakeJobSubjectSource,
  FakeTemplateSource,
  FakeTierSource,
} from "../../src/testfakes/orchestrator";
import { OrchestratorService } from "../../src/usecase/orchestrator/service";
import {
  ASK_A_PERSON,
  SUGGESTED_TIERS,
  decide,
  decideFor,
  tiersAreCoherent,
} from "../../src/domain/agent/model";
import {
  CorrectionChangedNothing,
  NothingProposed,
  ProposalUndecided,
} from "../../src/domain/orchestrator/errors";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const JOB = "00000000-0000-4000-8000-0000000000d1";
const PERSON = "00000000-0000-4000-8000-0000000000c1";
const TEMPLATE_KEY = "monthly-filing";
const VERSION = "00000000-0000-4000-8000-0000000000f1";
const NOW = "2026-08-29T09:00:00.000Z";
const ACTOR = { type: "human" as const, id: PERSON };

// ── The pure rule, on its own ───────────────────────────────────────────────

describe("the rule, before anything runs on it", () => {
  it("is the board's acceptance, in three numbers", () => {
    expect(decide(0.96, SUGGESTED_TIERS)).toBe("committed");
    expect(decide(0.8, SUGGESTED_TIERS)).toBe("queued");
    expect(decide(0.5, SUGGESTED_TIERS)).toBe("escalated");
  });

  it("commits only STRICTLY above the bar, which is what makes 1.0 an off switch", () => {
    // A firm that has an agent get something wrong on a Monday morning wants one
    // edit that stops every unattended commit. `>=` would leave no value meaning
    // "never", and this is the test that would go red if somebody relaxed it.
    expect(decide(0.95, SUGGESTED_TIERS)).toBe("queued");
    expect(decide(1, { autoCommitAt: 1, reviewAt: 0 })).toBe("queued");
  });

  it("with nothing published, nothing commits and nothing is thrown away", () => {
    // The product's real starting state. Not a default somebody chose: a firm
    // that has never set thresholds has not decided a machine may act alone.
    expect(decide(1, ASK_A_PERSON)).toBe("queued");
    expect(decide(0, ASK_A_PERSON)).toBe("queued");
  });

  // THE FIRM'S OWN INSTRUCTION OUTRANKS THE NUMBERS. This is why the thresholds
  // are not the load-bearing decision: the real control is per step, on the
  // template, chosen by whoever knows what the step does.
  it("`agent_with_approval` never commits, however sure the machine is", () => {
    expect(decideFor(0.99, SUGGESTED_TIERS, true)).toBe("queued");
    expect(decideFor(0.99, SUGGESTED_TIERS, false)).toBe("committed");
  });

  it("downgrades a commit to a queue, and never upgrades an escalation", () => {
    // "The machine was not sure enough to propose" is a different message to a
    // person than "check this over". Flattening them would put a guess in front
    // of somebody as a draft.
    expect(decideFor(0.4, SUGGESTED_TIERS, true)).toBe("escalated");
  });

  it("refuses a review bar above the commit bar, and allows them equal", () => {
    expect(tiersAreCoherent({ autoCommitAt: 0.7, reviewAt: 0.95 })).toBe(false);
    // Equal collapses the middle band: commit or escalate, nothing proposed. A
    // firm might genuinely want that.
    expect(tiersAreCoherent({ autoCommitAt: 0.8, reviewAt: 0.8 })).toBe(true);
  });
});

// ── The rule, wired into the engine ─────────────────────────────────────────

function template(executor: string) {
  return {
    versionId: VERSION,
    label: "Monthly filing",
    steps: [{ key: "reconcile", label: "Reconcile", executor, dependsOn: [], condition: null }],
  };
}

async function world(executor = "agent") {
  const jobs = new FakeJobRepo();
  const steps = new FakeJobStepRepo();
  const templates = new FakeTemplateSource();
  const subjects = new FakeJobSubjectSource();
  const agents = new FakeAgentRuntime();
  const tiers = new FakeTierSource();
  const runs = new FakeAgentRunRepo();
  const events = new RecordingEventSink();

  const created = await jobs.createIfAbsent({
    id: JOB,
    tenantId: TENANT,
    sourceKind: "engagement",
    sourceRef: "00000000-0000-4000-8000-0000000000e1",
    runnableAt: NOW,
    splitAxis: "none",
    splitCode: null,
  });
  templates.publish(TENANT, TEMPLATE_KEY, template(executor));
  subjects.set(JOB, {
    workflowTemplateKey: TEMPLATE_KEY,
    recurrence: "monthly",
    jurisdiction: "IN",
  });

  const service = new OrchestratorService({
    jobs,
    steps,
    templates,
    subjects,
    tiers,
    runs,
    agents,
    tenants: { activeTenantIds: () => Promise.resolve([TENANT]) },
    ids: new FakeIds(),
    clock: new FakeClock(new Date(NOW)),
    events,
  });
  return { service, jobs, steps, agents, tiers, runs, events, job: created.job };
}

async function statusOf(w: Awaited<ReturnType<typeof world>>): Promise<string | undefined> {
  const rows = await w.steps.listForJob(TENANT, JOB);
  return rows[0]?.status;
}

describe("what the engine does with what a machine produced", () => {
  it("commits above the bar — done, with nobody asked", async () => {
    const w = await world();
    w.tiers.publish(SUGGESTED_TIERS);
    w.agents.armWith("reconcile", 0.96, { total: "1200.00" });

    await w.service.advance(TENANT, w.job, ACTOR);

    expect(await statusOf(w)).toBe("done");
    expect(w.runs.rows[0]).toMatchObject({ decision: "committed", confidence: 0.96 });
    // A commit applies its own proposal, at the same moment, by nobody. There is
    // no decider because that is what unattended means.
    expect(w.runs.rows[0]?.applied).toEqual({ total: "1200.00" });
    expect(w.runs.rows[0]?.decidedBy).toBeNull();
    expect(w.events.verbs()).toContain("agent_run.completed");
  });

  it("queues in the middle band — blocked, with the answer kept", async () => {
    const w = await world();
    w.tiers.publish(SUGGESTED_TIERS);
    w.agents.armWith("reconcile", 0.8, { total: "1200.00" });

    await w.service.advance(TENANT, w.job, ACTOR);

    expect(await statusOf(w)).toBe("blocked");
    expect(w.runs.rows[0]).toMatchObject({ decision: "queued" });
    // Nothing applied until a person says so — and the proposal survives, which
    // is the whole difference between this and "commit or don't".
    expect(w.runs.rows[0]?.applied).toBeNull();
    expect(w.runs.rows[0]?.proposed).toEqual({ total: "1200.00" });
  });

  it("escalates below the bar — blocked, and recorded as its own thing", async () => {
    const w = await world();
    w.tiers.publish(SUGGESTED_TIERS);
    w.agents.armWith("reconcile", 0.5, { total: "1200.00" });

    await w.service.advance(TENANT, w.job, ACTOR);

    expect(await statusOf(w)).toBe("blocked");
    expect(w.runs.rows[0]).toMatchObject({ decision: "escalated" });
    // Its own verb, because "the machine was not sure enough to propose" is a
    // different fact from "here is a draft, check it".
    expect(w.events.verbs()).toContain("agent_run.escalated");
  });

  // THE SAFETY PROPERTY THAT MADE THIS SAFE TO SHIP. Nothing was seeded, so on
  // the day T2.8 landed every firm was in exactly this state.
  it("commits NOTHING when the firm has published no thresholds", async () => {
    const w = await world();
    w.agents.armWith("reconcile", 1, { total: "1200.00" });

    await w.service.advance(TENANT, w.job, ACTOR);

    expect(await statusOf(w)).toBe("blocked");
    expect(w.runs.rows[0]).toMatchObject({ decision: "queued", tierVersionId: null });
    // Stored as (1, 0) — "never commit, always ask" in the same two numbers, so
    // nothing downstream needs a special case for an absent tier.
    expect(w.runs.rows[0]).toMatchObject({ autoCommitAt: 1, reviewAt: 0 });
  });

  // THE GAP T2.8 CLOSED. `waitsForAPerson` returns true for this executor, so
  // the orchestrator used to block it before `agents.run` was ever reached: the
  // machine produced nothing and the person had nothing to approve.
  it("`agent_with_approval` RUNS the agent and then waits, at any confidence", async () => {
    const w = await world("agent_with_approval");
    w.tiers.publish(SUGGESTED_TIERS);
    w.agents.armWith("reconcile", 0.99, { total: "1200.00" });

    await w.service.advance(TENANT, w.job, ACTOR);

    expect(w.agents.ran).toEqual(["reconcile"]);
    expect(await statusOf(w)).toBe("blocked");
    expect(w.runs.rows[0]).toMatchObject({ decision: "queued", approvalRequired: true });
  });

  it("records the model and the prompt version, so a regression has something to blame", async () => {
    const w = await world();
    w.tiers.publish(SUGGESTED_TIERS);
    w.agents.model = "haiku-4.5";
    w.agents.promptVersion = "reconcile-v3";
    w.agents.armWith("reconcile", 0.96);

    await w.service.advance(TENANT, w.job, ACTOR);
    expect(w.runs.rows[0]).toMatchObject({ model: "haiku-4.5", promptVersion: "reconcile-v3" });
  });

  it("records NO run when the agent failed — it produced nothing to record", async () => {
    const w = await world();
    w.tiers.publish(SUGGESTED_TIERS);
    w.agents.armFailing("reconcile", "the portal did not respond");

    await w.service.advance(TENANT, w.job, ACTOR);

    expect(await statusOf(w)).toBe("failed");
    // A row with an invented proposal would put a fabricated answer into the
    // accuracy record.
    expect(w.runs.rows).toHaveLength(0);
  });

  it("keeps the CONFIDENCE out of nothing and the PROPOSAL out of the ledger", async () => {
    // The payload carries machine facts; the values can hold a client's own
    // data and this log cannot be erased.
    const w = await world();
    w.tiers.publish(SUGGESTED_TIERS);
    w.agents.armWith("reconcile", 0.8, { pan: "AAAPZ1234C" });

    await w.service.advance(TENANT, w.job, ACTOR);
    const event = w.events.recorded.find((e) => e.verb === "agent_run.completed");
    expect(event?.payload).toMatchObject({ confidence: 0.8, decision: "queued" });
    expect(JSON.stringify(event?.payload)).not.toContain("AAAPZ1234C");
  });
});

describe("what a person does with a proposal", () => {
  async function queued() {
    const w = await world();
    w.tiers.publish(SUGGESTED_TIERS);
    w.agents.armWith("reconcile", 0.8, { total: "1200.00" });
    await w.service.advance(TENANT, w.job, ACTOR);
    return w;
  }

  it("accepting applies the proposal itself and finishes the step", async () => {
    const w = await queued();
    await w.service.decideProposal(
      {
        tenantId: TENANT,
        jobId: JOB,
        stepKey: "reconcile",
        outcome: "accepted",
        applied: null,
        rejectedReason: null,
      },
      ACTOR,
      PERSON,
    );

    expect(await statusOf(w)).toBe("done");
    expect(w.runs.rows[0]).toMatchObject({ outcome: "accepted", decidedBy: PERSON });
    // Taken from the RUN, not from the caller — so "accepted" cannot quietly
    // carry a different value than the one proposed.
    expect(w.runs.rows[0]?.applied).toEqual({ total: "1200.00" });
  });

  it("correcting keeps BOTH values — which is the entire accuracy signal", async () => {
    const w = await queued();
    await w.service.decideProposal(
      {
        tenantId: TENANT,
        jobId: JOB,
        stepKey: "reconcile",
        outcome: "corrected",
        applied: { total: "1350.00" },
        rejectedReason: null,
      },
      ACTOR,
      PERSON,
    );

    expect(await statusOf(w)).toBe("done");
    expect(w.runs.rows[0]?.proposed).toEqual({ total: "1200.00" });
    expect(w.runs.rows[0]?.applied).toEqual({ total: "1350.00" });
  });

  it("refuses a `corrected` that changed nothing", async () => {
    // An acceptance somebody mis-clicked. Counting it as a correction
    // understates the agent, and a number nobody can trust is worse than none.
    const w = await queued();
    await expect(
      w.service.decideProposal(
        {
          tenantId: TENANT,
          jobId: JOB,
          stepKey: "reconcile",
          outcome: "corrected",
          applied: { total: "1200.00" },
          rejectedReason: null,
        },
        ACTOR,
        PERSON,
      ),
      // Refused in WORDS by the service, and by a CHECK underneath it. The
      // second is the wall; the first is what a person actually reads, and it
      // was answering "internal error" until somebody clicked it.
    ).rejects.toBeInstanceOf(CorrectionChangedNothing);
  });

  it("rejecting keeps the step WAITING — throwing an answer away is not doing the work", async () => {
    const w = await queued();
    await w.service.decideProposal(
      {
        tenantId: TENANT,
        jobId: JOB,
        stepKey: "reconcile",
        outcome: "rejected",
        applied: null,
        rejectedReason: "it read last quarter's ledger",
      },
      ACTOR,
      PERSON,
    );

    expect(await statusOf(w)).toBe("blocked");
    expect(w.runs.rows[0]).toMatchObject({
      outcome: "rejected",
      rejectedReason: "it read last quarter's ledger",
    });
    expect(w.runs.rows[0]?.applied).toBeNull();
  });

  it("refuses a SECOND decision — the first person's verdict stands", async () => {
    const w = await queued();
    const decision = {
      tenantId: TENANT,
      jobId: JOB,
      stepKey: "reconcile",
      outcome: "accepted" as const,
      applied: null,
      rejectedReason: null,
    };
    await w.service.decideProposal(decision, ACTOR, PERSON);
    // The step is done now, so the second caller is refused before it can reach
    // the run at all — which is the same answer by a shorter route.
    await expect(w.service.decideProposal(decision, ACTOR, PERSON)).rejects.toThrow();
  });

  it("refuses the plain Done button while a proposal is undecided", async () => {
    // Ticking "done" would record that a PERSON did the work and leave what the
    // machine said undecided forever — losing the one number that could ever
    // justify moving a threshold.
    const w = await queued();
    await expect(
      w.service.completeStep({ tenantId: TENANT, jobId: JOB, stepKey: "reconcile" }, ACTOR, PERSON),
    ).rejects.toBeInstanceOf(ProposalUndecided);
  });

  it("refuses a decision on a step no machine answered", async () => {
    // Otherwise the decision route becomes a second way to tick a step off, and
    // writes "accepted" against a proposal that never existed.
    const w = await world("human");
    await w.service.advance(TENANT, w.job, ACTOR);
    await expect(
      w.service.decideProposal(
        {
          tenantId: TENANT,
          jobId: JOB,
          stepKey: "reconcile",
          outcome: "accepted",
          applied: null,
          rejectedReason: null,
        },
        ACTOR,
        PERSON,
      ),
    ).rejects.toBeInstanceOf(NothingProposed);
  });

  it("records WHICH of the three, and never the values", async () => {
    const w = await queued();
    await w.service.decideProposal(
      {
        tenantId: TENANT,
        jobId: JOB,
        stepKey: "reconcile",
        outcome: "corrected",
        applied: { pan: "AAAPZ1234C" },
        rejectedReason: null,
      },
      ACTOR,
      PERSON,
    );
    const event = w.events.recorded.find((e) => e.verb === "agent_run.decided");
    expect(event?.payload).toMatchObject({ outcome: "corrected" });
    expect(JSON.stringify(event?.payload)).not.toContain("AAAPZ1234C");
  });
});
