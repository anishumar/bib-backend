// Who an invoice is from and to (audit 2026-10-03: B12 / CA#1, CA#22), and the
// one money formatter (B19), against a real Postgres (0334) and the real
// render source.
//
//   A DRAFT prints both parties as they stand today: the firm's company with
//   its registered address, state, GSTIN, PAN and how to reach it; the client
//   with its billing address, state and GSTIN. Money is written as the screens
//   write it, two places on a tax invoice, and the total in words.
//
//   ISSUE FREEZES THEM. A client's address and GSTIN corrected the next day do
//   not reach the issued invoice, and nothing can rewrite what it froze.
//
//   AN INVOICE ISSUED BEFORE 0334 has nothing frozen and prints exactly as it
//   always did: no address block, "INR 5,000.00", no words.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresRenderSource } from "../../src/infrastructure/postgres/render-source";
import { PostgresInvoiceRepository } from "../../src/infrastructure/postgres/invoice-repository";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { PostgresFirmTimeZone } from "../../src/infrastructure/postgres/firm-timezone-repository";
import { PostgresDocumentRepository } from "../../src/infrastructure/postgres/document-repository";
import { PostgresPartyRepository } from "../../src/infrastructure/postgres/party-repository";
import { PostgresInvoiceFirmSettings } from "../../src/infrastructure/postgres/invoice-settings";
import { LedgerService } from "../../src/usecase/ledger/service";
import { InvoiceService } from "../../src/usecase/invoice/service";
import { FakeBlobStore } from "../../src/testfakes/filestore";
import { FakeStaffDirectory } from "../../src/testfakes/lead";
import { systemIds } from "../../src/platform/ids";
import { systemClock } from "../../src/platform/clock";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });
const blobs = new FakeBlobStore();
const source = new PostgresRenderSource(app, (i) => blobs.get(i));
const ledger = new LedgerService({ events: new PostgresEventStore(app), ids: systemIds });
const invoices = new InvoiceService({
  invoices: new PostgresInvoiceRepository(app),
  timeZones: new PostgresFirmTimeZone(app),
  firmEntities: new PostgresDocumentRepository(app),
  parties: new PostgresPartyRepository(app),
  ids: systemIds,
  clock: systemClock,
  events: ledger,
  issuedCopies: { file: () => Promise.resolve() },
  staff: new FakeStaffDirectory(),
  settings: new PostgresInvoiceFirmSettings(app),
});

const stamp = Date.now().toString(36);
let tenant = "";
let firm = "";
let client = "";

async function identifier(party: string, type: string, value: string): Promise<void> {
  await owner`
    INSERT INTO core.party_identifier (tenant_id, party_id, type, value, valid_from)
    VALUES (${tenant}, ${party}, ${type}, ${value}, '2020-04-01')
  `;
}

