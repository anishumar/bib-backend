// F4.3: the document checks, each with the case it exists for, its boundaries
// and the near misses it must leave alone.
import { describe, expect, it } from "vitest";
import { checkDocuments } from "../../src/domain/fin/checks-documents";
import type { CheckedDocumentLine, ClientFacts, DocumentCheckInput } from "../../src/domain/fin/checks-input";
import { CheckInputInvalid } from "../../src/domain/fin/errors";
import { findingDraftProblem } from "../../src/domain/fin/finding";
import type { FindingDraft } from "../../src/domain/fin/finding";
import { RuleParameters } from "../../src/domain/fin/parameters";
import { SINGAPORE_PARAMETERS } from "../../src/testfakes/fin-findings";

const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const parameters = RuleParameters.from("SG", SINGAPORE_PARAMETERS);
const registered: ClientFacts = { clientPartyId: CLIENT, gstRegisteredFrom: "2015-01-01", fiscalYearStartMonth: 1 };
const notRegistered: ClientFacts = { clientPartyId: CLIENT, gstRegisteredFrom: null, fiscalYearStartMonth: 1 };
const YEAR = { start: "2025-01-01", end: "2025-12-31" } as const;

let n = 0;
function doc(over: Partial<CheckedDocumentLine> = {}): CheckedDocumentLine {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
    clientPartyId: CLIENT,
    kind: "document",
    docType: "purchase_invoice",
    counterpartyName: "Singa Mobile and Fibre Pte Ltd",
    counterpartyUen: "200937950R",
    counterpartyGstNo: "M2-6518956-4",
    docNumber: `K0${String(3000 + n)}`,
    docDate: "2025-04-21",
    currency: "SGD",
    fxRate: null,
    net: "575.00",
    gstRate: null,
    gst: "51.75",
    total: "626.75",
    servicePeriodFrom: null,
    servicePeriodTo: null,
    creditNoteRef: null,
    provenance: { documentVersionId: "00000000-0000-4000-8000-00000000f001", page: 1, row: null },
    uncertain: [],
    ...over,
  };
}

function run(
  lines: readonly CheckedDocumentLine[],
  over: Partial<DocumentCheckInput> = {},
): FindingDraft[] {
  return checkDocuments({ client: registered, period: YEAR, lines, history: [], parameters, ...over });
}

const keys = (findings: readonly FindingDraft[]) => findings.map((f) => f.checkKey);

describe("every finding a check produces is one the store can keep", () => {
  it("lane rule, a valid draft, and the client's", () => {
    const findings = run([doc({ gst: "46.00", total: "621.00" }), doc({ docDate: "2024-12-17" })]);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.lane).toBe("rule");
      expect(f.clientPartyId).toBe(CLIENT);
      expect(findingDraftProblem(f)).toBeNull();
    }
  });

  it("a clean purchase invoice raises nothing", () => {
    expect(run([doc()])).toEqual([]);
  });
});

