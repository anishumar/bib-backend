// T3.4's acceptance, and the only place it can honestly be proven:
//
//   "numbers cannot be edited; A GAP IS IMPOSSIBLE UNDER CONCURRENCY."
//
// Both halves are properties of Postgres, not of TypeScript. The freeze is a
// trigger, so it holds against raw SQL and against a psql session — which is
// the whole reason it is a trigger. And gaplessness is a row lock: what makes
// it true is that a SECOND writer BLOCKS until the first transaction ends, and
// that a ROLLBACK returns the number because the counter never moved. A fake
// cannot have either property; it can only be written so as not to contradict
// them, which is a different and much weaker thing.
//
// SINCE 0322 THE NUMBER IS DRAWN WHEN THE INVOICE IS ISSUED, not when the draft
// is made: a draft (the advance at signing is drafted by the system) that is
// cancelled spends nothing. Everything below about the series is therefore
// about ISSUES.
//
// The contrast this file exists to draw is with
// tests/document/reference.integration.test.ts, which proves the OPPOSITE for
// proposal and letter references: those BURN a number on failure, deliberately,
// because a gap in a document reference is honest and a gap in a tax invoice
// series is something an auditor may read as a suppressed sale.
//
// Run with:  npm run test:integration   (needs a migrated local database)
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
import { systemClock } from "../../src/platform/clock";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import { financialYearOf } from "../../src/domain/invoice/model";
import { FakeIssuedCopies } from "../../src/testfakes/invoice";
import { FakeStaffDirectory } from "../../src/testfakes/lead";

const cfg = load();
// Wide enough that six simultaneous issues are genuinely simultaneous. A
// narrow pool would serialise them at the CONNECTION, and the concurrency test
// would pass without ever exercising the lock it exists to prove.
const app = postgres(cfg.db.appUrl, { max: 12 });
const owner = postgres(cfg.db.ownerUrl, { max: 4 });

const ledger = new LedgerService({ events: new PostgresEventStore(app), ids: systemIds });
const invoices = new PostgresInvoiceRepository(app);
const service = new InvoiceService({
  invoices,
  timeZones: new PostgresFirmTimeZone(app),
  firmEntities: new PostgresDocumentRepository(app),
  parties: new PostgresPartyRepository(app),
  ids: systemIds,
  clock: systemClock,
  events: ledger,
  // No document store here: these tests are about the money and the series.
  issuedCopies: new FakeIssuedCopies(),
  staff: new FakeStaffDirectory(),
  settings: new PostgresInvoiceFirmSettings(app),
});

const stamp = Date.now().toString(36);

let tenant = "";
let rival = "";
let client = "";
let entity = "";
let secondEntity = "";
let rivalEntity = "";
let rivalClient = "";

async function makeTenant(slug: string): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${slug}, ${slug}, 'INR') RETURNING id
  `;
  if (!row) throw new Error(`could not create the tenant ${slug}`);
  return row.id;
}

async function makeParty(tenantId: string, name: string): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenantId}, 'organization', ${name}) RETURNING id
  `;
  if (!row) throw new Error(`could not create the party ${name}`);
  return row.id;
}

