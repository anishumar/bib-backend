// The firm's own words for work (T3.1) — states and priorities as rows, and
// the rules for changing them.
//
// This file is the STANDING DIRECTIVE, tested: the firm must be able to change
// this from a screen, with no deploy. So the assertions are mostly about what a
// firm is ALLOWED to do — rename, add, re-flag, retire — and the small number
// of things it is refused, each of which would leave the product unable to
// create any work at all.
import { describe, expect, it } from "vitest";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { FakeWorkVocabularyRepo } from "../../src/testfakes/workitem";
import { WorkVocabularyService } from "../../src/usecase/workitem/service";
import { WorkItemError } from "../../src/domain/workitem/errors";

const FIRM = "00000000-0000-4000-8000-000000000001";
const ACTOR = { type: "human", id: "00000000-0000-4000-8000-0000000000aa" } as const;

function svc() {
  const vocabulary = new FakeWorkVocabularyRepo();
  const events = new RecordingEventSink();
  const service = new WorkVocabularyService({ vocabulary, ids: new FakeIds(), events });
  return { service, vocabulary, events };
}

async function seeded() {
  const f = svc();
  await f.service.seedDefaultVocabulary(FIRM, ACTOR);
  return f;
}

async function stateNamed(f: Awaited<ReturnType<typeof seeded>>, code: string) {
  const s = await f.vocabulary.findStateByCode(FIRM, code);
  if (!s) throw new Error(`no "${code}" state`);
  return s;
}

async function priorityNamed(f: Awaited<ReturnType<typeof seeded>>, code: string) {
  const p = await f.vocabulary.findPriorityByCode(FIRM, code);
  if (!p) throw new Error(`no "${code}" priority`);
  return p;
}

describe("what a new firm starts with", () => {
  it("gets eight states and four priorities, as ONE fact", async () => {
    // A firm receiving its starting vocabulary is one thing that happened, not
    // twelve. Twelve rows would bury the events a person actually caused.
    const f = await seeded();
    expect(await f.service.listStates(FIRM)).toHaveLength(8);
    expect(await f.service.listPriorities(FIRM)).toHaveLength(4);
    expect(f.events.verbs()).toEqual(["work_vocabulary.seeded"]);
  });

  it("is idempotent — a retried createTenant does not produce a second board", async () => {
    // `createTenant` and the seeder share no unit of work, so a failure between
    // them means a retry. Rows that already exist are left exactly as they are,
    // because by then they may be the firm's own edits.
    const f = await seeded();
    const renamed = await stateNamed(f, "blocked");
    await f.service.updateState({ tenantId: FIRM, stateId: renamed.id, name: "Stuck" }, ACTOR);

    const written = await f.service.seedDefaultVocabulary(FIRM, ACTOR);

    expect(written).toEqual([]);
    expect(await f.service.listStates(FIRM)).toHaveLength(8);
    expect((await stateNamed(f, "blocked")).name).toBe("Stuck");
  });

  it("renders states in the firm's own order and priorities most urgent first", async () => {
    const f = await seeded();
    expect((await f.service.listStates(FIRM)).map((s) => s.code)).toEqual([
      "not_started",
      "in_progress",
      "waiting_client",
      "waiting_internal",
      "under_review",
      "blocked",
      "completed",
      "cancelled",
    ]);
    expect((await f.service.listPriorities(FIRM)).map((p) => p.code)).toEqual([
      "critical",
      "high",
      "medium",
      "low",
    ]);
  });
});

