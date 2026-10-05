// Q056 + Q057 (S5), the database half.
//
//   THE SPLIT IS COMPUTED TWICE AND MUST AGREE. `crm.invoice_line_amount`
//   (0370) adds an invoice up; `domain/invoice/gst.ts lineTax` states the same
//   rule so it can be tested case by case. This file feeds both the same lines
//   under every treatment and holds them equal to the paisa.
//
//   AN INVOICE FROM BEFORE 0370 COMPUTES AS IT DID: treatment NULL is 0325.
//
//   AN ISSUED INVOICE'S TAX IS FROZEN BY A TRIGGER, not only by the service.
//
//   THE CLIENT IS READ AS THE PAPER PRINTS IT: the GSTIN in force decides the
//   place of supply, an LUT for the year zero-rates an export, and TDS
//   recorded beside the money settles the invoice.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresInvoiceRepository } from "../../src/infrastructure/postgres/invoice-repository";
import { PostgresCompanyInvoicingRepository } from "../../src/infrastructure/postgres/company-invoicing-repository";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { LedgerService } from "../../src/usecase/ledger/service";
import { InvoiceService } from "../../src/usecase/invoice/service";
import { CompanyInvoicingService } from "../../src/usecase/invoice/company";
import { PostgresInvoiceFirmSettings } from "../../src/infrastructure/postgres/invoice-settings";
import { PostgresFirmTimeZone } from "../../src/infrastructure/postgres/firm-timezone-repository";
import { PostgresDocumentRepository } from "../../src/infrastructure/postgres/document-repository";
import { PostgresPartyRepository } from "../../src/infrastructure/postgres/party-repository";
import { systemIds } from "../../src/platform/ids";
import { FakeClock } from "../../src/testfakes/clock";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import { FakeIssuedCopies } from "../../src/testfakes/invoice";
import { FakeStaffDirectory } from "../../src/testfakes/lead";
import { lineTax, type TaxTreatment } from "../../src/domain/invoice/gst";
import { PlaceOfSupplyUnknown } from "../../src/domain/invoice/errors";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 4 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const ledger = new LedgerService({ events: new PostgresEventStore(app), ids: systemIds });
const repo = new PostgresInvoiceRepository(app);
const firmEntities = new PostgresDocumentRepository(app);
const parties = new PostgresPartyRepository(app);
const service = new InvoiceService({
  invoices: repo,
  timeZones: new PostgresFirmTimeZone(app),
  firmEntities,
  parties,
  ids: systemIds,
  // PINNED: FY 2026-27 on every company's calendar.
  clock: new FakeClock(new Date("2026-10-03T06:30:00Z")),
  events: ledger,
  issuedCopies: new FakeIssuedCopies(),
  staff: new FakeStaffDirectory(),
  settings: new PostgresInvoiceFirmSettings(app),
});
const companies = new CompanyInvoicingService({
  companies: new PostgresCompanyInvoicingRepository(app),
  firmEntities,
  parties,
  ids: systemIds,
  events: ledger,
});

const stamp = Date.now().toString(36);
let tenant = "";
let entity = "";
let mumbai = ""; // a client in Maharashtra, by GSTIN
let bengaluru = ""; // a client in Karnataka, by GSTIN
let newYork = ""; // a client in the US
let walkIn = ""; // a person with no GSTIN and no address
let unreadable = ""; // an address whose state cannot be read

