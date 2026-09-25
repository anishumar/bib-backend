// Invoicing (T3.4) at the use-case level: what the rules refuse, and what the
// ledger records. The gapless guarantee itself is a property of a Postgres row
// lock and is proven in numbering.integration.test.ts — a fake asserting it
// would be asserting its own behaviour.
import { describe, expect, it } from "vitest";
import { InvoiceService } from "../../src/usecase/invoice/service";
import { makeInvoiceFakes } from "../../src/testfakes/invoice";
import {
  EmptyInvoice,
  InvalidInvoiceAmount,
  InvalidInvoiceCurrency,
  InvalidInvoiceTransition,
  InvalidSeriesPrefix,
  InvoiceNotEditable,
  InvoiceNotFound,
  IrnAlreadyRegistered,
  EngagementOfAnotherClient,
  InvoiceBillsTheFirm,
  InvoiceEngagementNotFound,
  InvoiceIssuerNotAFirmEntity,
  InvoicePartyArchived,
} from "../../src/domain/invoice/errors";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const CLIENT = "00000000-0000-0000-0000-0000000000bb";
const ENTITY = "00000000-0000-0000-0000-0000000000f1";
const OTHER_ENTITY = "00000000-0000-0000-0000-0000000000f2";
const ACTOR = { type: "human" as const, id: "00000000-0000-0000-0000-0000000000cc" };

function setup(): { service: InvoiceService } & ReturnType<typeof makeInvoiceFakes> {
  const fakes = makeInvoiceFakes();
  fakes.invoices.partyNames.set(CLIENT, "Meridian Textiles Private Limited");
  fakes.invoices.partyNames.set(ENTITY, "10x Global Advisory Private Limited");
  fakes.invoices.partyNames.set(OTHER_ENTITY, "10x Global Inc.");
  // The firm's own two companies (F-10-1); the client is not one of them.
  fakes.firmEntities.add(ENTITY, OTHER_ENTITY);
  return { ...fakes, service: new InvoiceService(fakes) };
}

function raise(over: Partial<Parameters<InvoiceService["raise"]>[0]> = {}) {
  return {
    tenantId: TENANT,
    partyId: CLIENT,
    entityPartyId: ENTITY,
    currency: "INR",
    fxRate: "1",
    fxRateDate: "2026-07-01",
    ...over,
  };
}

describe("raising an invoice", () => {
  it("numbers it from the entity's series, consecutively", async () => {
    const s = setup();
    const first = await s.service.raise(raise(), ACTOR);
    const second = await s.service.raise(raise(), ACTOR);
    expect(first.number).toBe("INV/2026-27/0001");
    expect(second.number).toBe("INV/2026-27/0002");
    expect(second.sequenceNumber).toBe(2);
  });

  it("gives each of the firm's entities its OWN series", async () => {
    // Two legal entities each owe their own consecutive series, and both start
    // at 1. This is why UNIQUE is scoped to (tenant, entity, number) and not to
    // (tenant, number) — the firm-wide version would have failed here, on the
    // second entity's first invoice.
    const s = setup();
    const indian = await s.service.raise(raise(), ACTOR);
    const american = await s.service.raise(raise({ entityPartyId: OTHER_ENTITY }), ACTOR);
    expect(indian.number).toBe("INV/2026-27/0001");
    expect(american.number).toBe("INV/2026-27/0001");
    expect(american.entityPartyId).not.toBe(indian.entityPartyId);
  });

  it("puts a March invoice in the previous year's series", async () => {
    // The whole reason the year is financial and not calendar. A firm raising
    // an invoice on 2 April for March's work sets `seriesDate` deliberately.
    const s = setup();
    const march = await s.service.raise(raise({ seriesDate: "2026-03-31" }), ACTOR);
    expect(march.number).toBe("INV/2025-26/0001");
    expect(march.financialYear).toBe(2025);
    // …and the new year starts its own count at 1, beside it.
    const april = await s.service.raise(raise({ seriesDate: "2026-04-01" }), ACTOR);
    expect(april.number).toBe("INV/2026-27/0001");
  });

  it("records the allocation, with the number in it", async () => {
    // The number IS the machine fact this event is about. A consecutive series
    // is evidence, and "which number went to which client, when, decided by
    // whom" is the question an auditor asks about a gap.
    const s = setup();
    const raised = await s.service.raise(raise(), ACTOR);
    const event = s.events.recorded.find((e) => e.verb === "invoice.raised");
    expect(event?.payload).toMatchObject({
      number: raised.number,
      partyId: CLIENT,
      entityPartyId: ENTITY,
      financialYear: 2026,
      sequenceNumber: 1,
    });
    // The notes are free text a person wrote and stay out of a log that cannot
    // be erased.
    expect(JSON.stringify(event?.payload)).not.toContain("notes");
  });

  it("refuses a bad currency and a rate of zero", async () => {
    const s = setup();
    await expect(s.service.raise(raise({ currency: "rupees" }), ACTOR)).rejects.toBeInstanceOf(
      InvalidInvoiceCurrency,
    );
    // Positive, not merely non-negative: zero makes every converted total zero
    // and nothing looks wrong until a report does.
    await expect(s.service.raise(raise({ fxRate: "0" }), ACTOR)).rejects.toBeInstanceOf(
      InvalidInvoiceAmount,
    );
  });
});

