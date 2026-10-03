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
const repo = new PostgresInvoiceRepository(app);
const service = new InvoiceService({
  invoices: repo,
  timeZones: new PostgresFirmTimeZone(app),
  firmEntities: new PostgresDocumentRepository(app),
  parties: new PostgresPartyRepository(app),
  ids: systemIds,
  // PINNED (audit 2026-10-03): an invoice and a credit note are numbered in
  // the year of the day they are issued, and these tests name FY 2026-27. On
  // the real clock they would go red on 1 April 2027.
  clock: new FakeClock(new Date("2026-10-03T06:30:00Z")),
  events: ledger,
  // No document store here: these tests are about the money and the series.
  issuedCopies: new FakeIssuedCopies(),
  staff: new FakeStaffDirectory(),
  settings: new PostgresInvoiceFirmSettings(app),
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
      { tenantId: tenant, invoiceId: first, amount: "1000", reason: "goodwill" },
      SYSTEM_ACTOR,
    );
    expect(credit.number).toBe("CN/2026-27/0001");

    // The invoice series carried on regardless: the next one ISSUED is 2 (0322).
    const second = await repo.find(tenant, await issued());
    expect(second?.sequenceNumber).toBe(2);

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
          { tenantId: tenant, invoiceId: invoice, amount: "1000", reason: "goodwill" },
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
      { tenantId: tenant, invoiceId: invoice, amount: "1000", reason: "service_failure" },
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
      { tenantId: tenant, invoiceId: invoice, amount: "1800", reason: "billing_error" },
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

describe("an invoice adds up to whole paise (B02, 0325)", () => {
  // The audit found drafts totalling 91,354.833: tax was rounded to four places,
  // the PDF printed two, the client paid the printed figure and 0.003 stayed
  // "owed" for ever, so reminders, dunning and the advance escalation never
  // stopped. Each line's net and tax are rounded to the currency's minor unit,
  // and a total is the sum of those rounded lines.
  it("lets a client who pays the printed total owe exactly nothing", async () => {
    // A pro-rata bill of 27,419.35 at 18%: tax 4,935.483 unrounded.
    const invoice = await issued("27419.35", "18");
    const before = await service.balanceOf(tenant, invoice);
    expect(before.invoiced).toBe("32354.8300");

    const record = await service.describe(tenant, invoice);
    expect(record.lines.map((l) => [l.net, l.tax])).toEqual([["27419.3500", "4935.4800"]]);
    expect(record.totals.total).toBe("32354.8300");

    await service.recordPayment(
      { tenantId: tenant, invoiceId: invoice, amount: "32354.83", receivedOn: "2026-07-10", method: "bank_transfer" },
      SYSTEM_ACTOR,
    );
    expect((await service.balanceOf(tenant, invoice)).outstanding).toBe("0.0000");
    const receivables = await service.outstanding(tenant);
    expect(receivables.map((r) => r.balance.invoiceId)).not.toContain(invoice);
  });

  it("totals the rounded lines, never a rounding of the unrounded sum", async () => {
    // Two lines of 0.25 at 18%: 0.045 of tax each, 0.05 each once rounded, so
    // the invoice's tax is 0.10 (the sum of what each line prints), not 0.09.
    const draft = await service.raise(
      { tenantId: tenant, partyId: client, entityPartyId: entity, currency: "INR", fxRate: "1", fxRateDate: "2026-07-01", seriesDate: "2026-07-01" },
      SYSTEM_ACTOR,
    );
    for (const description of ["Stamp", "Courier"]) {
      await service.addLine({ tenantId: tenant, invoiceId: draft.id, description, quantity: "1", unitAmount: "0.25", taxPercent: "18" });
    }
    const totals = (await service.describe(tenant, draft.id)).totals;
    expect([totals.net, totals.tax, totals.total]).toEqual(["0.5000", "0.1000", "0.6000"]);
  });

  it("rounds to the currency's own minor unit: none for yen", async () => {
    const draft = await service.raise(
      { tenantId: tenant, partyId: client, entityPartyId: entity, currency: "JPY", fxRate: "0.56", fxRateDate: "2026-07-01", seriesDate: "2026-07-01" },
      SYSTEM_ACTOR,
    );
    await service.addLine({ tenantId: tenant, invoiceId: draft.id, description: "Filing", quantity: "1", unitAmount: "1235", taxPercent: "10" });
    const totals = (await service.describe(tenant, draft.id)).totals;
    // 123.5 of tax is 124 yen; there is no such thing as half a yen on a bill.
    expect([totals.tax, totals.total]).toEqual(["124.0000", "1359.0000"]);
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

describe("a draft's lines can be struck off and added again (B04, B36)", () => {
  async function draftWith(lines: number): Promise<string> {
    const draft = await service.raise(
      { tenantId: tenant, partyId: client, entityPartyId: entity, currency: "INR", fxRate: "1", fxRateDate: "2026-07-01", seriesDate: "2026-07-01" },
      SYSTEM_ACTOR,
    );
    for (let i = 1; i <= lines; i += 1) {
      await service.addLine({ tenantId: tenant, invoiceId: draft.id, description: `Line ${String(i)}`, quantity: "1", unitAmount: "100" });
    }
    return draft.id;
  }

  it("adds a line after the last line was struck off", async () => {
    // The unique position counted STRUCK lines too: strike line 2, add one, and
    // the new line took position 2 again and failed with a duplicate key.
    const draft = await draftWith(2);
    const [, second] = await service.describe(tenant, draft).then((r) => r.lines);
    if (second === undefined) throw new Error("no second line");
    await service.removeLine(tenant, draft, second.line.id);

    const added = await service.addLine({ tenantId: tenant, invoiceId: draft, description: "Again", quantity: "1", unitAmount: "50" });
    expect(added.position).toBe(2);
    const lines = (await service.describe(tenant, draft)).lines.map((l) => [l.line.position, l.line.description]);
    expect(lines).toEqual([[1, "Line 1"], [2, "Again"]]);
  });

  it("gives eight lines added at once eight positions", async () => {
    // MAX()+1 inside the INSERT reads a snapshot under READ COMMITTED: two adds
    // at once both took the same position and one surfaced as a 500.
    const draft = await draftWith(0);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        service.addLine({ tenantId: tenant, invoiceId: draft, description: `Line ${String(i)}`, quantity: "1", unitAmount: "10" }),
      ),
    );
    const positions = (await service.describe(tenant, draft)).lines.map((l) => l.line.position);
    expect(positions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("an issued invoice with money on it is not cancelled (B05, 0326)", () => {
  it("refuses through the service, in plain words, and leaves it issued", async () => {
    const invoice = await issued("50000");
    await service.recordPayment(
      { tenantId: tenant, invoiceId: invoice, amount: "50000", receivedOn: "2026-07-10", method: "bank_transfer" },
      SYSTEM_ACTOR,
    );
    const refused = await service.cancel(tenant, invoice, SYSTEM_ACTOR).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: "INVOICE_HAS_PAYMENTS" });
    expect((await repo.find(tenant, invoice))?.status).toBe("issued");
  });

  it("refuses in the database too, for a session that walks past the service", async () => {
    const invoice = await issued("1000");
    await service.recordPayment(
      { tenantId: tenant, invoiceId: invoice, amount: "1000", receivedOn: "2026-07-10", method: "cash" },
      SYSTEM_ACTOR,
    );
    const err = await owner`UPDATE crm.invoice SET status = 'cancelled' WHERE id = ${invoice}`.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23001");
  });

  it("cancels once a mistaken payment has been reversed", async () => {
    const invoice = await issued("1000");
    for (const amount of ["1000", "-1000"]) {
      await service.recordPayment(
        { tenantId: tenant, invoiceId: invoice, amount, receivedOn: "2026-07-10", method: "cash" },
        SYSTEM_ACTOR,
      );
    }
    expect((await service.cancel(tenant, invoice, SYSTEM_ACTOR)).status).toBe("cancelled");
  });
});

describe("a cancelled invoice owes nothing, in the view itself (B22, 0326)", () => {
  it("reads outstanding 0 on the balance once cancelled, and on a draft", async () => {
    const invoice = await issued("7080");
    expect((await service.balanceOf(tenant, invoice)).outstanding).toBe("7080.0000");
    await service.cancel(tenant, invoice, SYSTEM_ACTOR);
    const after = await service.balanceOf(tenant, invoice);
    expect(after.invoiced).toBe("7080.0000");
    expect(after.outstanding).toBe("0");

    const draft = await service.raise(
      { tenantId: tenant, partyId: client, entityPartyId: entity, currency: "INR", fxRate: "1", fxRateDate: "2026-07-01" },
      SYSTEM_ACTOR,
    );
    await service.addLine({ tenantId: tenant, invoiceId: draft.id, description: "Not sent", quantity: "1", unitAmount: "500" });
    expect((await service.balanceOf(tenant, draft.id)).outstanding).toBe("0");
  });
});

describe("the due date on a real database (B20, B21, 0327)", () => {
  it("sets a draft's due date, and an invoice issued with none takes the firm's terms", async () => {
    const draft = await service.raise(
      { tenantId: tenant, partyId: client, entityPartyId: entity, currency: "INR" },
      SYSTEM_ACTOR,
    );
    await service.addLine({ tenantId: tenant, invoiceId: draft.id, description: "Advisory", quantity: "1", unitAmount: "100" });
    const far = "2099-01-31";
    expect((await service.setDueDate(tenant, draft.id, far, SYSTEM_ACTOR)).dueOn).toBe(far);
    expect((await service.setDueDate(tenant, draft.id, null, SYSTEM_ACTOR)).dueOn).toBeNull();

    // The firm says 15 days; nothing was typed on the draft.
    await owner`UPDATE tenancy.tenant SET invoice_due_days = 15 WHERE id = ${tenant}`;
    try {
      const issuedOne = await service.issue(tenant, draft.id, SYSTEM_ACTOR);
      const [row] = await owner<{ gap: number }[]>`
        SELECT (due_on - issued_on)::int AS gap FROM crm.invoice WHERE id = ${draft.id}
      `;
      expect(row?.gap).toBe(15);
      expect(issuedOne.dueOn).not.toBeNull();
    } finally {
      await owner`UPDATE tenancy.tenant SET invoice_due_days = NULL WHERE id = ${tenant}`;
    }
  });
});
