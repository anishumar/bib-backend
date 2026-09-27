// 0084's database half — the proposal as a document, against a real Postgres.
//
//   THE DOCUMENT. A proposal written the way the firm's own sample is (Nexus
//   Fintech: "H3. Transfer pricing audit — Form 3CEB" under Financial Reporting
//   & Compliance, "C2. TDS/TCS — quarterly returns" under Transactions &
//   Regulatory Compliance) prints as a cover, Background, the in-scope list,
//   the Dept sections, the Summary of Fees and the Notes — and the PDF is a
//   pure function of it.
//
//   THE COLUMNS. What drafting and revising write is what a read returns, and
//   the WHERE clause that keeps a sent proposal as the client received it
//   holds for a writer that skipped the service.
//
//   THE WALLS. Blank Background prose and a proposal cover's kind are the
//   schema's to refuse or allow, for every writer.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { PostgresLeadRepository } from "../../src/infrastructure/postgres/lead-repository";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresProposalRepository } from "../../src/infrastructure/postgres/proposal-repository";
import { PostgresRenderSource } from "../../src/infrastructure/postgres/render-source";
import { PostgresServiceAxisRepository } from "../../src/infrastructure/postgres/service-axis-repository";
import { PostgresConfigRepository } from "../../src/infrastructure/postgres/config-repository";
import { PostgresDocumentRepository } from "../../src/infrastructure/postgres/document-repository";
import {
  PostgresDocumentBlockRepository,
  PostgresStandardBlockRepository,
} from "../../src/infrastructure/postgres/block-repository";
import { PostgresPartyRepository } from "../../src/infrastructure/postgres/party-repository";
import { PostgresIdentifierRepository } from "../../src/infrastructure/postgres/identifier-repository";
import { PostgresRelationshipRepository } from "../../src/infrastructure/postgres/relationship-repository";
import { PostgresFirmTimeZone } from "../../src/infrastructure/postgres/firm-timezone-repository";
import { PostgresMembershipRepository } from "../../src/infrastructure/postgres/membership-repository";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { RandomTokenFactory } from "../../src/infrastructure/crypto/random-tokens";
import { PdfLibRenderer } from "../../src/infrastructure/render/pdf-renderer";
import { LedgerService } from "../../src/usecase/ledger/service";
import { ConfigService } from "../../src/usecase/config/service";
import { PartyService } from "../../src/usecase/party/service";
import { ProposalService } from "../../src/usecase/proposal/service";
import { FAKE_PROPOSAL_LINKS, UNWIRED_PROPOSAL_PDFS } from "../../src/testfakes/proposal";
import { DocumentService } from "../../src/usecase/document/service";
import type { Flow } from "../../src/domain/render/model";
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
});
const repository = new PostgresProposalRepository(app);
const proposals = new ProposalService({
  proposals: repository,
  catalogue: configRepository,
  policies: configRepository,
  parties: new PostgresPartyRepository(app),
  leads: new PostgresLeadRepository(app),
  documents,
  shareTokens: new RandomTokenFactory(),
  structure: new PostgresRelationshipRepository(app),
  timeZones: new PostgresFirmTimeZone(app),
  staff: new PostgresMembershipRepository(app),
  // Nothing here emails a proposal (0085's own test does).
  mailer: null,
  pdfs: UNWIRED_PROPOSAL_PDFS,
  links: FAKE_PROPOSAL_LINKS,
  ids: systemIds,
  clock: systemClock,
  events: ledger,
});
const source = new PostgresRenderSource(app, () => Promise.resolve(null));

