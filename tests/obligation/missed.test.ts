// A missed deadline is a state, and the decision about it is a record (T3.3).
//
// ── WHAT THESE TESTS ARE ACTUALLY GUARDING ─────────────────────────────────
//
// Not "does the sweep flag a late row" — that is the easy half and it would
// pass against a wrong implementation. The expensive failures here are all
// SILENT, and each one has a test named after the silence:
//
//   · a firm renames "Missed" and the sweep stops working. The demo this was
//     built from looked the state up by `code`, so this is not hypothetical.
//   · a row goes back to work after a decision and is re-flagged every night
//     forever, asking a partner the same question every morning.
//   · a newly onboarded firm's first morning is four hundred filings it made
//     in Excel months ago.
//   · a decision is recorded with no reason, and eighteen months later nobody
//     can answer the client asking what the penalty was for.
import { beforeEach, describe, expect, it } from "vitest";
import { ObligationService } from "../../src/usecase/obligation/service";
import type { Actor } from "../../src/domain/ledger/model";
import {
  AlreadyDecided,
  NoMissedState,
  NotAwaitingDecision,
  ResolutionOptionNotFound,
  ResolutionOptionRetired,
  ResolutionReasonRequired,
} from "../../src/domain/obligation/errors";
import {
  DEFAULT_OBLIGATION_STATES,
  DEFAULT_RESOLUTION_OPTIONS,
  type ObligationState,
  type ResolutionOption,
} from "../../src/domain/obligation/model";
import {
  FakeCalendarSource,
  FakeRuleServiceLinks,
  FakeCompliancePolicySource,
  FakeObligationExceptionRepo,
  FakeObligationInstanceRepo,
  FakeObligationServices,
  FakeObligationStateRepo,
  FakeObligationTemplateRepo,
  FakeObligationTenants,
  FakeResolutionOptionRepo,
  FakeWorkItemRaiser,
} from "../../src/testfakes/obligation";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";

const TENANT = "00000000-0000-4000-8000-0000000000aa";
const ACTOR: Actor = { type: "human", id: "00000000-0000-4000-8000-000000000001" };
const TODAY = "2026-08-30";

/** The ledger refuses an objectId that is not a uuid — every event has to name
 *  the row it happened to — so the fixtures carry real ones rather than labels. */
function uuid(tag: string, n: number): string {
  return `00000000-0000-4000-8000-${tag}${String(n).padStart(8, "0")}`;
}

