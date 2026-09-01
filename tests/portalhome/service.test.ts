// The client portal's status home (T6.5) — the rules that are NOT the wall.
//
// Gate 4 is RLS and is proven where it runs, against real Postgres, by dropping
// a policy and watching the reads leak
// (`tests/portal/portal-reads.integration.test.ts`). Nothing in this file could
// establish it, and a fake that filtered by party id would be a second
// implementation of the wall — green, and evidence of nothing.
//
// What IS here is everything the service decides: that the scope is resolved
// once, on the CALLER's day; that an empty scope still reaches the database;
// and that the rows are split into the questions the screen asks, by the right
// predicate. Each of those has a way of being wrong that a reader would not see.
import { describe, expect, it } from "vitest";
import { PortalHomeService } from "../../src/usecase/portalhome/service";
import {
  FakePortalHomeRepo,
  FakePortalScope,
} from "../../src/testfakes/portalhome";
import { FakeClock } from "../../src/testfakes/clock";
import type {
  PortalFilingRow,
  PortalWorkRow,
} from "../../src/domain/portalhome/model";

const FIRM = "00000000-0000-4000-8000-00000000f001";
const MEERA = "00000000-0000-4000-8000-00000000u001";
const NOBODY = "00000000-0000-4000-8000-00000000u002";
const COBALT = "00000000-0000-4000-8000-00000000c001";

// The server is a few hours behind a firm in India for part of every day, and
// this clock sits in that window: 22:30 UTC on the 31st is already the 1st in
// Delhi. That gap is the whole reason `asOf` exists on this route.
const NOW = new Date("2026-08-31T22:30:00.000Z");

function work(over: Partial<PortalWorkRow> = {}): PortalWorkRow {
  return {
    workItemId: "00000000-0000-4000-8000-00000000w001",
    title: "GSTR-3B — August",
    companyName: "Cobalt Foods Private Limited",
    stateName: "In progress",
    isHeldUp: false,
    openedOn: "2026-08-20",
    statutoryDueOn: null,
    heldUpSince: null,
    heldUpReason: null,
    hasOpenAsk: false,
    ...over,
  };
}

function filing(over: Partial<PortalFilingRow> = {}): PortalFilingRow {
  return {
    obligationId: "00000000-0000-4000-8000-00000000o001",
    name: "GSTR-3B",
    companyName: "Cobalt Foods Private Limited",
    periodLabel: "Aug 2026",
    statutoryDueOn: "2026-09-20",
    stateName: "Pending",
    filedOn: null,
    ...over,
  };
}

function world() {
  const scope = new FakePortalScope();
  const rows = new FakePortalHomeRepo();
  scope.granted.set(`${FIRM}:${MEERA}`, [
    { clientPartyId: COBALT, clientName: "Cobalt Foods Private Limited" },
  ]);
  const service = new PortalHomeService({
    scope,
    rows,
    clock: new FakeClock(NOW),
  });
  return { scope, rows, service };
}

