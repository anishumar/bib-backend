// What automatic billing bills on 1 November for a letter shaped like the demo's
// EL-2026-0001 (audit 2026-10-03, F03 / F17). A pinned clock, a real database,
// the real sweep: no reading of the code, the number itself.
//
// The letter line: "Bookkeeping and MIS, 12 months", Monthly, quantity 12,
// INR 25,000, 10% off, billed after each month, billing from 1 October 2026.
// And a quarterly line written the same way: quantity 4, INR 9,000.
//
// QUANTITY MULTIPLIES THE FEE FOR ONE PERIOD, everywhere in this product: the
// letter's fee column ("INR 2,70,000 per month"), the proposal's "Fees … Monthly",
// the monthly recurring revenue and this sweep. So the bill for October is
// 12 x 25,000 x 0.9 = 2,70,000, not the 22,500 the description's "12 months"
// suggests. This test pins that number so nobody has to guess it again.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/billing/quantity.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import {
  PostgresBillingDueWriter,
  PostgresBillingManagerFacts,
} from "../../src/infrastructure/postgres/billing-repository";
import { systemIds } from "../../src/platform/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { FakeAutoBillingFirms, FakeFiscalYearSource } from "../../src/testfakes/billing";
import { BillingService } from "../../src/usecase/billing/service";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const stamp = Date.now().toString(36);
let tenantId = "";
let monthly = "";
let quarterly = "";

/** The sweep as the worker runs it, on 1 November 2026 at 11:30 in Delhi. */
function sweepOn(instant: string): BillingService {
  return new BillingService({
    dues: new PostgresBillingDueWriter(app),
    managers: new PostgresBillingManagerFacts(app),
    firms: new FakeAutoBillingFirms([tenantId]),
    fiscalYears: new FakeFiscalYearSource(4),
    timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
    ids: systemIds,
    clock: { now: () => new Date(instant) },
    events: new RecordingEventSink(),
  });
}

async function company(name: string): Promise<string> {
  const [p] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name) VALUES (${tenantId}, 'organization', ${name})
    RETURNING id
  `;
  if (!p) throw new Error("party seed failed");
  await owner`INSERT INTO core.organization (party_id, tenant_id, legal_name) VALUES (${p.id}, ${tenantId}, ${name})`;
  return p.id;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`qty-${stamp}`}, 'Quantity Proof', 'INR') RETURNING id
  `;
  if (!t) throw new Error("tenant seed failed");
  tenantId = t.id;
  const firm = await company("The Firm");
  await owner`INSERT INTO crm.firm_entity (tenant_id, party_id) VALUES (${tenantId}, ${firm})`;
  const client = await company(`Cobalt Foods ${stamp}`);

  const [entry] = await owner<{ id: string }[]>`
    INSERT INTO config.entry (tenant_id, kind, key) VALUES (${tenantId}, 'service', ${`books-${stamp}`})
    RETURNING id
  `;
  if (!entry) throw new Error("service seed failed");
  const [version] = await owner<{ id: string }[]>`
    INSERT INTO config.version (tenant_id, entry_id, version, body, status, published_at)
    VALUES (${tenantId}, ${entry.id}, 1,
            ${owner.json({ name: "Bookkeeping", recurrence: "monthly", module: "FRC" })}, 'published', now())
    RETURNING id
  `;
  if (!version) throw new Error("version seed failed");

  const [l] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter
      (tenant_id, party_id, status, currency, fx_rate, fx_rate_date, ref,
       issuing_entity_party_id, jurisdiction, title)
    VALUES (${tenantId}, ${client}, 'draft', 'INR', 1, '2026-10-01', 'EL-2026-0001', ${firm}, 'IN', 'Engagement')
    RETURNING id
  `;
  if (!l) throw new Error("letter seed failed");
  const letterId = l.id;
  const versionId = version.id;

  async function line(position: number, frequency: string, quantity: string, unit: string, discount: string, text: string) {
    const [ln] = await owner<{ id: string }[]>`
      INSERT INTO crm.engagement_letter_line
        (tenant_id, engagement_letter_id, position, service_version_id, quantity, unit_amount,
         currency, discount_percent, billing_frequency, entity_party_id, description, billing_timing)
      VALUES (${tenantId}, ${letterId}, ${position}, ${versionId}, ${quantity}, ${unit}, 'INR', ${discount},
              ${frequency}, ${client}, ${text}, 'arrears')
      RETURNING id
    `;
    if (!ln) throw new Error("line seed failed");
    return ln.id;
  }
  const books = await line(1, "monthly", "12", "25000", "10", "Bookkeeping and MIS, 12 months");
  const audit = await line(2, "quarterly", "4", "9000", "0", "Quarterly review, 4 quarters");

  await owner`
    UPDATE crm.engagement_letter
       SET status = 'signed', sent_at = now(), signed_at = now(), signed_by_name = 'A Director',
           signature_method = 'attested', signed_content_hash = ${"c".repeat(64)}
     WHERE id = ${letterId}
  `;
  async function engagement(lineId: string, firstInvoiceOn: string) {
    const [e] = await owner<{ id: string }[]>`
      INSERT INTO crm.engagement
        (tenant_id, party_id, entity_party_id, engagement_letter_id, engagement_letter_line_id,
         effective_from, status, activated_at, billing_from, first_invoice_on)
      VALUES (${tenantId}, ${client}, ${client}, ${letterId}, ${lineId}, '2026-10-01', 'active', now(),
              '2026-10-01', ${firstInvoiceOn})
      RETURNING id
    `;
    if (!e) throw new Error("engagement seed failed");
    return e.id;
  }
  monthly = await engagement(books, "2026-11-01");
  quarterly = await engagement(audit, "2027-01-01");
});

afterAll(async () => {
  await owner`
    UPDATE crm.engagement SET status = 'cancelled', billing_from = NULL, first_invoice_on = NULL
     WHERE tenant_id = ${tenantId}
  `;
  await app.end();
  await owner.end();
});

describe("what 1 November bills for a line with quantity 12 (F03)", () => {
  it("bills October at quantity x fee x (1 - discount): 2,70,000, not 22,500", async () => {
    const [report] = await sweepOn("2026-11-01T06:00:00Z").sweep();
    expect(report).toMatchObject({ tenantId, created: 1 });

    const rows = await owner<{ engagement_id: string; period_label: string; bill_on: string; amount: string }[]>`
      SELECT engagement_id, period_label, bill_on::text, amount::text
        FROM crm.billing_due WHERE tenant_id = ${tenantId} ORDER BY bill_on
    `;
    expect(rows).toEqual([
      { engagement_id: monthly, period_label: "Oct 2026", bill_on: "2026-11-01", amount: "270000.00" },
    ]);
  });

  it("bills the quarter written as quantity 4 at 4 x 9,000 = 36,000 on 1 January", async () => {
    await sweepOn("2027-01-01T06:00:00Z").sweep();
    const [row] = await owner<{ period_label: string; amount: string }[]>`
      SELECT period_label, amount::text FROM crm.billing_due
       WHERE tenant_id = ${tenantId} AND engagement_id = ${quarterly}
    `;
    expect(row).toEqual({ period_label: "Q3 FY2026-27", amount: "36000.00" });
  });
});
