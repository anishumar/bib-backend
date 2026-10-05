// Q056 (S5): the GST treatment and its arithmetic, case by case.
//
// `crm.invoice_line_amount` (0370) computes the same figures in SQL, and
// `gst.integration.test.ts` holds the two equal on real Postgres.
import { describe, expect, it } from "vitest";
import {
  INDIAN_STATES,
  decideTreatment,
  isSac,
  isTdsPercent,
  isTdsSection,
  lineTax,
  minorUnitOf,
  netPayable,
  placeOfSupplyOf,
  stateCodeOfGstin,
  stateCodeOfRegion,
  stateLabel,
  tdsOn,
  trimRate,
  type PlaceOfSupply,
  type TaxTreatment,
} from "../../src/domain/invoice/gst";

const MH_GSTIN = "27ABCDE1234F1Z5";
const KA_GSTIN = "29ABCDE1234F1Z5";
const CH_GSTIN = "04ABCDE1234F1Z5";
const DL_GSTIN = "07ABCDE1234F1Z5";

const state = (stateCode: string): PlaceOfSupply => ({ kind: "state", stateCode });

describe("the states", () => {
  it("have unique two-digit codes, and 25 (merged into 26) is not one", () => {
    const codes = INDIAN_STATES.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((c) => /^\d{2}$/.test(c))).toBe(true);
    expect(codes).not.toContain("25");
  });

  it("mark exactly the union territories without a legislature as UTGST", () => {
    const ut = INDIAN_STATES.filter((s) => s.utgst).map((s) => s.code);
    expect(ut.sort()).toEqual(["04", "26", "31", "35", "38", "97"]);
    // Delhi, Puducherry, Jammu and Kashmir have legislatures: SGST.
    for (const code of ["07", "34", "01"]) expect(INDIAN_STATES.find((s) => s.code === code)?.utgst).toBe(false);
  });

  it("print as name and code", () => {
    expect(stateLabel("27")).toBe("Maharashtra (27)");
    expect(stateLabel("99")).toBe("99");
  });
});

describe("reading a state", () => {
  it("from a GSTIN's first two digits", () => {
    expect(stateCodeOfGstin(MH_GSTIN)).toBe("27");
    expect(stateCodeOfGstin("25ABCDE1234F1Z5")).toBeNull(); // no longer issued
    expect(stateCodeOfGstin("AB")).toBeNull();
    expect(stateCodeOfGstin(null)).toBeNull();
  });

  it("from a typed region: exact names, usual spellings and codes only", () => {
    expect(stateCodeOfRegion("Maharashtra")).toBe("27");
    expect(stateCodeOfRegion("  maharashtra ")).toBe("27");
    expect(stateCodeOfRegion("Jammu & Kashmir")).toBe("01");
    expect(stateCodeOfRegion("Andaman & Nicobar Islands")).toBe("35");
    expect(stateCodeOfRegion("New Delhi")).toBe("07");
    expect(stateCodeOfRegion("Orissa")).toBe("21");
    expect(stateCodeOfRegion("Pondicherry")).toBe("34");
    expect(stateCodeOfRegion("Daman and Diu")).toBe("26");
    expect(stateCodeOfRegion("29")).toBe("29");
    expect(stateCodeOfRegion("Mumbai")).toBeNull(); // a city is not guessed at
    expect(stateCodeOfRegion("")).toBeNull();
    expect(stateCodeOfRegion(null)).toBeNull();
  });
});

describe("SAC", () => {
  it("is six digits in chapter 99", () => {
    expect(isSac("998222")).toBe(true);
    expect(isSac("9982")).toBe(false);
    expect(isSac("998222 ")).toBe(false);
    expect(isSac("123456")).toBe(false);
    expect(isSac("99822A")).toBe(false);
  });
});

describe("the place of supply", () => {
  const base = { recipientCountry: "IN", recipientGstin: null, addressRegion: null, hasAddress: true, chosenStateCode: null };

  it("is outside India for a client outside India, whatever else it holds", () => {
    expect(placeOfSupplyOf({ ...base, recipientCountry: "AE", recipientGstin: MH_GSTIN, chosenStateCode: "27" })).toEqual({
      kind: "outside_india",
      country: "AE",
    });
  });

  it("follows a state a person chose, then the GSTIN, then the address", () => {
    expect(placeOfSupplyOf({ ...base, recipientGstin: KA_GSTIN, addressRegion: "Goa", chosenStateCode: "27" })).toEqual(
      state("27"),
    );
    expect(placeOfSupplyOf({ ...base, recipientGstin: KA_GSTIN, addressRegion: "Goa" })).toEqual(state("29"));
    expect(placeOfSupplyOf({ ...base, addressRegion: "Goa" })).toEqual(state("30"));
  });

  it("is unknown when an address is on record but names no state that can be read", () => {
    expect(placeOfSupplyOf(base)).toEqual({ kind: "unknown" });
    expect(placeOfSupplyOf({ ...base, recipientCountry: null, addressRegion: "Mumbai" })).toEqual({ kind: "unknown" });
  });

  it("is the supplier's location for a client with no GSTIN and no address on record (s.12(2)(b))", () => {
    expect(placeOfSupplyOf({ ...base, hasAddress: false })).toEqual({ kind: "supplier_location" });
    expect(placeOfSupplyOf({ ...base, recipientCountry: null, hasAddress: false })).toEqual({ kind: "supplier_location" });
  });

  it("treats no country with a GSTIN as India", () => {
    expect(placeOfSupplyOf({ ...base, recipientCountry: null, recipientGstin: MH_GSTIN })).toEqual(state("27"));
  });
});

