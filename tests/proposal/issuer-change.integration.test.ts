// T6.18 · changing a draft's issuer and currency, against real Postgres.
//
// What only the database can prove: that the new issuer and that company's
// standard prose land in ONE transaction (a failure writing the prose leaves
// the old issuer and the old prose standing), that 0312's ON UPDATE CASCADE lets
// the currency move over a line struck off the draft, and that the WHERE
// refuses a new currency over a live line even past the service.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/proposal/issuer-change.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import { composeProposals } from "./compose-postgres";

const c = composeProposals();
const stamp = String(Date.now());
let tenant = "";
let client = "";
let fallback = "";
let gulf = "";
let gst = "";

beforeAll(async () => {
  const [t] = await c.owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`issuer-change-${stamp}`}, 'Issuer Change Test', 'INR') RETURNING id
  `;
  if (!t) throw new Error("could not create the test tenant");
  tenant = t.id;
  fallback = await c.documentRepository.seedFirmEntity(tenant, "Issuer Change Test Pvt Ltd");
  client = (await c.party.createOrganization({ tenantId: tenant, legalName: "Meridian Foods" }, SYSTEM_ACTOR))
    .partyId;

  // The firm's UAE company: an organization, registered in AE, named for AE.
  gulf = (await c.party.createOrganization({ tenantId: tenant, legalName: "Test Gulf FZE" }, SYSTEM_ACTOR))
    .partyId;
  await c.party.registerLegalEntity(
    { tenantId: tenant, organizationPartyId: gulf, jurisdiction: "AE", entityType: "fze" },
    SYSTEM_ACTOR,
  );
  await c.documents.setPreference(
    { tenantId: tenant, clientJurisdiction: "AE", firmEntityPartyId: gulf },
    SYSTEM_ACTOR,
  );

  for (const [body, jurisdiction, sortOrder] of [
    ["Anything not in the scope is excluded.", null, 1],
    ["All fees are exclusive of GST as applicable.", "IN", 2],
    ["All fees are exclusive of VAT as applicable.", "AE", 3],
  ] as const) {
    await c.documents.addStandardBlock(
      { tenantId: tenant, kind: "commercial", body, sortOrder, jurisdiction },
      SYSTEM_ACTOR,
    );
  }

  const defined = await c.config.define(
    { tenantId: tenant, kind: "service", key: "gst", body: { name: "GST returns", billingBasis: "fixed" } },
    SYSTEM_ACTOR,
  );
  await c.config.publish({ tenantId: tenant, kind: "service", key: "gst", version: 1 }, SYSTEM_ACTOR);
  gst = defined.draft.id;
});

afterAll(() => c.end());

async function draftIndian(): Promise<string> {
  const p = await c.proposals.draft(
    {
      tenantId: tenant,
      partyId: client,
      clientJurisdiction: "IN",
      title: "Meridian FY27",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-06-01",
    },
    SYSTEM_ACTOR,
  );
  return p.id;
}

async function liveProse(proposalId: string): Promise<string[]> {
  const rows = await c.owner<{ body: string }[]>`
    SELECT body FROM crm.document_block
    WHERE proposal_id = ${proposalId} AND removed_at IS NULL ORDER BY sort_order
  `;
  return rows.map((r) => r.body);
}

describe("a draft's issuer, against real Postgres (T6.18, D9)", () => {
  it("moves the issuer and replaces the prose in one statement set, the old lines struck not erased", async () => {
    const id = await draftIndian();
    expect(await liveProse(id)).toEqual([
      "Anything not in the scope is excluded.",
      "All fees are exclusive of GST as applicable.",
    ]);
    await c.proposals.revise({ tenantId: tenant, proposalId: id, issuingEntityPartyId: gulf }, SYSTEM_ACTOR);

    const [row] = await c.owner<{ issuing_entity_party_id: string }[]>`
      SELECT issuing_entity_party_id FROM crm.proposal WHERE id = ${id}
    `;
    expect(row?.issuing_entity_party_id).toBe(gulf);
    expect(await liveProse(id)).toEqual([
      "Anything not in the scope is excluded.",
      "All fees are exclusive of VAT as applicable.",
    ]);
    const [struck] = await c.owner<{ n: number }[]>`
      SELECT count(*)::int AS n FROM crm.document_block
      WHERE proposal_id = ${id} AND removed_at IS NOT NULL
    `;
    expect(struck?.n).toBe(2);
    const view = await c.proposals.describe(tenant, id);
    expect(view.issuer).toMatchObject({ partyId: gulf, name: "Test Gulf FZE", jurisdiction: "AE" });
  });

  it("is ONE transaction: when the prose cannot be written, the issuer does not move either", async () => {
    const id = await draftIndian();
    // A cover letter is letter-only (0083): the database refuses it on a
    // proposal, half-way through the change.
    await expect(
      c.repository.revise(tenant, id, { issuingEntityPartyId: gulf }, [
        { id: crypto.randomUUID(), kind: "cover", body: "Dear client,", isHeading: false, sortOrder: 1, sourceId: null },
      ]),
    ).rejects.toThrow();
    const [row] = await c.owner<{ issuing_entity_party_id: string }[]>`
      SELECT issuing_entity_party_id FROM crm.proposal WHERE id = ${id}
    `;
    expect(row?.issuing_entity_party_id).toBe(fallback);
    expect(await liveProse(id)).toEqual([
      "Anything not in the scope is excluded.",
      "All fees are exclusive of GST as applicable.",
    ]);
  });

  it("refuses to replace prose edited for this client until told to", async () => {
    const id = await draftIndian();
    const [first] = (await c.proposals.describe(tenant, id)).blocks;
    await c.documents.editBlock(tenant, first?.id ?? "", { body: "Nothing is excluded for you." });
    await expect(
      c.proposals.revise({ tenantId: tenant, proposalId: id, issuingEntityPartyId: gulf }, SYSTEM_ACTOR),
    ).rejects.toMatchObject({ code: "PROSE_EDITED", editedCount: 1 });
    expect(await liveProse(id)).toContain("Nothing is excluded for you.");
    await c.proposals.revise(
      { tenantId: tenant, proposalId: id, issuingEntityPartyId: gulf, replaceEditedProse: true },
      SYSTEM_ACTOR,
    );
    expect(await liveProse(id)).not.toContain("Nothing is excluded for you.");
  });
});

describe("a draft's currency, against real Postgres (T6.18, 0312)", () => {
  it("moves over a line struck off the draft — the key cascades to it", async () => {
    const id = await draftIndian();
    const line = await c.proposals.addLine({
      tenantId: tenant,
      proposalId: id,
      serviceVersionId: gst,
      description: "GST returns",
      quantity: "1",
      unitAmount: "15000",
      discountPercent: "0",
    });
    await c.proposals.removeLine(tenant, id, line.id);
    const revised = await c.proposals.revise(
      { tenantId: tenant, proposalId: id, currency: "AED", fxRate: "22.75", fxRateDate: "2026-09-28" },
      SYSTEM_ACTOR,
    );
    expect(revised).toMatchObject({ currency: "AED", fxRate: "22.7500000000", fxRateDate: "2026-09-28" });
    const [pulled] = await c.owner<{ currency: string }[]>`
      SELECT currency FROM crm.proposal_line WHERE id = ${line.id}
    `;
    expect(pulled?.currency).toBe("AED");
  });

  it("the WHERE refuses a new currency over a live line, below the service", async () => {
    const id = await draftIndian();
    await c.proposals.addLine({
      tenantId: tenant,
      proposalId: id,
      serviceVersionId: gst,
      description: "GST returns",
      quantity: "1",
      unitAmount: "15000",
      discountPercent: "0",
    });
    await expect(
      c.proposals.revise(
        { tenantId: tenant, proposalId: id, currency: "USD", fxRate: "83", fxRateDate: "2026-09-28" },
        SYSTEM_ACTOR,
      ),
    ).rejects.toMatchObject({ code: "CURRENCY_LOCKED_BY_LINES" });
    expect(
      await c.repository.revise(tenant, id, { currency: "USD", fxRate: "83", fxRateDate: "2026-09-28" }),
    ).toBeNull();
    const [row] = await c.owner<{ currency: string }[]>`SELECT currency FROM crm.proposal WHERE id = ${id}`;
    expect(row?.currency).toBe("INR");
  });
});
