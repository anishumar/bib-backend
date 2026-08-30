// The merge (T2.7) — how many checklists one engagement letter becomes.
//
// Its own file, because it answers a different question from `service.test.ts`.
// That file is about at-least-once: a redelivered trigger must not produce a
// second job. This one is about the firm's own organisation: a client buys
// three services from one delivery team and gets ONE checklist rather than
// three, and — the half that matters more — two of its companies buying the
// same service never share one, because each company files its own returns.
//
// Asserted against the firm's own numbers rather than invented ones. FRC/TRC
// are its Depts, FINCOMPLIANCE/PAYROLL its delivery teams, and FinCompliance
// genuinely delivers under both Depts — which is exactly what makes the two
// axes cut the same three services differently, and why the firm has to choose.
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import {
  FakeActivationFeed,
  FakeJobRepo,
  FakeTenantDirectory,
  FakeWorkItemSpawner,
  FakeWorkSplit,
} from "../../src/testfakes/scheduler";
import { SchedulerService, groupActivations } from "../../src/usecase/scheduler/service";
import type { Activation } from "../../src/usecase/scheduler/ports";

const FIRM = "00000000-0000-4000-8000-0000000000a1";
const LETTER_1 = "00000000-0000-4000-8000-0000000000b1";
const LETTER_2 = "00000000-0000-4000-8000-0000000000b2";
const ENTITY_1 = "00000000-0000-4000-8000-0000000000c1";
const ENTITY_2 = "00000000-0000-4000-8000-0000000000c2";
const GST = "00000000-0000-4000-8000-0000000000e1";
const TDS = "00000000-0000-4000-8000-0000000000e2";
const PAYROLL = "00000000-0000-4000-8000-0000000000e3";
const NOW = "2026-08-29T09:00:00.000Z";

/**
 * An activation with the grouping facts filled in.
 *
 * The defaults are one letter, one entity, nothing filed and no process — the
 * state a firm that has never touched `/admin/structure` is in. A test about
 * the merge says what it is about by overriding.
 */
function activation(
  engagementId: string,
  occurredAt: string,
  over: Partial<Activation> = {},
): Activation {
  return {
    engagementId,
    occurredAt,
    engagementLetterId: LETTER_1,
    entityPartyId: ENTITY_1,
    deptCode: null,
    teamCode: null,
    workflowKey: null,
    ...over,
  };
}

/** The engagements in one job, through the port BOTH the fake and the adapter
 *  implement — `describeJobs`, which is also what the work board reads. A test
 *  helper on the fake alone would be a method the real repository does not
 *  have, and the whole point of `implements` here is that it cannot drift. */
async function engagementsIn(jobs: FakeJobRepo, jobId: string): Promise<string[]> {
  const detail = await jobs.describeJobs(FIRM, [jobId]);
  return (detail.get(jobId)?.services ?? []).map((s) => s.engagementId);
}

function engine() {
  const jobs = new FakeJobRepo();
  const activations = new FakeActivationFeed();
  activations.jobs = jobs; // the anti-join, as the real query does it
  const events = new RecordingEventSink();
  const split = new FakeWorkSplit();
  const workItems = new FakeWorkItemSpawner();
  const service = new SchedulerService({
    jobs,
    activations,
    tenants: new FakeTenantDirectory([FIRM]),
    splitAxis: split,
    // T3.1's seam. Recorded rather than performed: what the work-item service
    // does with these engagements is `tests/workitem/`'s business, and what
    // matters HERE is that a second sweep hands over nothing.
    workItems,
    ids: new FakeIds(),
    clock: new FakeClock(new Date(NOW)),
    events,
  });
  return { service, jobs, activations, events, split, workItems };
}

/** The firm's own three-service letter: GST and TDS delivered by FinCompliance,
 *  payroll by Payroll — and GST and payroll both booked to FRC while TDS is
 *  TRC. One letter, one entity, one process named by all three. */