async function party(name: string): Promise<string> {
  const [p] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name) VALUES (${tenant}, 'organization', ${name}) RETURNING id
  `;
  if (!p) throw new Error("no party");
  return p.id;
}

async function registered(partyId: string, country: string): Promise<void> {
  await owner`
    INSERT INTO core.organization (party_id, tenant_id, legal_name)
    SELECT id, tenant_id, display_name FROM core.party WHERE id = ${partyId}
  `;
  await owner`
    INSERT INTO core.legal_entity (party_id, tenant_id, jurisdiction, entity_type)
    VALUES (${partyId}, ${tenant}, ${country}, 'private_limited')
  `;
}

async function gstin(partyId: string, value: string): Promise<void> {
  await owner`
    INSERT INTO core.party_identifier (tenant_id, party_id, type, value, is_primary, valid_from)
    VALUES (${tenant}, ${partyId}, 'gstin', ${value}, true, '2017-07-01')
  `;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`gst-${stamp}`}, ${`gst-${stamp}`}, 'INR') RETURNING id
  `;
  if (!t) throw new Error("could not create the tenant");
  tenant = t.id;
  entity = await party("10x Global Advisory Private Limited");
  await registered(entity, "IN");
  await gstin(entity, "27ABCDE1234F1Z5");
  await owner`
    INSERT INTO crm.firm_entity_preference (tenant_id, client_jurisdiction, firm_entity_party_id)
    VALUES (${tenant}, '*', ${entity})
  `;
  mumbai = await party("Meridian Textiles Private Limited");
  await registered(mumbai, "IN");
  await gstin(mumbai, "27AAACM1234K1Z9");
  bengaluru = await party("Kaveri Foods Private Limited");
  await registered(bengaluru, "IN");
  await gstin(bengaluru, "29AABCK5678L1Z3");
  newYork = await party("Hudson Analytics Inc");
  await registered(newYork, "US");
  walkIn = await party("Asha Verma");
  unreadable = await party("Coastal Exports");
  await owner`
    UPDATE core.party SET billing_address = '{"lines":["12 Marine Drive"],"region":"Mumbai","country":"IN"}'::jsonb
     WHERE id = ${unreadable}
  `;
  await companies.addBankAccount(
    tenant,
    entity,
    { accountName: "10x Global Advisory Pvt Ltd", accountNumber: "50200012345678", bankName: "HDFC Bank", ifsc: "HDFC0001234" },
    SYSTEM_ACTOR,
  );
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

async function draft(partyId: string, currency = "INR"): Promise<string> {
  const i = await service.raise(
    {
      tenantId: tenant,
      partyId,
      entityPartyId: entity,
      currency,
      fxRate: currency === "INR" ? "1" : "83.25",
      fxRateDate: "2026-10-03",
    },
    SYSTEM_ACTOR,
  );
  return i.id;
}

async function add(invoiceId: string, unitAmount: string, taxPercent = "18", quantity = "1", discountPercent = "0") {
  return service.addLine({
    tenantId: tenant,
    invoiceId,
    description: `Advisory ${unitAmount}`,
    quantity,
    unitAmount,
    discountPercent,
    taxPercent,
    sac: "998222",
  });
}

describe("the split in SQL is the split in the domain", () => {
  const cases: readonly { quantity: string; unit: string; discount: string; rate: string }[] = [
    { quantity: "1", unit: "10000", discount: "0", rate: "18" },
    { quantity: "1", unit: "1000.05", discount: "0", rate: "18" },
    { quantity: "1", unit: "50.25", discount: "0", rate: "18" },
    { quantity: "1", unit: "50.50", discount: "0", rate: "18" },
    { quantity: "3", unit: "333.33", discount: "10", rate: "18" },
    { quantity: "1", unit: "27419.35", discount: "0", rate: "5" },
    { quantity: "2.5", unit: "1234.5678", discount: "7.5", rate: "12" },
    { quantity: "1", unit: "1000", discount: "0", rate: "0.25" },
    { quantity: "1", unit: "999.99", discount: "0", rate: "0" },
    { quantity: "12", unit: "8333.33", discount: "0", rate: "28" },
  ];
  const treatments: readonly (TaxTreatment | null)[] = [
    null,
    "plain",
    "gst_intra",
    "gst_intra_ut",
    "gst_inter",
    "gst_export_igst",
    "gst_export_lut",
  ];

  for (const currency of ["INR", "JPY", "KWD"]) {
    it(`agrees to the minor unit under every treatment, in ${currency}`, async () => {
      for (const treatment of treatments) {
        const id = await draft(mumbai, currency);
        for (const c of cases) await add(id, c.unit, c.rate, c.quantity, c.discount);
        // The treatment as a test sets it, on the draft (the trigger allows a
        // draft's to change; an LUT export needs an LUT row to point at).
        if (treatment === "gst_export_lut") {
          const lut = await companies.addLut(tenant, entity, { financialYear: 2030, reference: `LUT${stamp}`.slice(0, 20) }, SYSTEM_ACTOR);
          await owner`UPDATE crm.invoice SET tax_treatment = ${treatment}, lut_id = ${lut.id} WHERE id = ${id}`;
        } else {
          await owner`UPDATE crm.invoice SET tax_treatment = ${treatment}, lut_id = NULL WHERE id = ${id}`;
        }
        const rows = await owner<
          { quantity: string; unit_amount: string; discount_percent: string; tax_percent: string; net: string; tax: string; cgst: string; sgst: string; utgst: string; igst: string }[]
        >`
          SELECT l.quantity::text, l.unit_amount::text, l.discount_percent::text, l.tax_percent::text,
                 a.net::text, a.tax::text, a.cgst::text, a.sgst::text, a.utgst::text, a.igst::text
            FROM crm.invoice_line l JOIN crm.invoice_line_amount a ON a.invoice_line_id = l.id
           WHERE l.invoice_id = ${id} ORDER BY l.position
        `;
        expect(rows).toHaveLength(cases.length);
        for (const r of rows) {
          const d = lineTax({
            quantity: r.quantity,
            unitAmount: r.unit_amount,
            discountPercent: r.discount_percent,
            taxPercent: r.tax_percent,
            currency,
            treatment,
          });
          const four = (v: string) => Number(v).toFixed(4);
          expect([four(r.net), four(r.tax), four(r.cgst), four(r.sgst), four(r.utgst), four(r.igst)], `${String(treatment)} ${r.unit_amount}`).toEqual([
            d.net,
            d.tax,
            d.cgst,
            d.sgst,
            d.utgst,
            d.igst,
          ]);
        }
      }
    });
  }
});

