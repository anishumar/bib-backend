// The copy of record (2026-09-29), against a real Postgres, the real renderer
// and the real document store:
//
//   A DRAFT invoice printed is the firm's own draft copy: not shown to the
//   client, titled Draft.
//
//   ISSUE files the invoice's PDF, once: the copy of record, shown to the
//   client, drawn while the client's name is the name that was billed.
//
//   A RENAME cannot reach it. Correcting the client's name (V2.5) and asking
//   for the PDF again is refused, and the one copy on file still carries the
//   old name.
//
//   The link's ROLE is read through the tenant wall: another firm listing the
//   same subject sees nothing.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresInvoiceRepository } from "../../src/infrastructure/postgres/invoice-repository";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { PostgresFirmTimeZone } from "../../src/infrastructure/postgres/firm-timezone-repository";
import { PostgresDocumentRepository } from "../../src/infrastructure/postgres/document-repository";
import { PostgresDocumentStoreRepository } from "../../src/infrastructure/postgres/document-store-repository";
import { PostgresPartyRepository } from "../../src/infrastructure/postgres/party-repository";
import { PostgresRenderSource } from "../../src/infrastructure/postgres/render-source";
import { Sha256ByteDigest } from "../../src/infrastructure/storage/filesystem-blob-store";
import { PdfLibRenderer } from "../../src/infrastructure/render/pdf-renderer";
import { LedgerService } from "../../src/usecase/ledger/service";
import { InvoiceService } from "../../src/usecase/invoice/service";
import { PostgresInvoiceFirmSettings } from "../../src/infrastructure/postgres/invoice-settings";
import { FileStoreService } from "../../src/usecase/filestore/service";
import { invoiceIssuedCopies } from "../../src/setup/invoice-copies";
import { FakeBlobStore } from "../../src/testfakes/filestore";
import { CopyAlreadyMade } from "../../src/domain/render/errors";
import { systemIds } from "../../src/platform/ids";
import { systemClock } from "../../src/platform/clock";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import type { Logger } from "../../src/platform/log";
import { FakeStaffDirectory } from "../../src/testfakes/lead";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 4 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const warnings: unknown[] = [];
const log: Logger = {
  info: () => undefined,
  warn: (obj) => {
    warnings.push(obj);
  },
  error: () => undefined,
};

const ledger = new LedgerService({ events: new PostgresEventStore(app), ids: systemIds });
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
const invoices = new InvoiceService({
  invoices: new PostgresInvoiceRepository(app),
  timeZones: new PostgresFirmTimeZone(app),
  firmEntities: new PostgresDocumentRepository(app),
  parties: new PostgresPartyRepository(app),
  ids: systemIds,
  clock: systemClock,
  events: ledger,
  issuedCopies: invoiceIssuedCopies(files, log),
  staff: new FakeStaffDirectory(),
  settings: new PostgresInvoiceFirmSettings(app),
});

const stamp = Date.now().toString(36);
let tenant = "";
let rival = "";
let client = "";
let entity = "";

async function makeTenant(slug: string): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${slug}, ${slug}, 'INR') RETURNING id
  `;
  if (!row) throw new Error(`could not create the tenant ${slug}`);
  return row.id;
}

async function makeParty(tenantId: string, name: string): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenantId}, 'organization', ${name}) RETURNING id
  `;
  if (!row) throw new Error(`could not create the party ${name}`);
  return row.id;
}

/** What is filed on the invoice, read as the owner: no RLS, no service. */
async function filedOn(invoiceId: string) {
  return owner<{ role: string | null; title: string; is_client_visible: boolean; hash: string }[]>`
    SELECT l.role, d.title, d.is_client_visible, v.content_hash AS hash
    FROM files.document_link l
    JOIN files.document d ON d.id = l.document_id
    JOIN files.document_version v ON v.document_id = d.id
    WHERE l.subject_kind = 'invoice' AND l.subject_ref = ${invoiceId}
    ORDER BY d.created_at
  `;
}

