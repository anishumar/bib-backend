// MONEY ON A DOCUMENT (audit 2026-10-03: B19, CA#49, CA#60, B12/CA#1). Pure,
// stdlib only.
//
// ONE formatter for every PDF the product draws, in the shape every screen
// already uses (the frontend's `formatMoney`):
//   - rupees with the sign, grouped in lakhs and crores: "₹12,50,000";
//   - every other currency with its ISO code, grouped in thousands:
//     "AED 5,000", because "$" is ambiguous across the firm's four countries
//     and a code is not;
//   - minor units (paise) only when there are some, "₹12,000" and
//     "₹12,000.50"; a TAX INVOICE and a credit note print them always
//     ("₹5,900.00"), as accounting documents in this market do, so a column of
//     figures lines up and nobody wonders whether paise were dropped.
// Before this, letters and invoices printed "INR 1,250,000.00" (western
// grouping, paise on whole rupees) while proposals printed "INR 12,50,000" and
// every screen "₹12,50,000".
//
// NO `Intl` AND NO NUMBER. The amount is a decimal string and stays one: it is
// split into digits and regrouped by hand, because `Number(amount)` loses
// paise on a large figure, and because `Intl` answers from whatever locale data
// the machine's Node was built with: a document's bytes must not depend on the
// machine (the renderer's determinism rule). Rounding to the minor unit is half
// away from zero, the database's `round()` (0325), done on digits.

/** How many decimal places a currency's smallest coin has — the same table
 *  as `crm.currency_minor_unit` (0325). */
export function minorUnitsOf(currency: string): number {
  switch (currency.toUpperCase()) {
    case "BIF": case "CLP": case "DJF": case "GNF": case "ISK": case "JPY": case "KMF":
    case "KRW": case "PYG": case "RWF": case "UGX": case "UYI": case "VND": case "VUV":
    case "XAF": case "XOF": case "XPF":
      return 0;
    case "BHD": case "IQD": case "JOD": case "KWD": case "LYD": case "OMR": case "TND":
      return 3;
    default:
      return 2;
  }
}

interface Split {
  readonly negative: boolean;
  /** The whole units, as digits with no leading zeros ("0" for none). */
  readonly whole: string;
  /** The minor units, exactly `places` digits. */
  readonly minor: string;
}

/** A decimal string rounded to `places`, half away from zero, on digits. */
function split(amount: string, places: number): Split {
  const trimmed = amount.trim();
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (m === null) throw new Error(`not a decimal amount: ${JSON.stringify(amount)}`);
  const negative = m[1] === "-";
  const intDigits = m[2] === undefined || m[2] === "" ? "0" : m[2];
  const fraction = m[3] ?? "";
  const kept = fraction.slice(0, places).padEnd(places, "0");
  const next = fraction.charAt(places);
  let scaled = BigInt(`${intDigits}${kept}`);
  if (next !== "" && next >= "5") scaled += 1n;
  const text = scaled.toString().padStart(places + 1, "0");
  const whole = places === 0 ? text : text.slice(0, -places);
  const minor = places === 0 ? "" : text.slice(-places);
  const isZero = scaled === 0n;
  return { negative: negative && !isZero, whole: whole.replace(/^0+(?=\d)/, ""), minor };
}

/** "1250000" to "12,50,000": the last three digits, then pairs. */
function lakhs(digits: string): string {
  if (digits.length <= 3) return digits;
  const last = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const pairs: string[] = [];
  while (rest.length > 2) {
    pairs.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest !== "") pairs.unshift(rest);
  return `${pairs.join(",")},${last}`;
}

/** "1250000" to "1,250,000". */
function thousands(digits: string): string {
  const groups: string[] = [];
  let rest = digits;
  while (rest.length > 3) {
    groups.unshift(rest.slice(-3));
    rest = rest.slice(0, -3);
  }
  groups.unshift(rest);
  return groups.join(",");
}

export interface DocumentMoneyOptions {
  /** "always" on a tax invoice or a credit note; otherwise only when the
   *  amount has any. */
  readonly minorUnits?: "always" | "when-present";
}

