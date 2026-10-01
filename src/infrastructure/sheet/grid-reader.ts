// Reading a spreadsheet without a spreadsheet library.
//
// An `.xlsx` is a zip of XML. The parts that matter are
// `xl/sharedStrings.xml`, which holds every distinct string in the workbook,
// the first worksheet, whose cells reference those strings by index, and
// `xl/styles.xml`, the only place that says a number is a date. That
// is enough for a flat table and it costs no dependency — a parser here is
// smaller than the supply chain of a library that reads charts, formulas and
// pivot tables an onboarding sheet does not have.
//
// `.csv` is read too, and is the format the templates come down in: a CSV is
// easier to diff and to correct than a workbook. Both go through the same
// header mapping in the domain, so neither is a special case downstream.
//
// What a parser this small has to get right, each of these found on QA against
// a real firm's sheet rather than by reading the spec:
//
//   - An element written SELF-CLOSING is not the start of an element. Excel
//     writes a cell somebody formatted and left empty as `<c r="E2" s="2"/>`
//     and an empty row as `<row r="4"/>`, and a regex that read either as an
//     opening tag swallowed everything up to the next closing tag — the cell
//     after it, value and all. A sheet lost its Country and its Key Manager
//     that way and the import refused rows it should have loaded (2026-10-01).
//   - A row's number is the `r` on it, not its position among the rows that
//     happen to be written out. Every finding names a row, and a sheet with a
//     blank line in it was naming the wrong one.
//   - The sizes in a zip's local headers are optional. A workbook streamed out
//     of a web app leaves them zero and writes them in a trailing data
//     descriptor, so the central directory at the end is the record to trust.
//   - The first worksheet FILE is not the first tab. Reorder or delete a tab in
//     Excel and the names stop following the tabs.
//
// Lifted from the pre-rebuild demo's `scripts/sheet.ts`, which read the same
// firm's same sheets, and reshaped as a port so the use case never touches
// bytes.

import { inflateRawSync } from "node:zlib";

import { SheetUnreadable } from "../../domain/clientimport/errors";
import type { SheetReader } from "../../usecase/clientimport/ports";

export class NodeSheetReader implements SheetReader {
  grid(bytes: Uint8Array, filename: string): (readonly string[])[] {
    const lower = filename.toLowerCase();
    if (lower.endsWith(".csv") || lower.endsWith(".txt")) return parseCsv(decodeText(bytes));
    if (lower.endsWith(".xlsx")) return readWorkbook(Buffer.from(bytes), filename);
    // A browser occasionally sends a CSV with no extension at all; a zip
    // signature says workbook, anything else is tried as text.
    if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
      return readWorkbook(Buffer.from(bytes), filename);
    }
    if (lower.endsWith(".xls")) {
      throw new SheetUnreadable(filename, "an .xls is the 2003 binary format; save it as .xlsx or .csv");
    }
    throw new SheetUnreadable(filename, "the name ends in neither .csv nor .xlsx");
  }
}

function unescapeXml(s: string): string {
  return (
    s
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      // Last, so an escaped ampersand in "A S D &amp; Associates" does not
      // re-expand whatever follows it.
      .replace(/&amp;/g, "&")
  );
}

// ── XML ──────────────────────────────────────────────────────────────────────

interface XmlElement {
  readonly attrs: string;
  /** Empty for a self-closing element — which is the whole point. */
  readonly body: string;
}

/**
 * Every `<name …>…</name>` and `<name …/>` in this XML, in order.
 *
 * The self-closing form is the one worth the function: matched as an opening
 * tag and paired with the next `</name>`, it takes the following element's
 * contents for its own, and a blank cell comes out holding its neighbour's
 * value while the neighbour vanishes.
 */
function elements(xml: string, name: string): readonly XmlElement[] {
  const out: XmlElement[] = [];
  const open = new RegExp(`<${name}\\b([^>]*?)(/?)>`, "g");
  const closing = `</${name}>`;
  for (;;) {
    const m = open.exec(xml);
    if (m === null) return out;
    const attrs = m[1] ?? "";
    if (m[2] === "/") {
      out.push({ attrs, body: "" });
      continue;
    }
    const close = xml.indexOf(closing, open.lastIndex);
    out.push({ attrs, body: xml.slice(open.lastIndex, close < 0 ? xml.length : close) });
    open.lastIndex = close < 0 ? xml.length : close + closing.length;
  }
}

