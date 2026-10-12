// The counterparty key (F4.3, reused by F3.2): UEN, else GST number, else a
// normalised name, and never a weaker identifier over a stronger one.
import { describe, expect, it } from "vitest";
import {
  counterpartyKey,
  counterpartyKeyText,
  normaliseCounterpartyName,
  normaliseDocNumber,
  normaliseRegistration,
  sameCounterparty,
} from "../../src/domain/fin/checks-counterparty";

const party = (uen: string | null, gst: string | null, name: string | null) => ({
  counterpartyUen: uen,
  counterpartyGstNo: gst,
  counterpartyName: name,
});

describe("normalising a name", () => {
  it.each([
    ["FreshPantry Supplies Pte Ltd", "freshpantry supplies"],
    ["FRESHPANTRY SUPPLIES PTE. LTD.", "freshpantry supplies"],
    ["Freshpantry Supplies", "freshpantry supplies"],
    ["  Singa Mobile   and Fibre Pte Ltd ", "singa mobile and fibre"],
    ["Singa Mobile & Fibre Private Limited", "singa mobile and fibre"],
    ["Kavya Tech Solutions Pvt Ltd", "kavya tech solutions"],
    ["Atlas Collab Inc", "atlas collab"],
    ["Startup Legal LLP", "startup legal"],
    ["Café Lumière Pte Ltd", "cafe lumiere"],
    ["Chen Mei Lin (Freelance Designer)", "chen mei lin freelance designer"],
  ] as const)("%s → %s", (raw, normal) => {
    expect(normaliseCounterpartyName(raw)).toBe(normal);
  });

  it("strips only a TRAILING legal form, never one inside the name", () => {
    expect(normaliseCounterpartyName("Wei and Co Chartered Accountants")).toBe("wei and co chartered accountants");
    expect(normaliseCounterpartyName("Ltd Holdings Pte Ltd")).toBe("ltd holdings");
  });

  it("keeps a name that is nothing but a legal form, and says nothing for nothing", () => {
    expect(normaliseCounterpartyName("Ltd")).toBe("ltd");
    expect(normaliseCounterpartyName("  ...  ")).toBeNull();
    expect(normaliseCounterpartyName(null)).toBeNull();
  });
});

describe("normalising a registration or document number", () => {
  it("drops the separators printers put in a number", () => {
    expect(normaliseRegistration("m2-2407755-9")).toBe("M224077559");
    expect(normaliseRegistration("M2 2407755 9")).toBe("M224077559");
    expect(normaliseRegistration("201560913X")).toBe("201560913X");
    expect(normaliseRegistration(" - ")).toBeNull();
  });

  it("keeps a document number's own dashes and slashes, dropping only spaces", () => {
    expect(normaliseDocNumber(" si/25/2839 ")).toBe("SI/25/2839");
    expect(normaliseDocNumber("INV 25 1006")).toBe("INV251006");
    expect(normaliseDocNumber("INV-25-1006")).toBe("INV-25-1006");
    expect(normaliseDocNumber("")).toBeNull();
  });
});

describe("the key, strongest first", () => {
  it("is the UEN, else the GST number, else the name", () => {
    expect(counterpartyKey(party("201560913X", "M2-8761513-8", "FreshPantry"))).toEqual({ kind: "uen", value: "201560913X" });
    expect(counterpartyKey(party(null, "M2-8761513-8", "FreshPantry"))).toEqual({ kind: "gst", value: "M287615138" });
    expect(counterpartyKey(party(null, null, "Chen Mei Lin"))).toEqual({ kind: "name", value: "chen mei lin" });
    expect(counterpartyKey(party(null, " ", null))).toBeNull();
    expect(counterpartyKeyText({ kind: "uen", value: "X" })).toBe("uen:X");
  });

  it("compares two lines on the strongest identifier BOTH carry", () => {
    // A photo whose UEN was not read still matches the PDF on the name.
    expect(sameCounterparty(party("201560913X", null, "FreshPantry Supplies Pte Ltd"), party(null, null, "FRESHPANTRY SUPPLIES"))).toBe(true);
    // Two UENs that differ are two companies, whatever the names say.
    expect(sameCounterparty(party("201560913X", null, "FreshPantry"), party("201560914Y", null, "FreshPantry"))).toBe(false);
    // Two GST numbers that differ, likewise.
    expect(sameCounterparty(party(null, "M2-1", "A"), party(null, "M2-2", "A"))).toBe(false);
    // Nothing in common: not the same.
    expect(sameCounterparty(party("201560913X", null, null), party(null, "M2-1", null))).toBe(false);
  });
});
