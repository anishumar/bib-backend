// Q056 + Q057 (S5): the GST tax invoice and the TDS line, through the use case.
//
// The arithmetic is `domain/invoice/gst.ts` (gst.test.ts); this file is about
// the RULES around it: a draft follows the client and the company, Issue
// decides once more and freezes, a GST invoice is refused without a place of
// supply or a SAC, and TDS settles an invoice beside the money.
import { describe, expect, it } from "vitest";
import { InvoiceService } from "../../src/usecase/invoice/service";
import { makeInvoiceFakes } from "../../src/testfakes/invoice";
import {
  InvalidPlaceOfSupply,
  InvalidSac,
  InvalidTds,
  InvoiceBillsTheFirm,
  InvoiceHasPayments,
  InvoiceLineNeedsSac,
  InvoiceNotEditable,
  PlaceOfSupplyUnknown,
  ReversalExceedsPaid,
} from "../../src/domain/invoice/errors";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const CLIENT = "00000000-0000-0000-0000-0000000000bb";
const ENTITY = "00000000-0000-0000-0000-0000000000f1";
const ENGAGEMENT = "00000000-0000-0000-0000-0000000000e1";
const ACTOR = { type: "human" as const, id: "00000000-0000-0000-0000-0000000000cc" };

const MH = "27ABCDE1234F1Z5";
const KA = "29PQRSX6789K1Z2";

function setup() {
  const fakes = makeInvoiceFakes();
  fakes.firmEntities.add(ENTITY);
  fakes.parties.know(CLIENT, "Mehta Traders");
  // An Indian company registered in Maharashtra.
  Object.assign(fakes.invoices.world, { supplierCountry: "IN", supplierGstin: MH, bankAccountId: "bank-1" });
  fakes.invoices.engagements.set(ENGAGEMENT, {
    partyId: CLIENT,
    issuingEntityPartyId: ENTITY,
    letterRef: "EL-0001",
    currency: "INR",
  });
  return { ...fakes, service: new InvoiceService(fakes) };
}

type S = ReturnType<typeof setup>;

async function draft(s: S, currency = "INR"): Promise<string> {
  const i = await s.service.raise(
    {
      tenantId: TENANT,
      partyId: CLIENT,
      entityPartyId: ENTITY,
      currency,
      fxRate: currency === "INR" ? "1" : "83.5",
      fxRateDate: "2026-07-01",
    },
    ACTOR,
  );
  return i.id;
}

async function line(s: S, invoiceId: string, over: Partial<{ unitAmount: string; taxPercent: string; sac: string; engagementId: string }> = {}) {
  return s.service.addLine({
    tenantId: TENANT,
    invoiceId,
    description: "Monthly bookkeeping, July",
    quantity: "1",
    unitAmount: over.unitAmount ?? "10000",
    taxPercent: over.engagementId !== undefined && over.taxPercent === undefined ? undefined : (over.taxPercent ?? "18"),
    sac: over.sac ?? (over.engagementId === undefined ? "998222" : undefined),
    engagementId: over.engagementId,
  });
}

