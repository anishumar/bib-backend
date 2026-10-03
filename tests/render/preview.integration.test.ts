// The preview IS the PDF (2026-09-28) — against a real Postgres, the real
// renderer and the real document store.
//
//   SAME BYTES. An unedited draft proposal, previewed, hashes EQUAL to the PDF
//   of record Send files the same day; an unedited draft letter, previewed,
//   hashes equal to the PDF Send renders for the envelope. The preview fills in
//   exactly what Send stamps (the date, the firm's signature block) and nothing
//   else, and the renderer is deterministic, so the two are one document.
//
//   FILES NOTHING. A preview adds no document, no version, no link and no event.
//
//   LAKHS. A proposal in rupees prints "₹12,50,000" (one formatter, audit 2026-10-03).
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { PostgresLeadRepository } from "../../src/infrastructure/postgres/lead-repository";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresProposalRepository } from "../../src/infrastructure/postgres/proposal-repository";
import { PostgresEngagementRepository } from "../../src/infrastructure/postgres/engagement-repository";
import { PostgresSignatureRequestRepository } from "../../src/infrastructure/postgres/signature-request-repository";
import { PostgresRenderSource } from "../../src/infrastructure/postgres/render-source";
import { PostgresConfigRepository } from "../../src/infrastructure/postgres/config-repository";
import { PostgresDocumentRepository } from "../../src/infrastructure/postgres/document-repository";
import { PostgresDocumentStoreRepository } from "../../src/infrastructure/postgres/document-store-repository";
import { PostgresServiceAxisRepository } from "../../src/infrastructure/postgres/service-axis-repository";
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
import { RandomTokenFactory, Sha256ContentHasher } from "../../src/infrastructure/crypto/random-tokens";
import { Sha256ByteDigest } from "../../src/infrastructure/storage/filesystem-blob-store";
import { AttestedSigner } from "../../src/infrastructure/esign/attested-signer";
import { PdfLibRenderer } from "../../src/infrastructure/render/pdf-renderer";
import { LedgerService } from "../../src/usecase/ledger/service";
import { ConfigService } from "../../src/usecase/config/service";
import { PartyService } from "../../src/usecase/party/service";
import { ProposalService } from "../../src/usecase/proposal/service";
import { EngagementService } from "../../src/usecase/engagement/service";
import { DocumentService } from "../../src/usecase/document/service";
import { FileStoreService } from "../../src/usecase/filestore/service";
import { FakeBlobStore } from "../../src/testfakes/filestore";
import { FAKE_PROPOSAL_LINKS } from "../../src/testfakes/proposal";
import { FakeAcceptedQuotes } from "../../src/testfakes/engagement";
import { proposalPdfs } from "../../src/setup/proposal-delivery";
import { dayInZone } from "../../src/domain/scheduler/zone";
import type { Flow } from "../../src/domain/render/model";
import { systemIds } from "../../src/platform/ids";
import { systemClock } from "../../src/platform/clock";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 4 });
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
const blobs = new FakeBlobStore();
const source = new PostgresRenderSource(app, (i) => blobs.get(i));
const renderer = new PdfLibRenderer();
const timeZones = new PostgresFirmTimeZone(app);
const files = new FileStoreService({
  documents: new PostgresDocumentStoreRepository(app),
  blobs,
  digest: new Sha256ByteDigest(),
  ids: systemIds,
  events: ledger,
  maxUploadBytes: 10 * 1024 * 1024,
  renderer,
  renderSource: source,
  timeZones,
  clock: systemClock,
});
const proposals = new ProposalService({
  proposals: new PostgresProposalRepository(app),
  catalogue: configRepository,
  policies: configRepository,
  parties: new PostgresPartyRepository(app),
  leads: new PostgresLeadRepository(app),
  documents,
  shareTokens: new RandomTokenFactory(),
  structure: new PostgresRelationshipRepository(app),
  timeZones,
  staff: new PostgresMembershipRepository(app),
  mailer: null,
  pdfs: proposalPdfs(files),
  links: FAKE_PROPOSAL_LINKS,
  ids: systemIds,
  clock: systemClock,
  events: ledger,
});

