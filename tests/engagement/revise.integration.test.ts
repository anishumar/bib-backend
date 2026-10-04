// T6.18 S6 · a DRAFT letter changes in place, against real Postgres.
//
// What only the database can prove: that the head's one UPDATE keeps what it
// was not told about and clears what it was told to clear; that a new issuer's
// wording is written in the SAME transaction as the issuer (the old lines struck
// off, the company's own set in their place); that a new main currency is
// refused in SQL over a live line in the old one (0344); that a line
// changes in place and reads back resolved; and that the money per frequency
// counts a section's fee once.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/engagement/revise.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import { EngagementService } from "../../src/usecase/engagement/service";
import { PostgresEngagementRepository } from "../../src/infrastructure/postgres/engagement-repository";
import { PostgresSignatureRequestRepository } from "../../src/infrastructure/postgres/signature-request-repository";
import { PostgresPartyRepository } from "../../src/infrastructure/postgres/party-repository";
import { PostgresRelationshipRepository } from "../../src/infrastructure/postgres/relationship-repository";
import { PostgresFirmTimeZone } from "../../src/infrastructure/postgres/firm-timezone-repository";
import { PostgresConfigRepository } from "../../src/infrastructure/postgres/config-repository";
import { PostgresFirmEntityRepository } from "../../src/infrastructure/postgres/firm-entity-repository";
import { FirmEntityService } from "../../src/usecase/document/firm-entities";
import { AttestedSigner } from "../../src/infrastructure/esign/attested-signer";
import { Sha256ContentHasher } from "../../src/infrastructure/crypto/random-tokens";
import { FakeFirmSignatory } from "../../src/testfakes/engagement";
import { systemIds } from "../../src/platform/ids";
import { systemClock } from "../../src/platform/clock";
import { composeProposals } from "../proposal/compose-postgres";

const c = composeProposals();
const repository = new PostgresEngagementRepository(c.app);
const letters = new EngagementService({
  letters: repository,
  library: new PostgresConfigRepository(c.app),
  documents: c.documents,
  firm: new FakeFirmSignatory(),
  firmSignatureImage: { activeSignatureVersion: () => Promise.resolve(null) },
  parties: new PostgresPartyRepository(c.app),
  quotes: c.proposals,
  structure: new PostgresRelationshipRepository(c.app),
  timeZones: new PostgresFirmTimeZone(c.app),
  esign: new AttestedSigner(),
  migrationSigner: new AttestedSigner(),
  hasher: new Sha256ContentHasher(),
  signatures: new PostgresSignatureRequestRepository(c.app),
  dispatch: null,
  letterPdf: null,
  signedCopies: null,
  tenants: { activeTenantIds: () => Promise.resolve([]) },
  ids: systemIds,
  clock: systemClock,
  events: c.ledger,
});
const companies = new FirmEntityService({
  firmEntities: new PostgresFirmEntityRepository(c.app),
  ids: systemIds,
  events: c.ledger,
});

const stamp = String(Date.now());
let tenant = "";
let client = "";
let gulf = "";
let gst = "";
let audit = "";

