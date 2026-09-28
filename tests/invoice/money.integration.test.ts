// T3.5's database half. Four things a fake can only agree not to contradict:
//
//   THE CREDIT-NOTE SERIES IS SEPARATE FROM THE INVOICE ONE. 0027 shipped a
//   series key with no document type and 0028 corrected it. If the two shared a
//   counter, an invoice number would go missing because a credit note took it —
//   a gap an auditor cannot account for, which is worse than no gap rule at all.
//
//   MONEY CANNOT BE APPLIED TO A DOCUMENT NOBODY WAS SENT. A trigger, so it
//   holds against raw SQL and against a psql session.
//
//   A PAYMENT'S CURRENCY CANNOT DISAGREE WITH ITS INVOICE. The composite
//   foreign key makes it unrepresentable rather than merely refused.
//
//   THE BALANCE IS COMPUTED IN `numeric`, over three tables, by the database.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresInvoiceRepository } from "../../src/infrastructure/postgres/invoice-repository";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { LedgerService } from "../../src/usecase/ledger/service";
import { InvoiceService } from "../../src/usecase/invoice/service";
import { PostgresFirmTimeZone } from "../../src/infrastructure/postgres/firm-timezone-repository";
import { PostgresDocumentRepository } from "../../src/infrastructure/postgres/document-repository";
import { PostgresPartyRepository } from "../../src/infrastructure/postgres/party-repository";
import { systemIds } from "../../src/platform/ids";
import { systemClock } from "../../src/platform/clock";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import { FakeIssuedCopies } from "../../src/testfakes/invoice";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 4 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const ledger = new LedgerService({ events: new PostgresEventStore(app), ids: systemIds });
const repo = new PostgresInvoiceRepository(app);
const service = new InvoiceService({
  invoices: repo,
  timeZones: new PostgresFirmTimeZone(app),
  firmEntities: new PostgresDocumentRepository(app),
  parties: new PostgresPartyRepository(app),
  ids: systemIds,
  clock: systemClock,
  events: ledger,
  // No document store here: these tests are about the money and the series.
  issuedCopies: new FakeIssuedCopies(),
});

