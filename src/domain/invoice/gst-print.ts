// What a GST tax invoice PRINTS (Q056, S5): CGST Rule 46, field by field.
// Pure, stdlib only. The render source reads the figures (Postgres added them
// up) and the frozen facts; this decides the words, the columns and the order.
//
// Rule 46 asks, beside what every invoice of this product already prints
// (both parties' names, addresses and GSTINs, a consecutive number, the date,
// the description, the value, the total in words):
//   (f)   the SAC of each service              -> the SAC column
//   (j)   the taxable value after discount     -> the Taxable value column
//   (k,l) the rate and amount of each tax      -> GST % column, the totals and
//                                                 the SAC-wise summary
//   (m)   the place of supply, with the state  -> "Place of supply" in the head
//   (o)   whether tax is payable on reverse
//         charge                               -> a declaration line
//   (p)   signature of the supplier            -> "For <company>, Authorised
//                                                 signatory"
//   export: "Supply meant for export under LUT without payment of IGST", the
//   LUT, and the country of destination.
// The line table carries no per-line tax amounts: on a service invoice the
// rate per line and the amounts per SAC and rate (the same summary GSTR-1 asks
// for) say it once, and an A4 page cannot hold nine money columns.
import type { LineTable, MetaRow, TaxInvoicePrint, TotalRow } from "../render/model";
import { amountInWords } from "../render/money";
import type { TaxTreatment } from "./gst";
import { isZero, stateLabel, trimRate } from "./gst";

export interface GstPrintInput {
  readonly treatment: Exclude<TaxTreatment, "plain">;
  readonly currency: string;
  /** How an amount prints (the render source's `documentMoney`). */
  readonly money: (amount: string) => string;
  readonly countryName: (code: string) => string;
  readonly supplierName: string;
  readonly placeOfSupplyStateCode: string | null;
  readonly placeOfSupplyCountry: string | null;
  readonly lines: readonly {
    readonly description: string;
    readonly sac: string | null;
    readonly quantity: string;
    readonly unitAmount: string;
    readonly taxPercent: string;
    /** The taxable value: after discount. */
    readonly net: string;
  }[];
  /** Per SAC and rate, summed by Postgres. */
  readonly summary: readonly {
    readonly sac: string | null;
    readonly taxPercent: string;
    readonly taxable: string;
    readonly cgst: string;
    readonly sgst: string;
    readonly utgst: string;
    readonly igst: string;
    /** All the tax on the row, summed by Postgres. */
    readonly tax: string;
  }[];
  readonly totals: {
    readonly gross: string;
    readonly discount: string;
    readonly net: string;
    readonly tax: string;
    readonly total: string;
    readonly cgst: string;
    readonly sgst: string;
    readonly utgst: string;
    readonly igst: string;
  };
  /** The tax in INR at the invoice's rate, when it is in another currency and
   *  charges tax; else null. */
  readonly taxInInr: { readonly amount: string; readonly printed: string; readonly rate: string } | null;
  readonly lut: { readonly reference: string; readonly yearLabel: string } | null;
  readonly bank: {
    readonly accountName: string;
    readonly accountNumber: string;
    readonly bankName: string;
    readonly branch: string | null;
    readonly ifsc: string | null;
    readonly swift: string | null;
    readonly iban: string | null;
  } | null;
}

export interface GstPrint {
  readonly meta: readonly MetaRow[];
  readonly table: LineTable;
  /** Sub-total to Total; the TDS rows are the caller's (any invoice has them). */
  readonly totals: readonly TotalRow[];
  readonly print: TaxInvoicePrint;
}

/** The second tax of an intra-state invoice: SGST, or UTGST in a union
 *  territory without a legislature. */
function secondTax(t: GstPrintInput["treatment"]): "SGST" | "UTGST" {
  return t === "gst_intra_ut" ? "UTGST" : "SGST";
}

function intra(t: GstPrintInput["treatment"]): boolean {
  return t === "gst_intra" || t === "gst_intra_ut";
}

/** "@9%" when every taxed line shares one rate, else nothing: the summary
 *  says each. */
function sharedRate(rates: readonly string[], half: boolean): string {
  const distinct = [...new Set(rates.map((r) => trimRate(r)))];
  if (distinct.length !== 1 || distinct[0] === undefined) return "";
  const r = distinct[0];
  if (!half) return ` @${r}%`;
  return ` @${trimRate(String(Number(r) / 2))}%`;
}

export function placeOfSupplyText(input: {
  readonly stateCode: string | null;
  readonly country: string | null;
  readonly countryName: (code: string) => string;
}): string | null {
  if (input.stateCode !== null) return stateLabel(input.stateCode);
  if (input.country !== null) return `Outside India (${input.countryName(input.country)})`;
  return null;
}

