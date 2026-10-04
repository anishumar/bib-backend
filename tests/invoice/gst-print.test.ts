// Q056 (S5): what a GST tax invoice prints, CGST Rule 46 field by field.
import { describe, expect, it } from "vitest";
import { gstPrint, placeOfSupplyText, tdsRows, type GstPrintInput } from "../../src/domain/invoice/gst-print";

const money = (a: string): string => `₹${Number(a).toFixed(2)}`;
const countryName = (c: string): string => ({ US: "United States", AE: "United Arab Emirates" })[c] ?? c;

const base: GstPrintInput = {
  treatment: "gst_intra",
  currency: "INR",
  money,
  countryName,
  supplierName: "10x Global Advisory Private Limited",
  placeOfSupplyStateCode: "27",
  placeOfSupplyCountry: null,
  lines: [
    { description: "Monthly bookkeeping", sac: "998222", quantity: "1.0000", unitAmount: "10000.0000", taxPercent: "18.00", net: "10000.0000" },
  ],
  summary: [
    { sac: "998222", taxPercent: "18.00", taxable: "10000.0000", cgst: "900.0000", sgst: "900.0000", utgst: "0.0000", igst: "0.0000", tax: "1800.0000" },
  ],
  totals: {
    gross: "10000.0000",
    discount: "0.0000",
    net: "10000.0000",
    tax: "1800.0000",
    total: "11800.0000",
    cgst: "900.0000",
    sgst: "900.0000",
    utgst: "0.0000",
    igst: "0.0000",
  },
  taxInInr: null,
  lut: null,
  bank: {
    accountName: "10x Global Advisory Pvt Ltd",
    accountNumber: "50200012345678",
    bankName: "HDFC Bank",
    branch: "Fort, Mumbai",
    ifsc: "HDFC0001234",
    swift: null,
    iban: null,
  },
};

