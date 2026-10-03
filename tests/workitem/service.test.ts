// The work-item use case (T3.1), against in-memory fakes and a fixed clock.
//
// The acceptance line is the first block: *a filing arrives pre-assigned to the
// client's Dept SPOC*. Everything after it is the machinery that makes the line
// mean something a year later — the block reason, the maker who cannot be the
// checker, and the idempotency the spawn path rests on.
import { beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import {
  FakeEngagementWork,
  FakeLetterWork,
  FakeObligationCoverage,
  FakeObligationFiling,
  FakeReviewPermissions,
  FakeReviewPolicies,
  FakeReviewers,
  FakeJobStepHandover,
  FakeSpocDirectory,
  FakeWorkAxes,
  FakeWorkItemApprovalRepo,
  FakeWorkItemClients,
  FakeWorkItemRepo,
  FakeWorkItemStaff,
  FakeWorkOwnerDirectory,
  FakeWorkVocabularyRepo,
} from "../../src/testfakes/workitem";
import { WorkItemService, WorkVocabularyService } from "../../src/usecase/workitem/service";
import { WorkItemError } from "../../src/domain/workitem/errors";

const FIRM = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-09-10T04:11:00.000Z";
const ACTOR = { type: "human", id: "00000000-0000-4000-8000-0000000000aa" } as const;

const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const ENTITY = "00000000-0000-4000-8000-0000000000e1";
const ENGAGEMENT = "00000000-0000-4000-8000-0000000000f1";
const ENGAGEMENT_2 = "00000000-0000-4000-8000-0000000000f2";
const JOB = "00000000-0000-4000-8000-0000000000j1".replace("j", "b");
const FRC = "00000000-0000-4000-8000-0000000000a1";
const PRIYA = "00000000-0000-4000-8000-0000000000d1";
const ANAND = "00000000-0000-4000-8000-0000000000d2";
const RAVI = "00000000-0000-4000-8000-0000000000d3";

async function harness() {
  const vocabulary = new FakeWorkVocabularyRepo();
  const items = new FakeWorkItemRepo();
  const approvals = new FakeWorkItemApprovalRepo();
  items.vocabulary = vocabulary;
  items.approvals = approvals;
  approvals.items = items;

  const clients = new FakeWorkItemClients();
  const staff = new FakeWorkItemStaff();
  const spocs = new FakeSpocDirectory();
  const owners = new FakeWorkOwnerDirectory();
  const jobSteps = new FakeJobStepHandover();
  const timeZones = new FakeFirmTimeZone();
  const axes = new FakeWorkAxes();
  const policies = new FakeReviewPolicies();
  const reviewers = new FakeReviewers();
  const permissions = new FakeReviewPermissions();
  const engagements = new FakeEngagementWork();
  const letters = new FakeLetterWork();
  const obligations = new FakeObligationCoverage();
  const filings = new FakeObligationFiling();
  const events = new RecordingEventSink();
  const clock = new FakeClock(new Date(NOW));
  const ids = new FakeIds();

  // The REAL vocabulary service over the in-memory store, seeded the way
  // `createTenant` seeds a firm — not a stub. A work-item test then fails if
  // the seed ever stops producing a usable starting state, which is the thing
  // that would leave the firm unable to create anything at all.
  const vocab = new WorkVocabularyService({ vocabulary, ids, events });
  await vocab.seedDefaultVocabulary(FIRM, ACTOR);

  const service = new WorkItemService({
    items,
    approvals,
    vocabulary,
    clients,
    staff,
    spocs,
    owners,
    jobSteps,
    timeZones,
    axes,
    policies,
    reviewers,
    permissions,
    engagements,
    letters,
    obligations,
    filings,
    ids,
    clock,
    events,
  });

  clients.add(CLIENT, "Kaveri Foods Group");
  clients.add(ENTITY, "Kaveri Foods Pvt Ltd");
  axes.add(FRC, "FRC", "Financial Reporting & Compliance");
  items.clients.set(CLIENT, "Kaveri Foods Group");
  items.clients.set(ENTITY, "Kaveri Foods Pvt Ltd");
  for (const [id, name] of [
    [PRIYA, "Priya"],
    [ANAND, "Anand"],
    [RAVI, "Ravi"],
  ] as const) {
    staff.active.add(id);
    items.people.set(id, { email: `${name.toLowerCase()}@10x.test`, displayName: name });
  }
  // Everything the SEED recorded is behind us; the tests assert on what THEY
  // caused. `RecordingEventSink` has no reset, so the baseline is a slice.
  const baseline = events.recorded.length;

  return {
    /** Verbs recorded since the harness was built. */
    verbs: (): readonly string[] => events.verbs().slice(baseline),
    /** The events themselves, same window. */
    recorded: () => events.recorded.slice(baseline),
    service,
    vocab,
    vocabulary,
    items,
    approvals,
    spocs,
    owners,
    jobSteps,
    timeZones,
    clock,
    axes,
    policies,
    reviewers,
    permissions,
    engagements,
    letters,
    obligations,
    filings,
    events,
    staff,
    clients,
  };
}

/** The engagement the sweep hands over: FRC work for one of the group's
 *  companies, with a 30-day SLA and a start date the firm actually recorded. */
function engagementWork(over: Partial<Parameters<FakeEngagementWork["rows"]["push"]>[0]> = {}) {
  return {
    engagementId: ENGAGEMENT,
    clientPartyId: CLIENT,
    entityPartyId: ENTITY,
    effectiveFrom: "2026-09-01",
    serviceVersionId: "00000000-0000-4000-8000-0000000000v1",
    serviceName: "GST monthly filing",
    slaDays: 30,
    deptCode: "FRC",
    ...over,
  };
}

async function stateNamed(h: Awaited<ReturnType<typeof harness>>, code: string) {
  const s = await h.vocabulary.findStateByCode(FIRM, code);
  if (!s) throw new Error(`the seed did not produce a "${code}" state`);
  return s;
}

describe("THE ACCEPTANCE LINE — a filing arrives pre-assigned to the client's Dept SPOC", () => {
  it("puts it on the SPOC's desk, dated from the engagement's own start date", async () => {
    const h = await harness();
    h.spocs.add(CLIENT, FRC, { userId: PRIYA, displayName: "Priya", email: "priya@10x.test" });
    h.engagements.rows.push(engagementWork());

    const created = await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR);

    expect(created).toBe(1);
    const [row] = h.items.rows;
    expect(row).toMatchObject({
      clientPartyId: CLIENT,
      entityPartyId: ENTITY,
      engagementId: ENGAGEMENT,
      jobId: JOB,
      deptAxisId: FRC,
      title: "GST monthly filing",
      assigneeUserId: PRIYA,
      assignmentNote: null,
      // 2026-09-01 + 30 days. The firm's own rule — "task is due from signing
      // of EL", "SLA is per service" — and the date is the engagement's
      // calendar-native `effective_from`, never an instant.
      dueOn: "2026-10-01",
      // SNAPSHOTTED. G2.3's whole argument: a later catalogue revision must not
      // make finished work retroactively late.
      slaDaysSnapshot: 30,
    });
  });

  it("records BOTH facts — that work exists, and that the router placed it", async () => {
    const h = await harness();
    h.spocs.add(CLIENT, FRC, { userId: PRIYA, displayName: "Priya", email: "priya@10x.test" });
    h.engagements.rows.push(engagementWork());

    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR);

    expect(h.verbs()).toEqual(["work_item.created", "work_item.assigned"]);
    // `how: "spoc"` is the fact worth keeping: "the router did this" and "a
    // partner overrode it" are different answers to the same later question,
    // and nothing else in the row distinguishes them.
    expect(h.recorded().at(-1)?.payload).toMatchObject({ how: "spoc", userId: PRIYA });
  });

  it("takes turns between two SPOCs on the same Dept", async () => {
    // G3.2 allows more than one per Dept. Since 2026-09-25 the router shares
    // the work between them off the rows themselves: whoever has had the
    // fewest of this client's tasks gets the next one, so two alternate.
    const h = await harness();
    h.spocs.add(CLIENT, FRC, { userId: PRIYA, displayName: "Priya", email: "priya@10x.test" });
    h.spocs.add(CLIENT, FRC, { userId: ANAND, displayName: "Anand", email: "anand@10x.test" });
    h.engagements.rows.push(engagementWork());

    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR);
    expect(h.items.rows[0]?.assigneeUserId).toBe(PRIYA);
    expect(h.items.rows[0]?.assignmentNote).toBeNull();
    // The router did it, and the trail says so.
    expect(h.verbs()).toEqual(["work_item.created", "work_item.assigned"]);

    // Priya's desk now holds one of this client's tasks; the next goes to Anand.
    h.spocs.bump(CLIENT, PRIYA);
    h.engagements.rows.push({ ...engagementWork(), engagementId: ENGAGEMENT_2 });
    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT_2], ACTOR);
    expect(h.items.rows[1]?.assigneeUserId).toBe(ANAND);
  });

  it("leaves it unassigned when the client has no SPOC for that Dept", async () => {
    const h = await harness();
    h.engagements.rows.push(engagementWork());
    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR);
    expect(h.items.rows[0]?.assigneeUserId).toBeNull();
    expect(h.items.rows[0]?.assignmentNote).toContain("No SPOC");
  });

  it("ignores a SPOC whose term had not started on the day the work begins", async () => {
    // The lookup uses the engagement's OWN start date, not "today". A handover
    // effective next week must not take work that began last week.
    const h = await harness();
    h.spocs.add(
      CLIENT,
      FRC,
      { userId: PRIYA, displayName: "Priya", email: "priya@10x.test" },
      "2026-10-01",
    );
    h.engagements.rows.push(engagementWork());
    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR);
    expect(h.items.rows[0]?.assigneeUserId).toBeNull();
  });

  it("says so when the service is filed under a Dept the firm does not have", async () => {
    const h = await harness();
    h.engagements.rows.push(engagementWork({ deptCode: "XYZ" }));
    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR);
    expect(h.items.rows[0]?.deptAxisId).toBeNull();
    expect(h.items.rows[0]?.assignmentNote).toContain("XYZ");
  });

  it("creates the item anyway when the service resolves to nothing at all", async () => {
    // No SLA, no Dept, no SPOC — and still a row. Losing the task because we
    // could not decide who it belonged to is the worst failure available here.
    const h = await harness();
    h.engagements.rows.push(
      engagementWork({ deptCode: null, slaDays: null, serviceVersionId: null }),
    );
    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR);
    expect(h.items.rows).toHaveLength(1);
    expect(h.items.rows[0]?.dueOn).toBeNull();
    expect(h.items.rows[0]?.slaDaysSnapshot).toBeNull();
  });

  it("is NOT marked statutory — an engagement's SLA is the firm's own promise", async () => {
    // Defaulting this true would put every piece of advisory work on the
    // statutory priority and make the flag meaningless the day it matters.
    // T3.2's obligations are what set it, from the law.
    const h = await harness();
    h.engagements.rows.push(engagementWork());
    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR);
    expect(h.items.rows[0]?.isStatutoryDue).toBe(false);
    const medium = await h.vocabulary.findPriorityByCode(FIRM, "medium");
    expect(h.items.rows[0]?.priorityId).toBe(medium?.id);
  });

  it("SPAWNS ONCE, however many times the sweep runs", async () => {
    // THE property the engine rests on. Every route into the sweep is
    // at-least-once — a redelivered pg-boss message, a restarted worker, a
    // replayed activation — and a second work item is a second task on
    // somebody's desk for work already being done.
    const h = await harness();
    h.spocs.add(CLIENT, FRC, { userId: PRIYA, displayName: "Priya", email: "priya@10x.test" });
    h.engagements.rows.push(engagementWork());

    expect(await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR)).toBe(1);
    expect(await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR)).toBe(0);
    expect(h.items.rows).toHaveLength(1);
    // And no second pair of events. A replay that recorded again would make the
    // trail say the work was raised twice.
    expect(h.verbs()).toEqual(["work_item.created", "work_item.assigned"]);
  });

  it("does nothing at all when handed no engagements", async () => {
    const h = await harness();
    expect(await h.service.spawnForEngagements(FIRM, JOB, [], ACTOR)).toBe(0);
    expect(h.verbs()).toEqual([]);
  });
});

