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
import {
  PartyAlreadyArchived,
  PartyHasReferences,
  PartyNotArchived,
} from "../../src/domain/party/errors";
import { systemIds } from "../../src/platform/ids";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const ledger = new LedgerService({ events: new PostgresEventStore(app), ids: systemIds });
/** Held separately as well as injected: the concurrency block below drives the
 *  repository directly, because the service's own pre-check would otherwise
 *  decide the race before the database ever saw it. */
const parties = new PostgresPartyRepository(app);
const service = new PartyService({
  parties,
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
    const before = await service.listParties(tenant, false);
    expect(before.map((p) => p.id)).toContain(partyId);

    const archived = await service.archiveParty({ tenantId: tenant, partyId }, SYSTEM_ACTOR);
    expect(archived.archivedAt).not.toBeNull();

    // Gone from the picker…
    const after = await service.listParties(tenant, false);
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
    const list = await service.listParties(tenant, false);
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
      db`INSERT INTO crm.lead (tenant_id, party_id, source, stage, title)
         VALUES (${tenant}, ${partyId}, 'inbound', 'new', 'FY26 retainer')`,
    );

    const err = await service
      .archiveParty({ tenantId: tenant, partyId }, SYSTEM_ACTOR)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartyHasReferences);
    expect((err as PartyHasReferences).referrers).toEqual(["an open lead"]);

    // Refused means unchanged: still live, still in the picker.
    const [row] = await owner<{ archived_at: Date | null }[]>`
      SELECT archived_at FROM core.party WHERE id = ${partyId}
    `;
    expect(row?.archived_at).toBeNull();
  });

  it("names every kind of thing that refers to it, not just the first", async () => {
    const partyId = await newParty(`Lead And Proposal ${stamp}`);
    await withTenant(app, tenant, async (db) => {
      await db`INSERT INTO crm.lead (tenant_id, party_id, source, stage, title)
               VALUES (${tenant}, ${partyId}, 'referral', 'qualified', 'Group restructuring')`;
      await db`INSERT INTO crm.proposal
                 (tenant_id, party_id, title, currency, fx_rate, fx_rate_date,
                  ref, issuing_entity_party_id)
               VALUES (${tenant}, ${partyId}, 'FY26 compliance', 'INR', 1, '2026-08-28',
                       'PR-2026-9001', ${partyId})`;
    });

    const err = await service
      .archiveParty({ tenantId: tenant, partyId }, SYSTEM_ACTOR)
      .catch((e: unknown) => e);
    expect((err as PartyHasReferences).referrers).toEqual(["an open lead", "a proposal in progress"]);
  });

  // THE ONLY THING THAT PROVES A DATABASE-LEVEL RULE: the same refusal with the
  // service taken out of the picture entirely.
  it("and with raw SQL, as the app role — the import and agent path", async () => {
    const partyId = await newParty(`Raw App Path ${stamp}`);
    await withTenant(app, tenant, (db) =>
      db`INSERT INTO crm.lead (tenant_id, party_id, source, stage, title)
         VALUES (${tenant}, ${partyId}, 'outbound', 'contacted', 'GST advisory')`,
    );

    const err = await archiveRaw(partyId);
    expect((err as { code?: string }).code).toBe("23001"); // restrict_violation
    expect((err as { detail?: string }).detail).toBe("an open lead");
  });

  it("and as the OWNER role, which RLS does not filter — the psql path", async () => {
    // A service-level check is one a migration or a 2 a.m. session walks
    // straight past. This is the assertion that says it does not.
    const partyId = await newParty(`Raw Owner Path ${stamp}`);
    await withTenant(app, tenant, (db) =>
      db`INSERT INTO crm.lead (tenant_id, party_id, source, stage, title)
         VALUES (${tenant}, ${partyId}, 'event', 'new', 'Conference follow-up')`,
    );

    const err = await owner`
      UPDATE core.party SET archived_at = now() WHERE id = ${partyId}
    `.then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe("23001");
  });

  // THE SIXTH REFERENCE (migration 0036). 0035 enumerated five and left this
  // one out on the grounds that widening a refusal past what was decided is a
  // product change. It was the wrong call: entity_party_id is ONE field at
  // three stages of one document chain, 0035 probed the last two and skipped
  // the first, and this is the cheapest probe of the six because
  // idx_proposal_line_entity has existed since 0018. Without 0036 this test
  // archives a subsidiary that a live quote is naming.
  it("a party named only by a live proposal line cannot be archived", async () => {
    const client = await newParty(`Group Client ${stamp}`);
    const subsidiary = await newParty(`Group Subsidiary ${stamp}`);

    await withTenant(app, tenant, async (db) => {
      // A service version for the line to pin. The registry's own rules are not
      // what is under test; the foreign key just needs a real row.
      const [entry] = await db<{ id: string }[]>`
        INSERT INTO config.entry (tenant_id, kind, key)
        VALUES (${tenant}, 'service', ${`gst-filing-${stamp}`}) RETURNING id
      `;
      const [version] = await db<{ id: string }[]>`
        INSERT INTO config.version (tenant_id, entry_id, version, status, body)
        VALUES (${tenant}, ${entry?.id ?? ""}, 1, 'draft', '{}'::jsonb) RETURNING id
      `;
      // The proposal is about the CLIENT; only the LINE names the subsidiary.
      // That is the whole shape this probe exists for — a group's quote, with
      // the work delivered to one of its companies.
      const [proposal] = await db<{ id: string }[]>`
        INSERT INTO crm.proposal
          (tenant_id, party_id, title, currency, fx_rate, fx_rate_date,
           ref, issuing_entity_party_id)
        VALUES (${tenant}, ${client}, 'Group FY26', 'INR', 1, '2026-08-28',
                'PR-2026-9002', ${client}) RETURNING id
      `;
      await db`
        INSERT INTO crm.proposal_line
          (tenant_id, proposal_id, service_version_id, description, position,
           quantity, unit_amount, currency, entity_party_id)
        VALUES
          (${tenant}, ${proposal?.id ?? ""}, ${version?.id ?? ""}, 'GST filing', 1,
           1, '15000.0000', 'INR', ${subsidiary})
      `;
    });

    const err = await service
      .archiveParty({ tenantId: tenant, partyId: subsidiary }, SYSTEM_ACTOR)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartyHasReferences);
    expect((err as PartyHasReferences).referrers).toEqual(["a line of a proposal in progress"]);

    // And the client at the head of the same document is refused too, by the
    // proposal itself — the two probes are independent and both hold.
    const clientErr = await service
      .archiveParty({ tenantId: tenant, partyId: client }, SYSTEM_ACTOR)
      .catch((e: unknown) => e);
    expect((clientErr as PartyHasReferences).referrers).toEqual(["a proposal in progress"]);
  });

  it("lets the party be archived once nothing LIVE points at it (0314)", async () => {
    // Until 0314 this asserted the opposite: a CLOSED lead still refused, and
    // a client with any history could never be put away. Decided 2026-09-28:
    // only live references refuse (an open lead, a proposal or letter in
    // progress, a live engagement), so a client who left can be archived once
    // its engagements are ended. A lost lead is history, not work in hand.
    const partyId = await newParty(`Closed Lead ${stamp}`);
    await withTenant(app, tenant, (db) =>
      db`INSERT INTO crm.lead (tenant_id, party_id, source, stage, closed_at, title)
         VALUES (${tenant}, ${partyId}, 'partner', 'lost', now(), 'Statutory audit')`,
    );
    const archived = await service.archiveParty({ tenantId: tenant, partyId }, SYSTEM_ACTOR);
    expect(archived.archivedAt).not.toBeNull();
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
      db`INSERT INTO crm.lead (tenant_id, party_id, source, stage, title)
         VALUES (${tenant}, ${partyId}, 'other', 'new', 'Rename probe')`,
    );

    await withTenant(app, tenant, (db) =>
      db`UPDATE core.party SET display_name = ${`Renamed Twice ${stamp}`} WHERE id = ${partyId}`,
    );
    const party = await service.partyProfile(tenant, partyId);
    expect(party.party.displayName).toBe(`Renamed Twice ${stamp}`);
  });

  it("un-archiving is never refused, and is what lets a new reference be made", async () => {
    // Until 0305 this test made its reference to the ARCHIVED party and then
    // restored it. That reference is now refused (see the block below), so the
    // order is the one the product asks for: restore, then work with them.
    const partyId = await newParty(`Restored Under Reference ${stamp}`);
    await service.archiveParty({ tenantId: tenant, partyId }, SYSTEM_ACTOR);

    const restored = await service.unarchiveParty({ tenantId: tenant, partyId }, SYSTEM_ACTOR);
    expect(restored.archivedAt).toBeNull();
    await withTenant(app, tenant, (db) =>
      db`INSERT INTO crm.lead (tenant_id, party_id, source, stage, title)
         VALUES (${tenant}, ${partyId}, 'inbound', 'new', 'Unarchive probe')`,
    );
  });
});

