// An Indian GST tax invoice: which tax, on what, at whose place (Q056, S5,
// 2026-10-05). Pure, stdlib only: nothing here reads a table or a clock.
//
// Four facts decide everything a GST invoice says about tax, and each has one
// source:
//
//  - the SUPPLIER'S STATE: the first two digits of the issuing company's GSTIN,
//    which is the state the company is registered in for GST;
//  - the PLACE OF SUPPLY: for a professional service, the recipient's location
//    (IGST Act s.12(2)): the state code of the client's GSTIN when it has one,
//    else the state of its billing address, else "outside India";
//  - an LUT in force for the issue date's financial year, for an export;
//  - the RATE, which is per line because it is per service.
//
// From those, CGST + SGST (same state), CGST + UTGST (the same union territory
// without a legislature), IGST (another state, or an export without an LUT), or
// zero-rated (an export under an LUT). A company outside India, or an Indian
// company with no GSTIN, issues a PLAIN invoice: one "Tax" figure, as before.
//
// THE ARITHMETIC IS DONE TWICE, ON PURPOSE. `crm.invoice_line_amount` (0370)
// computes every figure an invoice's balance is built on, because only the
// database adds money up. `lineTax` below computes the same figures exactly
// (BigInt, never a `number`), so the rule can be tested case by case without a
// database, and `tests/invoice/gst.integration.test.ts` holds the two equal.
// Rounding is per line and per component: CGST and SGST are each rounded to the
// currency's minor unit, half away from zero, and the line's tax is their sum,
// which is what Zoho Books and ClearTax print. Tally rounds per ledger; a firm
// that wants a round-off line asks for one (drafted to 10x, S5).

// ── The states and union territories, by GST state code ────────────────────

/** A GST state code: two digits, as the first two characters of a GSTIN. */
export type GstStateCode = string;

export interface IndianState {
  readonly code: GstStateCode;
  readonly name: string;
  /** A union territory WITHOUT a legislature: tax within it is CGST + UTGST.
   *  Delhi, Puducherry and Jammu and Kashmir have one, and charge SGST. */
  readonly utgst: boolean;
}

/** Every state code the GST portal issues. 25 (Daman and Diu) merged into 26 in
 *  2020; 28 is the pre-2014 Andhra Pradesh, still on old GSTINs. 97 is "Other
 *  Territory" (offshore), 99 the Centre's jurisdiction. */
export const INDIAN_STATES: readonly IndianState[] = [
  { code: "01", name: "Jammu and Kashmir", utgst: false },
  { code: "02", name: "Himachal Pradesh", utgst: false },
  { code: "03", name: "Punjab", utgst: false },
  { code: "04", name: "Chandigarh", utgst: true },
  { code: "05", name: "Uttarakhand", utgst: false },
  { code: "06", name: "Haryana", utgst: false },
  { code: "07", name: "Delhi", utgst: false },
  { code: "08", name: "Rajasthan", utgst: false },
  { code: "09", name: "Uttar Pradesh", utgst: false },
  { code: "10", name: "Bihar", utgst: false },
  { code: "11", name: "Sikkim", utgst: false },
  { code: "12", name: "Arunachal Pradesh", utgst: false },
  { code: "13", name: "Nagaland", utgst: false },
  { code: "14", name: "Manipur", utgst: false },
  { code: "15", name: "Mizoram", utgst: false },
  { code: "16", name: "Tripura", utgst: false },
  { code: "17", name: "Meghalaya", utgst: false },
  { code: "18", name: "Assam", utgst: false },
  { code: "19", name: "West Bengal", utgst: false },
  { code: "20", name: "Jharkhand", utgst: false },
  { code: "21", name: "Odisha", utgst: false },
  { code: "22", name: "Chhattisgarh", utgst: false },
  { code: "23", name: "Madhya Pradesh", utgst: false },
  { code: "24", name: "Gujarat", utgst: false },
  { code: "26", name: "Dadra and Nagar Haveli and Daman and Diu", utgst: true },
  { code: "27", name: "Maharashtra", utgst: false },
  { code: "28", name: "Andhra Pradesh (old)", utgst: false },
  { code: "29", name: "Karnataka", utgst: false },
  { code: "30", name: "Goa", utgst: false },
  { code: "31", name: "Lakshadweep", utgst: true },
  { code: "32", name: "Kerala", utgst: false },
  { code: "33", name: "Tamil Nadu", utgst: false },
  { code: "34", name: "Puducherry", utgst: false },
  { code: "35", name: "Andaman and Nicobar Islands", utgst: true },
  { code: "36", name: "Telangana", utgst: false },
  { code: "37", name: "Andhra Pradesh", utgst: false },
  { code: "38", name: "Ladakh", utgst: true },
  { code: "97", name: "Other Territory", utgst: true },
];

