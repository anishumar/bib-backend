// Loading a firm's existing book of clients from a spreadsheet — the nouns,
// the column contract, and the rules that decide whether a sheet may be loaded.
//
// Every firm arrives as spreadsheets, and the screens are for the clients that
// arrive AFTER that. This module is pure: it turns a grid of strings into rows
// in the product's own vocabulary, and a set of rows plus a snapshot of what
// the firm already has into a VERDICT — which rows load, which are skipped,
// which are refused and why. Nothing here reads a file or a table; the use
// case gathers the snapshot through its ports and hands it in.
//
// Two kinds of finding, and the difference is who acts on it:
//
//   · BLOCKING — the sheet is wrong and the firm fixes it. A country with no
//     entity type, a service code the catalogue does not have, a date that
//     reads two ways. Nothing loads while one remains, because a half-loaded
//     book is worse than none.
//   · WARNING — the sheet is loadable and somebody should look. A client with
//     no Key Manager, a registered company with no financial year end, a row
//     already on file that will be skipped.
//
// A row already on file is SKIPPED and said so, never updated. A sheet gets
// sent again with corrections, and the only tolerable behaviour on a re-run is
// that the second run is boring. A sheet that disagrees with the database is a
// question for the firm, not something to resolve silently in favour of the
// newer file — somebody may have corrected a name here on purpose.

import { isBillingFrequency, type BillingFrequency } from "../document/model";
import { isAmount, isCurrencyCode, normalizeCurrency } from "../money/model";
import {
  isValidIdentifier,
  normalizeIdentifier,
  type IdentifierType,
} from "../party/model";
import { countryCodeProblem, countryWords, entityKindWords, isCountryCode, withArticle } from "../country";

// ── The column contract ──────────────────────────────────────────────────────
//
// Header names are matched by NAME, case- and space-insensitively, wherever
// the header row is: these sheets routinely open with a title or a blank row,
// and a fixed position breaks the first time somebody adds one. The MARKER is
// the one column the header row must contain to be recognised as the header.

export interface SheetColumn {
  readonly header: string;
  readonly required: boolean;
  /**
   * The few words that go IN THE HEADER CELL, in brackets, on every sheet
   * this product hands out: `Started On (YYYY-MM-DD)`. Nobody reads a guide
   * (Shrestha, 2026-09-18: "guide wagerah koi padhta nahi hai"), and the one
   * place a person's eye is when they type a value is the cell above it. So
   * the format, the vocabulary and the one cross-sheet rule that matters —
   * "exactly the Client Name from 1-clients" — sit there.
   *
   * SHORT and WITHOUT BRACKETS of its own: the reader recognises a header by
   * what comes before the first "(", so a hint containing one would cut the
   * header in the wrong place. `tests/clientimport/header-hints.test.ts`
   * holds both. `about` is the longer sentence the import screen's table and
   * the guide carry.
   */
  readonly hint: string;
  readonly about: string;
}

/**
 * A header as a sheet PRINTS it — `Client Name (registered name, spelled the
 * same on all 3 sheets)` — and the two halves of reading one back.
 *
 * `headerKey` is what every header comparison in this module goes through:
 * the bracketed hint is dropped, then the name is normalised the way a client
 * name is. So a sheet downloaded with hints, a sheet somebody typed by hand
 * with plain headers, and a sheet where somebody shortened a hint all read
 * the same — the hint is for the person filling the cell, never for the
 * machine reading it. Only ever applied to HEADERS: a client called
 * "Kaveri (India) Private Limited" keeps its brackets.
 */
export function headerWithHint(header: string, hint: string): string {
  return hint === "" ? header : `${header} (${hint})`;
}

