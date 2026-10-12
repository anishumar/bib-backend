// What is IN a sheet's cells: header words, amounts, days, months, pass types,
// and the identity numbers that must never be stored whole (docs/FIN_BUILD_PLAN.md
// F2.6, F2.9, F2.11). Pure.
//
// Every reader here answers "this is what the cell says", "the cell is blank" or
// "the cell says something I cannot read", and never a fourth thing. A value it
// cannot read is the caller's to refuse; nothing here rounds a doubt into a
// number.
import type { Day, PassType, SignedDecimal } from "./lines";

// ── Header words ─────────────────────────────────────────────────────────────

/**
 * A header cell as words, for matching: camelCase and digits split off
 * ("TxnDate" → "txn date", "GST9" → "gst 9"), lower case, every run of
 * punctuation one space. "NRIC / FIN", "NRIC_FIN" and "NricFin" are then one
 * header, and so are "No." and "No".
 */
export function normaliseHeader(cell: string): string {
  return cell
    .replace(/^﻿/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A cell's text with its runs of whitespace (a line break typed into a cell
 *  included) made one space. */
export function collapseText(cell: string): string {
  return cell.replace(/\s+/g, " ").trim();
}

// ── Amounts ──────────────────────────────────────────────────────────────────

export type AmountCell =
  | { readonly kind: "blank" }
  | {
      readonly kind: "amount";
      readonly value: SignedDecimal;
      /** A CR or DR the cell carried after its digits, already applied to
       *  `value` (CR in, DR out). Null when it carried none. */
      readonly suffix: "CR" | "DR" | null;
    }
  | { readonly kind: "bad" };

/** What a bank prints in a column it has nothing for. */
const BLANK_AMOUNTS = new Set(["", "-", "–", "—"]);

/** Currency marks a sheet prints beside a figure. Longest first, so "US$" is
 *  not read as "$" with "US" left over. */
const CURRENCY_MARKS = /^(?:US\$|S\$|SGD|USD|EUR|GBP|MYR|INR|AED|RM|Rs\.?|₹|\$|€|£|¥)\s*/i;
const CURRENCY_SUFFIX = /\s*(?:SGD|USD|EUR|GBP|MYR|INR|AED)$/i;

const PLAIN_DIGITS = /^\d+(?:\.\d+)?$/;
const GROUPED_DIGITS = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
const FRACTION_ONLY = /^\.\d+$/;

/** More fractional digits than this is a binary float written out by the
 *  program that saved the sheet ("560.9299999999999"), not a figure anybody
 *  typed. */
const NOISE_SCALE = 6;

/**
 * Digits as a canonical decimal: no leading zeros, and a fraction longer than
 * six places rounded half up to six and its trailing zeros dropped, which
 * turns a spreadsheet's float noise back into the figure on screen and moves
 * no figure a person typed.
 */
function canonical(digits: string, negative: boolean): SignedDecimal {
  const [rawWhole = "0", rawFraction = ""] = digits.split(".");
  let whole = rawWhole.replace(/^0+(?=\d)/, "") || "0";
  let fraction = rawFraction;
  if (fraction.length > NOISE_SCALE) {
    const kept = BigInt(whole + fraction.slice(0, NOISE_SCALE));
    const rounded = kept + (Number(fraction[NOISE_SCALE] ?? "0") >= 5 ? 1n : 0n);
    const text = rounded.toString().padStart(NOISE_SCALE + 1, "0");
    whole = text.slice(0, text.length - NOISE_SCALE).replace(/^0+(?=\d)/, "") || "0";
    fraction = text.slice(text.length - NOISE_SCALE).replace(/0+$/, "");
  }
  const value = fraction === "" ? whole : `${whole}.${fraction}`;
  const zero = /^[0.]+$/.test(value);
  return negative && !zero ? `-${value}` : value;
}

/**
 * One amount cell. Reads what statements and payroll sheets print: a sign
 * before the figure or after it ("120.00-"), brackets for a negative, thousands
 * separated by commas, a currency mark before or after ("S$6,200.00"), and a CR
 * or DR after the digits, which signs the figure the way a bank means it (CR
 * money in, DR money out). A comma as the decimal point is NOT read: "1.234,56"
 * and "1,234.56" cannot both be one convention, and guessing would move a
 * figure by a thousand.
 */
export function readAmount(raw: string): AmountCell {
  let s = raw.trim().replace(/−/g, "-");
  if (BLANK_AMOUNTS.has(s)) return { kind: "blank" };

  let suffix: "CR" | "DR" | null = null;
  const marked = /^(.*?)\s*(CR|DR)\.?$/i.exec(s);
  if (marked !== null && /\d/.test(marked[1] ?? "")) {
    s = (marked[1] ?? "").trim();
    suffix = (marked[2] ?? "").toUpperCase() as "CR" | "DR";
  }

  let negative = false;
  let signs = 0;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    signs += 1;
    s = s.slice(1, -1).trim();
  }
  const sign = (): void => {
    if (s.startsWith("-") || s.startsWith("+")) {
      if (s.startsWith("-")) {
        negative = true;
        signs += 1;
      }
      s = s.slice(1).trim();
    }
  };
  sign();
  s = s.replace(CURRENCY_MARKS, "");
  sign();
  s = s.replace(CURRENCY_SUFFIX, "").trim();
  if (s.endsWith("-")) {
    negative = true;
    signs += 1;
    s = s.slice(0, -1).trim();
  }
  if (signs > 1) return { kind: "bad" };

  let digits: string;
  if (PLAIN_DIGITS.test(s)) digits = s;
  else if (GROUPED_DIGITS.test(s)) digits = s.replace(/,/g, "");
  else if (FRACTION_ONLY.test(s)) digits = `0${s}`;
  else return { kind: "bad" };

  if (suffix === "DR") negative = !negative;
  return { kind: "amount", value: canonical(digits, negative), suffix };
}

