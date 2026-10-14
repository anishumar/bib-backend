// 0394 · proposal sections against real Postgres: the totals view, the
// grouped-line CHECK, the struck-off trigger and the currency move.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/proposal/fee-groups.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresLeadRepository } from "../../src/infrastructure/postgres/lead-repository";
import { PostgresFirmTimeZone } from "../../src/infrastructure/postgres/firm-timezone-repository";
import { PostgresProposalRepository } from "../../src/infrastructure/postgres/proposal-repository";
import { PostgresPartyRepository } from "../../src/infrastructure/postgres/party-repository";
import { PostgresIdentifierRepository } from "../../src/infrastructure/postgres/identifier-repository";
import { PostgresRelationshipRepository } from "../../src/infrastructure/postgres/relationship-repository";
import { PostgresMembershipRepository } from "../../src/infrastructure/postgres/membership-repository";
import { PostgresServiceAxisRepository } from "../../src/infrastructure/postgres/service-axis-repository";
import { PostgresConfigRepository } from "../../src/infrastructure/postgres/config-repository";
import { PostgresDocumentRepository } from "../../src/infrastructure/postgres/document-repository";
import {
  PostgresDocumentBlockRepository,
  PostgresStandardBlockRepository,
} from "../../src/infrastructure/postgres/block-repository";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { LedgerService } from "../../src/usecase/ledger/service";
import { PartyService } from "../../src/usecase/party/service";
import { ConfigService } from "../../src/usecase/config/service";
import { ProposalService } from "../../src/usecase/proposal/service";
import { DocumentService } from "../../src/usecase/document/service";
import { FAKE_PROPOSAL_LINKS, UNWIRED_PROPOSAL_PDFS } from "../../src/testfakes/proposal";
import { RandomTokenFactory } from "../../src/infrastructure/crypto/random-tokens";
import { systemIds } from "../../src/platform/ids";
import { systemClock } from "../../src/platform/clock";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const ledger = new LedgerService({ events: new PostgresEventStore(app), ids: systemIds });
const configRepository = new PostgresConfigRepository(app);
const config = new ConfigService({
  registry: configRepository,
  holders: new PostgresMembershipRepository(app),
  axes: new PostgresServiceAxisRepository(app),
  ids: systemIds,
  events: ledger,
});
const party = new PartyService({
  parties: new PostgresPartyRepository(app),
  identifiers: new PostgresIdentifierRepository(app),
  relationships: new PostgresRelationshipRepository(app),
  ids: systemIds,
  events: ledger,
});
const documentRepository = new PostgresDocumentRepository(app);
const documents = new DocumentService({
  preferences: documentRepository,
  refs: documentRepository,
  standardBlocks: new PostgresStandardBlockRepository(app),
  blocks: new PostgresDocumentBlockRepository(app),
  ids: systemIds,
  events: ledger,
  calendars: new PostgresFirmTimeZone(app),
  fiscalYears: new PostgresConfigRepository(app),
});
const service = new ProposalService({
  proposals: new PostgresProposalRepository(app),
  catalogue: configRepository,
  policies: configRepository,
  parties: new PostgresPartyRepository(app),
  leads: new PostgresLeadRepository(app),
  documents,
  shareTokens: new RandomTokenFactory(),
  structure: new PostgresRelationshipRepository(app),
  timeZones: new PostgresFirmTimeZone(app),
  staff: new PostgresMembershipRepository(app),
  mailer: null,
  pdfs: UNWIRED_PROPOSAL_PDFS,
  links: FAKE_PROPOSAL_LINKS,
  ids: systemIds,
  clock: systemClock,
  events: ledger,
});

