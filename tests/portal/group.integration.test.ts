// A group's contact sees its sister companies (Q064), on a real database.
//
// The group: Kaveri Holdings is the parent of Kaveri Foods and Kaveri
// Logistics (two SISTERS, no row between them). Around it, the things that
// must NOT reach the portal:
//   - a person who is a director of Kaveri Foods (a human, not a company);
//   - the firm's own company, recorded as a shareholder of the parent;
//   - a subsidiary sold last year (the relationship ended);
//   - an archived subsidiary;
//   - another FIRM's company, which nothing in this firm can name.
//
// What has to hold:
//   1. The group of a sister is the parent and the other sister, and nothing
//      else on that list.
//   2. Granting the group writes ONE ROW AND ONE EVENT PER COMPANY.
//   3. The portal session then sees all three, and switching between them is
//      just its scope (several rows in force).
//   4. A company joining the group later is never granted silently: its
//      contacts are LISTED for the firm to decide.
//   5. THE TENANT WALL: asking as another firm finds no group, and a grant of
//      the group from another firm's id writes nothing.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/portal/group.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresPortalAccessRepository } from "../../src/infrastructure/postgres/portal-access-repository";
import { PostgresPortalGroup } from "../../src/infrastructure/postgres/portal-group";
import { PostgresFirmTimeZone } from "../../src/infrastructure/postgres/firm-timezone-repository";
import { PortalAccessService } from "../../src/usecase/portalaccess/service";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { systemIds } from "../../src/platform/ids";
import { systemClock } from "../../src/platform/clock";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const repo = new PostgresPortalAccessRepository(app);
const groups = new PostgresPortalGroup(app);
const events = new RecordingEventSink();
const access = new PortalAccessService({
  grants: repo,
  memberships: repo,
  clients: repo,
  groups,
  ids: systemIds,
  clock: systemClock,
  events,
  timeZones: new PostgresFirmTimeZone(app),
});

const stamp = String(Date.now());
let tenantId = "";
let otherTenant = "";
let holdings = "";
let foods = "";
let logistics = "";
let late = "";
let theirs = "";
let contact = "";
let contactUser = "";
let granter = "";

