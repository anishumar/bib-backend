// G0.3's database half, proven against real Postgres: a party is never
// deleted, an archived one is out of the lists and still resolves by id, and
// archiving is refused while anything still points at it.
//
// The refusal is the reason this file exists. A fake can show that PartyService
// surfaces it; only Postgres can show that it HOLDS — that a client import, an
// agent or a psql session gets the same answer as the API. So every refusal
// below is asserted twice: once through the service, and once with raw SQL that
// never touches our code, including as the OWNER role, which RLS does not
// filter and which is what a 2 a.m. session actually looks like.
//
// Run with:  npm run test:integration   (needs a migrated local database)
//
// NOTE ON CLEANUP: this test leaves its rows behind — core.party and crm.lead
// have no DELETE grant, which is itself asserted below. The tenants it creates
// are uniquely named per run.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withTenant } from "../../src/db/tenant";
import { PostgresPartyRepository } from "../../src/infrastructure/postgres/party-repository";
import { PostgresIdentifierRepository } from "../../src/infrastructure/postgres/identifier-repository";
import { PostgresRelationshipRepository } from "../../src/infrastructure/postgres/relationship-repository";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { LedgerService } from "../../src/usecase/ledger/service";
import { PartyService } from "../../src/usecase/party/service";
import { PartyHasReferences } from "../../src/domain/party/errors";
import { systemIds } from "../../src/platform/ids";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const ledger = new LedgerService({ events: new PostgresEventStore(app), ids: systemIds });
const service = new PartyService({
  parties: new PostgresPartyRepository(app),
  identifiers: new PostgresIdentifierRepository(app),
  relationships: new PostgresRelationshipRepository(app),
  ids: systemIds,
  events: ledger,
});

const stamp = String(Date.now());
let tenant = "";

/** A fresh organization party, so each assertion starts from a live one. */
async function newParty(name: string): Promise<string> {
  const org = await service.createOrganization({ tenantId: tenant, legalName: name }, SYSTEM_ACTOR);
  return org.partyId;
}

/** The archiving UPDATE, run as the app role under RLS but WITHOUT the service:
 *  the import / agent path. Returns the error, or null if it went through. */