describe("a draft follows the client and the company", () => {
  it("charges CGST + SGST to a client in the company's state", async () => {
    const s = setup();
    Object.assign(s.invoices.world, { recipientCountry: "IN", recipientGstin: "27AAAAA0000A1Z5", recipientHasAddress: true });
    const id = await draft(s);
    await line(s, id);
    const v = await s.service.describe(TENANT, id);
    expect(v.invoice.tax).toMatchObject({
      treatment: "gst_intra",
      supplierStateCode: "27",
      placeOfSupplyStateCode: "27",
      recipientGstin: "27AAAAA0000A1Z5",
      bankAccountId: "bank-1",
    });
    expect([v.totals.cgst, v.totals.sgst, v.totals.igst, v.totals.tax, v.totals.total]).toEqual([
      "900.0000",
      "900.0000",
      "0.0000",
      "1800.0000",
      "11800.0000",
    ]);
    expect(v.issueBlocked).toBeNull();
  });

  it("charges IGST to a client in another state", async () => {
    const s = setup();
    Object.assign(s.invoices.world, { recipientCountry: "IN", recipientGstin: KA, recipientHasAddress: true });
    const id = await draft(s);
    await line(s, id);
    const v = await s.service.describe(TENANT, id);
    expect(v.invoice.tax.treatment).toBe("gst_inter");
    expect(v.invoice.tax.placeOfSupplyStateCode).toBe("29");
    expect([v.totals.cgst, v.totals.igst]).toEqual(["0.0000", "1800.0000"]);
  });

  it("zero-rates an export when the company holds an LUT for the year, and charges IGST when it does not", async () => {
    const s = setup();
    Object.assign(s.invoices.world, { recipientCountry: "US", recipientHasAddress: true });
    const id = await draft(s, "USD");
    await line(s, id, { unitAmount: "3000" });
    let v = await s.service.describe(TENANT, id);
    expect(v.invoice.tax).toMatchObject({ treatment: "gst_export_igst", placeOfSupplyCountry: "US", lutId: null });
    expect(v.totals.igst).toBe("540.0000");

    // The LUT for 2026-27 (the FakeClock's today is 1 July 2026).
    s.invoices.world.luts.set(2026, "lut-2026");
    v = await s.service.describe(TENANT, id);
    expect(v.invoice.tax).toMatchObject({ treatment: "gst_export_lut", lutId: "lut-2026" });
    expect([v.totals.igst, v.totals.tax, v.totals.total]).toEqual(["0.0000", "0.0000", "3000.0000"]);
  });

  it("issues a plain invoice from a company outside India, as before", async () => {
    const s = setup();
    Object.assign(s.invoices.world, { supplierCountry: "AE", supplierGstin: null, recipientCountry: "AE" });
    const id = await draft(s);
    await line(s, id, { taxPercent: "5", sac: undefined });
    const issued = await s.service.issue(TENANT, id, ACTOR);
    expect(issued.tax.treatment).toBe("plain");
    expect(issued.tax.supplierGstin).toBeNull();
  });
});

describe("the place of supply", () => {
  it("is refused at issue when the client's address names no readable state, and a person can choose it", async () => {
    const s = setup();
    Object.assign(s.invoices.world, { recipientCountry: "IN", recipientRegion: "Mumbai", recipientHasAddress: true });
    const id = await draft(s);
    await line(s, id);
    const v = await s.service.describe(TENANT, id);
    expect(v.issueBlocked?.reason).toBe("PLACE_OF_SUPPLY_UNKNOWN");
    expect(v.issueBlocked?.message).toContain("Mehta Traders");
    await expect(s.service.issue(TENANT, id, ACTOR)).rejects.toBeInstanceOf(PlaceOfSupplyUnknown);

    const chosen = await s.service.setPlaceOfSupply(TENANT, id, "27", ACTOR);
    expect(chosen.tax).toMatchObject({ treatment: "gst_intra", chosenPlaceOfSupply: "27", placeOfSupplyStateCode: "27" });
    expect(s.events.recorded.at(-1)?.verb).toBe("invoice.place_of_supply_set");
    const issued = await s.service.issue(TENANT, id, ACTOR);
    expect(issued.tax.placeOfSupplyStateCode).toBe("27");
  });

  it("is the supplier's state for a client with no GSTIN and no address on record", async () => {
    const s = setup();
    Object.assign(s.invoices.world, { recipientCountry: null, recipientHasAddress: false });
    const id = await draft(s);
    await line(s, id);
    const issued = await s.service.issue(TENANT, id, ACTOR);
    expect(issued.tax).toMatchObject({ treatment: "gst_intra", placeOfSupplyStateCode: "27", recipientGstin: null });
  });

  it("refuses a code that is not a GST state, and an issued invoice", async () => {
    const s = setup();
    Object.assign(s.invoices.world, { recipientCountry: "IN", recipientGstin: KA });
    const id = await draft(s);
    await expect(s.service.setPlaceOfSupply(TENANT, id, "25", ACTOR)).rejects.toBeInstanceOf(InvalidPlaceOfSupply);
    await line(s, id);
    await s.service.issue(TENANT, id, ACTOR);
    await expect(s.service.setPlaceOfSupply(TENANT, id, "27", ACTOR)).rejects.toBeInstanceOf(InvoiceNotEditable);
  });
});

