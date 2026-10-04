// T6.18 · the firm's own companies, against real Postgres.
//
// What only the database can prove: that creating a company writes the party,
// the organization, the legal entity and the preference row in ONE transaction
// (a clash on the country leaves no organization behind in the client list),
// that the list reads `crm.is_firm_entity`'s two sources, and that
// `POST /firm-entities/preferences` really upserts — including `*`.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/document/firm-entities.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import { PostgresFirmEntityRepository } from "../../src/infrastructure/postgres/firm-entity-repository";
import { FirmEntityService } from "../../src/usecase/document/firm-entities";
import { systemIds } from "../../src/platform/ids";
import { withTenant } from "../../src/db/tenant";
import { composeProposals } from "../proposal/compose-postgres";

const c = composeProposals();
const repository = new PostgresFirmEntityRepository(c.app);
const service = new FirmEntityService({ firmEntities: repository, ids: systemIds, events: c.ledger });
const stamp = String(Date.now());
let tenant = "";
let firmSelf = "";

beforeAll(async () => {
  const [t] = await c.owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`firm-entities-${stamp}`}, 'Firm Entities Test', 'INR') RETURNING id
  `;
  if (!t) throw new Error("could not create the test tenant");
  tenant = t.id;
  firmSelf = await c.documentRepository.seedFirmEntity(tenant, "Firm Entities Test Pvt Ltd");
});

afterAll(() => c.end());

async function organizationsNamed(name: string): Promise<number> {
  const [row] = await c.owner<{ n: number }[]>`
    SELECT count(*)::int AS n FROM core.organization
    WHERE tenant_id = ${tenant} AND legal_name = ${name}
  `;
  return row?.n ?? 0;
}

describe("the firm's own companies, against real Postgres (T6.18)", () => {
  it("lists the firm itself, as the fallback, before anything is added", async () => {
    const { reportingCurrency, entities } = await service.list(tenant);
    expect(reportingCurrency).toBe("INR");
    expect(entities).toEqual([
      expect.objectContaining({ partyId: firmSelf, isFirmSelf: true, isFallback: true, jurisdiction: null }),
    ]);
  });

  it("creates a company in one transaction: party, organization, registration, the rule", async () => {
    const created = await service.create(
      {
        tenantId: tenant,
        name: "Test USA Inc",
        jurisdiction: "US",
        entityType: "Inc.",
        registeredAddress: { lines: ["605 Geddes Street", "Wilmington, Delaware 19805", "USA"] },
      },
      SYSTEM_ACTOR,
    );
    expect(created).toMatchObject({
      name: "Test USA Inc",
      jurisdiction: "US",
      routedCountries: ["US"],
      defaultCurrency: "USD",
    });
    const [row] = await c.owner<{ address: unknown; firm: boolean }[]>`
      SELECT le.registered_address AS address,
             crm.is_firm_entity(${tenant}::uuid, ${created.partyId}::uuid) AS firm
      FROM core.legal_entity le WHERE le.party_id = ${created.partyId}
    `;
    expect(row?.address).toEqual({ lines: ["605 Geddes Street", "Wilmington, Delaware 19805", "USA"] });
    expect(row?.firm).toBe(true);
    const verbs = await c.owner<{ verb: string }[]>`
      SELECT verb FROM ledger.event
      WHERE tenant_id = ${tenant} AND (object_id = ${created.partyId} OR payload->>'firmEntityPartyId' = ${created.partyId})
      ORDER BY occurred_at, recorded_at
    `;
    expect(verbs.map((v) => v.verb)).toEqual([
      "party.created",
      "legal_entity.registered",
      "firm_entity_preference.set",
    ]);
  });

  it("a clash on the country rolls the whole company back — no organization left in the book", async () => {
    await service.create({ tenantId: tenant, name: "Test Gulf FZE", jurisdiction: "AE", entityType: "FZE" }, SYSTEM_ACTOR);
    // Past the service's check, straight at the adapter: the preference row is
    // refused inside the transaction, and the organization goes with it.
    const wrote = await repository.create({
      partyId: crypto.randomUUID(),
      tenantId: tenant,
      name: "Test Gulf Rival LLC",
      jurisdiction: "AE",
      entityType: "LLC",
      registeredAddress: null,
      preferenceId: crypto.randomUUID(),
      numbers: [],
      timeZone: null,
      fiscalYearEnd: null,
    });
    expect(wrote).toEqual({ created: false });
    expect(await organizationsNamed("Test Gulf Rival LLC")).toBe(0);
    await expect(
      service.create({ tenantId: tenant, name: "Test Gulf Rival LLC", jurisdiction: "AE", entityType: "LLC" }, SYSTEM_ACTOR),
    ).rejects.toMatchObject({ code: "COUNTRY_ALREADY_SERVED" });
  });

  it("edits the name on the party and the organization, and the address on the registration", async () => {
    const sg = await service.create({ tenantId: tenant, name: "Test Asia", jurisdiction: "SG", entityType: "Pte" }, SYSTEM_ACTOR);
    const saved = await service.edit(
      {
        tenantId: tenant,
        partyId: sg.partyId,
        name: "Test Asia Pte. Ltd.",
        entityType: "Pte. Ltd.",
        registeredAddress: { lines: ["1 Raffles Place", "Singapore 048616"] },
      },
      SYSTEM_ACTOR,
    );
    expect(saved).toMatchObject({ name: "Test Asia Pte. Ltd.", entityType: "Pte. Ltd.", defaultCurrency: "SGD" });
    const [row] = await c.owner<{ display_name: string; legal_name: string; address: unknown }[]>`
      SELECT p.display_name, o.legal_name, le.registered_address AS address
      FROM core.party p JOIN core.organization o ON o.party_id = p.id
      JOIN core.legal_entity le ON le.party_id = p.id WHERE p.id = ${sg.partyId}
    `;
    expect(row).toEqual({
      display_name: "Test Asia Pte. Ltd.",
      legal_name: "Test Asia Pte. Ltd.",
      address: { lines: ["1 Raffles Place", "Singapore 048616"] },
    });
  });

  it("records where the seeded company is registered, through the same statement", async () => {
    const saved = await service.edit(
      { tenantId: tenant, partyId: firmSelf, jurisdiction: "IN", entityType: "Private Limited" },
      SYSTEM_ACTOR,
    );
    expect(saved).toMatchObject({ jurisdiction: "IN", isFirmSelf: true, defaultCurrency: "INR" });
    await expect(
      service.edit({ tenantId: tenant, partyId: firmSelf, jurisdiction: "US" }, SYSTEM_ACTOR),
    ).rejects.toMatchObject({ code: "JURISDICTION_FIXED" });
  });

  it("POST /firm-entities/preferences upserts: a country and the fallback move, one row each", async () => {
    const { entities } = await service.list(tenant);
    const gulf = entities.find((e) => e.name === "Test Gulf FZE");
    const us = entities.find((e) => e.name === "Test USA Inc");
    if (gulf === undefined || us === undefined) throw new Error("fixture companies missing");
    await c.documents.setPreference({ tenantId: tenant, clientJurisdiction: "*", firmEntityPartyId: gulf.partyId }, SYSTEM_ACTOR);
    await c.documents.setPreference({ tenantId: tenant, clientJurisdiction: "GB", firmEntityPartyId: us.partyId }, SYSTEM_ACTOR);
    await c.documents.setPreference({ tenantId: tenant, clientJurisdiction: "GB", firmEntityPartyId: gulf.partyId }, SYSTEM_ACTOR);
    const rows = await c.owner<{ client_jurisdiction: string; firm_entity_party_id: string }[]>`
      SELECT client_jurisdiction, firm_entity_party_id FROM crm.firm_entity_preference
      WHERE tenant_id = ${tenant} AND client_jurisdiction IN ('*', 'GB') ORDER BY client_jurisdiction
    `;
    expect(rows).toEqual([
      { client_jurisdiction: "*", firm_entity_party_id: gulf.partyId },
      { client_jurisdiction: "GB", firm_entity_party_id: gulf.partyId },
    ]);
    const after = await service.list(tenant);
    expect(after.entities.find((e) => e.partyId === gulf.partyId)).toMatchObject({
      isFallback: true,
      routedCountries: ["AE", "GB"],
    });
    // The firm itself stops being the fallback, and stays one of the firm's.
    expect(after.entities.find((e) => e.partyId === firmSelf)).toMatchObject({ isFallback: false, isFirmSelf: true });
  });
});

// 0313 · a company is the firm's by MEMBERSHIP, not by routing. Before it, a
// company whose last country was pointed at another company stopped being the
// firm's: it left every list and every picker, and nothing could bring it back.
describe("a company stays the firm's with no country routed to it (0313)", () => {
  it("re-pointing a company's last country away leaves it in the list, with no countries", async () => {
    const { entities } = await service.list(tenant);
    const asia = entities.find((e) => e.name === "Test Asia Pte. Ltd.");
    const gulf = entities.find((e) => e.name === "Test Gulf FZE");
    if (asia === undefined || gulf === undefined) throw new Error("fixture companies missing");
    expect(asia.routedCountries).toEqual(["SG"]);

    await c.documents.setPreference({ tenantId: tenant, clientJurisdiction: "SG", firmEntityPartyId: gulf.partyId }, SYSTEM_ACTOR);

    const after = await service.list(tenant);
    expect(after.entities.find((e) => e.partyId === asia.partyId)).toMatchObject({
      name: "Test Asia Pte. Ltd.",
      routedCountries: [],
      isFallback: false,
    });
    const [row] = await c.owner<{ firm: boolean; members: number }[]>`
      SELECT crm.is_firm_entity(${tenant}::uuid, ${asia.partyId}::uuid) AS firm,
             (SELECT count(*)::int FROM crm.firm_entity
               WHERE tenant_id = ${tenant} AND party_id = ${asia.partyId}) AS members
    `;
    expect(row).toEqual({ firm: true, members: 1 });

    // And the way back is the ordinary one: route a country to it again.
    await c.documents.setPreference({ tenantId: tenant, clientJurisdiction: "SG", firmEntityPartyId: asia.partyId }, SYSTEM_ACTOR);
    expect((await service.list(tenant)).entities.find((e) => e.partyId === asia.partyId)?.routedCountries).toEqual(["SG"]);
  });

  it("routing a country to a party the older way makes it a member (the trigger)", async () => {
    const partyId = crypto.randomUUID();
    await withTenant(c.app, tenant, async (db) => {
      await db`INSERT INTO core.party (id, tenant_id, kind, display_name)
               VALUES (${partyId}, ${tenant}, 'organization', 'Test Routed Only Ltd')`;
      await db`INSERT INTO core.organization (party_id, tenant_id, legal_name)
               VALUES (${partyId}, ${tenant}, 'Test Routed Only Ltd')`;
    });
    expect(await repository.find(tenant, partyId)).toBeNull();
    await c.documents.setPreference({ tenantId: tenant, clientJurisdiction: "FR", firmEntityPartyId: partyId }, SYSTEM_ACTOR);
    expect(await repository.find(tenant, partyId)).toMatchObject({ routedCountries: ["FR"] });
    const [row] = await c.owner<{ members: number }[]>`
      SELECT count(*)::int AS members FROM crm.firm_entity WHERE tenant_id = ${tenant} AND party_id = ${partyId}
    `;
    expect(row?.members).toBe(1);
  });

  it("the app can neither delete a membership nor move it to another party", async () => {
    const [m] = await c.owner<{ id: string }[]>`
      SELECT id FROM crm.firm_entity WHERE tenant_id = ${tenant} AND party_id = ${firmSelf}
    `;
    if (m === undefined) throw new Error("the firm itself was not backfilled as a member");
    await expect(
      withTenant(c.app, tenant, (db) => db`DELETE FROM crm.firm_entity WHERE id = ${m.id}`),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTenant(c.app, tenant, (db) => db`UPDATE crm.firm_entity SET party_id = ${firmSelf} WHERE id = ${m.id}`),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("another firm cannot see this firm's memberships", async () => {
    const [other] = await c.owner<{ id: string }[]>`
      INSERT INTO tenancy.tenant (slug, name, reporting_currency)
      VALUES (${`firm-entities-other-${stamp}`}, 'Firm Entities Other', 'INR') RETURNING id
    `;
    if (!other) throw new Error("could not create the second tenant");
    const seen = await withTenant(c.app, other.id, (db) =>
      db<{ n: number }[]>`SELECT count(*)::int AS n FROM crm.firm_entity WHERE tenant_id = ${tenant}`,
    );
    expect(seen[0]?.n).toBe(0);
  });
});

describe("a company's numbers and address, against real Postgres (audit 2026-10-03)", () => {
  it("holds them as the party's identifiers, replaces by voiding, and prints them through crm.print_identity", async () => {
    const created = await service.create(
      {
        tenantId: tenant,
        name: "Test India LLP",
        jurisdiction: "IN",
        entityType: "LLP",
        registeredAddress: { lines: ["12 MG Road"], region: "Maharashtra", postalCode: "411001" },
        taxRegistration: "27ABCDE1234F1Z5",
        pan: "ABCDE1234F",
        phone: "+91 20 2612 3456",
        email: "office@testindia.in",
      },
      SYSTEM_ACTOR,
    );
    expect(created).toMatchObject({
      registeredAddress: { lines: ["12 MG Road"], region: "Maharashtra", postalCode: "411001" },
      taxRegistration: { type: "gstin", value: "27ABCDE1234F1Z5" },
      pan: "ABCDE1234F",
      phone: "+912026123456",
      email: "office@testindia.in",
    });

    const moved = await service.edit(
      { tenantId: tenant, partyId: created.partyId, taxRegistration: "29ABCDE1234F1Z7", phone: null },
      SYSTEM_ACTOR,
    );
    expect(moved.taxRegistration?.value).toBe("29ABCDE1234F1Z7");
    expect(moved.phone).toBeNull();
    const rows = await c.owner<{ type: string; voided: boolean }[]>`
      SELECT type, voided_at IS NOT NULL AS voided FROM core.party_identifier
       WHERE party_id = ${created.partyId} AND type IN ('gstin', 'phone') ORDER BY created_at
    `;
    expect(rows).toEqual([
      { type: "gstin", voided: true },
      { type: "phone", voided: true },
      { type: "gstin", voided: false },
    ]);

    const [printed] = await withTenant(c.app, tenant, (db) =>
      db<{ identity: Record<string, unknown> }[]>`
        SELECT crm.print_identity(${created.partyId}, (now() AT TIME ZONE 'UTC')::date) AS identity
      `,
    );
    expect(printed?.identity).toMatchObject({
      name: "Test India LLP",
      country: "IN",
      address: { lines: ["12 MG Road"], region: "Maharashtra", postalCode: "411001" },
      taxId: { type: "gstin", value: "29ABCDE1234F1Z7" },
      pan: "ABCDE1234F",
      email: "office@testindia.in",
    });
    expect(printed?.identity).not.toHaveProperty("phone");
  });

  it("refuses a number another party at the firm already holds, writing nothing", async () => {
    const before = await organizationsNamed("Test Taken FZE");
    await expect(
      service.create(
        { tenantId: tenant, name: "Test Taken FZE", jurisdiction: "NZ", entityType: "Ltd", email: "office@testindia.in" },
        SYSTEM_ACTOR,
      ),
    ).rejects.toThrow(/email address is already recorded for another/);
    expect(await organizationsNamed("Test Taken FZE")).toBe(before);
  });
});

describe("a company's own year and clock, against real Postgres (0337)", () => {
  it("is stored beside its registration and read back as a start month", async () => {
    const made = await service.create(
      {
        tenantId: tenant,
        name: "Test Mauritius Ltd",
        jurisdiction: "MU",
        entityType: "Ltd",
        timeZone: "Indian/Mauritius",
        fiscalYearStartMonth: 7,
      },
      SYSTEM_ACTOR,
    );
    expect(made).toMatchObject({ timeZone: "Indian/Mauritius", fiscalYearStartMonth: 7 });
    const listed = (await service.list(tenant)).entities.find((e) => e.partyId === made.partyId);
    expect(listed).toMatchObject({ timeZone: "Indian/Mauritius", fiscalYearStartMonth: 7 });

    const cleared = await service.edit(
      { tenantId: tenant, partyId: made.partyId, timeZone: null, fiscalYearStartMonth: null },
      SYSTEM_ACTOR,
    );
    expect(cleared).toMatchObject({ timeZone: null, fiscalYearStartMonth: null });

    const back = await service.edit(
      { tenantId: tenant, partyId: made.partyId, fiscalYearStartMonth: 1 },
      SYSTEM_ACTOR,
    );
    expect(back).toMatchObject({ timeZone: null, fiscalYearStartMonth: 1 });
  });

  it("is refused by the database itself when a zone gets past the service", async () => {
    const made = await service.create(
      { tenantId: tenant, name: "Test Nepal Pvt Ltd", jurisdiction: "NP", entityType: "Pvt Ltd" },
      SYSTEM_ACTOR,
    );
    await expect(
      repository.edit(tenant, made.partyId, { calendar: { timeZone: "Mars/Olympus" } }),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