describe("THE STANDING DIRECTIVE — the firm changes this from a screen", () => {
  it("renames a state without touching anything else", async () => {
    // The names came from a previous vendor and are unconfirmed even for 10x.
    // Confirming one has to be an UPDATE, not a migration somebody asks an
    // engineer for.
    const f = await seeded();
    const blocked = await stateNamed(f, "blocked");
    const renamed = await f.service.updateState(
      { tenantId: FIRM, stateId: blocked.id, name: "Stuck" },
      ACTOR,
    );
    expect(renamed).toMatchObject({ code: "blocked", name: "Stuck", isBlocked: true });
  });

  it("keeps the BEHAVIOUR when the name changes, because rules read the flag", async () => {
    // The whole point of the flags. A rule keyed on `code = 'blocked'` would
    // have switched itself off on the line above.
    const f = await seeded();
    const blocked = await stateNamed(f, "blocked");
    await f.service.updateState({ tenantId: FIRM, stateId: blocked.id, name: "Stuck" }, ACTOR);
    const after = await f.service.listStates(FIRM);
    expect(after.filter((s) => s.isBlocked).map((s) => s.name)).toEqual(["Stuck"]);
  });

  it("lets a firm start demanding a reason on 'Waiting for Client' too", async () => {
    // The seed flags only `blocked`, on the judgement that "Waiting for Client"
    // already says whose fault the delay is. A firm that wants the prose as
    // well ticks the box — which is the configurability being real rather than
    // advertised.
    const f = await seeded();
    const waiting = await stateNamed(f, "waiting_client");
    const flagged = await f.service.updateState(
      { tenantId: FIRM, stateId: waiting.id, isBlocked: true },
      ACTOR,
    );
    expect(flagged.isBlocked).toBe(true);
  });

  it("adds a ninth state", async () => {
    const f = await seeded();
    const added = await f.service.createState(
      { tenantId: FIRM, code: "With_Auditor", name: "With the auditor", sortOrder: 45 },
      ACTOR,
    );
    // Codes are normalised, so "With_Auditor" and "with_auditor" cannot become
    // two rows.
    expect(added.code).toBe("with_auditor");
    expect(await f.service.listStates(FIRM)).toHaveLength(9);
  });

  it("moves the STARTING state, un-marking the old one in the same act", async () => {
    // "At most one" is a partial unique index, so marking a new one must
    // un-mark the incumbent atomically or the write conflicts with a row the
    // caller is on their way to changing.
    const f = await seeded();
    const inProgress = await stateNamed(f, "in_progress");
    await f.service.updateState({ tenantId: FIRM, stateId: inProgress.id, isInitial: true }, ACTOR);

    const states = await f.service.listStates(FIRM);
    expect(states.filter((s) => s.isInitial).map((s) => s.code)).toEqual(["in_progress"]);
  });

  it("moves the STATUTORY default, which changes what every later filing gets", async () => {
    const f = await seeded();
    const critical = await priorityNamed(f, "critical");
    await f.service.updatePriority(
      { tenantId: FIRM, priorityId: critical.id, isStatutoryDefault: true },
      ACTOR,
    );
    const priorities = await f.service.listPriorities(FIRM);
    expect(priorities.filter((p) => p.isStatutoryDefault).map((p) => p.code)).toEqual([
      "critical",
    ]);
  });

  it("retires a state it has stopped using, and can bring it back", async () => {
    // Never a delete: work sitting in the state keeps it and still reads. What
    // retiring changes is only that nothing NEW may be moved into it.
    const f = await seeded();
    const waiting = await stateNamed(f, "waiting_internal");
    const retired = await f.service.updateState(
      { tenantId: FIRM, stateId: waiting.id, isActive: false },
      ACTOR,
    );
    expect(retired.isActive).toBe(false);
    expect(await f.service.listStates(FIRM)).toHaveLength(8);

    const back = await f.service.updateState(
      { tenantId: FIRM, stateId: waiting.id, isActive: true },
      ACTOR,
    );
    expect(back.isActive).toBe(true);
  });

  it("records BOTH sides of whatever changed", async () => {
    // "The flag moved" is not the useful fact a year later; "it stopped being
    // terminal on the 4th, which is why these items lost their completion date"
    // is.
    const f = await seeded();
    const blocked = await stateNamed(f, "blocked");
    await f.service.updateState(
      { tenantId: FIRM, stateId: blocked.id, name: "Stuck", sortOrder: 65 },
      ACTOR,
    );
    expect(f.events.recorded.at(-1)).toMatchObject({
      verb: "work_item_state.updated",
      payload: { code: "blocked", nameFrom: "Blocked", nameTo: "Stuck", sortOrder: 65 },
    });
  });

  it("records nothing when a patch changes nothing", async () => {
    const f = await seeded();
    const blocked = await stateNamed(f, "blocked");
    const before = f.events.verbs().length;
    await f.service.updateState({ tenantId: FIRM, stateId: blocked.id, name: "Blocked" }, ACTOR);
    expect(f.events.verbs()).toHaveLength(before);
  });
});

