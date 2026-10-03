// The chaser (T4.4) — the rules that decide whether a client hears from the
// firm a second time.
//
// The exclusion constraint, the unique index and RLS are database properties and
// are proven against real Postgres in `tests/chaser/freeze.integration.test.ts`.
// What is here is the arithmetic and the refusals: which rungs are due, what a
// freeze stops, and what the sweep is NOT allowed to do.
import { describe, expect, it } from "vitest";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { ChaserService } from "../../src/usecase/chaser/service";
import {
  FakeChaseCandidates,
  FakeChaseRepo,
  FakeChaserLadder,
  FakeChaserTenants,
  FakeClientFreezeRepo,
} from "../../src/testfakes/chaser";
import { FakeIds } from "../../src/testfakes/ids";
import { FakeClock } from "../../src/testfakes/clock";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import {
  FreezeAlreadyInForce,
  FreezeAlreadyLifted,
  FreezeClientNotFound,
  FreezeInvalidDates,
  FreezeNotFound,
  FreezeReasonRequired,
} from "../../src/domain/chaser/errors";
import { dueRungs, freezeInForceOn } from "../../src/domain/chaser/model";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const COBALT = "00000000-0000-4000-8000-0000000000c1";
const LAKEVIEW = "00000000-0000-4000-8000-0000000000c2";
const PARTNER = "00000000-0000-4000-8000-0000000000e1";
const actor = { type: "human", id: PARTNER } as const;

const LADDER = [
  { key: "first", afterDays: 3, label: "A gentle reminder" },
  { key: "second", afterDays: 7, label: "A second reminder" },
  { key: "final", afterDays: 15, label: "A final reminder" },
];

function ask(over: Partial<{ askId: string; clientPartyId: string; daysOpen: number; chasedRungs: string[] }> = {}) {
  return {
    askId: over.askId ?? "00000000-0000-4000-8000-0000000000a1",
    clientPartyId: over.clientPartyId ?? COBALT,
    workItemId: "00000000-0000-4000-8000-0000000000b1",
    daysOpen: over.daysOpen ?? 0,
    chasedRungs: over.chasedRungs ?? [],
  };
}

function svc(opts: { ladder?: readonly { key: string; afterDays: number; label: string }[] } = {}) {
  const ladders = new FakeChaserLadder();
  if (opts.ladder) ladders.publish(TENANT, opts.ladder);
  const candidates = new FakeChaseCandidates();
  const chases = new FakeChaseRepo();
  const freezes = new FakeClientFreezeRepo().client(COBALT).client(LAKEVIEW);
  const events = new RecordingEventSink();
  const service = new ChaserService({
      timeZones: new FakeFirmTimeZone(),
    tenants: new FakeChaserTenants([TENANT, OTHER]),
    ladders,
    candidates,
    chases,
    freezes,
    ids: new FakeIds(),
    clock: new FakeClock(new Date("2026-09-01T00:00:00.000Z")),
    events,
  });
  return { service, ladders, candidates, chases, freezes, events };
}

describe("nothing is set by default", () => {
  it("a firm that has published no ladder chases nobody", async () => {
    // The shipped state, and it is sharper here than on T4.5's inward ladder: an
    // escalation nobody asked for lands on a colleague, and a chase nobody asked
    // for lands on the CLIENT, who reads it as the firm's opinion of them.
    const { service, candidates, chases } = svc();
    candidates.open(ask({ daysOpen: 99 }));
    const [report] = await service.sweep("2026-09-01");
    expect(report?.sent).toBe(0);
    expect(chases.written).toEqual([]);
  });

  it("and it does not even look at the open asks", async () => {
    // Returned before the candidate read, so a firm that has published nothing
    // costs one config lookup per sweep rather than a scan of its asks.
    const { service, candidates } = svc();
    let asked = 0;
    const original = candidates.openAsks.bind(candidates);
    candidates.openAsks = (t, d) => {
      asked += 1;
      return original(t, d);
    };
    await service.sweepTenant(TENANT, "2026-09-01");
    expect(asked).toBe(0);
  });
});