describe("raising work by hand", () => {
  it("creates it unassigned, with a note saying there was nothing to route on", async () => {
    const h = await harness();
    const item = await h.service.create(
      { tenantId: FIRM, clientPartyId: CLIENT, title: "Prepare board minutes" },
      ACTOR,
    );
    expect(item.assigneeUserId).toBeNull();
    expect(item.assignmentNote).toContain("no Dept");
    expect(item.engagementId).toBeNull();
    expect(item.jobId).toBeNull();
  });

  it("takes a named assignee, and refuses somebody who does not work here", async () => {
    const h = await harness();
    const item = await h.service.create(
      { tenantId: FIRM, clientPartyId: CLIENT, title: "Board minutes", assigneeUserId: PRIYA },
      ACTOR,
    );
    expect(item.assigneeUserId).toBe(PRIYA);

    // `tenancy.user_account` is GLOBAL, so the foreign key would happily accept
    // a stranger. The roster is the only thing that can say otherwise.
    await expect(
      h.service.create(
        {
          tenantId: FIRM,
          clientPartyId: CLIENT,
          title: "Board minutes",
          assigneeUserId: "00000000-0000-4000-8000-0000000000ff",
        },
        ACTOR,
      ),
    ).rejects.toThrow(WorkItemError);
  });

  it("refuses an archived client", async () => {
    const h = await harness();
    h.clients.add("00000000-0000-4000-8000-0000000000c9", "Old Co", "2026-01-01T00:00:00.000Z");
    await expect(
      h.service.create(
        { tenantId: FIRM, clientPartyId: "00000000-0000-4000-8000-0000000000c9", title: "x" },
        ACTOR,
      ),
    ).rejects.toThrow(/archived/i);
  });

  it("refuses a blank title — a board row with nothing on it", async () => {
    const h = await harness();
    await expect(
      h.service.create({ tenantId: FIRM, clientPartyId: CLIENT, title: "   " }, ACTOR),
    ).rejects.toThrow(WorkItemError);
  });

  it("keeps it OFF the client's portal unless the caller says to show it (V1.4)", async () => {
    const h = await harness();
    const quiet = await h.service.create(
      { tenantId: FIRM, clientPartyId: CLIENT, title: "Chase Ravi for the ledger" },
      ACTOR,
    );
    expect(quiet.isClientVisible).toBe(false);

    const shown = await h.service.create(
      { tenantId: FIRM, clientPartyId: CLIENT, title: "Board minutes", isClientVisible: true },
      ACTOR,
    );
    expect(shown.isClientVisible).toBe(true);
  });

  it("still shows the client spawned monthly work and statutory tasks (V1.4)", async () => {
    const h = await harness();
    h.engagements.rows.push(engagementWork());

    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR);
    const statutory = await h.service.raiseForObligation(
      FIRM,
      { entityPartyId: ENTITY, engagementId: ENGAGEMENT, title: "GSTR-3B · Aug 2026", description: null, dueOn: "2026-09-20" },
      ACTOR,
    );

    const spawned = h.items.rows.find((r) => r.engagementId === ENGAGEMENT && r.id !== statutory);
    expect(spawned?.isClientVisible).toBe(true);
    expect(h.items.rows.find((r) => r.id === statutory)?.isClientVisible).toBe(true);
  });

  it("gives statutory work the STATUTORY default priority", async () => {
    const h = await harness();
    const item = await h.service.create(
      { tenantId: FIRM, clientPartyId: CLIENT, title: "GSTR-3B", isStatutoryDue: true },
      ACTOR,
    );
    const high = await h.vocabulary.findPriorityByCode(FIRM, "high");
    expect(item.priorityId).toBe(high?.id);
  });
});

describe("moving between the firm's own states", () => {
  it("stamps the start time on the first move out of the starting state", async () => {
    const h = await harness();
    const item = await h.service.create({ tenantId: FIRM, clientPartyId: CLIENT, title: "x" }, ACTOR);
    const moved = await h.service.moveToState(
      { tenantId: FIRM, workItemId: item.id, stateId: (await stateNamed(h, "in_progress")).id },
      ACTOR,
    );
    expect(moved.startedAt).toBe(NOW);
    expect(moved.completedAt).toBeNull();
  });

  it("DEMANDS a reason for a state the firm has marked blocked", async () => {
    // The capture-or-lose pair, taken at the one moment the answer is still
    // obvious to everybody. "Blocked" on its own records that work is stuck and
    // never why.
    const h = await harness();
    const item = await h.service.create({ tenantId: FIRM, clientPartyId: CLIENT, title: "x" }, ACTOR);
    const blocked = await stateNamed(h, "blocked");

    await expect(
      h.service.moveToState({ tenantId: FIRM, workItemId: item.id, stateId: blocked.id }, ACTOR),
    ).rejects.toThrow(/reason/i);

    const moved = await h.service.moveToState(
      {
        tenantId: FIRM,
        workItemId: item.id,
        stateId: blocked.id,
        blockedReason: "Client has not sent the bank statements",
      },
      ACTOR,
    );
    expect(moved.blockedReason).toBe("Client has not sent the bank statements");
    expect(moved.blockedAt).toBe(NOW);
  });

  it("CLEARS the pair on the way out, because the row says what is true now", async () => {
    const h = await harness();
    const item = await h.service.create({ tenantId: FIRM, clientPartyId: CLIENT, title: "x" }, ACTOR);
    await h.service.moveToState(
      {
        tenantId: FIRM,
        workItemId: item.id,
        stateId: (await stateNamed(h, "blocked")).id,
        blockedReason: "waiting on the client",
      },
      ACTOR,
    );
    const unblocked = await h.service.moveToState(
      { tenantId: FIRM, workItemId: item.id, stateId: (await stateNamed(h, "in_progress")).id },
      ACTOR,
    );
    expect(unblocked.blockedReason).toBeNull();
    expect(unblocked.blockedAt).toBeNull();
  });

  it("stamps the completion on a terminal state, and clears it when reopened", async () => {
    const h = await harness();
    const item = await h.service.create({ tenantId: FIRM, clientPartyId: CLIENT, title: "x" }, ACTOR);
    const done = await h.service.moveToState(
      { tenantId: FIRM, workItemId: item.id, stateId: (await stateNamed(h, "completed")).id },
      ACTOR,
    );
    expect(done.completedAt).toBe(NOW);

    const reopened = await h.service.moveToState(
      { tenantId: FIRM, workItemId: item.id, stateId: (await stateNamed(h, "in_progress")).id },
      ACTOR,
    );
    expect(reopened.completedAt).toBeNull();
  });

  it("records `work_item.completed` beside the move, but only on the way IN", async () => {
    // Its own verb, because "what did we finish last month" cannot be answered
    // from a generic state change without knowing which states were terminal at
    // the time.
    const h = await harness();
    const item = await h.service.create({ tenantId: FIRM, clientPartyId: CLIENT, title: "x" }, ACTOR);
    await h.service.moveToState(
      { tenantId: FIRM, workItemId: item.id, stateId: (await stateNamed(h, "completed")).id },
      ACTOR,
    );
    expect(h.verbs()).toEqual([
      "work_item.created",
      "work_item.state_changed",
      "work_item.completed",
    ]);

    await h.service.moveToState(
      { tenantId: FIRM, workItemId: item.id, stateId: (await stateNamed(h, "cancelled")).id },
      ACTOR,
    );
    // Terminal to terminal is one state change and NOT a second completion.
    expect(h.verbs().filter((v) => v === "work_item.completed")).toHaveLength(1);
  });

  it("does NOT record a completion for a task that was CANCELLED", async () => {
    // 0054. This fired on any terminal state until `is_success` existed, so a
    // cancelled task counted as work the firm finished — and the verb's own
    // description is "what did we finish last month", which a cancellation is
    // not an answer to. Every report built on this verb would have counted them
    // forever, silently.
    const h = await harness();
    const item = await h.service.create({ tenantId: FIRM, clientPartyId: CLIENT, title: "x" }, ACTOR);
    await h.service.moveToState(
      { tenantId: FIRM, workItemId: item.id, stateId: (await stateNamed(h, "cancelled")).id },
      ACTOR,
    );
    expect(h.verbs()).not.toContain("work_item.completed");
    // The fact is not lost: the state change carries the flag, so "what did we
    // abandon" is answerable without a verb of its own.
    const moved = h.recorded().find((e) => e.verb === "work_item.state_changed");
    expect(moved?.payload).toMatchObject({ isTerminal: true, isSuccess: false });
  });

  it("tells the compliance calendar on EVERY move, with the discharged answer", async () => {
    // The return leg of `raiseForObligation`, and the one writer
    // `obligation_instance.filed_on` has. Called on every move because the port
    // reconciles rather than transitions — so a reopen is the same call with a
    // different answer rather than a second path to keep in step.
    const h = await harness();
    const item = await h.service.create({ tenantId: FIRM, clientPartyId: CLIENT, title: "x" }, ACTOR);

    await h.service.moveToState(
      { tenantId: FIRM, workItemId: item.id, stateId: (await stateNamed(h, "in_progress")).id },
      ACTOR,
    );
    await h.service.moveToState(
      { tenantId: FIRM, workItemId: item.id, stateId: (await stateNamed(h, "completed")).id },
      ACTOR,
    );
    await h.service.moveToState(
      { tenantId: FIRM, workItemId: item.id, stateId: (await stateNamed(h, "in_progress")).id },
      ACTOR,
    );

    expect(h.filings.calls).toEqual([
      { workItemId: item.id, discharged: false },
      { workItemId: item.id, discharged: true },
      { workItemId: item.id, discharged: false },
    ]);
  });

  it("never tells the calendar a CANCELLED task discharged a filing", async () => {
    // The trap this whole flag exists for. "Terminal" alone would record that a
    // statutory return had been FILED because somebody tidied their board —
    // not a missing feature but a false statement about a filing, and worse
    // than the "Pending forever" it replaces.
    const h = await harness();
    const item = await h.service.create({ tenantId: FIRM, clientPartyId: CLIENT, title: "x" }, ACTOR);
    await h.service.moveToState(
      { tenantId: FIRM, workItemId: item.id, stateId: (await stateNamed(h, "cancelled")).id },
      ACTOR,
    );
    expect(h.filings.calls).toEqual([{ workItemId: item.id, discharged: false }]);
  });

  it("never puts the block REASON in the ledger", async () => {
    // Prose a person wrote, routinely naming a colleague or a client, in a log
    // that cannot be erased.
    const h = await harness();
    const item = await h.service.create({ tenantId: FIRM, clientPartyId: CLIENT, title: "x" }, ACTOR);
    await h.service.moveToState(
      {
        tenantId: FIRM,
        workItemId: item.id,
        stateId: (await stateNamed(h, "blocked")).id,
        blockedReason: "Ramesh at Kaveri has not signed",
      },
      ACTOR,
    );
    expect(JSON.stringify(h.recorded())).not.toContain("Ramesh");
  });

  it("refuses a move to the state it is already in", async () => {
    const h = await harness();
    const item = await h.service.create({ tenantId: FIRM, clientPartyId: CLIENT, title: "x" }, ACTOR);
    await expect(
      h.service.moveToState({ tenantId: FIRM, workItemId: item.id, stateId: item.stateId }, ACTOR),
    ).rejects.toThrow(WorkItemError);
  });

  it("refuses a state the firm has retired", async () => {
    const h = await harness();
    const item = await h.service.create({ tenantId: FIRM, clientPartyId: CLIENT, title: "x" }, ACTOR);
    const waiting = await stateNamed(h, "waiting_client");
    await h.vocab.updateState({ tenantId: FIRM, stateId: waiting.id, isActive: false }, ACTOR);
    await expect(
      h.service.moveToState({ tenantId: FIRM, workItemId: item.id, stateId: waiting.id }, ACTOR),
    ).rejects.toThrow(/no longer uses/i);
  });
});

