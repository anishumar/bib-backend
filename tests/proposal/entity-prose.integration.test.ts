// T6.18 · D5 — the real seeding path picks the ISSUER's standard prose.
//
// A proposal issued by the firm's UAE company gets the UAE company's own
// exclusions, because it has some, and the firm's default commercials, because
// it has none — through `ProposalService.draft`, `DocumentService.seedBlocks`
// and the 0312 column, against real Postgres. And an Indian company's
// India-only line now reaches a proposal drafted with no client country, which
// before T6.18 was always seeded as `*`.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/proposal/entity-prose.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import { composeProposals } from "./compose-postgres";

const c = composeProposals();
const stamp = String(Date.now());
let tenant = "";
let client = "";
let india = "";
let gulf = "";

async function firmCompany(name: string, jurisdiction: string): Promise<string> {
  const id = (await c.party.createOrganization({ tenantId: tenant, legalName: name }, SYSTEM_ACTOR)).partyId;
  await c.party.registerLegalEntity(
    { tenantId: tenant, organizationPartyId: id, jurisdiction, entityType: "company" },
    SYSTEM_ACTOR,
  );
  await c.documents.setPreference({ tenantId: tenant, clientJurisdiction: jurisdiction, firmEntityPartyId: id }, SYSTEM_ACTOR);
  return id;
}

beforeAll(async () => {
  const [t] = await c.owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`entity-prose-${stamp}`}, 'Entity Prose Test', 'INR') RETURNING id
  `;
  if (!t) throw new Error("could not create the test tenant");
  tenant = t.id;
  await c.documentRepository.seedFirmEntity(tenant, "Entity Prose Test Group");
  client = (await c.party.createOrganization({ tenantId: tenant, legalName: "Harbour Foods" }, SYSTEM_ACTOR)).partyId;
  india = await firmCompany("Prose India Pvt Ltd", "IN");
  gulf = await firmCompany("Prose Gulf FZE", "AE");

  let order = 0;
  for (const [kind, body, jurisdiction, issuer] of [
    ["exclusion", "Default: statutory fees are not included.", null, null],
    ["exclusion", "Default: representation before courts.", null, null],
    ["commercial", "Default: invoices are payable within 15 days.", null, null],
    ["commercial", "Default: all fees are exclusive of GST as applicable.", "IN", null],
    ["exclusion", "UAE: free-zone licence renewals are not included.", null, gulf],
    ["exclusion", "UAE: ESR filings are quoted separately.", "AE", gulf],
  ] as const) {
    order += 1;
    await c.documents.addStandardBlock(
      { tenantId: tenant, kind, body, sortOrder: order, jurisdiction, issuingEntityPartyId: issuer },
      SYSTEM_ACTOR,
    );
  }
});

afterAll(() => c.end());

async function proseOf(proposalId: string): Promise<string[]> {
  const rows = await c.owner<{ kind: string; body: string }[]>`
    SELECT kind, body FROM crm.document_block
    WHERE proposal_id = ${proposalId} AND removed_at IS NULL ORDER BY kind, sort_order
  `;
  return rows.map((r) => `${r.kind}: ${r.body}`);
}

describe("seeding a proposal from its issuer's standard prose (T6.18, D5)", () => {
  it("an AE-issued proposal gets AE's own exclusions and the firm's default commercials", async () => {
    const p = await c.proposals.draft(
      {
        tenantId: tenant,
        partyId: client,
        issuingEntityPartyId: gulf,
        title: "Harbour FY27",
        currency: "AED",
        fxRate: "22.75",
        fxRateDate: "2026-09-28",
      },
      SYSTEM_ACTOR,
    );
    expect(await proseOf(p.id)).toEqual([
      "commercial: Default: invoices are payable within 15 days.",
      "exclusion: UAE: free-zone licence renewals are not included.",
      "exclusion: UAE: ESR filings are quoted separately.",
    ]);
    // Each copied line still points at the standard row it came from.
    const [sourced] = await c.owner<{ n: number }[]>`
      SELECT count(*)::int AS n FROM crm.document_block b
      JOIN crm.standard_document_block s ON s.id = b.source_id
      WHERE b.proposal_id = ${p.id} AND s.issuing_entity_party_id = ${gulf}
    `;
    expect(sourced?.n).toBe(2);
  });

  it("an IN-issued proposal with no client country takes India's lines — no longer only `*`", async () => {
    const p = await c.proposals.draft(
      { tenantId: tenant, partyId: client, issuingEntityPartyId: india, title: "Harbour India", currency: "INR", fxRate: "1", fxRateDate: "2026-09-28" },
      SYSTEM_ACTOR,
    );
    expect(await proseOf(p.id)).toEqual([
      "commercial: Default: invoices are payable within 15 days.",
      "commercial: Default: all fees are exclusive of GST as applicable.",
      "exclusion: Default: statutory fees are not included.",
      "exclusion: Default: representation before courts.",
    ]);
  });

  it("the client's country, when sent, still decides the country filter inside the issuer's set", async () => {
    const p = await c.proposals.draft(
      {
        tenantId: tenant,
        partyId: client,
        issuingEntityPartyId: gulf,
        clientJurisdiction: "IN",
        title: "Harbour via Gulf",
        currency: "AED",
        fxRate: "22.75",
        fxRateDate: "2026-09-28",
      },
      SYSTEM_ACTOR,
    );
    expect(await proseOf(p.id)).toEqual([
      "commercial: Default: invoices are payable within 15 days.",
      "commercial: Default: all fees are exclusive of GST as applicable.",
      "exclusion: UAE: free-zone licence renewals are not included.",
    ]);
  });

  it("the standard read carries the company, and filters by it", async () => {
    const own = await c.documents.listStandardBlocks(tenant, gulf);
    expect(own.map((b) => b.issuingEntityPartyId)).toEqual([gulf, gulf]);
    const all = await c.documents.listStandardBlocks(tenant);
    expect(all.filter((b) => b.issuingEntityPartyId === null)).toHaveLength(4);
  });

  it("the column refuses another firm's company, by its composite key", async () => {
    const [other] = await c.owner<{ id: string }[]>`
      INSERT INTO tenancy.tenant (slug, name, reporting_currency)
      VALUES (${`entity-prose-other-${stamp}`}, 'Other Firm', 'INR') RETURNING id
    `;
    const foreign = await c.documentRepository.seedFirmEntity(other?.id ?? "", "Other Firm LLP");
    await expect(c.owner`
      INSERT INTO crm.standard_document_block (tenant_id, kind, body, sort_order, issuing_entity_party_id)
      VALUES (${tenant}, 'exclusion', 'Borrowed.', 1, ${foreign})
    `).rejects.toThrow(/std_block_issuing_entity_fkey/);
  });
});