export function headerKey(raw: string): string {
  return normaliseName(raw.replace(/\s*\(.*$/s, ""));
}

/** The registration numbers a firm keeps, one column each. Blank cells are
 *  ignored; a filled one becomes an identifier row on the party. */
export const IDENTIFIER_COLUMNS: readonly {
  readonly header: string;
  readonly type: IdentifierType;
  readonly hint: string;
}[] = [
  { header: "PAN", type: "pan", hint: "10 characters, blank if none" },
  { header: "GSTIN", type: "gstin", hint: "15 characters, blank if none" },
  { header: "CIN", type: "cin", hint: "21 characters, blank if none" },
  { header: "LLPIN", type: "llpin", hint: "blank if none" },
  { header: "TAN", type: "tan", hint: "10 characters, blank if none" },
  { header: "UEN", type: "uen", hint: "Singapore, blank if none" },
  { header: "TRN", type: "trn", hint: "UAE, blank if none" },
  { header: "EIN", type: "ein", hint: "US, blank if none" },
  { header: "CRN", type: "crn", hint: "UK, blank if none" },
  { header: "VAT", type: "vat", hint: "blank if none" },
];

// ── The SPOC columns, and why there are two spellings of them ────────────────
//
// A SPOC covers a Dept. That is not a convention this module could drop if it
// wanted to: `client_assignment_axis_matches_role` (0049) makes `axis_id` NOT
// NULL for a SPOC, so an email with no Dept beside it cannot become one. The
// only question a sheet gets to answer is WHERE the Dept is written.
//
// **NUMBERED PAIRS — `SPOC 1 Dept`, `SPOC 1 Email` — are the form to send.**
// The header is the same at every firm, which is the point: a template whose
// column names are one firm's Dept codes reads as though the product ships a
// fixed vocabulary of Depts, and it does not. The Dept moves into a cell, and
// the sheet can be filled in by somebody who has never seen this firm's
// structure screen.
//
// **`SPOC: <Dept>` — the Dept in the HEADER — is still read**, because sheets
// in that shape have already been sent out and a migration file that stops
// being readable a fortnight after somebody was asked to fill it in is its own
// small disaster. Both forms land in the same list; a sheet may use either or
// both, and nothing downstream can tell which one it came from.
//
// The numbering is not a limit. The reader scans the headers it is given, so a
// firm that wants a fourth SPOC adds `SPOC 4 Dept` and `SPOC 4 Email` to the
// sheet by hand and it works — the template ships as many pairs as the firm has
// Depts because that is the ordinary number, not because it is the maximum.

/** The prefix of the older, Dept-in-the-header form: `SPOC: IDT`. */
export const SPOC_COLUMN_PREFIX = "SPOC:";

/** `SPOC 1 Dept` / `SPOC 12 Email`, case- and space-insensitively. Captures the
 *  slot number so the two halves of one pair can be matched to each other. */
export const SPOC_PAIR_HEADER = /^spoc\s*(\d+)\s*(dept|email)$/;

/**
 * The one entry in `CLIENT_COLUMNS` that stands for a BLOCK of columns rather
 * than a column, and the only header in the template nobody types as written.
 *
 * A firm with three Depts downloads six real columns here — `SPOC 1 Dept`,
 * `SPOC 1 Email`, `SPOC 2 Dept`… — and the reader that expands it has to
 * recognise it. Named here rather than typed into both repositories, because a
 * magic string in two places is how a stand-in ends up literally in somebody's
 * spreadsheet.
 */
export const SPOC_COLUMN_TEMPLATE = "SPOC <n> Dept + SPOC <n> Email";

/** The real headers of one slot, in the order they belong on the sheet. */
export function spocPairHeaders(slot: number): readonly [string, string] {
  return [`SPOC ${String(slot)} Dept`, `SPOC ${String(slot)} Email`];
}

export const CLIENT_SHEET_MARKER = "Client Name";
export const CLIENT_COLUMNS: readonly SheetColumn[] = [
  { header: "Client Name", required: true, hint: "registered name, spelled the same on all 3 sheets", about: "The registered name, as it should print on a letter." },
  { header: "Known As", required: false, hint: "trading name, if different", about: "The trading name, if it differs." },
  { header: "Industry", required: false, hint: "optional", about: "" },
  { header: "Website", required: false, hint: "optional", about: "" },
  { header: "Client Since", required: false, hint: "YYYY-MM-DD, when the relationship began", about: "When the relationship started. Backdated, because it did. Defaults to the earliest engagement start, else today." },
  { header: "Group", required: false, hint: "blank unless this company sits inside a group client", about: "Leave blank for most rows. A client's name here makes this row a company inside that client's group. It is billed on the group's letter and handled by the group's account team, so put the Key Manager and SPOCs on the group's own row." },
  { header: "Country", required: true, hint: "2 letters: IN, AE, SG, GB, US", about: "Two-letter code. Required with Entity Type, unless this row is a group that other rows name." },
  { header: "Entity Type", required: true, hint: "private_limited, llp, partnership, pte_ltd, fzco, c_corp", about: "private_limited, llp, pte_ltd, fzco, c_corp… the firm's own word. Required with Country." },
  { header: "Incorporated On", required: false, hint: "YYYY-MM-DD", about: "2019-06-11 or 11-Jun-2019. Never 11/06/2019." },
  { header: "Financial Year End", required: false, hint: "MM-DD, e.g. 03-31", about: "MM-DD. Every statutory deadline is computed from it." },
  { header: "Registered Address", required: false, hint: "one cell, as on the certificate", about: "" },
  ...IDENTIFIER_COLUMNS.map((c) => ({ header: c.header, required: false, hint: c.hint, about: "" })),
  { header: "Key Manager", required: false, hint: "login email of the colleague who owns this client", about: "The email of the staff member who owns the relationship." },
  { header: SPOC_COLUMN_TEMPLATE, required: false, hint: "pairs: your Dept code, then that colleague's login email", about: "A pair of columns per SPOC: the Dept's own code or name, and that SPOC's email. Numbered, so the headers are the same at every firm. The Dept goes in the cell, not in the header. Need a fourth? Add \"SPOC 4 Dept\" and \"SPOC 4 Email\" to the sheet. (Sheets using the older \"SPOC: <code>\" headers are still read.)" },
  { header: "Signatory", required: false, hint: "who signed the paper letter for the client", about: "Who signed the paper letter for the client. Printed on the migrated letter's attestation." },
  { header: "Portal Invite", required: false, hint: "TRUE or FALSE", about: "TRUE to invite this client to their own portal login, FALSE (or blank) to send nothing. TRUE requires Portal Email." },
  { header: "Portal Email", required: false, hint: "the client's own login email, needed when Portal Invite is TRUE", about: "The client's own login address, not a director's. Required when Portal Invite is TRUE; ignored otherwise." },
];

export const PEOPLE_SHEET_MARKER = "Name";
export const PEOPLE_COLUMNS: readonly SheetColumn[] = [
  { header: "Client", required: true, hint: "exactly the Client Name from 1-clients", about: "The client, by the same registered name as the client sheet." },
  { header: "Of", required: false, hint: "a company in the group, if not the client itself", about: "Which company in the group they hold the role at. The client itself if blank." },
  { header: "Name", required: true, hint: "full name", about: "" },
  { header: "Relationship", required: true, hint: "director, signatory, shareholder or employee", about: "director, signatory, shareholder or employee." },
  { header: "Since", required: false, hint: "YYYY-MM-DD, optional", about: "When the role began. Defaults to today." },
  { header: "Email", required: false, hint: "optional", about: "Also how a re-run recognises the same person." },
  { header: "Phone", required: false, hint: "with country code, e.g. +91 98200 12345", about: "With the country code. A number without one is read as a number in the company's country." },
];

export const ENGAGEMENT_SHEET_MARKER = "Company";
export const ENGAGEMENT_COLUMNS: readonly SheetColumn[] = [
  { header: "Company", required: true, hint: "exactly the Client Name from 1-clients", about: "The company the work is delivered to, by registered name." },
  // No example code here, and that is the point: the codes belong to the firm's
  // own catalogue, and an invented `A1, H1, R7` reads as though the product
  // ships a fixed list of services. The same mistake the SPOC header made.
  { header: "Service", required: true, hint: "the service code from your catalogue", about: "The service's code from your own catalogue, exactly as it is written there. A code the catalogue does not have is refused rather than guessed at." },
  { header: "Started On", required: true, hint: "YYYY-MM-DD", about: "When the firm began delivering it." },
  { header: "Billed", required: false, hint: "one_time, monthly, quarterly, annually or custom", about: "one_time, monthly, quarterly, annually or custom. Defaults from the service." },
  { header: "Fee", required: false, hint: "digits only, per period, no commas or symbols", about: "Per period, as agreed. Blank means 'as per the paper letter' and is noted on the line." },
  { header: "Currency", required: false, hint: "3 letters, e.g. INR", about: "Three-letter code. Required when a Fee is given." },
  { header: "Where", required: false, hint: "2-letter country if not the company's own, else blank", about: "Two-letter country the work is in, if not the company's own." },
  { header: "Basis", required: false, hint: "where the signed paper letter is kept", about: "Where the real signed letter is kept: a folder, a reference. Recorded on the migrated letter." },
];

/** What the sheet's Relationship column may say, and the relationship type it
 *  means. Spelled out rather than passed through, because a typo in a
 *  spreadsheet should be a message naming the row, not a refused foreign key
 *  halfway through four hundred of them. */
export const RELATIONSHIP_WORDS: Readonly<Record<string, string>> = {
  director: "director_of",
  director_of: "director_of",
  signatory: "authorised_signatory_of",
  "authorised signatory": "authorised_signatory_of",
  "authorized signatory": "authorised_signatory_of",
  authorised_signatory_of: "authorised_signatory_of",
  shareholder: "shareholder_of",
  shareholder_of: "shareholder_of",
  employee: "employee_of",
  employee_of: "employee_of",
};

/** What the attestation says when the sheet names nobody: where the name is,
 *  rather than a name that was never given. */
export const MIGRATED_SIGNATORY = "Signatory as on the paper letter";

// ── Rows, in the product's vocabulary ────────────────────────────────────────

export type IsoDate = string;

export interface ImportIdentifier {
  readonly type: IdentifierType;
  /** As typed, trimmed. Normalised at validation. */
  readonly value: string;
}

/** One SPOC as the sheet names them: a Dept, by code or name, and an email. */
export interface ImportSpoc {
  /** As typed — the firm's code or the Dept's full name, resolved later. */
  readonly dept: string;
  readonly email: string;
  /** Which column said it, for a message that points at the right cell:
   *  `SPOC 2` for a numbered pair, `SPOC: IDT` for the older form. */
  readonly column: string;
}

export interface ClientRow {
  /** The row number the operator sees in Excel. Used in every message. */
  readonly lineNo: number;
  readonly legalName: string;
  readonly tradeName: string | null;
  readonly industry: string | null;
  readonly website: string | null;
  readonly clientSince: string | null;
  readonly group: string | null;
  readonly jurisdiction: string | null;
  readonly entityType: string | null;
  readonly incorporatedOn: string | null;
  readonly financialYearEnd: string | null;
  readonly registeredAddress: string | null;
  readonly identifiers: readonly ImportIdentifier[];
  readonly keyManagerEmail: string | null;
  /**
   * The SPOCs this row names, in sheet order.
   *
   * A LIST and not a map keyed by Dept, because G3.2 deliberately allows a Dept
   * to have more than one SPOC — leave cover, a joint SPOC on a large group, a
   * fortnight's parallel handover. A map would have silently kept the last of
   * two people named for the same Dept, which is the firm being told something
   * it did not say.
   */
  readonly spocs: readonly ImportSpoc[];
  readonly signatory: string | null;
  /** As typed — "TRUE" / "FALSE" / blank. Parsed and checked in validation,
   *  not here: a grid reader has no business deciding what a bad value means. */
  readonly portalInviteRaw: string | null;
  readonly portalEmail: string | null;
}

export interface PersonRow {
  readonly lineNo: number;
  readonly client: string;
  readonly of: string | null;
  readonly fullName: string;
  readonly relationship: string;
  readonly since: string | null;
  readonly email: string | null;
  readonly phone: string | null;
}

export interface EngagementRow {
  readonly lineNo: number;
  readonly company: string;
  readonly serviceCode: string;
  readonly startedOn: string;
  readonly billed: string | null;
  readonly fee: string | null;
  readonly currency: string | null;
  readonly where: string | null;
  readonly basis: string | null;
}

export interface ImportRows {
  readonly clients: readonly ClientRow[];
  readonly people: readonly PersonRow[];
  readonly engagements: readonly EngagementRow[];
}

// ── Reading a grid ───────────────────────────────────────────────────────────

/** One spelling of a header or a name, for comparing what a sheet says. */
export function normaliseName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface SheetRow {
  readonly lineNo: number;
  cell(header: string): string;
  /** Every header on the sheet, as typed. For the SPOC columns. */
  readonly headers: readonly string[];
}

/**
 * Rows keyed by header name, from a rectangular grid of strings.
 *
 * Returns null when no row carries the marker — which is the "is this the
 * right sheet?" answer, and the caller says so with the marker's name.
 */
export function rowsOf(
  grid: readonly (readonly string[])[],
  marker: string,
): readonly SheetRow[] | null {
  // Headers are compared through `headerKey`, so the bracketed hint every
  // downloaded sheet carries — `Client Name (registered name, …)` — is the
  // same column as a plain `Client Name`.
  const headerAt = grid.findIndex((r) => r.some((c) => headerKey(c) === headerKey(marker)));
  if (headerAt < 0) return null;
  const headerRow = grid[headerAt] ?? [];
  const keys = headerRow.map(headerKey);
  const headers = headerRow
    .map((h) => h.replace(/\s*\(.*$/s, "").trim())
    .filter((h) => h.length > 0);
  const rows: SheetRow[] = [];
  grid.slice(headerAt + 1).forEach((raw, offset) => {
    if (!raw.some((c) => c.trim())) return;
    rows.push({
      lineNo: headerAt + offset + 2,
      headers,
      cell: (name: string) => {
        const at = keys.indexOf(headerKey(name));
        return at < 0 ? "" : (raw[at] ?? "").trim();
      },
    });
  });
  return rows;
}

function blankToNull(s: string): string | null {
  const t = s.trim();
  return t === "" ? null : t;
}

/**
 * The SPOCs one row names, from both column shapes.
 *
 * A HALF-FILLED PAIR IS KEPT, not dropped. `SPOC 2 Dept` with no email beside
 * it is somebody's unfinished thought about a real client, and a reader that
 * quietly discarded it would load a client whose sheet plainly says who its
 * Accounting contact is with no Accounting SPOC on it and nothing said. It
 * comes through with the empty half blank and validation refuses it by name.
 * The older form cannot be half-filled — a blank cell there is simply a Dept
 * this client has no SPOC for, which is the ordinary case and not a finding.
 */
function spocsOfRow(r: SheetRow): readonly ImportSpoc[] {
  const out: ImportSpoc[] = [];
  const slots = new Map<number, { dept: string; email: string }>();
  for (const h of r.headers) {
    const pair = SPOC_PAIR_HEADER.exec(normaliseName(h));
    if (pair !== null) {
      const slot = Number(pair[1]);
      const half = slots.get(slot) ?? { dept: "", email: "" };
      if (pair[2] === "dept") half.dept = r.cell(h);
      else half.email = r.cell(h);
      slots.set(slot, half);
      continue;
    }
    if (!h.toUpperCase().startsWith(SPOC_COLUMN_PREFIX)) continue;
    const dept = h.slice(SPOC_COLUMN_PREFIX.length).trim();
    const email = r.cell(h);
    if (dept !== "" && email !== "") out.push({ dept, email, column: h.trim() });
  }
  // Numbered slots after the older form, in slot order — a sheet carrying both
  // reads the same however the columns happen to be arranged.
  for (const slot of [...slots.keys()].sort((a, b) => a - b)) {
    const half = slots.get(slot);
    if (half === undefined || (half.dept === "" && half.email === "")) continue;
    out.push({ dept: half.dept, email: half.email, column: `SPOC ${String(slot)}` });
  }
  return out;
}

export function clientRowsOf(rows: readonly SheetRow[]): readonly ClientRow[] {
  return rows.map((r) => {
    return {
      lineNo: r.lineNo,
      legalName: r.cell("Client Name"),
      tradeName: blankToNull(r.cell("Known As")),
      industry: blankToNull(r.cell("Industry")),
      website: blankToNull(r.cell("Website")),
      clientSince: blankToNull(r.cell("Client Since")),
      group: blankToNull(r.cell("Group")),
      jurisdiction: blankToNull(r.cell("Country")),
      entityType: blankToNull(r.cell("Entity Type")),
      incorporatedOn: blankToNull(r.cell("Incorporated On")),
      financialYearEnd: monthDayOf(blankToNull(r.cell("Financial Year End"))),
      registeredAddress: blankToNull(r.cell("Registered Address")),
      identifiers: IDENTIFIER_COLUMNS.flatMap((c) => {
        const value = r.cell(c.header);
        return value === "" ? [] : [{ type: c.type, value }];
      }),
      keyManagerEmail: blankToNull(r.cell("Key Manager")),
      spocs: spocsOfRow(r),
      signatory: blankToNull(r.cell("Signatory")),
      portalInviteRaw: blankToNull(r.cell("Portal Invite")),
      portalEmail: blankToNull(r.cell("Portal Email")),
    };
  });
}

export function personRowsOf(rows: readonly SheetRow[]): readonly PersonRow[] {
  return rows.map((r) => ({
    lineNo: r.lineNo,
    client: r.cell("Client"),
    of: blankToNull(r.cell("Of")),
    fullName: r.cell("Name"),
    relationship: r.cell("Relationship"),
    since: blankToNull(r.cell("Since")),
    email: blankToNull(r.cell("Email")),
    phone: blankToNull(r.cell("Phone")),
  }));
}

export function engagementRowsOf(rows: readonly SheetRow[]): readonly EngagementRow[] {
  return rows.map((r) => ({
    lineNo: r.lineNo,
    company: r.cell("Company"),
    serviceCode: r.cell("Service"),
    startedOn: r.cell("Started On"),
    billed: blankToNull(r.cell("Billed")),
    fee: blankToNull(r.cell("Fee")),
    currency: blankToNull(r.cell("Currency")),
    where: blankToNull(r.cell("Where")),
    basis: blankToNull(r.cell("Basis")),
  }));
}

// ── Dates ────────────────────────────────────────────────────────────────────

/**
 * `13-Feb-1995` → `1995-02-13`, and `2019-02-11` straight through.
 *
 * `13/02/1995` is REFUSED: it is 13 February or 2 November depending on who
 * typed it, and guessing a date on a legal record is worse than asking. The
 * round-trip through `Date` is not decoration — without it `32-Feb-1995`
 * formats as the well-shaped, entirely fictional `1995-02-32`.
 */
export function parseSheetDate(value: string): IsoDate | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return isCalendarDay(trimmed) ? trimmed : null;

  const m = /^(\d{1,2})[-/ ]([A-Za-z]{3,9})[-/ ](\d{4})$/.exec(trimmed);
  if (!m) return null;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const month = months.indexOf((m[2] ?? "").slice(0, 3).toLowerCase());
  if (month < 0) return null;
  const day = Number(m[1]);
  const year = Number(m[3]);
  const built = new Date(Date.UTC(year, month, day));
  if (built.getUTCFullYear() !== year || built.getUTCMonth() !== month || built.getUTCDate() !== day) {
    return null;
  }
  return built.toISOString().slice(0, 10);
}

export function isCalendarDay(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [y, m, d] = iso.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) return false;
  const built = new Date(Date.UTC(y, m - 1, d));
  return built.getUTCFullYear() === y && built.getUTCMonth() === m - 1 && built.getUTCDate() === d;
}

