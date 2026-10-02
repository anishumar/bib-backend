// T3.5 — payments, credit notes, and the balance that is a SUM.
//
// The idea this file exists to protect: THERE IS NO `paid` FLAG AND NO
// `amount_paid` COLUMN. Both are caches of an addition, and both drift the
// first time a payment is corrected — leaving an invoice that says "paid"
// beside arithmetic that says otherwise, where only one of the two is evidence.
// `crm.invoice_balance` computes it from the rows that exist.
import { describe, expect, it } from "vitest";
import { InvoiceService } from "../../src/usecase/invoice/service";
import { makeInvoiceFakes } from "../../src/testfakes/invoice";
import {
  CreditExceedsInvoice,
  InvalidCreditReason,
  InvalidInvoiceAmount,
  InvalidPaymentMethod,
  InvoiceNotIssued,
} from "../../src/domain/invoice/errors";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const CLIENT = "00000000-0000-0000-0000-0000000000bb";
const ENTITY = "00000000-0000-0000-0000-0000000000f1";
const ACTOR = { type: "human" as const, id: "00000000-0000-0000-0000-0000000000cc" };

function setup(): { service: InvoiceService } & ReturnType<typeof makeInvoiceFakes> {
  const fakes = makeInvoiceFakes();
  fakes.firmEntities.add(ENTITY);
  return { ...fakes, service: new InvoiceService(fakes) };
}

/** An issued invoice for 10,000 with no tax — round numbers, so the assertions
 *  are about the rules rather than about decimal places. */
async function issuedInvoice(s: ReturnType<typeof setup>, amount = "10000"): Promise<string> {
  const invoice = await s.service.raise(
    {
      tenantId: TENANT,
      partyId: CLIENT,
      entityPartyId: ENTITY,
      currency: "INR",
      fxRate: "1",
      fxRateDate: "2026-07-01",
      dueOn: "2026-07-31",
    },
    ACTOR,
  );
  await s.service.addLine({
    tenantId: TENANT,
    invoiceId: invoice.id,
    description: "Advisory",
    quantity: "1",
    unitAmount: amount,
  });
  await s.service.issue(TENANT, invoice.id, ACTOR);
  return invoice.id;
}