export function gstPrint(i: GstPrintInput): GstPrint {
  const pos = placeOfSupplyText({
    stateCode: i.placeOfSupplyStateCode,
    country: i.placeOfSupplyCountry,
    countryName: i.countryName,
  });
  const meta: MetaRow[] = pos === null ? [] : [{ label: "Place of supply", value: pos }];

  const table: LineTable = {
    columns: [
      { label: "Description", align: "left", weight: 6 },
      { label: "SAC", align: "left", weight: 1.4 },
      { label: "Qty", align: "right", weight: 0.8 },
      { label: "Rate", align: "right", weight: 2 },
      { label: "GST %", align: "right", weight: 1 },
      { label: "Taxable value", align: "right", weight: 2.3 },
    ],
    rows: i.lines.map((l) => [
      l.description,
      l.sac ?? "",
      String(Number(l.quantity)),
      i.money(l.unitAmount),
      i.treatment === "gst_export_lut" ? "0" : trimRate(l.taxPercent),
      i.money(l.net),
    ]),
  };

  const taxedRates = i.lines.filter((l) => !isZero(l.taxPercent)).map((l) => l.taxPercent);
  const totals: TotalRow[] = [{ label: "Sub-total", value: i.money(i.totals.gross), emphasis: false }];
  if (!isZero(i.totals.discount)) {
    totals.push({ label: "Discount", value: i.money(i.totals.discount), emphasis: false });
    totals.push({ label: "Taxable value", value: i.money(i.totals.net), emphasis: false });
  }
  if (intra(i.treatment)) {
    const at = sharedRate(taxedRates, true);
    totals.push({ label: `CGST${at}`, value: i.money(i.totals.cgst), emphasis: false });
    totals.push({
      label: `${secondTax(i.treatment)}${at}`,
      value: i.money(i.treatment === "gst_intra_ut" ? i.totals.utgst : i.totals.sgst),
      emphasis: false,
    });
  } else if (i.treatment === "gst_export_lut") {
    totals.push({ label: "IGST @0% (export under LUT)", value: i.money(i.totals.igst), emphasis: false });
  } else {
    totals.push({ label: `IGST${sharedRate(taxedRates, false)}`, value: i.money(i.totals.igst), emphasis: false });
  }
  totals.push({ label: "Total", value: i.money(i.totals.total), emphasis: true });

  const summary: LineTable = intra(i.treatment)
    ? {
        columns: [
          { label: "SAC", align: "left", weight: 1.3 },
          { label: "Taxable value", align: "right", weight: 2.2 },
          { label: "CGST %", align: "right", weight: 1 },
          { label: "CGST", align: "right", weight: 2 },
          { label: `${secondTax(i.treatment)} %`, align: "right", weight: 1.1 },
          { label: secondTax(i.treatment), align: "right", weight: 2 },
          { label: "Total tax", align: "right", weight: 2.2 },
        ],
        rows: i.summary.map((s) => [
          s.sac ?? "",
          i.money(s.taxable),
          trimRate(String(Number(s.taxPercent) / 2)),
          i.money(s.cgst),
          trimRate(String(Number(s.taxPercent) / 2)),
          i.money(i.treatment === "gst_intra_ut" ? s.utgst : s.sgst),
          i.money(s.tax),
        ]),
        keepTogether: true,
      }
    : {
        columns: [
          { label: "SAC", align: "left", weight: 1.3 },
          { label: "Taxable value", align: "right", weight: 2.4 },
          { label: "IGST %", align: "right", weight: 1 },
          { label: "IGST", align: "right", weight: 2.2 },
          { label: "Total tax", align: "right", weight: 2.4 },
        ],
        rows: i.summary.map((s) => [
          s.sac ?? "",
          i.money(s.taxable),
          i.treatment === "gst_export_lut" ? "0" : trimRate(s.taxPercent),
          i.money(s.igst),
          i.money(s.tax),
        ]),
        keepTogether: true,
      };

  const declarations: string[] = ["Whether tax is payable on reverse charge: No"];
  if (i.treatment === "gst_export_lut" && i.lut !== null) {
    declarations.push(
      `Supply meant for export under LUT without payment of IGST. LUT ARN ${i.lut.reference} (FY ${i.lut.yearLabel}).`,
    );
  }
  if (i.treatment === "gst_export_igst") {
    declarations.push("Supply meant for export on payment of IGST.");
  }
  if (i.taxInInr !== null && !isZero(i.taxInInr.amount)) {
    declarations.push(`Tax in Indian Rupees at ${i.taxInInr.rate.replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1")} per ${i.currency.toUpperCase()}: ${i.taxInInr.printed}.`);
  }

  const bank: string[] =
    i.bank === null
      ? []
      : [
          `Account name: ${i.bank.accountName}`,
          `Account number: ${i.bank.accountNumber}`,
          `Bank: ${i.bank.branch === null ? i.bank.bankName : `${i.bank.bankName}, ${i.bank.branch}`}`,
          ...(i.bank.ifsc === null ? [] : [`IFSC: ${i.bank.ifsc}`]),
          ...(i.bank.swift === null ? [] : [`SWIFT: ${i.bank.swift}`]),
          ...(i.bank.iban === null ? [] : [`IBAN: ${i.bank.iban}`]),
        ];

  return {
    meta,
    table,
    totals,
    print: {
      taxInWords: isZero(i.totals.tax) ? null : amountInWords(i.totals.tax, i.currency),
      summary,
      declarations,
      bank,
      signatoryFor: `For ${i.supplierName}`,
    },
  };
}

/** The TDS rows any invoice prints under its total when its client deducts
 *  (Q057): the deduction, on the amount before tax, and the net payable. */
export function tdsRows(input: {
  readonly section: string;
  readonly percent: string;
  readonly tds: string;
  readonly netPayable: string;
  readonly money: (amount: string) => string;
}): readonly TotalRow[] {
  return [
    {
      label: `Less: TDS u/s ${input.section} @${trimRate(input.percent)}% (on the amount before tax)`,
      value: `(${input.money(input.tds)})`,
      emphasis: false,
    },
    { label: "Net amount payable", value: input.money(input.netPayable), emphasis: true },
  ];
}