describe("dependencies", () => {
  async function twoItems(h: Awaited<ReturnType<typeof harness>>) {
    const annual = await h.service.create(
      { tenantId: FIRM, clientPartyId: CLIENT, title: "Annual filing" },
      ACTOR,
    );
    const monthly = await h.service.create(
      { tenantId: FIRM, clientPartyId: CLIENT, title: "August filing" },
      ACTOR,
    );
    return { annual, monthly };
  }

  it("refuses STARTING while an item it waits on is unfinished", async () => {
    // What a dependency SAYS: "this cannot start until that is finished". So it
    // is enforced rather than displayed.
    const h = await harness();
    const { annual, monthly } = await twoItems(h);
    await h.service.addDependency(FIRM, annual.id, monthly.id, ACTOR);

    await expect(
      h.service.moveToState(
        { tenantId: FIRM, workItemId: annual.id, stateId: (await stateNamed(h, "in_progress")).id },
        ACTOR,
      ),
    ).rejects.toThrow(/August filing/);
  });

  it("still allows CANCELLING it — that is a real act on work that never began", async () => {
    const h = await harness();
    const { annual, monthly } = await twoItems(h);
    await h.service.addDependency(FIRM, annual.id, monthly.id, ACTOR);
    const cancelled = await h.service.moveToState(
      { tenantId: FIRM, workItemId: annual.id, stateId: (await stateNamed(h, "cancelled")).id },
      ACTOR,
    );
    expect(cancelled.completedAt).toBe(NOW);
  });

  it("lets it start once the blocker reaches a TERMINAL state", async () => {
    const h = await harness();
    const { annual, monthly } = await twoItems(h);
    await h.service.addDependency(FIRM, annual.id, monthly.id, ACTOR);
    await h.service.moveToState(
      { tenantId: FIRM, workItemId: monthly.id, stateId: (await stateNamed(h, "completed")).id },
      ACTOR,
    );
    const started = await h.service.moveToState(
      { tenantId: FIRM, workItemId: annual.id, stateId: (await stateNamed(h, "in_progress")).id },
      ACTOR,
    );
    expect(started.startedAt).toBe(NOW);
  });

  it("refuses a duplicate, and refuses a cycle", async () => {
    const h = await harness();
    const { annual, monthly } = await twoItems(h);
    await h.service.addDependency(FIRM, annual.id, monthly.id, ACTOR);
    await expect(h.service.addDependency(FIRM, annual.id, monthly.id, ACTOR)).rejects.toThrow(
      WorkItemError,
    );
    await expect(h.service.addDependency(FIRM, monthly.id, annual.id, ACTOR)).rejects.toThrow(
      /wait on each other/,
    );
  });

  it("records who lifted one — the row is deleted, so the event is the record", async () => {
    const h = await harness();
    const { annual, monthly } = await twoItems(h);
    const dep = await h.service.addDependency(FIRM, annual.id, monthly.id, ACTOR);
    await h.service.removeDependency(FIRM, dep.id, ACTOR);
    expect(h.verbs()).toContain("work_item.dependency_removed");
    expect(h.items.dependencies).toHaveLength(0);
  });
});

describe("the checklist", () => {
  it("appends in tens, so a firm can slot a line between two later", async () => {
    const h = await harness();
    const item = await h.service.create({ tenantId: FIRM, clientPartyId: CLIENT, title: "x" }, ACTOR);
    const a = await h.service.addChecklistItem(FIRM, item.id, "Reconcile");
    const b = await h.service.addChecklistItem(FIRM, item.id, "File");
    expect([a.sortOrder, b.sortOrder]).toEqual([10, 20]);
  });

  it("records who ticked it and when — and NOT in the ledger", async () => {
    // A tick is somebody's working note on their own task. The row already
    // carries who and when; twelve events per filing would bury the transitions
    // that matter in a log that cannot be pruned.
    const h = await harness();
    const item = await h.service.create({ tenantId: FIRM, clientPartyId: CLIENT, title: "x" }, ACTOR);
    const line = await h.service.addChecklistItem(FIRM, item.id, "Reconcile");
    const ticked = await h.service.setChecklistDone(FIRM, line.id, true, PRIYA);
    expect(ticked).toMatchObject({ doneAt: NOW, doneByUserId: PRIYA });
    expect(h.verbs()).toEqual(["work_item.created"]);
  });

  it("refuses to remove a TICKED line — the tick lives nowhere else", async () => {
    const h = await harness();
    const item = await h.service.create({ tenantId: FIRM, clientPartyId: CLIENT, title: "x" }, ACTOR);
    const line = await h.service.addChecklistItem(FIRM, item.id, "Reconcile");
    await h.service.setChecklistDone(FIRM, line.id, true, PRIYA);
    await expect(h.service.removeChecklistItem(FIRM, line.id)).rejects.toThrow(/ticked/i);

    // Unticked first, then gone — which is the route the message names.
    await h.service.setChecklistDone(FIRM, line.id, false, PRIYA);
    await h.service.removeChecklistItem(FIRM, line.id);
    expect(h.items.checklist).toHaveLength(0);
  });

  it("counts done and total on the board row", async () => {
    const h = await harness();
    const item = await h.service.create({ tenantId: FIRM, clientPartyId: CLIENT, title: "x" }, ACTOR);
    const a = await h.service.addChecklistItem(FIRM, item.id, "Reconcile");
    await h.service.addChecklistItem(FIRM, item.id, "File");
    await h.service.setChecklistDone(FIRM, a.id, true, PRIYA);
    const detail = await h.service.detail(FIRM, item.id);
    expect(detail.record).toMatchObject({ checklistDone: 1, checklistTotal: 2 });
  });
});