/**
 * "TRUE" or "FALSE", case-insensitively, trimmed — and nothing else. Blank is
 * FALSE (no invite is the safe default for a column a sheet may not even
 * carry yet), and anything unrecognised is null so the caller can refuse it
 * rather than guess which way a typo meant.
 */
export function parsePortalInvite(raw: string | null): boolean | null {
  if (raw === null) return false;
  const w = raw.trim().toUpperCase();
  if (w === "TRUE") return true;
  if (w === "FALSE") return false;
  return null;
}

/**
 * A Financial Year End as `MM-DD` when the cell holds a whole DATE.
 *
 * A year end typed into Excel becomes a date cell and the reader hands it back
 * as `2031-03-31` (Excel adds the current year to "31/03"); `31-Mar-2026` is a
 * date too. The year means nothing here and the month and day are
 * unambiguous, so they are kept. Anything else comes back unchanged, so the
 * refusal quotes what was typed.
 */
export function monthDayOf(s: string | null): string | null {
  if (s === null) return null;
  const day = parseSheetDate(s);
  return day === null ? s : day.slice(5);
}

/** `MM-DD`, and a day that exists in that month. */
export function isMonthDay(s: string): boolean {
  const m = /^(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return false;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const lengths = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= (lengths[month - 1] ?? 0);
}

/** The day `days` before `iso`, as a calendar day. */
export function daysBefore(iso: IsoDate, days: number): IsoDate {
  const [y, m, d] = iso.split("-").map(Number);
  const t = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) - days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

// ── What the firm already has — the snapshot the validator reads ─────────────

export interface KnownService {
  readonly serviceId: string;
  readonly serviceVersionId: string;
  readonly code: string;
  readonly name: string;
  /** The Dept code the live body files this service under, or null. */
  readonly module: string | null;
  /** The pinned body's recurrence — what a line is billed at when the sheet
   *  does not say. Null when the firm never stated one. */
  readonly billingFrequency: BillingFrequency | null;
}

export interface KnownAxis {
  readonly id: string;
  readonly axis: "dept" | "team";
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
}

export interface KnownOrganization {
  readonly partyId: string;
  readonly displayName: string;
  readonly registered: boolean;
  readonly jurisdiction: string | null;
  /** The party this company is billed through — its group parent, else itself. */
  readonly billToPartyId: string;
  readonly archived: boolean;
}

export interface ImportSnapshot {
  readonly today: IsoDate;
  readonly firmCurrency: string;
  /** Live catalogue services by NORMALISED code. */
  readonly services: ReadonlyMap<string, KnownService>;
  readonly axes: readonly KnownAxis[];
  /** Active staff by lower-cased email → user id. */
  readonly staff: ReadonlyMap<string, string>;
  /**
   * Active staff by NORMALISED display name → their login emails. Read only to
   * say which email a NAME typed into an email column belongs to: the column
   * still takes the email, because two colleagues share a first name at the
   * first firm already and picking one is a guess about who owns a client.
   */
  readonly staffByName: ReadonlyMap<string, readonly string[]>;
  readonly relationshipTypes: ReadonlySet<string>;
  /** Letter jurisdictions the firm's clause library can cover. */
  readonly clauseJurisdictions: ReadonlySet<string>;
  /** `${type}:${normalised value}` → the organization already holding it. */
  readonly byIdentifier: ReadonlyMap<string, KnownOrganization>;
  /** Normalised registered or trading name → the organization on file. */
  readonly byName: ReadonlyMap<string, KnownOrganization>;
  /**
   * Lower-cased email → the person already on file, and the roles they hold.
   *
   * `roles` is `${toPartyId}:${type}`. A people row is one ROLE, so a person
   * already on file is not a reason to skip the row — only a role already
   * recorded is.
   */
  readonly peopleByEmail: ReadonlyMap<
    string,
    { readonly partyId: string; readonly name: string; readonly roles: ReadonlySet<string> }
  >;
  /** `${entityPartyId}:${serviceId}` for every engagement in force today. */
  readonly activeEngagements: ReadonlySet<string>;
  /** The firm's compliance go-live floor, or null for no floor. */
  readonly complianceFloor: IsoDate | null;
  /** How far back the calendar generates — the calendar's own constant. */
  readonly reachBackDays: number;
}

// ── The verdict ──────────────────────────────────────────────────────────────

export type Sheet = "clients" | "people" | "engagements";
export type Severity = "blocking" | "warning";

export interface Finding {
  readonly sheet: Sheet | "file";
  /** Null for a finding about the file as a whole — a header, a missing sheet. */
  readonly lineNo: number | null;
  readonly name: string;
  readonly severity: Severity;
  readonly message: string;
}

export type RowAction = "create" | "skip" | "blocked";

export interface RowVerdict {
  readonly sheet: Sheet;
  readonly lineNo: number;
  readonly name: string;
  readonly action: RowAction;
  /** Why it is skipped; what it becomes when created. Null when blocked — the
   *  findings say why. */
  readonly detail: string | null;
}

/** One line of a migrated letter. */
export interface LetterLinePlan {
  readonly engagementLineNo: number;
  /** The client-sheet row of the entity, or null when the entity is on file. */
  readonly entityLineNo: number | null;
  readonly entityPartyId: string | null;
  readonly entityName: string;
  readonly serviceCode: string;
  readonly serviceName: string;
  readonly serviceVersionId: string;
  readonly startedOn: IsoDate;
  readonly billingFrequency: BillingFrequency;
  readonly unitAmount: string | null;
  /** What the fee is in (0344): the letter's main currency or another. */
  readonly currency: string;
  readonly jurisdiction: string | null;
  readonly basis: string | null;
}

/** The main currency of a letter whose lines are in `currencies`: the firm's
 *  own when any line is in it, else the one most lines are in, ties by code. */
export function mainCurrency(currencies: readonly string[], firmCurrency: string): string {
  if (currencies.includes(firmCurrency) || currencies.length === 0) return firmCurrency;
  const count = new Map<string, number>();
  for (const c of currencies) count.set(c, (count.get(c) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? firmCurrency;
}

/** One migrated letter: a client, its lines in whatever currencies they are
 *  in (0345, Q006). `currency` is the MAIN one; every other currency on a
 *  line gets a rate on the letter when it is written. */
export interface LetterPlan {
  readonly clientName: string;
  /** The client-sheet row being billed, or null when the client is on file. */
  readonly clientLineNo: number | null;
  readonly clientPartyId: string | null;
  readonly jurisdiction: string;
  readonly currency: string;
  readonly effectiveFrom: IsoDate;
  readonly signatory: string;
  readonly lines: readonly LetterLinePlan[];
}

/** One client this sheet asks to be invited to its own portal login. */
export interface PortalInvitePlan {
  readonly clientLineNo: number;
  readonly clientName: string;
  /** Known now when the client is already on file; null means "resolve from
   *  the line at confirm time", the same convention `LetterLinePlan` uses. */
  readonly clientPartyId: string | null;
  readonly email: string;
}

export interface ImportCounts {
  readonly clientsToCreate: number;
  readonly clientsOnFile: number;
  readonly clientsBlocked: number;
  readonly entitiesToRegister: number;
  /** PARTIES this sheet would create — not people ROWS. A people row is a
   *  ROLE, so one director of three companies is three rows and one person. */
  readonly peopleToCreate: number;
  /** Directorships, signatory roles and the like — one per people row that
   *  would load, whether or not it also creates the person. */
  readonly rolesToRecord: number;
  /** People rows skipped because that exact role is already recorded. */
  readonly peopleOnFile: number;
  readonly peopleBlocked: number;
  readonly engagementsToCreate: number;
  readonly engagementsOnFile: number;
  readonly engagementsBlocked: number;
  readonly lettersToDraft: number;
  readonly assignmentsToRecord: number;
  readonly portalInvitesToSend: number;
}

export interface ImportReport {
  readonly findings: readonly Finding[];
  readonly blocking: number;
  readonly warnings: number;
  readonly rows: readonly RowVerdict[];
  readonly letters: readonly LetterPlan[];
  readonly portalInvites: readonly PortalInvitePlan[];
  /** A people row's phone as it will be stored (E.164), keyed by the row. A
   *  number typed without its calling code is completed with the country of
   *  the company the row is for, which is a fact the confirm step would
   *  otherwise have to look up again. */
  readonly peoplePhones: ReadonlyMap<number, string>;
  readonly counts: ImportCounts;
  readonly compliance: {
    readonly floor: IsoDate | null;
    readonly reachBackFrom: IsoDate;
    /** Engagements starting before the reach-back window — each gets up to
     *  three months of filings whose dates have passed. */
    readonly engagementsBeforeReachBack: number;
  };
}

/** Whether a report may be confirmed at all. */
export function mayConfirm(report: Pick<ImportReport, "blocking">): boolean {
  return report.blocking === 0;
}

// ── Validation ───────────────────────────────────────────────────────────────

/** What a client row resolved to, carried between the passes. */
interface ResolvedClient {
  readonly row: ClientRow;
  readonly key: string;
  readonly onFile: KnownOrganization | null;
  readonly blocked: boolean;
  readonly registered: boolean;
  /** The sheet row of the group parent, when the row is a child. */
  readonly parent: ResolvedClient | null;
  /** The on-file parent, when the parent is not on the sheet. */
  readonly parentOnFile: KnownOrganization | null;
}

/** The company a people or engagement row names, wherever it was found. */
interface Company {
  readonly name: string;
  readonly sheetRow: ResolvedClient | null;
  readonly onFile: KnownOrganization | null;
  readonly registered: boolean;
  readonly jurisdiction: string | null;
  readonly blocked: boolean;
}

/** Who a line is billed to — the group parent when there is one. */
interface BillTo {
  readonly key: string;
  readonly name: string;
  readonly lineNo: number | null;
  readonly partyId: string | null;
  readonly jurisdiction: string | null;
  readonly signatory: string | null;
}

interface PlannedLine {
  readonly line: LetterLinePlan;
  readonly billTo: BillTo;
  readonly currency: string;
  /** The entity's own country, for a letter whose client has none. */
  readonly entityJurisdiction: string | null;
}

/** The relationship as a sentence reads it: `authorised_signatory_of` becomes
 *  "an authorised signatory". The article is chosen because the four words this
 *  reads include one that starts with a vowel, and "a authorised signatory" in
 *  a refusal is the kind of thing a partner forwards to somebody. */
function roleWords(relationship: string): string {
  const word = relationship.replace(/_of$/, "").replace(/_/g, " ");
  return `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;
}

/**
 * The rest of the sentence refusing `typed` in a column that takes a
 * colleague's login email. A name gets the email it belongs to, or the emails
 * of every colleague it could be, because "is not an active member of staff"
 * reads as "this person does not work here" to somebody who typed their name.
 */
function notStaff(typed: string, snap: ImportSnapshot): string {
  const emails = typed.includes("@") ? [] : (snap.staffByName.get(normaliseName(typed)) ?? []);
  if (emails.length === 1) {
    return `"${typed}" is a name. This column takes the colleague's login email: ${emails[0] ?? ""}`;
  }
  if (emails.length > 1) {
    return `"${typed}" is a name, and ${String(emails.length)} colleagues have it (${emails.join(", ")}). Put the login email of the one you mean`;
  }
  if (!typed.includes("@")) {
    return `"${typed}" is not an email. This column takes the login email of an active member of staff at this firm`;
  }
  return `"${typed}" is not an active member of staff at this firm`;
}

export function validateImport(rows: ImportRows, snap: ImportSnapshot): ImportReport {
  const findings: Finding[] = [];
  const verdicts: RowVerdict[] = [];
  const block = (sheet: Sheet | "file", lineNo: number | null, name: string, message: string): void => {
    findings.push({ sheet, lineNo, name, severity: "blocking", message });
  };
  const warn = (sheet: Sheet | "file", lineNo: number | null, name: string, message: string): void => {
    findings.push({ sheet, lineNo, name, severity: "warning", message });
  };

  // ── The Dept columns, once for the file ──────────────────────────────────
  const activeDepts = snap.axes.filter((a) => a.axis === "dept" && a.isActive);
  const deptOf = (word: string): KnownAxis | null => {
    const w = normaliseName(word);
    return (
      activeDepts.find((a) => normaliseName(a.code) === w) ??
      activeDepts.find((a) => normaliseName(a.name) === w) ??
      null
    );
  };
  const deptsHere = (): string =>
    activeDepts.length === 0
      ? "this firm has published no Depts yet. Publish them under Structure first"
      : `the firm's Depts are ${activeDepts.map((a) => `${a.code} (${a.name})`).join(", ")}`;

  // A Dept written in a HEADER that names nothing is a fault of the FILE: every
  // row under it is wrong in the same way, and one finding says so once instead
  // of four hundred times. A Dept written in a CELL is a fault of that ROW, and
  // is refused below beside the client it was typed against — which is the
  // quiet advantage of the numbered pairs, not just the tidier header.
  const headerWords = new Set(
    rows.clients.flatMap((c) =>
      c.spocs.filter((s) => s.column.startsWith(SPOC_COLUMN_PREFIX)).map((s) => s.dept),
    ),
  );
  for (const word of headerWords) {
    if (deptOf(word) === null) {
      block("file", null, `SPOC: ${word}`, `the column "SPOC: ${word}" names no active Dept: ${deptsHere()}`);
    }
  }

  // ── Clients, pass one: each row on its own ───────────────────────────────
  const namedAsGroup = new Set(rows.clients.flatMap((c) => (c.group ? [normaliseName(c.group)] : [])));
  const seenNames = new Map<string, number>();
  const seenIdentifiers = new Map<string, number>();
  const resolved: ResolvedClient[] = [];

  for (const row of rows.clients) {
    const name = row.legalName.trim() === "" ? `row ${String(row.lineNo)}` : row.legalName;
    let blocked = false;
    const bad = (message: string): void => {
      block("clients", row.lineNo, name, message);
      blocked = true;
    };

    if (row.legalName.trim() === "") bad("Client Name is blank");
    const key = normaliseName(row.legalName);
    if (key !== "") {
      const earlier = seenNames.get(key);
      if (earlier !== undefined) bad(`the same Client Name is on row ${String(earlier)}`);
      else seenNames.set(key, row.lineNo);
    }

    const hasCountry = row.jurisdiction !== null;
    const hasType = row.entityType !== null;
    if (hasCountry !== hasType) {
      bad(
        hasCountry
          ? "has a Country but no Entity Type. A registration needs both"
          : "has an Entity Type but no Country. A registration needs both",
      );
    }
    if (hasCountry && !isCountryCode((row.jurisdiction ?? "").trim().toUpperCase())) {
      bad(`Country: ${countryCodeProblem(row.jurisdiction ?? "")}`);
    }
    const registered = hasCountry && hasType;
    const isGroupParent = namedAsGroup.has(key);
    // Said once: a row with only one half filled was refused above, and a
    // second sentence about the same two cells is noise.
    if (!hasCountry && !hasType && !isGroupParent && row.group === null) {
      bad("needs a Country and an Entity Type, or companies under it naming it in Group");
    }
    if (!hasCountry && !hasType && row.group !== null) {
      bad("a company inside a group needs a Country and an Entity Type. Without a registration it cannot be issued a letter or given a deadline");
    }
    if (registered && row.financialYearEnd === null) {
      warn("clients", row.lineNo, name, "no Financial Year End. Legal deadlines cannot be worked out for it until one is recorded");
    }
    if (row.financialYearEnd !== null && !isMonthDay(row.financialYearEnd)) {
      bad(`Financial Year End "${row.financialYearEnd}" is not MM-DD`);
    }
    if (row.clientSince !== null && parseSheetDate(row.clientSince) === null) {
      bad(`Client Since "${row.clientSince}" is not a date this can read. Use 2026-08-23 or 13-Feb-1995`);
    }
    if (row.incorporatedOn !== null && parseSheetDate(row.incorporatedOn) === null) {
      bad(`Incorporated On "${row.incorporatedOn}" is not a date this can read. Use 2026-08-23 or 13-Feb-1995`);
    }

    for (const id of row.identifiers) {
      const value = normalizeIdentifier(id.type, id.value);
      if (!isValidIdentifier(id.type, value)) {
        bad(`${id.type.toUpperCase()} "${id.value}" is not a well-formed ${id.type.toUpperCase()}`);
        continue;
      }
      const k = `${id.type}:${value}`;
      const earlier = seenIdentifiers.get(k);
      if (earlier !== undefined) bad(`${id.type.toUpperCase()} ${value} is also on row ${String(earlier)}`);
      else seenIdentifiers.set(k, row.lineNo);
    }

    if (row.keyManagerEmail !== null && !snap.staff.has(row.keyManagerEmail.toLowerCase())) {
      bad(`Key Manager ${notStaff(row.keyManagerEmail, snap)}`);
    }
    // A company inside a group is owned through the group — its letter is the
    // group's and so is its account team — so only a standalone client with no
    // Key Manager is a client nobody owns.
    if (row.keyManagerEmail === null && row.group === null) {
      warn("clients", row.lineNo, name, "no Key Manager. Nobody at the firm will own this client until somebody is named");
    }
    // A pair is both halves or neither. Half of one is not a smaller version of
    // a SPOC — an email with no Dept cannot become an assignment at all, and a
    // Dept with no email is a client whose sheet says who covers it and then
    // does not say who.
    for (const spoc of row.spocs) {
      const fromHeader = spoc.column.startsWith(SPOC_COLUMN_PREFIX);
      if (spoc.dept === "") {
        bad(`${spoc.column} Email is "${spoc.email}" with no ${spoc.column} Dept beside it. A SPOC covers a Dept, so there is nothing to put them in charge of`);
        continue;
      }
      if (spoc.email === "") {
        bad(`${spoc.column} Dept is "${spoc.dept}" with no ${spoc.column} Email beside it. Say who the SPOC for it is, or clear both cells`);
        continue;
      }
      // A bad header was already refused once for the whole file; a bad CELL is
      // this row's own and names the client it was typed against.
      if (deptOf(spoc.dept) === null) {
        if (!fromHeader) bad(`${spoc.column} Dept is "${spoc.dept}", which is no active Dept at this firm: ${deptsHere()}`);
        continue;
      }
      if (!snap.staff.has(spoc.email.toLowerCase())) {
        bad(`SPOC for ${spoc.dept} ${notStaff(spoc.email, snap)}`);
      }
    }

    // Portal Invite is TRUE, FALSE or blank — nothing else. TRUE requires an
    // address, because a login with nobody to mail it to is the halfway state
    // the invite service itself refuses; FALSE (or blank) means nobody is
    // invited, whatever Portal Email says, and that column is simply ignored.
    const portalInvite = parsePortalInvite(row.portalInviteRaw);
    if (portalInvite === null) {
      bad(`Portal Invite "${row.portalInviteRaw ?? ""}" is not TRUE or FALSE`);
    }
    if (portalInvite === true) {
      if (row.portalEmail === null) {
        bad("Portal Invite is TRUE but no Portal Email is given, so there is nobody to send the login to");
      } else {
        const normalised = normalizeIdentifier("email", row.portalEmail);
        if (!isValidIdentifier("email", normalised)) {
          bad(`Portal Email "${row.portalEmail}" is not an email address`);
        }
      }
    }

    // On file? By a registration number first — that is the only thing on
    // the sheet that is actually an identity — then by name.
    let onFile: KnownOrganization | null = null;
    for (const id of row.identifiers) {
      const hit = snap.byIdentifier.get(`${id.type}:${normalizeIdentifier(id.type, id.value)}`);
      if (hit) {
        onFile = hit;
        break;
      }
    }
    if (onFile === null && key !== "") onFile = snap.byName.get(key) ?? null;

    resolved.push({ row, key, onFile, blocked, registered, parent: null, parentOnFile: null });
  }

  // ── Clients, pass two: groups — after every row exists to be found ───────
  const bySheetName = new Map(resolved.filter((r) => r.key !== "").map((r) => [r.key, r] as const));
  const withParents: ResolvedClient[] = resolved.map((r) => {
    if (r.row.group === null) return r;
    const gk = normaliseName(r.row.group);
    const parent = bySheetName.get(gk) ?? null;
    const parentOnFile = parent === null ? (snap.byName.get(gk) ?? null) : null;
    if (parent === null && parentOnFile === null) {
      block("clients", r.row.lineNo, r.row.legalName, `no client called "${r.row.group}" on this sheet or on file. Check the Group column`);
      return { ...r, blocked: true };
    }
    if (parent !== null && parent.row.group !== null) {
      block("clients", r.row.lineNo, r.row.legalName, `"${r.row.group}" is itself inside a group. Groups are one level deep`);
      return { ...r, blocked: true };
    }
    return { ...r, parent, parentOnFile };
  });
  // A child whose parent is blocked is blocked too; the parent may not exist.
  const clients: ResolvedClient[] = withParents.map((r) => {
    if (r.parent !== null && r.parent.blocked && !r.blocked) {
      block("clients", r.row.lineNo, r.row.legalName, `its group "${r.parent.row.legalName}" (row ${String(r.parent.row.lineNo)}) has errors`);
      return { ...r, blocked: true };
    }
    return r;
  });
  const clientAt = (lineNo: number): ResolvedClient | null => clients.find((c) => c.row.lineNo === lineNo) ?? null;

  let assignments = 0;
  let entities = 0;
  const portalInvites: PortalInvitePlan[] = [];
  for (const c of clients) {
    if (c.blocked) {
      verdicts.push({ sheet: "clients", lineNo: c.row.lineNo, name: c.row.legalName, action: "blocked", detail: null });
      continue;
    }
    // Re-derived rather than carried on `ResolvedClient`: a row that reached
    // here is unblocked, so a bad value or a missing address already refused
    // it above and cannot appear now.
    if (parsePortalInvite(c.row.portalInviteRaw) === true && c.row.portalEmail !== null) {
      portalInvites.push({
        clientLineNo: c.row.lineNo,
        clientName: c.row.legalName,
        clientPartyId: c.onFile?.partyId ?? null,
        email: normalizeIdentifier("email", c.row.portalEmail),
      });
    }
    if (c.onFile !== null) {
      warn("clients", c.row.lineNo, c.row.legalName, `already on file as "${c.onFile.displayName}" . Skipped, not updated`);
      verdicts.push({ sheet: "clients", lineNo: c.row.lineNo, name: c.row.legalName, action: "skip", detail: `already on file as "${c.onFile.displayName}"` });
      continue;
    }
    if (c.registered) entities += 1;
    if (c.row.keyManagerEmail !== null) assignments += 1;
    assignments += c.row.spocs.filter((s) => deptOf(s.dept) !== null && s.email !== "").length;
    const parentName = c.parent?.row.legalName ?? c.parentOnFile?.displayName ?? null;
    verdicts.push({
      sheet: "clients",
      lineNo: c.row.lineNo,
      name: c.row.legalName,
      action: "create",
      detail:
        parentName !== null
          ? `a company under "${parentName}"`
          : c.registered
            ? `${withArticle(entityKindWords(c.row.entityType ?? ""))} in ${countryWords(c.row.jurisdiction ?? "")}`
            : "a group, with companies under it",
    });
  }

  // ── The company a people or engagement row names ─────────────────────────
  //
  // On the sheet first — a sheet describes itself — and on file second. A
  // sheet row that is already on file resolves to the on-file company, so a
  // directors sheet for an existing client still loads.
  const companyOf = (word: string): Company | null => {
    const k = normaliseName(word);
    const sheet = bySheetName.get(k);
    const fromSheet = sheet === undefined ? null : clientAt(sheet.row.lineNo);
    if (fromSheet !== null) {
      if (fromSheet.onFile !== null) {
        return {
          name: fromSheet.onFile.displayName,
          sheetRow: null,
          onFile: fromSheet.onFile,
          registered: fromSheet.onFile.registered,
          jurisdiction: fromSheet.onFile.jurisdiction,
          blocked: false,
        };
      }
      return {
        name: fromSheet.row.legalName,
        sheetRow: fromSheet,
        onFile: null,
        registered: fromSheet.registered,
        jurisdiction: fromSheet.row.jurisdiction === null ? null : fromSheet.row.jurisdiction.toUpperCase(),
        blocked: fromSheet.blocked,
      };
    }
    const onFile = snap.byName.get(k) ?? null;
    if (onFile === null) return null;
    return {
      name: onFile.displayName,
      sheetRow: null,
      onFile,
      registered: onFile.registered,
      jurisdiction: onFile.jurisdiction,
      blocked: false,
    };
  };

  // ── People ───────────────────────────────────────────────────────────────
  //
  // A ROW IS A ROLE, NOT A PERSON. One director of three companies in a group
  // is three rows, and the sheet says so plainly — the same name and the same
  // email on each. The email is what makes them one person: the first row
  // carrying it creates them, every later row finds them and adds the new role.
  //
  // Which means neither of the two things that would be tidier is right. A
  // second row with the same email is NOT a duplicate to refuse, and a person
  // already on file is NOT a row to skip — skipping it drops the role that row
  // existed to record, silently, on the client that needed it. Only the exact
  // ROLE being on file already makes a row a no-op, and that is what keeps a
  // second run of the same sheet boring.
  let peopleToCreate = 0;
  let rolesToRecord = 0;
  let peopleOnFile = 0;
  let peopleBlocked = 0;
  const peoplePhones = new Map<number, string>();
  /** `${email}|${target}|${type}` → the row that already said it. */
  const seenRoles = new Map<string, number>();
  /** Lower-cased email → the first row naming it, and the name it used. */
  const seenPeople = new Map<string, { readonly lineNo: number; readonly name: string }>();
  for (const p of rows.people) {
    const name = p.fullName.trim() === "" ? `row ${String(p.lineNo)}` : p.fullName;
    let blocked = false;
    const bad = (message: string): void => {
      block("people", p.lineNo, name, message);
      blocked = true;
    };
    if (p.fullName.trim() === "") bad("Name is blank");
    if (p.client.trim() === "") bad("Client is blank");
    const client = p.client.trim() === "" ? null : companyOf(p.client);
    if (p.client.trim() !== "" && client === null) bad(`no client called "${p.client}" on this sheet or on file`);
    if (client !== null && client.blocked) bad(`its client "${client.name}" has errors on the client sheet`);
    const target = p.of === null ? client : companyOf(p.of);
    if (p.of !== null && target === null) bad(`no company called "${p.of}" on this sheet or on file`);
    if (p.of !== null && target !== null && target.blocked) bad(`the company "${target.name}" has errors on the client sheet`);

    const relationship = RELATIONSHIP_WORDS[normaliseName(p.relationship)];
    if (p.relationship.trim() === "") bad("Relationship is blank");
    else if (relationship === undefined || !snap.relationshipTypes.has(relationship)) {
      bad(`Relationship "${p.relationship}" is not one this can read. Use director, signatory, shareholder or employee`);
    }
    if (p.since !== null && parseSheetDate(p.since) === null) {
      bad(`Since "${p.since}" is not a date this can read. Use 2026-08-23 or 13-Feb-1995`);
    }
    const email = p.email === null ? null : normalizeIdentifier("email", p.email);
    if (email !== null && !isValidIdentifier("email", email)) bad(`Email "${p.email ?? ""}" is not an email address`);
    const phone = p.phone === null ? null : normalizeIdentifier("phone", p.phone, target?.jurisdiction ?? client?.jurisdiction);
    if (phone !== null && !isValidIdentifier("phone", phone)) {
      bad(`Phone "${p.phone ?? ""}" is not a phone number this can read. Write it with the country code, for example +91 98200 12345`);
    } else if (phone !== null) peoplePhones.set(p.lineNo, phone);

    // The SAME ROLE twice — same person, same company, same relationship — is a
    // duplicate, and the only shape of repeated email that is one.
    if (email !== null && relationship !== undefined && target !== null) {
      const key = `${email}|${normaliseName(target.name)}|${relationship}`;
      const earlier = seenRoles.get(key);
      if (earlier !== undefined) {
        bad(`row ${String(earlier)} already makes "${p.email ?? ""}" ${roleWords(relationship)} of ${target.name}`);
      } else seenRoles.set(key, p.lineNo);
    }

    if (blocked) {
      peopleBlocked += 1;
      verdicts.push({ sheet: "people", lineNo: p.lineNo, name, action: "blocked", detail: null });
      continue;
    }

    // Who this row's person IS: somebody on file, somebody an earlier row made,
    // or somebody new. A row with no email is always somebody new — there is
    // nothing to recognise them by, and guessing from a name would merge two
    // real people who happen to share one.
    const onFile = email === null ? undefined : snap.peopleByEmail.get(email);
    const earlierRow = email === null ? undefined : seenPeople.get(email);
    if (email !== null && earlierRow === undefined) {
      seenPeople.set(email, { lineNo: p.lineNo, name });
    }
    // Said once, on the second row, because it is about the pair.
    if (earlierRow !== undefined && normaliseName(earlierRow.name) !== normaliseName(name)) {
      warn("people", p.lineNo, name, `row ${String(earlierRow.lineNo)} calls this email "${earlierRow.name}". One email is one person, so the role is added to them and this spelling of the name is not recorded`);
    } else if (onFile !== undefined && normaliseName(onFile.name) !== normaliseName(name)) {
      warn("people", p.lineNo, name, `already on file as "${onFile.name}". The role is added to them and this spelling of the name is not recorded`);
    }

    // Only the exact ROLE already being on file makes this row a no-op. A
    // company created by this very sheet has no partyId yet and therefore no
    // roles on file, so there is nothing to compare.
    const targetOnFileId = target?.onFile?.partyId ?? null;
    if (onFile !== undefined && targetOnFileId !== null && relationship !== undefined) {
      if (onFile.roles.has(`${targetOnFileId}:${relationship}`)) {
        peopleOnFile += 1;
        warn("people", p.lineNo, name, `already recorded as ${roleWords(relationship)} of ${target?.name ?? p.client} . Skipped, not updated`);
        verdicts.push({ sheet: "people", lineNo: p.lineNo, name, action: "skip", detail: `already ${roleWords(relationship)} of ${target?.name ?? p.client}` });
        continue;
      }
    }

    rolesToRecord += 1;
    if (earlierRow === undefined && onFile === undefined) peopleToCreate += 1;
    const word = relationship === undefined ? p.relationship : relationship.replace(/_of$/, "").replace(/_/g, " ");
    const whose =
      earlierRow !== undefined
        ? `, added to the person on row ${String(earlierRow.lineNo)}`
        : onFile !== undefined
          ? `, added to "${onFile.name}", already on file`
          : "";
    verdicts.push({ sheet: "people", lineNo: p.lineNo, name, action: "create", detail: `${word} of ${target?.name ?? p.client}${whose}` });
  }

  // ── Engagements, and the letters they fold into ──────────────────────────
  let engagementsToCreate = 0;
  let engagementsOnFile = 0;
  let engagementsBlocked = 0;
  let beforeReachBack = 0;
  const reachBackFrom = daysBefore(snap.today, snap.reachBackDays);
  const seenEngagements = new Map<string, number>();
  const planned: PlannedLine[] = [];

  for (const e of rows.engagements) {
    const name = `${e.company.trim() === "" ? `row ${String(e.lineNo)}` : e.company}: ${e.serviceCode}`;
    let blocked = false;
    const bad = (message: string): void => {
      block("engagements", e.lineNo, name, message);
      blocked = true;
    };
    if (e.company.trim() === "") bad("Company is blank");
    const company = e.company.trim() === "" ? null : companyOf(e.company);
    if (e.company.trim() !== "" && company === null) bad(`no company called "${e.company}" on this sheet or on file`);
    if (company !== null && company.blocked) bad(`the company "${company.name}" has errors on the client sheet`);
    if (company !== null && !company.blocked && !company.registered) {
      bad(`"${company.name}" has no registration. A letter line names a legal entity, so give it a Country and an Entity Type`);
    }
    if (company?.onFile?.archived === true) bad(`"${company.name}" is archived. Unarchive it first`);

    const service = e.serviceCode.trim() === "" ? undefined : snap.services.get(normaliseName(e.serviceCode));
    if (e.serviceCode.trim() === "") bad("Service is blank");
    else if (service === undefined) bad(`no live service with the code "${e.serviceCode}" in the catalogue`);

    const startedOn = parseSheetDate(e.startedOn);
    if (e.startedOn.trim() === "") bad("Started On is blank");
    else if (startedOn === null) bad(`Started On "${e.startedOn}" is not a date this can read. Use 2026-08-23 or 13-Feb-1995`);
    else if (startedOn > snap.today) bad(`Started On ${startedOn} is in the future. A migrated engagement is one the firm is already delivering`);

    const billed = e.billed === null ? null : e.billed.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (billed !== null && !isBillingFrequency(billed)) {
      bad(`Billed "${e.billed ?? ""}" is not one_time, monthly, quarterly, annually or custom`);
    }
    if (billed === null && service !== undefined && service.billingFrequency === null) {
      bad(`Billed is blank and the service "${service.name}" states no recurrence. Say how this one is billed`);
    }
    const fee = e.fee === null ? null : e.fee.replace(/,/g, "").trim();
    if (fee !== null && !isAmount(fee)) bad(`Fee "${e.fee ?? ""}" is not an amount. Use digits and up to four decimals`);
    const currency = e.currency === null ? null : normalizeCurrency(e.currency);
    if (currency !== null && !isCurrencyCode(currency)) bad(`Currency "${e.currency ?? ""}" is not a three-letter code`);
    if (fee !== null && currency === null) bad("has a Fee with no Currency. Say which currency the fee is in");
    if (fee === null && !blocked) {
      warn("engagements", e.lineNo, name, "no Fee. The line will read 'as per the paper letter' and carry no amount");
    }
    if (e.where !== null && !isCountryCode(e.where.trim().toUpperCase())) bad(`Where: ${countryCodeProblem(e.where)}`);

    if (company !== null && service !== undefined) {
      const k = `${normaliseName(company.name)}:${normaliseName(service.code)}`;
      const earlier = seenEngagements.get(k);
      if (earlier !== undefined) bad(`the same company and service is on row ${String(earlier)}`);
      else seenEngagements.set(k, e.lineNo);
    }

    if (blocked) {
      engagementsBlocked += 1;
      verdicts.push({ sheet: "engagements", lineNo: e.lineNo, name, action: "blocked", detail: null });
      continue;
    }
    // Narrowed by the checks above; restated for the types.
    if (company === null || service === undefined || startedOn === null) continue;

    if (company.onFile !== null && snap.activeEngagements.has(`${company.onFile.partyId}:${service.serviceId}`)) {
      engagementsOnFile += 1;
      warn("engagements", e.lineNo, name, `"${company.name}" already has ${service.name} in force. Skipped`);
      verdicts.push({ sheet: "engagements", lineNo: e.lineNo, name, action: "skip", detail: `${service.name} already in force` });
      continue;
    }

    // Whose letter this line belongs on: the group parent when there is one,
    // the company itself otherwise.
    const sheetParent = company.sheetRow?.parent ?? null;
    const onFileParent = company.sheetRow?.parentOnFile ?? null;
    let billTo: BillTo;
    if (sheetParent !== null) {
      billTo = {
        key: `sheet:${sheetParent.key}`,
        name: sheetParent.row.legalName,
        lineNo: sheetParent.row.lineNo,
        partyId: null,
        jurisdiction: sheetParent.row.jurisdiction === null ? null : sheetParent.row.jurisdiction.toUpperCase(),
        signatory: sheetParent.row.signatory,
      };
    } else if (onFileParent !== null) {
      billTo = {
        key: `file:${onFileParent.partyId}`,
        name: onFileParent.displayName,
        lineNo: null,
        partyId: onFileParent.partyId,
        jurisdiction: onFileParent.jurisdiction,
        signatory: company.sheetRow?.row.signatory ?? null,
      };
    } else if (company.sheetRow !== null) {
      billTo = {
        key: `sheet:${company.sheetRow.key}`,
        name: company.sheetRow.row.legalName,
        lineNo: company.sheetRow.row.lineNo,
        partyId: null,
        jurisdiction: company.jurisdiction,
        signatory: company.sheetRow.row.signatory,
      };
    } else {
      const billToId = company.onFile?.billToPartyId ?? null;
      const parentOrg = billToId === null ? null : [...snap.byName.values()].find((o) => o.partyId === billToId) ?? null;
      billTo = {
        key: `file:${billToId ?? ""}`,
        name: parentOrg?.displayName ?? company.name,
        lineNo: null,
        partyId: billToId,
        jurisdiction: parentOrg?.jurisdiction ?? company.jurisdiction,
        signatory: null,
      };
    }

    // The Dept this service is filed under should have a SPOC on the client.
    if (service.module !== null && company.sheetRow !== null) {
      const owner = sheetParent ?? company.sheetRow;
      const hasSpoc = owner.row.spocs.some((s) => deptOf(s.dept)?.code === service.module);
      if (!hasSpoc && owner.onFile === null) {
        warn("engagements", e.lineNo, name, `${service.name} is ${service.module}'s work and "${owner.row.legalName}" names no SPOC for ${service.module}`);
      }
    }
    if (startedOn < reachBackFrom) beforeReachBack += 1;

    engagementsToCreate += 1;
    const billingFrequency = billed !== null && isBillingFrequency(billed) ? billed : service.billingFrequency;
    planned.push({
      currency: currency ?? snap.firmCurrency,
      billTo,
      entityJurisdiction: company.jurisdiction,
      line: {
        engagementLineNo: e.lineNo,
        entityLineNo: company.sheetRow?.row.lineNo ?? null,
        entityPartyId: company.onFile?.partyId ?? null,
        entityName: company.name,
        serviceCode: service.code,
        serviceName: service.name,
        serviceVersionId: service.serviceVersionId,
        startedOn,
        // Narrowed above: a blank Billed with a service stating no
        // recurrence was refused, so one of the two is present here.
        billingFrequency: billingFrequency ?? "custom",
        unitAmount: fee,
        currency: currency ?? snap.firmCurrency,
        jurisdiction: e.where === null ? null : e.where.toUpperCase(),
        basis: e.basis,
      },
    });
    verdicts.push({
      sheet: "engagements",
      lineNo: e.lineNo,
      name,
      action: "create",
      detail: `${service.name} for ${company.name}, from ${startedOn}${fee === null ? "" : `, ${currency ?? ""} ${fee} ${billingFrequency ?? ""}`}`,
    });
  }

  // ONE LETTER PER CLIENT (0345, Shrestha 2026-10-04), its lines in their own
  // currencies, as a letter has been able to hold since 0344. The main
  // currency is the firm's own when any line is in it, else the one most lines
  // are in (ties by code); every other currency is rated when the letter is
  // written, from the exchange-rate feed on the letter's start day.
  const letters: LetterPlan[] = [];
  const groups = new Map<string, PlannedLine[]>();
  for (const p of planned) {
    const k = p.billTo.key;
    const list = groups.get(k);
    if (list) list.push(p);
    else groups.set(k, [p]);
  }
  for (const list of groups.values()) {
    const first = list[0];
    if (!first) continue;
    const letterJurisdiction =
      first.billTo.jurisdiction ?? list.map((l) => l.entityJurisdiction).find((j) => j !== null) ?? null;
    if (letterJurisdiction === null) {
      for (const l of list) {
        block("engagements", l.line.engagementLineNo, `${l.line.entityName}: ${l.line.serviceCode}`, `no country to write the letter for "${first.billTo.name}" under. Give the client a Country`);
      }
      continue;
    }
    if (!snap.clauseJurisdictions.has(letterJurisdiction)) {
      for (const l of list) {
        block(
          "engagements",
          l.line.engagementLineNo,
          `${l.line.entityName}: ${l.line.serviceCode}`,
          `no clause in the firm's library applies to ${letterJurisdiction}, so a letter for "${first.billTo.name}" cannot be signed. Publish one under the firm's clauses first`,
        );
      }
      continue;
    }
    const effectiveFrom = list.map((l) => l.line.startedOn).sort()[0] ?? snap.today;
    letters.push({
      clientName: first.billTo.name,
      clientLineNo: first.billTo.lineNo,
      clientPartyId: first.billTo.partyId,
      jurisdiction: letterJurisdiction,
      currency: mainCurrency(list.map((l) => l.currency), snap.firmCurrency),
      effectiveFrom,
      signatory: first.billTo.signatory ?? MIGRATED_SIGNATORY,
      lines: list.map((l) => l.line),
    });
  }
  // A line whose letter was refused is blocked, not created — restate the
  // verdicts and counts so the two agree.
  const refusedLines = new Set(
    findings
      .filter((f) => f.sheet === "engagements" && f.severity === "blocking" && f.lineNo !== null)
      .map((f) => f.lineNo),
  );
  const finalVerdicts = verdicts.map((v) =>
    v.sheet === "engagements" && v.action === "create" && refusedLines.has(v.lineNo)
      ? { ...v, action: "blocked" as const, detail: null }
      : v,
  );
  const createdLines = letters.reduce((n, l) => n + l.lines.length, 0);
  engagementsBlocked += engagementsToCreate - createdLines;
  engagementsToCreate = createdLines;

  if (snap.complianceFloor === null && beforeReachBack > 0) {
    warn(
      "file",
      null,
      "Compliance calendar",
      `${String(beforeReachBack)} engagement${beforeReachBack === 1 ? "" : "s"} started before ${reachBackFrom}, and the calendar looks back ninety days. Until the date deadlines are tracked from is set, every filing already made in the firm's old records will show as missed. Set "ask about deadlines from" on the compliance policy first.`,
    );
  }

  const blocking = findings.filter((f) => f.severity === "blocking").length;
  const warnings = findings.length - blocking;
  const count = (sheet: Sheet, action: RowAction): number =>
    finalVerdicts.filter((v) => v.sheet === sheet && v.action === action).length;

  return {
    findings,
    blocking,
    warnings,
    rows: finalVerdicts,
    letters,
    portalInvites,
    peoplePhones,
    counts: {
      clientsToCreate: count("clients", "create"),
      clientsOnFile: count("clients", "skip"),
      clientsBlocked: count("clients", "blocked"),
      entitiesToRegister: entities,
      peopleToCreate,
      rolesToRecord,
      peopleOnFile,
      peopleBlocked,
      engagementsToCreate,
      engagementsOnFile,
      engagementsBlocked,
      lettersToDraft: letters.length,
      assignmentsToRecord: assignments,
      portalInvitesToSend: portalInvites.length,
    },
    compliance: {
      floor: snap.complianceFloor,
      reachBackFrom,
      engagementsBeforeReachBack: beforeReachBack,
    },
  };
}