async function org(tenant: string, name: string, archived = false): Promise<string> {
  const [p] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name, archived_at)
    VALUES (${tenant}, 'organization', ${`${name} ${stamp}`}, ${archived ? new Date() : null}) RETURNING id
  `;
  if (!p) throw new Error("party seed failed");
  await owner`INSERT INTO core.organization (party_id, tenant_id, legal_name) VALUES (${p.id}, ${tenant}, ${name})`;
  return p.id;
}

async function rel(from: string, to: string, type: string, validFrom = "2025-01-01", validTo: string | null = null): Promise<void> {
  await owner`
    INSERT INTO core.party_relationship (tenant_id, from_party_id, to_party_id, type, valid_from, valid_to)
    VALUES (${tenantId}, ${from}, ${to}, ${type}, ${validFrom}::date, ${validTo}::date)
  `;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency) VALUES (${`group-${stamp}`}, 'Group Test', 'INR') RETURNING id
  `;
  const [o] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency) VALUES (${`group-other-${stamp}`}, 'Other', 'INR') RETURNING id
  `;
  if (!t || !o) throw new Error("tenant seed failed");
  tenantId = t.id;
  otherTenant = o.id;

  holdings = await org(tenantId, "Kaveri Holdings");
  foods = await org(tenantId, "Kaveri Foods");
  logistics = await org(tenantId, "Kaveri Logistics");
  late = await org(tenantId, "Kaveri Retail");
  const sold = await org(tenantId, "Kaveri Sold");
  const archived = await org(tenantId, "Kaveri Archived", true);
  const firm = await org(tenantId, "The Firm");
  await owner`INSERT INTO crm.firm_entity (tenant_id, party_id) VALUES (${tenantId}, ${firm})`;
  theirs = await org(otherTenant, "Kaveri Foods Elsewhere");
  const [person] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name) VALUES (${tenantId}, 'person', ${`Priya ${stamp}`}) RETURNING id
  `;

  await rel(holdings, foods, "parent_of");
  await rel(holdings, logistics, "parent_of");
  await rel(holdings, sold, "parent_of", "2024-01-01", "2025-06-01");
  await rel(holdings, archived, "parent_of");
  await rel(firm, holdings, "shareholder_of");
  await rel(person?.id ?? "", foods, "director_of");

  const [g] = await owner<{ id: string }[]>`INSERT INTO tenancy.user_account (email) VALUES (${`partner-${stamp}@firm.example`}) RETURNING id`;
  granter = g?.id ?? "";
  const [u] = await owner<{ id: string }[]>`INSERT INTO tenancy.user_account (email) VALUES (${`cfo-${stamp}@kaveri.example`}) RETURNING id`;
  contactUser = u?.id ?? "";
  const [m] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.membership (tenant_id, user_id, audience, role)
    VALUES (${tenantId}, ${contactUser}, 'CLIENT_PORTAL', 'client_contact') RETURNING id
  `;
  contact = m?.id ?? "";
});

afterAll(async () => {
  const both = [tenantId, otherTenant];
  await owner`DELETE FROM crm.portal_access WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM tenancy.membership WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM tenancy.user_account WHERE email LIKE ${`%-${stamp}@%`}`;
  await owner`DELETE FROM core.party_relationship WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM crm.firm_entity WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM core.organization WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM core.party WHERE tenant_id IN ${owner(both)}`;
  await Promise.all([app.end(), owner.end()]);
});

describe("a group's contact and its sister companies (Q064)", () => {
  it("reads the group as the parent and the sister, never a person, the firm, a sold or archived company", async () => {
    const group = await access.groupOf(tenantId, foods);
    expect(group.map((g) => g.id).sort()).toEqual([holdings, logistics].sort());
    const fromParent = await access.groupOf(tenantId, holdings);
    expect(fromParent.map((g) => g.id).sort()).toEqual([foods, logistics].sort());
  });

  it("grants a group of three as three rows and three events, and the portal then sees all three", async () => {
    await access.grant({ tenantId, membershipId: contact, clientPartyId: foods, grantedBy: granter }, SYSTEM_ACTOR);
    const out = await access.grantGroupOf(
      { tenantId, membershipId: contact, clientPartyId: foods, grantedBy: granter },
      SYSTEM_ACTOR,
    );
    expect(out.granted.map((g) => g.clientPartyId).sort()).toEqual([holdings, logistics].sort());
    const rows = await owner<{ client_party_id: string }[]>`
      SELECT client_party_id FROM crm.portal_access WHERE tenant_id = ${tenantId} AND membership_id = ${contact}
    `;
    expect(rows.map((r) => r.client_party_id).sort()).toEqual([foods, holdings, logistics].sort());
    expect(events.recorded.filter((e) => e.verb === "portal_access.granted")).toHaveLength(3);
    const scope = await access.scopedClientsForUser(tenantId, contactUser);
    expect(scope.map((c) => c.clientPartyId).sort()).toEqual([foods, holdings, logistics].sort());
    // Again: nothing new, all three already held.
    const again = await access.grantGroupOf({ tenantId, membershipId: contact, clientPartyId: foods, grantedBy: granter }, SYSTEM_ACTOR);
    expect(again.granted).toEqual([]);
    expect(again.alreadyHeld).toHaveLength(2);
  });

  it("lists, never grants, the group's contacts when a company joins the group later", async () => {
    expect(await access.groupContactsMissing(tenantId, late)).toEqual([]);
    await rel(holdings, late, "parent_of");
    const missing = await access.groupContactsMissing(tenantId, late);
    expect(missing.map((m) => m.membershipId)).toEqual([contact]);
    expect(missing[0]?.sees).toHaveLength(3);
    const lateRows = await owner`SELECT 1 FROM crm.portal_access WHERE client_party_id = ${late}`;
    expect(lateRows).toHaveLength(0);
  });

  it("finds no group across the tenant wall, and grants nothing from another firm", async () => {
    expect(await access.groupOf(otherTenant, foods)).toEqual([]);
    expect(await groups.groupOf(tenantId, theirs, "2026-10-05")).toEqual([]);
    const before = events.recorded.length;
    await expect(
      access.grantGroupOf({ tenantId: otherTenant, membershipId: contact, clientPartyId: foods, grantedBy: granter }, SYSTEM_ACTOR),
    ).resolves.toEqual({ granted: [], alreadyHeld: [] });
    expect(events.recorded.length).toBe(before);
    const stray = await owner`SELECT 1 FROM crm.portal_access WHERE tenant_id = ${otherTenant}`;
    expect(stray).toHaveLength(0);
  });
});