function harness(opts: { now?: string; zone?: string } = {}) {
  const states = new FakeObligationStateRepo();
  const resolutionOptions = new FakeResolutionOptionRepo();
  const instances = new FakeObligationInstanceRepo();
  const compliancePolicy = new FakeCompliancePolicySource();
  const events = new RecordingEventSink();
  const ids = new FakeIds();

  // The firm's vocabulary, exactly as `createTenant` seeds it. Built through
  // the fake's own store rather than through `seedDefaultStates`, so a test
  // about the SWEEP does not fail because seeding changed.
  const stateRows = DEFAULT_OBLIGATION_STATES.map(
    (s, i): ObligationState => ({ ...s, id: uuid("5747", i), tenantId: TENANT, isActive: true }),
  );
  states.rows.push(...stateRows);
  instances.states = states.rows;

  const optionRows = DEFAULT_RESOLUTION_OPTIONS.map(
    (o, i): ResolutionOption => ({
      ...o,
      id: uuid("0971", i),
      tenantId: TENANT,
      status: "unconfirmed",
      isActive: true,
    }),
  );
  resolutionOptions.rows.push(...optionRows);

  const service = new ObligationService({
    timeZones: new FakeFirmTimeZone(opts.zone),
    templates: new FakeObligationTemplateRepo(),
    exceptions: new FakeObligationExceptionRepo(),
    states,
    resolutionOptions,
    instances,
    compliancePolicy,
    calendarSource: new FakeCalendarSource(),
    links: new FakeRuleServiceLinks(),
    services: new FakeObligationServices(),
    workItems: new FakeWorkItemRaiser(),
    tenants: new FakeObligationTenants(),
    ids,
    clock: { now: () => new Date(opts.now ?? `${TODAY}T00:00:00Z`) },
    events,
  });

  const byCode = (code: string): ObligationState => {
    const found = stateRows.find((s) => s.code === code);
    if (!found) throw new Error(`no seeded state ${code}`);
    return found;
  };
  const optionByCode = (code: string): ResolutionOption => {
    const found = optionRows.find((o) => o.code === code);
    if (!found) throw new Error(`no seeded option ${code}`);
    return found;
  };

  /** One obligation, in whatever state, due on whatever date. */
  let n = 0;
  const given = (opts: {
    statutoryDueOn: string;
    stateCode?: string;
    filedOn?: string | null;
    /** Taken off the calendar when its service stopped including it (0309). */
    withdrawnAt?: string | null;
  }): string => {
    n += 1;
    const id = uuid("0b11", n);
    instances.rows.push({
      id,
      tenantId: TENANT,
      templateId: "GSTR-3B",
      entityPartyId: "entity-1",
      engagementId: null,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      periodLabel: "Jul 2026",
      statutoryDueOn: opts.statutoryDueOn,
      internalTargetOn: opts.statutoryDueOn,
      stateId: byCode(opts.stateCode ?? "pending").id,
      workItemId: null,
      filedOn: opts.filedOn ?? null,
      filedByWorkItemId: null,
      resolutionOptionId: null,
      resolutionReason: null,
      resolvedAt: null,
      withdrawnAt: opts.withdrawnAt ?? null,
      withdrawnByUserId: null,
      withdrawnReason: opts.withdrawnAt ? "service_unlinked" : null,
    });
    return id;
  };

  // Reads the LIVE store, not the snapshot the fixtures were built from. A
  // test that renames a state replaces the row in `states.rows`, and reading
  // the snapshot would report the old name — which would have made the rename
  // test pass for the wrong reason, or fail while the code was right.
  const stateOf = (id: string): string => {
    const row = instances.rows.find((r) => r.id === id);
    const st = states.rows.find((s) => s.id === row?.stateId);
    return st?.code ?? "?";
  };

  return {
    service, states, stateRows, resolutionOptions, instances, compliancePolicy, events,
    byCode, optionByCode, given, stateOf,
  };
}