describe("doc.duplicate_invoice", () => {
  it("the same counterparty, number and amount twice (A-X06)", () => {
    const first = doc({ docNumber: "SI/25/2839", total: "817.50", gst: "67.50" });
    const copy = doc({ docNumber: "SI/25/2839", total: "817.50", gst: "67.50" });
    const [f, ...rest] = run([first, copy]).filter((x) => x.checkKey === "doc.duplicate_invoice");
    expect(rest).toEqual([]);
    expect(f?.lineIds).toEqual([first.id, copy.id]);
    expect(f?.facts).toMatchObject({ docNumber: "SI/25/2839", total: "817.50", copies: 2, counterpartyKeyKind: "uen" });
    expect(f?.dedupeKey).toBe(`doc.duplicate_invoice:${first.id}:2`);
  });

  it("matches a photo with no UEN read to the PDF on the supplier's name", () => {
    const pdf = doc({ docNumber: "INV2500236", net: "1151.00", gst: "0", total: "1151.00", counterpartyName: "Chen Mei Lin (Freelance Designer)", counterpartyUen: null, counterpartyGstNo: null });
    const photo = doc({ docNumber: "inv2500236 ", net: "1151.00", gst: "0", total: "1151.0", counterpartyName: "CHEN MEI LIN (freelance designer)", counterpartyUen: null, counterpartyGstNo: null });
    expect(keys(run([pdf, photo]))).toEqual(["doc.duplicate_invoice"]);
  });

  it("is caught against history, and raised once the copy is this period's", () => {
    const august = doc({ docNumber: "IN000215", total: "7516.64", gst: "620.64", net: "6896.00" });
    const september = doc({ docNumber: "IN000215", total: "7516.64", gst: "620.64", net: "6896.00" });
    expect(keys(run([september], { history: [august] }))).toEqual(["doc.duplicate_invoice"]);
    // A group wholly in history was raised when it was that period's.
    expect(run([], { history: [august, september] })).toEqual([]);
  });

  it("near misses: another amount, another number, another supplier, another kind of document", () => {
    const base = { docNumber: "SI/25/2839", total: "817.50", gst: "67.50", net: "750.00" };
    expect(keys(run([doc(base), doc({ ...base, total: "817.51", gst: "67.51" })]))).not.toContain("doc.duplicate_invoice");
    expect(keys(run([doc(base), doc({ ...base, docNumber: "SI/25/2840" })]))).not.toContain("doc.duplicate_invoice");
    expect(keys(run([doc(base), doc({ ...base, counterpartyUen: "201560913X" })]))).not.toContain("doc.duplicate_invoice");
    expect(keys(run([doc(base), doc({ ...base, docType: "receipt" })]))).not.toContain("doc.duplicate_invoice");
  });

  it("three copies are one finding of three", () => {
    const base = { docNumber: "A03546", total: "981.00", gst: "81.00", net: "900.00" };
    const found = run([doc(base), doc(base), doc(base)]).filter((f) => f.checkKey === "doc.duplicate_invoice");
    expect(found).toHaveLength(1);
    expect(found[0]?.facts["copies"]).toBe(3);
  });
});

