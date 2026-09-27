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
    });
    expect(wrote).toBe(false);
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
