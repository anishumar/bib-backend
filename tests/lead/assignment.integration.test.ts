// T2.1b's real half: the rotation, against real Postgres.
//
// The unit tests in service.test.ts show that N captures with no owner divide
// evenly. They cannot show the two properties this file exists for, because
// both are properties of the DATABASE and a single-threaded fake has them for
// free:
//
//   1. Counting the desks and claiming one are ONE ATOMIC ACT. Two leads
//      captured in the same instant read the same counts under any naive
//      implementation and land on the same person — the rotation going wrong
//      exactly when the firm is busiest, and silently.
//   2. The candidate set is this firm's active STAFF and nobody else's. The
//      predicate is RLS plus `audience = 'STAFF' AND is_active`, and the roster
//      of a different tenant is not reachable at all.
//
// Run with:  npm run test:integration   (needs a migrated local database)
//
// NOTE ON CLEANUP: like the pipeline test, this leaves its rows behind —
// crm.lead has no DELETE grant. Its tenants are uniquely named per run.
import { PostgresFirmTimeZone } from "../../src/infrastructure/postgres/firm-timezone-repository";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresLeadRepository } from "../../src/infrastructure/postgres/lead-repository";
import { PostgresDashboardRepository } from "../../src/infrastructure/postgres/dashboard-repository";
import {
  FirstMatchAssignment,
  PostgresRoundRobinAssignment,
  PostgresTerritoryAssignment,
  PostgresTerritoryRules,
} from "../../src/infrastructure/postgres/lead-assignment";
import { PostgresPartyRepository } from "../../src/infrastructure/postgres/party-repository";
import { PostgresIdentifierRepository } from "../../src/infrastructure/postgres/identifier-repository";
import { PostgresRelationshipRepository } from "../../src/infrastructure/postgres/relationship-repository";
import { PostgresMembershipRepository } from "../../src/infrastructure/postgres/membership-repository";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { LedgerService } from "../../src/usecase/ledger/service";
import { PartyService } from "../../src/usecase/party/service";
import { LeadService } from "../../src/usecase/lead/service";
import { systemIds } from "../../src/platform/ids";
import { systemClock } from "../../src/platform/clock";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import type { Lead } from "../../src/domain/lead/model";

const cfg = load();
// Wide enough that six simultaneous captures are genuinely simultaneous. A
// narrow pool would serialise them at the CONNECTION and the concurrency test
// would pass without ever exercising the lock it exists to prove.
const app = postgres(cfg.db.appUrl, { max: 12 });
const owner = postgres(cfg.db.ownerUrl, { max: 4 });

const memberships = new PostgresMembershipRepository(app);
const ledger = new LedgerService({ events: new PostgresEventStore(app), ids: systemIds });
const party = new PartyService({
  parties: new PostgresPartyRepository(app),
  identifiers: new PostgresIdentifierRepository(app),
  relationships: new PostgresRelationshipRepository(app),
  ids: systemIds,
  events: ledger,
});
// The ROTATION on its own, because several tests below drive it directly to
// watch six simultaneous claims divide.
const assignment = new PostgresRoundRobinAssignment(app);
const territory = new PostgresTerritoryAssignment(app);
const territories = new PostgresTerritoryRules(app);
const service = new LeadService({
  leads: new PostgresLeadRepository(app),
  prospects: party,
  timeZones: new PostgresFirmTimeZone(app),
  currency: new PostgresDashboardRepository(app),
  staff: memberships,
  // What the SERVICE gets is the composite, in the order the composition root
  // wires it: territory first, rotation second. Every test in this file that
  // sets no territory rule therefore sees exactly the rotation it always saw,
  // because territory declines on a lead with no jurisdiction — which is the
  // property that makes T2.1b's override safe underneath work already written.
  assignment: new FirstMatchAssignment([territory, assignment]),
  territories,
  ids: systemIds,
  clock: systemClock,
  events: ledger,
});

const stamp = String(Date.now());

/** One firm, its roster, and a counter that keeps every prospect distinct. */
interface Firm {
  readonly id: string;
  readonly desks: string[];
}

let firm: Firm = { id: "", desks: [] };
let rival: Firm = { id: "", desks: [] };

let sequence = 0;
function nextEmail(): string {
  sequence += 1;
  return `rotation-${stamp}-${String(sequence)}@example.test`;
}