async function draft(): Promise<string> {
  const invoice = await invoices.raise(
    { tenantId: tenant, partyId: client, entityPartyId: firm, currency: "INR", fxRate: "1", fxRateDate: "2026-10-03" },
    SYSTEM_ACTOR,
  );
  await invoices.addLine({
    tenantId: tenant,
    invoiceId: invoice.id,
    description: "GST returns for September 2026",
    quantity: "1",
    unitAmount: "5000",
    taxPercent: "18",
    sac: "998231",
  });
  return invoice.id;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, time_zone)
    VALUES (${`ident-${stamp}`}, ${`ident-${stamp}`}, 'INR', 'Asia/Kolkata') RETURNING id
  `;
  tenant = t?.id ?? "";
  const org = async (name: string): Promise<string> => {
    const [p] = await owner<{ id: string }[]>`
      INSERT INTO core.party (tenant_id, kind, display_name) VALUES (${tenant}, 'organization', ${name}) RETURNING id
    `;
    await owner`INSERT INTO core.organization (party_id, tenant_id, legal_name) VALUES (${p?.id ?? ""}, ${tenant}, ${name})`;
    return p?.id ?? "";
  };
  firm = await org("Sharma Mehta & Co");
  client = await org("Deccan Agro Foods Private Limited");
  await owner`
    INSERT INTO core.legal_entity (party_id, tenant_id, jurisdiction, entity_type, registered_address)
    VALUES (${firm}, ${tenant}, 'IN', 'Partnership firm',
            ${owner.json({ lines: ["4th Floor, Pinnacle House", "12 MG Road, Camp, Pune"], region: "Maharashtra", postalCode: "411001" })})
  `;
  await owner`
    INSERT INTO crm.firm_entity_preference (tenant_id, client_jurisdiction, firm_entity_party_id)
    VALUES (${tenant}, '*', ${firm})
  `;
  await identifier(firm, "gstin", "27ABCDE1234F1Z5");
  await identifier(firm, "pan", "ABCDE1234F");
  await identifier(firm, "phone", "+912026123456");
  await identifier(firm, "email", "office@sharmamehta.in");
  await owner`
    UPDATE core.party SET billing_address = ${owner.json({ lines: ["Plot 4, MIDC Bhosari"], region: "Maharashtra", postalCode: "411026", country: "IN" })}
     WHERE id = ${client}
  `;
  await identifier(client, "gstin", "27AAACD1234E1Z2");
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

describe("who an invoice is from and to (B12 / CA#1)", () => {
  it("a draft prints both parties as they stand, money as the screens write it, and the total in words", async () => {
    const id = await draft();
    const d = (await source.describe({ tenantId: tenant, kind: "invoice", subjectRef: id }))?.document;
    expect(d?.issuer.name).toBe("Sharma Mehta & Co");
    // A GST tax invoice is the recipient's original (Rule 48, S7).
    expect(d?.copyMark).toBe("Original for recipient");
    expect(d?.issuer.lines).toEqual([
      "4th Floor, Pinnacle House",
      "12 MG Road, Camp, Pune",
      "Maharashtra 411001, India",
      "GSTIN 27ABCDE1234F1Z5",
      "PAN ABCDE1234F",
      "+912026123456",
      "office@sharmamehta.in",
      // Q056: both parties are registered in Maharashtra, so this is a GST
      // tax invoice (CGST + SGST), which names each party's state and code.
      "State: Maharashtra (27)",
    ]);
    expect(d?.recipient.lines).toEqual([
      "Plot 4, MIDC Bhosari",
      "Maharashtra 411026, India",
      "GSTIN 27AAACD1234E1Z2",
      "State: Maharashtra (27)",
    ]);
    expect(d?.table?.rows[0]).toEqual(["GST returns for September 2026", "998231", "1", "₹5,000.00", "18", "₹5,000.00"]);
    expect(d?.totals.map((t) => `${t.label} ${t.value}`)).toEqual([
      "Sub-total ₹5,000.00",
      "CGST @9% ₹450.00",
      "SGST @9% ₹450.00",
      "Total ₹5,900.00",
    ]);
    expect(d?.amountInWords).toBe("Indian Rupees Five Thousand Nine Hundred Only");
  });

  it("issue freezes them: a correction the next day does not reach the issued invoice", async () => {
    const id = await draft();
    await invoices.issue(tenant, id, SYSTEM_ACTOR);
    const [frozen] = await owner<{ printed_parties: unknown }[]>`SELECT printed_parties FROM crm.invoice WHERE id = ${id}`;
    expect(frozen?.printed_parties).not.toBeNull();

    await owner`
      UPDATE core.party SET billing_address = ${owner.json({ lines: ["New office, Hinjewadi"], region: "Maharashtra", country: "IN" })},
                            display_name = 'Deccan Agro Foods Limited'
       WHERE id = ${client}
    `;
    await owner`UPDATE core.party_identifier SET voided_at = now() WHERE party_id = ${client} AND type = 'gstin'`;

    const d = (await source.describe({ tenantId: tenant, kind: "invoice", subjectRef: id }))?.document;
    expect(d?.recipient.name).toBe("Deccan Agro Foods Private Limited");
    expect(d?.recipient.lines).toContain("Plot 4, MIDC Bhosari");
    expect(d?.recipient.lines).toContain("GSTIN 27AAACD1234E1Z2");

    // And nothing rewrites what Issue froze, whoever asks.
    await expect(
      owner`UPDATE crm.invoice SET printed_parties = '{}'::jsonb WHERE id = ${id}`,
    ).rejects.toThrow(/as they stood when it went out/);
  });

  it("an invoice issued before 0334 prints exactly as it always did", async () => {
    const id = await draft();
    await owner`
      INSERT INTO crm.invoice_series (tenant_id, entity_party_id, financial_year, document_type, prefix)
      VALUES (${tenant}, ${firm}, 2026, 'invoice', 'INV') ON CONFLICT DO NOTHING
    `;
    // As Issue wrote an invoice before 0334: number, date, status, and no
    // frozen parties.
    await owner`
      UPDATE crm.invoice SET status = 'issued', issued_on = '2026-09-30', number = ${`INV/2026-27/9${stamp.slice(-3)}`},
                             sequence_number = 900, financial_year = 2026
       WHERE id = ${id}
    `;
    const d = (await source.describe({ tenantId: tenant, kind: "invoice", subjectRef: id }))?.document;
    expect(d?.issuer.lines).toEqual([]);
    expect(d?.recipient.lines).toEqual([]);
    expect(d?.totals.map((t) => t.value)).toEqual(["INR 5,000.00", "INR 900.00", "INR 5,900.00"]);
    expect(d?.amountInWords).toBeUndefined();
  });
});