describe("the sweep — a deadline that passed with nothing filed", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("moves an overdue filing into the firm's missed state", async () => {
    const id = h.given({ statutoryDueOn: "2026-08-20" });
    expect(await h.service.markMissed(TENANT, TODAY, ACTOR)).toBe(1);
    expect(h.stateOf(id)).toBe("missed");
  });

  it("writes obligation.missed per FILING, with how late it is", async () => {
    h.given({ statutoryDueOn: "2026-08-20" });
    await h.service.markMissed(TENANT, TODAY, ACTOR);
    const written = h.events.recorded.filter((e) => e.verb === "obligation.missed");
    expect(written).toHaveLength(1);
    // The one number a partner asks for, computed once here rather than by
    // whoever reads the log. 20 Aug to 30 Aug.
    expect(written[0]?.payload).toMatchObject({ statutoryDueOn: "2026-08-20", daysLate: 10 });
  });

  it("carries no reason and no client name into the log", async () => {
    // §3.4 of the event contract, checked at the one verb most likely to want
    // to break it. The row this event names is a filing for a named company;
    // the log must be able to say WHICH filing without saying whose.
    h.given({ statutoryDueOn: "2026-08-20" });
    await h.service.markMissed(TENANT, TODAY, ACTOR);
    const payload = JSON.stringify(h.events.recorded[0]?.payload ?? {});
    expect(payload).not.toMatch(/entity-1|Jul 2026/);
  });

  it("leaves a filing due TODAY alone", async () => {
    // The boundary that decides on-time from late. Due today is not late.
    const id = h.given({ statutoryDueOn: TODAY });
    expect(await h.service.markMissed(TENANT, TODAY, ACTOR)).toBe(0);
    expect(h.stateOf(id)).toBe("pending");
  });

  it("leaves a filing that was actually FILED alone, however late", async () => {
    const id = h.given({ statutoryDueOn: "2026-01-01", stateCode: "filed", filedOn: "2026-03-01" });
    expect(await h.service.markMissed(TENANT, TODAY, ACTOR)).toBe(0);
    expect(h.stateOf(id)).toBe("filed");
  });

  it("never flags a WITHDRAWN filing, even once its date has passed (T6.16)", async () => {
    // It was upcoming when its service stopped including it, and crosses its
    // date later. Flagging it would fill the decision queue with returns the
    // firm stopped doing, which is 2026-09-18 again.
    const id = h.given({ statutoryDueOn: "2026-01-01", withdrawnAt: "2025-12-20T10:00:00.000Z" });
    expect(await h.service.markMissed(TENANT, TODAY, ACTOR)).toBe(0);
    expect(h.stateOf(id)).toBe("pending");
    expect(h.events.verbs()).not.toContain("obligation.missed");
  });

  it("does not flag the same filing twice", async () => {
    // THE IDEMPOTENCY STORY, and there is no machinery behind it: the missed
    // state carries `needsDecision`, so `canStillBeMissed` is false and the
    // next sweep does not see the row. A second event would mean a partner's
    // queue counting one filing twice.
    h.given({ statutoryDueOn: "2026-08-20" });
    expect(await h.service.markMissed(TENANT, TODAY, ACTOR)).toBe(1);
    expect(await h.service.markMissed(TENANT, TODAY, ACTOR)).toBe(0);
    expect(h.events.recorded.filter((e) => e.verb === "obligation.missed")).toHaveLength(1);
  });

  it("STILL WORKS WHEN THE FIRM RENAMES 'Missed' TO SOMETHING ELSE", async () => {
    // The bug the demo shipped, and the reason every rule here reads a flag.
    // Its sweep looked the state up by the literal 'missed', so this rename
    // would have switched the whole mechanism off in silence — on exactly the
    // rows a firm most needs to trust.
    const missed = h.byCode("missed");
    const i = h.states.rows.findIndex((s) => s.id === missed.id);
    h.states.rows[i] = { ...missed, code: "overdue", name: "Chasing" };

    const id = h.given({ statutoryDueOn: "2026-08-20" });
    expect(await h.service.markMissed(TENANT, TODAY, ACTOR)).toBe(1);
    expect(h.stateOf(id)).toBe("overdue");
  });

  it("refuses by NAME when the firm has nowhere for a missed filing to go", async () => {
    // Raised rather than swallowed. Quietly leaving it open is the silent
    // failure this module is built against — and the message names the screen
    // that fixes it, which is only honest because that screen now exists.
    const missed = h.byCode("missed");
    const i = h.states.rows.findIndex((s) => s.id === missed.id);
    h.states.rows[i] = { ...missed, isMissed: false };

    h.given({ statutoryDueOn: "2026-08-20" });
    await expect(h.service.markMissed(TENANT, TODAY, ACTOR)).rejects.toThrow(NoMissedState);
  });

  it("costs nothing when a firm has nothing overdue", async () => {
    // The ordinary night at every firm. The state list is read only after the
    // candidates come back empty-handed, so most sweeps do one query.
    h.given({ statutoryDueOn: "2026-12-20" });
    expect(await h.service.markMissed(TENANT, TODAY, ACTOR)).toBe(0);
  });
});

describe("the go-live floor — a firm's first morning", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("asks about EVERYTHING when the firm has published no floor", async () => {
    // Unset is a real answer and it means no floor, unlike the discount policy
    // where silence means zero. The direction is chosen: a hidden missed
    // deadline is the failure this module exists to prevent.
    h.given({ statutoryDueOn: "2025-04-20" });
    h.given({ statutoryDueOn: "2026-08-20" });
    expect(await h.service.markMissed(TENANT, TODAY, ACTOR)).toBe(2);
  });

  it("stops asking about filings that fell due before the firm went live", async () => {
    // The scenario that makes this exist: a firm onboarding with engagements
    // dated months back gets obligations it already filed in Excel. Without
    // this its first decision queue is hundreds of answered questions, and the
    // one screen whose value is being trusted is not.
    h.compliancePolicy.floor = "2026-08-01";
    const old = h.given({ statutoryDueOn: "2026-04-20" });
    const recent = h.given({ statutoryDueOn: "2026-08-20" });

    expect(await h.service.markMissed(TENANT, TODAY, ACTOR)).toBe(1);
    expect(h.stateOf(old)).toBe("pending");
    expect(h.stateOf(recent)).toBe("missed");
  });

  it("includes a filing due ON the floor date", async () => {
    // "From here" includes here. An exclusive bound would silently skip one
    // day's filings and nothing would ever say so.
    h.compliancePolicy.floor = "2026-08-20";
    const id = h.given({ statutoryDueOn: "2026-08-20" });
    expect(await h.service.markMissed(TENANT, TODAY, ACTOR)).toBe(1);
    expect(h.stateOf(id)).toBe("missed");
  });
});