describe("the four things a firm is refused, and why each one matters", () => {
  it("refuses to leave the firm with NO starting state", async () => {
    // A partial unique index enforces at most one and cannot enforce at least
    // one, so this floor lives in the service. Without it the firm would be
    // unable to create a single work item, and nothing would say why.
    const f = await seeded();
    const notStarted = await stateNamed(f, "not_started");
    await expect(
      f.service.updateState({ tenantId: FIRM, stateId: notStarted.id, isInitial: false }, ACTOR),
    ).rejects.toThrow(/no starting state/i);
  });

  it("refuses to RETIRE the starting state, which is the same hole", async () => {
    const f = await seeded();
    const notStarted = await stateNamed(f, "not_started");
    await expect(
      f.service.updateState({ tenantId: FIRM, stateId: notStarted.id, isActive: false }, ACTOR),
    ).rejects.toThrow(/no starting state/i);
  });

  it("allows the MOVE, because that is two ticks and never a moment with none", async () => {
    // The refusal above is not "you cannot change this" — it is "not like
    // that". Marking another state as the starting one does both halves at once.
    const f = await seeded();
    const inProgress = await stateNamed(f, "in_progress");
    await f.service.updateState({ tenantId: FIRM, stateId: inProgress.id, isInitial: true }, ACTOR);
    expect((await stateNamed(f, "not_started")).isInitial).toBe(false);
  });

  it("refuses to leave the firm with no default or no statutory-default priority", async () => {
    const f = await seeded();
    const medium = await priorityNamed(f, "medium");
    const high = await priorityNamed(f, "high");
    await expect(
      f.service.updatePriority({ tenantId: FIRM, priorityId: medium.id, isDefault: false }, ACTOR),
    ).rejects.toThrow(/no default priority/i);
    await expect(
      f.service.updatePriority(
        { tenantId: FIRM, priorityId: high.id, isStatutoryDefault: false },
        ACTOR,
      ),
    ).rejects.toThrow(/no statutory default priority/i);
  });

  it("refuses two flags that contradict each other", async () => {
    // Each flag turns a rule on somewhere else, and two together would demand
    // contradictory things of every item in the state — 0051's trigger would
    // then refuse every write into it with a message about a field the admin
    // never saw.
    const f = await seeded();
    await expect(
      f.service.createState(
        { tenantId: FIRM, code: "odd", name: "Odd", isTerminal: true, isBlocked: true },
        ACTOR,
      ),
    ).rejects.toThrow(/terminal and blocked/i);
    await expect(
      f.service.createState(
        { tenantId: FIRM, code: "odd2", name: "Odd", isInitial: true, isTerminal: true },
        ACTOR,
      ),
    ).rejects.toThrow(/starting state and a terminal/i);
    await expect(
      f.service.createState(
        { tenantId: FIRM, code: "odd3", name: "Odd", isInitial: true, isBlocked: true },
        ACTOR,
      ),
    ).rejects.toThrow(/block reason before it could exist/i);
  });

  it("refuses a code that is already taken, and a malformed one", async () => {
    const f = await seeded();
    await expect(
      f.service.createState({ tenantId: FIRM, code: "blocked", name: "Also blocked" }, ACTOR),
    ).rejects.toThrow(WorkItemError);
    await expect(
      f.service.createState({ tenantId: FIRM, code: "Not A Code!", name: "x" }, ACTOR),
    ).rejects.toThrow(/lowercase handle/i);
  });

  it("refuses a rank that is not a whole number above zero", async () => {
    const f = await seeded();
    await expect(
      f.service.createPriority({ tenantId: FIRM, code: "zero", name: "Zero", rank: 0 }, ACTOR),
    ).rejects.toThrow(WorkItemError);
    await expect(
      f.service.createPriority({ tenantId: FIRM, code: "half", name: "Half", rank: 1.5 }, ACTOR),
    ).rejects.toThrow(WorkItemError);
  });

  it("allows two priorities to SHARE a rank — nothing compares within one", async () => {
    // Uniqueness would turn "insert a priority between two others" into a
    // renumbering, to buy an ordering guarantee nothing reads.
    const f = await seeded();
    const added = await f.service.createPriority(
      { tenantId: FIRM, code: "urgent", name: "Urgent", rank: 2 },
      ACTOR,
    );
    expect(added.rank).toBe(2);
    expect((await f.service.listPriorities(FIRM)).filter((p) => p.rank === 2)).toHaveLength(2);
  });
});