function threeServices(activations: FakeActivationFeed): void {
  activations.add(
    FIRM,
    activation(GST, "2026-08-28T10:00:00.000Z", {
      deptCode: "FRC",
      teamCode: "FINCOMPLIANCE",
      workflowKey: "monthly-filing",
    }),
  );
  activations.add(
    FIRM,
    activation(TDS, "2026-08-28T11:00:00.000Z", {
      deptCode: "TRC",
      teamCode: "FINCOMPLIANCE",
      workflowKey: "monthly-filing",
    }),
  );
  activations.add(
    FIRM,
    activation(PAYROLL, "2026-08-28T12:00:00.000Z", {
      deptCode: "FRC",
      teamCode: "PAYROLL",
      workflowKey: "monthly-filing",
    }),
  );
}

describe("how many checklists one letter becomes", () => {
  it("`none` merges nothing — three lines, three jobs, exactly as before", async () => {
    const { service, jobs, activations } = engine();
    threeServices(activations);

    const [report] = await service.sweepActivations();
    expect(report).toMatchObject({ spawned: 3, extended: 0, alreadySpawned: 0 });
    expect(jobs.rows).toHaveLength(3);
    // The old shape all the way down: the engagement's own id as the cause, so
    // nothing changed for a firm that has not chosen an axis. This is the test
    // that would have caught `groupByAxis`'s `none` returning one bucket for
    // everything, which would have merged all three.
    expect(jobs.rows.map((j) => j.sourceKind)).toEqual([
      "engagement",
      "engagement",
      "engagement",
    ]);
    expect([...jobs.rows.map((j) => j.sourceRef)].sort()).toEqual([GST, TDS, PAYROLL].sort());
    expect(jobs.rows.every((j) => j.splitAxis === "none" && j.splitCode === null)).toBe(true);
  });

  it("by team: the two FinCompliance services share a checklist, payroll gets its own", async () => {
    const { service, jobs, activations, split } = engine();
    split.axis = "team";
    threeServices(activations);

    const [report] = await service.sweepActivations();
    expect(report).toMatchObject({ spawned: 2, extended: 0 });
    expect(jobs.rows).toHaveLength(2);
    expect(jobs.rows.map((j) => j.splitCode)).toEqual(["FINCOMPLIANCE", "PAYROLL"]);
    expect(jobs.rows.every((j) => j.sourceKind === "engagement_group")).toBe(true);

    expect(await engagementsIn(jobs, jobs.rows[0]?.id ?? "")).toEqual([GST, TDS]);
    expect(await engagementsIn(jobs, jobs.rows[1]?.id ?? "")).toEqual([PAYROLL]);
  });

  it("by Dept: the SAME three services cut differently — which is why the firm chooses", async () => {
    const { service, jobs, activations, split } = engine();
    split.axis = "dept";
    threeServices(activations);

    await service.sweepActivations();
    expect(jobs.rows.map((j) => j.splitCode)).toEqual(["FRC", "TRC"]);
    // GST and payroll are one job under FRC even though different teams deliver
    // them — the two axes are not a hierarchy, and this is what that means.
    expect(await engagementsIn(jobs, jobs.rows[0]?.id ?? "")).toEqual([GST, PAYROLL]);
  });

  it("services the firm has filed under nothing group together, and are never dropped", async () => {
    const { service, jobs, activations, split } = engine();
    split.axis = "team";
    activations.add(FIRM, activation(GST, "2026-08-28T10:00:00.000Z", { teamCode: null }));
    activations.add(FIRM, activation(TDS, "2026-08-28T11:00:00.000Z", { teamCode: null }));

    await service.sweepActivations();
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]?.splitCode).toBeNull();
    expect(await engagementsIn(jobs, jobs.rows[0]?.id ?? "")).toHaveLength(2);
  });

  it("produces the same jobs in the same order on every run", () => {
    // A sweep whose output depends on a hash order is one nobody can reproduce
    // a complaint against. First-seen order, all the way through.
    const feed = new FakeActivationFeed();
    threeServices(feed);
    const items = [...(feed.byTenant.get(FIRM) ?? [])];
    const once = groupActivations(items, "team").map((g) => g.splitCode);
    const twice = groupActivations(items, "team").map((g) => g.splitCode);
    expect(once).toEqual(["FINCOMPLIANCE", "PAYROLL"]);
    expect(twice).toEqual(once);
  });
});