/**
 * An amount as every document prints it — see the file header. Throws on a
 * value that is not a decimal: the caller reads it from a `numeric` column.
 */
export function documentMoney(amount: string, currency: string, options: DocumentMoneyOptions = {}): string {
  const code = currency.toUpperCase();
  const places = minorUnitsOf(code);
  const s = split(amount, places);
  const showMinor = places > 0 && (options.minorUnits === "always" || /[1-9]/.test(s.minor));
  const grouped = code === "INR" ? lakhs(s.whole) : thousands(s.whole);
  const figure = `${grouped}${showMinor ? `.${s.minor}` : ""}`;
  const sign = s.negative ? "-" : "";
  return code === "INR" ? `${sign}₹${figure}` : `${sign}${code} ${figure}`;
}

// ── The total in words ──────────────────────────────────────────────────────

const ONES = [
  "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

/** 0..999 in words, with nothing for zero. */
function underThousand(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) parts.push(`${ONES[hundreds] ?? ""} Hundred`);
  if (rest > 0) {
    if (rest < 20) parts.push(ONES[rest] ?? "");
    else {
      const t = TENS[Math.floor(rest / 10)] ?? "";
      const o = rest % 10;
      parts.push(o === 0 ? t : `${t}-${ONES[o] ?? ""}`);
    }
  }
  return parts.join(" ");
}

/** Whole units in words, Indian (crore, lakh, thousand) or international
 *  (billion, million, thousand). Recursive above the largest scale, so a
 *  hundred crore reads "One Hundred Crore". A digit string, never a number. */
function wholeInWords(digits: string, indian: boolean): string {
  const n = BigInt(digits);
  if (n === 0n) return "Zero";
  const scales: readonly (readonly [bigint, string])[] = indian
    ? [[10_000_000n, "Crore"], [100_000n, "Lakh"], [1_000n, "Thousand"]]
    : [[1_000_000_000n, "Billion"], [1_000_000n, "Million"], [1_000n, "Thousand"]];
  const parts: string[] = [];
  let rest = n;
  for (const [size, name] of scales) {
    if (rest >= size) {
      const count = rest / size;
      rest %= size;
      // Above the largest scale the count is itself a figure: words again.
      const words =
        size === scales[0]?.[0] && count >= 1000n
          ? wholeInWords(count.toString(), indian)
          : underThousand(Number(count));
      parts.push(`${words} ${name}`);
    }
  }
  if (rest > 0n) parts.push(underThousand(Number(rest)));
  return parts.join(" ");
}

/** What a currency and its smallest coin are called on an invoice. A code not
 *  here is written as its code, and its coins as "cents" of it. */
const CURRENCY_WORDS: Readonly<Record<string, { readonly name: string; readonly minor: string }>> = {
  INR: { name: "Indian Rupees", minor: "Paise" },
  USD: { name: "US Dollars", minor: "Cents" },
  AED: { name: "UAE Dirhams", minor: "Fils" },
  SGD: { name: "Singapore Dollars", minor: "Cents" },
  GBP: { name: "Pounds Sterling", minor: "Pence" },
  EUR: { name: "Euros", minor: "Cents" },
  AUD: { name: "Australian Dollars", minor: "Cents" },
  CAD: { name: "Canadian Dollars", minor: "Cents" },
};

/**
 * The total in words, as an invoice states it beside the figure (CA#1):
 * "Indian Rupees Thirty-Two Thousand Three Hundred Fifty-Four and Eighty-Three
 * Paise Only". Rupees are counted in lakhs and crores, every other currency in
 * thousands and millions.
 */
export function amountInWords(amount: string, currency: string): string {
  const code = currency.toUpperCase();
  const places = minorUnitsOf(code);
  const s = split(amount, places);
  const named = CURRENCY_WORDS[code] ?? { name: code, minor: "Cents" };
  const whole = wholeInWords(s.whole, code === "INR");
  const minorCount = places === 0 ? 0n : BigInt(s.minor);
  const minor = minorCount === 0n ? "" : ` and ${wholeInWords(minorCount.toString(), false)} ${named.minor}`;
  return `${s.negative ? "Minus " : ""}${named.name} ${whole}${minor} Only`;
}
