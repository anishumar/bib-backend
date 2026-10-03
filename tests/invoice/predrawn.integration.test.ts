// B51 against Postgres (audit 2026-10-03; the user decided 2026-10-03: NEVER
// RENUMBER).
//
// Drafts made before 0322 drew their number when they were made, and keep it.
// One whose number is still in order issues as it is. One whose number would
// now go out of order (a later number of its series has been issued, or today
// is in another financial year than its series) is refused with "cancel it and
// raise it again", and nothing is written.
//
// "Out of order" is decided under the series' row lock, the same lock an
// unnumbered issue takes to draw the next number, so a later number cannot go
// out between the check and the write. The last test holds that lock in
// another transaction and watches the issue wait for it.
//
// The clock is PINNED (2 November 2026, financial year 2026-27), so nothing
// here depends on the day the suite runs.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/invoice/predrawn.integration.test.ts
import { afterAll, describe, expect, it } from "vitest";
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
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import { FakeIssuedCopies } from "../../src/testfakes/invoice";
import { FakeStaffDirectory } from "../../src/testfakes/lead";
import { FakeClock } from "../../src/testfakes/clock";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 6 });
const owner = postgres(cfg.db.ownerUrl, { max: 4 });

const clock = new FakeClock(new Date("2026-11-02T06:30:00Z"));
const service = new InvoiceService({
  invoices: new PostgresInvoiceRepository(app),
  timeZones: new PostgresFirmTimeZone(app),
  firmEntities: new PostgresDocumentRepository(app),
  parties: new PostgresPartyRepository(app),
  ids: systemIds,
  clock,
  events: new LedgerService({ events: new PostgresEventStore(app), ids: systemIds }),
  issuedCopies: new FakeIssuedCopies(),
  staff: new FakeStaffDirectory(),
  settings: new PostgresInvoiceFirmSettings(app),
});

const stamp = Date.now().toString(36);
let firms = 0;

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

interface Firm {
  readonly tenant: string;
  readonly client: string;
  readonly entity: string;
  readonly otherEntity: string;
}

/** A firm of its own per test, so every series starts empty. */
async function firm(): Promise<Firm> {
  firms += 1;
  const slug = `b51-${stamp}-${String(firms)}`;
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency) VALUES (${slug}, ${slug}, 'INR') RETURNING id
  `;
  if (!t) throw new Error("no tenant");
  const party = async (name: string) => {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO core.party (tenant_id, kind, display_name) VALUES (${t.id}, 'organization', ${name}) RETURNING id
    `;
    if (!row) throw new Error(`no party ${name}`);
    return row.id;
  };
  const client = await party("Meridian Textiles Private Limited");
  const entity = await party("10x Global Advisory Private Limited");
  const otherEntity = await party("10x Global Inc.");
  await owner`
    INSERT INTO crm.firm_entity_preference (tenant_id, client_jurisdiction, firm_entity_party_id)
    VALUES (${t.id}, '*', ${entity}), (${t.id}, 'US', ${otherEntity})
  `;
  return { tenant: t.id, client, entity, otherEntity };
}

async function lastNumber(f: Firm, entity: string, financialYear: number): Promise<number> {
  const [row] = await owner<{ last_number: number }[]>`
    SELECT last_number FROM crm.invoice_series
     WHERE tenant_id = ${f.tenant} AND entity_party_id = ${entity}
       AND financial_year = ${financialYear} AND document_type = 'invoice'
  `;
  return row?.last_number ?? 0;
}

/**
 * A draft as one made before 0322 was: the counter moved for it, and the draft
 * holds the number. Written as the owner, the way the old code path left it.
 */