describe("the status home", () => {
  it("resolves the scope once and hands the party ids to the read", async () => {
    const { rows, service } = world();
    const home = await service.home(FIRM, MEERA, "2026-09-01");

    expect(home.companies).toEqual([
      { clientPartyId: COBALT, clientName: "Cobalt Foods Private Limited" },
    ]);
    // ONE read, and it carries the scope. Two reads would be two transactions
    // and two `SET LOCAL` scopes, which is the shape a later addition would copy.
    expect(rows.calls).toHaveLength(1);
    expect(rows.calls[0]?.scope).toEqual([COBALT]);
  });

  it("asks the grant table about the CALLER's day, not the server's", async () => {
    // The server is on 2026-08-31 at this instant and the caller is on the 1st.
    // A grant that starts today is not in force yet on the server's day, so a
    // client in Delhi signing in before half past five would be told the firm
    // has given them nothing.
    const { scope, rows, service } = world();
    await service.home(FIRM, MEERA, "2026-09-01");
    expect(scope.askedOn).toBe("2026-09-01");
    expect(rows.calls[0]?.asOf).toBe("2026-09-01");
  });

  it("falls back to the server's day only when the caller did not say", async () => {
    const { scope, service } = world();
    const home = await service.home(FIRM, MEERA);
    expect(scope.askedOn).toBe("2026-08-31");
    // Echoed back, so a screen can show which day the answer was computed for
    // rather than leaving a reader to wonder why a filing due today is missing.
    expect(home.asOf).toBe("2026-08-31");
  });

  it("STILL READS with an empty scope — the one silent mistake available here", async () => {
    // A contact invited and granted nothing. Short-circuiting on the empty list
    // would look identical from outside and is the exact shape that, one layer
    // down, leaves `app.portal` unset — which means STAFF, and every read
    // succeeds. So the call must happen, with an empty scope.
    const { rows, service } = world();
    const home = await service.home(FIRM, NOBODY, "2026-09-01");

    expect(home.companies).toEqual([]);
    expect(rows.calls).toHaveLength(1);
    expect(rows.calls[0]?.scope).toEqual([]);
  });

  it("splits work into what is moving and what is held up", async () => {
    const { rows, service } = world();
    rows.work = [
      work({ workItemId: "w-1", title: "Bookkeeping — August" }),
      work({
        workItemId: "w-2",
        title: "GSTR-3B — Cobalt Logistics — July",
        isHeldUp: true,
        stateName: "Blocked",
        heldUpSince: "2026-08-28",
        heldUpReason:
          "The client has not shared the Maharashtra purchase register.",
      }),
    ];
    const home = await service.home(FIRM, MEERA, "2026-09-01");

    expect(home.inProgress.map((r) => r.workItemId)).toEqual(["w-1"]);
    expect(home.heldUp.map((r) => r.workItemId)).toEqual(["w-2"]);
    // The reason travels. It is the only field that says what the firm is
    // waiting for, and without it the section is a list of titles with no ask.
    expect(home.heldUp[0]?.heldUpReason).toContain("purchase register");
  });

  it("splits filings on `filedOn`, NOT on the state being terminal", async () => {
    // 0052 seeds TWO terminal obligation states — `filed` and `resolved` — and
    // `resolved` is T3.3's end of a deadline already MISSED, which a partner
    // decided about. Telling a client that such a filing has "arrived" is a
    // false statement about a statutory return, which is exactly the failure
    // 0054 closed from the writing side.
    const { rows, service } = world();
    rows.filings = [
      filing({ obligationId: "o-1" }),
      filing({
        obligationId: "o-2",
        stateName: "Filed",
        filedOn: "2026-08-12",
      }),
      filing({
        obligationId: "o-3",
        stateName: "Resolved — late fee accepted",
        filedOn: null,
      }),
    ];
    const home = await service.home(FIRM, MEERA, "2026-09-01");

    expect(home.recentlyFiled.map((r) => r.obligationId)).toEqual(["o-2"]);
    expect(home.upcomingFilings.map((r) => r.obligationId)).toEqual([
      "o-1",
      "o-3",
    ]);
  });

  it("carries a statutory date only where one was set, and no other deadline", async () => {
    // The firm has never given its turnaround times, so a date this product
    // derived is a promise nobody made to this reader. The repository decides
    // which rows carry one; this asserts the service forwards the null rather
    // than filling it in.
    const { rows, service } = world();
    rows.work = [
      work({ workItemId: "w-1", statutoryDueOn: "2026-09-20" }),
      work({ workItemId: "w-2", statutoryDueOn: null }),
    ];
    const home = await service.home(FIRM, MEERA, "2026-09-01");
    expect(home.inProgress.map((r) => r.statutoryDueOn)).toEqual([
      "2026-09-20",
      null,
    ]);
  });
});
