// V2.5's SQL half, against a real database: the duplicate check reads only
// OPEN identifiers (0315), a voided identifier is final by trigger, and a
// rename writes both rows.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/party/master-data.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { load } from "../../src/config/config";
import { PostgresIdentifierRepository } from "../../src/infrastructure/postgres/identifier-repository";
import { PostgresPartyRepository } from "../../src/infrastructure/postgres/party-repository";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const identifiers = new PostgresIdentifierRepository(app);
const parties = new PostgresPartyRepository(app);
const stamp = Date.now().toString(36);
let tenantId = "";
let partyId = "";

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`masterdata-${stamp}`}, 'Master Data Test', 'INR') RETURNING id
  `;
  if (!t) throw new Error("tenant seed failed");
  tenantId = t.id;
  const org = await parties.createOrganization({
    partyId: randomUUID(),
    tenantId,
    legalName: "Kaveri Fods Private Limited",
    tradeName: null,
    industry: null,
    website: null,
    displayName: "Kaveri Fods",
  });
  partyId = org.partyId;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

describe("the duplicate check reads only OPEN identifiers (0315)", () => {
  it("finds an open PAN, and stops finding it once it is voided or ended", async () => {
    const pan = await identifiers.add({
      id: randomUUID(), tenantId, partyId, type: "pan", value: "AAACK9999F",
      jurisdiction: null, isPrimary: false, validFrom: "2026-04-01", validTo: null,
    });
    expect(await identifiers.findByValue(tenantId, "pan", "AAACK9999F")).toMatchObject({ id: pan.id });

    const voided = await identifiers.void(tenantId, pan.id, null);
    expect(voided?.voidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await identifiers.findByValue(tenantId, "pan", "AAACK9999F")).toBeNull();
    // Final: a second void, an end, any change at all is refused.
    expect(await identifiers.void(tenantId, pan.id, null)).toBeNull();
    await expect(owner`
      UPDATE core.party_identifier SET is_primary = true WHERE id = ${pan.id}
    `).rejects.toMatchObject({ code: "55000" });

    const gstin = await identifiers.add({
      id: randomUUID(), tenantId, partyId, type: "gstin", value: "27AAACK9999F1Z5",
      jurisdiction: null, isPrimary: false, validFrom: "2026-04-01", validTo: null,
    });
    await identifiers.end(tenantId, gstin.id, "2026-09-30");
    expect(await identifiers.findByValue(tenantId, "gstin", "27AAACK9999F1Z5")).toBeNull();
    expect(await identifiers.end(tenantId, gstin.id, "2026-10-31")).toBeNull();
  });
});

describe("a rename writes the party and the organization together", () => {
  it("corrects the display name and the trade name, and clears the industry", async () => {
    const updated = await parties.updateDetails(tenantId, partyId, {
      displayName: "Kaveri Foods",
      tradeName: "Kaveri Foods",
      industry: null,
    });
    expect(updated?.displayName).toBe("Kaveri Foods");
    expect(await parties.findOrganization(tenantId, partyId)).toMatchObject({
      tradeName: "Kaveri Foods",
      industry: null,
      legalName: "Kaveri Fods Private Limited",
    });
  });
});