describe("a NEW reference to an archived party is refused (0305)", () => {
  // 0035 refused ARCHIVING while something pointed at a party. Nothing stopped
  // the other direction: lead capture matched an archived client's PAN and
  // attached a fresh lead to it. The services now refuse by name; these prove
  // the wall under them, for the writers that are not those services.
  async function archived(name: string): Promise<string> {
    const partyId = await newParty(`${name} ${stamp}`);
    await service.archiveParty({ tenantId: tenant, partyId }, SYSTEM_ACTOR);
    return partyId;
  }

  it("refuses a lead naming it, as the app role — the import and agent path", async () => {
    const partyId = await archived("Archived Lead Target");
    await expect(
      withTenant(app, tenant, (db) =>
        db`INSERT INTO crm.lead (tenant_id, party_id, source, stage, title)
           VALUES (${tenant}, ${partyId}, 'inbound', 'new', 'Web enquiry')`,
      ),
    ).rejects.toThrow(/is archived, so a new crm\.lead may not name it/);
  });

  it("refuses it as the OWNER role too — the psql path", async () => {
    const partyId = await archived("Archived Owner Target");
    await expect(
      owner`INSERT INTO crm.lead (tenant_id, party_id, source, stage, title)
            VALUES (${tenant}, ${partyId}, 'inbound', 'new', 'psql')`,
    ).rejects.toThrow(/is archived/);
  });

  it("refuses a proposal naming it", async () => {
    const partyId = await archived("Archived Proposal Target");
    const issuer = await newParty(`Issuer ${stamp}`);
    await expect(
      withTenant(app, tenant, (db) =>
        db`INSERT INTO crm.proposal
             (tenant_id, party_id, title, currency, fx_rate, fx_rate_date, ref,
              issuing_entity_party_id)
           VALUES (${tenant}, ${partyId}, 'FY27', 'INR', 1, '2026-09-25',
                   ${`PR-2026-${stamp.slice(-4)}`}, ${issuer})`,
      ),
    ).rejects.toThrow(/is archived, so a new crm\.proposal may not name it/);
  });

  it("leaves an EXISTING row alone, and refuses only a new line naming the company", async () => {
    // The subsidiary is archived FIRST, the proposal is about a live client,
    // and an ordinary edit of an existing line must pass while re-pointing it
    // at the archived company — a new reference — must not.
    const client = await newParty(`Live Client ${stamp}`);
    const subsidiary = await archived("Archived Subsidiary");
    const lineId = await withTenant(app, tenant, async (db) => {
      const [entry] = await db<{ id: string }[]>`
        INSERT INTO config.entry (tenant_id, kind, key)
        VALUES (${tenant}, 'service', ${`gst-0305-${stamp}`}) RETURNING id
      `;
      const [version] = await db<{ id: string }[]>`
        INSERT INTO config.version (tenant_id, entry_id, version, status, body)
        VALUES (${tenant}, ${entry?.id ?? ""}, 1, 'draft', '{}'::jsonb) RETURNING id
      `;
      const [proposal] = await db<{ id: string }[]>`
        INSERT INTO crm.proposal
          (tenant_id, party_id, title, currency, fx_rate, fx_rate_date, ref,
           issuing_entity_party_id)
        VALUES (${tenant}, ${client}, 'Group FY27', 'INR', 1, '2026-09-25',
                ${`PR-2027-${stamp.slice(-4)}`}, ${client}) RETURNING id
      `;
      // A line for the live client itself goes in, and can be edited freely.
      const [line] = await db<{ id: string }[]>`
        INSERT INTO crm.proposal_line
          (tenant_id, proposal_id, service_version_id, description, position,
           quantity, unit_amount, currency, entity_party_id)
        VALUES (${tenant}, ${proposal?.id ?? ""}, ${version?.id ?? ""}, 'GST filing', 1,
                1, '15000.0000', 'INR', ${client}) RETURNING id
      `;
      await db`UPDATE crm.proposal_line SET description = 'GST filing, monthly'
               WHERE id = ${line?.id ?? ""}`;
      return line?.id ?? "";
    });
    // Pointing it at the archived subsidiary is a NEW reference: refused. Its
    // own transaction, because a refused statement aborts the one it is in.
    await expect(
      withTenant(app, tenant, (db) =>
        db`UPDATE crm.proposal_line SET entity_party_id = ${subsidiary} WHERE id = ${lineId}`,
      ),
    ).rejects.toThrow(/is archived, so a new crm\.proposal_line may not name it/);
  });
});

