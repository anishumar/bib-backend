// Revenue by manager (auto-invoice T4), proven where its sums live: a real
// Postgres, through the app role, so the tenant wall is the one production has.
//
// One firm, two companies (India Co bills INR, Gulf Co AED), three people:
// Mona (staff), Zubin (has left: membership inactive) and an outsider who is
// staff at ANOTHER firm only. The clock is 29 September 2026 in Kolkata.
//
//   Mona  Aug  INV 10,000 + 18%, paid 11,800 on 2 Sep     -> Aug billed 10,000, Sep collected 11,800
//         Sep  INV 20,000 + 18% (23,600)                   -> 20,000
//              credit note 5,900 on 20 Sep                 -> -5,000 (pre-tax share)
//              part payment 10,000 on 21 Sep               -> collected 10,000, still owed 7,700
//         Sep  INV AED 1,000 + 5% at 22.5 (Gulf Co)        -> 22,500
//              paid AED 1,050 on 15 Sep, bounced 18 Sep    -> collected +23,625 - 23,625, owed 23,625
//         Jan 2025 INV 90,000, unpaid (outside the window)  -> billed nothing here, owed 90,000 NOW
//         Sep  INV 50,000, 5,000 paid, then CANCELLED      -> nothing anywhere
//              a DRAFT of 70,000                           -> nothing
//   Zubin Aug  INV 8,000, no tax, unpaid                    -> Aug 8,000, owed 8,000; left the firm
//   nobody Sep INV 7,000 + 18% (8,260), unpaid              -> the no-manager row
//   the outsider, named on a Sep INV of 1,000 by a bad write -> a row with no name
//
// and a second firm whose invoice in September must not appear.
//
// Run with:  npm run test:integration
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresDashboardRepository } from "../../src/infrastructure/postgres/dashboard-repository";
import { PostgresInvoiceRepository } from "../../src/infrastructure/postgres/invoice-repository";
import { PostgresMembershipRepository } from "../../src/infrastructure/postgres/membership-repository";
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
let mona = "";
let zubin = "";
let outsider = "";
let draft = "";
let september = "";
const users: string[] = [];

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

async function staff(tenantId: string, name: string, active: boolean): Promise<string> {
  const [u] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`${name.toLowerCase()}-${stamp}@example.test`}, ${name}) RETURNING id
  `;
  if (!u) throw new Error("user seed failed");
  users.push(u.id);
  await owner`
    INSERT INTO tenancy.membership (tenant_id, user_id, audience, role, is_active)
    VALUES (${tenantId}, ${u.id}, 'STAFF', 'partner', ${active})
  `;
  return u.id;
}

let sequence = 0;
/** An invoice with one line: drafted, the line on, THEN its status, the order
 *  the freezes allow. A cancelled one keeps its issue date (0029). */
async function invoice(input: {
  tenantId: string;
  clientId: string;
  entity: string;
  manager: string | null;
  currency?: string;
  fxRate?: string;
  unit: string;
  taxPercent: string;
  status: "draft" | "issued";
  issuedOn: string | null;
}): Promise<string> {
  sequence += 1;
  const currency = input.currency ?? "INR";
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO crm.invoice
      (tenant_id, party_id, entity_party_id, number, financial_year, sequence_number,
       status, currency, fx_rate, fx_rate_date, issued_on, due_on, manager_user_id)
    VALUES (${input.tenantId}, ${input.clientId}, ${input.entity},
            ${`INV/${stamp}/${String(sequence)}`}, 2026, ${sequence},
            'draft', ${currency}, ${input.fxRate ?? "1"}, '2026-08-01', null, null, ${input.manager})
    RETURNING id
  `;
  if (!row) throw new Error("invoice seed failed");
  await owner`
    INSERT INTO crm.invoice_line
      (tenant_id, invoice_id, description, position, quantity, unit_amount, currency, tax_percent)
    VALUES (${input.tenantId}, ${row.id}, 'Monthly bookkeeping', 1, 1, ${input.unit},
            ${currency}, ${input.taxPercent})
  `;
  if (input.status === "issued") {
    await owner`UPDATE crm.invoice SET status = 'issued', issued_on = ${input.issuedOn} WHERE id = ${row.id}`;
  }
  return row.id;
}

async function pay(tenantId: string, invoiceId: string, amount: string, currency: string, on: string): Promise<void> {
  await owner`
    INSERT INTO crm.payment (tenant_id, invoice_id, amount, currency, received_on, method)
    VALUES (${tenantId}, ${invoiceId}, ${amount}, ${currency}, ${on}, 'bank_transfer')
  `;
}

