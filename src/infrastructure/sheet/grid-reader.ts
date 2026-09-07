// Reading a spreadsheet without a spreadsheet library.
//
// An `.xlsx` is a zip of XML. The two parts that matter are
// `xl/sharedStrings.xml`, which holds every distinct string in the workbook,
// and the first worksheet, whose cells reference those strings by index. That
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

/** Every cell of the first worksheet, as a rectangular grid of strings. */
function readWorkbook(buf: Buffer, filename: string): (readonly string[])[] {
  const entries = readZipEntries(buf);

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
      const type = /t="(\w+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = "";
      if (v !== undefined) {
        value = type === "s" ? (shared[Number(v)] ?? "") : unescapeXml(v);
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