describe("the lines, and what they add up to", () => {
  it("computes net of discount, and tax on the net", async () => {
    const s = setup();
    const invoice = await s.service.raise(raise(), ACTOR);
    await s.service.addLine({
      tenantId: TENANT,
      invoiceId: invoice.id,
      description: "GST filing, 12 months",
      quantity: "12",
      unitAmount: "2000",
      discountPercent: "10",
      taxPercent: "18",
    });
    const record = await s.service.describe(TENANT, invoice.id);
    // 12 x 2000 = 24000; less 10% = 21600; tax 18% of 21600 = 3888.
    expect(record.totals.gross).toBe("24000.0000");
    expect(record.totals.discount).toBe("2400.0000");
    expect(record.totals.net).toBe("21600.0000");
    expect(record.totals.tax).toBe("3888.0000");
    expect(record.totals.total).toBe("25488.0000");
  });

  it("taxes each line at its own rate", async () => {
    // Why `tax_percent` is per line and not per invoice: 18% on professional
    // fees and 0% on an out-of-pocket recharge, on the same document.
    const s = setup();
    const invoice = await s.service.raise(raise(), ACTOR);
    await s.service.addLine({
      tenantId: TENANT,
      invoiceId: invoice.id,
      description: "Professional fees",
      quantity: "1",
      unitAmount: "10000",
      taxPercent: "18",
    });
    await s.service.addLine({
      tenantId: TENANT,
      invoiceId: invoice.id,
      description: "Registrar fees at actuals",
      quantity: "1",
      unitAmount: "5000",
      taxPercent: "0",
    });
    const record = await s.service.describe(TENANT, invoice.id);
    expect(record.totals.net).toBe("15000.0000");
    expect(record.totals.tax).toBe("1800.0000");
  });

  it("holds a line to the invoice's currency, not the caller's", async () => {
    const s = setup();
    const invoice = await s.service.raise(raise({ currency: "AED" }), ACTOR);
    await s.service.addLine({
      tenantId: TENANT,
      invoiceId: invoice.id,
      description: "Advisory",
      quantity: "1",
      unitAmount: "1000",
    });
    const record = await s.service.describe(TENANT, invoice.id);
    expect(record.lines[0]?.line.currency).toBe("AED");
  });

  it("refuses a quantity of zero and a negative amount", async () => {
    const s = setup();
    const invoice = await s.service.raise(raise(), ACTOR);
    const line = { tenantId: TENANT, invoiceId: invoice.id, description: "x", unitAmount: "10" };
    await expect(
      s.service.addLine({ ...line, quantity: "0" }),
    ).rejects.toBeInstanceOf(InvalidInvoiceAmount);
    await expect(
      s.service.addLine({ ...line, quantity: "1", unitAmount: "-5" }),
    ).rejects.toBeInstanceOf(InvalidInvoiceAmount);
  });

  it("reads zeroes, not nulls, for an invoice with nothing on it", async () => {
    // No live lines means no row in the totals view at all — sum() over nothing
    // is NULL and GROUP BY emits no group. A screen must not render "null"
    // where a figure belongs.
    const s = setup();
    const invoice = await s.service.raise(raise(), ACTOR);
    const record = await s.service.describe(TENANT, invoice.id);
    expect(record.totals).toMatchObject({ lineCount: 0, net: "0.0000", total: "0.0000" });
  });
});

