// The firm's own words for its compliance calendar (T3.3).
//
// The promise 0052 made — hold these as rows so a firm can rename them — was
// only half kept until now, because nothing could write them. These tests are
// about the half that makes renaming SAFE rather than merely possible: the
// flags carry every rule, and the firm must not be able to move one into a
// shape where a mechanism silently stops working.
//
// Each refusal here corresponds to a specific silence:
//   · no starting state       → nothing the calendar generates can exist
//   · no filed state          → finished work never closes on the calendar
//   · no missed state         → no overdue filing ever reaches a partner
//   · no resolution state     → a partner's decision has nowhere to land
//   · missed without decision → overdue filings move there and ask nobody
import { beforeEach, describe, expect, it } from "vitest";
import { ObligationVocabularyService } from "../../src/usecase/obligation/vocabulary";
import type { Actor } from "../../src/domain/ledger/model";
import {
  ConflictingStateFlags,
  LastDestinationState,
  LastInitialState,
  VocabularyCodeTaken,
} from "../../src/domain/obligation/errors";
import {
  DEFAULT_OBLIGATION_STATES,
  DEFAULT_RESOLUTION_OPTIONS,
  missedState,
  resolutionState,
  type ObligationState,
  type ResolutionOption,
} from "../../src/domain/obligation/model";
import {
  FakeObligationStateRepo,
  FakeResolutionOptionRepo,
} from "../../src/testfakes/obligation";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";

const TENANT = "00000000-0000-4000-8000-0000000000aa";
const ACTOR: Actor = { type: "human", id: "00000000-0000-4000-8000-000000000001" };

function uuid(tag: string, n: number): string {
  return `00000000-0000-4000-8000-${tag}${String(n).padStart(8, "0")}`;
}

function harness() {
  const states = new FakeObligationStateRepo();
  const resolutionOptions = new FakeResolutionOptionRepo();
  const events = new RecordingEventSink();

  states.rows.push(
    ...DEFAULT_OBLIGATION_STATES.map(
      (s, i): ObligationState => ({
        ...s,
        id: uuid("5747", i),
        tenantId: TENANT,
        isActive: true,
      }),
    ),
  );
  resolutionOptions.rows.push(
    ...DEFAULT_RESOLUTION_OPTIONS.map(
      (o, i): ResolutionOption => ({
        ...o,
        id: uuid("0971", i),
        tenantId: TENANT,
        status: "unconfirmed",
        isActive: true,
      }),
    ),
  );

  const service = new ObligationVocabularyService({
    states,
    resolutionOptions,
    ids: new FakeIds(),
    events,
  });

  const idOf = (code: string): string => {
    const found = states.rows.find((s) => s.code === code);
    if (!found) throw new Error(`no state ${code}`);
    return found.id;
  };

  return { service, states, resolutionOptions, events, idOf };
}

describe("renaming a compliance state", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("changes the NAME and leaves the handle and every flag alone", async () => {
    // The whole promise: a firm calls it what it calls it, and nothing about
    // how the product behaves moves. `code` is identity and is never renamed
    // from a screen — it is also never compared by any rule, which is what
    // makes the rename free.
    const before = h.states.rows.find((s) => s.code === "missed");
    const after = await h.service.updateState(
      { tenantId: TENANT, stateId: h.idOf("missed"), name: "Late — needs a call" },
      ACTOR,
    );
    expect(after.name).toBe("Late — needs a call");
    expect(after.code).toBe("missed");
    expect(after.isMissed).toBe(true);
    expect(after.needsDecision).toBe(before?.needsDecision);
  });

  it("records both sides of the change", async () => {
    // "The flag moved" is not the useful fact a year later. "It stopped being
    // the missed state on the 4th, which is why nothing reached the queue after
    // that" is.
    await h.service.updateState(
      { tenantId: TENANT, stateId: h.idOf("missed"), name: "Late" },
      ACTOR,
    );
    const [written] = h.events.recorded.filter((e) => e.verb === "obligation_state.updated");
    expect(written?.payload).toMatchObject({ nameFrom: "Missed", nameTo: "Late" });
  });

  it("records nothing when the patch changes nothing", async () => {
    await h.service.updateState(
      { tenantId: TENANT, stateId: h.idOf("missed"), name: "Missed" },
      ACTOR,
    );
    expect(h.events.recorded).toHaveLength(0);
  });
});