describe("which rungs are due", () => {
  it("takes EVERY due rung, not only the next", () => {
    // A week of downtime must not need seven sweeps to catch up, because the run
    // that finally happens is the one a partner is looking at. The dunning
    // sweep's rule and the escalation sweep's after it.
    const due = dueRungs(ask({ daysOpen: 20 }), LADDER);
    expect(due.map((d) => d.rungKey)).toEqual(["first", "second", "final"]);
  });

  it("never re-sends a rung already climbed", () => {
    const due = dueRungs(ask({ daysOpen: 20, chasedRungs: ["first", "second"] }), LADDER);
    expect(due.map((d) => d.rungKey)).toEqual(["final"]);
  });

  it("sends nothing before the first threshold", () => {
    expect(dueRungs(ask({ daysOpen: 2 }), LADDER)).toEqual([]);
  });

  it("fires ON the threshold day, not after it", () => {
    // `>=`, because a firm writing D+3 means "on day three". Off by one here is
    // a client reminded a day late every single time, which nobody would ever
    // notice from the outside.
    expect(dueRungs(ask({ daysOpen: 3 }), LADDER).map((d) => d.rungKey)).toEqual(["first"]);
  });

  it("copies the threshold onto the row it writes", async () => {
    // Like `escalation_notice` and `work_item.sla_days_snapshot`: a firm
    // changing its cadence in April must not restate what it did in March.
    const { service, candidates, chases } = svc({ ladder: LADDER });
    candidates.open(ask({ daysOpen: 9 }));
    await service.sweepTenant(TENANT, "2026-09-01");
    expect(chases.written.map((c) => ({ rung: c.rungKey, at: c.afterDays, open: c.daysOpen })))
      .toEqual([
        { rung: "first", at: 3, open: 9 },
        { rung: "second", at: 7, open: 9 },
      ]);
  });
});

describe("what a freeze stops", () => {
  it("skips a frozen client and COUNTS them", async () => {
    // The count is the point. A sweep that sent nothing because everybody is
    // frozen and one that sent nothing because it is broken look identical from
    // the outside, and only one of them is somebody's to fix.
    const { service, candidates, chases } = svc({ ladder: LADDER });
    candidates.open(ask({ daysOpen: 9 }));
    candidates.open(ask({ askId: "00000000-0000-4000-8000-0000000000a2", clientPartyId: LAKEVIEW, daysOpen: 9 }));
    candidates.freeze(COBALT);

    const report = await service.sweepTenant(TENANT, "2026-09-01");
    expect(report.frozen).toBe(1);
    expect(chases.written.map((c) => c.clientPartyId)).toEqual([LAKEVIEW, LAKEVIEW]);
  });

  it("is half-open — the first day NOT in force is the end", () => {
    // `[from, to)`, like every other effective-dated row in this schema. Getting
    // this wrong is a client chased on the day a partner froze them.
    expect(freezeInForceOn("2026-09-01", "2026-09-10", "2026-09-01")).toBe(true);
    expect(freezeInForceOn("2026-09-01", "2026-09-10", "2026-09-09")).toBe(true);
    expect(freezeInForceOn("2026-09-01", "2026-09-10", "2026-09-10")).toBe(false);
    expect(freezeInForceOn("2026-09-01", null, "2099-01-01")).toBe(true);
    expect(freezeInForceOn("2026-09-01", "2026-09-10", "2026-08-31")).toBe(false);
  });
});