// ── Days ─────────────────────────────────────────────────────────────────────

/**
 * How a sheet writes a day. Stored on a learnt layout (`fin.source_format`), so
 * a CHECK in 0386 lists the same codes.
 *
 *   iso        2025-03-15 (also 2025/03/15, and with a time after it)
 *   dmy        15/03/2025, 15-03-2025, 15.03.2025
 *   mdy        03/15/2025
 *   dmy_short  15/03/25
 *   mdy_short  03/15/25
 *   d_mon_y    15 Mar 2025, 15-Mar-2025, 15-Mar-25
 *   mon_d_y    Mar 15, 2025
 *   ddmmyyyy   15032025
 *   yyyymmdd   20250315
 *
 * An Excel date cell needs none of these: the core sheet reader writes one as
 * `iso` already.
 */
export type DateFormat =
  | "iso"
  | "dmy"
  | "mdy"
  | "dmy_short"
  | "mdy_short"
  | "d_mon_y"
  | "mon_d_y"
  | "ddmmyyyy"
  | "yyyymmdd";

export const DATE_FORMATS: readonly DateFormat[] = [
  "iso",
  "dmy",
  "mdy",
  "dmy_short",
  "mdy_short",
  "d_mon_y",
  "mon_d_y",
  "ddmmyyyy",
  "yyyymmdd",
];

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/** A month's number from its name or its three-letter form, any case. */
export function monthNumber(name: string): number | null {
  return MONTHS[name.toLowerCase().replace(/\.$/, "")] ?? null;
}

const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

/** A real calendar day as `YYYY-MM-DD`, or null. No `Date` is kept: one is
 *  built only to ask whether the day exists (2025-02-30 does not). */