describe("the treatment", () => {
  const india = { supplierCountry: "IN", supplierGstin: MH_GSTIN, lutInForce: false };

  it("is CGST + SGST within a state", () => {
    expect(decideTreatment({ ...india, placeOfSupply: state("27") })).toMatchObject({
      ok: true,
      treatment: "gst_intra",
      supplierStateCode: "27",
    });
  });

  it("is CGST + UTGST within a union territory without a legislature", () => {
    expect(decideTreatment({ ...india, supplierGstin: CH_GSTIN, placeOfSupply: state("04") })).toMatchObject({
      treatment: "gst_intra_ut",
    });
  });

  it("is CGST + SGST within Delhi, which has a legislature", () => {
    expect(decideTreatment({ ...india, supplierGstin: DL_GSTIN, placeOfSupply: state("07") })).toMatchObject({
      treatment: "gst_intra",
    });
  });

  it("is IGST between states, and between a state and a union territory", () => {
    expect(decideTreatment({ ...india, placeOfSupply: state("29") })).toMatchObject({ treatment: "gst_inter" });
    expect(decideTreatment({ ...india, placeOfSupply: state("04") })).toMatchObject({ treatment: "gst_inter" });
  });

  it("is zero-rated for an export under an LUT, IGST without one", () => {
    const abroad: PlaceOfSupply = { kind: "outside_india", country: "US" };
    expect(decideTreatment({ ...india, placeOfSupply: abroad, lutInForce: true })).toMatchObject({
      treatment: "gst_export_lut",
    });
    expect(decideTreatment({ ...india, placeOfSupply: abroad, lutInForce: false })).toMatchObject({
      treatment: "gst_export_igst",
    });
  });

  it("is plain for a company outside India, or an Indian one without a GSTIN", () => {
    expect(decideTreatment({ ...india, supplierCountry: "AE", supplierGstin: null, placeOfSupply: state("27") })).toMatchObject({
      treatment: "plain",
      supplierStateCode: null,
    });
    expect(decideTreatment({ ...india, supplierGstin: null, placeOfSupply: { kind: "unknown" } })).toMatchObject({
      treatment: "plain",
    });
  });

  it("reads the supplier's location as the supplier's own state: CGST + SGST", () => {
    expect(decideTreatment({ ...india, placeOfSupply: { kind: "supplier_location" } })).toEqual({
      ok: true,
      treatment: "gst_intra",
      supplierStateCode: "27",
      placeOfSupply: state("27"),
    });
  });

  it("refuses an Indian GST invoice whose place of supply nobody has given", () => {
    expect(decideTreatment({ ...india, placeOfSupply: { kind: "unknown" } })).toEqual({
      ok: false,
      why: "place_of_supply_unknown",
    });
  });
});

const line = (over: Partial<Parameters<typeof lineTax>[0]> & { treatment: TaxTreatment | null }) =>
  lineTax({ quantity: "1", unitAmount: "10000", discountPercent: "0", taxPercent: "18", currency: "INR", ...over });

