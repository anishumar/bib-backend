// Billing by company (Wave 5), proven where its sums live: a real Postgres,
// through the app role, so the tenant wall is the one production has.
//
// One firm with two companies and every kind of document the definition has
// to decide about:
//
//   India Co (IN, bills INR)
//     - Aug: an invoice, 10,000 + 18% tax                  -> billed 10,000
//     - Sep: an invoice, 20,000 + 18% tax (23,600 in all)   -> 20,000
//            a credit note of 5,900 against it, in Sep     -> -5,000 (its pre-tax share)
//            a CANCELLED invoice of 50,000                 -> nothing
//            a DRAFT of 70,000                             -> nothing
//     - an invoice issued in January 2025, outside the window -> nothing
//   Gulf Co (AE, bills AED)
//     - Sep: an invoice, AED 1,000 + 5%, at 22.5           -> AED 1,000 / INR 22,500
//            an invoice in USD 100, at 83                 -> not in AED; INR 8,300
//
// and a second firm with an issued invoice in the same month, which must not
// appear in the first firm's answer.
//
// Run with:  npm run test:integration
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresDashboardRepository } from "../../src/infrastructure/postgres/dashboard-repository";
import { DashboardService } from "../../src/usecase/dashboard/service";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { FakeFiscalYearSource } from "../../src/testfakes/billing";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });
const stamp = Date.now().toString(36);

let firmA = "";
let firmB = "";
let india = "";
let gulf = "";
let other = "";

async function seedFirm(slug: string): Promise<{ tenantId: string; clientId: string }> {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${slug}, ${slug}, 'INR') RETURNING id
  `;
  if (!t) throw new Error("tenant seed failed");
  const [client] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${t.id}, 'organization', 'Kaveri Foods') RETURNING id
  `;
  if (!client) throw new Error("client seed failed");
  return { tenantId: t.id, clientId: client.id };
}

/** One of the firm's own companies, registered in `jurisdiction`, with its
 *  invoice and credit-note series for the financial year the invoices use. */
async function seedCompany(tenantId: string, name: string, jurisdiction: string): Promise<string> {
  const [party] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenantId}, 'organization', ${name}) RETURNING id
  `;
  if (!party) throw new Error("company seed failed");
  await owner`INSERT INTO core.organization (party_id, tenant_id, legal_name)
              VALUES (${party.id}, ${tenantId}, ${name})`;
  await owner`INSERT INTO core.legal_entity (party_id, tenant_id, jurisdiction, entity_type)
              VALUES (${party.id}, ${tenantId}, ${jurisdiction}, 'private_limited')`;
  await owner`INSERT INTO crm.firm_entity (tenant_id, party_id) VALUES (${tenantId}, ${party.id})`;
  for (const [type, prefix] of [["invoice", "INV"], ["credit_note", "CN"]] as const) {
    await owner`
      INSERT INTO crm.invoice_series
        (tenant_id, entity_party_id, financial_year, last_number, prefix, document_type)
      VALUES (${tenantId}, ${party.id}, 2026, 0, ${prefix}, ${type})
    `;
  }
  return party.id;
}

let sequence = 0;
/**
 * An invoice with one line, then its status. DRAFT FIRST, lines on, THEN the
 * status, which is the order `refuse_issued_invoice_line_change` (0027) allows
 * and the order a firm works in. A cancelled invoice has no issue date
 * (`invoice_issued_has_date_chk`).
 */
async function invoice(input: {
  tenantId: string;
  clientId: string;
  entity: string;
  currency: string;
  fxRate: string;
  unit: string;
  taxPercent: string;
  status: "draft" | "issued" | "cancelled";
  issuedOn: string | null;
}): Promise<string> {
  sequence += 1;
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO crm.invoice
      (tenant_id, party_id, entity_party_id, number, financial_year, sequence_number,
       status, currency, fx_rate, fx_rate_date, issued_on, due_on)
    VALUES (${input.tenantId}, ${input.clientId}, ${input.entity},
            ${`INV/${stamp}/${String(sequence)}`}, 2026, ${sequence},
            'draft', ${input.currency}, ${input.fxRate}, '2026-08-01', null, null)
    RETURNING id
  `;
  if (!row) throw new Error("invoice seed failed");
  await owner`
    INSERT INTO crm.invoice_line
      (tenant_id, invoice_id, description, position, quantity, unit_amount, currency, tax_percent)
    VALUES (${input.tenantId}, ${row.id}, 'Monthly bookkeeping', 1, 1, ${input.unit},
            ${input.currency}, ${input.taxPercent})
  `;
  if (input.status !== "draft") {
    await owner`
      UPDATE crm.invoice SET status = ${input.status}, issued_on = ${input.issuedOn}
       WHERE id = ${row.id}
    `;
  }
  return row.id;
}