describe("moving a destination flag", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("takes it off whoever held it, in one step", async () => {
    // Marking rather than unticking-then-ticking, so there is never an instant
    // where the firm has none — and so the partial unique index does not refuse
    // a perfectly ordinary change.
    await h.service.createState(
      {
        tenantId: TENANT,
        code: "chasing",
        name: "Chasing",
        needsDecision: true,
        isMissed: true,
        sortOrder: 45,
      },
      ACTOR,
    );
    const held = h.states.rows.filter((s) => s.isMissed);
    expect(held).toHaveLength(1);
    expect(held[0]?.code).toBe("chasing");
    // And the rule reading it follows, because it reads the flag.
    expect(missedState(h.states.rows)?.code).toBe("chasing");
  });

  it("REFUSES to leave the firm with nowhere for a missed filing to go", async () => {
    // The refusal that matters most, because its failure is invisible: with no
    // missed state the nightly sweep throws and no overdue filing ever reaches
    // a partner again. The message says what stops working, not which
    // constraint fired.
    await expect(
      h.service.updateState(
        { tenantId: TENANT, stateId: h.idOf("missed"), isMissed: false },
        ACTOR,
      ),
    ).rejects.toThrow(LastDestinationState);
  });

  it("refuses to RETIRE the row holding one, which is the same hole", async () => {
    // `missedState` skips inactive rows, so retiring the holder leaves the firm
    // with none exactly as unticking does. Two roads, one refusal — closing
    // only the first leaves the second, and the second is the one somebody
    // actually walks while tidying up.
    await expect(
      h.service.updateState(
        { tenantId: TENANT, stateId: h.idOf("missed"), isActive: false },
        ACTOR,
      ),
    ).rejects.toThrow(LastDestinationState);
  });

  it("refuses to leave the firm with no starting state", async () => {
    await expect(
      h.service.updateState(
        { tenantId: TENANT, stateId: h.idOf("pending"), isInitial: false },
        ACTOR,
      ),
    ).rejects.toThrow(LastInitialState);
  });

  it("refuses to leave a decision with nowhere to land", async () => {
    await expect(
      h.service.updateState(
        { tenantId: TENANT, stateId: h.idOf("resolved"), isResolution: false },
        ACTOR,
      ),
    ).rejects.toThrow(LastDestinationState);
    expect(resolutionState(h.states.rows)?.code).toBe("resolved");
  });
});

describe("flag combinations a state cannot hold", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("refuses a missed state that asks nobody", async () => {
    // A firm could otherwise point `is_missed` at an ordinary working state,
    // and every overdue filing would move there silently. Indistinguishable
    // from the product not working, on the rows that matter most.
    await expect(
      h.service.createState(
        { tenantId: TENANT, code: "quiet", name: "Quiet", isMissed: true },
        ACTOR,
      ),
    ).rejects.toThrow(ConflictingStateFlags);
  });

  it("refuses a filed or resolution state that is not an ending", async () => {
    await expect(
      h.service.createState(
        { tenantId: TENANT, code: "half_filed", name: "Half filed", isFiled: true },
        ACTOR,
      ),
    ).rejects.toThrow(ConflictingStateFlags);
    await expect(
      h.service.createState(
        { tenantId: TENANT, code: "half_done", name: "Half done", isResolution: true },
        ACTOR,
      ),
    ).rejects.toThrow(ConflictingStateFlags);
  });

  it("refuses a state that is both over and waiting on somebody", async () => {
    // 0052's CHECK, restated as a sentence. It is also why Missed is not
    // terminal, which is the entire point of T3.3.
    await expect(
      h.service.createState(
        {
          tenantId: TENANT,
          code: "both",
          name: "Both",
          isTerminal: true,
          needsDecision: true,
        },
        ACTOR,
      ),
    ).rejects.toThrow(ConflictingStateFlags);
  });

  it("refuses a state claiming two destinations", async () => {
    await expect(
      h.service.createState(
        {
          tenantId: TENANT,
          code: "two",
          name: "Two",
          isTerminal: true,
          isFiled: true,
          isResolution: true,
        },
        ACTOR,
      ),
    ).rejects.toThrow(ConflictingStateFlags);
  });

  it("refuses a starting state that needs a decision", async () => {
    // Every obligation the calendar generated would arrive in a partner's
    // queue on the day it was created, months before it was due.
    await expect(
      h.service.createState(
        { tenantId: TENANT, code: "odd", name: "Odd", isInitial: true, needsDecision: true },
        ACTOR,
      ),
    ).rejects.toThrow(ConflictingStateFlags);
  });

  it("refuses a handle the firm already uses", async () => {
    await expect(
      h.service.createState({ tenantId: TENANT, code: "missed", name: "Missed again" }, ACTOR),
    ).rejects.toThrow(VocabularyCodeTaken);
  });
});

describe("the firm's resolution options", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("lets a firm add its own, with its own meaning", async () => {
    const made = await h.service.createResolutionOption(
      {
        tenantId: TENANT,
        code: "client_deregistered",
        name: "Client deregistered mid-year",
        closesWithoutFiling: true,
        sortOrder: 50,
      },
      ACTOR,
    );
    expect(made.closesWithoutFiling).toBe(true);
    // Seeds unconfirmed like the shipped four — a firm's own new option is not
    // automatically a confirmed one either.
    expect(made.status).toBe("unconfirmed");
  });

  it("lets a partner CONFIRM the shipped list is actually theirs", async () => {
    // The four came from a previous vendor's app and match what the firm
    // described — described is not confirmed, and this is where that gap
    // closes. Same word and same reason as a rule's own status.
    const [first] = h.resolutionOptions.rows;
    const after = await h.service.updateResolutionOption(
      { tenantId: TENANT, optionId: first?.id ?? "", status: "confirmed" },
      ACTOR,
    );
    expect(after.status).toBe("confirmed");
  });

  it("has NO floor — a firm may retire every option it was given", async () => {
    // Deliberately unlike the states. The shipped four are somebody else's
    // list, and this firm's real answer may be none of them. What it cannot do
    // is resolve anything until it writes one, and `resolve` refuses by name
    // rather than this screen refusing in advance.
    for (const o of [...h.resolutionOptions.rows]) {
      await h.service.updateResolutionOption(
        { tenantId: TENANT, optionId: o.id, isActive: false },
        ACTOR,
      );
    }
    expect(h.resolutionOptions.rows.every((o) => !o.isActive)).toBe(true);
  });
});