async function preDrawn(f: Firm, over: { entity?: string; financialYear?: number } = {}): Promise<{ id: string; number: string }> {
  const entity = over.entity ?? f.entity;
  const fy = over.financialYear ?? 2026;
  await owner`
    INSERT INTO crm.invoice_series (tenant_id, entity_party_id, financial_year, document_type, prefix)
    VALUES (${f.tenant}, ${entity}, ${fy}, 'invoice', 'INV')
    ON CONFLICT (tenant_id, entity_party_id, financial_year, document_type) DO NOTHING
  `;
  const seq = (await lastNumber(f, entity, fy)) + 1;
  await owner`
    UPDATE crm.invoice_series SET last_number = ${seq}
     WHERE tenant_id = ${f.tenant} AND entity_party_id = ${entity} AND financial_year = ${fy}
       AND document_type = 'invoice'
  `;
  const id = systemIds.newId();
  const label = `${String(fy)}-${String((fy + 1) % 100).padStart(2, "0")}`;
  const number = `INV/${label}/${String(seq).padStart(4, "0")}`;
  await owner`
    INSERT INTO crm.invoice (id, tenant_id, party_id, entity_party_id, number, financial_year,
                             sequence_number, currency, fx_rate, fx_rate_date)
    VALUES (${id}, ${f.tenant}, ${f.client}, ${entity}, ${number}, ${fy}, ${seq}, 'INR', 1, '2026-07-01')
  `;
  await service.addLine({ tenantId: f.tenant, invoiceId: id, description: "Advisory", quantity: "1", unitAmount: "1000" });
  return { id, number };
}

/** A draft of today (unnumbered, 0322), with a line, issued: the next number. */
async function issuedNow(f: Firm, entity?: string) {
  const d = await service.raise(
    { tenantId: f.tenant, partyId: f.client, entityPartyId: entity ?? f.entity, currency: "INR", fxRate: "1", fxRateDate: "2026-11-02" },
    SYSTEM_ACTOR,
  );
  await service.addLine({ tenantId: f.tenant, invoiceId: d.id, description: "Advisory", quantity: "1", unitAmount: "1000" });
  return service.issue(f.tenant, d.id, SYSTEM_ACTOR);
}

async function row(id: string) {
  const [r] = await owner<{ status: string; number: string | null; issued_on: string | null }[]>`
    SELECT status, number, issued_on::text FROM crm.invoice WHERE id = ${id}
  `;
  return r;
}