describe("the decision — what a partner chose, and why", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  async function missedOne(): Promise<string> {
    const id = h.given({ statutoryDueOn: "2026-08-20" });
    await h.service.markMissed(TENANT, TODAY, ACTOR);
    return id;
  }

  it("puts an overdue filing in the queue and takes it out once decided", async () => {
    const id = await missedOne();
    expect((await h.service.decisionQueue(TENANT)).map((r) => r.id)).toEqual([id]);

    await h.service.resolve(
      TENANT,
      id,
      { optionId: h.optionByCode("late_fee").id, reason: "client sent books on the 19th" },
      ACTOR,
    );
    expect(await h.service.decisionQueue(TENANT)).toHaveLength(0);
  });

  it("REFUSES A DECISION WITH NO REASON", async () => {
    // The whole point of the endpoint. The option says what was done and can be
    // counted; this says why, and it is what answers the client who asks in
    // eighteen months what the penalty was for.
    const id = await missedOne();
    await expect(
      h.service.resolve(
        TENANT,
        id,
        { optionId: h.optionByCode("late_fee").id, reason: "   " },
        ACTOR,
      ),
    ).rejects.toThrow(ResolutionReasonRequired);
  });

  it("sends it BACK TO WORK when the option does not close it", async () => {
    // "Accept the late fee" means the filing still has to happen. It returns to
    // the firm's initial state, where `raise` picks it up again — and 0054
    // files it, late, when that work finishes. Nothing in T3.3 has to know how
    // it ends, which is why the fork is a column and not a branch.
    const id = await missedOne();
    await h.service.resolve(
      TENANT,
      id,
      { optionId: h.optionByCode("late_fee").id, reason: "penalty is smaller than the ITC loss" },
      ACTOR,
    );
    expect(h.stateOf(id)).toBe("pending");
  });

  it("ENDS it when the option says it will never be filed", async () => {
    const id = await missedOne();
    await h.service.resolve(
      TENANT,
      id,
      { optionId: h.optionByCode("not_applicable").id, reason: "entity deregistered in June" },
      ACTOR,
    );
    expect(h.stateOf(id)).toBe("resolved");
  });

  it("DOES NOT ASK AGAIN TOMORROW after sending one back to work", async () => {
    // The loop this would otherwise be. The statutory date is in the past
    // forever, so without `resolved_at` the next sweep re-flags it and the
    // partner is asked the same question every morning until the filing is
    // made. Found by reasoning about the state machine, not by a symptom —
    // which is why it is a column and not only a ledger event: the sweep's
    // WHERE clause cannot read the ledger.
    const id = await missedOne();
    await h.service.resolve(
      TENANT,
      id,
      { optionId: h.optionByCode("provisional_filing").id, reason: "figures are provisional" },
      ACTOR,
    );
    expect(h.stateOf(id)).toBe("pending");

    expect(await h.service.markMissed(TENANT, "2026-08-31", ACTOR)).toBe(0);
    expect(h.stateOf(id)).toBe("pending");
  });

  it("writes the OPTION into the log and never the reason", async () => {
    // §3.4 again, and here it is the sharpest: the reason is a partner's free
    // text about a client and may name a person, in a log that cannot be
    // erased. The option is a code the firm defined, so "how many late fees
    // this quarter" stays answerable without it.
    const id = await missedOne();
    await h.service.resolve(
      TENANT,
      id,
      { optionId: h.optionByCode("late_fee").id, reason: "Priya was on leave" },
      ACTOR,
    );
    const written = h.events.recorded.filter((e) => e.verb === "obligation.resolved");
    expect(written).toHaveLength(1);
    expect(written[0]?.payload).toMatchObject({
      resolutionCode: "late_fee",
      closesWithoutFiling: false,
      daysLate: 10,
    });
    expect(JSON.stringify(written[0]?.payload)).not.toMatch(/Priya/);
  });

  it("never overwrites a decision already taken", async () => {
    // A double-submitted form, or somebody changing their mind. The first
    // decision is the record; replacing it would destroy the only copy of what
    // was originally chosen and why.
    const id = await missedOne();
    await h.service.resolve(
      TENANT,
      id,
      { optionId: h.optionByCode("late_fee").id, reason: "first answer" },
      ACTOR,
    );
    await expect(
      h.service.resolve(
        TENANT,
        id,
        { optionId: h.optionByCode("nil_return").id, reason: "second answer" },
        ACTOR,
      ),
    ).rejects.toThrow(AlreadyDecided);
    expect(h.events.recorded.filter((e) => e.verb === "obligation.resolved")).toHaveLength(1);
  });

  it("refuses to decide about a filing that is not waiting on one", async () => {
    // A stale screen, or somebody with the id. Without this any row at all
    // could be "resolved", including one somebody is actively working — and
    // the queue would stop meaning anything.
    const id = h.given({ statutoryDueOn: "2026-12-20" });
    await expect(
      h.service.resolve(
        TENANT,
        id,
        { optionId: h.optionByCode("late_fee").id, reason: "why not" },
        ACTOR,
      ),
    ).rejects.toThrow(NotAwaitingDecision);
  });

  it("refuses an option this firm does not have", async () => {
    const id = await missedOne();
    await expect(
      h.service.resolve(
        TENANT,
        id,
        { optionId: "00000000-0000-4000-8000-00000000ffff", reason: "x" },
        ACTOR,
      ),
    ).rejects.toThrow(ResolutionOptionNotFound);
  });

  it("refuses an option the firm has RETIRED, and keeps the row", async () => {
    // A retired option still explains decisions already recorded against it —
    // nothing is deleted — but a firm that retired one has stopped choosing it.
    const id = await missedOne();
    const late = h.optionByCode("late_fee");
    const i = h.resolutionOptions.rows.findIndex((o) => o.id === late.id);
    h.resolutionOptions.rows[i] = { ...late, isActive: false };

    await expect(
      h.service.resolve(TENANT, id, { optionId: late.id, reason: "x" }, ACTOR),
    ).rejects.toThrow(ResolutionOptionRetired);
  });

  it("orders the queue OLDEST FIRST", async () => {
    // The row late longest is the one costing the most, and it is the one a
    // date-windowed list would have dropped off the bottom.
    const older = h.given({ statutoryDueOn: "2026-02-20" });
    const newer = h.given({ statutoryDueOn: "2026-08-20" });
    await h.service.markMissed(TENANT, TODAY, ACTOR);
    expect((await h.service.decisionQueue(TENANT)).map((r) => r.id)).toEqual([older, newer]);
  });
});