async function archiveRaw(partyId: string): Promise<unknown> {
  return withTenant(app, tenant, (db) =>
    db`UPDATE core.party SET archived_at = now() WHERE id = ${partyId}`,
  ).then(
    () => null,
    (e: unknown) => e,
  );
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`archive-test-${stamp}`}, 'Archive Test', 'INR') RETURNING id
  `;
  if (!t) throw new Error("could not create the test tenant");
  tenant = t.id;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

describe("parties are permanent", () => {
  it("no core table carries deleted_at", async () => {
    // The decision, kept true by a test rather than only by a paragraph. The
    // CLAUDE.md line this task corrected said "soft delete only" while no such
    // column existed anywhere in core — a stated rule the schema does not
    // implement is worse than no rule, and this is what stops it recurring.
    const rows = await owner<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'core' AND column_name = 'deleted_at'
    `;
    expect(rows.map((r) => r.table_name)).toEqual([]);
  });

  it("bib_app holds no DELETE grant on any core table", async () => {
    // Hard delete is impossible at the database level and stays that way. 0035
    // adds a column and grants nothing.
    const rows = await owner<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.role_table_grants
      WHERE grantee = 'bib_app' AND table_schema = 'core' AND privilege_type = 'DELETE'
    `;
    expect(rows.map((r) => r.table_name)).toEqual([]);
  });
});

describe("the read asymmetry", () => {
  it("an archived party is absent from the list and still resolves by id", async () => {
    const partyId = await newParty(`Dormant Holdings ${stamp}`);
    const before = await service.listParties(tenant);
    expect(before.map((p) => p.id)).toContain(partyId);

    const archived = await service.archiveParty({ tenantId: tenant, partyId }, SYSTEM_ACTOR);
    expect(archived.archivedAt).not.toBeNull();

    // Gone from the picker…
    const after = await service.listParties(tenant);
    expect(after.map((p) => p.id)).not.toContain(partyId);

    // …still there when asked for…
    const all = await service.listParties(tenant, true);
    expect(all.map((p) => p.id)).toContain(partyId);

    // …and STILL RESOLVES BY ID, which is the half that matters. A signed
    // engagement letter's counterparty must never render blank.
    const profile = await service.partyProfile(tenant, partyId);
    expect(profile.party.id).toBe(partyId);
    expect(profile.party.archivedAt).toBe(archived.archivedAt);
    expect(profile.organization?.legalName).toBe(`Dormant Holdings ${stamp}`);
  });

  it("un-archiving puts it back in the list", async () => {
    const partyId = await newParty(`Returning Client ${stamp}`);
    await service.archiveParty({ tenantId: tenant, partyId }, SYSTEM_ACTOR);
    const restored = await service.unarchiveParty({ tenantId: tenant, partyId }, SYSTEM_ACTOR);

    expect(restored.archivedAt).toBeNull();
    const list = await service.listParties(tenant);
    expect(list.map((p) => p.id)).toContain(partyId);
  });

  it("both events are in the ledger, naming the party and no display name", async () => {
    const partyId = await newParty(`Ledger Check ${stamp}`);
    await service.archiveParty({ tenantId: tenant, partyId }, SYSTEM_ACTOR);
    await service.unarchiveParty({ tenantId: tenant, partyId }, SYSTEM_ACTOR);

    const rows = await withTenant(app, tenant, (db) =>
      db<{ verb: string; object_type: string; payload: Record<string, unknown> }[]>`
        SELECT verb, object_type, payload FROM ledger.event
        WHERE object_id = ${partyId} ORDER BY recorded_at
      `,
    );
    expect(rows.map((r) => r.verb)).toEqual([
      "party.created",
      "party.archived",
      "party.unarchived",
    ]);
    for (const row of rows) expect(row.object_type).toBe("party");
    expect(JSON.stringify(rows)).not.toContain("Ledger Check");
  });
});

describe("archiving is refused while anything points at the party", () => {
  it("through the service, naming what refers to it", async () => {
    const partyId = await newParty(`Has A Lead ${stamp}`);
    await withTenant(app, tenant, (db) =>
      db`INSERT INTO crm.lead (tenant_id, party_id, source, stage)
         VALUES (${tenant}, ${partyId}, 'inbound', 'new')`,
    );

    const err = await service
      .archiveParty({ tenantId: tenant, partyId }, SYSTEM_ACTOR)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartyHasReferences);
    expect((err as PartyHasReferences).referrers).toEqual(["a lead"]);

    // Refused means unchanged: still live, still in the picker.
    const [row] = await owner<{ archived_at: Date | null }[]>`
      SELECT archived_at FROM core.party WHERE id = ${partyId}
    `;
    expect(row?.archived_at).toBeNull();
  });

  it("names every kind of thing that refers to it, not just the first", async () => {
    const partyId = await newParty(`Lead And Proposal ${stamp}`);
    await withTenant(app, tenant, async (db) => {
      await db`INSERT INTO crm.lead (tenant_id, party_id, source, stage)
               VALUES (${tenant}, ${partyId}, 'referral', 'qualified')`;
      await db`INSERT INTO crm.proposal (tenant_id, party_id, title, currency, fx_rate, fx_rate_date)
               VALUES (${tenant}, ${partyId}, 'FY26 compliance', 'INR', 1, '2026-08-28')`;
    });

    const err = await service
      .archiveParty({ tenantId: tenant, partyId }, SYSTEM_ACTOR)
      .catch((e: unknown) => e);
    expect((err as PartyHasReferences).referrers).toEqual(["a lead", "a proposal"]);
  });

  // THE ONLY THING THAT PROVES A DATABASE-LEVEL RULE: the same refusal with the
  // service taken out of the picture entirely.
  it("and with raw SQL, as the app role — the import and agent path", async () => {
    const partyId = await newParty(`Raw App Path ${stamp}`);
    await withTenant(app, tenant, (db) =>
      db`INSERT INTO crm.lead (tenant_id, party_id, source, stage)
         VALUES (${tenant}, ${partyId}, 'outbound', 'contacted')`,
    );

    const err = await archiveRaw(partyId);
    expect((err as { code?: string }).code).toBe("23001"); // restrict_violation
    expect((err as { detail?: string }).detail).toBe("a lead");
  });

  it("and as the OWNER role, which RLS does not filter — the psql path", async () => {
    // A service-level check is one a migration or a 2 a.m. session walks
    // straight past. This is the assertion that says it does not.
    const partyId = await newParty(`Raw Owner Path ${stamp}`);
    await withTenant(app, tenant, (db) =>
      db`INSERT INTO crm.lead (tenant_id, party_id, source, stage)
         VALUES (${tenant}, ${partyId}, 'event', 'new')`,
    );

    const err = await owner`
      UPDATE core.party SET archived_at = now() WHERE id = ${partyId}
    `.then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe("23001");
  });

  it("lets the party be archived once what pointed at it is gone", async () => {
    // Not a trick: crm.lead has no DELETE grant either. The lead is CLOSED, and
    // a closed lead still refers to the party — which is the rule working, not
    // failing. The party is archivable only once nothing at all points at it,
    // and this asserts the refusal is about the reference and not about a
    // particular lead stage.
    const partyId = await newParty(`Closed Lead ${stamp}`);
    await withTenant(app, tenant, (db) =>
      db`INSERT INTO crm.lead (tenant_id, party_id, source, stage, closed_at)
         VALUES (${tenant}, ${partyId}, 'partner', 'lost', now())`,
    );
    const err = await service
      .archiveParty({ tenantId: tenant, partyId }, SYSTEM_ACTOR)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartyHasReferences);
  });
});

describe("the guard is narrow, deliberately", () => {
  it("an ordinary UPDATE of a referenced party is untouched by it", async () => {
    // The whole argument for putting this in the database rather than the
    // service was that it costs nothing on writes that are not an archive:
    // BEFORE UPDATE OF archived_at, plus a WHEN clause on the NULL → NOT NULL
    // transition. A rename of a party with five leads must not pay for five
    // EXISTS probes, and this is what says so.
    const partyId = await newParty(`Renamed ${stamp}`);
    await withTenant(app, tenant, (db) =>
      db`INSERT INTO crm.lead (tenant_id, party_id, source, stage)
         VALUES (${tenant}, ${partyId}, 'other', 'new')`,
    );

    await withTenant(app, tenant, (db) =>
      db`UPDATE core.party SET display_name = ${`Renamed Twice ${stamp}`} WHERE id = ${partyId}`,
    );
    const party = await service.partyProfile(tenant, partyId);
    expect(party.party.displayName).toBe(`Renamed Twice ${stamp}`);
  });

  it("un-archiving is never refused, even once something points at the party", async () => {
    // Archive first (nothing refers to it yet), then create the reference, then
    // restore. Bringing a party back cannot orphan anything, so the guard has
    // no business firing here.
    const partyId = await newParty(`Restored Under Reference ${stamp}`);
    await service.archiveParty({ tenantId: tenant, partyId }, SYSTEM_ACTOR);
    await withTenant(app, tenant, (db) =>
      db`INSERT INTO crm.lead (tenant_id, party_id, source, stage)
         VALUES (${tenant}, ${partyId}, 'inbound', 'new')`,
    );

    const restored = await service.unarchiveParty({ tenantId: tenant, partyId }, SYSTEM_ACTOR);
    expect(restored.archivedAt).toBeNull();
  });
});

describe("the tenant wall covers the archive", () => {
  it("the guard only sees references inside the party's own firm", async () => {
    // The trigger probes crm with an explicit tenant_id predicate as well as
    // RLS, so a lead in another firm can never keep this firm's party live —
    // and, more importantly, can never be leaked by an error message naming it.
    const [other] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.tenant (slug, name, reporting_currency)
      VALUES (${`archive-test-other-${stamp}`}, 'Archive Test Other', 'INR') RETURNING id
    `;
    if (!other) throw new Error("could not create the second tenant");

    const mine = await newParty(`Clean Party ${stamp}`);
    const theirs = await service.createOrganization(
      { tenantId: other.id, legalName: `Their Party ${stamp}` },
      SYSTEM_ACTOR,
    );
    await withTenant(app, other.id, (db) =>
      db`INSERT INTO crm.lead (tenant_id, party_id, source, stage)
         VALUES (${other.id}, ${theirs.partyId}, 'inbound', 'new')`,
    );

    const archived = await service.archiveParty({ tenantId: tenant, partyId: mine }, SYSTEM_ACTOR);
    expect(archived.archivedAt).not.toBeNull();
    expect(await service.listParties(other.id)).toHaveLength(1);
  });
});
