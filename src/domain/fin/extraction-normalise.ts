// Turning what a document PRINTS into what the books store (F2.4). Pure, and no
// `Date` anywhere: every value here is a calendar day or a decimal string, and
// both are arithmetic on text (CLAUDE.md, "a date column is a DAY").
//
// The model is told to transcribe, never to convert: "20.06.2025", "S$3,125.00",
// "9%". Converting is this file's job, because a rule is testable and a model is
// not, and because a value the rule cannot read is then a value a PERSON looks
// at, rather than one the model quietly guessed into shape.
//
// Every function answers null for what it cannot read with certainty. Null here
// never means "not printed": the caller marks the field uncertain.
import { isCalendarDay } from "../day";
import { isCurrencyCode, isExchangeRate, isSignedAmount, normalizeCurrency } from "../money/model";
import type { Day } from "./lines";

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/** Years this reader accepts. A two-digit year is this century; a date outside
 *  these is a misreading (or a document nobody's books need). */
const FIRST_YEAR = 2000;
const LAST_YEAR = 2099;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function fullYear(text: string): number {
  const y = Number(text);
  return text.length === 2 ? 2000 + y : y;
}

function monthNamed(text: string): number | null {
  return MONTHS[text.toLowerCase().replace(/\.$/, "")] ?? null;
}

function dayOf(y: number, m: number, d: number): Day | null {
  if (y < FIRST_YEAR || y > LAST_YEAR) return null;
  const iso = `${String(y)}-${pad2(m)}-${pad2(d)}`;
  return isCalendarDay(iso) ? iso : null;
}

function cleanDateText(text: string): string {
  return (
    text
      .trim()
      .replace(/\s+/g, " ")
      // A weekday in front ("Mon, 15 Mar 2025") says nothing the date does not.
      .replace(/^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+/i, "")
      // A time after it ("15/03/2025 14:32") is not part of the day.
      .replace(/[\sT]+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?$/i, "")
  );
}

/**
 * A printed date as `YYYY-MM-DD`, read DAY FIRST, as Singapore prints dates:
 * `03/04/2025` is 3 April. A date that only makes sense month first
 * (`12/31/2025`) is refused rather than turned round: a document that prints its
 * dates the American way prints `03/04/2025` the American way too, and turning
 * round only the dates that cannot be read otherwise would get every other date
 * on it wrong without anyone knowing. A person reads that one.
 *
 * Read: `2025-03-15` (year first is never ambiguous), `15/03/2025`,
 * `15.03.25`, `15-03-2025`, `15 Mar 2025`, `15th March, 2025`, `15-Mar-25`,
 * `March 15, 2025` (a month NAME is never ambiguous), `20250315`.
 */
export function normaliseDay(text: string): Day | null {
  const s = cleanDateText(text);

  const yearFirst = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (yearFirst) return dayOf(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]));

  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (compact) return dayOf(Number(compact[1]), Number(compact[2]), Number(compact[3]));

  const dayFirst = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{4}|\d{2})$/.exec(s);
  if (dayFirst) {
    return dayOf(fullYear(dayFirst[3] ?? ""), Number(dayFirst[2]), Number(dayFirst[1]));
  }

  const namedDayFirst = /^(\d{1,2})(?:st|nd|rd|th)?[\s\-/.]*([A-Za-z]+\.?)[\s\-/.,]*(\d{4}|\d{2})$/.exec(s);
  if (namedDayFirst) {
    const m = monthNamed(namedDayFirst[2] ?? "");
    return m === null ? null : dayOf(fullYear(namedDayFirst[3] ?? ""), m, Number(namedDayFirst[1]));
  }

  const namedMonthFirst = /^([A-Za-z]+\.?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s);
  if (namedMonthFirst) {
    const m = monthNamed(namedMonthFirst[1] ?? "");
    return m === null ? null : dayOf(Number(namedMonthFirst[3]), m, Number(namedMonthFirst[2]));
  }

  return null;
}

function lastDayOfMonth(y: number, m: number): number {
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 30;
}

/** A printed MONTH with no day ("December 2025", "Dec-25", "12/2025",
 *  "2025-12"), as its first and last day. Null when it is not a month. */