/** The firm's standing signatory: on the tenant row (which the preview reads)
 *  AND through the port (which Send reads) — the same person either way. */
let signatoryUserId = "";
const letters = new EngagementService({
  letters: new PostgresEngagementRepository(app),
  library: configRepository,
  documents,
  firm: {
    firmSignatory: () =>
      Promise.resolve(signatoryUserId === "" ? null : { userId: signatoryUserId, title: "Director" }),
  },
  firmSignatureImage: { activeSignatureVersion: () => Promise.resolve(null) },
  parties: new PostgresPartyRepository(app),
  quotes: new FakeAcceptedQuotes(),
  structure: new PostgresRelationshipRepository(app),
  timeZones,
  esign: new AttestedSigner(),
  migrationSigner: new AttestedSigner(),
  hasher: new Sha256ContentHasher(),
  signatures: new PostgresSignatureRequestRepository(app),
  dispatch: null,
  letterPdf: null,
  signedCopies: null,
  tenants: { activeTenantIds: () => Promise.resolve([]) },
  ids: systemIds,
  clock: systemClock,
  events: ledger,
});

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const stamp = Date.now().toString(36);
let tenant = "";
let nexus = "";
let priya = "";
let preparer = "";
let gst = "";
let audit = "";
let clause = "";

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`preview-${stamp}`}, 'Preview Test', 'INR') RETURNING id
  `;
  if (!t) throw new Error("could not create the test tenant");
  tenant = t.id;
  await documentRepository.seedFirmEntity(tenant, "10x Global Private Limited");

  const [user] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`sahil-${stamp}@example.test`}, 'Sahil Kohli') RETURNING id
  `;
  if (!user) throw new Error("could not create the preparer");
  preparer = user.id;
  signatoryUserId = user.id;
  await owner`
    INSERT INTO tenancy.membership (tenant_id, user_id, audience, role, commercial_visibility)
    VALUES (${tenant}, ${preparer}, 'STAFF', 'partner', true)
  `;
  await owner`
    UPDATE tenancy.tenant
       SET firm_signatory_user_id = ${preparer}, firm_signatory_title = 'Director'
     WHERE id = ${tenant}
  `;

  nexus = (await party.createOrganization({ tenantId: tenant, legalName: "Nexus Fintech" }, SYSTEM_ACTOR)).partyId;
  priya = (await party.createPerson({ tenantId: tenant, fullName: "Priya Sharma" }, SYSTEM_ACTOR)).partyId;
  await party.addRelationship(
    { tenantId: tenant, fromPartyId: priya, toPartyId: nexus, type: "director_of", validFrom: "2024-01-01" },
    SYSTEM_ACTOR,
  );

  const publish = async (key: string, body: Record<string, unknown>): Promise<string> => {
    const defined = await config.define({ tenantId: tenant, kind: "service", key, body }, SYSTEM_ACTOR);
    await config.publish({ tenantId: tenant, kind: "service", key, version: 1 }, SYSTEM_ACTOR);
    return defined.draft.id;
  };
  gst = await publish("gst-returns", {
    name: "GST returns",
    billingBasis: "fixed",
    recurrence: "monthly",
    scope: "- Monthly GSTR-1 and GSTR-3B.",
  });
  audit = await publish("tax-audit", { name: "Tax audit", billingBasis: "fixed", recurrence: "annually" });

  const defined = await config.define(
    {
      tenantId: tenant,
      kind: "clause",
      key: "fees",
      body: { title: "Fees", text: "Fees are as set out in Annexure 1.", jurisdictions: [] },
    },
    SYSTEM_ACTOR,
  );
  await config.publish({ tenantId: tenant, kind: "clause", key: "fees", version: 1 }, SYSTEM_ACTOR);
  clause = defined.draft.id;

  let order = 0;
  for (const [kind, body] of [
    ["cover", "This letter confirms the services you have engaged us for."],
    ["acceptance", "The terms of this engagement are accepted."],
    ["commercial", "All fees are exclusive of GST."],
    ["exclusion", "Statutory fees and penalties."],
  ] as const) {
    order += 1;
    await documents.addStandardBlock({ tenantId: tenant, kind, body, sortOrder: order }, SYSTEM_ACTOR);
  }
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