function day(year: number, month: number, dayOfMonth: number): Day | null {
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) return null;
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) return null;
  const probe = new Date(Date.UTC(year, month - 1, dayOfMonth));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== dayOfMonth) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(dayOfMonth).padStart(2, "0")}`;
}

/** A two-digit year is this century's: a 2025 bank export says "25". */
function fullYear(yy: string): number {
  return yy.length === 2 ? 2000 + Number(yy) : Number(yy);
}

const ISO = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/;
const NUMERIC_LONG = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/;
const NUMERIC_SHORT = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/;
const DAY_MONTH_NAME = /^(\d{1,2})[\s/.-]+([A-Za-z]{3,9})\.?[\s/.,-]+(\d{4}|\d{2})$/;
const MONTH_NAME_DAY = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/;
const EIGHT_DIGITS = /^(\d{2})(\d{2})(\d{4})$/;
const EIGHT_DIGITS_YEAR_FIRST = /^(\d{4})(\d{2})(\d{2})$/;

/** One cell read in one format, or null when it is not that format. */
export function parseDay(raw: string, format: DateFormat): Day | null {
  const s = raw.trim();
  let m: RegExpExecArray | null;
  switch (format) {
    case "iso":
      m = ISO.exec(s);
      return m === null ? null : day(Number(m[1]), Number(m[2]), Number(m[3]));
    case "dmy":
      m = NUMERIC_LONG.exec(s);
      return m === null ? null : day(Number(m[3]), Number(m[2]), Number(m[1]));
    case "mdy":
      m = NUMERIC_LONG.exec(s);
      return m === null ? null : day(Number(m[3]), Number(m[1]), Number(m[2]));
    case "dmy_short":
      m = NUMERIC_SHORT.exec(s);
      return m === null ? null : day(fullYear(m[3] ?? ""), Number(m[2]), Number(m[1]));
    case "mdy_short":
      m = NUMERIC_SHORT.exec(s);
      return m === null ? null : day(fullYear(m[3] ?? ""), Number(m[1]), Number(m[2]));
    case "d_mon_y": {
      m = DAY_MONTH_NAME.exec(s);
      const month = m === null ? null : monthNumber(m[2] ?? "");
      return m === null || month === null ? null : day(fullYear(m[3] ?? ""), month, Number(m[1]));
    }
    case "mon_d_y": {
      m = MONTH_NAME_DAY.exec(s);
      const month = m === null ? null : monthNumber(m[1] ?? "");
      return m === null || month === null ? null : day(Number(m[3]), month, Number(m[2]));
    }
    case "ddmmyyyy":
      m = EIGHT_DIGITS.exec(s);
      return m === null ? null : day(Number(m[3]), Number(m[2]), Number(m[1]));
    case "yyyymmdd":
      m = EIGHT_DIGITS_YEAR_FIRST.exec(s);
      return m === null ? null : day(Number(m[1]), Number(m[2]), Number(m[3]));
  }
}

export type DateFormatFinding =
  | { readonly kind: "found"; readonly format: DateFormat }
  /** No cell looked like a day in any format. */
  | { readonly kind: "none" }
  /** More than one format reads every cell: 03/04/2025 is the 3rd of April
   *  or the 4th of March and nothing in the file says which. */
  | { readonly kind: "ambiguous"; readonly formats: readonly DateFormat[] };

/**
 * The one format every day-shaped cell in a column is written in. Cells no
 * format reads are left to the caller (a row label in the date column is not
 * a day); a format must read every OTHER cell. Two formats that both do is an
 * answer only a person, or a layout a person confirmed, can give: never a
 * guess, however unlikely the other reading looks.
 */
export function detectDateFormat(cells: readonly string[]): DateFormatFinding {
  const dayish = cells
    .map((c) => c.trim())
    .filter((c) => c !== "" && DATE_FORMATS.some((f) => parseDay(c, f) !== null));
  if (dayish.length === 0) return { kind: "none" };
  const fits = DATE_FORMATS.filter((f) => dayish.every((c) => parseDay(c, f) !== null));
  if (fits.length === 1 && fits[0] !== undefined) return { kind: "found", format: fits[0] };
  if (fits.length === 0) return { kind: "none" };
  return { kind: "ambiguous", formats: fits };
}

// ── Months (a payroll's period) ──────────────────────────────────────────────

/** `YYYY-MM`, or null. */
function month(year: number, monthOfYear: number): string | null {
  if (!Number.isInteger(year) || year < 2000 || year > 2099) return null;
  if (!Number.isInteger(monthOfYear) || monthOfYear < 1 || monthOfYear > 12) return null;
  return `${String(year)}-${String(monthOfYear).padStart(2, "0")}`;
}

/**
 * A cell that names a month: "2025-08", "2025-08-01" (a day, as an Excel date
 * cell becomes), "Aug-25", "Aug 2025", "August 2025", "08/2025", "202508".
 */
export function parsePeriod(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?(?:[ T].*)?$/.exec(s);
  if (m !== null) return month(Number(m[1]), Number(m[2]));
  m = /^([A-Za-z]{3,9})\.?[\s'’/-]*(\d{4}|\d{2})$/.exec(s);
  if (m !== null) {
    const n = monthNumber(m[1] ?? "");
    return n === null ? null : month(fullYear(m[2] ?? ""), n);
  }
  m = /^(\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m !== null) return month(Number(m[2]), Number(m[1]));
  m = /^(\d{4})(\d{2})$/.exec(s);
  if (m !== null) return month(Number(m[1]), Number(m[2]));
  return null;
}

const MONTH_WORD = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

/**
 * A month named in free text, the way a payroll sheet's title says it: "Payroll
 * for August 2025", "SALARY SHEET - SEPTEMBER 2025". A month name followed by a
 * four-digit year, or a `YYYY-MM`. The first one found.
 */
export function periodInText(text: string): string | null {
  const named = new RegExp(`(?<![a-z])${MONTH_WORD}\\.?[\\s,'’-]*(\\d{4})(?!\\d)`, "i").exec(text);
  if (named !== null) {
    const n = monthNumber(named[1] ?? "");
    if (n !== null) return month(Number(named[2]), n);
  }
  const numeric = /(?<!\d)(\d{4})-(\d{2})(?!\d)/.exec(text);
  return numeric === null ? null : month(Number(numeric[1]), Number(numeric[2]));
}

