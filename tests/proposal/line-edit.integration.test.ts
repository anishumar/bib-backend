// T6.18 · the line edit's UPDATE, run against real Postgres.
//
// The unit tests prove the rules against a fake; what only the database can
// prove is the statement itself: that the UPDATE's WHERE refuses a line on a
// proposal that has gone out, that the totals the view computes follow the
// edit, that a null override reads back as the catalogue's words through the
// real join, and that a lapsed sign-off clears BOTH approval columns in the same
// transaction (0011 holds them together with a CHECK).
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/proposal/line-edit.integration.test.ts
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
let gst = "";
let approver = "";

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`line-edit-${stamp}`}, 'Line Edit Test', 'INR') RETURNING id
  `;
  if (!t) throw new Error("could not create the test tenant");
  tenant = t.id;
  await documentRepository.seedFirmEntity(tenant, "Line Edit Test LLP");
  client = (
    await party.createClientCompany({ tenantId: tenant, legalName: "Meridian Textiles", jurisdiction: "IN", entityType: "private_limited" }, SYSTEM_ACTOR)
  ).partyId;

  const defined = await config.define(
    {
      tenantId: tenant,
      kind: "service",
      key: "gst-filing",
      body: {
        name: "GST monthly filing",
        ref: "H1",
        billingBasis: "fixed",
        recurrence: "monthly",
        listPrice: { amount: "25000.00", currency: "INR" },
        scope: "Monthly GSTR-1 and GSTR-3B.",
      },
    },
    SYSTEM_ACTOR,
  );
  await config.publish({ tenantId: tenant, kind: "service", key: "gst-filing", version: 1 }, SYSTEM_ACTOR);
  gst = defined.draft.id;

  await config.define(
    { tenantId: tenant, kind: "policy", key: "discount", body: { maxDiscountPercent: "15" } },
    SYSTEM_ACTOR,
  );
  await config.publish({ tenantId: tenant, kind: "policy", key: "discount", version: 1 }, SYSTEM_ACTOR);

  const [a] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email) VALUES (${`line-edit-approver-${stamp}@example.test`})
    RETURNING id
  `;
  if (!a) throw new Error("could not create the approver");
  approver = a.id;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

async function draftWithLine(discountPercent = "0"): Promise<{ proposalId: string; lineId: string }> {
  const p = await service.draft(
    {
      tenantId: tenant,
      partyId: client,
      title: "Meridian FY27",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-06-01",
    },
    SYSTEM_ACTOR,
  );
  const line = await service.addLine({
    tenantId: tenant,
    proposalId: p.id,
    serviceVersionId: gst,
    description: "GST monthly filing",
    quantity: "12",
    unitAmount: "2000",
    discountPercent,
  });
  return { proposalId: p.id, lineId: line.id };
}