const stamp = Date.now().toString(36);
let tenant = "";
let nexus = "";
let priya = "";
let preparer = "";
const versions: Record<string, string> = {};

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`proposal-doc-${stamp}`}, 'Proposal Document Test', 'INR') RETURNING id
  `;
  if (!t) throw new Error("could not create the test tenant");
  tenant = t.id;
  await documentRepository.seedFirmEntity(tenant, "10x Global Private Limited");

  const [user] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`siddharth-${stamp}@example.test`}, 'Siddharth Kohli') RETURNING id
  `;
  if (!user) throw new Error("could not create the preparer");
  preparer = user.id;
  await owner`
    INSERT INTO tenancy.membership (tenant_id, user_id, audience, role, commercial_visibility)
    VALUES (${tenant}, ${preparer}, 'STAFF', 'partner', true)
  `;

  // The firm's Depts, in its own order — the proposal's sections.
  await owner`
    INSERT INTO tenancy.service_axis (tenant_id, axis, code, name, sort_order) VALUES
      (${tenant}, 'dept', 'FRC', 'Financial Reporting & Compliance', 1),
      (${tenant}, 'dept', 'TRC', 'Transactions & Regulatory Compliance', 2)
  `;

  nexus = (await party.createOrganization({ tenantId: tenant, legalName: "Nexus Fintech" }, SYSTEM_ACTOR)).partyId;
  priya = (await party.createPerson({ tenantId: tenant, fullName: "Priya Sharma" }, SYSTEM_ACTOR)).partyId;
  await party.addRelationship(
    { tenantId: tenant, fromPartyId: priya, toPartyId: nexus, type: "director_of", validFrom: "2024-01-01" },
    SYSTEM_ACTOR,
  );

  const publish = async (key: string, body: Record<string, unknown>): Promise<string> => {
    const defined = await config.define(
      { tenantId: tenant, kind: "service", key, body: { billingBasis: "fixed", ...body } },
      SYSTEM_ACTOR,
    );
    await config.publish({ tenantId: tenant, kind: "service", key, version: 1 }, SYSTEM_ACTOR);
    return defined.draft.id;
  };
  versions["tp"] = await publish("tp-audit", {
    name: "Transfer pricing audit — Form 3CEB",
    ref: "H3",
    module: "FRC",
    recurrence: "annually",
  });
  versions["tds"] = await publish("tds-returns", {
    name: "TDS/TCS — quarterly returns",
    ref: "C2",
    module: "TRC",
    recurrence: "quarterly",
    scope: "- Quarterly TDS/TCS returns (24Q, 26Q, 27EQ).\n- Form 16 and 16A.",
  });

  // The firm's standard Notes, which every new proposal copies (G1.7).
  let order = 0;
  for (const [kind, body, isHeading] of [
    ["team", "Analyst: CA (Semi-Qualified) with minimum 1 year experience", false],
    ["team", "Manager: Qualified CA with 5 years of post-qualification experience", false],
    ["exclusion", "The scope of work does not include following-", true],
    ["exclusion", "Any certification unless otherwise included in the scope", false],
    ["exclusion", "Anything specifically not mentioned in the scope shall be deemed excluded", false],
    ["commercial", "All fees are exclusive of GST as applicable.", false],
  ] as const) {
    order += 1;
    await documents.addStandardBlock({ tenantId: tenant, kind, body, isHeading, sortOrder: order }, SYSTEM_ACTOR);
  }
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

/** The firm's own sample, as a draft. */
async function nexusProposal(): Promise<string> {
  const p = await proposals.draft(
    {
      tenantId: tenant,
      partyId: nexus,
      title: "Compliance support FY 2026-27",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-09-26",
      validUntil: "2026-10-31",
      background: "Nexus Fintech is a leading company that provides quality services and solutions to its clients.",
      addressedToPartyId: priya,
      preparedByUserId: preparer,
    },
    SYSTEM_ACTOR,
  );
  await proposals.addLine({
    tenantId: tenant,
    proposalId: p.id,
    serviceVersionId: versions["tp"] ?? "",
    description: "Transfer pricing audit — Form 3CEB",
    quantity: "1",
    unitAmount: "50000",
    discountPercent: "0",
  });
  await proposals.addLine({
    tenantId: tenant,
    proposalId: p.id,
    serviceVersionId: versions["tds"] ?? "",
    description: "TDS/TCS — quarterly returns",
    quantity: "1",
    unitAmount: "25000",
    discountPercent: "0",
  });
  return p.id;
}

const texts = (flow: readonly Flow[]): string[] =>
  flow.map((f) => {
    if (f.kind === "heading") return `#${String(f.level)} ${f.text}`;
    if (f.kind === "paragraph") return f.lead === undefined ? f.text : `[${f.lead}] ${f.text}`;
    if (f.kind === "table") return f.table.rows.map((r) => r.join(" | ")).join("\n");
    return f.rows.map((r) => `${r.label}: ${r.value}`).join("\n");
  });