describe("review — and the rule no firm may configure away", () => {
  beforeEach(() => undefined);

  async function readyForReview() {
    const h = await harness();
    // Priya does the work; Anand is a Senior Manager who may check it; Ravi
    // holds a read-only role and may not.
    h.reviewers.rows.push(
      { userId: PRIYA, displayName: "Priya", role: "associate", gradeRank: 3, gradeName: "Associate", reportsToUserId: ANAND },
      { userId: ANAND, displayName: "Anand", role: "manager", gradeRank: 8, gradeName: "Senior Manager", reportsToUserId: null },
      { userId: RAVI, displayName: "Ravi", role: "readonly", gradeRank: 9, gradeName: "Director", reportsToUserId: null },
    );
    h.permissions.byRole.set("associate", ["work:write"]);
    h.permissions.byRole.set("manager", ["work:write"]);
    h.permissions.byRole.set("readonly", ["party:read"]);

    const item = await h.service.create(
      { tenantId: FIRM, clientPartyId: CLIENT, title: "GST filing", assigneeUserId: PRIYA },
      ACTOR,
    );
    return { h, item };
  }

  /**
   * The firm names one of its own states as "with a checker" (0073).
   *
   * Written as a helper rather than into the harness on purpose: NOT having one
   * is the shipped state and the default every other test in this file runs
   * under, so a test that wants the move has to ask for it.
   */
  async function nameAReviewState(h: Awaited<ReturnType<typeof harness>>): Promise<string> {
    const states = await h.vocab.listStates(FIRM);
    const target = states.find((st) => st.code === "under_review");
    if (!target) throw new Error("the seed no longer ships an under_review state");
    await h.vocab.updateState({ tenantId: FIRM, stateId: target.id, isUnderReview: true }, ACTOR);
    return target.id;
  }

  it("MOVES the item into the firm's 'with a checker' state", async () => {
    // The defect this closes, found by using the product: the buttons became
    // Approve / Send back while the header went on reading "In Progress", and
    // on a board organised by state the task sat in the wrong column while
    // somebody's queue said it was theirs.
    const { h, item } = await readyForReview();
    const reviewStateId = await nameAReviewState(h);

    await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);

    const after = await h.service.detail(FIRM, item.id);
    expect(after.record.item.stateId).toBe(reviewStateId);
  });

  it("leaves the state ALONE when the firm has named none — the shipped answer", async () => {
    // Null is supported, not a gap. There is deliberately no fallback to a
    // state NAMED "Under Review": the firm owns the words, and a product that
    // reads a name breaks the morning somebody renames it.
    const { h, item } = await readyForReview();
    const before = (await h.service.detail(FIRM, item.id)).record.item.stateId;

    await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);

    expect((await h.service.detail(FIRM, item.id)).record.item.stateId).toBe(before);
  });

  it("records the move, and says it was the REVIEW that moved it", async () => {
    const { h, item } = await readyForReview();
    const reviewStateId = await nameAReviewState(h);
    const before = h.recorded().length;

    await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);

    const written = h.recorded().slice(before);
    const moved = written.find((e) => e.verb === "work_item.state_changed");
    // A person choosing the state from a dropdown and a review request moving
    // it are the same WRITE and are not the same FACT.
    expect(moved?.payload).toMatchObject({ toStateId: reviewStateId, byReviewRequest: true });
    const asked = written.find((e) => e.verb === "work_item.review_requested");
    expect(asked?.payload).toMatchObject({ movedToStateId: reviewStateId });
  });

  it("says on the event when NOTHING moved, because that is a firm's decision", async () => {
    const { h, item } = await readyForReview();
    const before = h.recorded().length;

    await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);

    const written = h.recorded().slice(before);
    expect(written.some((e) => e.verb === "work_item.state_changed")).toBe(false);
    expect(
      written.find((e) => e.verb === "work_item.review_requested")?.payload,
    ).toMatchObject({ movedToStateId: null });
  });

  it("clears a stale block on the way in — it is not stuck, it is with a checker", async () => {
    const { h, item } = await readyForReview();
    const reviewStateId = await nameAReviewState(h);
    const states = await h.vocab.listStates(FIRM);
    const blocked = states.find((st) => st.isBlocked);
    if (!blocked) throw new Error("the seed no longer ships a blocked state");
    await h.service.moveToState(
      {
        tenantId: FIRM,
        workItemId: item.id,
        stateId: blocked.id,
        blockedReason: "waiting on the client's bank statement",
      },
      ACTOR,
    );

    await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);

    const after = (await h.service.detail(FIRM, item.id)).record.item;
    expect(after.stateId).toBe(reviewStateId);
    // A sentence left behind from the block would be read as the reason the
    // work is where it is now, and it is not. The ledger keeps what it said.
    expect(after.blockedReason).toBeNull();
    expect(after.blockedAt).toBeNull();
  });

  it("does not reopen FINISHED work by asking for a check", async () => {
    const { h, item } = await readyForReview();
    await nameAReviewState(h);
    const states = await h.vocab.listStates(FIRM);
    const done = states.find((st) => st.isTerminal && st.isSuccess);
    if (!done) throw new Error("the seed no longer ships a successful terminal state");
    await h.service.moveToState(
      { tenantId: FIRM, workItemId: item.id, stateId: done.id },
      ACTOR,
    );

    await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);

    const after = (await h.service.detail(FIRM, item.id)).record.item;
    // Moving it out would clear `completedAt` as a side effect of asking for a
    // check, which is finished work being reopened by a button that says
    // nothing about reopening.
    expect(after.stateId).toBe(done.id);
    expect(after.completedAt).not.toBeNull();
  });

  it("derives the maker from the item's assignee — the caller cannot set it", async () => {
    const { h, item } = await readyForReview();
    const approval = await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);
    expect(approval.submittedBy).toBe(PRIYA);
  });

  it("refuses the maker as the checker, with no policy published at all", async () => {
    // Maker != checker is the product's rule and not a setting. It applies
    // FIRST, before any policy, so a firm that has published none still gets it.
    const { h, item } = await readyForReview();
    const approval = await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);
    await expect(
      h.service.decideReview(
        { tenantId: FIRM, approvalId: approval.id, decision: "approved", decidedBy: PRIYA },
        ACTOR,
      ),
    ).rejects.toThrow(/can never be the person who checks it/i);
  });

  it("lets a colleague with work:write approve it", async () => {
    const { h, item } = await readyForReview();
    const approval = await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);
    const decided = await h.service.decideReview(
      { tenantId: FIRM, approvalId: approval.id, decision: "approved", decidedBy: ANAND },
      ACTOR,
    );
    expect(decided).toMatchObject({ decision: "approved", decidedBy: ANAND, decidedAt: NOW });
    expect(h.verbs()).toContain("work_item.review_approved");
  });

  it("refuses somebody with no work:write, however senior", async () => {
    // The demo's Q41, closed: a read-only Management membership carrying a
    // Director grade would otherwise pass a rank threshold and sign off a
    // statutory filing.
    const { h, item } = await readyForReview();
    const approval = await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);
    await expect(
      h.service.decideReview(
        { tenantId: FIRM, approvalId: approval.id, decision: "approved", decidedBy: RAVI },
        ACTOR,
      ),
    ).rejects.toThrow(/permission/i);
  });

  it("applies the firm's PUBLISHED rank threshold when one is named", async () => {
    const { h, item } = await readyForReview();
    h.policies.published.set("manager_review", {
      versionId: "00000000-0000-4000-8000-0000000000p1",
      key: "manager_review",
      policy: {
        label: "Manager review",
        rule: "rank_threshold",
        minGradeRank: 7,
        minGradeCode: "manager",
      },
    });
    // A second maker, below the bar, so the threshold has something to refuse.
    h.reviewers.rows.push({
      userId: "00000000-0000-4000-8000-0000000000d4",
      displayName: "Junior",
      role: "associate",
      gradeRank: 2,
      gradeName: "Senior Analyst",
      reportsToUserId: null,
    });

    const approval = await h.service.requestReview(
      { tenantId: FIRM, workItemId: item.id, policyKey: "manager_review" },
      ACTOR,
    );
    expect(approval.policyKey).toBe("manager_review");

    const checkers = await h.service.eligibleCheckers(FIRM, approval.id);
    const byId = new Map(checkers.map((c) => [c.userId, c]));
    expect(byId.get(ANAND)?.eligible).toBe(true);
    expect(byId.get(PRIYA)?.eligible).toBe(false);
    expect(byId.get(PRIYA)?.reason).toMatch(/did this work/i);
    expect(byId.get("00000000-0000-4000-8000-0000000000d4")?.reason).toMatch(/grade above yours/i);
  });

  it("puts the WHOLE firm's queue on every desk, with the viewer's own verdict on each row", async () => {
    // Not filtered to what the viewer may take. Under a rank threshold there is
    // no "mine" — any Manager may take any of it — and a list narrowed to what
    // one person can act on hides the queue's most useful fact: that work has
    // waited a week because nobody senior enough has looked. So the verdict
    // rides on the ROW, and the refusal is the sentence a screen prints
    // verbatim rather than a code it has to translate a second time.
    const { h, item } = await readyForReview();
    await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);

    const asPriya = await h.service.pendingChecks(FIRM, PRIYA);
    expect(asPriya).toHaveLength(1);
    expect(asPriya[0]?.viewer.eligible).toBe(false);
    expect(asPriya[0]?.viewer.reason).toMatch(/did this work/i);

    const asAnand = await h.service.pendingChecks(FIRM, ANAND);
    expect(asAnand).toHaveLength(1);
    expect(asAnand[0]?.viewer).toEqual({ eligible: true, reason: null });

    // Ravi is a Director and may not, because checking somebody's work writes
    // to the record of who did it. He still SEES the row — that is the point.
    const asRavi = await h.service.pendingChecks(FIRM, RAVI);
    expect(asRavi).toHaveLength(1);
    expect(asRavi[0]?.viewer.reason).toMatch(/permission/i);
  });

  it("gives an item's own page the same verdict its queue row gets, and only on the OPEN one", async () => {
    // The defect this closes: the item's page derived maker != checker locally
    // from `submittedBy` — one third of the rule — so the ladder and the grade
    // threshold were discovered by pressing Approve and reading a 403, while
    // the queue screen had been showing the same person the full answer since
    // T2.9. Two screens, one question, two answers.
    const { h, item } = await readyForReview();
    const approval = await h.service.requestReview(
      { tenantId: FIRM, workItemId: item.id },
      ACTOR,
    );

    // Word for word what `pendingChecks` says to each of them.
    const queueRavi = (await h.service.pendingChecks(FIRM, RAVI))[0];
    const detailRavi = await h.service.detail(FIRM, item.id, RAVI);
    expect(detailRavi.openReviewViewer).toEqual(queueRavi?.viewer);
    expect(detailRavi.openReviewViewer?.reason).toMatch(/permission/i);

    const detailPriya = await h.service.detail(FIRM, item.id, PRIYA);
    expect(detailPriya.openReviewViewer?.eligible).toBe(false);
    expect(detailPriya.openReviewViewer?.reason).toMatch(/did this work/i);

    const detailAnand = await h.service.detail(FIRM, item.id, ANAND);
    expect(detailAnand.openReviewViewer).toEqual({ eligible: true, reason: null });

    // NULL ONCE IT IS DECIDED, and that is not tidiness: "may you check this"
    // is not a question about a review already approved, and a verdict there
    // would be a sentence nobody should act on.
    await h.service.decideReview(
      { tenantId: FIRM, approvalId: approval.id, decision: "approved", decidedBy: ANAND },
      ACTOR,
    );
    const after = await h.service.detail(FIRM, item.id, ANAND);
    expect(after.reviews).toHaveLength(1);
    expect(after.openReviewViewer).toBeNull();
  });

  it("empties the queue once the work has been checked", async () => {
    const { h, item } = await readyForReview();
    const approval = await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);
    await h.service.decideReview(
      { tenantId: FIRM, approvalId: approval.id, decision: "approved", decidedBy: ANAND },
      ACTOR,
    );
    expect(await h.service.pendingChecks(FIRM, ANAND)).toEqual([]);
  });

  // ── THE FIRM'S RULE APPLIES TO A TASK TOO (audit 2026-10-03, CA#27) ──────
  //
  // The roleplay firm published "Manager review" and its ad-hoc tasks went on
  // being checked under "Anyone but the maker", so one Analyst approved
  // another's GSTR-3B. A task names no rule (there is no template step to name
  // one), so the firm's published rule is applied when the sender names none.

  function publish(h: Awaited<ReturnType<typeof harness>>, key: string, label: string, minGradeRank: number) {
    h.policies.published.set(key, {
      versionId: `00000000-0000-4000-8000-0000000000${key === "manager_review" ? "p1" : "p2"}`,
      key,
      policy: { label, rule: "rank_threshold", minGradeRank, minGradeCode: key },
    });
  }

  it("applies the firm's ONLY published rule when the sender names none", async () => {
    const { h, item } = await readyForReview();
    publish(h, "manager_review", "Manager review", 7);
    // Another Associate, who under "anyone but the maker" could approve.
    const SNEHA = "00000000-0000-4000-8000-0000000000d4";
    h.reviewers.rows.push({
      userId: SNEHA,
      displayName: "Sneha",
      role: "associate",
      gradeRank: 2,
      gradeName: "Analyst",
      reportsToUserId: ANAND,
    });

    const approval = await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);

    expect(approval.policyKey).toBe("manager_review");
    await expect(
      h.service.decideReview(
        { tenantId: FIRM, approvalId: approval.id, decision: "approved", decidedBy: SNEHA },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "REVIEWER_NOT_ELIGIBLE" });
    expect(h.recorded().find((e) => e.verb === "work_item.review_requested")?.payload).toMatchObject({
      policyKey: "manager_review",
      policyVersionId: "00000000-0000-4000-8000-0000000000p1",
    });
  });

  it("asks WHICH rule when the firm has published several, naming them, and opens nothing", async () => {
    const { h, item } = await readyForReview();
    publish(h, "manager_review", "Manager review", 7);
    publish(h, "eqcr", "Quality review by a partner", 10);

    const refused = h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);
    await expect(refused).rejects.toMatchObject({ code: "REVIEW_RULE_NEEDED" });
    await expect(refused).rejects.toThrow(/Manager review.*Quality review by a partner|Quality review by a partner.*Manager review/);
    expect(await h.service.pendingChecks(FIRM, ANAND)).toEqual([]);

    const chosen = await h.service.requestReview(
      { tenantId: FIRM, workItemId: item.id, policyKey: "eqcr" },
      ACTOR,
    );
    expect(chosen.policyKey).toBe("eqcr");
  });

  it("opens under maker != checker alone when the firm has published no rule", async () => {
    const { h, item } = await readyForReview();
    const approval = await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);
    expect(approval.policyKey).toBeNull();
  });

  it("lists the firm's published rules for the screen that sends work to be checked", async () => {
    const { h } = await readyForReview();
    publish(h, "manager_review", "Manager review", 7);
    expect(await h.service.reviewRules(FIRM)).toEqual([{ key: "manager_review", label: "Manager review" }]);
  });

  it("refuses a policy key the firm has not published, rather than falling through", async () => {
    // The caller asked for a particular bar; quietly opening the check without
    // it would be this product lowering it.
    const { h, item } = await readyForReview();
    await expect(
      h.service.requestReview({ tenantId: FIRM, workItemId: item.id, policyKey: "eqcr" }, ACTOR),
    ).rejects.toThrow(/no rule in force called "eqcr"/i);
  });

  it("allows only ONE open review at a time", async () => {
    const { h, item } = await readyForReview();
    await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);
    await expect(
      h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR),
    ).rejects.toThrow(/already waiting/i);
  });

  it("DEMANDS a note on a rejection, and keeps it", async () => {
    // Why work came back is the only signal that ever explains rework; marking
    // the task Completed later erases the fact that it was rejected at all.
    const { h, item } = await readyForReview();
    const approval = await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);
    await expect(
      h.service.decideReview(
        { tenantId: FIRM, approvalId: approval.id, decision: "rejected", decidedBy: ANAND },
        ACTOR,
      ),
    ).rejects.toThrow(WorkItemError);

    const rejected = await h.service.decideReview(
      {
        tenantId: FIRM,
        approvalId: approval.id,
        decision: "rejected",
        notes: "ITC reconciliation is missing two invoices",
        decidedBy: ANAND,
      },
      ACTOR,
    );
    expect(rejected.notes).toContain("ITC reconciliation");
    // The note is NOT in the ledger — prose about a colleague's work, in a log
    // that cannot be erased.
    expect(JSON.stringify(h.recorded())).not.toContain("ITC reconciliation");
  });

  it("keeps a rejected review, so a second go is visible as a second go", async () => {
    const { h, item } = await readyForReview();
    const first = await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);
    await h.service.decideReview(
      {
        tenantId: FIRM,
        approvalId: first.id,
        decision: "rejected",
        notes: "sent back",
        decidedBy: ANAND,
      },
      ACTOR,
    );
    const second = await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);
    await h.service.decideReview(
      { tenantId: FIRM, approvalId: second.id, decision: "approved", decidedBy: ANAND },
      ACTOR,
    );

    const detail = await h.service.detail(FIRM, item.id);
    expect(detail.reviews).toHaveLength(2);
    expect(detail.reviews.map((r) => r.approval.decision).sort()).toEqual([
      "approved",
      "rejected",
    ]);
  });

  it("refuses a second decision — whoever got there first is the one that stands", async () => {
    const { h, item } = await readyForReview();
    const approval = await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);
    await h.service.decideReview(
      { tenantId: FIRM, approvalId: approval.id, decision: "approved", decidedBy: ANAND },
      ACTOR,
    );
    await expect(
      h.service.decideReview(
        { tenantId: FIRM, approvalId: approval.id, decision: "rejected", notes: "no", decidedBy: ANAND },
        ACTOR,
      ),
    ).rejects.toThrow(/already/i);
  });

  // ── the decision closes the loop (audit 2026-10-03, CA#28) ────────────────
  //
  // The roleplay's manager pressed Approve and the task stayed "In Progress"
  // with Send for review offered again: nobody ever marked it Completed, so
  // finished work read as open on every board and report.

  it("COMPLETES the task when the review is approved", async () => {
    const { h, item } = await readyForReview();
    const approval = await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);

    await h.service.decideReview(
      { tenantId: FIRM, approvalId: approval.id, decision: "approved", decidedBy: ANAND },
      ACTOR,
    );

    const after = (await h.service.detail(FIRM, item.id)).record;
    expect(after.state.isTerminal && after.state.isSuccess).toBe(true);
    expect(after.item.completedAt).toBe(NOW);
    // The same facts a hand move to Completed records: the calendar is told,
    // and "what did we finish" counts it.
    expect(h.verbs()).toContain("work_item.completed");
    expect(h.filings.calls.at(-1)).toMatchObject({ workItemId: item.id, discharged: true });
    const moved = h.recorded().find((e) => e.verb === "work_item.state_changed");
    expect(moved?.payload).toMatchObject({ toStateId: after.state.id, byReviewDecision: "approved" });
  });

  it("completes it from the firm's 'with a checker' state too", async () => {
    const { h, item } = await readyForReview();
    await nameAReviewState(h);
    const approval = await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);

    await h.service.decideReview(
      { tenantId: FIRM, approvalId: approval.id, decision: "approved", decidedBy: ANAND },
      ACTOR,
    );

    const after = (await h.service.detail(FIRM, item.id)).record;
    expect(after.state.isTerminal && after.state.isSuccess).toBe(true);
  });

  it("leaves the task where it is when the firm has no successful finished state", async () => {
    const { h, item } = await readyForReview();
    const states = await h.vocab.listStates(FIRM);
    const done = states.find((st) => st.isTerminal && st.isSuccess);
    if (!done) throw new Error("the seed no longer ships a successful terminal state");
    await h.vocab.updateState({ tenantId: FIRM, stateId: done.id, isSuccess: false }, ACTOR);
    const before = (await h.service.detail(FIRM, item.id)).record.item.stateId;
    const approval = await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);

    const decided = await h.service.decideReview(
      { tenantId: FIRM, approvalId: approval.id, decision: "approved", decidedBy: ANAND },
      ACTOR,
    );

    expect(decided.decision).toBe("approved");
    expect((await h.service.detail(FIRM, item.id)).record.item.stateId).toBe(before);
  });

  it("puts sent-back work back to the firm's working state, out of 'with a checker'", async () => {
    const { h, item } = await readyForReview();
    const reviewStateId = await nameAReviewState(h);
    const approval = await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);
    expect((await h.service.detail(FIRM, item.id)).record.item.stateId).toBe(reviewStateId);

    await h.service.decideReview(
      {
        tenantId: FIRM,
        approvalId: approval.id,
        decision: "rejected",
        notes: "Two invoices missing from the ITC working",
        decidedBy: ANAND,
      },
      ACTOR,
    );

    const after = (await h.service.detail(FIRM, item.id)).record;
    expect(after.state.code).toBe("in_progress");
    expect(after.item.completedAt).toBeNull();
    const moved = h.recorded().filter((e) => e.verb === "work_item.state_changed").at(-1);
    expect(moved?.payload).toMatchObject({ toStateId: after.state.id, byReviewDecision: "rejected" });
  });

  it("leaves sent-back work alone when it never moved into a 'with a checker' state", async () => {
    const { h, item } = await readyForReview();
    const before = (await h.service.detail(FIRM, item.id)).record.item.stateId;
    const approval = await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);

    await h.service.decideReview(
      { tenantId: FIRM, approvalId: approval.id, decision: "rejected", notes: "redo", decidedBy: ANAND },
      ACTOR,
    );

    expect((await h.service.detail(FIRM, item.id)).record.item.stateId).toBe(before);
  });

  // ── the checklist is a gate, the way a step's sub-steps are (CA#30) ───────

  it("refuses Send for review while a checklist line is open, and names it", async () => {
    // Sent with 2 of 3 ticked in the roleplay. A process step will not take
    // Done with a sub-step open (T6.15); a task's checklist now says the same.
    const { h, item } = await readyForReview();
    const a = await h.service.addChecklistItem(FIRM, item.id, "Get sales and purchase data");
    const b = await h.service.addChecklistItem(FIRM, item.id, "Reconcile ITC with GSTR-2B");
    await h.service.addChecklistItem(FIRM, item.id, "Compute liability and share challan");
    await h.service.setChecklistDone(FIRM, a.id, true, PRIYA);
    await h.service.setChecklistDone(FIRM, b.id, true, PRIYA);

    const refused = h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);
    await expect(refused).rejects.toMatchObject({ code: "CHECKLIST_OPEN" });
    await expect(refused).rejects.toThrow(/Compute liability and share challan/);
    expect(await h.service.pendingChecks(FIRM, ANAND)).toEqual([]);
  });

  it("refuses moving to the finished-and-done state by hand while a line is open, and still lets it be cancelled", async () => {
    const { h, item } = await readyForReview();
    await h.service.addChecklistItem(FIRM, item.id, "File the return");
    const states = await h.vocab.listStates(FIRM);
    const done = states.find((st) => st.isTerminal && st.isSuccess);
    const cancelled = states.find((st) => st.isTerminal && !st.isSuccess);
    if (!done || !cancelled) throw new Error("the seed no longer ships both terminal states");

    await expect(
      h.service.moveToState({ tenantId: FIRM, workItemId: item.id, stateId: done.id }, ACTOR),
    ).rejects.toMatchObject({ code: "CHECKLIST_OPEN" });
    // Cancelling is not saying the work was done.
    await h.service.moveToState({ tenantId: FIRM, workItemId: item.id, stateId: cancelled.id }, ACTOR);
  });

  it("refuses Approve when a line was unticked after it was sent, and still lets the checker send it back", async () => {
    const { h, item } = await readyForReview();
    const a = await h.service.addChecklistItem(FIRM, item.id, "File the return");
    await h.service.setChecklistDone(FIRM, a.id, true, PRIYA);
    const approval = await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);
    await h.service.setChecklistDone(FIRM, a.id, false, PRIYA);

    await expect(
      h.service.decideReview(
        { tenantId: FIRM, approvalId: approval.id, decision: "approved", decidedBy: ANAND },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "CHECKLIST_OPEN" });
    const back = await h.service.decideReview(
      { tenantId: FIRM, approvalId: approval.id, decision: "rejected", notes: "tick it", decidedBy: ANAND },
      ACTOR,
    );
    expect(back.decision).toBe("rejected");
  });

  it("still opens a review on UNASSIGNED work, with no maker to compare against", async () => {
    // A real state, not an error: somebody did the work off the record. Maker
    // != checker is then vacuous rather than blocking, and the screen says so.
    const h = await harness();
    h.reviewers.rows.push({
      userId: ANAND,
      displayName: "Anand",
      role: "manager",
      gradeRank: 8,
      gradeName: "Senior Manager",
      reportsToUserId: null,
    });
    h.permissions.byRole.set("manager", ["work:write"]);
    const item = await h.service.create({ tenantId: FIRM, clientPartyId: CLIENT, title: "x" }, ACTOR);
    const approval = await h.service.requestReview({ tenantId: FIRM, workItemId: item.id }, ACTOR);
    expect(approval.submittedBy).toBeNull();
    const decided = await h.service.decideReview(
      { tenantId: FIRM, approvalId: approval.id, decision: "approved", decidedBy: ANAND },
      ACTOR,
    );
    expect(decided.decision).toBe("approved");
  });
});