describe("issuing, and what stops afterwards", () => {
  it("refuses to issue an invoice that asks for nothing", async () => {
    const s = setup();
    const invoice = await s.service.raise(raise(), ACTOR);
    await expect(s.service.issue(TENANT, invoice.id, ACTOR)).rejects.toBeInstanceOf(EmptyInvoice);
  });

  it("issues, and then refuses every edit", async () => {
    const s = setup();
    const invoice = await s.service.raise(raise(), ACTOR);
    await s.service.addLine({
      tenantId: TENANT,
      invoiceId: invoice.id,
      description: "Advisory",
      quantity: "1",
      unitAmount: "1000",
    });
    const issued = await s.service.issue(TENANT, invoice.id, ACTOR);
    expect(issued.status).toBe("issued");
    expect(issued.issuedOn).toBe("2026-07-01");

    await expect(
      s.service.addLine({
        tenantId: TENANT,
        invoiceId: invoice.id,
        description: "One more thing",
        quantity: "1",
        unitAmount: "500",
      }),
    ).rejects.toBeInstanceOf(InvoiceNotEditable);
    const lines = await s.service.describe(TENANT, invoice.id);
    await expect(
      s.service.removeLine(TENANT, invoice.id, lines.lines[0]?.line.id ?? ""),
    ).rejects.toBeInstanceOf(InvoiceNotEditable);
  });

  it("cannot be issued twice", async () => {
    const s = setup();
    const invoice = await s.service.raise(raise(), ACTOR);
    await s.service.addLine({
      tenantId: TENANT,
      invoiceId: invoice.id,
      description: "Advisory",
      quantity: "1",
      unitAmount: "1000",
    });
    await s.service.issue(TENANT, invoice.id, ACTOR);
    await expect(s.service.issue(TENANT, invoice.id, ACTOR)).rejects.toBeInstanceOf(
      InvalidInvoiceTransition,
    );
  });

  it("cancels without releasing the number", async () => {
    // The heart of "consecutive". A cancelled invoice stays IN the sequence,
    // readable, saying it was cancelled — which is exactly what an auditor
    // needs in order to see where a number went.
    const s = setup();
    const first = await s.service.raise(raise(), ACTOR);
    await s.service.cancel(TENANT, first.id, ACTOR);
    const second = await s.service.raise(raise(), ACTOR);
    expect(second.sequenceNumber).toBe(2);

    const listed = await s.service.list(TENANT, {});
    expect(listed.map((r) => [r.invoice.number, r.invoice.status])).toEqual([
      ["INV/2026-27/0002", "draft"],
      ["INV/2026-27/0001", "cancelled"],
    ]);
  });

  it("cannot be cancelled twice", async () => {
    const s = setup();
    const invoice = await s.service.raise(raise(), ACTOR);
    await s.service.cancel(TENANT, invoice.id, ACTOR);
    await expect(s.service.cancel(TENANT, invoice.id, ACTOR)).rejects.toBeInstanceOf(
      InvalidInvoiceTransition,
    );
  });
});

describe("the registry's identifier", () => {
  it("is recorded once and never replaced", async () => {
    const s = setup();
    const invoice = await s.service.raise(raise(), ACTOR);
    const registered = await s.service.registerIrn(TENANT, invoice.id, "IRN-ABC-123", ACTOR);
    expect(registered.irn).toBe("IRN-ABC-123");
    expect(registered.irnRegisteredAt).not.toBeNull();
    await expect(
      s.service.registerIrn(TENANT, invoice.id, "IRN-XYZ-999", ACTOR),
    ).rejects.toBeInstanceOf(IrnAlreadyRegistered);
  });
});

