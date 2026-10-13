// 0085's database half — the proposal by email and the client's own answer,
// against a real Postgres, a real renderer and the real document store.
//
//   THE FLOW. Send with an email files the PDF of record, pins it, and keeps
//   the email with its link's digest; the client's answer on that link lands
//   with its evidence, naming the email and the PDF.
//
//   ONE ANSWER. Two answers racing — accept in one tab, decline in another —
//   land exactly one: the repository moves the status only while it is still
//   `sent`, in the statement that writes the evidence.
//
//   THE WALLS. A PDF pinned on a draft, an acceptance with no statement, a
//   decline with one, and a second evidence row are the schema's to refuse,
//   for every writer.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { PostgresLeadRepository } from "../../src/infrastructure/postgres/lead-repository";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresProposalRepository } from "../../src/infrastructure/postgres/proposal-repository";
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
import { RandomTokenFactory } from "../../src/infrastructure/crypto/random-tokens";
import { Sha256ByteDigest } from "../../src/infrastructure/storage/filesystem-blob-store";
import { PdfLibRenderer } from "../../src/infrastructure/render/pdf-renderer";
import { LedgerService } from "../../src/usecase/ledger/service";
import { ConfigService } from "../../src/usecase/config/service";
import { PartyService } from "../../src/usecase/party/service";
import { ProposalService } from "../../src/usecase/proposal/service";
import { DocumentService } from "../../src/usecase/document/service";
import { FileStoreService } from "../../src/usecase/filestore/service";
import { FakeBlobStore } from "../../src/testfakes/filestore";
import { FAKE_PROPOSAL_LINKS, FakeProposalMailer } from "../../src/testfakes/proposal";
import { proposalPdfs } from "../../src/setup/proposal-delivery";
import { AlreadyAnswered } from "../../src/domain/proposal/errors";
import { withTenant } from "../../src/db/tenant";
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
  calendars: new PostgresFirmTimeZone(app),
  fiscalYears: new PostgresConfigRepository(app),
});
const blobs = new FakeBlobStore();
const files = new FileStoreService({
  documents: new PostgresDocumentStoreRepository(app),
  blobs,
  digest: new Sha256ByteDigest(),
  ids: systemIds,
  events: ledger,
  maxUploadBytes: 10 * 1024 * 1024,
  renderer: new PdfLibRenderer(),
  renderSource: new PostgresRenderSource(app, (i) => blobs.get(i)),
  timeZones: new PostgresFirmTimeZone(app),
  clock: systemClock,
});
const mailer = new FakeProposalMailer();
const tokens = new RandomTokenFactory();
const repository = new PostgresProposalRepository(app);
const proposals = new ProposalService({
  proposals: repository,
  catalogue: configRepository,
  policies: configRepository,
  parties: new PostgresPartyRepository(app),
  leads: new PostgresLeadRepository(app),
  documents,
  shareTokens: tokens,
  structure: new PostgresRelationshipRepository(app),
  timeZones: new PostgresFirmTimeZone(app),
  staff: new PostgresMembershipRepository(app),
  mailer,
  pdfs: proposalPdfs(files),
  links: FAKE_PROPOSAL_LINKS,
  ids: systemIds,
  clock: systemClock,
  events: ledger,
});

const stamp = Date.now().toString(36);
let tenant = "";
let nexus = "";
let priya = "";
let preparer = "";
let gst = "";

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`proposal-email-${stamp}`}, 'Proposal Email Test', 'INR') RETURNING id
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
  await owner`
    INSERT INTO tenancy.membership (tenant_id, user_id, audience, role, commercial_visibility)
    VALUES (${tenant}, ${preparer}, 'STAFF', 'partner', true)
  `;

  nexus = (await party.createClientCompany({ tenantId: tenant, legalName: "Nexus Fintech", jurisdiction: "IN", entityType: "private_limited" }, SYSTEM_ACTOR)).partyId;
  priya = (await party.createPerson({ tenantId: tenant, fullName: "Priya Sharma" }, SYSTEM_ACTOR)).partyId;
  await party.addRelationship(
    { tenantId: tenant, fromPartyId: priya, toPartyId: nexus, type: "director_of", validFrom: "2024-01-01" },
    SYSTEM_ACTOR,
  );
  await party.addIdentifier(
    { tenantId: tenant, partyId: priya, type: "email", value: `priya-${stamp}@nexus.example`, validFrom: "2024-01-01" },
    SYSTEM_ACTOR,
  );

  const defined = await config.define(
    {
      tenantId: tenant,
      kind: "service",
      key: "gst-returns",
      body: { name: "GST returns", billingBasis: "fixed", recurrence: "monthly" },
    },
    SYSTEM_ACTOR,
  );
  await config.publish({ tenantId: tenant, kind: "service", key: "gst-returns", version: 1 }, SYSTEM_ACTOR);
  gst = defined.draft.id;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