describe("editing a work item", () => {
  it("records BOTH sides of a moved due date", async () => {
    // "Why was this late" is answered by somebody having moved it, and a
    // payload saying only that something was edited could not answer it.
    const h = await harness();
    const item = await h.service.create(
      { tenantId: FIRM, clientPartyId: CLIENT, title: "x", dueOn: "2026-09-30" },
      ACTOR,
    );
    await h.service.update({ tenantId: FIRM, workItemId: item.id, dueOn: "2026-10-15" }, ACTOR);
    expect(h.recorded().at(-1)).toMatchObject({
      verb: "work_item.updated",
      payload: { dueOnFrom: "2026-09-30", dueOnTo: "2026-10-15" },
    });
  });

  it("records THAT a title changed and never what it changed to", async () => {
    const h = await harness();
    const item = await h.service.create({ tenantId: FIRM, clientPartyId: CLIENT, title: "x" }, ACTOR);
    await h.service.update(
      { tenantId: FIRM, workItemId: item.id, title: "Kaveri Foods GST reconciliation" },
      ACTOR,
    );
    expect(h.recorded().at(-1)?.payload).toMatchObject({ titleChanged: true });
    expect(JSON.stringify(h.recorded())).not.toContain("Kaveri Foods GST reconciliation");
  });

  it("records nothing when nothing changed", async () => {
    const h = await harness();
    const item = await h.service.create({ tenantId: FIRM, clientPartyId: CLIENT, title: "x" }, ACTOR);
    const before = h.verbs().length;
    await h.service.update({ tenantId: FIRM, workItemId: item.id, title: "x" }, ACTOR);
    expect(h.verbs()).toHaveLength(before);
  });
});