function attr(attrs: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
}

// ── Zip ──────────────────────────────────────────────────────────────────────

/**
 * The parts of a zip, by name.
 *
 * The central directory at the END is the record with reliable sizes: a local
 * header may carry zeroes and leave the real sizes to a trailing data
 * descriptor, which is how a workbook streamed out of a web app arrives.
 * Walking the local headers is the fallback for a zip with no directory.
 */
function readZipEntries(buf: Buffer): ReadonlyMap<string, Buffer> {
  const fromDirectory = readCentralDirectory(buf);
  return fromDirectory !== null && fromDirectory.size > 0 ? fromDirectory : scanLocalHeaders(buf);
}

/** One entry's bytes, inflated, from the local header at `offset`. */
function entryAt(buf: Buffer, offset: number, method: number, size: number): Buffer | null {
  if (offset < 0 || offset + 30 > buf.length) return null;
  if (buf.readUInt32LE(offset) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(offset + 26);
  const extraLen = buf.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLen + extraLen;
  if (start + size > buf.length) return null;
  const data = buf.subarray(start, start + size);
  try {
    // 0 = stored, 8 = raw deflate. Excel writes 8 for everything here.
    return method === 0 ? Buffer.from(data) : inflateRawSync(data);
  } catch {
    return null;
  }
}

function readCentralDirectory(buf: Buffer): Map<string, Buffer> | null {
  // The end-of-central-directory record is last, before an optional comment of
  // at most 64K.
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 65_535);
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  const out = new Map<string, Buffer>();
  let at = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) break;
    const method = buf.readUInt16LE(at + 10);
    const compressedSize = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const data = entryAt(buf, offset, method, compressedSize);
    if (data !== null) out.set(name, data);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Walks local file headers for a zip whose directory is missing or unreadable. */
function scanLocalHeaders(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let i = 0;
  while (i < buf.length - 4) {
    if (buf.readUInt32LE(i) !== 0x04034b50) {
      i += 1;
      continue;
    }
    const method = buf.readUInt16LE(i + 8);
    const compressedSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString("utf8");
    const dataStart = i + 30 + nameLen + extraLen;
    if (compressedSize > 0) {
      const data = entryAt(buf, i, method, compressedSize);
      if (data !== null) out.set(name, data);
      i = dataStart + compressedSize;
    } else {
      // The size is in the trailing descriptor; only the directory has it.
      i = dataStart;
    }
  }
  return out;
}

function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ── Dates ────────────────────────────────────────────────────────────────────
//
// Excel stores a date as a NUMBER — days since its epoch — and only the cell's
// number format says it is a date. So a sheet whose Incorporated On reads
// "2019/11/12" on screen hands a reader that ignores styles "43781", and the
// import refused every date a firm had typed into Excel rather than into a
// text cell (found on QA, 2026-09-30). The format is in `xl/styles.xml`: a
// cell's `s` indexes `cellXfs`, whose `numFmtId` is either built in or defined
// in `numFmts`. A date-formatted number comes out as `YYYY-MM-DD`, the form
// every date column already accepts; the domain decides what else a column
// wants from it (Financial Year End keeps the month and day).

/** Built-in number formats that show a DATE (14–17, 22) or a locale's date
 *  (27–36, 50–58). 18–21 and 45–47 are times of day and stay numbers. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** A custom format is a date when a day or year token survives removing its
 *  literal text, escapes, fill and padding characters and bracketed sections
 *  (locale, colour, elapsed time). `m` alone is left out: it is also minutes. */
export function isDateFormatCode(code: string): boolean {
  const bare = code
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/[_*]./g, "")
    .replace(/\[[^\]]*\]/g, "");
  return /[dy]/i.test(bare);
}

/** Which style indexes (`s` on a cell) format a number as a date. */
function dateStyles(stylesXml: string | undefined): ReadonlySet<number> {
  const out = new Set<number>();
  if (stylesXml === undefined) return out;
  const custom = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*?numFmtId="(\d+)"[^>]*?formatCode="([^"]*)"/g)) {
    custom.set(Number(m[1]), unescapeXml(m[2] ?? ""));
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? "";
  [...xfs.matchAll(/<xf\b([^>]*)/g)].forEach((m, index) => {
    const id = Number(/numFmtId="(\d+)"/.exec(m[1] ?? "")?.[1] ?? "0");
    const code = custom.get(id);
    if (code !== undefined ? isDateFormatCode(code) : BUILTIN_DATE_FORMATS.has(id)) out.add(index);
  });
  return out;
}