describe("what the sweep may not do", () => {
  it("holds no seam that could send anything", () => {
    // The board's hard limit — "it never contacts anybody outside a channel the
    // firm configured" — met by there being no channel at all rather than by a
    // check somebody could delete. Asserted structurally: if a mailer, a
    // notifier or a transport ever appears in Deps, this goes red and somebody
    // has to justify it here.
    const wired = [
      "tenants",
      "ladders",
      "candidates",
      "chases",
      "freezes",
      // ADDED DELIBERATELY (0071). A `FirmTimeZone` is read-only and answers
      // ONE question — which calendar the sweep counts days on — so it is not a
      // channel and holds no seam that could send anything. It is listed here
      // because this test exists to make every addition to `Deps` a decision
      // somebody wrote down, and that includes the harmless ones: a list that
      // only ever grew by exception would stop being read.
      "timeZones",
      "ids",
      "clock",
      "events",
    ];
    const actual = Object.keys(
      (svc().service as unknown as { deps: Record<string, unknown> }).deps,
    ).sort();
    expect(actual).toEqual([...wired].sort());
  });

  it("names the SYSTEM as the actor, because a cron sent it", async () => {
    // Nobody at the firm decided to send this one. Who wrote the ladder is a
    // config event; who raised the ask is `client_ask.raised`. Naming a person
    // here would credit them with a decision a cron made.
    const { service, candidates, events } = svc({ ladder: LADDER });
    candidates.open(ask({ daysOpen: 3 }));
    await service.sweepTenant(TENANT, "2026-09-01");
    const event = events.recorded.find((e) => e.verb === "client_ask.chased");
    expect(event?.actorType).toBe("system");
    expect(event?.actorId).toBeNull();
  });

  it("writes the event only for rows that were actually created", async () => {
    // At-least-once. pg-boss redelivers and the ask is still open tomorrow;
    // neither may remind a client twice, and this is what keeps "we reminded you
    // four times" a sentence the count supports.
    const { service, candidates, chases, events } = svc({ ladder: LADDER });
    candidates.open(ask({ daysOpen: 9 }));
    chases.alreadyTaken(ask().askId, "first");

    const report = await service.sweepTenant(TENANT, "2026-09-01");
    expect(report.sent).toBe(1);
    expect(report.alreadySent).toBe(1);
    expect(events.recorded.filter((e) => e.verb === "client_ask.chased")).toHaveLength(1);
  });

  it("one firm's failure never stops the others", async () => {
    // T3.1's lesson, where one firm with no work states stopped the calendar for
    // every firm after it in the list. Reported rather than swallowed.
    const { service, ladders } = svc({ ladder: LADDER });
    ladders.ladderFor = (tenantId) =>
      tenantId === TENANT
        ? Promise.reject(new Error("this firm's config is broken"))
        : Promise.resolve([]);
    const reports = await service.sweep("2026-09-01");
    expect(reports).toHaveLength(2);
    expect(reports[0]?.failure).toContain("broken");
    expect(reports[1]?.failure).toBeUndefined();
  });
});

describe("setting and lifting a freeze", () => {
  it("insists on a reason", async () => {
    // "Why is this client not being chased" is asked months later by somebody
    // who did not set it.
    const { service } = svc();
    await expect(
      service.freeze({
        tenantId: TENANT,
        clientPartyId: COBALT,
        validFrom: "2026-09-01",
        validTo: null,
        reason: "   ",
        actor,
      }),
    ).rejects.toBeInstanceOf(FreezeReasonRequired);
  });

  it("refuses a freeze in force on no day", async () => {
    // A typo at the moment of freezing. 0065's CHECK allows the shape because
    // LIFTING produces exactly it twenty seconds later; the service allows only
    // the act.
    const { service } = svc();
    await expect(
      service.freeze({
        tenantId: TENANT,
        clientPartyId: COBALT,
        validFrom: "2026-09-01",
        validTo: "2026-09-01",
        reason: "in dispute",
        actor,
      }),
    ).rejects.toBeInstanceOf(FreezeInvalidDates);
  });

  it("refuses a client this firm does not have", async () => {
    const { service } = svc();
    await expect(
      service.freeze({
        tenantId: TENANT,
        clientPartyId: "00000000-0000-4000-8000-00000000dead",
        validFrom: "2026-09-01",
        validTo: null,
        reason: "in dispute",
        actor,
      }),
    ).rejects.toBeInstanceOf(FreezeClientNotFound);
  });

  it("refuses an overlapping freeze IN WORDS, before the constraint says it in SQL", async () => {
    // The constraint still holds under concurrency and against an import; this
    // is what a person is told, and it names the client rather than an index.
    const { service } = svc();
    const set = () =>
      service.freeze({
        tenantId: TENANT,
        clientPartyId: COBALT,
        validFrom: "2026-09-01",
        validTo: null,
        reason: "in dispute over the FY26 audit fee",
        actor,
      });
    await set();
    await expect(set()).rejects.toBeInstanceOf(FreezeAlreadyInForce);
  });

  it("keeps the reason OFF the ledger and ON the row", async () => {
    // §3.4, and the same split `obligation.resolved` makes: a partner's free
    // text about a client, in a log that cannot be erased.
    const { service, events } = svc();
    const record = await service.freeze({
      tenantId: TENANT,
      clientPartyId: COBALT,
      validFrom: "2026-09-01",
      validTo: null,
      reason: "in dispute over the FY26 audit fee",
      actor,
    });
    expect(record.reason).toContain("FY26 audit fee");
    const event = events.recorded.find((e) => e.verb === "client_freeze.set");
    expect(JSON.stringify(event?.payload)).not.toContain("FY26");
    expect(event?.payload).toMatchObject({ clientPartyId: COBALT, validFrom: "2026-09-01" });
  });

  it("lifts TODAY, not tomorrow", async () => {
    // 0061's decision applied a second time: a partner pressing resume expects
    // the next sweep to chase. A row dated tomorrow means one more silent day.
    const { service } = svc();
    const set = await service.freeze({
      tenantId: TENANT,
      clientPartyId: COBALT,
      validFrom: "2026-08-01",
      validTo: null,
      reason: "in dispute",
      actor,
    });
    const lifted = await service.lift({ tenantId: TENANT, freezeId: set.id, actor });
    expect(lifted.validTo).toBe("2026-09-01");
  });

  it("refuses a second lift rather than moving the day chasing resumed", async () => {
    const { service } = svc();
    const set = await service.freeze({
      tenantId: TENANT,
      clientPartyId: COBALT,
      validFrom: "2026-08-01",
      validTo: null,
      reason: "in dispute",
      actor,
    });
    await service.lift({ tenantId: TENANT, freezeId: set.id, actor });
    await expect(
      service.lift({ tenantId: TENANT, freezeId: set.id, actor }),
    ).rejects.toBeInstanceOf(FreezeAlreadyLifted);
  });

  it("refuses a freeze this firm does not have", async () => {
    const { service } = svc();
    await expect(
      service.lift({
        tenantId: TENANT,
        freezeId: "00000000-0000-4000-8000-00000000dead",
        actor,
      }),
    ).rejects.toBeInstanceOf(FreezeNotFound);
  });

  it("keeps the whole history, not only the freeze in force", async () => {
    // "Was this client being chased in March" is the question, and a list of
    // only the current freeze answers it with silence.
    const { service } = svc();
    const first = await service.freeze({
      tenantId: TENANT,
      clientPartyId: COBALT,
      validFrom: "2026-06-01",
      validTo: null,
      reason: "fee dispute",
      actor,
    });
    await service.lift({ tenantId: TENANT, freezeId: first.id, on: "2026-07-01", actor });
    await service.freeze({
      tenantId: TENANT,
      clientPartyId: COBALT,
      validFrom: "2026-08-01",
      validTo: null,
      reason: "scope renegotiation",
      actor,
    });
    const history = await service.history(TENANT, COBALT);
    expect(history).toHaveLength(2);
    expect(history.map((f) => f.reason).sort()).toEqual(["fee dispute", "scope renegotiation"]);
  });
});