describe("payments", () => {
  it("reduce what is outstanding, without any flag saying so", async () => {
    const s = setup();
    const id = await issuedInvoice(s);
    await s.service.recordPayment(
      { tenantId: TENANT, invoiceId: id, amount: "4000", receivedOn: "2026-07-10", method: "bank_transfer" },
      ACTOR,
    );
    const balance = await s.service.balanceOf(TENANT, id);
    expect(balance.invoiced).toBe("10000.0000");
    expect(balance.paid).toBe("4000.0000");
    expect(balance.outstanding).toBe("6000.0000");
    // The invoice itself still just says `issued`. Its status is about the
    // DOCUMENT; what has been paid is arithmetic.
    const invoice = await s.service.describe(TENANT, id);
    expect(invoice.invoice.status).toBe("issued");
  });

  it("settle it exactly, and the balance reaches zero on its own", async () => {
    const s = setup();
    const id = await issuedInvoice(s);
    await s.service.recordPayment(
      { tenantId: TENANT, invoiceId: id, amount: "10000", receivedOn: "2026-07-10", method: "upi" },
      ACTOR,
    );
    expect((await s.service.balanceOf(TENANT, id)).outstanding).toBe("0.0000");
  });

  it("take a NEGATIVE amount, because a cheque bounces", async () => {
    // Two rows that tell the story, rather than the original edited into
    // something that never happened. `bib_app` holds no DELETE grant, so this
    // is the only honest way to express it.
    const s = setup();
    const id = await issuedInvoice(s);
    await s.service.recordPayment(
      { tenantId: TENANT, invoiceId: id, amount: "10000", receivedOn: "2026-07-10", method: "cheque", reference: "CHQ-88123" },
      ACTOR,
    );
    await s.service.recordPayment(
      { tenantId: TENANT, invoiceId: id, amount: "-10000", receivedOn: "2026-07-14", method: "cheque", note: "Returned unpaid" },
      ACTOR,
    );
    expect((await s.service.balanceOf(TENANT, id)).outstanding).toBe("10000.0000");
    // BOTH rows survive. "It was paid and then it was not" is the fact.
    expect(await s.service.listPayments(TENANT, id)).toHaveLength(2);
  });

  it("allow an overpayment rather than tidying it away", async () => {
    // A client settles two invoices with one transfer, or rounds up. A firm
    // needs to record what actually arrived; the balance simply goes negative,
    // which is what a credit on account looks like before there is a feature
    // for it.
    const s = setup();
    const id = await issuedInvoice(s);
    await s.service.recordPayment(
      { tenantId: TENANT, invoiceId: id, amount: "12000", receivedOn: "2026-07-10", method: "bank_transfer" },
      ACTOR,
    );
    expect((await s.service.balanceOf(TENANT, id)).outstanding).toBe("-2000.0000");
  });

  it("refuse a payment against an invoice nobody has been sent", async () => {
    // A draft has asked the client for nothing. The database refuses this again
    // in a trigger, because a payment applied to a withdrawn document quietly
    // reduces a balance nobody owes.
    const s = setup();
    const invoice = await s.service.raise(
      { tenantId: TENANT, partyId: CLIENT, entityPartyId: ENTITY, currency: "INR", fxRate: "1", fxRateDate: "2026-07-01" },
      ACTOR,
    );
    await expect(
      s.service.recordPayment(
        { tenantId: TENANT, invoiceId: invoice.id, amount: "100", receivedOn: "2026-07-10", method: "cash" },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(InvoiceNotIssued);
  });

  it("refuse a zero amount and an unknown method", async () => {
    const s = setup();
    const id = await issuedInvoice(s);
    const base = { tenantId: TENANT, invoiceId: id, receivedOn: "2026-07-10" };
    await expect(
      s.service.recordPayment({ ...base, amount: "0", method: "cash" }, ACTOR),
    ).rejects.toBeInstanceOf(InvalidInvoiceAmount);
    await expect(
      s.service.recordPayment({ ...base, amount: "100", method: "bitcoin" }, ACTOR),
    ).rejects.toBeInstanceOf(InvalidPaymentMethod);
  });

  it("record the bank's reference and not the free-text note", async () => {
    // The reference is the counterparty's own machine identifier and is what a
    // reconciliation dispute turns on. The note is prose a person wrote, and
    // this log cannot be erased.
    const s = setup();
    const id = await issuedInvoice(s);
    await s.service.recordPayment(
      { tenantId: TENANT, invoiceId: id, amount: "1000", receivedOn: "2026-07-10", method: "bank_transfer", reference: "UTR-99881", note: "Priya rang to confirm" },
      ACTOR,
    );
    const event = s.events.recorded.find((e) => e.verb === "payment.recorded");
    expect(event?.payload).toMatchObject({ reference: "UTR-99881", method: "bank_transfer" });
    expect(JSON.stringify(event?.payload)).not.toContain("Priya");
  });
});

describe("credit notes", () => {
  it("are their OWN document, in their OWN series", async () => {
    // Not an invoice with a minus sign. Under Indian GST it is a separate
    // document type with its own consecutive numbering, and interleaving the
    // two series would leave an invoice number an auditor cannot account for.
    const s = setup();
    const id = await issuedInvoice(s);
    const credit = await s.service.issueCreditNote(
      { tenantId: TENANT, invoiceId: id, amount: "2500", reason: "service_failure" },
      ACTOR,
    );
    expect(credit.number).toBe("CN/2026-27/0001");
    expect(credit.sequenceNumber).toBe(1);
    // The invoice series is untouched — the next invoice issued is still 0002.
    const next = await s.invoices.find(TENANT, await issuedInvoice(s));
    expect(next?.number).toBe("INV/2026-27/0002");
  });

  it("reduce what is outstanding", async () => {
    const s = setup();
    const id = await issuedInvoice(s);
    await s.service.issueCreditNote(
      { tenantId: TENANT, invoiceId: id, amount: "2500", reason: "billing_error" },
      ACTOR,
    );
    const balance = await s.service.balanceOf(TENANT, id);
    expect(balance.credited).toBe("2500.0000");
    expect(balance.outstanding).toBe("7500.0000");
  });

  it("demand a reason from the closed set", async () => {
    // The whole value of the field. Free text would satisfy NOT NULL and would
    // not GROUP BY, and "how much did we write off to service failures last
    // year" is the only question anybody asks of it.
    const s = setup();
    const id = await issuedInvoice(s);
    await expect(
      s.service.issueCreditNote(
        { tenantId: TENANT, invoiceId: id, amount: "100", reason: "because the client asked" },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(InvalidCreditReason);
  });

  it("put the reason in the ledger, not just the amount", async () => {
    // A log that recorded the amount and not the category would reproduce
    // exactly the blindness the column exists to remove.
    const s = setup();
    const id = await issuedInvoice(s);
    await s.service.issueCreditNote(
      { tenantId: TENANT, invoiceId: id, amount: "2500", reason: "goodwill", note: "Late filing was ours" },
      ACTOR,
    );
    const event = s.events.recorded.find((e) => e.verb === "credit_note.issued");
    expect(event?.payload).toMatchObject({ reason: "goodwill", amount: "2500" });
    expect(JSON.stringify(event?.payload)).not.toContain("Late filing");
  });

  it("cannot credit more than was billed", async () => {
    // Checked in the service rather than by a CHECK constraint, because the
    // limit depends on the SUM of every other credit note against the invoice —
    // which a row-level constraint cannot see.
    const s = setup();
    const id = await issuedInvoice(s);
    await s.service.issueCreditNote(
      { tenantId: TENANT, invoiceId: id, amount: "6000", reason: "scope_change" },
      ACTOR,
    );
    await expect(
      s.service.issueCreditNote(
        { tenantId: TENANT, invoiceId: id, amount: "5000", reason: "goodwill" },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(CreditExceedsInvoice);
    // …and crediting exactly the remainder is fine.
    await expect(
      s.service.issueCreditNote(
        { tenantId: TENANT, invoiceId: id, amount: "4000", reason: "goodwill" },
        ACTOR,
      ),
    ).resolves.toBeDefined();
    expect((await s.service.balanceOf(TENANT, id)).outstanding).toBe("0.0000");
  });

  it("refuse a credit against an invoice nobody has been sent", async () => {
    const s = setup();
    const invoice = await s.service.raise(
      { tenantId: TENANT, partyId: CLIENT, entityPartyId: ENTITY, currency: "INR", fxRate: "1", fxRateDate: "2026-07-01" },
      ACTOR,
    );
    await expect(
      s.service.issueCreditNote(
        { tenantId: TENANT, invoiceId: invoice.id, amount: "100", reason: "goodwill" },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(InvoiceNotIssued);
  });
});

describe("who owes the firm money", () => {
  it("lists issued invoices with something still on them, and nothing else", async () => {
    const s = setup();
    const settled = await issuedInvoice(s, "1000");
    await s.service.recordPayment(
      { tenantId: TENANT, invoiceId: settled, amount: "1000", receivedOn: "2026-07-10", method: "upi" },
      ACTOR,
    );
    const owing = await issuedInvoice(s, "5000");
    // A draft owes nothing because nobody has been asked.
    await s.service.raise(
      { tenantId: TENANT, partyId: CLIENT, entityPartyId: ENTITY, currency: "INR", fxRate: "1", fxRateDate: "2026-07-01" },
      ACTOR,
    );

    const receivables = await s.service.outstanding(TENANT);
    expect(receivables.map((r) => r.balance.invoiceId)).toEqual([owing]);
    expect(receivables[0]?.balance.outstanding).toBe("5000.0000");
    // The JOIN the collections screen needs: whose debt, and which invoice.
    expect(receivables[0]?.party.displayName).not.toBe("");
    expect(receivables[0]?.number).toMatch(/^INV\//);
  });
});
