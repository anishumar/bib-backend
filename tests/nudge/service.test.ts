// The proactive nudge (T6.7) — the rules that decide whether a client is told a
// filing of theirs is coming up.
//
// The at-least-once UNIQUE index, RLS, gate 4 and the day arithmetic are
// database properties and are proven against real Postgres in
// `tests/nudge/sweep.integration.test.ts`. What is here is the arithmetic and
// the refusals: which rungs are due, what the sweep may not do, and the two
// places this ladder is deliberately the MIRROR of the chaser rather than a copy
// of it.
import { describe, expect, it } from "vitest";
import { NudgeService } from "../../src/usecase/nudge/service";
import {
  FakeNudgeCandidates,
  FakeNudgeLadder,
  FakeNudgeRepo,
  FakeNudgeTenants,
} from "../../src/testfakes/nudge";
import { FakeClock } from "../../src/testfakes/clock";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { dueRungs, horizonDays } from "../../src/domain/nudge/model";
import { readNudgeBody, validateBody } from "../../src/domain/config/model";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const COBALT = "00000000-0000-4000-8000-0000000000c1";
const FILING = "00000000-0000-4000-8000-0000000000f1";

/** 7, then 3, then 1 — DESCENDING, because this ladder counts down to a
 *  deadline. The chaser's is ascending, and that difference is the whole reason
 *  these are two config kinds. */
const LADDER = [
  { key: "week", beforeDays: 7, label: "A week to go" },
  { key: "three_days", beforeDays: 3, label: "Three days to go" },
  { key: "eve", beforeDays: 1, label: "Due tomorrow" },
];

function filing(
  over: Partial<{ obligationId: string; daysUntil: number; nudgedRungs: string[] }> = {},
) {
  return {
    obligationId: over.obligationId ?? FILING,
    entityPartyId: COBALT,
    dueOn: "2026-09-20",
    daysUntil: over.daysUntil ?? 30,
    nudgedRungs: over.nudgedRungs ?? [],
  };
}

function svc(
  opts: { ladder?: readonly { key: string; beforeDays: number; label: string }[]; now?: string; zone?: string } = {},
) {
  const ladders = new FakeNudgeLadder();
  if (opts.ladder) ladders.publish(TENANT, opts.ladder);
  const candidates = new FakeNudgeCandidates();
  const nudges = new FakeNudgeRepo();
  const events = new RecordingEventSink();
  const service = new NudgeService({
    timeZones: new FakeFirmTimeZone(opts.zone),
    tenants: new FakeNudgeTenants([TENANT, OTHER]),
    ladders,
    candidates,
    nudges,
    clock: new FakeClock(new Date(opts.now ?? "2026-09-01T00:00:00.000Z")),
    events,
  });
  return { service, ladders, candidates, nudges, events };
}

describe("nothing is set by default", () => {
  it("a firm that has published no ladder tells nobody", async () => {
    // The shipped state, third time this product states it (dunning, escalation,
    // chaser). A client who did not ask to be reminded about their own filings
    // reads an unasked-for reminder as the firm managing them.
    const { service, candidates, nudges } = svc();
    candidates.upcoming(filing({ daysUntil: 0 }));
    const [report] = await service.sweep("2026-09-01");
    expect(report?.sent).toBe(0);
    expect(nudges.written).toHaveLength(0);
  });

  it("returns before it even reads the calendar", async () => {
    // The order matters here more than it does on the chaser: the candidate read
    // is a scan of a firm's whole calendar, not a handful of open asks. A firm
    // that has published nothing costs one config lookup per sweep.
    const { service, candidates } = svc();
    let asked = false;
    const original = candidates.upcomingFilings.bind(candidates);
    candidates.upcomingFilings = (...args: Parameters<typeof original>) => {
      asked = true;
      return original(...args);
    };
    await service.sweepTenant(TENANT, "2026-09-01");
    expect(asked).toBe(false);
  });
});