beforeAll(async () => {
  const a = await seedFirm(`t4-mgr-a-${stamp}`);
  const b = await seedFirm(`t4-mgr-b-${stamp}`);
  firmA = a.tenantId;
  firmB = b.tenantId;
  const india = await seedCompany(firmA, "Alpha India Private Limited", "IN");
  const gulf = await seedCompany(firmA, "Beta Gulf FZCO", "AE");
  const other = await seedCompany(firmB, "Other Firm LLP", "IN");
  mona = await staff(firmA, "Mona", true);
  zubin = await staff(firmA, "Zubin", false);
  outsider = await staff(firmB, "Outsider", true);

  const A = { tenantId: firmA, clientId: a.clientId, entity: india };
  const august = await invoice({ ...A, manager: mona, unit: "10000", taxPercent: "18", status: "issued", issuedOn: "2026-08-10" });
  await pay(firmA, august, "11800", "INR", "2026-09-02");

  september = await invoice({ ...A, manager: mona, unit: "20000", taxPercent: "18", status: "issued", issuedOn: "2026-09-05" });
  await owner`
    INSERT INTO crm.credit_note
      (tenant_id, invoice_id, entity_party_id, number, financial_year, sequence_number,
       amount, currency, issued_on, reason)
    VALUES (${firmA}, ${september}, ${india}, ${`CN/${stamp}/1`}, 2026, 1,
            5900, 'INR', '2026-09-20', 'goodwill')
  `;
  await pay(firmA, september, "10000", "INR", "2026-09-21");

  const aed = await invoice({ ...A, entity: gulf, manager: mona, currency: "AED", fxRate: "22.5", unit: "1000", taxPercent: "5", status: "issued", issuedOn: "2026-09-12" });
  await pay(firmA, aed, "1050", "AED", "2026-09-15");
  await pay(firmA, aed, "-1050", "AED", "2026-09-18");

  await invoice({ ...A, manager: mona, unit: "90000", taxPercent: "0", status: "issued", issuedOn: "2025-01-10" });

  const cancelled = await invoice({ ...A, manager: mona, unit: "50000", taxPercent: "0", status: "issued", issuedOn: "2026-09-06" });
  await pay(firmA, cancelled, "5000", "INR", "2026-09-07");
  // A paid invoice cancelled BEFORE 0326 (B05 refuses it since; the audit found
  // 16 such rows): written with the triggers off, as the data already stands.
  await owner.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`UPDATE crm.invoice SET status = 'cancelled' WHERE id = ${cancelled}`;
  });

  draft = await invoice({ ...A, manager: mona, unit: "70000", taxPercent: "18", status: "draft", issuedOn: null });
  await invoice({ ...A, manager: zubin, unit: "8000", taxPercent: "0", status: "issued", issuedOn: "2026-08-20" });
  await invoice({ ...A, manager: null, unit: "7000", taxPercent: "18", status: "issued", issuedOn: "2026-09-25" });
  // A write from before the roster check: the key reaches the global user
  // account, so nothing in the schema stopped it.
  await invoice({ ...A, manager: outsider, unit: "1000", taxPercent: "0", status: "issued", issuedOn: "2026-09-10" });

  await invoice({ tenantId: firmB, clientId: b.clientId, entity: other, manager: outsider, unit: "999999", taxPercent: "0", status: "issued", issuedOn: "2026-09-01" });
});

afterAll(async () => {
  // Issued invoices and credit notes cannot be changed or removed, which is
  // right in the product and makes a teardown impossible; the freezes are off
  // for this cleanup only, as the owner, as the other invoice tests do.
  await owner`ALTER TABLE crm.invoice DISABLE TRIGGER trg_invoice_number_freeze`;
  await owner`ALTER TABLE crm.invoice_line DISABLE TRIGGER trg_invoice_line_freeze`;
  await owner`ALTER TABLE crm.credit_note DISABLE TRIGGER trg_credit_note_freeze`;
  try {
    for (const t of [firmA, firmB]) {
      if (t === "") continue;
      await owner`DELETE FROM crm.payment WHERE tenant_id = ${t}`;
      await owner`DELETE FROM crm.credit_note WHERE tenant_id = ${t}`;
      await owner`DELETE FROM crm.invoice_line WHERE tenant_id = ${t}`;
      await owner`DELETE FROM crm.invoice WHERE tenant_id = ${t}`;
      await owner`DELETE FROM crm.invoice_series WHERE tenant_id = ${t}`;
      await owner`DELETE FROM crm.firm_entity WHERE tenant_id = ${t}`;
      await owner`DELETE FROM core.legal_entity WHERE tenant_id = ${t}`;
      await owner`DELETE FROM core.organization WHERE tenant_id = ${t}`;
      await owner`DELETE FROM core.party WHERE tenant_id = ${t}`;
      await owner`DELETE FROM tenancy.membership WHERE tenant_id = ${t}`;
      await owner`DELETE FROM tenancy.tenant WHERE id = ${t}`;
    }
    if (users.length > 0) await owner`DELETE FROM tenancy.user_account WHERE id = ANY(${users}::uuid[])`;
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
    fiscalYears: new FakeFiscalYearSource(4),
    clock: new FakeClock(new Date("2026-09-29T10:00:00Z")),
  });
}

