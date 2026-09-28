// Setup readiness (V2.6): the eight lines, from facts. Pure, so every rule is
// a line here: what makes a line done, and what each gap names.
import { describe, expect, it } from "vitest";
import { READINESS_KEYS, readinessLines } from "../../src/domain/readiness/model";
import type { ReadinessFacts, ReadinessLine } from "../../src/domain/readiness/model";
import { ReadinessService } from "../../src/usecase/readiness/service";
import { FakeReadinessFacts, emptyFacts } from "../../src/testfakes/readiness";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { FakeClock } from "../../src/testfakes/clock";

const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const SHRESTHA = "00000000-0000-4000-8000-0000000000a1";

/** The QA firm on 27 Sep 2026 (qa-extract REPORT.md §§2,7,9,10), as facts. */
function qaFirm(): ReadinessFacts {
  return {
    ...emptyFacts(),
    day: "2026-09-27",
    activeClients: [
      { partyId: CLIENT, name: "test company", hasKeyManager: false, deptsWithoutSpoc: ["FRC"], hasPortalLogin: true },
    ],
    reportingLinePolicies: ["manager review"],
    staffWithoutManager: [{ userId: SHRESTHA, name: "Shrestha Pandit" }],
    services: [{ key: "monthly-accounting", name: "Monthly Accounting & Bookkeeping", processKey: "monthly_accounting", processPublished: true }],
    requestRouting: "key_manager",
  };
}

const byKey = (lines: readonly ReadinessLine[], key: ReadinessLine["key"]): ReadinessLine => {
  const l = lines.find((x) => x.key === key);
  if (!l) throw new Error(`no ${key} line`);
  return l;
};

describe("the lines", () => {
  it("are the eight, in the order a firm sets itself up", () => {
    expect(readinessLines(qaFirm()).map((l) => l.key)).toEqual([...READINESS_KEYS]);
    expect(READINESS_KEYS).toHaveLength(8);
  });

  it("list every gap the QA firm had on 27 Sep, and pass what it had done", () => {
    const lines = readinessLines(qaFirm());
    expect(byKey(lines, "deadlines").gaps.map((g) => g.missing[0])).toEqual(["go_live_floor", "fiscal_year_start"]);
    expect(byKey(lines, "reporting_lines")).toMatchObject({
      done: false,
      context: ["manager review"],
      gaps: [{ id: SHRESTHA, name: "Shrestha Pandit", missing: ["manager"] }],
    });
    expect(byKey(lines, "ladders").gaps.map((g) => g.missing[0])).toEqual(["escalation", "chaser", "nudge"]);
    expect(byKey(lines, "compliance_rules").gaps.map((g) => g.missing[0])).toEqual(["confirmed_linked_rule"]);
    expect(byKey(lines, "account_team").gaps).toEqual([
      { id: CLIENT, ref: null, name: "test company", missing: ["key_manager", "spoc:FRC"] },
    ]);
    // Done there: routing was set, the service had a published process, the
    // client had a portal login.
    expect(byKey(lines, "request_routing").done).toBe(true);
    expect(byKey(lines, "processes").done).toBe(true);
    expect(byKey(lines, "portal_contacts").done).toBe(true);
    expect(lines.filter((l) => l.done)).toHaveLength(3);
  });
});

describe("each line turns done when its gap is fixed", () => {
  it("deadlines: both the go-live floor and the financial year", () => {
    const f = { ...qaFirm(), missedFromOn: "2026-10-01" };
    expect(byKey(readinessLines(f), "deadlines").gaps.map((g) => g.missing[0])).toEqual(["fiscal_year_start"]);
    expect(byKey(readinessLines({ ...f, fiscalYearStartMonth: 4 }), "deadlines").done).toBe(true);
  });

  it("reporting lines are not asked for when no check rule reads them alone", () => {
    const line = byKey(readinessLines({ ...qaFirm(), reportingLinePolicies: [] }), "reporting_lines");
    expect(line).toMatchObject({ done: true, gaps: [], context: [] });
  });

  it("ladders: a ladder PUBLISHED is enough; its days are the firm's (D3)", () => {
    const f = { ...qaFirm(), ladders: { escalation: true, chaser: true, nudge: false } };
    expect(byKey(readinessLines(f), "ladders").gaps.map((g) => g.missing[0])).toEqual(["nudge"]);
  });

  it("compliance rules: one confirmed and linked, and nothing linked left unconfirmed", () => {
    const one = { ...qaFirm(), generatingRules: 1 };
    expect(byKey(readinessLines(one), "compliance_rules").done).toBe(true);
    const half = { ...one, linkedUnconfirmedRules: [{ id: "r1", name: "GSTR-3B" }] };
    expect(byKey(readinessLines(half), "compliance_rules").gaps).toEqual([
      { id: "r1", ref: null, name: "GSTR-3B", missing: ["confirmed"] },
    ]);
  });

  it("processes: a service naming no process, or one never published", () => {
    const f = {
      ...qaFirm(),
      services: [
        { key: "books", name: "Books", processKey: null, processPublished: false },
        { key: "gst", name: "GST", processKey: "gst_filing", processPublished: false },
        { key: "tds", name: "TDS", processKey: "tds", processPublished: true },
      ],
    };
    expect(byKey(readinessLines(f), "processes").gaps).toEqual([
      { id: null, ref: "books", name: "Books", missing: ["process"] },
      { id: null, ref: "gst", name: "GST", missing: ["published_process"] },
    ]);
  });

  it("account team: a Key Manager AND a SPOC for every Dept the client's services name", () => {
    const withKm = {
      ...qaFirm(),
      activeClients: [{ partyId: CLIENT, name: "test company", hasKeyManager: true, deptsWithoutSpoc: ["FRC"], hasPortalLogin: true }],
    };
    expect(byKey(readinessLines(withKm), "account_team").gaps[0]?.missing).toEqual(["spoc:FRC"]);
    const full = { ...withKm, activeClients: [{ ...withKm.activeClients[0]!, deptsWithoutSpoc: [] }] };
    expect(byKey(readinessLines(full), "account_team").done).toBe(true);
  });

  it("request routing and portal contacts", () => {
    const f = {
      ...qaFirm(),
      requestRouting: "none",
      activeClients: [{ partyId: CLIENT, name: "test company", hasKeyManager: true, deptsWithoutSpoc: [], hasPortalLogin: false }],
    };
    const lines = readinessLines(f);
    expect(byKey(lines, "request_routing").gaps[0]?.missing).toEqual(["routing"]);
    expect(byKey(lines, "portal_contacts").gaps).toEqual([
      { id: CLIENT, ref: null, name: "test company", missing: ["portal_login"] },
    ]);
  });

  it("a firm with no clients has nothing missing on the two client lines", () => {
    const lines = readinessLines({ ...emptyFacts(), day: "2026-09-28" });
    expect(byKey(lines, "account_team").done).toBe(true);
    expect(byKey(lines, "portal_contacts").done).toBe(true);
  });
});

describe("the service", () => {
  it("reads the facts on the FIRM's day, not the server's", async () => {
    // 20:00 UTC on the 27th is 01:30 on the 28th in India.
    const facts = new FakeReadinessFacts();
    const service = new ReadinessService({
      facts,
      timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
      clock: new FakeClock(new Date("2026-09-27T20:00:00.000Z")),
    });
    const r = await service.readiness("00000000-0000-4000-8000-000000000001");
    expect(r.asOf).toBe("2026-09-28");
    expect(facts.askedOn).toEqual(["2026-09-28"]);
    expect(r.lines).toHaveLength(8);
  });
});