describe("doc.gst_rate", () => {
  it("8% charged in 2025, where 9% was in force (A-X01)", () => {
    const [f] = run([doc({ net: "575.00", gst: "46.00", total: "621.00" })]);
    expect(f?.checkKey).toBe("doc.gst_rate");
    expect(f?.facts).toMatchObject({
      rateInForce: "9",
      base: "575.00",
      gst: "46.00",
      expectedGst: "51.75",
      difference: "-5.75",
      mismatch: "amount",
    });
  });

  it("each side of the 2024 change: 8% on 31 December 2023 is right, on 1 January 2024 is not", () => {
    const eight = { net: "100.00", gst: "8.00", total: "108.00" };
    expect(run([doc({ ...eight, docDate: "2023-12-31" })], { period: { start: "2023-01-01", end: "2023-12-31" } })).toEqual([]);
    expect(keys(run([doc({ ...eight, docDate: "2024-01-01" })], { period: { start: "2024-01-01", end: "2024-12-31" } }))).toEqual([
      "doc.gst_rate",
    ]);
  });

  it("each side of the 2023 change: 7% on 31 December 2022 is right, on 1 January 2023 is not", () => {
    const seven = { net: "100.00", gst: "7.00", total: "107.00" };
    const y22 = { start: "2022-01-01", end: "2022-12-31" };
    const y23 = { start: "2023-01-01", end: "2023-12-31" };
    expect(run([doc({ ...seven, docDate: "2022-12-31" })], { period: y22 })).toEqual([]);
    expect(keys(run([doc({ ...seven, docDate: "2023-01-01" })], { period: y23 }))).toEqual(["doc.gst_rate"]);
  });

  it("to the cent: a cent out is a finding, the right cent is not", () => {
    expect(run([doc({ net: "575.00", gst: "51.75", total: "626.75" })])).toEqual([]);
    expect(keys(run([doc({ net: "575.00", gst: "51.74", total: "626.74" })]))).toEqual(["doc.gst_rate"]);
  });

  it("charges GST on the subtotal plus the service charge (a restaurant bill is not a finding)", () => {
    // A-RC-0002: subtotal 153.43, GST 15.19, total 183.96: 9% of 168.77.
    expect(run([doc({ docType: "receipt", net: "153.43", gst: "15.19", total: "183.96" })])).toEqual([]);
  });

  it("a printed rate that is not the rate in force, even where the amount follows it", () => {
    const [f] = run([doc({ gstRate: "8", net: "575.00", gst: "46.00", total: "621.00" })]);
    expect(f?.facts).toMatchObject({ printedRate: "8", mismatch: "amount_and_printed_rate" });
    const [g] = run([doc({ gstRate: "8" })]);
    expect(g?.facts).toMatchObject({ printedRate: "8", mismatch: "printed_rate" });
    expect(run([doc({ gstRate: "9.0" })])).toEqual([]);
  });

  it("holds a POS summary to the rate to a hundredth of a percent, not to the cent", () => {
    const pos = { docType: "pos_summary" as const, counterpartyName: null, counterpartyUen: null, counterpartyGstNo: null };
    expect(run([doc({ ...pos, net: "129315.82", gst: "11638.43", total: "140954.25" })])).toEqual([]);
    expect(keys(run([doc({ ...pos, net: "129315.82", gst: "10345.27", total: "139661.09" })]))).toEqual(["doc.gst_rate"]);
  });

  it("holds a credit note to the rate of the invoice it credits", () => {
    const invoice = doc({ docType: "sales_invoice", docNumber: "INV-23-0007", docDate: "2023-11-30", net: "1000.00", gst: "80.00", total: "1080.00" });
    const note = doc({ docType: "credit_note", docNumber: "CN-24-0001", docDate: "2024-02-01", creditNoteRef: "INV-23-0007", net: "-1000.00", gst: "-80.00", total: "-1080.00" });
    const found = run([note], { history: [invoice], period: { start: "2024-01-01", end: "2024-12-31" } });
    expect(keys(found)).toEqual(["doc.credit_note"]);
  });

  it("leaves alone what it cannot check: no GST, a customs permit, no date, an unseeded day", () => {
    expect(run([doc({ gst: "0.00", total: "575.00" })])).toEqual([]);
    expect(run([doc({ docType: "customs_permit", net: null, gst: "5046.45", total: "5046.45", counterpartyGstNo: null })])).toEqual([]);
    expect(keys(run([doc({ docDate: null, gst: "46.00", total: "621.00" })]))).toEqual([]);
    const since1994: ClientFacts = { ...registered, gstRegisteredFrom: "1994-04-01" };
    expect(
      run([doc({ docDate: "2006-01-01", gst: "46.00", total: "621.00" })], {
        client: since1994,
        period: { start: "2006-01-01", end: "2006-12-31" },
      }),
    ).toEqual([]);
  });
});

describe("doc.invalid_tax_invoice", () => {
  it("GST charged with no supplier GST number (A-X02)", () => {
    const [f] = run([doc({ docNumber: "SI/25/2842", counterpartyGstNo: null, net: "792.00", gst: "71.28", total: "863.28" })]);
    expect(f?.checkKey).toBe("doc.invalid_tax_invoice");
    expect(f?.facts).toMatchObject({ gst: "71.28", gstNumberUncertain: false, clientGstRegistered: true });
  });

  it("a number the reader was not sure of is flagged, and says so", () => {
    const [f] = run([doc({ uncertain: ["counterpartyGstNo"] })]);
    expect(f?.facts).toMatchObject({ gstNumberUncertain: true });
  });

  it("near misses: no GST charged, a blank-looking number that is there, the client's own sale, a customs permit", () => {
    expect(run([doc({ counterpartyGstNo: null, gst: "0.00", total: "575.00" })])).toEqual([]);
    expect(run([doc({ counterpartyGstNo: " M2-1 " })])).toEqual([]);
    expect(run([doc({ docType: "sales_invoice", counterpartyGstNo: null })])).toEqual([]);
    expect(run([doc({ docType: "customs_permit", counterpartyGstNo: null, net: null, gst: "10.00", total: "10.00" })])).toEqual([]);
  });

  it("flags a blank number as no number", () => {
    expect(keys(run([doc({ counterpartyGstNo: "   " })]))).toEqual(["doc.invalid_tax_invoice"]);
  });
});