describe("the SAC", () => {
  it("comes from the catalogue with the service's rate when a line bills an engagement", async () => {
    const s = setup();
    Object.assign(s.invoices.world, { recipientCountry: "IN", recipientGstin: KA });
    s.invoices.world.serviceTax.set(ENGAGEMENT, { sac: "998222", ratePercent: "18" });
    const id = await draft(s);
    const l = await line(s, id, { engagementId: ENGAGEMENT });
    expect([l.sac, l.taxPercent]).toEqual(["998222", "18"]);
  });

  it("refuses to issue a GST invoice with a line that has none, and a catalogue SAC added later is taken at issue", async () => {
    const s = setup();
    Object.assign(s.invoices.world, { recipientCountry: "IN", recipientGstin: KA });
    const id = await draft(s);
    await line(s, id, { engagementId: ENGAGEMENT, taxPercent: "18" });
    const v = await s.service.describe(TENANT, id);
    expect(v.issueBlocked?.reason).toBe("INVOICE_LINE_NEEDS_SAC");
    await expect(s.service.issue(TENANT, id, ACTOR)).rejects.toBeInstanceOf(InvoiceLineNeedsSac);

    s.invoices.world.serviceTax.set(ENGAGEMENT, { sac: "998231", ratePercent: null });
    await s.service.issue(TENANT, id, ACTOR);
    const lines = await s.invoices.listLines(TENANT, id);
    expect(lines[0]?.sac).toBe("998231");
  });

  it("is set by hand on a draft line, and refused when it is not one", async () => {
    const s = setup();
    Object.assign(s.invoices.world, { recipientCountry: "IN", recipientGstin: KA });
    const id = await draft(s);
    const l = await line(s, id, { engagementId: ENGAGEMENT, taxPercent: "18" });
    await expect(s.service.setLineSac(TENANT, id, l.id, "123456", ACTOR)).rejects.toBeInstanceOf(InvalidSac);
    await s.service.setLineSac(TENANT, id, l.id, "998222", ACTOR);
    expect(s.events.recorded.at(-1)?.verb).toBe("invoice.line_sac_set");
    await s.service.issue(TENANT, id, ACTOR);
  });

  it("is not required on a plain invoice", async () => {
    const s = setup();
    Object.assign(s.invoices.world, { supplierGstin: null, recipientCountry: "IN" });
    const id = await draft(s);
    await line(s, id, { engagementId: ENGAGEMENT, taxPercent: "0" });
    const issued = await s.service.issue(TENANT, id, ACTOR);
    expect(issued.tax.treatment).toBe("plain");
  });
});

describe("issued is frozen", () => {
  it("keeps the tax, the place and the TDS it went out with when the client changes", async () => {
    const s = setup();
    Object.assign(s.invoices.world, { recipientCountry: "IN", recipientGstin: "27AAAAA0000A1Z5" });
    await s.service.setClientTds(TENANT, CLIENT, { section: "194J", percent: "10" }, ACTOR);
    const id = await draft(s);
    await line(s, id);
    await s.service.issue(TENANT, id, ACTOR);

    Object.assign(s.invoices.world, { recipientGstin: KA });
    await s.service.setClientTds(TENANT, CLIENT, { section: "194J", percent: "2" }, ACTOR);
    const v = await s.service.describe(TENANT, id);
    expect(v.invoice.tax).toMatchObject({ treatment: "gst_intra", placeOfSupplyStateCode: "27", tdsPercent: "10" });
    expect(v.totals.tds).toBe("1000.0000");
  });

  it("writes the treatment and the place of supply into invoice.issued", async () => {
    const s = setup();
    Object.assign(s.invoices.world, { recipientCountry: "IN", recipientGstin: KA });
    const id = await draft(s);
    await line(s, id);
    await s.service.issue(TENANT, id, ACTOR);
    const issued = s.events.recorded.find((e) => e.verb === "invoice.issued");
    expect(issued?.payload).toMatchObject({ taxTreatment: "gst_inter", placeOfSupplyStateCode: "29" });
  });
});