describe("the board's filters", () => {
  it("shows one person's desk, the unassigned queue, and hides finished work", async () => {
    const h = await harness();
    const mine = await h.service.create(
      { tenantId: FIRM, clientPartyId: CLIENT, title: "mine", assigneeUserId: PRIYA },
      ACTOR,
    );
    await h.service.create({ tenantId: FIRM, clientPartyId: CLIENT, title: "nobody's" }, ACTOR);
    const done = await h.service.create(
      { tenantId: FIRM, clientPartyId: CLIENT, title: "done", assigneeUserId: PRIYA },
      ACTOR,
    );
    await h.service.moveToState(
      { tenantId: FIRM, workItemId: done.id, stateId: (await stateNamed(h, "completed")).id },
      ACTOR,
    );

    const board = await h.service.board(FIRM, { openOnly: true }, "2026-09-10");
    expect(board.map((r) => r.item.title).sort()).toEqual(["mine", "nobody's"]);

    const desk = await h.service.board(FIRM, { assigneeUserId: PRIYA, openOnly: true }, "2026-09-10");
    expect(desk.map((r) => r.item.id)).toEqual([mine.id]);

    const queue = await h.service.board(FIRM, { unassignedOnly: true, openOnly: true }, "2026-09-10");
    expect(queue.map((r) => r.item.title)).toEqual(["nobody's"]);

    const all = await h.service.board(FIRM, {}, "2026-09-10");
    expect(all).toHaveLength(3);
  });
});

// ── T6.13: one MONTH's task, handed over with its period ────────────────────

describe("a period job's umbrella task is one month's task", () => {
  const SEPTEMBER = { label: "Sep 2026", end: "2026-09-30" };

  it("names the month and counts the turnaround from the period's END", async () => {
    const h = await harness();
    h.spocs.add(CLIENT, FRC, { userId: PRIYA, displayName: "Priya", email: "priya@10x.test" });
    h.engagements.rows.push(engagementWork({ serviceName: "Monthly bookkeeping" }));

    const created = await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR, SEPTEMBER);

    expect(created).toBe(1);
    expect(h.items.rows[0]).toMatchObject({
      title: "Monthly bookkeeping · Sep 2026",
      // 30 September + 30 days, NOT the engagement's start plus 30. For a
      // month-aligned period this is exactly "by the 30th of the following
      // month", which is how the firm states it.
      dueOn: "2026-10-30",
      slaDaysSnapshot: 30,
      assigneeUserId: PRIYA,
      isStatutoryDue: false,
    });
  });

  it("is never due after the legal date of a filing its work is for (audit 2026-10-03, CA#11)", async () => {
    // GST returns · Sep 2026 read due 20 Oct, period end plus the turnaround,
    // while its GSTR-1 was legally due 11 Oct.
    const h = await harness();
    h.spocs.add(CLIENT, FRC, { userId: PRIYA, displayName: "Priya", email: "priya@10x.test" });
    h.engagements.rows.push(engagementWork({ serviceName: "GST returns" }));
    h.obligations.filingDue.set(ENGAGEMENT, "2026-10-11");

    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR, { ...SEPTEMBER, start: "2026-09-01" });

    expect(h.items.rows[0]).toMatchObject({ dueOn: "2026-10-11", isStatutoryDue: true });
    expect(h.obligations.filingDueAsked).toEqual([{ engagementId: ENGAGEMENT, start: "2026-09-01", end: "2026-09-30" }]);
  });

  it("keeps the turnaround when it is the earlier date", async () => {
    const h = await harness();
    h.spocs.add(CLIENT, FRC, { userId: PRIYA, displayName: "Priya", email: "priya@10x.test" });
    h.engagements.rows.push(engagementWork({ serviceName: "Monthly bookkeeping" }));
    h.obligations.filingDue.set(ENGAGEMENT, "2026-11-30");

    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR, { ...SEPTEMBER, start: "2026-09-01" });

    expect(h.items.rows[0]).toMatchObject({ dueOn: "2026-10-30", isStatutoryDue: false });
  });

  it("an entity that files GST through one engagement still owes its bookkeeping task on the other", async () => {
    // Since T6.16 a rule reaches an engagement only through the service it
    // bought, so coverage is per ENGAGEMENT and "covered" and "a filing" are
    // one answer (the adapter runs one statement for both). The company's GST
    // engagement is covered; its bookkeeping engagement carries no filing, and
    // September's bookkeeping must still be spawned. (T6.13 tested this as
    // one engagement covered and not a filing, which the adapter can no
    // longer say.)
    const BOOKS = "00000000-0000-4000-8000-0000000000f2";
    const h = await harness();
    h.spocs.add(CLIENT, FRC, { userId: PRIYA, displayName: "Priya", email: "priya@10x.test" });
    h.engagements.rows.push(
      engagementWork(),
      engagementWork({ engagementId: BOOKS, serviceName: "Monthly bookkeeping" }),
    );
    h.obligations.covered.add(ENGAGEMENT);

    expect(
      await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT, BOOKS], ACTOR, SEPTEMBER),
    ).toBe(1);
    expect(h.items.rows.map((r) => r.title)).toEqual(["Monthly bookkeeping · Sep 2026"]);
  });

  it("skips the month's task where a filing is linked to the service: it IS a filing", async () => {
    const h = await harness();
    h.spocs.add(CLIENT, FRC, { userId: PRIYA, displayName: "Priya", email: "priya@10x.test" });
    h.engagements.rows.push(engagementWork());
    h.obligations.covered.add(ENGAGEMENT);

    expect(await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR)).toBe(0);
    expect(await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR, SEPTEMBER)).toBe(0);
    expect(h.items.rows).toHaveLength(0);
  });

  it("KEEPS the month's task where the service has a process of its own, filings linked or not", async () => {
    // The T6.16 follow-up (the firm's rule, 2026-09-26). A monthly bookkeeping
    // service with a ten-step close that also carries TDS lost "Monthly
    // Accounting · Sep 2026", the task its period job's steps hang under,
    // because the calendar dated its TDS. It keeps it now; the TDS returns get
    // their own tasks from the calendar beside it.
    const h = await harness();
    h.spocs.add(CLIENT, FRC, { userId: PRIYA, displayName: "Priya", email: "priya@10x.test" });
    h.engagements.rows.push(engagementWork({ serviceName: "Monthly Accounting" }));
    h.obligations.covered.add(ENGAGEMENT);
    h.obligations.ownProcess.add(ENGAGEMENT);

    expect(await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR, SEPTEMBER)).toBe(1);
    expect(h.items.rows[0]).toMatchObject({
      title: "Monthly Accounting · Sep 2026",
      dueOn: "2026-10-30",
      assigneeUserId: PRIYA,
      isStatutoryDue: false,
    });
  });

  it("still skips the ONE-TIME activation task of a covered service with a process: that question is unchanged", async () => {
    // The activation task is due `effective_from + slaDays` on an engagement
    // that runs a year, and can never be completed whatever steps the service
    // has: the thirteenth-row argument, which a process does not answer.
    const h = await harness();
    h.spocs.add(CLIENT, FRC, { userId: PRIYA, displayName: "Priya", email: "priya@10x.test" });
    h.engagements.rows.push(engagementWork({ serviceName: "Monthly Accounting" }));
    h.obligations.covered.add(ENGAGEMENT);
    h.obligations.ownProcess.add(ENGAGEMENT);

    expect(await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR)).toBe(0);
    expect(h.items.rows).toHaveLength(0);
  });

  it("is one task per engagement PER JOB, so October's job gets its own", async () => {
    const h = await harness();
    h.spocs.add(CLIENT, FRC, { userId: PRIYA, displayName: "Priya", email: "priya@10x.test" });
    h.engagements.rows.push(engagementWork());
    const OCTOBER_JOB = "00000000-0000-4000-8000-0000000000b2";

    expect(await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR, SEPTEMBER)).toBe(1);
    expect(await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR, SEPTEMBER)).toBe(0);
    expect(
      await h.service.spawnForEngagements(FIRM, OCTOBER_JOB, [ENGAGEMENT], ACTOR, {
        label: "Oct 2026",
        end: "2026-10-31",
      }),
    ).toBe(1);
    expect(h.items.rows.map((r) => r.title)).toEqual([
      "GST monthly filing · Sep 2026",
      "GST monthly filing · Oct 2026",
    ]);
  });
});

describe("THE OWNER RULE: work always has an owner (2026-09-27)", () => {
  const RAVI_KM = { userId: RAVI, displayName: "Ravi" };

  it("gives the task to the client's Key Manager to hand out when there is no SPOC", async () => {
    const h = await harness();
    h.owners.setKeyManager(CLIENT, RAVI_KM);
    h.engagements.rows.push(engagementWork());

    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR);

    const [row] = h.items.rows;
    expect(row?.assigneeUserId).toBe(RAVI);
    // The note is what tells Ravi the task came to him to HAND OUT, and why.
    expect(row?.assignmentNote).toContain("Key Manager to hand out");
    expect(h.recorded().at(-1)).toMatchObject({ verb: "work_item.assigned", payload: { how: "key_manager", userId: RAVI } });
  });

  it("gives it to the person who signs for the firm when the client has no Key Manager either", async () => {
    const h = await harness();
    h.owners.partner = { userId: ANAND, displayName: "Anand" };
    h.engagements.rows.push(engagementWork());

    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR);

    expect(h.items.rows[0]?.assigneeUserId).toBe(ANAND);
    expect(h.items.rows[0]?.assignmentNote).toContain("Anand, who signs for the firm");
    expect(h.recorded().at(-1)?.payload).toMatchObject({ how: "partner" });
  });

  it("routes a statutory filing's task by the same ladder", async () => {
    const h = await harness();
    h.owners.setKeyManager(CLIENT, RAVI_KM);
    h.engagements.rows.push(engagementWork());

    const id = await h.service.raiseForObligation(
      FIRM,
      { entityPartyId: ENTITY, engagementId: ENGAGEMENT, title: "GSTR-3B · Aug 2026", description: null, dueOn: "2026-09-20" },
      ACTOR,
    );

    expect(h.items.rows.find((r) => r.id === id)?.assigneeUserId).toBe(RAVI);
    expect(h.recorded().at(-1)?.payload).toMatchObject({ how: "key_manager" });
  });

  it("asks who owns it on the firm's TODAY, the day the job's steps ask on, not the engagement's first day", async () => {
    // Priya was the FRC SPOC until 5 September and Anand is from then. The
    // engagement began on the 1st and the work is created on the 10th (NOW):
    // it is Anand's, as the job's steps will be.
    const h = await harness();
    h.spocs.add(CLIENT, FRC, { userId: PRIYA, displayName: "Priya", email: "priya@10x.test" }, "2000-01-01", "2026-09-05");
    h.spocs.add(CLIENT, FRC, { userId: ANAND, displayName: "Anand", email: "anand@10x.test" }, "2026-09-05");
    h.engagements.rows.push(engagementWork());

    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR, { label: "Sep 2026", end: "2026-09-30" });

    expect(h.items.rows[0]?.assigneeUserId).toBe(ANAND);
  });

  it("finds an account team named today for an engagement back-dated by the book import", async () => {
    // The import names the team from today and dates the engagement from the
    // paper letter. Asking on the engagement's day found nobody.
    const h = await harness();
    h.spocs.add(CLIENT, FRC, { userId: PRIYA, displayName: "Priya", email: "priya@10x.test" }, "2026-09-10");
    h.engagements.rows.push(engagementWork({ effectiveFrom: "2023-04-01" }));

    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR, { label: "Sep 2026", end: "2026-09-30" });

    expect(h.items.rows[0]?.assigneeUserId).toBe(PRIYA);
  });

  it("reads today in the FIRM's zone: 04:11 UTC on the 10th is still the 10th in Kolkata, 23:30 UTC is the 11th", async () => {
    const h = await harness();
    h.timeZones.set("Asia/Kolkata");
    h.spocs.add(CLIENT, FRC, { userId: PRIYA, displayName: "Priya", email: "priya@10x.test" }, "2026-09-11");
    h.engagements.rows.push(engagementWork());
    h.clock.set(new Date("2026-09-10T19:00:00.000Z")); // 00:30 on the 11th in Kolkata
    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR);
    expect(h.items.rows[0]?.assigneeUserId).toBe(PRIYA);
  });
});