beforeAll(async () => {
  const [t] = await c.owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`letter-revise-${stamp}`}, 'Letter Revise Test', 'INR') RETURNING id
  `;
  if (!t) throw new Error("could not create the test tenant");
  tenant = t.id;
  const self = await c.documentRepository.seedFirmEntity(tenant, "Letter Revise Test Pvt Ltd");
  await companies.edit({ tenantId: tenant, partyId: self, jurisdiction: "IN", entityType: "Private Limited" }, SYSTEM_ACTOR);
  gulf = (await companies.create({ tenantId: tenant, name: "Revise Gulf FZE", jurisdiction: "AE", entityType: "FZE" }, SYSTEM_ACTOR)).partyId;
  client = (await c.party.createClientCompany({ tenantId: tenant, legalName: "Orbit Traders", jurisdiction: "IN", entityType: "private_limited" }, SYSTEM_ACTOR)).partyId;

  // The default set, and the Gulf company's OWN commercials (D5).
  let order = 0;
  for (const [kind, body, owner] of [
    ["exclusion", "Representation before any authority.", null],
    ["commercial", "All fees are exclusive of GST.", null],
    ["commercial", "All fees are exclusive of VAT.", "gulf"],
    ["cover", "Thank you for choosing us.", null],
  ] as const) {
    order += 1;
    await c.documents.addStandardBlock(
      { tenantId: tenant, kind, body, sortOrder: order, issuingEntityPartyId: owner === null ? null : gulf },
      SYSTEM_ACTOR,
    );
  }

  for (const [key, body] of [
    ["gst", { name: "GST returns", billingBasis: "fixed", recurrence: "monthly", scope: "Monthly GST returns." }],
    ["audit", { name: "Statutory audit", billingBasis: "fixed", recurrence: "annually" }],
  ] as const) {
    const defined = await c.config.define({ tenantId: tenant, kind: "service", key, body }, SYSTEM_ACTOR);
    await c.config.publish({ tenantId: tenant, kind: "service", key, version: 1 }, SYSTEM_ACTOR);
    if (key === "gst") gst = defined.draft.id;
    else audit = defined.draft.id;
  }
});

afterAll(() => c.end());

async function draft(): Promise<string> {
  const letter = await letters.draft(
    {
      tenantId: tenant,
      partyId: client,
      jurisdiction: "IN",
      title: "Engagement Letter for Orbit Traders",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-09-28",
      advanceRequired: false,
      background: "Orbit is a trading house.",
    },
    SYSTEM_ACTOR,
  );
  return letter.id;
}

describe("a draft letter's head changes in place (T6.18 S6)", () => {
  it("writes what it was told, clears what it was told to clear, keeps the rest", async () => {
    const id = await draft();
    await letters.revise(
      {
        tenantId: tenant,
        letterId: id,
        title: "Engagement Letter for Orbit Traders LLP",
        background: null,
        effectiveFrom: "2026-10-01",
        advanceRequired: true,
        advanceAmount: "15000",
      },
      SYSTEM_ACTOR,
    );
    const view = await letters.describe(tenant, id);
    expect(view.letter).toMatchObject({
      title: "Engagement Letter for Orbit Traders LLP",
      background: null,
      effectiveFrom: "2026-10-01",
      advanceRequired: true,
      advanceAmount: "15000.0000",
      jurisdiction: "IN",
      currency: "INR",
    });
    expect(view.issuerJurisdiction).toBe("IN");
  });

  it("a new issuer's wording is written in the same transaction, the old lines struck off", async () => {
    const id = await draft();
    const before = await c.documents.listBlocks(tenant, { kind: "engagement_letter", id });
    expect(before.filter((b) => b.kind === "commercial").map((b) => b.body)).toEqual([
      "All fees are exclusive of GST.",
    ]);
    await letters.revise(
      { tenantId: tenant, letterId: id, issuingEntityPartyId: gulf, jurisdiction: "AE" },
      SYSTEM_ACTOR,
    );
    const view = await letters.describe(tenant, id);
    expect(view.issuingEntity.id).toBe(gulf);
    expect(view.issuerJurisdiction).toBe("AE");
    // The Gulf company's OWN commercials; the default exclusions and cover.
    expect(view.blocks.filter((b) => b.kind === "commercial").map((b) => b.body)).toEqual([
      "All fees are exclusive of VAT.",
    ]);
    expect(view.blocks.filter((b) => b.kind === "exclusion").map((b) => b.body)).toEqual([
      "Representation before any authority.",
    ]);
    const [struck] = await c.owner<{ n: number }[]>`
      SELECT count(*)::int AS n FROM crm.document_block
      WHERE engagement_letter_id = ${id} AND removed_at IS NOT NULL
    `;
    expect(struck?.n).toBe(before.length);
    const verbs = await c.owner<{ verb: string }[]>`
      SELECT verb FROM ledger.event WHERE tenant_id = ${tenant} AND object_id = ${id}
    `;
    expect(verbs.map((v) => v.verb)).toContain("engagement_letter.issuer_changed");
  });

  it("refuses a new main currency over a LIVE line in the old one, and not over a pulled one (0344)", async () => {
    const id = await draft();
    const line = await letters.addLine({
      tenantId: tenant,
      letterId: id,
      entityPartyId: client,
      serviceVersionId: gst,
      description: "GST returns",
      quantity: "1",
      unitAmount: "5000",
      discountPercent: "0",
    });
    await expect(
      letters.revise(
        { tenantId: tenant, letterId: id, currency: "AED", fxRate: "22.75", fxRateDate: "2026-09-28" },
        SYSTEM_ACTOR,
      ),
    ).rejects.toMatchObject({ code: "CURRENCY_LOCKED_BY_LINES" });
    // Past the service's check, the WHERE refuses it too.
    const written = await repository.revise(
      tenant,
      id,
      { currency: "AED", fxRate: "22.75", fxRateDate: "2026-09-28" },
      null,
    );
    expect(written).toBeNull();
    // Pulled, the line holds nothing back: its key no longer carries the
    // letter's currency (0344).
    await letters.removeLine(tenant, id, line.id);
    const moved = await letters.revise(
      { tenantId: tenant, letterId: id, currency: "AED", fxRate: "22.75", fxRateDate: "2026-09-28" },
      SYSTEM_ACTOR,
    );
    expect(moved.currency).toBe("AED");
    // A letter that priced nothing moves.
    const bare = await draft();
    await letters.revise(
      { tenantId: tenant, letterId: bare, currency: "AED", fxRate: "22.75", fxRateDate: "2026-09-28" },
      SYSTEM_ACTOR,
    );
    expect((await letters.describe(tenant, bare)).letter.currency).toBe("AED");
  });
});

describe("a line changes in place, and the read carries the preview's plan and totals", () => {
  it("changes a line and reads it back resolved; null goes back to the catalogue", async () => {
    const id = await draft();
    const line = await letters.addLine({
      tenantId: tenant,
      letterId: id,
      entityPartyId: client,
      serviceVersionId: gst,
      description: "GST returns",
      quantity: "1",
      unitAmount: "5000",
      discountPercent: "0",
    });
    await letters.updateLine({
      tenantId: tenant,
      letterId: id,
      lineId: line.id,
      description: "GST returns and reconciliation",
      unitAmount: "6500",
      scopeOverride: "Monthly GST returns and a quarterly reconciliation.",
      effectiveFrom: "2026-11-01",
    });
    let view = await letters.describe(tenant, id);
    expect(view.lines[0]).toMatchObject({
      line: { description: "GST returns and reconciliation", unitAmount: "6500.0000", effectiveFrom: "2026-11-01" },
      terms: { scope: { text: "Monthly GST returns and a quarterly reconciliation.", tailored: true } },
    });
    await letters.updateLine({ tenantId: tenant, letterId: id, lineId: line.id, scopeOverride: null });
    view = await letters.describe(tenant, id);
    expect(view.lines[0]?.terms.scope).toEqual({ text: "Monthly GST returns.", tailored: false });
  });

  it("totals per frequency count a section's fee once, and the plan letters it as the PDF does", async () => {
    const id = await draft();
    await letters.addLine({
      tenantId: tenant,
      letterId: id,
      entityPartyId: client,
      serviceVersionId: gst,
      description: "GST returns",
      quantity: "1",
      unitAmount: "5000",
      discountPercent: "10",
    });
    const group = await letters.addFeeGroup(tenant, id, {
      title: "Annual compliance",
      billingFrequency: "annually",
      amount: "150000",
    });
    await letters.addLine({
      tenantId: tenant,
      letterId: id,
      entityPartyId: client,
      serviceVersionId: audit,
      description: "Statutory audit",
      quantity: "1",
      discountPercent: "0",
      feeGroupId: group.id,
    });
    await letters.addLine({
      tenantId: tenant,
      letterId: id,
      entityPartyId: client,
      serviceVersionId: gst,
      description: "GST advisory",
      quantity: "1",
      discountPercent: "0",
      pricingNote: "As mutually agreed",
    });
    const view = await letters.describe(tenant, id);
    expect(view.totalsByFrequency).toEqual([
      { currency: "INR", frequency: "monthly", net: "4500.0000", lineCount: 2, unpricedLineCount: 1 },
      { currency: "INR", frequency: "annually", net: "150000.0000", lineCount: 1, unpricedLineCount: 0 },
    ]);
    expect(view.document.sections.map((s) => `${s.code}. ${s.title}`)).toEqual([
      "A. Annual compliance",
      "B. Other services",
    ]);
    expect(view.document.fees.map((f) => f.code)).toEqual(["A", "B1", "B2"]);
  });
});