describe("one line's tax", () => {
  it("splits 18% into 9% CGST and 9% SGST within a state", () => {
    expect(line({ treatment: "gst_intra" })).toEqual({
      gross: "10000.0000",
      net: "10000.0000",
      cgst: "900.0000",
      sgst: "900.0000",
      utgst: "0.0000",
      igst: "0.0000",
      tax: "1800.0000",
      halfRate: "9",
      fullRate: null,
    });
  });

  it("charges UTGST instead of SGST within a union territory", () => {
    const t = line({ treatment: "gst_intra_ut" });
    expect([t.cgst, t.sgst, t.utgst, t.tax]).toEqual(["900.0000", "0.0000", "900.0000", "1800.0000"]);
  });

  it("charges the whole rate as IGST between states, and on an export without an LUT", () => {
    for (const treatment of ["gst_inter", "gst_export_igst"] as const) {
      const t = line({ treatment });
      expect([t.cgst, t.sgst, t.igst, t.tax, t.fullRate]).toEqual(["0.0000", "0.0000", "1800.0000", "1800.0000", "18"]);
    }
  });

  it("charges nothing on an export under an LUT, whatever the line's rate", () => {
    const t = line({ treatment: "gst_export_lut" });
    expect([t.net, t.igst, t.tax, t.fullRate]).toEqual(["10000.0000", "0.0000", "0.0000", "0"]);
  });

  it("charges nothing on a zero-rated line within a state", () => {
    const t = line({ treatment: "gst_intra", taxPercent: "0" });
    expect([t.cgst, t.sgst, t.tax, t.halfRate]).toEqual(["0.0000", "0.0000", "0.0000", "0"]);
  });

  it("computes a plain or pre-0370 line exactly as 0325 did: the rate on the net, rounded once", () => {
    for (const treatment of [null, "plain"] as const) {
      const t = line({ treatment, unitAmount: "27419.35" });
      expect([t.net, t.tax, t.cgst, t.igst]).toEqual(["27419.3500", "4935.4800", "0.0000", "0.0000"]);
    }
  });

  it("rounds each half on its own, so CGST + SGST may differ from 18% rounded once", () => {
    // 1000.05 x 9% = 90.0045 -> 90.00 each, 180.00; 1000.05 x 18% = 180.009 -> 180.01.
    const split = line({ treatment: "gst_intra", unitAmount: "1000.05" });
    expect([split.cgst, split.sgst, split.tax]).toEqual(["90.0000", "90.0000", "180.0000"]);
    expect(line({ treatment: "gst_inter", unitAmount: "1000.05" }).tax).toBe("180.0100");
  });

  it("rounds half away from zero, as Postgres does", () => {
    // 50.25 x 9% = 4.5225 -> 4.52; 50.50 x 9% = 4.545 -> 4.55.
    expect(line({ treatment: "gst_intra", unitAmount: "50.25" }).cgst).toBe("4.5200");
    expect(line({ treatment: "gst_intra", unitAmount: "50.50" }).cgst).toBe("4.5500");
  });

  it("taxes the rounded net after discount", () => {
    // 3 x 333.33 = 999.99, less 10% = 899.991 -> 899.99; 9% = 80.9991 -> 81.00.
    const t = line({ treatment: "gst_intra", quantity: "3", unitAmount: "333.33", discountPercent: "10" });
    expect([t.gross, t.net, t.cgst, t.tax]).toEqual(["999.9900", "899.9900", "81.0000", "162.0000"]);
  });

  it("splits an odd rate into halves with a decimal: 5% is 2.5 + 2.5, 0.25% is 0.125 + 0.125", () => {
    expect(line({ treatment: "gst_intra", taxPercent: "5" })).toMatchObject({ cgst: "250.0000", halfRate: "2.5" });
    expect(line({ treatment: "gst_intra", taxPercent: "0.25", unitAmount: "1000" })).toMatchObject({
      cgst: "1.2500",
      halfRate: "0.125",
    });
  });

  it("rounds to each currency's own minor unit", () => {
    expect(line({ treatment: "gst_export_igst", currency: "JPY", unitAmount: "1005" }).igst).toBe("181.0000");
    expect(line({ treatment: "gst_export_igst", currency: "KWD", unitAmount: "10.0005" }).igst).toBe("1.8000");
    expect(minorUnitOf("inr")).toBe(2);
  });

  it("adds up a multi-line, multi-rate invoice from its rounded lines", () => {
    const lines = [
      line({ treatment: "gst_intra", unitAmount: "1000.05" }), // 18%: 90.00 + 90.00
      line({ treatment: "gst_intra", unitAmount: "2000", taxPercent: "5" }), // 5%: 50 + 50
      line({ treatment: "gst_intra", unitAmount: "300", taxPercent: "0" }), // out of pocket: 0
    ];
    const sum = (k: "net" | "cgst" | "sgst" | "tax") =>
      lines.reduce((acc, l) => acc + BigInt(l[k].replace(".", "")), 0n).toString();
    expect(sum("net")).toBe("33000500"); // 3,300.05
    expect(sum("cgst")).toBe("1400000"); // 140.00
    expect(sum("sgst")).toBe("1400000");
    expect(sum("tax")).toBe("2800000");
  });
});

describe("TDS", () => {
  it("is the rate on the amount before GST", () => {
    expect(tdsOn({ taxable: "10000.0000", percent: "10", currency: "INR" })).toBe("1000.0000");
    expect(tdsOn({ taxable: "27419.35", percent: "10", currency: "INR" })).toBe("2741.9400"); // 2741.935 -> .94
    expect(tdsOn({ taxable: "1000", percent: "2", currency: "INR" })).toBe("20.0000");
  });

  it("leaves the net the client remits", () => {
    expect(netPayable("11800.0000", "1000.0000")).toBe("10800.0000");
  });

  it("takes a section as the Act writes it, and a rate above zero up to 100", () => {
    for (const ok of ["194J", "194JB", "194C", "195", "194J(b)"]) expect(isTdsSection(ok)).toBe(true);
    for (const bad of ["94J", "194j", "Section 194J", "", "194JBX"]) expect(isTdsSection(bad)).toBe(false);
    for (const ok of ["10", "2", "0.1", "100", "7.5"]) expect(isTdsPercent(ok)).toBe(true);
    for (const bad of ["0", "100.01", "-1", "10.001", "abc", ""]) expect(isTdsPercent(bad)).toBe(false);
  });
});

describe("a rate as printed", () => {
  it("drops trailing zeros", () => {
    expect(trimRate("18.0000")).toBe("18");
    expect(trimRate("2.50")).toBe("2.5");
    expect(trimRate("0")).toBe("0");
  });
});
