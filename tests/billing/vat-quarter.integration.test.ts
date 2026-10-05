// Q071 (d) against a REAL database: a quarterly service on the client's own
// tax quarter (S7, after S2 + S3 merged).
//
// ── WHAT IS PROVED HERE AND NOWHERE ELSE ───────────────────────────────────
//
//   1. The sweep's subjects carry the client's assigned quarter (0359) only
//      for a service that carries an authority-assigned rule of that tax
//      (T6.16, on the lineage); another quarterly service of the same client
//      carries none.
//   2. The sweep cuts the first on the client's quarter (Feb-Apr, May-Jul),
//      called by its months, and the second on the company's year, as before.
//   3. A quarter taken off (0360's cleared_at) no longer governs.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/billing/vat-quarter.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { systemIds } from "../../src/platform/ids";
import {
  PostgresAutoBillingFirms,
  PostgresBillingDueWriter,
  PostgresBillingManagerFacts,
} from "../../src/infrastructure/postgres/billing-repository";
import { BillingService } from "../../src/usecase/billing/service";
import { FakeFiscalYearSource } from "../../src/testfakes/billing";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { RecordingEventSink } from "../../src/testfakes/ledger";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 4 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const stamp = Date.now().toString(36);
let tenantId = "";
let client = "";
let vat = "";
let bookkeeping = "";

function sweepAt(now: string) {
  return new BillingService({
    dues: new PostgresBillingDueWriter(app),
    managers: new PostgresBillingManagerFacts(app),
    firms: new PostgresAutoBillingFirms(app),
    fiscalYears: new FakeFiscalYearSource(1),
    timeZones: new FakeFirmTimeZone("Asia/Dubai"),
    ids: systemIds,
    clock: { now: () => new Date(now) },
    events: new RecordingEventSink(),
  });
}