async function makeTenant(slug: string): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${slug}, ${slug}, 'INR') RETURNING id
  `;
  if (!row) throw new Error(`could not create the tenant ${slug}`);
  return row.id;
}

/** A colleague at a firm. `audience` and `isActive` are the two halves of the
 *  notion the rotation and `isActiveStaff` must agree about. */
async function makeMember(
  tenantId: string,
  label: string,
  audience: "STAFF" | "CLIENT_PORTAL" = "STAFF",
  isActive = true,
): Promise<string> {
  const [account] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email)
    VALUES (${`${label}-${stamp}@example.test`}) RETURNING id
  `;
  if (!account) throw new Error(`could not create the account ${label}`);
  await owner`
    INSERT INTO tenancy.membership (tenant_id, user_id, audience, role, commercial_visibility, is_active)
    VALUES (${tenantId}, ${account.id}, ${audience}, 'associate', false, ${isActive})
  `;
  return account.id;
}

/**
 * A capture with NO owner named — the rotation decides.
 *
 * Every call invents a fresh prospect, so each one starts a NEW lead. Repeating
 * a prospect would MERGE onto its live opportunity and assign nobody, which is
 * the merge rule working and would look here like the rotation failing.
 */
async function captureUnowned(tenantId: string): Promise<Lead> {
  const { lead } = await service.capture(
    {
      tenantId,
      source: "inbound",
      title: "FY27 statutory audit",
      kind: "organization",
      name: `Rotation Prospect ${String(sequence + 1)} Private Limited`,
      identifiers: [{ type: "email", value: nextEmail() }],
    },
    SYSTEM_ACTOR,
  );
  return lead;
}

/** A capture that asks for the unassigned queue by name, so the lead exists
 *  with no owner and the rotation can be raced against it deliberately. */
async function captureQueued(tenantId: string): Promise<Lead> {
  const { lead } = await service.capture(
    {
      tenantId,
      source: "inbound",
      title: "FY27 statutory audit",
      kind: "organization",
      name: `Queued Prospect ${String(sequence + 1)} Private Limited`,
      identifiers: [{ type: "email", value: nextEmail() }],
      ownerUserId: null,
    },
    SYSTEM_ACTOR,
  );
  return lead;
}

function tally(owners: readonly (string | null)[], desks: readonly string[]): number[] {
  return desks.map((d) => owners.filter((o) => o === d).length);
}