const BY_CODE = new Map(INDIAN_STATES.map((s) => [s.code, s]));

export function stateByCode(code: string): IndianState | null {
  return BY_CODE.get(code) ?? null;
}

/** How a state is written on an invoice: `Maharashtra (27)`. */
export function stateLabel(code: string): string {
  const s = stateByCode(code);
  return s === null ? code : `${s.name} (${s.code})`;
}

/** Other spellings people type, mapped to the code. Lower case, `&` as "and". */
const ALIASES: Readonly<Record<string, GstStateCode>> = {
  "new delhi": "07",
  "nct of delhi": "07",
  "national capital territory of delhi": "07",
  orissa: "21",
  pondicherry: "34",
  "andaman and nicobar": "35",
  "daman and diu": "26",
  "dadra and nagar haveli": "26",
  "andhra pradesh (new)": "37",
  uttaranchal: "05",
  "j and k": "01",
  "jammu kashmir": "01",
};

function normaliseRegion(region: string): string {
  return region
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The state a free-text region names, or null. Exact names and the usual other
 * spellings only: a guess at "Mumbai" or a fuzzy match would put a wrong state
 * on a tax document, and "we could not tell" is the answer a person can fix.
 * A two-digit code is accepted too ("27").
 */
export function stateCodeOfRegion(region: string | null): GstStateCode | null {
  if (region === null) return null;
  const n = normaliseRegion(region);
  if (n === "") return null;
  if (/^\d{2}$/.test(n)) return BY_CODE.has(n) ? n : null;
  for (const s of INDIAN_STATES) if (normaliseRegion(s.name) === n) return s.code;
  return ALIASES[n] ?? null;
}

/** The state a GSTIN is registered in: its first two digits, when they are a
 *  code the portal issues. Null for anything else. */
export function stateCodeOfGstin(gstin: string | null): GstStateCode | null {
  if (gstin === null) return null;
  const code = gstin.trim().slice(0, 2);
  return /^\d{2}$/.test(code) && BY_CODE.has(code) ? code : null;
}

// ── SAC ────────────────────────────────────────────────────────────────────

/** A Services Accounting Code: chapter 99, six digits (998222 is accounting
 *  and bookkeeping). Six because Notification 78/2020 asks six of a firm over
 *  ₹5 crore and four of a smaller one only on B2B, and six is always valid. */
export function isSac(v: string): boolean {
  return /^99\d{4}$/.test(v);
}

// ── Place of supply ────────────────────────────────────────────────────────

export type PlaceOfSupply =
  | { readonly kind: "state"; readonly stateCode: GstStateCode }
  | { readonly kind: "outside_india"; readonly country: string | null }
  /** IGST Act s.12(2)(b): an unregistered recipient whose address is not on
   *  record is supplied at the SUPPLIER's location. */
  | { readonly kind: "supplier_location" }
  /** An address is on record but no state can be read from it: a person
   *  chooses the state on the invoice. */
  | { readonly kind: "unknown" };

/**
 * Where a service to this client is supplied, for an invoice from an Indian
 * company (IGST Act s.12(2) and s.13(2): the recipient's location).
 *
 * In order: a state a PERSON CHOSE on the invoice; the client's GSTIN's state
 * (where it is registered, which is what the return is filed against); the
 * state of its address; with no address on record at all, the supplier's own
 * location (s.12(2)(b)); else unknown (an address whose state cannot be read).
 * A client whose country is not India is outside India whatever else it holds.
 */
export function placeOfSupplyOf(input: {
  readonly recipientCountry: string | null;
  readonly recipientGstin: string | null;
  readonly addressRegion: string | null;
  /** Whether the client has any address on record. */
  readonly hasAddress: boolean;
  readonly chosenStateCode: GstStateCode | null;
}): PlaceOfSupply {
  const country = input.recipientCountry?.toUpperCase() ?? null;
  if (country !== null && country !== "IN") return { kind: "outside_india", country };
  if (input.chosenStateCode !== null && BY_CODE.has(input.chosenStateCode)) {
    return { kind: "state", stateCode: input.chosenStateCode };
  }
  const fromGstin = stateCodeOfGstin(input.recipientGstin);
  if (fromGstin !== null) return { kind: "state", stateCode: fromGstin };
  const fromAddress = stateCodeOfRegion(input.addressRegion);
  if (fromAddress !== null) return { kind: "state", stateCode: fromAddress };
  return input.hasAddress ? { kind: "unknown" } : { kind: "supplier_location" };
}

// ── The treatment ──────────────────────────────────────────────────────────

/**
 * Which taxes an invoice charges, decided once per invoice and frozen at issue.
 *
 * `plain`: not a GST invoice (a company outside India, or an Indian company with
 * no GSTIN): one "Tax" figure at the line's rate, as every invoice before 0370.
 */
export type TaxTreatment =
  | "plain"
  | "gst_intra"
  | "gst_intra_ut"
  | "gst_inter"
  | "gst_export_lut"
  | "gst_export_igst";

export const TAX_TREATMENTS: readonly TaxTreatment[] = [
  "plain",
  "gst_intra",
  "gst_intra_ut",
  "gst_inter",
  "gst_export_lut",
  "gst_export_igst",
];

export function isTaxTreatment(v: string): v is TaxTreatment {
  return (TAX_TREATMENTS as readonly string[]).includes(v);
}

export function isGstTreatment(t: TaxTreatment | null): boolean {
  return t !== null && t !== "plain";
}

export type TreatmentDecision =
  | {
      readonly ok: true;
      readonly treatment: TaxTreatment;
      /** The supplier's state, from its GSTIN; null on a plain invoice. */
      readonly supplierStateCode: GstStateCode | null;
      /** Resolved: a state or outside India on a GST invoice (the supplier's
       *  location already read as its state); as given on a plain one. */
      readonly placeOfSupply: PlaceOfSupply;
    }
  /** An Indian GST invoice to an Indian client whose state nobody has given. */
  | { readonly ok: false; readonly why: "place_of_supply_unknown" };

export function decideTreatment(input: {
  /** The issuing company's country (its legal entity's jurisdiction). */
  readonly supplierCountry: string;
  readonly supplierGstin: string | null;
  readonly placeOfSupply: PlaceOfSupply;
  /** Whether the company holds an LUT for the issue date's financial year. */
  readonly lutInForce: boolean;
}): TreatmentDecision {
  const supplierState = stateCodeOfGstin(input.supplierGstin);
  if (input.supplierCountry.toUpperCase() !== "IN" || supplierState === null) {
    return { ok: true, treatment: "plain", supplierStateCode: null, placeOfSupply: input.placeOfSupply };
  }
  const given = input.placeOfSupply;
  if (given.kind === "unknown") return { ok: false, why: "place_of_supply_unknown" };
  const pos: PlaceOfSupply = given.kind === "supplier_location" ? { kind: "state", stateCode: supplierState } : given;
  const decided = (treatment: TaxTreatment): TreatmentDecision => ({
    ok: true,
    treatment,
    supplierStateCode: supplierState,
    placeOfSupply: pos,
  });
  if (pos.kind === "outside_india") return decided(input.lutInForce ? "gst_export_lut" : "gst_export_igst");
  if (pos.stateCode !== supplierState) return decided("gst_inter");
  return decided(stateByCode(supplierState)?.utgst === true ? "gst_intra_ut" : "gst_intra");
}

// ── Exact arithmetic ───────────────────────────────────────────────────────

/** A decimal as an integer and a scale: 12.34 is { int: 1234n, scale: 2 }. */
interface Dec {
  readonly int: bigint;
  readonly scale: number;
}

function dec(value: string): Dec {
  const t = value.trim();
  const negative = t.startsWith("-");
  const body = negative ? t.slice(1) : t;
  if (!/^\d+(\.\d+)?$/.test(body)) throw new RangeError(`not a decimal string: ${JSON.stringify(value)}`);
  const [whole = "0", frac = ""] = body.split(".");
  const int = BigInt(whole + frac);
  return { int: negative ? -int : int, scale: frac.length };
}

function mul(a: Dec, b: Dec): Dec {
  return { int: a.int * b.int, scale: a.scale + b.scale };
}

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/** Rounded to `places`, half away from zero, as Postgres's `round(numeric, n)`. */
function roundTo(a: Dec, places: number): Dec {
  if (a.scale <= places) return { int: a.int * pow10(places - a.scale), scale: places };
  const divisor = pow10(a.scale - places);
  const negative = a.int < 0n;
  const abs = negative ? -a.int : a.int;
  let q = abs / divisor;
  if ((abs % divisor) * 2n >= divisor) q += 1n;
  return { int: negative ? -q : q, scale: places };
}

function add(a: Dec, b: Dec): Dec {
  const scale = Math.max(a.scale, b.scale);
  return { int: a.int * pow10(scale - a.scale) + b.int * pow10(scale - b.scale), scale };
}

/** At four places, the scale every invoice amount crosses the wire at. */
function str(a: Dec): string {
  const r = roundTo(a, 4);
  const negative = r.int < 0n;
  const digits = (negative ? -r.int : r.int).toString().padStart(5, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

/** ISO 4217 minor units, the same table as `crm.currency_minor_unit` (0325). */
export function minorUnitOf(currency: string): number {
  const c = currency.toUpperCase();
  if (
    [
      "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV",
      "XAF", "XOF", "XPF",
    ].includes(c)
  ) {
    return 0;
  }
  if (["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"].includes(c)) return 3;
  return 2;
}

const PERCENT: Dec = { int: 1n, scale: 2 }; // x / 100
const HALF: Dec = { int: 5n, scale: 1 }; // x / 2

function minus(a: Dec, b: Dec): Dec {
  return add(a, { int: -b.int, scale: b.scale });
}

// ── One line's money ───────────────────────────────────────────────────────

export interface LineTax {
  readonly gross: string;
  /** The taxable value: after discount, rounded to the minor unit. */
  readonly net: string;
  readonly cgst: string;
  readonly sgst: string;
  readonly utgst: string;
  readonly igst: string;
  /** All the tax on the line: the sum of its components, or on a plain (or
   *  pre-0370) invoice the rate on the net, rounded once. */
  readonly tax: string;
  /** The rate each component is charged at, for printing ("9", "18"); null
   *  where the component does not apply. */
  readonly halfRate: string | null;
  readonly fullRate: string | null;
}

/**
 * One line's figures under a treatment. `treatment: null` is an invoice from
 * before 0370 and computes exactly as 0325 did.
 *
 * An export under an LUT charges no tax whatever the line's rate says: the
 * rate stays on the line (it is the service's rate, and would apply if the LUT
 * lapsed), but the supply is zero-rated.
 */
export function lineTax(input: {
  readonly quantity: string;
  readonly unitAmount: string;
  readonly discountPercent: string;
  readonly taxPercent: string;
  readonly currency: string;
  readonly treatment: TaxTreatment | null;
}): LineTax {
  const places = minorUnitOf(input.currency);
  const raw = mul(dec(input.quantity), dec(input.unitAmount));
  const gross = roundTo(raw, places);
  const keep = minus({ int: 1n, scale: 0 }, mul(dec(input.discountPercent), PERCENT));
  const net = roundTo(mul(raw, keep), places);
  const rate = dec(input.taxPercent);
  const onNet = (r: Dec): Dec => roundTo(mul(mul(net, r), PERCENT), places);
  const zero: Dec = { int: 0n, scale: places };
  const halfRate = mul(rate, HALF);

  let cgst = zero;
  let sgst = zero;
  let utgst = zero;
  let igst = zero;
  let tax: Dec;
  let half: string | null = null;
  let full: string | null = null;
  switch (input.treatment) {
    case null:
    case "plain":
      tax = onNet(rate);
      break;
    case "gst_intra":
      cgst = onNet(halfRate);
      sgst = onNet(halfRate);
      tax = add(cgst, sgst);
      half = trimRate(halfRate);
      break;
    case "gst_intra_ut":
      cgst = onNet(halfRate);
      utgst = onNet(halfRate);
      tax = add(cgst, utgst);
      half = trimRate(halfRate);
      break;
    case "gst_inter":
    case "gst_export_igst":
      igst = onNet(rate);
      tax = igst;
      full = trimRate(rate);
      break;
    case "gst_export_lut":
      tax = zero;
      full = "0";
      break;
  }
  return {
    gross: str(gross),
    net: str(net),
    cgst: str(cgst),
    sgst: str(sgst),
    utgst: str(utgst),
    igst: str(igst),
    tax: str(tax),
    halfRate: half,
    fullRate: full,
  };
}

/** "9.0000" -> "9", "2.50" -> "2.5": how a rate prints. */
export function trimRate(r: Dec | string): string {
  const d = typeof r === "string" ? dec(r) : r;
  const s = str(d);
  return s.replace(/\.?0+$/, "");
}

// ── TDS ────────────────────────────────────────────────────────────────────

/** The section a client deducts under, as the Act writes it: 194J, 194JB,
 *  194C, 195. Upper case on the invoice. */
export function isTdsSection(v: string): boolean {
  return /^[0-9]{3}[A-Z]{0,2}(\([0-9a-z]{1,3}\))?$/.test(v);
}

/** A rate above zero and at most 100, two places. */
export function isTdsPercent(v: string): boolean {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(v)) return false;
  const d = dec(v);
  return d.int > 0n && roundTo(d, 2).int <= 10000n;
}

/**
 * The TDS a client is expected to deduct: the rate on the amount BEFORE GST
 * (CBDT Circular 23/2017: where the invoice shows GST separately, tax is
 * deducted on the amount without it), rounded to the minor unit. An
 * EXPECTATION printed for the client's convenience: what the client actually
 * deducted is recorded with its payment, and only that settles the invoice.
 */
export function tdsOn(input: { readonly taxable: string; readonly percent: string; readonly currency: string }): string {
  return str(roundTo(mul(mul(dec(input.taxable), dec(input.percent)), PERCENT), minorUnitOf(input.currency)));
}

/** `total - tds`, exactly, at four places: the net the client remits. */
export function netPayable(total: string, tds: string): string {
  return str(minus(dec(total), dec(tds)));
}

/** Whether a decimal string is zero. */
export function isZero(v: string): boolean {
  return dec(v).int === 0n;
}
