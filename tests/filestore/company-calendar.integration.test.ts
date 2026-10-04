// The days a company's documents read off the database are the issuing
// COMPANY's (0337): the issuer the store dates a draft by, a draft's date when
// nothing else dates it, and the day a company's own number is in force from.
//
// The firm sits on Pacific/Kiritimati (UTC+14) and its company on
// Pacific/Pago_Pago (UTC-11): 25 hours apart, so ANY instant falls on two
// different days, and the test cannot pass by the firm's day by accident.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/filestore/company-calendar.integration.test.ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresRenderSource } from "../../src/infrastructure/postgres/render-source";
import { PostgresFirmEntityRepository } from "../../src/infrastructure/postgres/firm-entity-repository";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });
const source = new PostgresRenderSource(app, () => Promise.resolve(null));
const firmEntities = new PostgresFirmEntityRepository(app);

const stamp = Date.now().toString(36);
const INSTANT = "2026-10-31T20:00:00Z"; // Pago Pago: 31 Oct 09:00. Kiritimati: 1 Nov 10:00.
let tenantId = "";
let client = "";
let farWest = "";
let firmItself = "";

async function organization(name: string): Promise<string> {
  const [p] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name) VALUES (${tenantId}, 'organization', ${name}) RETURNING id
  `;
  if (!p) throw new Error("party seed failed");
  await owner`INSERT INTO core.organization (party_id, tenant_id, legal_name) VALUES (${p.id}, ${tenantId}, ${name})`;
  return p.id;
}

/** A draft invoice by `issuer`, first saved at INSTANT, with one line. */
async function draftInvoice(issuer: string): Promise<string> {
  await owner`
    INSERT INTO crm.invoice_series (tenant_id, entity_party_id, financial_year, document_type, prefix)
    VALUES (${tenantId}, ${issuer}, 2026, 'invoice', 'INV')
    ON CONFLICT (tenant_id, entity_party_id, financial_year, document_type) DO NOTHING
  `;
  const [i] = await owner<{ id: string }[]>`
    INSERT INTO crm.invoice (tenant_id, party_id, entity_party_id, financial_year, currency, fx_rate, fx_rate_date, created_at)
    VALUES (${tenantId}, ${client}, ${issuer}, 2026, 'INR', 1, '2026-10-01', ${INSTANT}::timestamptz)
    RETURNING id
  `;
  if (!i) throw new Error("invoice seed failed");
  await owner`
    INSERT INTO crm.invoice_line (tenant_id, invoice_id, position, description, quantity, unit_amount, currency)
    VALUES (${tenantId}, ${i.id}, 1, 'Advisory', 1, 1000, 'INR')
  `;
  return i.id;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, time_zone)
    VALUES (${`cal-doc-${stamp}`}, ${`cal-doc-${stamp}`}, 'INR', 'Pacific/Kiritimati') RETURNING id
  `;
  if (!t) throw new Error("tenant seed failed");
  tenantId = t.id;
  client = await organization("Kaveri Foods Private Limited");
  farWest = await organization("Far West Advisory Inc");
  firmItself = await organization("Far East Advisory Ltd");
  await owner`
    INSERT INTO core.legal_entity (party_id, tenant_id, jurisdiction, entity_type, time_zone)
    VALUES (${farWest}, ${tenantId}, 'AS', 'Inc', 'Pacific/Pago_Pago')
  `;
  await owner`INSERT INTO crm.firm_entity (tenant_id, party_id) VALUES (${tenantId}, ${farWest}), (${tenantId}, ${firmItself})`;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

describe("a company's documents read its day off the database (0337)", () => {
  it("names the company that issues a record, and nobody for a record that is not there", async () => {
    const invoiceId = await draftInvoice(farWest);
    expect(await source.issuerOf({ tenantId, kind: "invoice", subjectRef: invoiceId })).toBe(farWest);
    expect(await source.issuerOf({ tenantId, kind: "invoice", subjectRef: randomUUID() })).toBeNull();
  });

  it("dates a draft invoice nothing else dates on the day its company first saved it", async () => {
    const west = await source.describe({ tenantId, kind: "invoice", subjectRef: await draftInvoice(farWest) });
    const own = await source.describe({ tenantId, kind: "invoice", subjectRef: await draftInvoice(firmItself) });
    expect(west?.document.issuedOn).toBe("2026-10-31");
    expect(own?.document.issuedOn).toBe("2026-11-01");
  });

  it("puts a company's own number in force from its company's today", async () => {
    const result = await firmEntities.edit(tenantId, farWest, {
      numbers: [{ types: ["ein"], set: { id: randomUUID(), type: "ein", value: `98-${stamp}` } }],
    });
    expect("numbers" in result).toBe(true);
    const [row] = await owner<{ valid_from: string; company_today: string }[]>`
      SELECT valid_from::text, (now() AT TIME ZONE 'Pacific/Pago_Pago')::date::text AS company_today
        FROM core.party_identifier WHERE party_id = ${farWest} AND voided_at IS NULL
    `;
    expect(row?.valid_from).toBe(row?.company_today);
  });
});