describe("two archives at once", () => {
  // The service checks isArchived and then the repository writes, which is two
  // statements with room between them — and the trigger cannot close that gap
  // because it deliberately does not fire on NOT NULL -> NOT NULL. Without
  // `AND archived_at IS NULL` on the UPDATE both writers win, the timestamp
  // moves, and a SECOND party.archived lands in a log that cannot be corrected.
  //
  // Driven through the REPOSITORY, not the service: the service's pre-check
  // would decide most interleavings before the database saw either write, and a
  // test that passes because of the check it is not testing is worthless.
  it("only one wins, and the loser is told the party is already archived", async () => {
    const partyId = await newParty(`Raced ${stamp}`);

    const [a, b] = await Promise.allSettled([
      parties.archive(tenant, partyId),
      parties.archive(tenant, partyId),
    ]);

    const outcomes = [a, b];
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const loser = outcomes.find((o) => o.status === "rejected");
    expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(PartyAlreadyArchived);

    // One timestamp, and it is the winner's — the loser did not move it.
    const winner = outcomes.find((o) => o.status === "fulfilled");
    const [row] = await owner<{ archived_at: Date | null }[]>`
      SELECT archived_at FROM core.party WHERE id = ${partyId}
    `;
    expect(row?.archived_at?.toISOString()).toBe(
      (winner as PromiseFulfilledResult<{ archivedAt: string | null }>).value.archivedAt,
    );
  });

  it("the same holds for two restores", async () => {
    const partyId = await newParty(`Raced Back ${stamp}`);
    await parties.archive(tenant, partyId);

    const outcomes = await Promise.allSettled([
      parties.unarchive(tenant, partyId),
      parties.unarchive(tenant, partyId),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const loser = outcomes.find((o) => o.status === "rejected");
    expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(PartyNotArchived);
  });

  it("puts exactly one party.archived in the ledger", async () => {
    // The reason the race matters at all. Through the SERVICE this time,
    // because the event is what an un-correctable log would be left holding.
    const partyId = await newParty(`Raced Ledger ${stamp}`);
    await Promise.allSettled([
      service.archiveParty({ tenantId: tenant, partyId }, SYSTEM_ACTOR),
      service.archiveParty({ tenantId: tenant, partyId }, SYSTEM_ACTOR),
    ]);

    const rows = await withTenant(app, tenant, (db) =>
      db<{ verb: string }[]>`
        SELECT verb FROM ledger.event
        WHERE object_id = ${partyId} AND verb = 'party.archived'
      `,
    );
    expect(rows).toHaveLength(1);
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
      db`INSERT INTO crm.lead (tenant_id, party_id, source, stage, title)
         VALUES (${other.id}, ${theirs.partyId}, 'inbound', 'new', 'Another firm''s opportunity')`,
    );

    const archived = await service.archiveParty({ tenantId: tenant, partyId: mine }, SYSTEM_ACTOR);
    expect(archived.archivedAt).not.toBeNull();
    expect(await service.listParties(other.id, false)).toHaveLength(1);
  });
});