async function draft(): Promise<string> {
  const p = await proposals.draft(
    {
      tenantId: tenant,
      partyId: nexus,
      title: "Compliance support FY 2026-27",
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-09-26",
      addressedToPartyId: priya,
      preparedByUserId: preparer,
    },
    SYSTEM_ACTOR,
  );
  await proposals.addLine({
    tenantId: tenant,
    proposalId: p.id,
    serviceVersionId: gst,
    description: "GST returns — monthly",
    quantity: "12",
    unitAmount: "5000",
    discountPercent: "0",
  });
  return p.id;
}

const accept = (token: string) => ({
  token,
  decision: "accepted",
  signerName: "Priya Sharma",
  confirmed: true,
  ipAddress: "203.0.113.9",
  userAgent: "Mozilla/5.0 (integration)",
});

describe("the proposal by email, end to end", () => {
  it("emails the PDF of record, and the client's answer lands with its evidence", async () => {
    const id = await draft();
    const before = await proposals.describe(tenant, id);
    // Send offers the address the firm already holds for the person.
    expect(before.addressee?.email).toBe(`priya-${stamp}@nexus.example`);

    const sent = await proposals.send(tenant, id, SYSTEM_ACTOR, {
      to: `priya-${stamp}@nexus.example`,
    });
    expect(sent.email?.status).toBe("sent");

    // THE PDF: a real one, pinned, and the very bytes the email attached.
    const letter = mailer.letters.at(-1);
    const bytes = letter?.pdf.bytes ?? new Uint8Array();
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const record = await proposals.describe(tenant, id);
    expect(record.sentPdf?.contentHash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(record.proposal.sentPdfVersionId).toBe(record.sentPdf?.versionId);
    expect(record.emails.map((e) => e.to)).toEqual([`priya-${stamp}@nexus.example`]);
    expect(record.emails[0]?.pdfContentHash).toBe(record.sentPdf?.contentHash);

    // THE LINK the email carried is the one on the proposal — by digest only.
    const [emailRow] = await owner<{ link_digest: string }[]>`
      SELECT link_digest FROM crm.proposal_email WHERE proposal_id = ${id}
    `;
    expect(emailRow?.link_digest).toBe(tokens.hash(sent.shareToken));

    // THE ANSWER, through that link.
    const shared = await proposals.answerShared(accept(sent.shareToken), SYSTEM_ACTOR);
    expect(shared.status).toBe("accepted");
    expect(shared.answer?.signerName).toBe("Priya Sharma");

    const after = await proposals.describe(tenant, id);
    expect(after.clientDecision).toMatchObject({
      decision: "accepted",
      signerName: "Priya Sharma",
      statement: `I accept proposal ${after.proposal.ref} on behalf of Nexus Fintech.`,
      emailedTo: `priya-${stamp}@nexus.example`,
      ipAddress: "203.0.113.9",
      userAgent: "Mozilla/5.0 (integration)",
    });
    expect(after.clientDecision?.pdf?.contentHash).toBe(record.sentPdf?.contentHash);
    // The colleague who prepared it was told.
    expect(mailer.notices.at(-1)).toMatchObject({ to: `sahil-${stamp}@example.test`, decision: "accepted" });
  });

  it("serves the pinned PDF from the link, byte for byte", async () => {
    const id = await draft();
    const sent = await proposals.send(tenant, id, SYSTEM_ACTOR);
    // Send filed and pinned it (2026-09-28); the link serves THAT file.
    const atSend = (await proposals.describe(tenant, id)).sentPdf;
    expect(atSend).not.toBeNull();
    const first = await proposals.sharedPdf(sent.shareToken, SYSTEM_ACTOR);
    const second = await proposals.sharedPdf(sent.shareToken, SYSTEM_ACTOR);
    expect(second.bytes).toEqual(first.bytes);
    const pinned = (await proposals.describe(tenant, id)).sentPdf;
    expect(pinned?.versionId).toBe(atSend?.versionId);
    expect(pinned?.contentHash).toBe(createHash("sha256").update(first.bytes).digest("hex"));
  });

  it("gives a new link, and the old one stops opening anything", async () => {
    const id = await draft();
    const sent = await proposals.send(tenant, id, SYSTEM_ACTOR);
    const again = await proposals.reissue(tenant, id, SYSTEM_ACTOR);
    await expect(proposals.viewShared(sent.shareToken, SYSTEM_ACTOR)).rejects.toThrow(
      /not one we recognise/,
    );
    expect((await proposals.viewShared(again.shareToken, SYSTEM_ACTOR)).id).toBe(id);
  });
});

describe("one answer", () => {
  it("lands exactly one of two answers given at once", async () => {
    const id = await draft();
    const sent = await proposals.send(tenant, id, SYSTEM_ACTOR);
    const results = await Promise.allSettled([
      proposals.answerShared(accept(sent.shareToken), SYSTEM_ACTOR),
      proposals.answerShared(
        { ...accept(sent.shareToken), decision: "rejected", confirmed: false },
        SYSTEM_ACTOR,
      ),
    ]);
    const landed = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    expect(landed).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(AlreadyAnswered);

    const rows = await owner<{ decision: string }[]>`
      SELECT decision FROM crm.proposal_client_decision WHERE proposal_id = ${id}
    `;
    expect(rows).toHaveLength(1);
    const [status] = await owner<{ status: string }[]>`
      SELECT status FROM crm.proposal WHERE id = ${id}
    `;
    expect(status?.status).toBe(rows[0]?.decision);
  });
});

describe("the walls", () => {
  const refusal = async (fn: () => Promise<unknown>): Promise<string | undefined> =>
    fn().then(
      () => undefined,
      (e: unknown) => (e as { code?: string }).code,
    );

  it("refuses a PDF pinned on a draft", async () => {
    const id = await draft();
    const sent = await draft();
    const s = await proposals.send(tenant, sent, SYSTEM_ACTOR);
    await proposals.sharedPdf(s.shareToken, SYSTEM_ACTOR);
    const pinned = (await proposals.describe(tenant, sent)).sentPdf?.versionId ?? "";
    expect(
      await refusal(() =>
        withTenant(app, tenant, (db) =>
          db`UPDATE crm.proposal SET sent_pdf_version_id = ${pinned} WHERE id = ${id}`,
        ),
      ),
    ).toBe("23514"); // check_violation
  });

  it("refuses an acceptance with no statement, a decline with one, and a second answer", async () => {
    const id = await draft();
    await proposals.send(tenant, id, SYSTEM_ACTOR);
    const insert = (decision: string, statement: string | null) =>
      withTenant(app, tenant, (db) => db`
        INSERT INTO crm.proposal_client_decision
          (tenant_id, proposal_id, decision, signer_name, statement, decided_at)
        VALUES (${tenant}, ${id}, ${decision}, 'Priya Sharma', ${statement}, now())
      `);
    expect(await refusal(() => insert("accepted", null))).toBe("23514");
    expect(await refusal(() => insert("rejected", "I accept."))).toBe("23514");
    await insert("rejected", null);
    expect(await refusal(() => insert("rejected", null))).toBe("23505"); // unique_violation
  });
});

describe("a proposal the client accepted outside the link, in the database (0317)", () => {
  it("accepts it and keeps the evidence, in one transaction, and refuses a second yes", async () => {
    const id = await draft();
    await proposals.send(tenant, id, SYSTEM_ACTOR);
    const today = (await proposals.describe(tenant, id)).proposal.sentAt?.slice(0, 10) ?? "";

    const accepted = await proposals.recordAcceptance(
      tenant,
      id,
      { channel: "call", acceptedOn: today, acceptedByName: "Priya Sharma", note: "Called to say go ahead." },
      preparer,
      { type: "human", id: preparer },
    );

    expect(accepted.status).toBe("accepted");
    const record = await proposals.describe(tenant, id);
    expect(record.recordedAcceptance).toMatchObject({
      channel: "call",
      acceptedOn: today,
      acceptedByName: "Priya Sharma",
      evidenceDocumentId: null,
      recordedBy: { userId: preparer, displayName: "Sahil Kohli" },
    });
    // The client's own answer on the link can no longer land: the status moved.
    expect(await repository.recordAcceptance(id, new Date().toISOString(), {
      id: crypto.randomUUID(),
      tenantId: tenant,
      channel: "email",
      acceptedOn: today,
      acceptedByName: "Priya Sharma",
      acceptedByTitle: null,
      note: "second",
      evidenceDocumentId: null,
      recordedByUserId: preparer,
    })).toBeNull();
    const rows = await withTenant(app, tenant, (db) => db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM crm.recorded_acceptance WHERE proposal_id = ${id}
    `);
    expect(rows[0]?.n).toBe(1);
  });
});