export function normaliseMonth(text: string): { readonly first: Day; readonly last: Day } | null {
  const s = cleanDateText(text);
  let y: number | null = null;
  let m: number | null = null;

  const named = /^([A-Za-z]+\.?)[\s\-/.,']*(\d{4}|\d{2})$/.exec(s);
  const numeric = /^(\d{1,2})[-/.](\d{4})$/.exec(s);
  const yearFirst = /^(\d{4})[-/.](\d{1,2})$/.exec(s);
  if (named) {
    m = monthNamed(named[1] ?? "");
    y = fullYear(named[2] ?? "");
  } else if (numeric) {
    m = Number(numeric[1]);
    y = Number(numeric[2]);
  } else if (yearFirst) {
    y = Number(yearFirst[1]);
    m = Number(yearFirst[2]);
  }
  if (y === null || m === null || m < 1 || m > 12) return null;
  const first = dayOf(y, m, 1);
  const last = dayOf(y, m, lastDayOfMonth(y, m));
  return first === null || last === null ? null : { first, last };
}

/** The start of a service period: a day as printed, or the first day of a
 *  printed month ("for December 2025"). */
export function normalisePeriodStart(text: string): Day | null {
  return normaliseDay(text) ?? normaliseMonth(text)?.first ?? null;
}

/** The end of a service period: a day as printed, or the LAST day of a printed
 *  month. The cut-off check (F4.3) reads it against the period end. */
export function normalisePeriodEnd(text: string): Day | null {
  return normaliseDay(text) ?? normaliseMonth(text)?.last ?? null;
}

// ── Money ────────────────────────────────────────────────────────────────────

/** A currency mark printed next to an amount, at either end. Three letters,
 *  or one of the symbols a Singapore document uses. */
const CURRENCY_MARK = String.raw`(?:[A-Za-z]{3}|SG?\$|US\$|HK\$|AU?\$|RM|Rp|Rs\.?|\$|€|£|¥|₹)`;
const LEADING_MARK = new RegExp(`^${CURRENCY_MARK}\\s*`);
const TRAILING_MARK = new RegExp(`\\s*${CURRENCY_MARK}$`);

/** "1,234.50" or "1234.50", at most four decimal places (MAX_AMOUNT_SCALE). */
const DIGITS = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,4})?$/;

/**
 * A printed amount as a decimal STRING, keeping the sign it prints: "-120.00"
 * for "(120.00)", "-120.00", "120.00-" or "S$ -120.00". The decimals are kept as
 * printed ("3,125" is "3125", "3,125.00" is "3125.00"): the amount is what the
 * document says, and rewriting its scale would be an edit.
 *
 * Refused (null): a European "1.234,50" (the comma and point are the other way
 * round, and reading it as 1.234 would be a thousandfold error), more than four
 * decimal places, letters left over, or nothing at all.
 */
export function normaliseAmount(text: string): string | null {
  let s = text.trim().replace(/\u2212/g, "-").replace(/[\u00a0\u2009\u202f]/g, " ");
  let negative = false;
  // Signs and currency marks come in any order ("-S$120", "S$-120", "(S$120)",
  // "SGD 120.00-"), so peel them until nothing changes.
  for (let i = 0; i < 6; i += 1) {
    const before = s;
    s = s.trim();
    if (s.startsWith("(") && s.endsWith(")")) {
      negative = true;
      s = s.slice(1, -1);
    }
    if (s.startsWith("-")) {
      negative = true;
      s = s.slice(1);
    }
    if (s.endsWith("-")) {
      negative = true;
      s = s.slice(0, -1);
    }
    s = s.replace(LEADING_MARK, "").replace(TRAILING_MARK, "");
    if (s === before) break;
  }
  s = s.replace(/ /g, "");
  if (!DIGITS.test(s)) return null;
  const [whole = "", fraction] = s.replace(/,/g, "").split(".");
  const trimmed = whole.replace(/^0+(?=\d)/, "");
  const value = fraction === undefined ? trimmed : `${trimmed}.${fraction}`;
  const isZero = /^0(?:\.0+)?$/.test(value);
  const signed = negative && !isZero ? `-${value}` : value;
  return isSignedAmount(signed) ? signed : null;
}

/**
 * A printed exchange rate as a positive decimal string, up to ten places
 * (MAX_RATE_SCALE). "1 USD = 1.3456 SGD" reads the right-hand side, which is
 * what a rate line prints; anything else must be one number.
 */