describe("the sweep's today is the FIRM's (audit 2026-10-03, B41)", () => {
  // T6.14: a sweep has no caller to say which day it is, so it is the day in
  // the firm's zone. The chaser used the server's UTC day, and the freeze's
  // lift defaulted to it too.
  function kolkata(at: string) {
    const ladders = new FakeChaserLadder();
    ladders.publish(TENANT, LADDER);
    const candidates = new FakeChaseCandidates();
    const freezes = new FakeClientFreezeRepo().client(COBALT);
    const service = new ChaserService({
      timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
      tenants: new FakeChaserTenants([TENANT]),
      ladders,
      candidates,
      chases: new FakeChaseRepo(),
      freezes,
      ids: new FakeIds(),
      // 20:00 UTC on 1 September is 01:30 on the 2nd in India.
      clock: new FakeClock(new Date(at)),
      events: new RecordingEventSink(),
    });
    return { service, candidates, freezes };
  }

  it("asks for open requests on the firm's day when no day is given", async () => {
    const { service, candidates } = kolkata("2026-09-01T20:00:00.000Z");
    await service.sweep();
    await service.sweepTenant(TENANT);
    expect(candidates.askedOn).toEqual(["2026-09-02", "2026-09-02"]);
  });

  it("still takes the day a caller names", async () => {
    const { service, candidates } = kolkata("2026-09-01T20:00:00.000Z");
    await service.sweep("2026-08-30");
    expect(candidates.askedOn).toEqual(["2026-08-30"]);
  });

  it("lifts a freeze on the firm's day", async () => {
    const { service } = kolkata("2026-09-01T20:00:00.000Z");
    const set = await service.freeze({
      tenantId: TENANT,
      clientPartyId: COBALT,
      validFrom: "2026-08-20",
      validTo: null,
      reason: "fee dispute",
      actor,
    });
    const lifted = await service.lift({ tenantId: TENANT, freezeId: set.id, actor });
    expect(lifted.validTo).toBe("2026-09-02");
  });
});