describe("TDS (Q057)", () => {
  async function tdsInvoice(s: S): Promise<string> {
    Object.assign(s.invoices.world, { recipientCountry: "IN", recipientGstin: "27AAAAA0000A1Z5" });
    await s.service.setClientTds(TENANT, CLIENT, { section: "194j", percent: "10" }, ACTOR);
    const id = await draft(s);
    await line(s, id);
    await s.service.issue(TENANT, id, ACTOR);
    return id;
  }

  it("prints the TDS on the amount before GST, and the net the client remits", async () => {
    const s = setup();
    const id = await tdsInvoice(s);
    const v = await s.service.describe(TENANT, id);
    expect(v.invoice.tax).toMatchObject({ tdsSection: "194J", tdsPercent: "10" });
    expect([v.totals.total, v.totals.tds, v.totals.netPayable]).toEqual(["11800.0000", "1000.0000", "10800.0000"]);
    expect(s.events.recorded.find((e) => e.verb === "client.tds_set")?.payload).toMatchObject({ section: "194J", percent: "10" });
  });

  it("leaves the full total receivable, and settles when the money and the TDS cover it", async () => {
    const s = setup();
    const id = await tdsInvoice(s);
    expect((await s.service.balanceOf(TENANT, id)).outstanding).toBe("11800.0000");
    await s.service.recordPayment(
      { tenantId: TENANT, invoiceId: id, amount: "10800", tdsAmount: "1000", receivedOn: "2026-07-20", method: "bank_transfer" },
      ACTOR,
    );
    const b = await s.service.balanceOf(TENANT, id);
    expect([b.paid, b.tds, b.outstanding]).toEqual(["10800.0000", "1000.0000", "0.0000"]);
    expect(s.events.recorded.at(-1)?.payload).toMatchObject({ amount: "10800", tdsAmount: "1000" });
  });

  it("takes the TDS on its own, on another day, and refuses to undo more than was recorded", async () => {
    const s = setup();
    const id = await tdsInvoice(s);
    await s.service.recordPayment(
      { tenantId: TENANT, invoiceId: id, amount: "10800", receivedOn: "2026-07-20", method: "bank_transfer" },
      ACTOR,
    );
    expect((await s.service.balanceOf(TENANT, id)).outstanding).toBe("1000.0000");
    await s.service.recordPayment(
      { tenantId: TENANT, invoiceId: id, amount: "0", tdsAmount: "1000", receivedOn: "2026-08-05", method: "other" },
      ACTOR,
    );
    expect((await s.service.balanceOf(TENANT, id)).outstanding).toBe("0.0000");
    await expect(
      s.service.recordPayment(
        { tenantId: TENANT, invoiceId: id, amount: "0", tdsAmount: "-1500", receivedOn: "2026-08-06", method: "other" },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(ReversalExceedsPaid);
  });

  it("does not let an invoice with TDS recorded on it be cancelled", async () => {
    const s = setup();
    const id = await tdsInvoice(s);
    await s.service.recordPayment(
      { tenantId: TENANT, invoiceId: id, amount: "0", tdsAmount: "1000", receivedOn: "2026-07-20", method: "other" },
      ACTOR,
    );
    await expect(s.service.cancel(TENANT, id, ACTOR)).rejects.toBeInstanceOf(InvoiceHasPayments);
  });

  it("refuses a payment of nothing at all", async () => {
    const s = setup();
    const id = await tdsInvoice(s);
    await expect(
      s.service.recordPayment({ tenantId: TENANT, invoiceId: id, amount: "0", receivedOn: "2026-07-20", method: "other" }, ACTOR),
    ).rejects.toThrow();
  });

  it("is a section as the Act writes it and a rate above 0, and never one of the firm's own companies", async () => {
    const s = setup();
    await expect(s.service.setClientTds(TENANT, CLIENT, { section: "Section 194J", percent: "10" }, ACTOR)).rejects.toBeInstanceOf(InvalidTds);
    await expect(s.service.setClientTds(TENANT, CLIENT, { section: "194J", percent: "0" }, ACTOR)).rejects.toBeInstanceOf(InvalidTds);
    await expect(s.service.setClientTds(TENANT, ENTITY, { section: "194J", percent: "10" }, ACTOR)).rejects.toBeInstanceOf(InvoiceBillsTheFirm);
    expect(await s.service.setClientTds(TENANT, CLIENT, { section: "194J(b)", percent: "2" }, ACTOR)).toEqual({ section: "194J(b)", percent: "2" });
  });

  it("stops: a draft drafted after has none", async () => {
    const s = setup();
    Object.assign(s.invoices.world, { recipientCountry: "IN", recipientGstin: KA });
    await s.service.setClientTds(TENANT, CLIENT, { section: "194J", percent: "10" }, ACTOR);
    await s.service.setClientTds(TENANT, CLIENT, null, ACTOR);
    const id = await draft(s);
    await line(s, id);
    const v = await s.service.describe(TENANT, id);
    expect([v.invoice.tax.tdsSection, v.totals.tds, v.totals.netPayable]).toEqual([null, "0.0000", "11800.0000"]);
  });
});
