// B10 (audit 2026-10-03): a DRAFT is never shared with the client.
//
// `PATCH /documents/{id}/client-visibility` checked one thing, that the
// document belongs to a client. So the Share switch on a "Draft, firm only"
// copy put the firm's draft invoice in the client's portal library: the bug
// the copy of record (2026-09-29) had just closed, back through a switch.
//
// Against a real Postgres, the real renderer and the real document store:
//
//   A draft copy (role `draft_copy`) is refused, before and after the invoice
//   is issued: it says "Draft" on it either way.
//   A copy drawn by the product while its record was still a draft is refused
//   too, whatever its role (the copies made before 2026-09-29 are `rendered`).
//   The issued copy shares and unshares as before, and taking a draft OFF the
//   portal is never refused.
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
import { DraftNotShareable } from "../../src/domain/filestore/errors";
import { systemIds } from "../../src/platform/ids";
import { systemClock } from "../../src/platform/clock";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import type { Logger } from "../../src/platform/log";
import { FakeStaffDirectory } from "../../src/testfakes/lead";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 4 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const log: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

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
let client = "";
let entity = "";

async function makeParty(tenantId: string, name: string): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenantId}, 'organization', ${name}) RETURNING id
  `;
  if (!row) throw new Error(`could not create the party ${name}`);
  return row.id;
}

async function draftWithALine(): Promise<string> {
  const invoice = await invoices.raise(
    { tenantId: tenant, partyId: client, entityPartyId: entity, currency: "INR", fxRate: "1", fxRateDate: "2026-10-03" },
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

/** What is filed on the invoice, by role, read as the owner. */
async function filedOn(invoiceId: string) {
  return owner<{ id: string; role: string | null; is_client_visible: boolean }[]>`
    SELECT d.id, l.role, d.is_client_visible
    FROM files.document_link l JOIN files.document d ON d.id = l.document_id
    WHERE l.subject_kind = 'invoice' AND l.subject_ref = ${invoiceId}
    ORDER BY d.created_at
  `;
}

function share(documentId: string, visible: boolean) {
  return files.setClientVisible({ tenantId: tenant, documentId, visible, actor: SYSTEM_ACTOR });
}

beforeAll(async () => {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`b10-${stamp}`}, ${`b10-${stamp}`}, 'INR') RETURNING id
  `;
  tenant = row?.id ?? "";
  client = await makeParty(tenant, "Meridian Textiles Private Limited");
  entity = await makeParty(tenant, "The Firm LLP");
  await owner`
    INSERT INTO crm.firm_entity_preference (tenant_id, client_jurisdiction, firm_entity_party_id)
    VALUES (${tenant}, '*', ${entity})
  `;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

describe("a draft is never shared with the client (B10)", () => {
  it("refuses the draft copy, before the invoice is issued and after", async () => {
    const invoiceId = await draftWithALine();
    await files.render({ tenantId: tenant, kind: "invoice", subjectKind: "invoice", subjectRef: invoiceId, actor: SYSTEM_ACTOR });
    const [draft] = await filedOn(invoiceId);
    expect(draft?.role).toBe("draft_copy");

    await expect(share(draft?.id ?? "", true)).rejects.toBeInstanceOf(DraftNotShareable);

    await invoices.issue(tenant, invoiceId, SYSTEM_ACTOR);
    // Still a draft copy: the PDF says "Draft" on it, whatever the invoice is now.
    await expect(share(draft?.id ?? "", true)).rejects.toBeInstanceOf(DraftNotShareable);
    const after = await filedOn(invoiceId);
    expect(after.find((f) => f.id === draft?.id)?.is_client_visible).toBe(false);
  });

  it("refuses a copy the product drew while its record was a draft, whatever its role", async () => {
    const invoiceId = await draftWithALine();
    await files.render({ tenantId: tenant, kind: "invoice", subjectKind: "invoice", subjectRef: invoiceId, actor: SYSTEM_ACTOR });
    const [copy] = await filedOn(invoiceId);
    // As every copy made before 2026-09-29 was filed.
    await owner`UPDATE files.document_link SET role = 'rendered' WHERE document_id = ${copy?.id ?? ""}`;
    await expect(share(copy?.id ?? "", true)).rejects.toBeInstanceOf(DraftNotShareable);
  });

  it("shares and unshares the issued copy, and always lets a draft be taken off", async () => {
    const invoiceId = await draftWithALine();
    await invoices.issue(tenant, invoiceId, SYSTEM_ACTOR);
    const [issued] = await filedOn(invoiceId);
    expect(issued?.role).toBe("copy_of_record");

    const off = await share(issued?.id ?? "", false);
    expect(off.document.isClientVisible).toBe(false);
    const on = await share(issued?.id ?? "", true);
    expect(on.document.isClientVisible).toBe(true);

    // A draft copy that somehow reached the portal can always come off it.
    const draftId = await draftWithALine();
    await files.render({ tenantId: tenant, kind: "invoice", subjectKind: "invoice", subjectRef: draftId, actor: SYSTEM_ACTOR });
    const [draft] = await filedOn(draftId);
    await owner`UPDATE files.document SET is_client_visible = true WHERE id = ${draft?.id ?? ""}`;
    const pulled = await share(draft?.id ?? "", false);
    expect(pulled.document.isClientVisible).toBe(false);
  });
});