describe("the proposal as the firm's own document", () => {
  it("prints the firm's sample: cover, Background, in scope, the Dept sections, fees and Notes", async () => {
    const id = await nexusProposal();
    const described = await source.describe({ tenantId: tenant, kind: "proposal", subjectRef: id });
    const proposal = described?.document.proposal;
    if (proposal === undefined) throw new Error("a proposal must describe as a proposal");
    expect(described?.partyId).toBe(nexus);

    expect(proposal.cover.preparedFor).toEqual([
      { text: "Priya Sharma", bold: true },
      { text: "Nexus Fintech", bold: true },
    ]);
    expect(proposal.cover.preparedBy).toEqual([
      { text: "Siddharth Kohli", bold: true },
      { text: "10x Global Private Limited", bold: true },
      { text: `siddharth-${stamp}@example.test`, bold: false },
    ]);
    expect(proposal.running).toMatch(/^PR-\d{4}-\d{4,} {2}· {2}\d{1,2} \w+ \d{4}$/);

    expect(texts(proposal.flow)).toEqual([
      "#1 Background",
      "Nexus Fintech is a leading company that provides quality services and solutions to its clients.",
      "#1 In-scope processes / services",
      "A. Transfer pricing audit — Form 3CEB\nB. TDS/TCS — quarterly returns",
      "#1 A. Financial Reporting & Compliance",
      "#3 Our responsibilities:",
      "#2 H3. Transfer pricing audit — Form 3CEB",
      "[Fees] H3: INR 50,000 Yearly",
      "#1 B. Transactions & Regulatory Compliance",
      "#3 Our responsibilities:",
      "#2 C2. TDS/TCS — quarterly returns",
      "- Quarterly TDS/TCS returns (24Q, 26Q, 27EQ).\n- Form 16 and 16A.",
      "[Fees] C2: INR 25,000 Quarterly",
      "#1 Summary of Fees",
      "A | H3 | Transfer pricing audit — Form 3CEB | Yearly | INR 50,000\n" +
        "B | C2 | TDS/TCS — quarterly returns | Quarterly | INR 25,000",
      "This proposal is valid until 31 October 2026.",
      "#1 Notes",
      "#1 Team Deployment",
      "- Analyst: CA (Semi-Qualified) with minimum 1 year experience",
      "- Manager: Qualified CA with 5 years of post-qualification experience",
      "#1 General scope exclusions",
      "The scope of work does not include following-",
      "- Any certification unless otherwise included in the scope",
      "- Anything specifically not mentioned in the scope shall be deemed excluded",
      "#1 Commercials",
      "- All fees are exclusive of GST as applicable.",
    ]);
  });

  it("renders to the same bytes every time", async () => {
    const id = await nexusProposal();
    const described = await source.describe({ tenantId: tenant, kind: "proposal", subjectRef: id });
    if (described === null) throw new Error("no such proposal");
    const r = new PdfLibRenderer();
    const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
    const first = await r.render(described.document);
    expect(sha(await r.render(described.document))).toBe(sha(first));
  });

  it("leaves out what the proposal does not say — no Background, no validity, no names", async () => {
    const p = await proposals.draft(
      { tenantId: tenant, partyId: nexus, title: "Bare", currency: "INR", fxRate: "1", fxRateDate: "2026-09-26" },
      SYSTEM_ACTOR,
    );
    const described = await source.describe({ tenantId: tenant, kind: "proposal", subjectRef: p.id });
    const proposal = described?.document.proposal;
    if (proposal === undefined) throw new Error("a proposal must describe as a proposal");
    expect(proposal.cover.preparedFor).toEqual([{ text: "Nexus Fintech", bold: true }]);
    expect(proposal.cover.preparedBy).toEqual([{ text: "10x Global Private Limited", bold: true }]);
    const flow = texts(proposal.flow);
    expect(flow.slice(0, 2)).toEqual(["#1 Summary of Fees", "No services have been added to this proposal yet."]);
    expect(flow.some((t) => t.includes("valid until"))).toBe(false);
  });
});

describe("the columns 0084 added", () => {
  it("reads back what drafting wrote, with the names joined", async () => {
    const id = await nexusProposal();
    const view = await proposals.describe(tenant, id);
    expect(view.proposal.background).toMatch(/^Nexus Fintech is a leading company/);
    // `email` is Priya's email identifier when the firm holds one (0085) —
    // this test records none.
    expect(view.addressee).toEqual({ id: priya, displayName: "Priya Sharma", email: null });
    expect(view.preparedBy).toEqual({
      userId: preparer,
      displayName: "Siddharth Kohli",
      email: `siddharth-${stamp}@example.test`,
    });
  });

  it("revises a draft, and a sent proposal stays as the client received it", async () => {
    const id = await nexusProposal();
    const revised = await proposals.revise({
      tenantId: tenant,
      proposalId: id,
      background: null,
      addressedToPartyId: null,
      validUntil: "2026-11-30",
    });
    expect(revised).toMatchObject({ background: null, addressedToPartyId: null, validUntil: "2026-11-30" });

    await owner`UPDATE crm.proposal SET status = 'sent', sent_at = now() WHERE id = ${id}`;
    // Past the service, straight at the adapter: the WHERE clause is the wall.
    expect(await repository.revise(tenant, id, { background: "Rewritten after sending." })).toBeNull();
    const [row] = await owner<{ background: string | null }[]>`
      SELECT background FROM crm.proposal WHERE id = ${id}
    `;
    expect(row?.background).toBeNull();
  });

  it("refuses blank Background prose for every writer", async () => {
    const id = await nexusProposal();
    await expect(owner`UPDATE crm.proposal SET background = '   ' WHERE id = ${id}`).rejects.toThrow(
      /proposal_background_not_blank_chk/,
    );
  });

  it("lets a firm put a proposal cover in force, and nothing that is not a brand asset kind", async () => {
    const [checked] = await owner<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'files.brand_asset'::regclass AND conname = 'brand_asset_kind_check'
    `;
    expect(checked?.def).toMatch(/'proposal_cover'/);
    expect(checked?.def).toMatch(/'logo'.*'signature'.*'letterhead'/);
  });
});