async function draftWithALine(): Promise<string> {
  const invoice = await invoices.raise(
    {
      tenantId: tenant,
      partyId: client,
      entityPartyId: entity,
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-09-29",
    },
    SYSTEM_ACTOR,
  );
  await invoices.addLine({
    tenantId: tenant,
    invoiceId: invoice.id,
    description: "Monthly bookkeeping",
    quantity: "1",
    unitAmount: "15000",
  });
  return invoice.id;
}

beforeAll(async () => {
  tenant = await makeTenant(`copy-${stamp}`);
  rival = await makeTenant(`copy-rival-${stamp}`);
  client = await makeParty(tenant, "Meridian Textiles Private Limited");
  entity = await makeParty(tenant, "10x Global Advisory Private Limited");
  await owner`
    INSERT INTO crm.firm_entity_preference (tenant_id, client_jurisdiction, firm_entity_party_id)
    VALUES (${tenant}, '*', ${entity})
  `;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

describe("an invoice's PDF is filed once, at Issue (2026-09-29)", () => {
  it("a draft printed is the firm's own draft copy", async () => {
    const invoiceId = await draftWithALine();
    await files.render({
      tenantId: tenant,
      kind: "invoice",
      subjectKind: "invoice",
      subjectRef: invoiceId,
      actor: SYSTEM_ACTOR,
    });
    const filed = await filedOn(invoiceId);
    expect(filed).toHaveLength(1);
    expect(filed[0]?.role).toBe("draft_copy");
    expect(filed[0]?.is_client_visible).toBe(false);
    expect(filed[0]?.title).toMatch(/^Draft /);
  });

  it("Issue files the copy of record, and a rename cannot make a second", async () => {
    const invoiceId = await draftWithALine();
    await invoices.issue(tenant, invoiceId, SYSTEM_ACTOR);

    const afterIssue = await filedOn(invoiceId);
    expect(warnings).toEqual([]);
    expect(afterIssue.map((f) => f.role)).toEqual(["copy_of_record"]);
    expect(afterIssue[0]?.is_client_visible).toBe(true);
    expect(afterIssue[0]?.title).not.toMatch(/^Draft /);

    // The client's name corrected after the invoice went out.
    await owner`UPDATE core.party SET display_name = 'Meridian Textiles Limited' WHERE id = ${client}`;
    const again = files.render({
      tenantId: tenant,
      kind: "invoice",
      subjectKind: "invoice",
      subjectRef: invoiceId,
      actor: SYSTEM_ACTOR,
    });
    await expect(again).rejects.toBeInstanceOf(CopyAlreadyMade);

    const afterRename = await filedOn(invoiceId);
    expect(afterRename).toHaveLength(1);
    expect(afterRename[0]?.hash).toBe(afterIssue[0]?.hash);

    // The role comes back through the service, and only to this firm.
    const mine = await files.listForSubject(tenant, "invoice", invoiceId);
    expect(mine.map((d) => d.role)).toEqual(["copy_of_record"]);
    const theirs = await files.listForSubject(rival, "invoice", invoiceId);
    expect(theirs).toEqual([]);
  });

  it("a draft copy made before Issue does not stop the copy of record", async () => {
    await owner`UPDATE core.party SET display_name = 'Meridian Textiles Private Limited' WHERE id = ${client}`;
    const invoiceId = await draftWithALine();
    await files.render({
      tenantId: tenant,
      kind: "invoice",
      subjectKind: "invoice",
      subjectRef: invoiceId,
      actor: SYSTEM_ACTOR,
    });
    await invoices.issue(tenant, invoiceId, SYSTEM_ACTOR);
    const filed = await filedOn(invoiceId);
    expect(filed.map((f) => f.role)).toEqual(["draft_copy", "copy_of_record"]);
  });
});