/**
 * A month named in a FILENAME: "Payroll_Aug2025", "SALARY Sep 25",
 * "Wages_2025_03", "PR_register_2025-10". A two-digit year is read only right
 * after a month name, where nothing else can be meant. The weakest evidence
 * there is (a client chose the name), so a reader that uses it marks the
 * period uncertain.
 */
export function periodInFilename(filename: string): string | null {
  const stem = filename.replace(/\.[A-Za-z0-9]+$/, "");
  const named = new RegExp(`(?<![a-z])${MONTH_WORD}[\\s_.-]*(\\d{4}|\\d{2})(?!\\d)`, "i").exec(stem);
  if (named !== null) {
    const n = monthNumber(named[1] ?? "");
    if (n !== null) return month(fullYear(named[2] ?? ""), n);
  }
  const numeric = /(?<!\d)(20\d{2})[-_. ]?(0[1-9]|1[0-2])(?!\d)/.exec(stem);
  return numeric === null ? null : month(Number(numeric[1]), Number(numeric[2]));
}

/** The first day of a `YYYY-MM` period. */
export function periodStart(period: string): Day {
  return `${period}-01`;
}

/** Whole years from a birth day to a day, or null when that is not an age. */
export function ageOn(birth: Day, on: Day): number | null {
  const [by, bm, bd] = birth.split("-").map(Number);
  const [y, m, d] = on.split("-").map(Number);
  if (by === undefined || bm === undefined || bd === undefined) return null;
  if (y === undefined || m === undefined || d === undefined) return null;
  const age = y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
  return age >= 0 && age <= 130 ? age : null;
}

// ── NRIC / FIN ───────────────────────────────────────────────────────────────
//
// A Singapore identity number is a prefix letter (S, T, F, G, M), seven digits
// and a check letter. It is never stored whole, anywhere fin writes: the
// readers keep its last four characters, which is how Singapore's own guidance
// masks one ("*****567D"), and which is enough to tell a payroll's employees
// apart and to match them to the employee master later.

const NRIC_SHAPE = /^[STFGM]\d{7}[A-Z]$/i;
const NRIC_IN_TEXT = /(?<![A-Za-z0-9])[STFGM]\d{7}[A-Z](?![A-Za-z0-9])/gi;

/** Whether a cell is one NRIC/FIN. */
export function isNric(value: string): boolean {
  return NRIC_SHAPE.test(value.trim());
}

/** An NRIC/FIN with all but its last four characters masked. */
export function maskedNric(value: string): string {
  const v = value.trim().toUpperCase();
  return `*****${v.slice(-4)}`;
}

/** Text with every NRIC/FIN in it masked: a name or a narration a person typed
 *  one into keeps the rest of what they typed. */
export function maskNric(text: string): string {
  return text.replace(NRIC_IN_TEXT, (found) => maskedNric(found));
}

// ── Pass types ───────────────────────────────────────────────────────────────

const PASS_TYPES: Readonly<Record<string, PassType>> = {
  sc: "citizen",
  citizen: "citizen",
  "singapore citizen": "citizen",
  singaporean: "citizen",
  pr: "pr",
  spr: "pr",
  "permanent resident": "pr",
  "singapore pr": "pr",
  "singapore permanent resident": "pr",
  ep: "employment_pass",
  "employment pass": "employment_pass",
  sp: "s_pass",
  "s pass": "s_pass",
  spass: "s_pass",
  wp: "work_permit",
  "work permit": "work_permit",
};

/** A pass type cell as the product's code, or null when it names none of
 *  the five. */
export function passTypeOf(raw: string): PassType | null {
  return PASS_TYPES[normaliseHeader(raw)] ?? null;
}