beforeAll(async () => {
  const a = await seedFirm(`w5-billing-a-${stamp}`);
  const b = await seedFirm(`w5-billing-b-${stamp}`);
  firmA = a.tenantId;
  firmB = b.tenantId;
  india = await seedCompany(firmA, "Alpha India Private Limited", "IN");
  gulf = await seedCompany(firmA, "Beta Gulf FZCO", "AE");
  other = await seedCompany(firmB, "Other Firm LLP", "IN");

  const base = { tenantId: firmA, clientId: a.clientId };
  await invoice({ ...base, entity: india, currency: "INR", fxRate: "1", unit: "10000", taxPercent: "18", status: "issued", issuedOn: "2026-08-10" });
  const september = await invoice({ ...base, entity: india, currency: "INR", fxRate: "1", unit: "20000", taxPercent: "18", status: "issued", issuedOn: "2026-09-05" });
  await invoice({ ...base, entity: india, currency: "INR", fxRate: "1", unit: "50000", taxPercent: "18", status: "cancelled", issuedOn: null });
  await invoice({ ...base, entity: india, currency: "INR", fxRate: "1", unit: "70000", taxPercent: "18", status: "draft", issuedOn: null });
  await invoice({ ...base, entity: india, currency: "INR", fxRate: "1", unit: "90000", taxPercent: "18", status: "issued", issuedOn: "2025-01-10" });
  await invoice({ ...base, entity: gulf, currency: "AED", fxRate: "22.5", unit: "1000", taxPercent: "5", status: "issued", issuedOn: "2026-09-12" });
  await invoice({ ...base, entity: gulf, currency: "USD", fxRate: "83", unit: "100", taxPercent: "0", status: "issued", issuedOn: "2026-09-15" });

  // 5,900 off an invoice of 20,000 + 3,600 tax: its pre-tax share is 5,000.
  await owner`
    INSERT INTO crm.credit_note
      (tenant_id, invoice_id, entity_party_id, number, financial_year, sequence_number,
       amount, currency, issued_on, reason)
    VALUES (${firmA}, ${september}, ${india}, ${`CN/${stamp}/1`}, 2026, 1,
            5900, 'INR', '2026-09-20', 'goodwill')
  `;

  await invoice({ tenantId: firmB, clientId: b.clientId, entity: other, currency: "INR", fxRate: "1", unit: "999999", taxPercent: "0", status: "issued", issuedOn: "2026-09-01" });
});

