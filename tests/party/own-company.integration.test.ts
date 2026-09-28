// Which parties are the firm's OWN companies, against a real database: the
// list spells `crm.is_firm_entity` (0313) as two joins, and this holds it to
// the function row for row, including a retired member and the firm itself.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/party/own-company.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { load } from "../../src/config/config";
import { PostgresPartyRepository } from "../../src/infrastructure/postgres/party-repository";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const parties = new PostgresPartyRepository(app);
const stamp = Date.now().toString(36);
let tenantId = "";
const ids = { firm: "", member: "", retired: "", client: "" };

async function org(legalName: string): Promise<string> {
  const o = await parties.createOrganization({
    partyId: randomUUID(),
    tenantId,
    legalName,
    tradeName: null,
    industry: null,
    website: null,
    displayName: legalName,
  });
  return o.partyId;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`own-company-${stamp}`}, 'Own Company Test', 'INR') RETURNING id
  `;
  if (!t) throw new Error("tenant seed failed");
  tenantId = t.id;
  ids.firm = await org("Own Company Test Private Limited");
  ids.member = await org("Own Company Test FZE");
  ids.retired = await org("Own Company Test Pte Ltd");
  ids.client = await org("Kaveri Foods Private Limited");
  await owner`UPDATE core.organization SET is_firm_self = true WHERE party_id = ${ids.firm}`;
  await owner`
    INSERT INTO crm.firm_entity (tenant_id, party_id) VALUES (${tenantId}, ${ids.member})
  `;
  await owner`
    INSERT INTO crm.firm_entity (tenant_id, party_id, retired_at)
    VALUES (${tenantId}, ${ids.retired}, now())
  `;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

describe("isOwnCompany (0313's definition)", () => {
  it("the list marks the firm itself and a live member, not a retired member or a client", async () => {
    const listed = await parties.listParties(tenantId, false);
    const own = Object.fromEntries(listed.map((p) => [p.id, p.isOwnCompany]));
    expect(own).toEqual({
      [ids.firm]: true,
      [ids.member]: true,
      [ids.retired]: false,
      [ids.client]: false,
    });
  });

  it("agrees with crm.is_firm_entity row for row, in both lists and in a single read", async () => {
    const truth = await owner<{ id: string; yes: boolean }[]>`
      SELECT id, crm.is_firm_entity(tenant_id, id) AS yes FROM core.party WHERE tenant_id = ${tenantId}
    `;
    for (const includeArchived of [false, true]) {
      const listed = await parties.listParties(tenantId, includeArchived);
      for (const row of truth) {
        expect(listed.find((p) => p.id === row.id)?.isOwnCompany).toBe(row.yes);
      }
    }
    for (const row of truth) {
      expect((await parties.findParty(tenantId, row.id))?.isOwnCompany).toBe(row.yes);
    }
  });
});