describe("the series a firm names", () => {
  it("changes future numbers and never an issued one", async () => {
    const s = setup();
    const before = await s.service.raise(raise(), ACTOR);
    await s.service.setSeriesPrefix(TENANT, ENTITY, "10XIN", ACTOR);
    const after = await s.service.raise(raise(), ACTOR);
    expect(before.number).toBe("INV/2026-27/0001");
    expect(after.number).toBe("10XIN/2026-27/0002");
    // The count did not restart — the prefix is what it READS as, not which
    // series it belongs to.
    expect(after.sequenceNumber).toBe(2);
  });

  it("refuses a prefix that could not print on a legal document", async () => {
    const s = setup();
    await expect(s.service.setSeriesPrefix(TENANT, ENTITY, "inv", ACTOR)).rejects.toBeInstanceOf(
      InvalidSeriesPrefix,
    );
  });
});

describe("the tenant wall, at the use case", () => {
  it("does not find another firm's invoice", async () => {
    const s = setup();
    const invoice = await s.service.raise(raise(), ACTOR);
    await expect(
      s.service.describe("00000000-0000-0000-0000-0000000000ab", invoice.id),
    ).rejects.toBeInstanceOf(InvoiceNotFound);
  });
});


describe("the list says what is still OWED, not just what was billed", () => {
  // Walked: a fully-settled invoice sat beside one seventy-five days overdue,
  // both reading `issued` and both showing their full value. `status` is about
  // the DOCUMENT and says nothing about money; /receivables already dropped the
  // settled one, so the data existed and the list simply never asked for it.

  it("carries paid, credited and outstanding on every ISSUED invoice", async () => {
    const h = setup();
    const invoice = await h.service.raise(raise(), ACTOR);
    await h.service.addLine({
      tenantId: TENANT,
      invoiceId: invoice.id,
      description: "Statutory audit",
      quantity: "1",
      unitAmount: "100000.00",
    });
    await h.service.issue(TENANT, invoice.id, ACTOR);
    await h.service.recordPayment(
      { tenantId: TENANT, invoiceId: invoice.id, amount: "40000.00", receivedOn: "2026-07-10", method: "bank_transfer" },
      ACTOR,
    );

    const [row] = await h.service.list(TENANT, {});

    // Compared as NUMBERS here and nowhere else in the product: the in-memory
    // fake carries four decimals where Postgres carries two, and the assertion
    // is about the arithmetic rather than the scale. Nothing that renders money
    // may do this — see the note on `formatMoney` in the frontend.
    expect(Number(row?.balance?.paid)).toBe(40000);
    expect(Number(row?.balance?.credited)).toBe(0);
    expect(Number(row?.balance?.outstanding)).toBe(60000);
  });

  it("tells a SETTLED invoice from an unpaid one, which `status` cannot", async () => {
    const h = setup();
    const settled = await h.service.raise(raise(), ACTOR);
    await h.service.addLine({
      tenantId: TENANT,
      invoiceId: settled.id,
      description: "Paid in full",
      quantity: "1",
      unitAmount: "10000.00",
    });
    await h.service.issue(TENANT, settled.id, ACTOR);
    await h.service.recordPayment(
      { tenantId: TENANT, invoiceId: settled.id, amount: "10000.00", receivedOn: "2026-07-10", method: "bank_transfer" },
      ACTOR,
    );

    const owing = await h.service.raise(raise(), ACTOR);
    await h.service.addLine({
      tenantId: TENANT,
      invoiceId: owing.id,
      description: "Not paid",
      quantity: "1",
      unitAmount: "10000.00",
    });
    await h.service.issue(TENANT, owing.id, ACTOR);

    const rows = await h.service.list(TENANT, {});
    const bySettled = rows.find((r) => r.invoice.id === settled.id);
    const byOwing = rows.find((r) => r.invoice.id === owing.id);

    // Both are `issued` and both show their full total. Only this tells them
    // apart, which is the whole point of putting it on the list.
    expect(bySettled?.invoice.status).toBe(byOwing?.invoice.status);
    expect(bySettled?.totals.total).toBe(byOwing?.totals.total);
    expect(Number(bySettled?.balance?.outstanding)).toBe(0);
    expect(Number(byOwing?.balance?.outstanding)).toBe(10000);
  });

  it("is NULL on a CANCELLED invoice — it was withdrawn, so it owes nothing", async () => {
    // Walked: a cancelled invoice sat in the list reading ₹7,080 outstanding.
    // /receivables has always filtered `status = 'issued'`; the list now reads
    // it the same way, so the two cannot disagree about who owes what.
    const h = setup();
    const killed = await h.service.raise(raise(), ACTOR);
    await h.service.addLine({
      tenantId: TENANT,
      invoiceId: killed.id,
      description: "Withdrawn",
      quantity: "1",
      unitAmount: "7080.00",
    });
    await h.service.issue(TENANT, killed.id, ACTOR);
    await h.service.cancel(TENANT, killed.id, ACTOR);

    const [row] = await h.service.list(TENANT, {});

    expect(row?.invoice.status).toBe("cancelled");
    expect(row?.balance).toBeNull();
    // The TOTAL stays: a cancelled invoice keeps its number and its figures
    // forever, which is the whole reason cancelling is not deleting.
    expect(Number(row?.totals.total)).toBe(7080);
  });

  it("is NULL on a draft — nobody has been asked, and zero would read as settled", async () => {
    const h = setup();
    const draft = await h.service.raise(raise(), ACTOR);
    await h.service.addLine({
      tenantId: TENANT,
      invoiceId: draft.id,
      description: "Not issued yet",
      quantity: "1",
      unitAmount: "10000.00",
    });

    const [row] = await h.service.list(TENANT, {});

    expect(row?.invoice.status).toBe("draft");
    expect(row?.balance).toBeNull();
    // The TOTAL is still there: what the document says is a fact even before
    // anybody is asked to pay it.
    expect(Number(row?.totals.total)).toBe(10000);
  });
});

