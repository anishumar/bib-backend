// Ageing cut on the FIRM's day, not the database's (audit 2026-10-03, B29).
//
// `crm.receivable_ageing` bucketed by CURRENT_DATE, the database session's
// day (Etc/UTC here), so between 00:00 and 05:30 IST an invoice due yesterday
// read "current" on the dashboard while /receivables, asked on the firm's day,
// called it overdue. The dashboard now reads `crm.receivable_ageing_on(day)`
// (0328) with the firm's day, and this pins it: the same invoice is current on
// its due day and overdue the day after, WHATEVER the database thinks today
// is, and RLS still holds through the function.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresDashboardRepository } from "../../src/infrastructure/postgres/dashboard-repository";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });
const repo = new PostgresDashboardRepository(app);
const stamp = Date.now().toString(36);

let firm = "";
let other = "";

async function seedFirm(slug: string): Promise<{ tenantId: string; clientId: string; entity: string }> {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, time_zone)
    VALUES (${slug}, ${slug}, 'INR', 'Asia/Kolkata') RETURNING id
  `;
  if (!t) throw new Error("tenant seed failed");
  const [client] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name) VALUES (${t.id}, 'organization', 'Kaveri Foods') RETURNING id
  `;
  const [entity] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name) VALUES (${t.id}, 'organization', 'Firm Co') RETURNING id
  `;
  if (!client || !entity) throw new Error("party seed failed");
  await owner`INSERT INTO core.organization (party_id, tenant_id, legal_name) VALUES (${entity.id}, ${t.id}, 'Firm Co')`;
  await owner`INSERT INTO crm.firm_entity (tenant_id, party_id) VALUES (${t.id}, ${entity.id})`;
  await owner`
    INSERT INTO crm.invoice_series (tenant_id, entity_party_id, financial_year, last_number, prefix, document_type)
    VALUES (${t.id}, ${entity.id}, 2026, 0, 'INV', 'invoice')
  `;
  return { tenantId: t.id, clientId: client.id, entity: entity.id };
}

beforeAll(async () => {
  const a = await seedFirm(`ageing-day-a-${stamp}`);
  const b = await seedFirm(`ageing-day-b-${stamp}`);
  firm = a.tenantId;
  other = b.tenantId;
  // One issued invoice of 10,000 (no tax), due 2 October 2026, nothing paid.
  const [inv] = await owner<{ id: string }[]>`
    INSERT INTO crm.invoice
      (tenant_id, party_id, entity_party_id, number, financial_year, sequence_number,
       status, currency, fx_rate, fx_rate_date, issued_on, due_on)
    VALUES (${firm}, ${a.clientId}, ${a.entity}, ${`INV/${stamp}/1`}, 2026, 1,
            'draft', 'INR', 1, '2026-09-01', null, '2026-10-02')
    RETURNING id
  `;
  if (!inv) throw new Error("invoice seed failed");
  await owner`
    INSERT INTO crm.invoice_line (tenant_id, invoice_id, description, position, quantity, unit_amount, currency, tax_percent)
    VALUES (${firm}, ${inv.id}, 'Monthly bookkeeping', 1, 1, 10000, 'INR', 0)
  `;
  await owner`UPDATE crm.invoice SET status = 'issued', issued_on = '2026-09-02' WHERE id = ${inv.id}`;
});

afterAll(async () => {
  await Promise.all([owner.end({ timeout: 5 }), app.end({ timeout: 5 })]);
});

const band = (r: Awaited<ReturnType<typeof repo.receivables>>, bucket: string) =>
  r.bands.find((b) => b.bucket === bucket)?.invoiceCount ?? 0;

describe("ageing on the day the firm says it is", () => {
  it("is current on its due day and overdue the day after, whatever the database's day", async () => {
    const onDue = await repo.receivables(firm, "2026-10-02");
    expect(band(onDue, "current")).toBe(1);
    expect(band(onDue, "d1_30")).toBe(0);
    const after = await repo.receivables(firm, "2026-10-03");
    expect(band(after, "current")).toBe(0);
    expect(band(after, "d1_30")).toBe(1);
    expect(Number(after.outstanding)).toBe(10000);
  });

  it("is one firm's ageing and nobody else's", async () => {
    const theirs = await repo.receivables(other, "2026-10-03");
    expect(Number(theirs.outstanding)).toBe(0);
  });

  it("counts credit sales back from the firm's day", async () => {
    // Issued 2 Sep: inside a 31-day window ending 3 Oct, outside one ending 4 Oct.
    expect(Number(await repo.creditSales(firm, 31, "2026-10-03"))).toBe(10000);
    expect(Number(await repo.creditSales(firm, 31, "2026-10-04"))).toBe(0);
  });
});