describe("a GST invoice, end to end", () => {
  it("charges CGST + SGST to a client registered in the company's state", async () => {
    const id = await draft(mumbai);
    await add(id, "10000");
    const issued = await service.issue(tenant, id, SYSTEM_ACTOR);
    expect(issued.tax).toMatchObject({
      treatment: "gst_intra",
      supplierGstin: "27ABCDE1234F1Z5",
      supplierStateCode: "27",
      recipientGstin: "27AAACM1234K1Z9",
      placeOfSupplyStateCode: "27",
      placeOfSupplyCountry: null,
    });
    expect(issued.tax.bankAccountId).not.toBeNull();
    const v = await service.describe(tenant, id);
    expect([v.totals.cgst, v.totals.sgst, v.totals.igst, v.totals.total]).toEqual(["900.0000", "900.0000", "0.0000", "11800.0000"]);
    expect(v.bankAccount).toMatchObject({ bankName: "HDFC Bank", ifsc: "HDFC0001234" });
  });

  it("charges IGST to a client in another state", async () => {
    const id = await draft(bengaluru);
    await add(id, "10000");
    const issued = await service.issue(tenant, id, SYSTEM_ACTOR);
    expect(issued.tax).toMatchObject({ treatment: "gst_inter", placeOfSupplyStateCode: "29" });
    const v = await service.describe(tenant, id);
    expect([v.totals.cgst, v.totals.igst]).toEqual(["0.0000", "1800.0000"]);
  });

  it("charges IGST on an export without an LUT, and nothing under one", async () => {
    const before = await draft(newYork, "USD");
    await add(before, "3000");
    expect((await service.describe(tenant, before)).invoice.tax).toMatchObject({ treatment: "gst_export_igst", placeOfSupplyCountry: "US" });

    await companies.addLut(tenant, entity, { financialYear: 2026, reference: "AD2704260012345" }, SYSTEM_ACTOR);
    const v = await service.describe(tenant, before);
    expect(v.invoice.tax.treatment).toBe("gst_export_lut");
    expect(v.lut).toMatchObject({ reference: "AD2704260012345", financialYear: 2026 });
    expect([v.totals.tax, v.totals.total]).toEqual(["0.0000", "3000.0000"]);
    const issued = await service.issue(tenant, before, SYSTEM_ACTOR);
    expect(issued.tax.lutId).toBe(v.lut?.id);
  });

  it("is the supplier's state for a person with no GSTIN and no address", async () => {
    const id = await draft(walkIn);
    await add(id, "5000");
    const issued = await service.issue(tenant, id, SYSTEM_ACTOR);
    expect(issued.tax).toMatchObject({ treatment: "gst_intra", placeOfSupplyStateCode: "27", recipientGstin: null });
  });

  it("refuses an address whose state cannot be read, until a person chooses it", async () => {
    const id = await draft(unreadable);
    await add(id, "5000");
    await expect(service.issue(tenant, id, SYSTEM_ACTOR)).rejects.toBeInstanceOf(PlaceOfSupplyUnknown);
    await service.setPlaceOfSupply(tenant, id, "27", SYSTEM_ACTOR);
    const issued = await service.issue(tenant, id, SYSTEM_ACTOR);
    expect(issued.tax).toMatchObject({ chosenPlaceOfSupply: "27", placeOfSupplyStateCode: "27" });
  });
});