describe("the line edit's UPDATE, against real Postgres (T6.18)", () => {
  it("writes the change, keeps the pin and the place, and the view's totals follow it", async () => {
    const { proposalId, lineId } = await draftWithLine();
    const line = await service.updateLine(
      {
        tenantId: tenant,
        proposalId,
        lineId,
        quantity: "6",
        unitAmount: "1499.50",
        discountPercent: "12.5",
        billingFrequency: "quarterly",
        jurisdiction: "IN",
        oopEstimate: { min: "500", max: "900", currency: "USD" },
        scopeOverride: "Quarterly GSTR-1 only.",
      },
      SYSTEM_ACTOR,
    );
    expect(line.serviceVersionId).toBe(gst);
    expect(line.position).toBe(1);

    const view = await service.describe(tenant, proposalId);
    const read = view.lines[0];
    expect(read?.line.quantity).toBe("6.0000");
    expect(read?.line.billingFrequency).toBe("quarterly");
    expect(read?.line.oopEstimate).toEqual({ min: "500.0000", max: "900.0000", currency: "USD" });
    expect(read?.terms.scope).toEqual({ text: "Quarterly GSTR-1 only.", tailored: true });
    // 6 × 1499.50 = 8997.00, less 12.5% = 7872.375 → 7872.3750, from `numeric`.
    expect(read?.net).toBe("7872.3750");
    expect(view.totals[0]?.net).toBe("7872.3750");
  });

  it("null reads back as the catalogue's words and the service's recurrence through the join", async () => {
    const { proposalId, lineId } = await draftWithLine();
    await service.updateLine(
      { tenantId: tenant, proposalId, lineId, scopeOverride: "Tailored.", billingFrequency: "annually" },
      SYSTEM_ACTOR,
    );
    await service.updateLine(
      { tenantId: tenant, proposalId, lineId, scopeOverride: null, billingFrequency: null },
      SYSTEM_ACTOR,
    );
    const read = (await service.describe(tenant, proposalId)).lines[0];
    expect(read?.terms.scope).toEqual({ text: "Monthly GSTR-1 and GSTR-3B.", tailored: false });
    expect(read?.line.billingFrequency).toBe("monthly");
  });

  it("an unpriced line is written as NULL with its reason, and counted rather than summed", async () => {
    const { proposalId, lineId } = await draftWithLine();
    await service.updateLine(
      { tenantId: tenant, proposalId, lineId, unitAmount: null, pricingNote: "As mutually agreed" },
      SYSTEM_ACTOR,
    );
    const view = await service.describe(tenant, proposalId);
    expect(view.lines[0]?.line.unitAmount).toBeNull();
    expect(view.lines[0]?.net).toBeNull();
    expect(view.totals[0]?.unpricedLineCount).toBe(1);
    expect(view.totals[0]?.net).toBe("0");
  });

  it("the WHERE refuses a line on a proposal that has gone out", async () => {
    const { proposalId, lineId } = await draftWithLine();
    await service.send(tenant, proposalId, SYSTEM_ACTOR);
    await expect(
      service.updateLine({ tenantId: tenant, proposalId, lineId, quantity: "2" }, SYSTEM_ACTOR),
    ).rejects.toMatchObject({ code: "NOT_A_DRAFT" });
    // And the statement itself, below the service: the repository's WHERE
    // changes nothing and says so.
    const repo = new PostgresProposalRepository(app);
    const untouched = await repo.updateLine(
      tenant,
      proposalId,
      lineId,
      {
        description: "Changed after sending",
        quantity: "1",
        unitAmount: "1",
        currency: "INR",
        discountPercent: "0",
        jurisdiction: null,
        billingFrequency: null,
        billingTiming: null,
        billingOn: null,
        scopeOverride: null,
        clientObligationsOverride: null,
        volumeLimitsOverride: null,
        exclusionsOverride: null,
        oopEstimate: null,
        pricingNote: null,
      },
      false,
    );
    expect(untouched).toBeNull();
    const [row] = await owner<{ description: string }[]>`
      SELECT description FROM crm.proposal_line WHERE id = ${lineId}
    `;
    expect(row?.description).toBe("GST monthly filing");
  });

  it("a discount raised past the limit clears BOTH approval columns, in the same transaction", async () => {
    const { proposalId, lineId } = await draftWithLine("20");
    await service.approveDiscount(tenant, proposalId, approver, SYSTEM_ACTOR);
    await service.updateLine(
      { tenantId: tenant, proposalId, lineId, discountPercent: "35" },
      SYSTEM_ACTOR,
    );
    const [row] = await owner<{ by: string | null; at: Date | null }[]>`
      SELECT discount_approved_by AS by, discount_approved_at AS at
      FROM crm.proposal WHERE id = ${proposalId}
    `;
    expect(row).toEqual({ by: null, at: null });
    await expect(service.send(tenant, proposalId, SYSTEM_ACTOR)).rejects.toMatchObject({
      code: "DISCOUNT_NEEDS_APPROVAL",
    });
    const [event] = await owner<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM ledger.event
      WHERE object_id = ${proposalId} AND verb = 'proposal.discount_approval_lapsed'
    `;
    expect(event?.payload).toMatchObject({
      previouslyApprovedByUserId: approver,
      lineId,
      limitPercent: "15",
    });
  });
});