afterAll(async () => {
  // An issued invoice and a credit note cannot be changed or removed, which is
  // right in the product and makes a teardown impossible; the freezes are off
  // for the length of this cleanup only, as the owner, as the other invoice
  // tests do.
  await owner`ALTER TABLE crm.invoice DISABLE TRIGGER trg_invoice_number_freeze`;
  await owner`ALTER TABLE crm.invoice_line DISABLE TRIGGER trg_invoice_line_freeze`;
  await owner`ALTER TABLE crm.credit_note DISABLE TRIGGER trg_credit_note_freeze`;
  try {
    for (const t of [firmA, firmB]) {
      if (t === "") continue;
      await owner`DELETE FROM crm.credit_note WHERE tenant_id = ${t}`;
      await owner`DELETE FROM crm.invoice_line WHERE tenant_id = ${t}`;
      await owner`DELETE FROM crm.invoice WHERE tenant_id = ${t}`;
      await owner`DELETE FROM crm.invoice_series WHERE tenant_id = ${t}`;
      await owner`DELETE FROM crm.firm_entity WHERE tenant_id = ${t}`;
      await owner`DELETE FROM core.legal_entity WHERE tenant_id = ${t}`;
      await owner`DELETE FROM core.organization WHERE tenant_id = ${t}`;
      await owner`DELETE FROM core.party WHERE tenant_id = ${t}`;
      await owner`DELETE FROM tenancy.tenant WHERE id = ${t}`;
    }
  } finally {
    await owner`ALTER TABLE crm.invoice ENABLE TRIGGER trg_invoice_number_freeze`;
    await owner`ALTER TABLE crm.invoice_line ENABLE TRIGGER trg_invoice_line_freeze`;
    await owner`ALTER TABLE crm.credit_note ENABLE TRIGGER trg_credit_note_freeze`;
    await owner.end();
    await app.end();
  }
});

function service(): DashboardService {
  return new DashboardService({
    dashboards: new PostgresDashboardRepository(app),
    timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
    fiscalYears: new FakeFiscalYearSource(),
    clock: new FakeClock(new Date("2026-09-29T10:00:00Z")),
  });
}

describe("billing by company, against real rows", () => {
  it("bills issued invoices before tax, less a credit note's pre-tax share", async () => {
    const out = await service().revenueByCompany(firmA, 12);
    expect(out.reportingCurrency).toBe("INR");
    expect(out.months[0]).toBe("2025-10");
    expect(out.months.at(-1)).toBe("2026-09");

    const alpha = out.companies.find((c) => c.partyId === india);
    expect(alpha?.currency).toBe("INR");
    const month = (m: string) => alpha?.months.find((x) => x.month === m);
    expect(month("2026-08")).toEqual({
      month: "2026-08",
      billed: "10000.0000",
      billedReporting: "10000.0000",
      invoiceCount: 1,
    });
    // 20,000 less 5,000: the cancelled invoice, the draft and the January
    // 2025 one are not in it.
    expect(month("2026-09")).toEqual({
      month: "2026-09",
      billed: "15000.0000",
      billedReporting: "15000.0000",
      invoiceCount: 1,
    });
    expect(month("2026-07")?.billed).toBe("0");
    expect(alpha?.otherCurrencyInvoices).toBe(0);
  });

  it("keeps a company in its own currency and never converts at a rate nothing stores", async () => {
    const out = await service().revenueByCompany(firmA, 12);
    const beta = out.companies.find((c) => c.partyId === gulf);
    expect(beta?.currency).toBe("AED");
    expect(beta?.months.find((m) => m.month === "2026-09")).toEqual({
      month: "2026-09",
      billed: "1000.0000",
      // AED 1,000 at 22.5 and USD 100 at 83, each at its own stored rate.
      billedReporting: "30800.0000",
      invoiceCount: 1,
    });
    expect(beta?.otherCurrencyInvoices).toBe(1);
  });

  it("totals the whole firm per month in the reporting currency", async () => {
    const out = await service().revenueByCompany(firmA, 12);
    expect(out.total.find((t) => t.month === "2026-08")).toEqual({
      month: "2026-08",
      billedReporting: "10000.0000",
      invoiceCount: 1,
    });
    expect(out.total.find((t) => t.month === "2026-09")).toEqual({
      month: "2026-09",
      billedReporting: "45800.0000",
      invoiceCount: 3,
    });
  });

  it("stays behind the tenant wall", async () => {
    const out = await service().revenueByCompany(firmA, 12);
    expect(out.companies.map((c) => c.partyId).sort()).toEqual([india, gulf].sort());
    expect(JSON.stringify(out)).not.toContain("999999");
    const theirs = await service().revenueByCompany(firmB, 12);
    expect(theirs.companies.map((c) => c.partyId)).toEqual([other]);
    expect(theirs.total.find((t) => t.month === "2026-09")?.billedReporting).toBe("999999.0000");
  });
});