async function company(name: string): Promise<string> {
  const [p] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name) VALUES (${tenantId}, 'organization', ${name}) RETURNING id
  `;
  if (!p) throw new Error("party seed failed");
  await owner`INSERT INTO core.organization (party_id, tenant_id, legal_name) VALUES (${p.id}, ${tenantId}, ${name})`;
  return p.id;
}

async function service(key: string, name: string): Promise<{ entry: string; version: string }> {
  const [e] = await owner<{ id: string }[]>`
    INSERT INTO config.entry (tenant_id, kind, key) VALUES (${tenantId}, 'service', ${`${key}-${stamp}`}) RETURNING id
  `;
  if (!e) throw new Error("service seed failed");
  const [v] = await owner<{ id: string }[]>`
    INSERT INTO config.version (tenant_id, entry_id, version, body, status, published_at)
    VALUES (${tenantId}, ${e.id}, 1, ${owner.json({ name, recurrence: "quarterly", module: "TRC" })}, 'published', now())
    RETURNING id
  `;
  if (!v) throw new Error("version seed failed");
  return { entry: e.id, version: v.id };
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, time_zone, auto_billing, auto_billing_since)
    VALUES (${`vq-${stamp}`}, 'VAT Quarter Test', 'AED', 'Asia/Dubai', true, '2026-01-01') RETURNING id
  `;
  if (!t) throw new Error("tenant seed failed");
  tenantId = t.id;
  const firm = await company("The Firm Gulf");
  await owner`INSERT INTO crm.firm_entity (tenant_id, party_id) VALUES (${tenantId}, ${firm})`;
  client = await company(`Falcon Trading ${stamp}`);
  await owner`
    INSERT INTO core.legal_entity (party_id, tenant_id, jurisdiction, entity_type, financial_year_end)
    VALUES (${client}, ${tenantId}, 'AE', 'llc', '12-31')
  `;

  const vatService = await service("vat", "VAT return");
  const books = await service("books", "Bookkeeping");

  // The VAT rule cuts on the period the FTA assigned (0359) and is carried by
  // the VAT service only.
  const [rule] = await owner<{ id: string; lineage_id: string }[]>`
    INSERT INTO delivery.obligation_template
      (tenant_id, jurisdiction, name, module, recurrence, due_rule, due_month_offset, due_day_of_month,
       lead_time_days, rule_pack, status, is_active, period_basis)
    VALUES (${tenantId}, 'AE', 'VAT return', 'VAT', 'quarterly', 'day_of_month', 1, 28, 10,
            ${`vq-${stamp}`}, 'confirmed', true, 'authority_assigned')
    RETURNING id, lineage_id
  `;
  if (!rule) throw new Error("rule seed failed");
  await owner`
    INSERT INTO delivery.obligation_rule_service (tenant_id, lineage_id, service_entry_id)
    VALUES (${tenantId}, ${rule.lineage_id}, ${vatService.entry})
  `;
  // Falcon's VAT quarters start in February: Feb-Apr, May-Jul, Aug-Oct, Nov-Jan.
  await owner`
    INSERT INTO core.legal_entity_return_period (tenant_id, entity_party_id, tax, frequency, first_month)
    VALUES (${tenantId}, ${client}, 'VAT', 'quarterly', 2)
  `;

  const [letter] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter
      (tenant_id, party_id, status, currency, fx_rate, fx_rate_date, ref, issuing_entity_party_id, jurisdiction, title)
    VALUES (${tenantId}, ${client}, 'draft', 'AED', 1, '2026-01-20', 'EL-2026-0001', ${firm}, 'AE', 'Engagement')
    RETURNING id
  `;
  if (!letter) throw new Error("letter seed failed");
  const lines: string[] = [];
  for (const [position, version, words] of [
    [1, vatService.version, "VAT return"],
    [2, books.version, "Bookkeeping"],
  ] as const) {
    const [ln] = await owner<{ id: string }[]>`
      INSERT INTO crm.engagement_letter_line
        (tenant_id, engagement_letter_id, position, service_version_id, quantity, unit_amount,
         currency, discount_percent, billing_frequency, entity_party_id, description)
      VALUES (${tenantId}, ${letter.id}, ${position}, ${version}, 1, 3000, 'AED', 0, 'quarterly', ${client}, ${words})
      RETURNING id
    `;
    if (!ln) throw new Error("line seed failed");
    lines.push(ln.id);
  }
  await owner`
    UPDATE crm.engagement_letter
       SET status = 'signed', sent_at = now(), signed_at = now(), signed_by_name = 'A Director',
           signature_method = 'attested', signed_content_hash = ${"d".repeat(64)}
     WHERE id = ${letter.id}
  `;
  const ids: string[] = [];
  for (const lineId of lines) {
    const [en] = await owner<{ id: string }[]>`
      INSERT INTO crm.engagement
        (tenant_id, party_id, entity_party_id, engagement_letter_id, engagement_letter_line_id,
         effective_from, status, activated_at, billing_from, first_invoice_on, year_start_month)
      VALUES (${tenantId}, ${client}, ${client}, ${letter.id}, ${lineId}, '2026-02-01', 'active', now(),
              '2026-02-01', '2026-03-31', 1)
      RETURNING id
    `;
    if (!en) throw new Error("engagement seed failed");
    ids.push(en.id);
  }
  vat = ids[0] ?? "";
  bookkeeping = ids[1] ?? "";
});

afterAll(async () => {
  await Promise.all([owner.end({ timeout: 5 }), app.end({ timeout: 5 })]);
});

describe("a quarterly service on the client's own tax quarter (Q071 d)", () => {
  it("the VAT service carries the client's quarter; bookkeeping carries none", async () => {
    const subjects = await new PostgresBillingDueWriter(app).subjectsFor(tenantId);
    expect(subjects.find((s) => s.engagementId === vat)?.assignedQuarterMonth).toBe(2);
    expect(subjects.find((s) => s.engagementId === bookkeeping)?.assignedQuarterMonth ?? null).toBeNull();
  });

  it("bills VAT on Feb-Apr and May-Jul, bookkeeping on the company's quarters", async () => {
    await sweepAt("2026-08-05T06:00:00Z").sweep();
    const dues = await owner<{ engagement_id: string; period_start: string; period_end: string; period_label: string; bill_on: string }[]>`
      SELECT engagement_id, period_start::text, period_end::text, period_label, bill_on::text
        FROM crm.billing_due WHERE tenant_id = ${tenantId} ORDER BY engagement_id, period_start
    `;
    const of = (id: string) =>
      dues.filter((d) => d.engagement_id === id).map((d) => [d.period_start, d.period_end, d.period_label, d.bill_on]);
    expect(of(vat)).toEqual([
      ["2026-02-01", "2026-04-30", "Feb-Apr 2026", "2026-04-30"],
      ["2026-05-01", "2026-07-31", "May-Jul 2026", "2026-07-31"],
    ]);
    expect(of(bookkeeping).map((r) => [r[0], r[1]])).toEqual([
      ["2026-01-01", "2026-03-31"],
      ["2026-04-01", "2026-06-30"],
    ]);
    expect(of(bookkeeping)[0]?.[2]).toMatch(/^Q1 /);
  });

  it("a quarter taken off no longer governs", async () => {
    await owner`
      UPDATE core.legal_entity_return_period SET cleared_at = now()
       WHERE tenant_id = ${tenantId} AND entity_party_id = ${client}
    `;
    const subjects = await new PostgresBillingDueWriter(app).subjectsFor(tenantId);
    expect(subjects.find((s) => s.engagementId === vat)?.assignedQuarterMonth ?? null).toBeNull();
  });
});