describe("revenue by manager, against real rows", () => {
  it("bills before tax less credit notes, and collects the cash that came in that month", async () => {
    const out = await service().revenueByManager(firmA, 12);
    expect(out.reportingCurrency).toBe("INR");
    expect(out.months.at(-1)).toBe("2026-09");
    expect(out.financialYearStartMonth).toBe(4);

    const row = out.managers.find((m) => m.userId === mona);
    expect(row).toMatchObject({ name: "Mona", activeStaff: true });
    const month = (m: string) => row?.months.find((x) => x.month === m);
    expect(month("2026-08")).toEqual({ month: "2026-08", billed: "10000.0000", collected: "0", invoiceCount: 1 });
    // 20,000 - 5,000 + AED 1,000 at 22.5. Collected: 11,800 for August's
    // invoice, 10,000 part paid, and the AED cheque in and out again. The
    // cancelled invoice (and its payment) and the draft are nowhere.
    expect(month("2026-09")).toEqual({
      month: "2026-09",
      billed: "37500.0000",
      collected: "21800.0000",
      invoiceCount: 2,
    });
    // Owed NOW, not cut by month: 7,700 + 23,625 + the January 2025 90,000.
    expect(row).toMatchObject({ outstanding: "121325.0000", outstandingInvoices: 3 });
  });

  it("keeps a leaver's revenue under their name, and lists the invoices naming nobody", async () => {
    const out = await service().revenueByManager(firmA, 12);
    const gone = out.managers.find((m) => m.userId === zubin);
    expect(gone).toMatchObject({ name: "Zubin", activeStaff: false, outstanding: "8000.0000" });
    expect(gone?.months.find((m) => m.month === "2026-08")?.billed).toBe("8000.0000");

    const nobody = out.managers.at(-1);
    expect(nobody).toMatchObject({ userId: null, name: null, outstanding: "8260.0000", outstandingInvoices: 1 });
    expect(nobody?.months.find((m) => m.month === "2026-09")?.billed).toBe("7000.0000");
  });

  it("names nobody from another firm's roster", async () => {
    const out = await service().revenueByManager(firmA, 12);
    const stranger = out.managers.find((m) => m.userId === outsider);
    expect(stranger).toMatchObject({ name: null, activeStaff: false, outstanding: "1000.0000" });
    expect(stranger?.months.find((m) => m.month === "2026-09")?.billed).toBe("1000.0000");
  });

  it("adds up to the figures the dashboard already shows", async () => {
    const svc = service();
    const [managers, companies, overview] = await Promise.all([
      svc.revenueByManager(firmA, 12),
      svc.revenueByCompany(firmA, 12),
      svc.overview(firmA),
    ]);
    // Billed: the "All companies" total, month for month, to the paisa.
    expect(managers.total.months.map((m) => [m.month, m.billed])).toEqual(
      companies.total.map((t) => [t.month, t.billedReporting]),
    );
    expect(managers.total.months.find((m) => m.month === "2026-09")?.billed).toBe("45500.0000");
    // Owed: "Owed to the firm".
    expect(managers.total.outstanding).toBe(overview.receivables.outstanding);
    expect(managers.total).toMatchObject({ outstanding: "138585.0000", outstandingInvoices: 6 });
    expect(managers.total.months.find((m) => m.month === "2026-09")?.collected).toBe("21800.0000");
  });

  it("stays behind the tenant wall", async () => {
    const out = await service().revenueByManager(firmA, 12);
    expect(JSON.stringify(out)).not.toContain("999999");
    const theirs = await service().revenueByManager(firmB, 12);
    expect(theirs.managers.map((m) => [m.userId, m.name])).toEqual([[outsider, "Outsider"]]);
    expect(theirs.total.outstanding).toBe("999999.0000");
  });
});

describe("whose revenue a draft is, against real rows", () => {
  it("changes a draft's manager and refuses an issued one's", async () => {
    const repo = new PostgresInvoiceRepository(app);
    expect((await repo.setManager(firmA, draft, zubin)).managerUserId).toBe(zubin);
    expect((await repo.setManager(firmA, draft, null)).managerUserId).toBeNull();
    await expect(repo.setManager(firmA, september, zubin)).rejects.toThrow(/no row matched/);
    // And the trigger, for a writer that is not the repository.
    await expect(
      owner`UPDATE crm.invoice SET manager_user_id = ${zubin} WHERE id = ${september}`,
    ).rejects.toThrow();
  });

  it("asks this firm's roster, today, who may be named", async () => {
    const roster = new PostgresMembershipRepository(app);
    expect(await roster.isActiveStaff(firmA, mona)).toBe(true);
    expect(await roster.isActiveStaff(firmA, zubin)).toBe(false);
    expect(await roster.isActiveStaff(firmA, outsider)).toBe(false);
  });
});