async function filedCount(): Promise<{ documents: number; events: number }> {
  const [row] = await owner<{ documents: string; events: string }[]>`
    SELECT (SELECT count(*) FROM files.document WHERE tenant_id = ${tenant}) AS documents,
           (SELECT count(*) FROM ledger.event WHERE tenant_id = ${tenant}) AS events
  `;
  return { documents: Number(row?.documents ?? 0), events: Number(row?.events ?? 0) };
}

async function draftProposal(): Promise<string> {
  const p = await proposals.draft(
    {
      tenantId: tenant,
      partyId: nexus,
      title: "Compliance support FY 2026-27",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-09-28",
      addressedToPartyId: priya,
      preparedByUserId: preparer,
    },
    SYSTEM_ACTOR,
  );
  await proposals.addLine({
    tenantId: tenant,
    proposalId: p.id,
    serviceVersionId: gst,
    description: "GST returns",
    quantity: "1",
    unitAmount: "25000",
    discountPercent: "0",
  });
  await proposals.addLine({
    tenantId: tenant,
    proposalId: p.id,
    serviceVersionId: audit,
    description: "Tax audit",
    quantity: "1",
    unitAmount: "1250000",
    discountPercent: "0",
  });
  return p.id;
}

describe("the preview of a proposal", () => {
  it("files nothing, and is the very PDF Send files the same day", async () => {
    const id = await draftProposal();
    const before = await filedCount();

    const preview = await files.preview({ tenantId: tenant, kind: "proposal", subjectRef: id });
    expect(new TextDecoder().decode(preview.bytes.slice(0, 5))).toBe("%PDF-");
    expect(preview.contentHash).toBe(sha(preview.bytes));
    // Dated the day Send will date it: the firm's.
    const firmDay = dayInZone(systemClock.now().toISOString(), await timeZones.timeZoneFor(tenant));
    expect(preview.datedAsIfSent).toBe(firmDay);
    expect(await filedCount()).toEqual(before);

    // A second preview of the unchanged draft: the same bytes.
    const again = await files.preview({ tenantId: tenant, kind: "proposal", subjectRef: id });
    expect(again.contentHash).toBe(preview.contentHash);

    // SEND, with no email: the PDF of record is filed at once.
    await proposals.send(tenant, id, SYSTEM_ACTOR);
    const record = await proposals.describe(tenant, id);
    expect(record.sentPdf).not.toBeNull();
    expect(record.sentPdf?.contentHash).toBe(preview.contentHash);
  });

  it("reports where each editable piece was drawn", async () => {
    const id = await draftProposal();
    const record = await proposals.describe(tenant, id);
    const preview = await files.preview({ tenantId: tenant, kind: "proposal", subjectRef: id });
    const keys = new Set(preview.anchors.map((a) => a.key));
    for (const line of record.lines) {
      expect(keys.has(`line:${line.line.id}.name`)).toBe(true);
      expect(keys.has(`fee:line:${line.line.id}`)).toBe(true);
    }
    expect(keys.has("proposal.preparedFor")).toBe(true);
    for (const block of record.blocks) expect(keys.has(`block:${block.id}`)).toBe(true);
    expect(preview.missingBrand).toEqual(["logo", "proposal_cover"]);
    expect(preview.issuingEntity?.name).toBe("10x Global Private Limited");
  });

  it("names a person who is the client, addressed to herself, once on the cover", async () => {
    // Found on the screen (2026-09-28): the cover read "Asha Verma / Asha Verma".
    const p = await proposals.draft(
      {
        tenantId: tenant,
        partyId: priya,
        title: "Proposal for Priya",
        currency: "INR",
        fxRate: "1",
        fxRateDate: "2026-09-28",
        addressedToPartyId: priya,
        preparedByUserId: preparer,
      },
      SYSTEM_ACTOR,
    );
    const described = await source.describe({ tenantId: tenant, kind: "proposal", subjectRef: p.id });
    expect(described?.document.proposal?.cover.preparedFor.map((l) => l.text)).toEqual(["Priya Sharma"]);
    // A person at a company is still named above the company.
    const id = await draftProposal();
    const other = await source.describe({ tenantId: tenant, kind: "proposal", subjectRef: id });
    expect(other?.document.proposal?.cover.preparedFor.map((l) => l.text)).toEqual(["Priya Sharma", "Nexus Fintech"]);
  });

  it("prints rupees in lakhs", async () => {
    const id = await draftProposal();
    const described = await source.describe({ tenantId: tenant, kind: "proposal", subjectRef: id });
    const flow: readonly Flow[] = described?.document.proposal?.flow ?? [];
    const text = flow
      .map((p) => (p.kind === "paragraph" ? `${p.lead === undefined ? "" : `[${p.lead}] `}${p.text}` : ""))
      .join("\n");
    expect(text).toContain("₹12,50,000");
    expect(text).not.toContain("1,250,000");
  });
});