describe("the day on the invoice is the firm's, or the caller's — never the server's", () => {
  // 20:00 UTC on 1 July is 01:30 on 2 July in Delhi. An invoice issued then was
  // dated the 1st: Greenwich's day, the day before it was issued.
  async function lined(s: ReturnType<typeof setup>) {
    const invoice = await s.service.raise(raise(), ACTOR);
    await s.service.addLine({
      tenantId: TENANT,
      invoiceId: invoice.id,
      description: "Advisory",
      quantity: "1",
      unitAmount: "1000",
    });
    return invoice;
  }

  it("dates an issued invoice by the FIRM's calendar", async () => {
    const s = setup();
    s.timeZones.set("Asia/Kolkata");
    s.clock.set("2026-07-01T20:00:00.000Z");
    const invoice = await lined(s);
    const issued = await s.service.issue(TENANT, invoice.id, ACTOR);
    expect(issued.issuedOn).toBe("2026-07-02");
  });

  it("takes the caller's own today when it sends one", async () => {
    // A partner in Dubai at 23:30 local on the 1st, for a firm in Delhi where
    // it is already the 2nd: their today is the 1st, and that is a real today.
    const s = setup();
    s.timeZones.set("Asia/Kolkata");
    s.clock.set("2026-07-01T19:30:00.000Z");
    const invoice = await lined(s);
    const issued = await s.service.issue(TENANT, invoice.id, ACTOR, "2026-07-01");
    expect(issued.issuedOn).toBe("2026-07-01");
  });

  it("REFUSES an asOf that is not today anywhere, so it cannot backdate a tax invoice", async () => {
    const s = setup();
    const invoice = await lined(s);
    await expect(s.service.issue(TENANT, invoice.id, ACTOR, "2026-06-01")).rejects.toMatchObject({
      code: "NOT_CALLERS_TODAY",
    });
    // And nothing moved: still a draft.
    const after = await s.invoices.find(TENANT, invoice.id);
    expect(after?.status).toBe("draft");
  });

  it("puts an undated invoice in the FIRM's year's books on 1 April morning in Delhi", async () => {
    // 31 March 20:00 UTC is 1 April 01:30 IST — a new financial year there.
    const s = setup();
    s.timeZones.set("Asia/Kolkata");
    s.clock.set("2027-03-31T20:00:00.000Z");
    const invoice = await s.service.raise(raise(), ACTOR);
    expect(invoice.number).toMatch(/2027-28/);
  });

  it("dates a credit note by the firm's day when none is given", async () => {
    const s = setup();
    s.timeZones.set("Asia/Kolkata");
    s.clock.set("2026-07-01T20:00:00.000Z");
    const invoice = await lined(s);
    await s.service.issue(TENANT, invoice.id, ACTOR);
    const credit = await s.service.issueCreditNote(
      { tenantId: TENANT, invoiceId: invoice.id, amount: "100", reason: "goodwill" },
      ACTOR,
    );
    expect(credit.issuedOn).toBe("2026-07-02");
  });
});