describe("doc.out_of_period", () => {
  it("dated before the financial year (A-X07)", () => {
    const [f] = run([doc({ docDate: "2024-12-17" })]);
    expect(f?.checkKey).toBe("doc.out_of_period");
    expect(f?.facts).toMatchObject({ docDate: "2024-12-17", financialYearStart: "2025-01-01" });
  });

  it("the boundary: 31 December is the year before, 1 January is not", () => {
    expect(keys(run([doc({ docDate: "2024-12-31" })]))).toEqual(["doc.out_of_period"]);
    expect(run([doc({ docDate: "2025-01-01" })])).toEqual([]);
  });

  it("follows the client's own year: an April year starts on 1 April", () => {
    const april: ClientFacts = { ...registered, fiscalYearStartMonth: 4 };
    const october = { start: "2025-10-01", end: "2025-10-31" };
    expect(run([doc({ docDate: "2025-04-01" })], { client: april, period: october })).toEqual([]);
    expect(keys(run([doc({ docDate: "2025-03-31" })], { client: april, period: october }))).toEqual(["doc.out_of_period"]);
  });

  it("a document from earlier in the same year is late, not out of period", () => {
    expect(run([doc({ docDate: "2025-09-03" })], { period: { start: "2025-10-01", end: "2025-10-31" } })).toEqual([]);
  });
});

describe("doc.cutoff", () => {
  it("dated after the period, for services inside it (A-X08)", () => {
    const [f] = run([doc({ docDate: "2026-01-06", servicePeriodFrom: "2025-12-01", servicePeriodTo: "2025-12-31" })]);
    expect(f?.checkKey).toBe("doc.cutoff");
    expect(f?.facts).toMatchObject({ docDate: "2026-01-06", servicePeriodKnown: true });
  });

  it("with no service period read, still asks a person", () => {
    const [f] = run([doc({ docDate: "2026-01-06" })]);
    expect(f?.facts).toMatchObject({ servicePeriodKnown: false });
  });

  it("near misses: dated on the period's last day, or wholly for a later period", () => {
    expect(run([doc({ docDate: "2025-12-31" })])).toEqual([]);
    expect(run([doc({ docDate: "2026-01-06", servicePeriodFrom: "2026-01-01", servicePeriodTo: "2026-01-31" })])).toEqual([]);
  });

  it("services that START inside the period and run past it are still this period's in part", () => {
    expect(keys(run([doc({ docDate: "2026-01-06", servicePeriodFrom: "2025-12-15", servicePeriodTo: "2026-01-14" })]))).toEqual([
      "doc.cutoff",
    ]);
  });
});

describe("doc.gst_not_claimable and doc.gst_charged_not_registered", () => {
  it("one finding for every purchase carrying GST at a client not registered (E-X01)", () => {
    const rent = doc({ docNumber: "IN000759", net: "2400.00", gst: "216.00", total: "2616.00" });
    const phone = doc({ docNumber: "INV2502610", net: "82.58", gst: "7.43", total: "90.01" });
    const meal = doc({ docType: "receipt", docNumber: "228886", net: "200.43", gst: "19.84", total: "240.31" });
    const freelancer = doc({ docNumber: "INV2500236", gst: "0.00", total: "1151.00", counterpartyGstNo: null });
    const found = run([rent, phone, meal, freelancer], { client: notRegistered });
    expect(keys(found)).toEqual(["doc.gst_not_claimable"]);
    expect(found[0]?.lineIds).toEqual([rent.id, phone.id, meal.id].sort());
    expect(found[0]?.facts).toMatchObject({ documents: 3, gst: "243.27", currency: "SGD", gstRegisteredFrom: null });
  });

  it("its key carries the count and the total, so a late document raises it again", () => {
    const one = doc({ gst: "216.00", total: "2616.00", net: "2400.00" });
    const two = doc({ gst: "7.43", total: "90.01", net: "82.58" });
    const before = run([one], { client: notRegistered })[0]?.dedupeKey;
    const after = run([one, two], { client: notRegistered })[0]?.dedupeKey;
    expect(before).not.toBe(after);
    expect(run([one], { client: notRegistered })[0]?.dedupeKey).toBe(before);
  });

  it("a client registered part-way: only what is dated before registration", () => {
    const fromJuly: ClientFacts = { ...notRegistered, gstRegisteredFrom: "2025-07-01" };
    const june = doc({ docDate: "2025-06-30" });
    const july = doc({ docDate: "2025-07-01" });
    const found = run([june, july], { client: fromJuly });
    expect(found.find((f) => f.checkKey === "doc.gst_not_claimable")?.lineIds).toEqual([june.id]);
  });

  it("a registered client's purchases are not this finding", () => {
    expect(run([doc()])).toEqual([]);
  });

  it("a client not registered that CHARGED GST on its own sale", () => {
    const sale = doc({ docType: "sales_invoice", counterpartyName: "Bayfront Dental", counterpartyGstNo: null, net: "1250.00", gst: "112.50", total: "1362.50" });
    expect(keys(run([sale], { client: notRegistered }))).toEqual(["doc.gst_charged_not_registered"]);
    expect(run([doc({ ...sale, gst: "0.00", total: "1250.00" })], { client: notRegistered })).toEqual([]);
  });
});