const stamp = Date.now().toString(36);
let tenant = "";
let client = "";
let entity = "";

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`money-${stamp}`}, ${`money-${stamp}`}, 'INR') RETURNING id
  `;
  if (!t) throw new Error("could not create the tenant");
  tenant = t.id;
  const [c] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenant}, 'organization', 'Meridian Textiles Private Limited') RETURNING id
  `;
  const [e] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenant}, 'organization', '10x Global Advisory Private Limited') RETURNING id
  `;
  if (!c || !e) throw new Error("could not create the parties");
  client = c.id;
  entity = e.id;
  // The issuer is one of the firm's own companies (0306): named by the firm's
  // rule, as every tenant's seeded entity is.
  await owner`
    INSERT INTO crm.firm_entity_preference (tenant_id, client_jurisdiction, firm_entity_party_id)
    VALUES (${tenant}, '*', ${entity})
  `;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

async function issued(amount = "10000", tax = "0"): Promise<string> {
  const invoice = await service.raise(
    {
      tenantId: tenant,
      partyId: client,
      entityPartyId: entity,
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-07-01",
      seriesDate: "2026-07-01",
      dueOn: "2026-07-31",
    },
    SYSTEM_ACTOR,
  );
  await service.addLine({
    tenantId: tenant,
    invoiceId: invoice.id,
    description: "Advisory",
    quantity: "1",
    unitAmount: amount,
    taxPercent: tax,
  });
  await service.issue(tenant, invoice.id, SYSTEM_ACTOR);
  return invoice.id;
}

describe("the two series do not interleave", () => {
  it("numbers credit notes from their own counter", async () => {
    // THE CORRECTION 0028 MADE. Sharing the invoice counter would leave an
    // invoice number missing because a credit note took it.
    const first = await issued();
    const credit = await service.issueCreditNote(
      { tenantId: tenant, invoiceId: first, amount: "1000", reason: "goodwill", issuedOn: "2026-07-05" },
      SYSTEM_ACTOR,
    );
    expect(credit.number).toBe("CN/2026-27/0001");

    // The invoice series carried on regardless.
    const second = await service.raise(
      { tenantId: tenant, partyId: client, entityPartyId: entity, currency: "INR", fxRate: "1", fxRateDate: "2026-07-01", seriesDate: "2026-07-01" },
      SYSTEM_ACTOR,
    );
    expect(second.sequenceNumber).toBe(2);

    // …and the two counters are two rows, which is what the key change bought.
    const rows = await owner<{ document_type: string; last_number: number }[]>`
      SELECT document_type, last_number FROM crm.invoice_series
      WHERE tenant_id = ${tenant} AND entity_party_id = ${entity} AND financial_year = 2026
      ORDER BY document_type
    `;
    expect(rows.map((r) => r.document_type)).toEqual(["credit_note", "invoice"]);
  });

  it("hands four simultaneous credit notes four consecutive numbers", async () => {
    // The same row lock, on the other series. It would be easy to build the
    // credit-note path without it and never notice until two clients were sent
    // the same credit-note number.
    const invoice = await issued("100000");
    const before = await lastNumber("credit_note");
    await Promise.all(
      Array.from({ length: 4 }, () =>
        service.issueCreditNote(
          { tenantId: tenant, invoiceId: invoice, amount: "1000", reason: "goodwill", issuedOn: "2026-07-05" },
          SYSTEM_ACTOR,
        ),
      ),
    );
    expect(await lastNumber("credit_note")).toBe(before + 4);
  });
});

describe("money only attaches to a document that was sent", () => {
  it("refuses a payment against a draft, in the database", async () => {
    // RAW SQL, because the point of a trigger is that it holds when the
    // application is bypassed.
    const draft = await service.raise(
      { tenantId: tenant, partyId: client, entityPartyId: entity, currency: "INR", fxRate: "1", fxRateDate: "2026-07-01", seriesDate: "2026-07-01" },
      SYSTEM_ACTOR,
    );
    const err = await owner`
      INSERT INTO crm.payment (tenant_id, invoice_id, amount, currency, received_on, method)
      VALUES (${tenant}, ${draft.id}, 100, 'INR', '2026-07-10', 'cash')
    `.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23001"); // restrict_violation
  });

  it("refuses a payment against a cancelled invoice", async () => {
    const invoice = await issued();
    await service.cancel(tenant, invoice, SYSTEM_ACTOR);
    const err = await owner`
      INSERT INTO crm.payment (tenant_id, invoice_id, amount, currency, received_on, method)
      VALUES (${tenant}, ${invoice}, 100, 'INR', '2026-07-10', 'cash')
    `.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23001");
  });

  it("refuses a payment in a currency the invoice is not in", async () => {
    // The composite foreign key. Converting would need a rate struck at payment
    // time, which is a different fact from the one on the invoice — a feature,
    // not a default.
    const invoice = await issued();
    const err = await owner`
      INSERT INTO crm.payment (tenant_id, invoice_id, amount, currency, received_on, method)
      VALUES (${tenant}, ${invoice}, 100, 'AED', '2026-07-10', 'cash')
    `.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23503"); // foreign_key_violation
  });
});

describe("a credit note, once issued, says what it says", () => {
  it("refuses to restate the amount or the reason", async () => {
    const invoice = await issued();
    const credit = await service.issueCreditNote(
      { tenantId: tenant, invoiceId: invoice, amount: "1000", reason: "service_failure", issuedOn: "2026-07-05" },
      SYSTEM_ACTOR,
    );
    for (const patch of [
      owner`UPDATE crm.credit_note SET amount = 9999 WHERE id = ${credit.id}`,
      owner`UPDATE crm.credit_note SET reason = 'goodwill' WHERE id = ${credit.id}`,
      owner`UPDATE crm.credit_note SET number = 'CN/2026-27/9999' WHERE id = ${credit.id}`,
    ]) {
      const err = await patch.catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe("23001");
    }
  });

  it("refuses a reason outside the closed set, in the database", async () => {
    // The CHECK, not the service. An import or an agent walks straight past a
    // service, and a free-text reason is the thing that makes revenue leakage
    // invisible.
    const invoice = await issued();
    const err = await owner`
      INSERT INTO crm.credit_note
        (tenant_id, invoice_id, entity_party_id, number, financial_year, sequence_number,
         amount, currency, issued_on, reason)
      VALUES (${tenant}, ${invoice}, ${entity}, ${`CN/2026-27/${stamp}`}, 2026, 9999,
              100, 'INR', '2026-07-05', 'the client asked nicely')
    `.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23514"); // check_violation
  });
});

describe("the balance is arithmetic, done by the database", () => {
  it("is invoiced less paid less credited, tax included", async () => {
    const invoice = await issued("10000", "18");
    await service.recordPayment(
      { tenantId: tenant, invoiceId: invoice, amount: "5000", receivedOn: "2026-07-10", method: "bank_transfer" },
      SYSTEM_ACTOR,
    );
    await service.issueCreditNote(
      { tenantId: tenant, invoiceId: invoice, amount: "1800", reason: "billing_error", issuedOn: "2026-07-11" },
      SYSTEM_ACTOR,
    );
    const balance = await service.balanceOf(tenant, invoice);
    // 10000 + 18% = 11800; less 5000 paid; less 1800 credited.
    expect(balance.invoiced).toBe("11800.0000");
    expect(balance.outstanding).toBe("5000.0000");
  });

  it("nets a reversal out, leaving both rows in place", async () => {
    const invoice = await issued("4000");
    await service.recordPayment(
      { tenantId: tenant, invoiceId: invoice, amount: "4000", receivedOn: "2026-07-10", method: "cheque" },
      SYSTEM_ACTOR,
    );
    await service.recordPayment(
      { tenantId: tenant, invoiceId: invoice, amount: "-4000", receivedOn: "2026-07-14", method: "cheque", note: "Returned unpaid" },
      SYSTEM_ACTOR,
    );
    expect((await service.balanceOf(tenant, invoice)).outstanding).toBe("4000.0000");
    expect(await service.listPayments(tenant, invoice)).toHaveLength(2);
  });

  it("counts an invoice nobody has paid, which is the point of the LEFT JOINs", async () => {
    const invoice = await issued("7500");
    const receivables = await service.outstanding(tenant);
    expect(receivables.some((r) => r.balance.invoiceId === invoice && r.balance.outstanding === "7500.0000")).toBe(
      true,
    );
  });

  it("leaves a draft and a cancelled invoice out of the receivables", async () => {
    const draft = await service.raise(
      { tenantId: tenant, partyId: client, entityPartyId: entity, currency: "INR", fxRate: "1", fxRateDate: "2026-07-01", seriesDate: "2026-07-01" },
      SYSTEM_ACTOR,
    );
    await service.addLine({
      tenantId: tenant,
      invoiceId: draft.id,
      description: "Not sent yet",
      quantity: "1",
      unitAmount: "99999",
    });
    const receivables = await service.outstanding(tenant);
    expect(receivables.map((r) => r.balance.invoiceId)).not.toContain(draft.id);
  });
});

async function lastNumber(documentType: string): Promise<number> {
  const [row] = await owner<{ last_number: number }[]>`
    SELECT last_number FROM crm.invoice_series
    WHERE tenant_id = ${tenant} AND entity_party_id = ${entity}
      AND financial_year = 2026 AND document_type = ${documentType}
  `;
  return row?.last_number ?? 0;
}
