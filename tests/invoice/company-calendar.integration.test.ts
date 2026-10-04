// An invoice's number is in its COMPANY's own year, and a series keeps the
// year it started with (0337). What only Postgres can show: the series row the
// issuing write creates is fixed to the company's start month and carries the
// company's latest prefix into a new year; a company that changes its year
// mid-series keeps numbering that series under its label.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/invoice/company-calendar.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresInvoiceRepository } from "../../src/infrastructure/postgres/invoice-repository";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { LedgerService } from "../../src/usecase/ledger/service";
import { InvoiceService } from "../../src/usecase/invoice/service";
import { PostgresInvoiceFirmSettings } from "../../src/infrastructure/postgres/invoice-settings";
import { PostgresFirmTimeZone } from "../../src/infrastructure/postgres/firm-timezone-repository";
import { PostgresDocumentRepository } from "../../src/infrastructure/postgres/document-repository";
import { PostgresPartyRepository } from "../../src/infrastructure/postgres/party-repository";
import { systemIds } from "../../src/platform/ids";
import { FakeClock } from "../../src/testfakes/clock";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import { FakeIssuedCopies } from "../../src/testfakes/invoice";
import { FakeStaffDirectory } from "../../src/testfakes/lead";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 4 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });
const ledger = new LedgerService({ events: new PostgresEventStore(app), ids: systemIds });
const invoices = new PostgresInvoiceRepository(app);

/** The invoice service on a clock pinned to `at`. */
function serviceAt(at: string): InvoiceService {
  return new InvoiceService({
    invoices,
    timeZones: new PostgresFirmTimeZone(app),
    firmEntities: new PostgresDocumentRepository(app),
    parties: new PostgresPartyRepository(app),
    ids: systemIds,
    clock: new FakeClock(new Date(at)),
    events: ledger,
    issuedCopies: new FakeIssuedCopies(),
    staff: new FakeStaffDirectory(),
    settings: new PostgresInvoiceFirmSettings(app),
  });
}

const stamp = Date.now().toString(36);
let tenant = "";
let client = "";

/** One of the firm's companies, registered, with its own zone and year end. */
async function company(name: string, jurisdiction: string, zone: string | null, yearEnd: string | null) {
  const [p] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenant}, 'organization', ${name}) RETURNING id
  `;
  if (!p) throw new Error("no party");
  await owner`INSERT INTO core.organization (party_id, tenant_id, legal_name) VALUES (${p.id}, ${tenant}, ${name})`;
  await owner`
    INSERT INTO core.legal_entity (party_id, tenant_id, jurisdiction, entity_type, time_zone, financial_year_end)
    VALUES (${p.id}, ${tenant}, ${jurisdiction}, 'company', ${zone}, ${yearEnd})
  `;
  await owner`INSERT INTO crm.firm_entity (tenant_id, party_id) VALUES (${tenant}, ${p.id})`;
  return p.id;
}

async function issueAt(at: string, entityPartyId: string) {
  const service = serviceAt(at);
  const draft = await service.raise(
    { tenantId: tenant, partyId: client, entityPartyId, currency: "INR", fxRate: "1" },
    SYSTEM_ACTOR,
  );
  await service.addLine({ tenantId: tenant, invoiceId: draft.id, description: "Advisory", quantity: "1", unitAmount: "1000" });
  return service.issue(tenant, draft.id, SYSTEM_ACTOR);
}

async function seriesOf(entityPartyId: string) {
  return owner<{ financial_year: number; start_month: number; prefix: string; last_number: number }[]>`
    SELECT financial_year, start_month, prefix, last_number FROM crm.invoice_series
     WHERE tenant_id = ${tenant} AND entity_party_id = ${entityPartyId} AND document_type = 'invoice'
     ORDER BY financial_year
  `;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, time_zone)
    VALUES (${`cal-inv-${stamp}`}, ${`cal-inv-${stamp}`}, 'INR', 'Asia/Kolkata') RETURNING id
  `;
  if (!t) throw new Error("no tenant");
  tenant = t.id;
  const [c] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenant}, 'organization', 'Meridian Textiles Private Limited') RETURNING id
  `;
  if (!c) throw new Error("no client");
  client = c.id;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

describe("each company numbers in its own year (0337)", () => {
  it("a calendar-year company and an April company, on 2 January 2027", async () => {
    const gulf = await company("Gulf Advisory FZE", "AE", "Asia/Dubai", "12-31");
    const india = await company("India Advisory Private Limited", "IN", null, null);
    const ae = await issueAt("2027-01-02T06:00:00Z", gulf);
    const inr = await issueAt("2027-01-02T06:00:00Z", india);
    expect(ae.number).toBe("INV/2027/0001");
    expect(inr.number).toBe("INV/2026-27/0001");
    expect((await seriesOf(gulf)).map((s) => [s.financial_year, s.start_month])).toEqual([[2027, 1]]);
    expect((await seriesOf(india)).map((s) => [s.financial_year, s.start_month])).toEqual([[2026, 4]]);
  });

  it("dates a New York company's invoice on New York's day", async () => {
    const usa = await company("USA Advisory Inc", "US", "America/New_York", "12-31");
    // 19:30 UTC on 31 October 2026: 15:30 in New York, 01:00 on 1 November in India.
    const issued = await issueAt("2026-10-31T19:30:00Z", usa);
    expect(issued.issuedOn).toBe("2026-10-31");
    expect(issued.number).toBe("INV/2026/0001");
  });
});

describe("a custom prefix carries into the next year (0337)", () => {
  it("keeps 10XIN on the first invoice of 2027-28", async () => {
    const india = await company("India Prefix Private Limited", "IN", null, "03-31");
    await issueAt("2026-10-20T06:00:00Z", india);
    await invoices.setSeriesPrefix(tenant, india, "10XIN");
    const next = await issueAt("2027-04-02T06:00:00Z", india);
    expect(next.number).toBe("10XIN/2027-28/0001");
  });
});

describe("a series keeps the year it started with (0337)", () => {
  it("goes on under its label after the company moves to a calendar year, until the new year begins", async () => {
    const india = await company("India Changes Year Private Limited", "IN", null, "03-31");
    const first = await issueAt("2026-10-20T06:00:00Z", india);
    expect(first.number).toBe("INV/2026-27/0001");
    // The company moves to a calendar year in October 2026.
    await owner`UPDATE core.legal_entity SET financial_year_end = '12-31' WHERE party_id = ${india}`;
    const second = await issueAt("2026-10-21T06:00:00Z", india);
    expect(second.number).toBe("INV/2026-27/0002");
    // From 1 January 2027 its new year's series begins.
    const third = await issueAt("2027-01-05T06:00:00Z", india);
    expect(third.number).toBe("INV/2027/0001");
    expect((await seriesOf(india)).map((s) => [s.financial_year, s.start_month, s.last_number])).toEqual([
      [2026, 4, 2],
      [2027, 1, 1],
    ]);
  });
});