describe("what may never be merged", () => {
  // THE CLIENT'S OWN RULE, and the reason `entity_party_id` is in the key. vCFO
  // for four companies is four engagements because each company files its own
  // returns, under its own registrations, on its own dates. One checklist
  // across two of them would be two companies' filings in one place.
  //
  // The firm says three sub-companies get three separate letters, so within one
  // letter the entity is normally constant and this key part looks redundant.
  // It is not: `engagement_letter_line.entity_party_id` is per LINE and NOT
  // NULL (0018), so the schema permits a mixed letter whatever the practice is,
  // and this is what makes the rule hold rather than the practice holding it.
  it("two of a client's companies never share a checklist, same team or not", async () => {
    const { service, jobs, activations, split } = engine();
    split.axis = "team";
    activations.add(
      FIRM,
      activation(GST, "2026-08-28T10:00:00.000Z", {
        teamCode: "FINCOMPLIANCE",
        entityPartyId: ENTITY_1,
      }),
    );
    activations.add(
      FIRM,
      activation(TDS, "2026-08-28T11:00:00.000Z", {
        teamCode: "FINCOMPLIANCE",
        entityPartyId: ENTITY_2,
      }),
    );

    await service.sweepActivations();
    expect(jobs.rows).toHaveLength(2);
  });

  // A job has to be able to FINISH. Two contracts signed months apart are two
  // pieces of delivery; letting the second join the first's open checklist
  // would grow one job for the life of the client relationship.
  it("two letters are two checklists, even for one entity and one team", async () => {
    const { service, jobs, activations, split } = engine();
    split.axis = "team";
    activations.add(
      FIRM,
      activation(GST, "2026-08-28T10:00:00.000Z", {
        teamCode: "FINCOMPLIANCE",
        engagementLetterId: LETTER_1,
      }),
    );
    activations.add(
      FIRM,
      activation(TDS, "2026-08-28T11:00:00.000Z", {
        teamCode: "FINCOMPLIANCE",
        engagementLetterId: LETTER_2,
      }),
    );

    await service.sweepActivations();
    expect(jobs.rows).toHaveLength(2);
  });

  // If the firm wrote one process for GST and a different one for TDS, it has
  // said they are two processes. Merging them would invent an order between
  // them that nobody wrote, over step keys that can collide.
  it("two different processes are two checklists, even on one team", async () => {
    const { service, jobs, activations, split } = engine();
    split.axis = "team";
    activations.add(
      FIRM,
      activation(GST, "2026-08-28T10:00:00.000Z", {
        teamCode: "FINCOMPLIANCE",
        workflowKey: "gst-filing",
      }),
    );
    activations.add(
      FIRM,
      activation(TDS, "2026-08-28T11:00:00.000Z", {
        teamCode: "FINCOMPLIANCE",
        workflowKey: "tds-return",
      }),
    );

    await service.sweepActivations();
    expect(jobs.rows).toHaveLength(2);
  });

  // And the common case is still one job: services on one team usually name one
  // process, or none at all. If this ever failed, the workflow key would be
  // splitting work the firm expects together.
  it("but services naming NO process still merge — most firms start here", async () => {
    const { service, jobs, activations, split } = engine();
    split.axis = "team";
    activations.add(
      FIRM,
      activation(GST, "2026-08-28T10:00:00.000Z", {
        teamCode: "FINCOMPLIANCE",
        workflowKey: null,
      }),
    );
    activations.add(
      FIRM,
      activation(TDS, "2026-08-28T11:00:00.000Z", {
        teamCode: "FINCOMPLIANCE",
        workflowKey: null,
      }),
    );

    await service.sweepActivations();
    expect(jobs.rows).toHaveLength(1);
  });
});

