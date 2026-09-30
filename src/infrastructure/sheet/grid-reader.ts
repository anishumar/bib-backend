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
// Lifted from the pre-rebuild demo's `scripts/sheet.ts`, which read the same
// firm's same sheets, and reshaped as a port so the use case never touches
// bytes.

import { inflateRawSync } from "node:zlib";

import { SheetUnreadable } from "../../domain/clientimport/errors";
import type { SheetReader } from "../../usecase/clientimport/ports";

export class NodeSheetReader implements SheetReader {
  grid(bytes: Uint8Array, filename: string): (readonly string[])[] {
    const lower = filename.toLowerCase();
    if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
      return parseCsv(new TextDecoder("utf-8").decode(bytes));
    }
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

/** Minimal zip reader — walks local file headers, then raw deflate. */
function readZipEntries(buf: Buffer): Map<string, Buffer> {
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
    const nameStart = i + 30;
    const name = buf.subarray(nameStart, nameStart + nameLen).toString("utf8");
    const dataStart = nameStart + nameLen + extraLen;

    if (compressedSize > 0) {
      const data = buf.subarray(dataStart, dataStart + compressedSize);
      try {
        // 0 = stored, 8 = raw deflate. Excel writes 8 for everything here.
        out.set(name, method === 0 ? Buffer.from(data) : inflateRawSync(data));
      } catch {
        // A streamed entry (size in the trailing descriptor) — skip it. The
        // parts this needs are never stored that way by Excel.
      }
      i = dataStart + compressedSize;
    } else {
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

/** Every cell of the first worksheet, as a rectangular grid of strings. */
function readWorkbook(buf: Buffer, filename: string): (readonly string[])[] {
  const entries = readZipEntries(buf);
  const dates = dateStyles(entries.get("xl/styles.xml")?.toString("utf8"));
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(
    entries.get("xl/workbook.xml")?.toString("utf8") ?? "",
  );

  const sharedXml = entries.get("xl/sharedStrings.xml");
  const shared: string[] = [];
  if (sharedXml) {
    const text = sharedXml.toString("utf8");
    for (const si of text.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
      const parts = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1] ?? "");
      shared.push(unescapeXml(parts.join("")));
    }
  }

  const sheetName = [...entries.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort()[0];
  if (sheetName === undefined) {
    throw new SheetUnreadable(filename, "the workbook has no worksheet in it");
  }
  const sheet = entries.get(sheetName)?.toString("utf8") ?? "";

  const grid: string[][] = [];
  for (const rowXml of sheet.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []) {
    const cells: Record<number, string> = {};
    for (const m of rowXml.matchAll(/<c ([^>]*?)\/?>(?:([\s\S]*?)<\/c>)?/g)) {
      const attrs = m[1] ?? "";
      const body = m[2] ?? "";
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
      if (ref === undefined) continue;
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      const style = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? "-1");
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = "";
      if (v !== undefined) {
        if (type === "s") {
          value = shared[Number(v)] ?? "";
        } else if (type === "b") {
          // A typed TRUE is a boolean cell stored as 1; Portal Invite wants the word.
          value = v.trim() === "1" ? "TRUE" : "FALSE";
        } else if (type === "d") {
          // Strict OOXML writes a date cell as ISO text already.
          value = /^\d{4}-\d{2}-\d{2}/.exec(v.trim())?.[0] ?? unescapeXml(v);
        } else if ((type === undefined || type === "n") && dates.has(style)) {
          value = excelSerialToDay(Number(v), date1904) ?? unescapeXml(v);
        } else {
          value = unescapeXml(v);
        }
      } else if (body !== "") {
        value = unescapeXml(
          [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1] ?? "").join(""),
        );
      }
      cells[columnIndex(ref)] = value;
    }
    const width = Math.max(-1, ...Object.keys(cells).map(Number)) + 1;
    if (width > 0) grid.push(Array.from({ length: width }, (_, i) => cells[i] ?? ""));
  }
  return grid;
}

/**
 * RFC-4180 enough: quoted fields, doubled quotes inside them, and newlines
 * within a quoted field. A client's registered address contains commas, and a
 * split on `,` would quietly shear it in half.
 */
export function parseCsv(text: string): (readonly string[])[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  // A UTF-8 byte-order mark, which Excel writes and which would otherwise
  // become the first character of the first header.
  const src = text.startsWith("﻿") ? text.slice(1) : text;

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
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
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
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}