describe("who an invoice names (F-10-1)", () => {
  // Checked for the FIRM only until now. The issuer opens a numbered GST series
  // in its own name, so a client named there could never be taken back.
  const OTHER_CLIENT = "00000000-0000-0000-0000-0000000000b9";
  const ENGAGEMENT = "00000000-0000-0000-0000-0000000000e1";
  const THEIR_ENGAGEMENT = "00000000-0000-0000-0000-0000000000e2";

  function named() {
    const s = setup();
    s.parties
      .know(CLIENT, "Meridian Textiles Private Limited")
      .know(OTHER_CLIENT, "Lakeview Foods Private Limited")
      .know(ENTITY, "10x Global Advisory Private Limited");
    s.invoices.engagementParties.set(ENGAGEMENT, CLIENT);
    s.invoices.engagementParties.set(THEIR_ENGAGEMENT, OTHER_CLIENT);
    return s;
  }

  it("refuses a client as the issuer, by name, and opens no series for it", async () => {
    const s = named();
    const refused = s.service.raise(raise({ entityPartyId: OTHER_CLIENT }), ACTOR);
    await expect(refused).rejects.toBeInstanceOf(InvoiceIssuerNotAFirmEntity);
    await expect(refused).rejects.toThrow(
      /Lakeview Foods Private Limited is not one of the firm's own companies/,
    );
    expect(s.invoices.invoices).toHaveLength(0);
    // The firm's own series starts at 1 regardless.
    expect((await s.service.raise(raise(), ACTOR)).number).toBe("INV/2026-27/0001");
  });

  it("refuses to bill one of the firm's own companies", async () => {
    const s = named();
    await expect(s.service.raise(raise({ partyId: OTHER_ENTITY }), ACTOR)).rejects.toBeInstanceOf(
      InvoiceBillsTheFirm,
    );
    expect(s.invoices.invoices).toHaveLength(0);
  });

  it("refuses an archived client, as a letter does (0305)", async () => {
    const s = named();
    s.parties.archive(CLIENT, "Meridian Textiles Private Limited");
    await expect(s.service.raise(raise(), ACTOR)).rejects.toBeInstanceOf(InvoicePartyArchived);
    expect(s.invoices.invoices).toHaveLength(0);
  });

  it("bills the client's own engagement, and refuses another client's", async () => {
    const s = named();
    const invoice = await s.service.raise(raise(), ACTOR);
    const line = (engagementId: string) =>
      s.service.addLine({
        tenantId: TENANT,
        invoiceId: invoice.id,
        engagementId,
        description: "GST filing, July",
        quantity: "1",
        unitAmount: "6000",
      });
    await expect(line(ENGAGEMENT)).resolves.toBeUndefined();
    const refused = line(THEIR_ENGAGEMENT);
    await expect(refused).rejects.toBeInstanceOf(EngagementOfAnotherClient);
    await expect(refused).rejects.toThrow(
      "That engagement is Lakeview Foods Private Limited's work, and this invoice bills Meridian Textiles Private Limited.",
    );
    await expect(line("00000000-0000-0000-0000-0000000000e9")).rejects.toBeInstanceOf(
      InvoiceEngagementNotFound,
    );
    expect(await s.invoices.listLines(TENANT, invoice.id)).toHaveLength(1);
  });

  it("names a series only for one of the firm's own companies", async () => {
    const s = named();
    await expect(
      s.service.setSeriesPrefix(TENANT, OTHER_CLIENT, "LV", ACTOR),
    ).rejects.toBeInstanceOf(InvoiceIssuerNotAFirmEntity);
    expect(s.events.recorded).toHaveLength(0);
  });
});