describe("a GST tax invoice prints", () => {
  it("the place of supply with the state's name and code (Rule 46(m))", () => {
    expect(gstPrint(base).meta).toEqual([{ label: "Place of supply", value: "Maharashtra (27)" }]);
    expect(placeOfSupplyText({ stateCode: null, country: "US", countryName })).toBe("Outside India (United States)");
  });

  it("each line's SAC, rate and taxable value (Rule 46(f), (j), (k))", () => {
    const t = gstPrint(base).table;
    expect(t.columns.map((c) => c.label)).toEqual(["Description", "SAC", "Qty", "Rate", "GST %", "Taxable value"]);
    expect(t.rows).toEqual([["Monthly bookkeeping", "998222", "1", "₹10000.00", "18", "₹10000.00"]]);
  });

  it("CGST and SGST at half the rate each within a state", () => {
    const p = gstPrint(base);
    expect(p.totals.map((r) => `${r.label}=${r.value}`)).toEqual([
      "Sub-total=₹10000.00",
      "CGST @9%=₹900.00",
      "SGST @9%=₹900.00",
      "Total=₹11800.00",
    ]);
    expect(p.print.summary.columns.map((c) => c.label)).toEqual([
      "SAC",
      "Taxable value",
      "CGST %",
      "CGST",
      "SGST %",
      "SGST",
      "Total tax",
    ]);
    expect(p.print.summary.rows).toEqual([["998222", "₹10000.00", "9", "₹900.00", "9", "₹900.00", "₹1800.00"]]);
    expect(p.print.taxInWords).toBe("Indian Rupees One Thousand Eight Hundred Only");
  });

  it("UTGST instead of SGST in a union territory without a legislature", () => {
    const p = gstPrint({ ...base, treatment: "gst_intra_ut", placeOfSupplyStateCode: "04", totals: { ...base.totals, sgst: "0.0000", utgst: "900.0000" } });
    expect(p.totals[2]).toEqual({ label: "UTGST @9%", value: "₹900.00", emphasis: false });
    expect(p.print.summary.columns[4]?.label).toBe("UTGST %");
  });

  it("IGST between states, without a shared rate when the lines differ", () => {
    const p = gstPrint({
      ...base,
      treatment: "gst_inter",
      placeOfSupplyStateCode: "29",
      lines: [...base.lines, { ...base.lines[0]!, taxPercent: "5.00" }],
      totals: { ...base.totals, cgst: "0.0000", sgst: "0.0000", igst: "1800.0000" },
    });
    expect(p.totals[1]).toEqual({ label: "IGST", value: "₹1800.00", emphasis: false });
    expect(p.print.summary.columns.map((c) => c.label)).toEqual(["SAC", "Taxable value", "IGST %", "IGST", "Total tax"]);
  });

  it("a discount, then the taxable value it leaves", () => {
    const p = gstPrint({ ...base, totals: { ...base.totals, discount: "1000.0000", net: "9000.0000" } });
    expect(p.totals.slice(0, 3).map((r) => r.label)).toEqual(["Sub-total", "Discount", "Taxable value"]);
  });

  it("the LUT declaration on an export under one, and IGST at 0%", () => {
    const p = gstPrint({
      ...base,
      treatment: "gst_export_lut",
      currency: "USD",
      placeOfSupplyStateCode: null,
      placeOfSupplyCountry: "US",
      lut: { reference: "AD2704260012345", yearLabel: "2026-27" },
      totals: { ...base.totals, tax: "0.0000", total: "10000.0000", cgst: "0.0000", sgst: "0.0000" },
      taxInInr: { amount: "0.00", printed: "₹0.00", rate: "83.2500000000" },
    });
    expect(p.meta[0]?.value).toBe("Outside India (United States)");
    expect(p.table.rows[0]?.[4]).toBe("0");
    expect(p.totals[1]?.label).toBe("IGST @0% (export under LUT)");
    expect(p.print.declarations).toEqual([
      "Whether tax is payable on reverse charge: No",
      "Supply meant for export under LUT without payment of IGST. LUT ARN AD2704260012345 (FY 2026-27).",
    ]);
    expect(p.print.taxInWords).toBeNull();
  });

  it("an export on payment of IGST, with the tax in rupees at the invoice's rate", () => {
    const p = gstPrint({
      ...base,
      treatment: "gst_export_igst",
      currency: "USD",
      placeOfSupplyStateCode: null,
      placeOfSupplyCountry: "US",
      totals: { ...base.totals, cgst: "0.0000", sgst: "0.0000", igst: "540.0000", tax: "540.0000" },
      taxInInr: { amount: "44955.00", printed: "₹44,955.00", rate: "83.2500000000" },
    });
    expect(p.print.declarations).toEqual([
      "Whether tax is payable on reverse charge: No",
      "Supply meant for export on payment of IGST.",
      "Tax in Indian Rupees at 83.25 per USD: ₹44,955.00.",
    ]);
  });

  it("whether tax is payable on reverse charge (Rule 46(o)), the bank, and who signs (Rule 46(p))", () => {
    const p = gstPrint(base).print;
    expect(p.declarations[0]).toBe("Whether tax is payable on reverse charge: No");
    expect(p.bank).toEqual([
      "Account name: 10x Global Advisory Pvt Ltd",
      "Account number: 50200012345678",
      "Bank: HDFC Bank, Fort, Mumbai",
      "IFSC: HDFC0001234",
    ]);
    expect(p.signatoryFor).toBe("For 10x Global Advisory Private Limited");
    expect(gstPrint({ ...base, bank: null }).print.bank).toEqual([]);
  });
});

describe("the TDS rows (Q057)", () => {
  it("say the section, the rate and that it is on the amount before tax, then the net", () => {
    expect(tdsRows({ section: "194J", percent: "10.00", tds: "1000.0000", netPayable: "10800.0000", money })).toEqual([
      { label: "Less: TDS u/s 194J @10% (on the amount before tax)", value: "(₹1000.00)", emphasis: false },
      { label: "Net amount payable", value: "₹10800.00", emphasis: true },
    ]);
  });
});