describe("work that arrives after the checklist already exists", () => {
  it("joins the open job and says so, rather than starting a second one", async () => {
    const { service, jobs, activations, events, split } = engine();
    split.axis = "team";
    activations.add(
      FIRM,
      activation(GST, "2026-08-28T10:00:00.000Z", { teamCode: "FINCOMPLIANCE" }),
    );
    await service.sweepActivations();
    expect(jobs.rows).toHaveLength(1);
    const jobId = jobs.rows[0]?.id ?? "";

    // A week later, the second line's advance lands.
    activations.add(
      FIRM,
      activation(TDS, "2026-09-04T10:00:00.000Z", { teamCode: "FINCOMPLIANCE" }),
    );
    const [report] = await service.sweepActivations();

    expect(report).toMatchObject({ spawned: 0, extended: 1, alreadySpawned: 0 });
    expect(jobs.rows).toHaveLength(1);
    expect(await engagementsIn(jobs, jobId)).toEqual([GST, TDS]);
    expect(events.verbs()).toEqual(["job.spawned", "job.scope_extended"]);
    // Only the engagement that actually joined — not the whole job's contents,
    // which would read as if both services arrived on the 4th.
    expect(events.recorded[1]?.payload).toMatchObject({ engagementIds: [TDS] });
  });

  it("gets its OWN job when the group's checklist has already finished", async () => {
    const { service, jobs, activations, split } = engine();
    split.axis = "team";
    activations.add(
      FIRM,
      activation(GST, "2026-08-28T10:00:00.000Z", { teamCode: "FINCOMPLIANCE" }),
    );
    await service.sweepActivations();
    const first = jobs.rows[0]?.id ?? "";
    await service.transition(FIRM, first, "running");
    await service.transition(FIRM, first, "done");

    activations.add(
      FIRM,
      activation(TDS, "2026-10-04T10:00:00.000Z", { teamCode: "FINCOMPLIANCE" }),
    );
    const [report] = await service.sweepActivations();

    // Attaching new work to a finished checklist means work nobody looks at
    // again. The partial unique index — open jobs only — is what makes a second
    // job for the same group legal, and this is the case it exists for.
    expect(report).toMatchObject({ spawned: 1, extended: 0 });
    expect(jobs.rows).toHaveLength(2);
    expect(jobs.rows[1]?.sourceRef).toBe(jobs.rows[0]?.sourceRef);
  });

  it("a redelivered sweep changes nothing at all", async () => {
    const { service, jobs, activations, events, split } = engine();
    split.axis = "team";
    threeServices(activations);
    await service.sweepActivations();
    const before = events.verbs().length;

    const [report] = await service.sweepActivations();
    expect(report).toMatchObject({ spawned: 0, extended: 0, alreadySpawned: 0 });
    expect(jobs.rows).toHaveLength(2);
    expect(events.verbs()).toHaveLength(before);
  });

  it("one engagement is in one job, whatever a caller asks for", async () => {
    // The absolute rule, straight at the port: a second job asking for the same
    // engagement gets nothing. This is what stops two checklists, two sets of
    // tasks and eventually two invoices for one piece of work.
    const { jobs } = engine();
    const base = {
      tenantId: FIRM,
      sourceKind: "engagement_group" as const,
      runnableAt: NOW,
      splitAxis: "team" as const,
      splitCode: "FINCOMPLIANCE",
    };
    const a = await jobs.createIfAbsent({
      ...base,
      id: "00000000-0000-4000-8000-00000000f001",
      sourceRef: "00000000-0000-4000-8000-00000000f0a1",
    });
    const b = await jobs.createIfAbsent({
      ...base,
      id: "00000000-0000-4000-8000-00000000f002",
      sourceRef: "00000000-0000-4000-8000-00000000f0a2",
    });

    expect(await jobs.linkEngagements(FIRM, a.job.id, [GST])).toEqual([GST]);
    expect(await jobs.linkEngagements(FIRM, b.job.id, [GST])).toEqual([]);
    expect(await engagementsIn(jobs, b.job.id)).toEqual([]);
  });
});