describe("an issued invoice's tax is frozen in the database", () => {
  it("refuses a change to the treatment, the place of supply or the TDS once issued", async () => {
    const id = await draft(mumbai);
    await add(id, "1000");
    await service.issue(tenant, id, SYSTEM_ACTOR);
    await expect(owner`UPDATE crm.invoice SET tax_treatment = 'gst_inter' WHERE id = ${id}`).rejects.toThrow(/cannot change/);
    await expect(owner`UPDATE crm.invoice SET place_of_supply_state_code = '29' WHERE id = ${id}`).rejects.toThrow(/cannot change/);
    await expect(owner`UPDATE crm.invoice SET tds_section = '194J', tds_percent = 10 WHERE id = ${id}`).rejects.toThrow(/cannot change/);
    await expect(owner`UPDATE crm.invoice_line SET sac = '998231' WHERE invoice_id = ${id}`).rejects.toThrow();
  });

  it("keeps a bank account it printed when the company changes it", async () => {
    const id = await draft(mumbai);
    await add(id, "1000");
    const issued = await service.issue(tenant, id, SYSTEM_ACTOR);
    await companies.addBankAccount(
      tenant,
      entity,
      { accountName: "10x Global Advisory Pvt Ltd", accountNumber: "00112233445566", bankName: "ICICI Bank", ifsc: "ICIC0000123" },
      SYSTEM_ACTOR,
    );
    const v = await service.describe(tenant, id);
    expect(v.bankAccount?.id).toBe(issued.tax.bankAccountId);
    expect(v.bankAccount?.bankName).toBe("HDFC Bank");
    // A refused UPDATE of a written account: details are written once.
    await expect(
      app.begin(async (db) => {
        await db`SELECT set_config('app.tenant_id', ${tenant}, true)`;
        await db`UPDATE crm.firm_entity_bank_account SET bank_name = 'X' WHERE entity_party_id = ${entity}`;
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it("computes an invoice from before 0370 (treatment NULL) as 0325 did", async () => {
    const id = await draft(mumbai);
    await add(id, "1000.05");
    await owner`UPDATE crm.invoice SET tax_treatment = NULL WHERE id = ${id}`;
    const [t] = await owner<{ tax: string; cgst: string }[]>`
      SELECT tax::text, cgst::text FROM crm.invoice_totals WHERE invoice_id = ${id}
    `;
    expect([Number(t?.tax).toFixed(2), Number(t?.cgst).toFixed(2)]).toEqual(["180.01", "0.00"]);
  });
});

describe("TDS (Q057)", () => {
  it("prints the TDS on the pre-tax amount and settles the invoice with the money", async () => {
    await service.setClientTds(tenant, mumbai, { section: "194J", percent: "10" }, SYSTEM_ACTOR);
    const id = await draft(mumbai);
    await add(id, "10000");
    await service.issue(tenant, id, SYSTEM_ACTOR);
    const v = await service.describe(tenant, id);
    expect(v.invoice.tax).toMatchObject({ tdsSection: "194J" });
    expect([Number(v.totals.tds).toFixed(2), Number(v.totals.netPayable).toFixed(2)]).toEqual(["1000.00", "10800.00"]);

    await service.recordPayment(
      { tenantId: tenant, invoiceId: id, amount: "10800", tdsAmount: "1000", receivedOn: "2026-10-03", method: "bank_transfer" },
      SYSTEM_ACTOR,
    );
    const b = await service.balanceOf(tenant, id);
    expect([Number(b.paid), Number(b.tds), Number(b.outstanding)]).toEqual([10800, 1000, 0]);
    // Settled: off the receivables.
    expect((await service.outstanding(tenant)).some((r) => r.balance.invoiceId === id)).toBe(false);
    await service.setClientTds(tenant, mumbai, null, SYSTEM_ACTOR);
  });

  it("records TDS on its own, and refuses cancelling the invoice it is on", async () => {
    const id = await draft(bengaluru);
    await add(id, "2000", "18");
    await service.issue(tenant, id, SYSTEM_ACTOR);
    await service.recordPayment(
      { tenantId: tenant, invoiceId: id, amount: "0", tdsAmount: "200", receivedOn: "2026-10-03", method: "other" },
      SYSTEM_ACTOR,
    );
    expect(Number((await service.balanceOf(tenant, id)).outstanding)).toBe(2160);
    await expect(service.cancel(tenant, id, SYSTEM_ACTOR)).rejects.toThrow();
    await expect(owner`UPDATE crm.invoice SET status = 'cancelled' WHERE id = ${id}`).rejects.toThrow(/TDS/);
  });

  it("reads and stops a client's setting behind the tenant wall", async () => {
    await service.setClientTds(tenant, bengaluru, { section: "194C", percent: "2" }, SYSTEM_ACTOR);
    expect(await service.clientTds(tenant, bengaluru)).toEqual({ section: "194C", percent: "2.00" });
    await service.setClientTds(tenant, bengaluru, null, SYSTEM_ACTOR);
    expect(await service.clientTds(tenant, bengaluru)).toBeNull();
  });
});

describe("a company's bank accounts and LUTs", () => {
  it("lists the live ones, one per currency and one per year", async () => {
    await companies.addBankAccount(
      tenant,
      entity,
      { accountName: "10x Global Advisory Pvt Ltd", accountNumber: "EEFC 0099887766", bankName: "HDFC Bank", swift: "HDFCINBB", currency: "USD" },
      SYSTEM_ACTOR,
    );
    const [co] = (await companies.list(tenant)).filter((c) => c.entityPartyId === entity);
    expect(co?.gstin).toBe("27ABCDE1234F1Z5");
    expect(co?.bankAccounts.map((b) => b.currency)).toEqual([null, "USD"]);
    expect(co?.luts.map((l) => l.financialYear)).toEqual([2030, 2026]);
  });

  it("prints the account for the invoice's currency", async () => {
    const id = await draft(newYork, "USD");
    await add(id, "100");
    const v = await service.describe(tenant, id);
    expect(v.bankAccount).toMatchObject({ currency: "USD", swift: "HDFCINBB" });
  });
});

describe("Round off (Q087, 0375)", () => {
  it("rounds a draft's total while the company rounds, freezes it at issue, and never moves an issued one", async () => {
    // The company must be one of the firm's listed companies to carry the
    // setting (0313's membership).
    await owner`
      INSERT INTO crm.firm_entity (tenant_id, party_id) VALUES (${tenant}, ${entity})
      ON CONFLICT (tenant_id, party_id) DO NOTHING
    `;
    await companies.setRoundOff(tenant, entity, true, SYSTEM_ACTOR);
    expect((await companies.list(tenant)).find((c) => c.entityPartyId === entity)?.roundOff).toBe(true);

    // 1,000.05 at 18% within a state: 90.00 + 90.00 = 180.00, so 1,180.05
    // before rounding; the client pays 1,180.00 and the PDF says Round off -0.05.
    const id = await draft(mumbai);
    await add(id, "1000.05");
    const d = await service.describe(tenant, id);
    expect(d.totals).toMatchObject({ total: "1180.0000", roundOff: "-0.0500", netPayable: "1180.0000" });

    await service.issue(tenant, id, SYSTEM_ACTOR);
    expect((await service.describe(tenant, id)).totals).toMatchObject({ total: "1180.0000", roundOff: "-0.0500" });
    const [b] = await owner<{ outstanding: string }[]>`
      SELECT outstanding::text FROM crm.invoice_balance WHERE invoice_id = ${id}
    `;
    expect(b?.outstanding).toBe("1180.0000");

    // Switched off: a new draft keeps its paise, the issued one keeps its rounding.
    await companies.setRoundOff(tenant, entity, false, SYSTEM_ACTOR);
    expect((await service.describe(tenant, id)).totals).toMatchObject({ total: "1180.0000", roundOff: "-0.0500" });
    const next = await draft(mumbai);
    await add(next, "1000.05");
    expect((await service.describe(tenant, next)).totals).toMatchObject({ total: "1180.0500", roundOff: "0.0000" });

    // And the trigger, not only the service, keeps an issued invoice's rounding.
    await expect(owner`UPDATE crm.invoice SET round_off = false WHERE id = ${id}`).rejects.toThrow(/rounded/);
  });
});