beforeAll(async () => {
  tenant = await makeTenant(`inv-${stamp}`);
  rival = await makeTenant(`inv-rival-${stamp}`);
  client = await makeParty(tenant, "Meridian Textiles Private Limited");
  entity = await makeParty(tenant, "10x Global Advisory Private Limited");
  secondEntity = await makeParty(tenant, "10x Global Inc.");
  rivalClient = await makeParty(rival, "Somebody Else Ltd");
  rivalEntity = await makeParty(rival, "Their Firm LLP");
  // Each issuer is one of its firm's own companies (0306): the firm's rule
  // names it for a country, as a firm with two companies does.
  await owner`
    INSERT INTO crm.firm_entity_preference (tenant_id, client_jurisdiction, firm_entity_party_id)
    VALUES (${tenant}, '*', ${entity}), (${tenant}, 'US', ${secondEntity}),
           (${rival}, '*', ${rivalEntity})
  `;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

function draft(over: Record<string, unknown> = {}) {
  return {
    tenantId: tenant,
    partyId: client,
    entityPartyId: entity,
    currency: "INR",
    fxRate: "1",
    fxRateDate: "2026-07-01",
    seriesDate: "2026-07-01",
    ...over,
  };
}

/** A draft with one line, ready to issue. */
async function drafted(over: Record<string, unknown> = {}) {
  const invoice = await service.raise(draft(over), SYSTEM_ACTOR);
  await service.addLine({
    tenantId: tenant,
    invoiceId: invoice.id,
    description: "Advisory",
    quantity: "1",
    unitAmount: "1000",
  });
  return invoice;
}

/** A draft with a line, issued: since 0322 the number is drawn HERE. */
async function issued(over: Record<string, unknown> = {}) {
  const invoice = await drafted(over);
  return service.issue(tenant, invoice.id, SYSTEM_ACTOR);
}

describe("the series is consecutive", () => {
  it("counts up one at a time", async () => {
    const raised = [];
    for (let n = 0; n < 3; n += 1) raised.push(await issued());
    expect(raised.map((i) => i.sequenceNumber)).toEqual([1, 2, 3]);
    expect(raised[0]?.number).toBe("INV/2026-27/0001");
  });

  it("gives each of the firm's entities its own count", async () => {
    const other = await issued({ entityPartyId: secondEntity });
    expect(other.sequenceNumber).toBe(1);
    // …and both entities' first invoices carry the SAME number, which is
    // correct and is why UNIQUE is (tenant, entity, number).
    expect(other.number).toBe("INV/2026-27/0001");
  });

  it("starts a new count in a new financial year, the year the invoice is ISSUED in (B03)", async () => {
    // A draft made on 28 March 2027 (FY 2026-27) and issued on 3 April 2027:
    // the number and its year are drawn together, at issue, in the same write.
    // It used to keep the draft's year and go out as INV/2026-27/… dated in
    // FY 2027-28. The trigger admits the move only in the issuing write.
    const d = await drafted({ seriesDate: "2027-03-28" });
    expect(d.financialYear).toBe(2026);
    const next = await invoices.issue(tenant, d.id, {
      issuedOn: "2027-04-03",
      financialYear: 2027,
      fiscalYearStartMonth: 4,
      dueOnIfUnset: null,
    });
    expect(next).toMatchObject({ issued: { financialYear: 2027, issuedOn: "2027-04-03", number: "INV/2027-28/0001" } });
  });
});

describe("THE NUMBER IS DRAWN AT ISSUE (0322)", () => {
  it("leaves a draft unnumbered, and counts nothing for it", async () => {
    const before = await lastNumber(entity, 2026);
    const d = await service.raise(draft(), SYSTEM_ACTOR);
    expect(d.number).toBeNull();
    expect(d.sequenceNumber).toBeNull();
    expect(d.financialYear).toBe(2026);
    expect(await lastNumber(entity, 2026)).toBe(before);
  });

  it("spends nothing when a draft is cancelled: the next issue takes the next number", async () => {
    const before = await lastNumber(entity, 2026);
    const withdrawn = await service.raise(draft(), SYSTEM_ACTOR);
    const cancelled = await service.cancel(tenant, withdrawn.id, SYSTEM_ACTOR);
    expect(cancelled.number).toBeNull();
    const next = await issued();
    expect(next.sequenceNumber).toBe(before + 1);
  });

  it("numbers in the order invoices are ISSUED, not the order they were drafted", async () => {
    const first = await drafted();
    const second = await issued();
    const firstIssued = await service.issue(tenant, first.id, SYSTEM_ACTOR);
    expect(firstIssued.sequenceNumber).toBe((second.sequenceNumber ?? 0) + 1);
  });

  it("keeps the number a draft made before 0322 already drew, and counts nothing more", async () => {
    // A draft from before 0322 holds a number: the counter moved for it then.
    const seq = (await lastNumber(entity, 2026)) + 1;
    const id = systemIds.newId();
    await owner`
      UPDATE crm.invoice_series SET last_number = ${seq}
       WHERE tenant_id = ${tenant} AND entity_party_id = ${entity} AND financial_year = 2026
         AND document_type = 'invoice'
    `;
    await owner`
      INSERT INTO crm.invoice (id, tenant_id, party_id, entity_party_id, number, financial_year,
                               sequence_number, currency, fx_rate, fx_rate_date)
      VALUES (${id}, ${tenant}, ${client}, ${entity}, ${`INV/2026-27/${String(seq).padStart(4, "0")}`},
              2026, ${seq}, 'INR', 1, '2026-07-01')
    `;
    await service.addLine({ tenantId: tenant, invoiceId: id, description: "Advisory", quantity: "1", unitAmount: "1" });
    const out = await service.issue(tenant, id, SYSTEM_ACTOR);
    expect(out.sequenceNumber).toBe(seq);
    expect(await lastNumber(entity, 2026)).toBe(seq);
  });

  it("refuses an issued invoice with no number, and a number put on a draft without issuing it", async () => {
    const d = await service.raise(draft(), SYSTEM_ACTOR);
    const unnumbered = await owner`
      UPDATE crm.invoice SET status = 'issued', issued_on = '2026-07-02' WHERE id = ${d.id}
    `.catch((e: unknown) => e);
    expect((unnumbered as { code?: string }).code).toBe("23514"); // invoice_issued_is_numbered_chk
    const sneaked = await owner`
      UPDATE crm.invoice SET number = 'INV/2026-27/9998', sequence_number = 9998 WHERE id = ${d.id}
    `.catch((e: unknown) => e);
    expect((sneaked as { code?: string }).code).toBe("23001"); // the freeze
  });
});

describe("A GAP IS IMPOSSIBLE — the acceptance", () => {
  it("returns the number when the transaction that took it rolls back", async () => {
    // THE PROPERTY A SEQUENCE CANNOT HAVE. `nextval` survives rollback by
    // design, which is exactly what makes it wrong here. This drives the
    // adapter's own SQL inside a transaction that then aborts, and asserts the
    // counter is where it was.
    const before = await lastNumber(entity, 2026);

    const failed = await app
      .begin(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${tenant}, true)`;
        await tx`
          INSERT INTO crm.invoice_series
            (tenant_id, entity_party_id, financial_year, document_type, prefix)
          VALUES (${tenant}, ${entity}, 2026, 'invoice', 'INV')
          ON CONFLICT (tenant_id, entity_party_id, financial_year, document_type) DO NOTHING
        `;
        const [row] = await tx<{ last_number: number }[]>`
          SELECT last_number FROM crm.invoice_series
          WHERE tenant_id = ${tenant} AND entity_party_id = ${entity} AND financial_year = 2026
            AND document_type = 'invoice'
          FOR UPDATE
        `;
        await tx`
          UPDATE crm.invoice_series SET last_number = ${(row?.last_number ?? 0) + 1}
          WHERE tenant_id = ${tenant} AND entity_party_id = ${entity} AND financial_year = 2026
            AND document_type = 'invoice'
        `;
        // The issue fails — a validation, a constraint, a crash. What happens
        // to the number it had already taken is the whole question.
        throw new Error("the invoice write failed");
      })
      .catch((e: unknown) => e);
    expect((failed as Error).message).toBe("the invoice write failed");

    expect(await lastNumber(entity, 2026)).toBe(before);
    // And the NEXT real invoice takes the number the failed one was holding —
    // no gap, which a sequence would have left.
    const next = await issued();
    expect(next.sequenceNumber).toBe(before + 1);
  });

  it("hands six simultaneous issues six consecutive numbers", async () => {
    // The lock, doing its job. Without `FOR UPDATE` these six would read the
    // same `last_number` and collide on the UNIQUE constraint — which would
    // fail loudly rather than silently duplicating, but would still be five
    // lost invoices.
    const drafts = [];
    for (let n = 0; n < 6; n += 1) drafts.push(await drafted());
    const before = await lastNumber(entity, 2026);
    const raised = await Promise.all(drafts.map((d) => service.issue(tenant, d.id, SYSTEM_ACTOR)));
    const sequences = raised.map((i) => i.sequenceNumber ?? 0).sort((a, b) => a - b);
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6].map((n) => before + n));
    // Stated as the acceptance states it: no gaps, and no repeats.
    expect(new Set(raised.map((i) => i.number)).size).toBe(6);
  });

  it("issues a draft once when two people press Issue together", async () => {
    const d = await drafted();
    const before = await lastNumber(entity, 2026);
    const both = await Promise.allSettled([
      service.issue(tenant, d.id, SYSTEM_ACTOR),
      service.issue(tenant, d.id, SYSTEM_ACTOR),
    ]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await lastNumber(entity, 2026)).toBe(before + 1);
  });

  it("cancels an ISSUED invoice, and it keeps the date it went out with", async () => {
    // THE BUG 0029 FIXED, and the reason it escaped: every cancellation test in
    // this file cancelled a DRAFT, which is the one state where 0027's
    // `(status = 'issued') = (issued_on IS NOT NULL)` happens to hold. On an
    // issued invoice the status moves to `cancelled` while `issued_on` stays
    // set — correctly, because the document WAS issued and a copy is with the
    // client — and the equality failed with 23514.
    const out = await issued();
    expect(out.issuedOn).not.toBeNull();

    const cancelled = await service.cancel(tenant, out.id, SYSTEM_ACTOR);
    expect(cancelled.status).toBe("cancelled");
    // The date SURVIVES. "It was never issued" and "it was issued and then
    // withdrawn" are different facts, and only the second is true here.
    expect(cancelled.issuedOn).toBe(out.issuedOn);
    // …and so does its number.
    expect(cancelled.number).toBe(out.number);
  });

  it("leaves no hole when an issued invoice is cancelled", async () => {
    // Cancelling does NOT release the number. The row stays in the sequence
    // saying it was cancelled, which is exactly what an auditor needs in order
    // to see where a number went.
    const cancelled = await issued();
    await service.cancel(tenant, cancelled.id, SYSTEM_ACTOR);
    const next = await issued();
    expect(next.sequenceNumber).toBe((cancelled.sequenceNumber ?? 0) + 1);

    const rows = await owner<{ sequence_number: number }[]>`
      SELECT sequence_number FROM crm.invoice
      WHERE tenant_id = ${tenant} AND entity_party_id = ${entity} AND financial_year = 2026
        AND sequence_number IS NOT NULL
      ORDER BY sequence_number
    `;
    // The real assertion: the stored sequence numbers are 1..N with nothing
    // missing, whatever happened along the way.
    expect(rows.map((r) => r.sequence_number)).toEqual(
      Array.from({ length: rows.length }, (_, n) => n + 1),
    );
  });
});

describe("A NUMBER CANNOT BE EDITED — the other half of the acceptance", () => {
  it("refuses to renumber an invoice, even as the owner", async () => {
    // RAW SQL as the OWNER role, because the point of a trigger is that it
    // holds when the application is bypassed. A service check would be silent
    // here, and "why is invoice 41 now numbered 43" is a question an auditor
    // asks.
    const invoice = await issued();
    const err = await owner`
      UPDATE crm.invoice SET number = 'INV/2026-27/9999' WHERE id = ${invoice.id}
    `.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23001"); // restrict_violation
  });

  it("refuses to move an invoice into another series", async () => {
    const invoice = await issued();
    for (const patch of [
      owner`UPDATE crm.invoice SET sequence_number = 1 WHERE id = ${invoice.id}`,
      owner`UPDATE crm.invoice SET financial_year = 2025 WHERE id = ${invoice.id}`,
      owner`UPDATE crm.invoice SET entity_party_id = ${secondEntity} WHERE id = ${invoice.id}`,
    ]) {
      const err = await patch.catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe("23001");
    }
    // A draft cannot move series either: the year it will be numbered in was
    // chosen when it was made.
    const d = await service.raise(draft(), SYSTEM_ACTOR);
    const moved = await owner`UPDATE crm.invoice SET financial_year = 2025 WHERE id = ${d.id}`.catch(
      (e: unknown) => e,
    );
    expect((moved as { code?: string }).code).toBe("23001");
  });

  it("refuses to restate what an ISSUED invoice says the client owes", async () => {
    const invoice = await issued();

    const rate = await owner`
      UPDATE crm.invoice SET fx_rate = 2 WHERE id = ${invoice.id}
    `.catch((e: unknown) => e);
    expect((rate as { code?: string }).code).toBe("23001");

    // …and its lines are fixed too. A tax authority holds a copy.
    const line = await owner`
      UPDATE crm.invoice_line SET unit_amount = 5000 WHERE invoice_id = ${invoice.id}
    `.catch((e: unknown) => e);
    expect((line as { code?: string }).code).toBe("23001");
  });

  it("refuses to replace the registry's own identifier", async () => {
    const invoice = await service.raise(draft(), SYSTEM_ACTOR);
    await service.registerIrn(tenant, invoice.id, `IRN-${stamp}`, SYSTEM_ACTOR);
    const err = await owner`
      UPDATE crm.invoice SET irn = 'IRN-SOMETHING-ELSE' WHERE id = ${invoice.id}
    `.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23001");
  });
});

describe("the two copies of the financial-year rule agree", () => {
  // `crm.financial_year_of(date)` and `financialYearOf()` are the same rule
  // written twice — a CHECK cannot call TypeScript, and the application
  // composes the number before it writes the row. Two copies of a rule is
  // exactly how a boundary case ends up answered differently on the two sides,
  // so the boundary is asked of both.
  it.each(["2026-03-31", "2026-04-01", "2026-12-31", "2027-01-01"])("%s", async (date) => {
    const [row] = await owner<{ fy: number }[]>`
      SELECT crm.financial_year_of(${date}::date) AS fy
    `;
    expect(row?.fy).toBe(financialYearOf(date));
  });
});

describe("the tenant wall", () => {
  it("keeps one firm's invoices out of another's", async () => {
    const mine = await service.raise(draft(), SYSTEM_ACTOR);
    expect(await service.list(rival, {})).toEqual([]);
    expect(await invoices.find(rival, mine.id)).toBeNull();
  });

  it("refuses an invoice billed to another firm's party", async () => {
    // The composite foreign key. RLS hides the row both ways already; this is
    // the wall making the crossed row UNREPRESENTABLE rather than invisible.
    const err = await service
      .raise(draft({ partyId: rivalClient }), SYSTEM_ACTOR)
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23503"); // foreign_key_violation
  });

  it("refuses an invoice issued by another firm's entity", async () => {
    // Refused by NAME first (F-10-1): RLS hides the rival's company, so it is
    // not one of this firm's own and the service says so.
    const err = await service
      .raise(draft({ entityPartyId: rivalEntity }), SYSTEM_ACTOR)
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("ISSUER_NOT_A_FIRM_ENTITY");

    // And the write underneath is unrepresentable on its own. 0306's trigger
    // speaks before the composite key gets to: it is not this firm's company.
    const wall = await invoices
      .create({
        id: systemIds.newId(),
        tenantId: tenant,
        partyId: client,
        entityPartyId: rivalEntity,
        currency: "INR",
        fxRate: "1",
        fxRateDate: "2026-07-01",
        dueOn: null,
        notes: null,
        financialYear: 2026,
      })
      .catch((e: unknown) => e);
    expect((wall as { code?: string }).code).toBe("23514"); // check_violation
  });
});

/** The counter as it actually stands, read as the owner so RLS cannot be what
 *  makes an assertion pass. */
async function lastNumber(entityPartyId: string, financialYear: number): Promise<number> {
  const [row] = await owner<{ last_number: number }[]>`
    SELECT last_number FROM crm.invoice_series
    WHERE tenant_id = ${tenant} AND entity_party_id = ${entityPartyId}
      AND financial_year = ${financialYear} AND document_type = 'invoice'
  `;
  return row?.last_number ?? 0;
}