describe("which day it is, for the firm (T6.14)", () => {
  it("flags MISSED on the firm's calendar, not Greenwich's", async () => {
    // 20:00 UTC on the 29th is 01:30 on the 30th in Kolkata: for the firm the
    // 29th has passed with nothing filed; for a server on UTC it is still the
    // 29th and the filing is "due today", which is left alone.
    const now = "2026-08-29T20:00:00Z";

    const kolkata = harness({ now, zone: "Asia/Kolkata" });
    const late = kolkata.given({ statutoryDueOn: "2026-08-29" });
    expect((await kolkata.service.sweepTenant(TENANT, ACTOR)).missed).toBe(1);
    expect(kolkata.stateOf(late)).toBe("missed");

    const greenwich = harness({ now, zone: "UTC" });
    const notYet = greenwich.given({ statutoryDueOn: "2026-08-29" });
    expect((await greenwich.service.sweepTenant(TENANT, ACTOR)).missed).toBe(0);
    expect(greenwich.stateOf(notYet)).toBe("pending");
  });
});

describe("the decision queue's today (audit 2026-10-03, B44)", () => {
  // The route counted days late from `new Date()`, the server's UTC day and
  // not the injected clock, when the browser sent no day. It is the firm's.
  it("is the firm's day when the caller sends none, and the caller's when it does", async () => {
    const h = harness({ now: "2026-10-02T20:00:00Z", zone: "Asia/Kolkata" });
    expect(await h.service.decisionDay(TENANT)).toBe("2026-10-03");
    expect(await h.service.decisionDay(TENANT, "2026-10-02")).toBe("2026-10-02");
  });
});