describe("which rungs are due", () => {
  it("fires a rung when the days left have fallen to its threshold", () => {
    expect(dueRungs(filing({ daysUntil: 7 }), LADDER).map((n) => n.rungKey)).toEqual(["week"]);
    expect(dueRungs(filing({ daysUntil: 8 }), LADDER)).toEqual([]);
  });

  it("catches up on EVERY rung it missed, not just the next one", () => {
    // The dunning sweep's rule, the escalation sweep's, the chaser's — and it is
    // loudest here. A firm whose worker was down from T-8 to T-2 tells the
    // client about every stage they missed hearing about, in one pass, rather
    // than nothing because the machine was asleep when each moment passed.
    //
    // This is why the test is `daysUntil <= beforeDays` and not `===`: with
    // equality a missed sweep is a permanently missed rung, silently.
    expect(dueRungs(filing({ daysUntil: 2 }), LADDER).map((n) => n.rungKey)).toEqual([
      "week",
      "three_days",
    ]);
  });

  it("never re-sends a rung already told", () => {
    expect(
      dueRungs(filing({ daysUntil: 1, nudgedRungs: ["week", "three_days"] }), LADDER).map(
        (n) => n.rungKey,
      ),
    ).toEqual(["eve"]);
  });

  it("snapshots the threshold that fired, not the one in force later", () => {
    // A firm moving its ladder from 7 days to 10 in April must not restate what
    // it sent in March. `client_ask_chase.after_days` and
    // `work_item.sla_days_snapshot` before it.
    const [first] = dueRungs(filing({ daysUntil: 5 }), LADDER);
    expect(first?.beforeDays).toBe(7);
    expect(first?.daysUntil).toBe(5);
  });

  it("takes its window from the LADDER, so a wider rung gets rows", () => {
    // A constant would hand a firm that added a 30-day rung a rung that is due
    // and a query that never offers the row — which fails as SILENCE.
    expect(horizonDays(LADDER)).toBe(7);
    expect(horizonDays([...LADDER, { key: "month", beforeDays: 30, label: "A month" }])).toBe(30);
    expect(horizonDays([])).toBe(0);
  });
});

describe("what the sweep may not do", () => {
  it("holds no seam that could send anything, and no freeze either", () => {
    // TWO structural assertions in one list, and the second is the decision.
    //
    // No transport: P10 is Phase 7, so a nudge RAISES a reminder and the
    // client's filings list shows it. A logging stub that announced a client had
    // been emailed would be the same class of lie as a `scan()` returning clean.
    //
    // And NO `freezes` port. `crm.client_freeze` stops the CHASER and does not
    // reach this ladder (0067): the statutory date is the LAW's and travels
    // whether or not a fee is in dispute, and a freeze is keyed on
    // `client_party_id` while an obligation carries `entity_party_id`. A port
    // that took freezes and ignored them would be worse than none.
    const wired = ["tenants", "timeZones", "ladders", "candidates", "nudges", "clock", "events"];
    const actual = Object.keys(
      (svc().service as unknown as { deps: Record<string, unknown> }).deps,
    ).sort();
    expect(actual).toEqual([...wired].sort());
  });

  it("names the SYSTEM as the actor, because a cron sent it", async () => {
    const { service, candidates, events } = svc({ ladder: LADDER });
    candidates.upcoming(filing({ daysUntil: 3 }));
    await service.sweepTenant(TENANT, "2026-09-01");
    const event = events.recorded.find((e) => e.verb === "obligation.nudged");
    expect(event?.actorType).toBe("system");
    expect(event?.actorId).toBeNull();
  });

  it("writes the event only for rows that were actually created", async () => {
    // At-least-once: pg-boss redelivers and the filing is still due tomorrow.
    // The row is taken by a unique index; the LEDGER stays honest because the
    // event follows what came back from the insert rather than what was wanted.
    const { service, candidates, events } = svc({ ladder: LADDER });
    candidates.upcoming(filing({ daysUntil: 3 }));
    await service.sweepTenant(TENANT, "2026-09-01");
    await service.sweepTenant(TENANT, "2026-09-01");
    expect(events.recorded.filter((e) => e.verb === "obligation.nudged")).toHaveLength(2);
  });

  it("reports the duplicates rather than hiding them", async () => {
    const { service, candidates } = svc({ ladder: LADDER });
    candidates.upcoming(filing({ daysUntil: 1 }));
    await service.sweepTenant(TENANT, "2026-09-01");
    const second = await service.sweepTenant(TENANT, "2026-09-01");
    expect(second.sent).toBe(0);
    expect(second.alreadySent).toBe(3);
  });
});