export function normaliseRate(text: string): string | null {
  const rhs = text.includes("=") ? (text.split("=").pop() ?? "") : text;
  const s = rhs.trim().replace(LEADING_MARK, "").replace(TRAILING_MARK, "").replace(/,/g, "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
  const value = s.replace(/^0+(?=\d)/, "");
  if (!isExchangeRate(value) || /^0(?:\.0+)?$/.test(value)) return null;
  return value;
}

/**
 * A printed GST rate as percent without the sign: "9%" and "GST @ 9.00%" are
 * "9", "7.5 %" is "7.5", "0%" (zero-rated) is "0". A rate between 0 and 1 is
 * refused: "0.09" is a fraction written by somebody else's convention or 0.09%,
 * and neither is a rate a person should find already decided.
 */
export function normalisePercent(text: string): string | null {
  const s = text
    .replace(/\b(?:gst|vat|tax|rate)\b/gi, "")
    .replace(/[@%:]/g, "")
    .trim();
  if (!/^\d{1,3}(?:\.\d{1,3})?$/.test(s)) return null;
  const [whole = "", fraction = ""] = s.split(".");
  const kept = fraction.replace(/0+$/, "");
  const value = `${whole.replace(/^0+(?=\d)/, "")}${kept === "" ? "" : `.${kept}`}`;
  const n = Number(value);
  if (n > 100 || (n > 0 && n < 1)) return null;
  return value;
}

/** Marks and words that name one currency only. "$" alone is NOT here: it is
 *  Singapore's, America's, Hong Kong's and Australia's, and a person decides. */
const CURRENCY_WORDS: Readonly<Record<string, string>> = {
  s$: "SGD",
  sg$: "SGD",
  sgd$: "SGD",
  "singapore dollar": "SGD",
  "singapore dollars": "SGD",
  us$: "USD",
  "us dollar": "USD",
  "us dollars": "USD",
  hk$: "HKD",
  a$: "AUD",
  au$: "AUD",
  rm: "MYR",
  "€": "EUR",
  "£": "GBP",
  "₹": "INR",
  rs: "INR",
  "rs.": "INR",
  rp: "IDR",
};

/** A printed currency as its ISO 4217 code, upper-case ("sgd" is "SGD", "S$"
 *  is "SGD"); null for a bare "$" or "¥", which name more than one. */
export function normaliseCurrencyMark(text: string): string | null {
  const s = text.trim().replace(/\s+/g, " ");
  const word = CURRENCY_WORDS[s.toLowerCase()];
  if (word !== undefined) return word;
  const code = normalizeCurrency(s);
  return isCurrencyCode(code) ? code : null;
}

// ── Words and numbers on the document ────────────────────────────────────────

/** A name as printed, with its spacing tidied. Longer than any name is a
 *  misreading (the model took a paragraph). */
export function normaliseName(text: string): string | null {
  const s = text.trim().replace(/\s+/g, " ");
  return s === "" || s.length > 200 ? null : s;
}

/** The labels a model sometimes copies in front of a number. A bare "No" or
 *  "Ref" is a label only with its point or colon, or "NO123" and "REF2025-01"
 *  would lose their letters. */
const LABEL =
  /^(?:(?:uen|gst\s*reg(?:istration)?\.?\s*no|gst\s*no|co\.?\s*reg\.?\s*no|reg\.?\s*no|tax\s*invoice\s*no|invoice\s*no|receipt\s*no|credit\s*note\s*no)\.?\s*[:#]?|(?:no|ref(?:erence)?)\.\s*[:#]?|(?:no|ref(?:erence)?)\s*[:#])\s*/i;

/** A registration number (UEN, GST number) as printed, labels off, upper-case
 *  (they are case-free identifiers). */
export function normaliseRegistration(text: string): string | null {
  const s = text.trim().replace(/\s+/g, " ").replace(LABEL, "").trim().toUpperCase();
  return s === "" || s.length > 40 || !/^[A-Z0-9][A-Z0-9 ./-]*$/.test(s) ? null : s;
}

/** A document number as printed, labels off, its own case kept. */
export function normaliseReference(text: string): string | null {
  const s = text.trim().replace(/\s+/g, " ").replace(LABEL, "").trim();
  return s === "" || s.length > 60 ? null : s;
}
