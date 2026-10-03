// B42 and CA#56 (audit 2026-10-03), against a real Postgres and the real
// render source.
//
//   A DRAFT IS DATED ON THE FIRM'S DAY. A draft invoice first saved at 20:00
//   UTC on 2 October, in a firm on India time, was saved on 3 October there,
//   and its draft copy printed "2 October 2026": the UTC day. Described for a
//   preview or a draft copy, it is dated as Issue will date it, the firm's day
//   given, and says so.
//
//   AN UNNUMBERED DRAFT says so too, so its file is not named after "Draft".
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresRenderSource } from "../../src/infrastructure/postgres/render-source";
import { FakeBlobStore } from "../../src/testfakes/filestore";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });
const blobs = new FakeBlobStore();
const source = new PostgresRenderSource(app, (i) => blobs.get(i));

const stamp = Date.now().toString(36);
let tenant = "";
let invoiceId = "";

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, time_zone)
    VALUES (${`b42-${stamp}`}, ${`b42-${stamp}`}, 'INR', 'Asia/Kolkata') RETURNING id
  `;
  tenant = t?.id ?? "";
  const party = async (name: string): Promise<string> => {
    const [p] = await owner<{ id: string }[]>`
      INSERT INTO core.party (tenant_id, kind, display_name) VALUES (${tenant}, 'organization', ${name}) RETURNING id
    `;
    return p?.id ?? "";
  };
  const client = await party("Deccan Agro Foods Private Limited");
  const firm = await party("Sharma Mehta & Co");
  await owner`
    INSERT INTO crm.firm_entity_preference (tenant_id, client_jurisdiction, firm_entity_party_id)
    VALUES (${tenant}, '*', ${firm})
  `;
  await owner`
    INSERT INTO crm.invoice_series (tenant_id, entity_party_id, financial_year, document_type, prefix)
    VALUES (${tenant}, ${firm}, 2026, 'invoice', 'INV')
    ON CONFLICT DO NOTHING
  `;
  const [i] = await owner<{ id: string }[]>`
    INSERT INTO crm.invoice (tenant_id, party_id, entity_party_id, financial_year, currency,
                             fx_rate, fx_rate_date, created_at)
    VALUES (${tenant}, ${client}, ${firm}, 2026, 'INR', 1, '2026-10-02',
            '2026-10-02T20:00:00Z')
    RETURNING id
  `;
  invoiceId = i?.id ?? "";
  await owner`
    INSERT INTO crm.invoice_line (tenant_id, invoice_id, description, position, quantity,
                                  unit_amount, currency, tax_percent)
    VALUES (${tenant}, ${invoiceId}, 'GST returns for September 2026', 1, 1, 5000, 'INR', 18)
  `;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

function invoiceDate(meta: readonly { label: string; value: string }[]): string | undefined {
  return meta.find((m) => m.label === "Invoice date")?.value;
}

describe("a draft is dated on the firm's day (B42)", () => {
  it("a draft invoice described as it stands reads the firm's day it was saved, never the UTC day", async () => {
    const described = await source.describe({ tenantId: tenant, kind: "invoice", subjectRef: invoiceId });
    expect(invoiceDate(described?.document.meta ?? [])).toBe("3 October 2026");
    expect(described?.document.issuedOn).toBe("2026-10-03");
    expect(described?.datedAsIfSent).toBeUndefined();
  });

  it("a draft invoice drawn for a preview or a draft copy is dated as Issue will date it", async () => {
    const described = await source.describe({
      tenantId: tenant,
      kind: "invoice",
      subjectRef: invoiceId,
      asIfSentOn: "2026-10-05",
    });
    expect(invoiceDate(described?.document.meta ?? [])).toBe("5 October 2026");
    expect(described?.datedAsIfSent).toBe("2026-10-05");
  });

  it("says a draft invoice has no number yet, so nothing is named after 'Draft' (CA#56)", async () => {
    const described = await source.describe({ tenantId: tenant, kind: "invoice", subjectRef: invoiceId });
    expect(described?.unnumbered).toBe(true);
    expect(described?.document.reference).toBe("Draft");
  });
});