describe("one firm's bad data never stops the others", () => {
  it("reports a failure and carries on down the list", async () => {
    // T3.1's lesson, where one firm with no work states stopped the calendar for
    // every firm after it. Reported rather than swallowed: a firm silently
    // skipped forever is worse than a sweep that stops.
    const { service, ladders, candidates } = svc({ ladder: LADDER });
    ladders.publish(OTHER, LADDER);
    candidates.upcoming(filing({ daysUntil: 1 }));
    const original = candidates.upcomingFilings.bind(candidates);
    let calls = 0;
    candidates.upcomingFilings = (...args: Parameters<typeof original>) => {
      calls += 1;
      if (calls === 1) throw new Error("this firm's calendar is broken");
      return original(...args);
    };
    const reports = await service.sweep("2026-09-01");
    expect(reports[0]?.failure).toContain("broken");
    expect(reports[1]?.sent).toBe(3);
  });
});

describe("the ladder a firm writes down", () => {
  it("refuses rungs that do not count DOWN, which is where it mirrors the chaser", () => {
    // `validateChaserBody` demands ASCENDING afterDays because its ladder runs
    // away from a day in the past. This one runs towards a day in the future.
    // Same "one subject, one sequence" rule, pointing the other way — and a firm
    // that wrote 1 before 7 has made a mistake about its own cadence.
    expect(
      validateBody("nudge", {
        rungs: [
          { key: "eve", beforeDays: 1, label: "Tomorrow" },
          { key: "week", beforeDays: 7, label: "A week" },
        ],
      }),
    ).toContain("counts down to a deadline");
    expect(validateBody("nudge", { rungs: LADDER })).toBeNull();
  });

  it("refuses an empty ladder, because publishing none already means that", () => {
    expect(validateBody("nudge", { rungs: [] })).toContain("non-empty");
  });

  it("refuses a duplicate key, which would silently never fire", () => {
    expect(
      validateBody("nudge", {
        rungs: [
          { key: "week", beforeDays: 7, label: "A week" },
          { key: "week", beforeDays: 3, label: "Three days" },
        ],
      }),
    ).toContain("appears twice");
  });

  it("allows beforeDays 0 — 'tell them this morning' is a real cadence", () => {
    expect(
      validateBody("nudge", { rungs: [{ key: "today", beforeDays: 0, label: "Due today" }] }),
    ).toBeNull();
  });

  it("drops a malformed rung rather than defaulting it to 0", () => {
    // Fail-closed, the reading `readChaserBody` and `readEscalationBody` both
    // take. A rung with no usable `beforeDays` read as 0 would tell a client
    // about a filing on the morning it is due and never before — the loudest
    // possible misreading of a cadence somebody wrote down carefully.
    const body = readNudgeBody({
      rungs: [{ key: "week", beforeDays: "soon", label: "A week" }, { key: "eve", beforeDays: 1 }],
    });
    expect(body.rungs).toEqual([{ key: "eve", beforeDays: 1, label: "eve" }]);
  });

  it("sorts on the way OUT, furthest from the deadline first", () => {
    // Never on the way in: the validator refuses an out-of-order ladder so a
    // firm learns about its own mistake, while this is a stored body that may
    // predate a rule or have been hand-edited.
    const body = readNudgeBody({
      rungs: [
        { key: "eve", beforeDays: 1, label: "Tomorrow" },
        { key: "week", beforeDays: 7, label: "A week" },
      ],
    });
    expect(body.rungs.map((r) => r.key)).toEqual(["week", "eve"]);
  });
});

describe("which day it is, for the firm (T6.14)", () => {
  it("asks the calendar about the FIRM's day, not Greenwich's", async () => {
    // 20:00 UTC on 19 September is already the 20th in Kolkata, and "due in
    // one day" is a different filing on each of those days.
    const now = "2026-09-19T20:00:00.000Z";

    const kolkata = svc({ ladder: LADDER, now, zone: "Asia/Kolkata" });
    await kolkata.service.sweep();
    expect(kolkata.candidates.askedOn).toBe("2026-09-20");

    const greenwich = svc({ ladder: LADDER, now, zone: "UTC" });
    await greenwich.service.sweep();
    expect(greenwich.candidates.askedOn).toBe("2026-09-19");
  });
});