describe("the preview of a letter", () => {
  it("files nothing, and is the very PDF Send renders for the envelope", async () => {
    const letter = await letters.draft(
      {
        tenantId: tenant,
        partyId: nexus,
        jurisdiction: "IN",
        title: "Engagement letter for Nexus Fintech",
        currency: "INR",
        fxRate: "1",
        fxRateDate: "2026-09-28",
        advanceRequired: false,

        background: "Nexus Fintech provides payment services.",
        addressedToPartyId: priya,
      },
      SYSTEM_ACTOR,
    );
    const group = await letters.addFeeGroup(tenant, letter.id, {
      title: "Ongoing recurring services",
      billingFrequency: "monthly",
      amount: "45000",
      intro: "One monthly fee covers the work below.",
    });
    await letters.addLine({
      tenantId: tenant,
      letterId: letter.id,
      entityPartyId: nexus,
      serviceVersionId: gst,
      description: "GST returns",
      quantity: "1",
      discountPercent: "0",
      feeGroupId: group.id,
    });
    await letters.addClause(tenant, letter.id, clause);

    const tz = await timeZones.timeZoneFor(tenant);
    const today = dayInZone(systemClock.now().toISOString(), tz);
    const before = await filedCount();
    const preview = await files.preview({
      tenantId: tenant,
      kind: "engagement_letter",
      subjectRef: letter.id,
      asOf: today,
    });
    expect(preview.datedAsIfSent).toBe(today);
    expect(await filedCount()).toEqual(before);
    const keys = new Set(preview.anchors.map((a) => a.key));
    for (const key of ["letter.issuedOn", "letter.subject", `section:${group.id}.intro`, `fee:group:${group.id}`]) {
      expect(keys.has(key)).toBe(true);
    }

    // What an unsent draft rendered for FILING looks like: no date of its own
    // and no firm block — a different document, which is why the preview
    // fills them in.
    const asItStands = await source.describe({ tenantId: tenant, kind: "engagement_letter", subjectRef: letter.id });
    expect(sha(await renderer.render(asItStands?.document ?? (undefined as never)))).not.toBe(preview.contentHash);

    await letters.send(tenant, letter.id, SYSTEM_ACTOR, { asOf: today });
    // The envelope's PDF: `letterPdf.render` in setup/server.ts, exactly.
    const sent = await source.describe({ tenantId: tenant, kind: "engagement_letter", subjectRef: letter.id });
    const envelope = await renderer.render(sent?.document ?? (undefined as never));
    expect(sha(envelope)).toBe(preview.contentHash);

    // And a sent letter previews as its frozen self.
    const frozen = await files.preview({
      tenantId: tenant,
      kind: "engagement_letter",
      subjectRef: letter.id,
      asOf: today,
    });
    expect(frozen.contentHash).toBe(preview.contentHash);
    expect(frozen.datedAsIfSent).toBeNull();
  });
});