describe("handing a task on takes its job's steps with it (2026-09-27)", () => {
  it("hands the job's unheld steps to the new owner, and says how many went", async () => {
    const h = await harness();
    h.owners.setKeyManager(CLIENT, { userId: RAVI, displayName: "Ravi" });
    h.engagements.rows.push(engagementWork());
    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR);
    const task = h.items.rows[0];
    if (!task) throw new Error("no task was spawned");
    h.jobSteps.moves = 10;

    const out = await h.service.assign({ tenantId: FIRM, workItemId: task.id, assigneeUserId: PRIYA }, ACTOR);

    expect(out.item.assigneeUserId).toBe(PRIYA);
    // A hand move clears the router's note: it was about Ravi's desk.
    expect(out.item.assignmentNote).toBeNull();
    expect(out.stepsHandedOver).toBe(10);
    expect(h.jobSteps.calls).toEqual([{ jobId: JOB, fromUserId: RAVI, toUserId: PRIYA }]);
  });

  it("leaves the steps where they are while another open task of the job is on somebody else's desk", async () => {
    const h = await harness();
    h.owners.setKeyManager(CLIENT, { userId: RAVI, displayName: "Ravi" });
    h.engagements.rows.push(engagementWork(), { ...engagementWork(), engagementId: ENGAGEMENT_2 });
    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT, ENGAGEMENT_2], ACTOR);
    const [first, second] = h.items.rows;
    if (!first || !second) throw new Error("two tasks were expected");

    const one = await h.service.assign({ tenantId: FIRM, workItemId: first.id, assigneeUserId: PRIYA }, ACTOR);
    expect(one.stepsHandedOver).toBe(0);
    expect(h.jobSteps.calls).toEqual([]);

    // Once every open task of the job is Priya's, the job is hers.
    await h.service.assign({ tenantId: FIRM, workItemId: second.id, assigneeUserId: PRIYA }, ACTOR);
    expect(h.jobSteps.calls).toEqual([{ jobId: JOB, fromUserId: RAVI, toUserId: PRIYA }]);
  });

  it("moves no steps when a task is taken off a desk, or has no job", async () => {
    const h = await harness();
    h.owners.setKeyManager(CLIENT, { userId: RAVI, displayName: "Ravi" });
    h.engagements.rows.push(engagementWork());
    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR);
    const task = h.items.rows[0];
    if (!task) throw new Error("no task was spawned");
    await h.service.assign({ tenantId: FIRM, workItemId: task.id, assigneeUserId: null }, ACTOR);

    const byHand = await h.service.create(
      { tenantId: FIRM, clientPartyId: CLIENT, title: "Board minutes", assigneeUserId: null },
      ACTOR,
    );
    await h.service.assign({ tenantId: FIRM, workItemId: byHand.id, assigneeUserId: PRIYA }, ACTOR);

    expect(h.jobSteps.calls).toEqual([]);
  });
});

describe("THE CATCH-UP: naming the account team moves the work waiting for it (T6.17)", () => {
  const RAVI_KM = { userId: RAVI, displayName: "Ravi" };
  const priyaSpoc = { userId: PRIYA, displayName: "Priya", email: "priya@10x.test" };

  /** A client whose September task landed on Ravi's desk (the Key Manager) to
   *  hand out, because nobody was the FRC SPOC when the letter was signed. */
  async function waitingOnKeyManager() {
    const h = await harness();
    h.owners.setKeyManager(CLIENT, RAVI_KM);
    h.engagements.rows.push(engagementWork());
    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR, { label: "Sep 2026", end: "2026-09-30" });
    const task = h.items.rows[0];
    if (!task) throw new Error("no task was spawned");
    expect(task.assigneeUserId).toBe(RAVI);
    return { h, task };
  }

  it("moves the Key Manager's hand-out task to the SPOC named afterwards, with its steps, and clears the note", async () => {
    const { h, task } = await waitingOnKeyManager();
    h.spocs.add(CLIENT, FRC, priyaSpoc, "2026-09-10");
    h.jobSteps.moves = 10;

    const out = await h.service.catchUpClient(FIRM, CLIENT, ACTOR);

    const after = h.items.rows.find((r) => r.id === task.id);
    expect(after?.assigneeUserId).toBe(PRIYA);
    // The SPOC rung leaves no note: "no SPOC is recorded" is no longer true.
    expect(after?.assignmentNote).toBeNull();
    expect(out.moves).toEqual([{ userId: PRIYA, tasks: 1, steps: 10 }]);
    // The steps go the way a hand-over sends them: off Ravi's desk, to Priya.
    expect(h.jobSteps.calls).toEqual([{ jobId: JOB, fromUserId: RAVI, toUserId: PRIYA }]);
    expect(h.recorded().at(-1)).toMatchObject({
      verb: "work_item.assigned",
      objectId: task.id,
      payload: { how: "spoc", userId: PRIYA, catchUp: true, fromUserId: RAVI, clientPartyId: CLIENT },
    });
  });

  it("gives a task that went to nobody to the Key Manager named afterwards, with the Key Manager's note", async () => {
    const h = await harness();
    h.engagements.rows.push(engagementWork());
    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR);
    expect(h.items.rows[0]?.assigneeUserId).toBeNull();
    h.owners.setKeyManager(CLIENT, RAVI_KM);

    const out = await h.service.catchUpClient(FIRM, CLIENT, ACTOR);

    expect(h.items.rows[0]?.assigneeUserId).toBe(RAVI);
    expect(h.items.rows[0]?.assignmentNote).toContain("Key Manager to hand out");
    expect(out.moves).toEqual([{ userId: RAVI, tasks: 1, steps: 0 }]);
    // Nobody held it, so only the steps nobody holds may follow.
    expect(h.jobSteps.calls).toEqual([{ jobId: JOB, fromUserId: null, toUserId: RAVI }]);
    expect(h.recorded().at(-1)?.payload).toMatchObject({ how: "key_manager", catchUp: true, fromUserId: null });
  });

  it("moves the signing partner's hand-out task to a Key Manager named afterwards", async () => {
    const h = await harness();
    h.owners.partner = { userId: ANAND, displayName: "Anand" };
    h.engagements.rows.push(engagementWork());
    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR);
    expect(h.items.rows[0]?.assigneeUserId).toBe(ANAND);
    h.owners.setKeyManager(CLIENT, RAVI_KM);

    await h.service.catchUpClient(FIRM, CLIENT, ACTOR);

    expect(h.items.rows[0]?.assigneeUserId).toBe(RAVI);
  });

  it("hands the outgoing Key Manager's hand-out work to the incoming one (Shrestha, 2026-09-27)", async () => {
    const h = await harness();
    h.owners.setKeyManager(CLIENT, RAVI_KM, "2000-01-01", "2026-09-10");
    h.owners.setKeyManager(CLIENT, { userId: ANAND, displayName: "Anand" }, "2026-09-10");
    h.engagements.rows.push(engagementWork());
    // Created while Ravi was still the Key Manager.
    h.clock.set(new Date("2026-09-05T04:00:00.000Z"));
    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR);
    expect(h.items.rows[0]?.assigneeUserId).toBe(RAVI);
    h.clock.set(new Date(NOW));

    await h.service.catchUpClient(FIRM, CLIENT, ACTOR);

    expect(h.items.rows[0]?.assigneeUserId).toBe(ANAND);
    expect(h.recorded().at(-1)?.payload).toMatchObject({ how: "key_manager", fromUserId: RAVI });
  });

  it("leaves alone a task a person handed on, even to the Key Manager", async () => {
    const { h, task } = await waitingOnKeyManager();
    // Ravi handed it to Anand by hand: the note is gone, and so is the router's claim on it.
    await h.service.assign({ tenantId: FIRM, workItemId: task.id, assigneeUserId: ANAND }, ACTOR);
    h.spocs.add(CLIENT, FRC, priyaSpoc, "2026-09-10");

    const out = await h.service.catchUpClient(FIRM, CLIENT, ACTOR);

    expect(h.items.rows[0]?.assigneeUserId).toBe(ANAND);
    expect(out.moves).toEqual([]);
  });

  it("leaves alone a task a person took off a desk and left with nobody", async () => {
    const { h, task } = await waitingOnKeyManager();
    await h.service.assign({ tenantId: FIRM, workItemId: task.id, assigneeUserId: null }, ACTOR);
    h.spocs.add(CLIENT, FRC, priyaSpoc, "2026-09-10");

    const out = await h.service.catchUpClient(FIRM, CLIENT, ACTOR);

    expect(h.items.rows[0]?.assigneeUserId).toBeNull();
    expect(out.moves).toEqual([]);
  });

  it("leaves alone a task that has been started, and one that is finished", async () => {
    const h = await harness();
    h.owners.setKeyManager(CLIENT, RAVI_KM);
    h.engagements.rows.push(engagementWork(), { ...engagementWork(), engagementId: ENGAGEMENT_2 });
    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT, ENGAGEMENT_2], ACTOR);
    const [started, finished] = h.items.rows;
    if (!started || !finished) throw new Error("two tasks were expected");
    await h.service.moveToState({ tenantId: FIRM, workItemId: started.id, stateId: (await stateNamed(h, "in_progress")).id }, ACTOR);
    await h.service.moveToState({ tenantId: FIRM, workItemId: finished.id, stateId: (await stateNamed(h, "completed")).id }, ACTOR);
    h.spocs.add(CLIENT, FRC, priyaSpoc, "2026-09-10");

    const out = await h.service.catchUpClient(FIRM, CLIENT, ACTOR);

    expect(h.items.rows.map((r) => r.assigneeUserId)).toEqual([RAVI, RAVI]);
    expect(out.moves).toEqual([]);
  });

  it("leaves alone work somebody raised by hand, and work a SPOC already holds", async () => {
    const h = await harness();
    h.spocs.add(CLIENT, FRC, priyaSpoc);
    h.engagements.rows.push(engagementWork());
    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR);
    const byHand = await h.service.create({ tenantId: FIRM, clientPartyId: CLIENT, title: "Board minutes" }, ACTOR);
    // A second FRC SPOC, named today: the old SPOC's work is not re-dealt.
    h.spocs.add(CLIENT, FRC, { userId: ANAND, displayName: "Anand", email: "anand@10x.test" }, "2026-09-10");

    const out = await h.service.catchUpClient(FIRM, CLIENT, ACTOR);

    expect(h.items.rows[0]?.assigneeUserId).toBe(PRIYA);
    expect(h.items.rows.find((r) => r.id === byHand.id)?.assigneeUserId).toBeNull();
    expect(out.moves).toEqual([]);
  });

  it("does nothing, and takes nothing off a desk, when the rule still names the same person or nobody", async () => {
    const { h } = await waitingOnKeyManager();
    const before = h.recorded().length;

    const out = await h.service.catchUpClient(FIRM, CLIENT, ACTOR);

    expect(out.moves).toEqual([]);
    expect(h.items.rows[0]?.assigneeUserId).toBe(RAVI);
    expect(h.recorded().length).toBe(before);
  });

  it("keeps the desk and corrects the sentence when the Key Manager is now also the Dept's SPOC", async () => {
    const { h } = await waitingOnKeyManager();
    h.spocs.add(CLIENT, FRC, { userId: RAVI, displayName: "Ravi", email: "ravi@10x.test" }, "2026-09-10");
    const before = h.recorded().length;

    const out = await h.service.catchUpClient(FIRM, CLIENT, ACTOR);

    expect(h.items.rows[0]?.assigneeUserId).toBe(RAVI);
    expect(h.items.rows[0]?.assignmentNote).toBeNull();
    // Not a move: nothing on the ledger and nothing counted.
    expect(out.moves).toEqual([]);
    expect(h.recorded().length).toBe(before);
  });

  it("moves a filing's task, asking about its due date while that is still ahead", async () => {
    const h = await harness();
    h.owners.setKeyManager(CLIENT, RAVI_KM);
    h.engagements.rows.push(engagementWork());
    const id = await h.service.raiseForObligation(
      FIRM,
      { entityPartyId: ENTITY, engagementId: ENGAGEMENT, title: "GSTR-3B · Sep 2026", description: null, dueOn: "2026-10-20" },
      ACTOR,
    );
    h.items.filings.set(id, { engagementId: ENGAGEMENT });
    // Priya takes FRC from 1 October: in force on the filing's due date.
    h.spocs.add(CLIENT, FRC, priyaSpoc, "2026-10-01");

    const out = await h.service.catchUpClient(FIRM, CLIENT, ACTOR);

    expect(h.items.rows.find((r) => r.id === id)?.assigneeUserId).toBe(PRIYA);
    // A filing's task has no job, so no steps are asked about.
    expect(out.moves).toEqual([{ userId: PRIYA, tasks: 1, steps: 0 }]);
    expect(h.jobSteps.calls).toEqual([]);
  });

  it("asks about TODAY for a filing already past its due date", async () => {
    const h = await harness();
    h.owners.setKeyManager(CLIENT, RAVI_KM);
    h.engagements.rows.push(engagementWork());
    const id = await h.service.raiseForObligation(
      FIRM,
      { entityPartyId: ENTITY, engagementId: ENGAGEMENT, title: "GSTR-3B · Aug 2026", description: null, dueOn: "2026-09-08" },
      ACTOR,
    );
    h.items.filings.set(id, { engagementId: ENGAGEMENT });
    // Named from today (the 10th): not in force on the 8th, and still the
    // person who should have the overdue filing now.
    h.spocs.add(CLIENT, FRC, priyaSpoc, "2026-09-10");

    await h.service.catchUpClient(FIRM, CLIENT, ACTOR);

    expect(h.items.rows.find((r) => r.id === id)?.assigneeUserId).toBe(PRIYA);
  });

  it("does not overwrite a task somebody handed out between the read and the write", async () => {
    const { h, task } = await waitingOnKeyManager();
    h.spocs.add(CLIENT, FRC, priyaSpoc, "2026-09-10");
    // Anand takes it by hand the moment after the catch-up read its candidates.
    const read = h.items.listCatchUpCandidates.bind(h.items);
    h.items.listCatchUpCandidates = async (...args) => {
      const out = await read(...args);
      await h.service.assign({ tenantId: FIRM, workItemId: task.id, assigneeUserId: ANAND }, ACTOR);
      return out;
    };

    const out = await h.service.catchUpClient(FIRM, CLIENT, ACTOR);

    expect(h.items.rows[0]?.assigneeUserId).toBe(ANAND);
    expect(out.moves).toEqual([]);
  });

  it("moves no steps while another open task of the job is on somebody else's desk", async () => {
    const h = await harness();
    h.owners.setKeyManager(CLIENT, RAVI_KM);
    h.engagements.rows.push(engagementWork(), { ...engagementWork(), engagementId: ENGAGEMENT_2 });
    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT, ENGAGEMENT_2], ACTOR);
    const second = h.items.rows[1];
    if (!second) throw new Error("two tasks were expected");
    // The second task was handed to Anand by hand; only the first is waiting.
    await h.service.assign({ tenantId: FIRM, workItemId: second.id, assigneeUserId: ANAND }, ACTOR);
    h.jobSteps.calls.length = 0;
    h.spocs.add(CLIENT, FRC, priyaSpoc, "2026-09-10");

    const out = await h.service.catchUpClient(FIRM, CLIENT, ACTOR);

    expect(h.items.rows[0]?.assigneeUserId).toBe(PRIYA);
    expect(out.moves).toEqual([{ userId: PRIYA, tasks: 1, steps: 0 }]);
    expect(h.jobSteps.calls).toEqual([]);
  });

  it("touches only the client it was asked about", async () => {
    const { h } = await waitingOnKeyManager();
    h.spocs.add(CLIENT, FRC, priyaSpoc, "2026-09-10");

    const out = await h.service.catchUpClient(FIRM, ENTITY, ACTOR);

    expect(out.moves).toEqual([]);
    expect(h.items.rows[0]?.assigneeUserId).toBe(RAVI);
  });
});