beforeAll(async () => {
  const firmId = await makeTenant(`rotation-a-${stamp}`);
  const rivalId = await makeTenant(`rotation-b-${stamp}`);

  // Three active staff, plus two people who must NEVER receive a lead: a client
  // contact of the firm (a real, active membership — and a prospect's file on
  // their desk is the firm's book of business handed outside it) and a
  // colleague whose access has been revoked.
  const desks = [
    await makeMember(firmId, "desk-1"),
    await makeMember(firmId, "desk-2"),
    await makeMember(firmId, "desk-3"),
  ];
  await makeMember(firmId, "client-contact", "CLIENT_PORTAL");
  await makeMember(firmId, "left-the-firm", "STAFF", false);

  firm = { id: firmId, desks: [...desks].sort() };
  rival = { id: rivalId, desks: [await makeMember(rivalId, "rival-desk")] };
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

describe("the acceptance: leads captured with no owner distribute evenly", () => {
  it("divides nine captures into three equal desks", async () => {
    const owners: (string | null)[] = [];
    for (let n = 0; n < 9; n += 1) owners.push((await captureUnowned(firm.id)).ownerUserId);

    expect(tally(owners, firm.desks)).toEqual([3, 3, 3]);
    // And it went ROUND rather than filling a desk at a time: three each could
    // also be produced by AAA BBB CCC, which is a batch queue, not a rotation.
    expect(owners.slice(0, 3)).toEqual(firm.desks);
  });

  it("counts the same way the database does, asked directly", async () => {
    // The service's answer could be a lie the service tells itself. This is the
    // table, read as the owner role with RLS out of the picture entirely.
    const rows = await owner<{ owner_user_id: string | null; n: string }[]>`
      SELECT owner_user_id, count(*)::text AS n
      FROM crm.lead WHERE tenant_id = ${firm.id}
      GROUP BY owner_user_id ORDER BY owner_user_id
    `;
    expect(rows.map((r) => r.owner_user_id)).toEqual(firm.desks);
    expect(rows.map((r) => r.n)).toEqual(["3", "3", "3"]);
  });
});

describe("fairness when two leads arrive in the same instant", () => {
  it("never lands two simultaneous claims on the same desk", async () => {
    // THE RACE, staged as tightly as it can be. Six leads are created first,
    // one at a time, so that lead CREATION is not what is under test; then all
    // six claims are issued in the same tick.
    //
    // Without the per-tenant advisory lock every one of them reads the same
    // counts — the desks are level at three each going in — and all six pick
    // the same emptiest desk. With it, each waits for the one before to COMMIT
    // its claim and then counts a world that contains it, so the six divide two
    // apiece. A collision shows up as a lopsided tally, and a lost claim shows
    // up as a null.
    const queued: Lead[] = [];
    for (let n = 0; n < 6; n += 1) queued.push(await captureQueued(firm.id));

    const claimed = await Promise.all(queued.map((lead) => assignment.assign(lead)));
    const owners = claimed.map((outcome) => outcome.lead.ownerUserId);

    expect(owners.filter((o) => o === null)).toHaveLength(0);
    expect(tally(owners, firm.desks)).toEqual([2, 2, 2]);
  });

  it("leaves the whole firm level afterwards, read from the table", async () => {
    const rows = await owner<{ n: string }[]>`
      SELECT count(*)::text AS n FROM crm.lead
      WHERE tenant_id = ${firm.id} AND owner_user_id IS NOT NULL
      GROUP BY owner_user_id ORDER BY owner_user_id
    `;
    expect(rows.map((r) => r.n)).toEqual(["5", "5", "5"]);
  });
});

describe("who is even a candidate", () => {
  it("never picks a client contact or somebody who has left", async () => {
    // Both are memberships at this firm, and neither may hold a lead. The
    // rotation's predicate and the manual-assignment refusal are the SAME
    // notion, so the next test asks the other door about the same people.
    const excluded = await owner<{ user_id: string }[]>`
      SELECT user_id FROM tenancy.membership
      WHERE tenant_id = ${firm.id} AND (audience <> 'STAFF' OR NOT is_active)
    `;
    expect(excluded).toHaveLength(2);

    const held = await owner<{ owner_user_id: string | null }[]>`
      SELECT DISTINCT owner_user_id FROM crm.lead WHERE tenant_id = ${firm.id}
    `;
    for (const person of excluded) {
      expect(held.map((h) => h.owner_user_id)).not.toContain(person.user_id);
    }
  });

  it("agrees with the refusal that guards manual assignment", async () => {
    // One notion, two doors. If these ever disagreed, the rotation would be a
    // back door into the state OwnerNotStaff exists to prevent.
    const excluded = await owner<{ user_id: string }[]>`
      SELECT user_id FROM tenancy.membership
      WHERE tenant_id = ${firm.id} AND (audience <> 'STAFF' OR NOT is_active)
    `;
    for (const person of excluded) {
      expect(await memberships.isActiveStaff(firm.id, person.user_id)).toBe(false);
    }
    for (const desk of firm.desks) {
      expect(await memberships.isActiveStaff(firm.id, desk)).toBe(true);
    }
  });

  it("cannot reach another firm's roster, because RLS is the candidate filter", async () => {
    // The rival firm's only colleague has nothing on their desk, so a rotation
    // that could see them would pick them every time. RLS is why it cannot —
    // there is no tenant predicate in the query at all.
    const chosen = (await captureUnowned(firm.id)).ownerUserId;
    expect(firm.desks).toContain(chosen);
    expect(rival.desks).not.toContain(chosen);
  });

  it("leaves the lead unassigned when a firm has nobody to give it to", async () => {
    // Declining is an answer, not a failure: the capture still lands, in the
    // unassigned queue migration 0007 created for exactly this.
    const empty = await makeTenant(`rotation-empty-${stamp}`);
    expect((await captureUnowned(empty)).ownerUserId).toBeNull();
  });
});

describe("a rotation never overrules a person", () => {
  it("leaves an owner alone once one is set, whatever the counts say", async () => {
    // The `AND owner_user_id IS NULL` guard, exercised directly against the
    // adapter: a manual assignment that landed between the insert and the claim
    // wins. Proved by calling assign() on a lead that already has an owner —
    // the busiest desk in the firm, which the rotation would never choose.
    const [busiest] = await owner<{ owner_user_id: string }[]>`
      SELECT owner_user_id FROM crm.lead
      WHERE tenant_id = ${firm.id} AND owner_user_id IS NOT NULL
      GROUP BY owner_user_id ORDER BY count(*) DESC, owner_user_id DESC LIMIT 1
    `;
    if (!busiest) throw new Error("expected the firm to hold assigned leads by now");

    const { lead } = await service.capture(
      {
        tenantId: firm.id,
        source: "referral",
        title: "GST registration for the Pune plant",
        kind: "organization",
        name: `Already Owned ${String(sequence + 1)} Private Limited`,
        identifiers: [{ type: "email", value: nextEmail() }],
        ownerUserId: busiest.owner_user_id,
      },
      SYSTEM_ACTOR,
    );
    expect(lead.ownerUserId).toBe(busiest.owner_user_id);

    const again = await assignment.assign(lead);
    expect(again.lead.ownerUserId).toBe(busiest.owner_user_id);
    // …and it says it did not choose, so the timeline does not credit the
    // rotation with a decision a person already made.
    expect(again.policy).toBeNull();
  });

  it("honours an explicit request for the unassigned queue", async () => {
    const { lead } = await service.capture(
      {
        tenantId: firm.id,
        source: "event",
        title: "Triage me",
        kind: "organization",
        name: `Queued ${String(sequence + 1)} Private Limited`,
        identifiers: [{ type: "email", value: nextEmail() }],
        ownerUserId: null,
      },
      SYSTEM_ACTOR,
    );
    expect(lead.ownerUserId).toBeNull();

    const [row] = await owner<{ owner_user_id: string | null }[]>`
      SELECT owner_user_id FROM crm.lead WHERE id = ${lead.id}
    `;
    expect(row?.owner_user_id).toBeNull();
  });
});

describe("T2.1b — territory, against the real tables", () => {
  // The half the fakes cannot prove: the rule and the ACTIVE-STAFF join are one
  // SQL statement, and "declines when the desk it names is gone" is that join
  // returning no row. A fake asserts the intention; only this asserts the query.

  /** A capture from a named country, with no owner — territory decides. */
  async function captureFrom(tenantId: string, jurisdiction: string): Promise<Lead> {
    const { lead } = await service.capture(
      {
        tenantId,
        source: "inbound",
        title: "FY27 statutory audit",
        kind: "organization",
        name: `Territory Prospect ${String(sequence + 1)} Private Limited`,
        identifiers: [{ type: "email", value: nextEmail() }],
        jurisdiction,
      },
      SYSTEM_ACTOR,
    );
    return lead;
  }

  it("sends a lead from the rule's country to that desk, past the rotation", async () => {
    const specialist = await makeMember(firm.id, "gb-desk");
    await service.setTerritoryRule(
      { tenantId: firm.id, jurisdiction: "GB", ownerUserId: specialist, note: "UK desk" },
      SYSTEM_ACTOR,
    );
    // The specialist joined last and holds nothing, so the rotation might well
    // pick them by accident — load their desk first, and the two answers can no
    // longer coincide.
    for (let n = 0; n < 3; n += 1) {
      const filler = await captureUnowned(firm.id);
      await owner`UPDATE crm.lead SET owner_user_id = ${specialist} WHERE id = ${filler.id}`;
    }
    const lead = await captureFrom(firm.id, "GB");
    expect(lead.ownerUserId).toBe(specialist);
    expect(lead.jurisdiction).toBe("GB");
  });

  it("declines to a desk whose membership has been revoked", async () => {
    const leaver = await makeMember(firm.id, "gb-leaver");
    await service.setTerritoryRule(
      { tenantId: firm.id, jurisdiction: "SG", ownerUserId: leaver },
      SYSTEM_ACTOR,
    );
    // The rule stays; the person goes. No foreign key can express this, and the
    // service check ran when the rule was WRITTEN — only the strategy's join
    // sees it now.
    await owner`
      UPDATE tenancy.membership SET is_active = false
      WHERE tenant_id = ${firm.id} AND user_id = ${leaver}
    `;
    const lead = await captureFrom(firm.id, "SG");
    expect(lead.ownerUserId).not.toBeNull();
    // It fell through to the rotation rather than parking on a dead desk, where
    // it would LOOK assigned and be seen by nobody.
    expect(lead.ownerUserId).not.toBe(leaver);
  });

  it("a lead with no country never reaches the territory query at all", async () => {
    const specialist = await makeMember(firm.id, "gb-desk-2");
    await service.setTerritoryRule(
      { tenantId: firm.id, jurisdiction: "GB", ownerUserId: specialist },
      SYSTEM_ACTOR,
    );
    const lead = await captureUnowned(firm.id);
    expect(lead.jurisdiction).toBeNull();
    expect(lead.ownerUserId).not.toBeNull();
  });

  it("keeps one firm's territory rules out of another's", async () => {
    // RLS on crm.territory_rule, and it matters more here than on most tables:
    // a rule that leaked would put another firm's staff on this firm's leads.
    const mine = await makeMember(firm.id, "row-mine");
    await service.setTerritoryRule(
      { tenantId: firm.id, jurisdiction: "AE", ownerUserId: mine },
      SYSTEM_ACTOR,
    );
    expect(await service.listTerritoryRules(rival.id)).toEqual([]);
    const theirs = await captureFrom(rival.id, "AE");
    expect(theirs.ownerUserId).not.toBe(mine);
  });
});