describe("doc.credit_note", () => {
  it("every credit note is a thing to settle, with the invoice it credits when it is there (A-X04)", () => {
    const invoice = doc({ docType: "sales_invoice", docNumber: "INV-25-1006", counterpartyName: "Orchid Healthcare Services Pte Ltd", counterpartyUen: "201137488B", net: "3200.00", gst: "288.00", total: "3488.00" });
    const note = doc({ docType: "credit_note", docNumber: "CN-25-0002", docDate: "2025-10-06", creditNoteRef: "INV-25-1006", counterpartyName: "Orchid Healthcare Services Pte Ltd", counterpartyUen: "201137488B", net: "3200.00", gst: "288.00", total: "3488.00" });
    const [f] = run([note], { history: [invoice] });
    expect(f?.checkKey).toBe("doc.credit_note");
    expect(f?.lineIds).toEqual([note.id, invoice.id]);
    expect(f?.facts).toMatchObject({ creditNoteRef: "INV-25-1006", invoiceFound: true });
  });

  it("raised with invoiceFound false when the reference is missing or is another party's", () => {
    const invoice = doc({ docType: "sales_invoice", docNumber: "INV-25-1006", counterpartyUen: "201137488B" });
    const stranger = doc({ docType: "credit_note", creditNoteRef: "INV-25-1006", counterpartyUen: "209999999Z" });
    const [f] = run([stranger], { history: [invoice] });
    expect(f?.lineIds).toEqual([stranger.id]);
    expect(f?.facts).toMatchObject({ invoiceFound: false });
    expect(run([doc({ docType: "credit_note", creditNoteRef: null })])[0]?.facts).toMatchObject({ invoiceFound: false });
  });
});

describe("raised once however often it runs", () => {
  it("the same lines give the same findings with the same keys, in the same order", () => {
    const lines = [doc({ gst: "46.00", total: "621.00" }), doc({ docDate: "2024-12-17" }), doc({ docDate: "2026-01-06" })];
    expect(run(lines)).toEqual(run([...lines].reverse()));
  });

  it("no key names a counterparty", () => {
    const lines = [doc({ counterpartyName: "Chen Mei Lin", counterpartyUen: null, counterpartyGstNo: null, docNumber: "X1", gst: "0", total: "10.00" })];
    const copy = { ...lines[0], id: "00000000-0000-4000-8000-0000000fffff" } as CheckedDocumentLine;
    for (const f of run([...lines, copy])) expect(f.dedupeKey.toLowerCase()).not.toContain("chen");
  });
});

describe("input a check cannot read", () => {
  it("refuses another client's line, and a period that is not two days in order", () => {
    expect(() => run([doc({ clientPartyId: "00000000-0000-4000-8000-0000000000c2" })])).toThrow(CheckInputInvalid);
    expect(() => run([], { period: { start: "2025-12-31", end: "2025-01-01" } })).toThrow(CheckInputInvalid);
    expect(() => run([], { period: { start: "2025-02-30", end: "2025-03-01" } })).toThrow(CheckInputInvalid);
    expect(() => run([], { client: { ...registered, fiscalYearStartMonth: 13 } })).toThrow(CheckInputInvalid);
  });
});