const stamp = String(Date.now());
let tenant = "";
let client = "";
let books = "";
let gst = "";

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`fee-groups-${stamp}`}, 'Fee Groups Test', 'INR') RETURNING id
  `;
  if (!t) throw new Error("could not create the test tenant");
  tenant = t.id;
  await documentRepository.seedFirmEntity(tenant, "Fee Groups Test LLP");
  client = (
    await party.createClientCompany(
      { tenantId: tenant, legalName: "EduHub Learning", jurisdiction: "IN", entityType: "private_limited" },
      SYSTEM_ACTOR,
    )
  ).partyId;
  for (const [key, name, price] of [
    ["books", "Accounting", "30000.00"],
    ["gst", "GST returns", "15000.00"],
  ] as const) {
    const defined = await config.define(
      {
        tenantId: tenant,
        kind: "service",
        key,
        body: { name, billingBasis: "retainer", recurrence: "monthly", listPrice: { amount: price, currency: "INR" } },
      },
      SYSTEM_ACTOR,
    );
    await config.publish({ tenantId: tenant, kind: "service", key, version: 1 }, SYSTEM_ACTOR);
    if (key === "books") books = defined.draft.id;
    else gst = defined.draft.id;
  }
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

async function draftWithSection(): Promise<{ proposalId: string; grouped: string; own: string; groupId: string }> {
  const p = await service.draft(
    { tenantId: tenant, partyId: client, title: "EduHub FY27", currency: "INR", fxRate: "1", fxRateDate: "2026-10-01" },
    SYSTEM_ACTOR,
  );
  const group = await service.addFeeGroup(tenant, p.id, {
    title: "Accounting, Tax & GST",
    billingFrequency: "monthly",
    amount: "70000",
  });
  const grouped = await service.addLine({
    tenantId: tenant,
    proposalId: p.id,
    serviceVersionId: books,
    description: "Accounting",
    quantity: "1",
    discountPercent: "0",
    feeGroupId: group.id,
  });
  const own = await service.addLine({
    tenantId: tenant,
    proposalId: p.id,
    serviceVersionId: gst,
    description: "GST returns",
    quantity: "1",
    discountPercent: "0",
  });
  return { proposalId: p.id, grouped: grouped.id, own: own.id, groupId: group.id };
}

describe("proposal sections against real Postgres (0394)", () => {
  it("totals count the section's fee once and its service not at all", async () => {
    const { proposalId, groupId, grouped } = await draftWithSection();
    const view = await service.describe(tenant, proposalId);
    expect(view.feeGroups).toEqual([expect.objectContaining({ code: "A", lineIds: [grouped] })]);
    expect(view.feeGroups[0]?.group.id).toBe(groupId);
    // 70,000 section + 15,000 GST at its list price; no "as agreed" line.
    expect(view.totals).toEqual([
      expect.objectContaining({ currency: "INR", net: "85000.0000", unpricedLineCount: 0 }),
    ]);
    expect(view.totalsByFrequency).toEqual([
      expect.objectContaining({ currency: "INR", frequency: "monthly", net: "85000.0000", unpricedLineCount: 0 }),
    ]);
    expect(view.annualValue).toEqual([{ amount: "1020000.0000", currency: "INR" }]);
    const listed = (await service.list(tenant, {})).find((s) => s.proposal.id === proposalId);
    expect(listed?.totals[0]?.net).toBe("85000.0000");
  });

  it("refuses a price on a grouped line, and striking off a section still paying for one", async () => {
    const { grouped, groupId } = await draftWithSection();
    await expect(owner`UPDATE crm.proposal_line SET unit_amount = 100 WHERE id = ${grouped}`).rejects.toThrow(
      /proposal_line_grouped_is_unpriced_chk/,
    );
    await expect(
      owner`UPDATE crm.proposal_fee_group SET removed_at = now() WHERE id = ${groupId}`,
    ).rejects.toThrow(/still covers 1 live service/);
  });

  it("moves a section's services with its new currency, in one statement", async () => {
    const { proposalId, groupId, grouped } = await draftWithSection();
    await service.setRate(
      { tenantId: tenant, proposalId, currency: "USD", fxRate: "84", fxRateDate: "2026-10-01" },
      SYSTEM_ACTOR,
    );
    const edited = await service.editFeeGroup(tenant, proposalId, groupId, { currency: "USD", amount: "750" });
    expect(edited).toMatchObject({ currency: "USD", amount: "750.0000" });
    const lines = await service.describe(tenant, proposalId);
    expect(lines.lines.find((l) => l.line.id === grouped)?.line.currency).toBe("USD");
    expect(lines.totals.map((t) => [t.currency, t.net])).toEqual([
      ["INR", "15000.0000"],
      ["USD", "750.0000"],
    ]);
  });

  it("moves a service out with a price, and a section left empty can then go", async () => {
    const { proposalId, groupId, grouped } = await draftWithSection();
    const out = await service.setLinePricing({
      tenantId: tenant,
      proposalId,
      lineId: grouped,
      feeGroupId: null,
      unitAmount: "30000",
    });
    expect(out).toMatchObject({ feeGroupId: null, unitAmount: "30000.0000" });
    await service.removeFeeGroup(tenant, proposalId, groupId);
    const view = await service.describe(tenant, proposalId);
    expect(view.feeGroups).toEqual([]);
    expect(view.totals[0]?.net).toBe("45000.0000");
  });
});