describe("where an unsigned letter's work will land (T6.17's Send warning)", () => {
  const LETTER = "00000000-0000-4000-8000-0000000000b9";
  const TRC = "00000000-0000-4000-8000-0000000000a2";
  const line = (n: number, name: string, deptCode: string | null) => ({
    lineId: `00000000-0000-4000-8000-00000000010${n}`,
    name,
    deptCode,
  });

  it("names the SPOC where there is one and the fallback desk where there is not, one row per Dept", async () => {
    const h = await harness();
    h.axes.add(TRC, "TRC", "Tax & Regulatory");
    h.spocs.add(CLIENT, FRC, { userId: PRIYA, displayName: "Priya", email: "priya@10x.test" });
    h.owners.setKeyManager(CLIENT, { userId: RAVI, displayName: "Ravi" });
    h.letters.letters.set(LETTER, {
      clientPartyId: CLIENT,
      lines: [line(1, "Bookkeeping", "FRC"), line(2, "GST returns", "TRC"), line(3, "Payroll", "FRC")],
    });

    const r = await h.service.routingForLetter(FIRM, LETTER);

    expect(r).toMatchObject({ letterId: LETTER, clientPartyId: CLIENT, onDate: "2026-09-10" });
    expect(r.depts).toEqual([
      {
        deptCode: "FRC",
        deptName: "Financial Reporting & Compliance",
        lines: [
          { lineId: line(1, "", null).lineId, name: "Bookkeeping" },
          { lineId: line(3, "", null).lineId, name: "Payroll" },
        ],
        how: "spoc",
        userId: PRIYA,
        ownerName: "Priya",
        reason: null,
      },
      {
        deptCode: "TRC",
        deptName: "Tax & Regulatory",
        lines: [{ lineId: line(2, "", null).lineId, name: "GST returns" }],
        how: "key_manager",
        userId: RAVI,
        ownerName: "Ravi",
        reason: "no_spoc",
      },
    ]);
  });

  it("says why a line has no SPOC to find, and when nobody at all would get it", async () => {
    const h = await harness();
    h.letters.letters.set(LETTER, {
      clientPartyId: CLIENT,
      lines: [line(1, "Advisory", null), line(2, "Audit", "AUD")],
    });

    const r = await h.service.routingForLetter(FIRM, LETTER);

    expect(r.depts.map((d) => [d.deptCode, d.reason, d.how, d.userId])).toEqual([
      [null, "no_dept", null, null],
      ["AUD", "unknown_dept", null, null],
    ]);
  });

  it("goes to the signing partner when the client has neither a SPOC nor a Key Manager", async () => {
    const h = await harness();
    h.owners.partner = { userId: ANAND, displayName: "Anand" };
    h.letters.letters.set(LETTER, { clientPartyId: CLIENT, lines: [line(1, "Bookkeeping", "FRC")] });

    const r = await h.service.routingForLetter(FIRM, LETTER);

    expect(r.depts[0]).toMatchObject({ how: "partner", userId: ANAND, ownerName: "Anand", reason: "no_spoc" });
  });

  it("refuses a letter that is not at this firm", async () => {
    const h = await harness();
    await expect(h.service.routingForLetter(FIRM, LETTER)).rejects.toMatchObject({
      code: "ROUTING_LETTER_NOT_FOUND",
    });
  });
});

describe("a cancelled job closes its tasks (V2.4)", () => {
  it("moves every open task of the job to the firm's cancelled state, as a cancellation", async () => {
    const h = await harness();
    h.engagements.rows.push(engagementWork());
    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR);
    const cancelled = await stateNamed(h, "cancelled");
    const before = h.recorded().length;

    expect(await h.service.cancelOpenForJob(FIRM, JOB, ACTOR)).toBe(1);

    expect(h.items.rows[0]?.stateId).toBe(cancelled.id);
    const moved = h.recorded().slice(before);
    expect(moved.map((e) => e.verb)).toEqual(["work_item.state_changed"]);
    // A cancellation, never a completion: no `work_item.completed`.
    expect(moved[0]?.payload).toMatchObject({ isTerminal: true, isSuccess: false });
    // Nothing open is left, so a second call moves nothing.
    expect(await h.service.cancelOpenForJob(FIRM, JOB, ACTOR)).toBe(0);
  });

  it("refuses BEFORE moving anything when the firm has no state for cancelled work", async () => {
    const h = await harness();
    h.engagements.rows.push(engagementWork());
    await h.service.spawnForEngagements(FIRM, JOB, [ENGAGEMENT], ACTOR);
    const cancelled = await stateNamed(h, "cancelled");
    await h.vocab.updateState({ tenantId: FIRM, stateId: cancelled.id, isActive: false }, ACTOR);
    const stateBefore = h.items.rows[0]?.stateId;

    await expect(h.service.cancelOpenForJob(FIRM, JOB, ACTOR)).rejects.toMatchObject({
      code: "NO_CANCELLED_STATE",
    });
    expect(h.items.rows[0]?.stateId).toBe(stateBefore);
  });
});