/**
 * An Excel serial day as `YYYY-MM-DD`, or null when it names no day.
 *
 * The 1900 system counts 1900-01-01 as 1 and carries Lotus 1-2-3's fictional
 * 29 February 1900 as 60, so from 61 on the epoch is 1899-12-30 and below it
 * 1899-12-31; serial 60 is a day that never existed and is refused. The 1904
 * system (old Mac workbooks) counts from 1904-01-01 as 0. A time of day is
 * the fraction and is dropped: these columns hold days.
 */
export function excelSerialToDay(serial: number, date1904: boolean): string | null {
  if (!Number.isFinite(serial) || serial < 0) return null;
  const whole = Math.floor(serial);
  let epoch: number;
  if (date1904) {
    epoch = Date.UTC(1904, 0, 1);
  } else {
    if (whole < 1 || whole === 60) return null;
    epoch = whole > 60 ? Date.UTC(1899, 11, 30) : Date.UTC(1899, 11, 31);
  }
  const day = new Date(epoch + whole * 86_400_000);
  const year = day.getUTCFullYear();
  if (year > 9999) return null;
  return day.toISOString().slice(0, 10);
}

// ── Workbooks ────────────────────────────────────────────────────────────────

/** Shared by every row the sheet skipped: nothing writes to a grid row. */
const BLANK_ROW: readonly string[] = [];

/** The strings of `xl/sharedStrings.xml`, by the index a cell refers to. */
function sharedStrings(xml: string | undefined): readonly string[] {
  if (xml === undefined) return [];
  // An empty string is written `<si/>`, and skipping it shifts every string
  // after it onto the wrong cell.
  return elements(xml, "si").map((si) =>
    unescapeXml(
      elements(si.body, "t")
        .map((t) => t.body)
        .join(""),
    ),
  );
}

/** The path of the workbook's first TAB, else its lowest-numbered worksheet. */
function firstWorksheet(entries: ReadonlyMap<string, Buffer>): string | undefined {
  const workbook = entries.get("xl/workbook.xml")?.toString("utf8");
  const rels = entries.get("xl/_rels/workbook.xml.rels")?.toString("utf8");
  const id = workbook === undefined ? undefined : attr(elements(workbook, "sheet")[0]?.attrs ?? "", "r:id");
  if (id !== undefined && rels !== undefined) {
    for (const rel of elements(rels, "Relationship")) {
      if (attr(rel.attrs, "Id") !== id) continue;
      const target = attr(rel.attrs, "Target");
      if (target === undefined) continue;
      const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
      if (entries.has(path)) return path;
    }
  }
  return [...entries.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(/(\d+)/.exec(a)?.[1] ?? "0") - Number(/(\d+)/.exec(b)?.[1] ?? "0"))[0];
}

/** Every cell of the first worksheet, as a grid of strings numbered as Excel numbers its rows. */
function readWorkbook(buf: Buffer, filename: string): (readonly string[])[] {
  const entries = readZipEntries(buf);
  const dates = dateStyles(entries.get("xl/styles.xml")?.toString("utf8"));
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(
    entries.get("xl/workbook.xml")?.toString("utf8") ?? "",
  );
  const shared = sharedStrings(entries.get("xl/sharedStrings.xml")?.toString("utf8"));

  const sheetName = firstWorksheet(entries);
  if (sheetName === undefined) {
    throw new SheetUnreadable(filename, "the workbook has no worksheet in it");
  }
  const sheet = entries.get(sheetName)?.toString("utf8") ?? "";

  const byRowNumber = new Map<number, readonly string[]>();
  let lastWithContent = 0;
  let previous = 0;
  for (const row of elements(sheet, "row")) {
    // `r` is the row Excel shows. Without one, a row follows the row before it.
    const at = Number(attr(row.attrs, "r") ?? String(previous + 1));
    previous = at;
    const cells = new Map<number, string>();
    for (const cell of elements(row.body, "c")) {
      const ref = attr(cell.attrs, "r");
      if (ref === undefined) continue;
      cells.set(columnIndex(ref), cellValue(cell, shared, dates, date1904));
    }
    const width = Math.max(-1, ...cells.keys()) + 1;
    if (width <= 0) continue;
    const out = Array.from({ length: width }, (_, i) => cells.get(i) ?? "");
    byRowNumber.set(at, out);
    if (out.some((c) => c.trim() !== "")) lastWithContent = Math.max(lastWithContent, at);
  }

  const grid: (readonly string[])[] = [];
  for (let at = 1; at <= lastWithContent; at += 1) grid.push(byRowNumber.get(at) ?? BLANK_ROW);
  return grid;
}