async function issuedEvents(f: Firm, id: string): Promise<number> {
  const [r] = await owner<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ledger.event
     WHERE tenant_id = ${f.tenant} AND object_id = ${id} AND verb = 'invoice.issued'
  `;
  return r?.n ?? 0;
}

describe("a draft numbered before 0322 whose number is still in order (B51)", () => {
  it("issues as it is: its own number, and the counter does not move", async () => {
    const f = await firm();
    await issuedNow(f); // INV/2026-27/0001
    const d = await preDrawn(f); // INV/2026-27/0002, drawn and not yet issued
    const out = await service.issue(f.tenant, d.id, SYSTEM_ACTOR);
    expect(out).toMatchObject({ status: "issued", number: "INV/2026-27/0002", sequenceNumber: 2, issuedOn: "2026-11-02" });
    expect(await lastNumber(f, f.entity, 2026)).toBe(2);
    expect((await issuedNow(f)).number).toBe("INV/2026-27/0003");
  });

  it("does not count a later draft that was cancelled before it was ever issued", async () => {
    const f = await firm();
    const early = await preDrawn(f); // 0001
    const later = await preDrawn(f); // 0002, cancelled as a draft: it never went out
    await service.cancel(f.tenant, later.id, SYSTEM_ACTOR);
    expect((await service.issue(f.tenant, early.id, SYSTEM_ACTOR)).number).toBe(early.number);
  });

  it("does not count another company's series", async () => {
    const f = await firm();
    const d = await preDrawn(f); // 10x Global Advisory 0001
    await issuedNow(f, f.otherEntity); // 10x Global Inc. 0001
    await issuedNow(f, f.otherEntity); // 10x Global Inc. 0002
    expect((await service.issue(f.tenant, d.id, SYSTEM_ACTOR)).number).toBe(d.number);
  });
});

describe("a draft numbered before 0322 whose number would go out of order (B51)", () => {
  it("is refused once a later number of its series has been issued, and nothing is written", async () => {
    const f = await firm();
    const d = await preDrawn(f); // INV/2026-27/0001
    await issuedNow(f); // INV/2026-27/0002 goes out first
    const counter = await lastNumber(f, f.entity, 2026);

    const refused = await service.issue(f.tenant, d.id, SYSTEM_ACTOR).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: "INVOICE_NUMBER_OUT_OF_ORDER" });
    expect((refused as Error).message).toContain("INV/2026-27/0002");
    expect((refused as Error).message).toContain("Cancel this draft and raise it again");

    expect(await row(d.id)).toMatchObject({ status: "draft", number: d.number, issued_on: null });
    expect(await lastNumber(f, f.entity, 2026)).toBe(counter);
    expect(await issuedEvents(f, d.id)).toBe(0);
  });

  it("counts a later number that was issued and then cancelled: it went out", async () => {
    const f = await firm();
    const d = await preDrawn(f); // 0001
    const later = await issuedNow(f); // 0002, issued
    await service.cancel(f.tenant, later.id, SYSTEM_ACTOR);
    await expect(service.issue(f.tenant, d.id, SYSTEM_ACTOR)).rejects.toMatchObject({
      code: "INVOICE_NUMBER_OUT_OF_ORDER",
    });
  });

  it("is refused when today is in another financial year than its series", async () => {
    const f = await firm();
    const d = await preDrawn(f, { financialYear: 2025 }); // INV/2025-26/0001, issued in 2026-27
    const refused = await service.issue(f.tenant, d.id, SYSTEM_ACTOR).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: "INVOICE_NUMBER_OUT_OF_ORDER" });
    expect((refused as Error).message).toContain("2026-27");
    expect(await row(d.id)).toMatchObject({ status: "draft", number: d.number });
  });

  it("can be cancelled, keeping its number in the series, and raised again: the new draft is numbered at issue", async () => {
    const f = await firm();
    const d = await preDrawn(f); // 0001
    await issuedNow(f); // 0002
    const cancelled = await service.cancel(f.tenant, d.id, SYSTEM_ACTOR);
    expect(cancelled).toMatchObject({ status: "cancelled", number: d.number });
    expect((await issuedNow(f)).number).toBe("INV/2026-27/0003");
  });

  it("is said on the invoice read before anyone presses Issue, with the refusal's own words", async () => {
    const f = await firm();
    const d = await preDrawn(f);
    expect((await service.describe(f.tenant, d.id)).issueBlocked).toBeNull();
    await issuedNow(f);
    const blocked = (await service.describe(f.tenant, d.id)).issueBlocked;
    expect(blocked?.reason).toBe("INVOICE_NUMBER_OUT_OF_ORDER");
    const refused = await service.issue(f.tenant, d.id, SYSTEM_ACTOR).catch((e: unknown) => e);
    expect(blocked?.message).toBe((refused as Error).message);
  });

  it("decides under the series' lock: an issue of a later number in flight is waited for, then counted", async () => {
    // Another transaction holds the series row (as an unnumbered issue does
    // while it draws the next number) and issues 0002. The pre-0322 draft's
    // issue must WAIT for it and then see 0002. Without the lock it would read
    // the series before 0002 committed and go out after it, out of order.
    const f = await firm();
    const d = await preDrawn(f); // 0001
    let pending: Promise<unknown> | undefined;
    let settledEarly = false;
    await owner.begin(async (tx) => {
      await tx`
        SELECT 1 FROM crm.invoice_series
         WHERE tenant_id = ${f.tenant} AND entity_party_id = ${f.entity} AND financial_year = 2026
           AND document_type = 'invoice'
        FOR UPDATE
      `;
      // Only the lock and the issued row: the counter row is left unwritten, so
      // nothing but the series lock can make the issue below wait.
      await tx`
        INSERT INTO crm.invoice (id, tenant_id, party_id, entity_party_id, number, financial_year,
                                 sequence_number, status, issued_on, currency, fx_rate, fx_rate_date)
        VALUES (${systemIds.newId()}, ${f.tenant}, ${f.client}, ${f.entity}, 'INV/2026-27/0002', 2026,
                2, 'issued', '2026-11-02', 'INR', 1, '2026-11-02')
      `;
      pending = service.issue(f.tenant, d.id, SYSTEM_ACTOR).then(
        (v) => {
          settledEarly = true;
          return v;
        },
        (e: unknown) => {
          settledEarly = true;
          return e;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      // Still waiting on the lock while the other issue is uncommitted.
      expect(settledEarly).toBe(false);
    });
    const outcome = await pending;
    expect(outcome).toMatchObject({ code: "INVOICE_NUMBER_OUT_OF_ORDER" });
    expect(await row(d.id)).toMatchObject({ status: "draft" });
  });
});