function cellValue(
  cell: XmlElement,
  shared: readonly string[],
  dates: ReadonlySet<number>,
  date1904: boolean,
): string {
  const type = attr(cell.attrs, "t");
  const style = Number(attr(cell.attrs, "s") ?? "-1");
  const held = elements(cell.body, "v")[0]?.body;
  // `<v/>` holds nothing, and reading it as a shared-string index reads string 0.
  const v = held === undefined || held === "" ? undefined : held;
  if (v === undefined) {
    // An inline string: the text is in the cell rather than in the shared table.
    return unescapeXml(
      elements(cell.body, "t")
        .map((t) => t.body)
        .join(""),
    );
  }
  if (type === "s") return shared[Number(v)] ?? "";
  // A typed TRUE is a boolean cell stored as 1; Portal Invite wants the word.
  if (type === "b") return v.trim() === "1" ? "TRUE" : "FALSE";
  // Strict OOXML writes a date cell as ISO text already.
  if (type === "d") return /^\d{4}-\d{2}-\d{2}/.exec(v.trim())?.[0] ?? unescapeXml(v);
  if ((type === undefined || type === "n") && dates.has(style)) {
    return excelSerialToDay(Number(v), date1904) ?? unescapeXml(v);
  }
  return unescapeXml(v);
}

// ── CSVs ─────────────────────────────────────────────────────────────────────

/**
 * A sheet's bytes as text.
 *
 * Excel's "Unicode Text" and its UTF-16 CSV are UTF-16, and the byte-order mark
 * they open with is the only thing that says so — decoded as UTF-8 the header
 * row comes out interleaved with NULs and no column matches anything.
 */
function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    return new TextDecoder("utf-16le").decode(swapped.subarray(0, swapped.length & ~1).swap16());
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** The delimiters a sheet saved out of a spreadsheet can arrive with. */
const DELIMITERS = [",", ";", "\t"] as const;

/**
 * The delimiter of the HEADER line, by counting the candidates outside quotes.
 *
 * Excel writes the list separator of the machine it ran on, so a firm whose
 * Windows is set to a European locale sends semicolons and the whole sheet
 * arrives as one column — which the import can only report as "no header row".
 * Only the header line is counted: an address holding two semicolons would
 * otherwise outvote the commas separating the columns.
 */
function sniffDelimiter(src: string): string {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i] ?? "";
    if (quoted) {
      if (ch !== '"') continue;
      if (src[i + 1] === '"') i += 1;
      else quoted = false;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === "\n" || ch === "\r") break;
    const seen = counts.get(ch);
    if (seen !== undefined) counts.set(ch, seen + 1);
  }
  let best = ",";
  for (const d of DELIMITERS) {
    if ((counts.get(d) ?? 0) > (counts.get(best) ?? 0)) best = d;
  }
  return best;
}

/**
 * RFC-4180 enough: quoted fields, doubled quotes inside them, and newlines
 * within a quoted field. A client's registered address contains commas, and a
 * split on `,` would quietly shear it in half.
 *
 * A blank line in the MIDDLE is kept. Every finding names a row the way the
 * file numbers it, and dropping the blank line moved every row under it up one.
 */
export function parseCsv(text: string, delimiter?: string): (readonly string[])[] {
  // A UTF-8 byte-order mark, which Excel writes and which would otherwise
  // become the first character of the first header.
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  const sep = delimiter ?? sniffDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else if (ch === "\r") {
        // A line break typed into a cell: one newline, whatever the file's
        // line endings are, so no carriage return reaches the database.
        field += "\n";
        if (src[i + 1] === "\n") i += 1;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // A trailing newline leaves one empty row; a sheet exported from Excel often
  // leaves several.
  let end = rows.length;
  while (end > 0 && !(rows[end - 1] ?? []).some((c) => c.trim() !== "")) end -= 1;
  return rows.slice(0, end);
}
