import { deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { SheetUnreadable } from "../../src/domain/clientimport/errors";
import { CLIENT_SHEET_MARKER, clientRowsOf, rowsOf } from "../../src/domain/clientimport/model";
import {
  excelSerialToDay,
  isDateFormatCode,
  NodeSheetReader,
  parseCsv,
} from "../../src/infrastructure/sheet/grid-reader";

/** One part of the zip an `.xlsx` is. */
type Part = readonly [string, string];

/**
 * A zip of XML parts.
 *
 * `central` writes the central directory a real `.xlsx` ends with, and
 * `descriptor` writes each part's sizes in a trailing data descriptor instead of
 * in its local header — which is how a workbook streamed out of a web app
 * arrives, and which only the central directory can then size.
 */
function zipOf(
  parts: readonly Part[],
  opts: { readonly central?: boolean; readonly descriptor?: boolean } = {},
): Uint8Array {
  const streamed = opts.descriptor === true;
  const chunks: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, xml] of parts) {
    const raw = Buffer.from(xml, "utf8");
    const data = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(streamed ? 0x08 : 0, 6);
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt32LE(0, 10);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(streamed ? 0 : data.length, 18);
    header.writeUInt32LE(streamed ? 0 : raw.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    chunks.push(header, nameBuf, data);
    let written = header.length + nameBuf.length + data.length;
    if (streamed) {
      const trailer = Buffer.alloc(16);
      trailer.writeUInt32LE(0x08074b50, 0);
      trailer.writeUInt32LE(0, 4);
      trailer.writeUInt32LE(data.length, 8);
      trailer.writeUInt32LE(raw.length, 12);
      chunks.push(trailer);
      written += trailer.length;
    }
    if (opts.central === true) {
      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE(20, 4);
      entry.writeUInt16LE(20, 6);
      entry.writeUInt16LE(streamed ? 0x08 : 0, 8);
      entry.writeUInt16LE(8, 10);
      entry.writeUInt32LE(0, 16);
      entry.writeUInt32LE(data.length, 20);
      entry.writeUInt32LE(raw.length, 24);
      entry.writeUInt16LE(nameBuf.length, 28);
      entry.writeUInt32LE(offset, 42);
      directory.push(entry, nameBuf);
    }
    offset += written;
  }
  if (opts.central === true) {
    const cd = Buffer.concat(directory);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(parts.length, 8);
    end.writeUInt16LE(parts.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    chunks.push(cd, end);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** A workbook whose worksheet XML is written out cell by cell, as Excel writes it. */
function rawBook(sheetData: string, parts: readonly Part[] = []): Uint8Array {
  return zipOf([
    ["xl/worksheets/sheet1.xml", `<worksheet><sheetData>${sheetData}</sheetData></worksheet>`],
    ...parts,
  ]);
}

/** `<sst>` holding these strings, in order. */
function sst(...strings: readonly string[]): Part {
  return ["xl/sharedStrings.xml", `<sst>${strings.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`];
}

/**
 * A minimal .xlsx: a zip holding `xl/sharedStrings.xml` and one worksheet,
 * written the way Excel writes them — local file headers, raw deflate — and
 * nothing else. Enough to prove the reader takes a real workbook apart.
 */
function xlsx(
  shared: readonly string[],
  rows: readonly (readonly (string | number | RawCell)[])[],
  extra: readonly [string, string][] = [],
): Uint8Array {
  const col = (i: number): string => String.fromCharCode(65 + i);
  const sharedXml =
    `<?xml version="1.0" encoding="UTF-8"?><sst><si><t>${shared.map((s) => s.replace(/&/g, "&amp;")).join("</t></si><si><t>")}</t></si></sst>`;
  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData>` +
    rows
      .map(
        (r, ri) =>
          `<row r="${String(ri + 1)}">` +
          r
            .map((v, ci) =>
              typeof v === "number"
                ? `<c r="${col(ci)}${String(ri + 1)}"><v>${String(v)}</v></c>`
                : typeof v === "object"
                  ? `<c r="${col(ci)}${String(ri + 1)}"${v.s === undefined ? "" : ` s="${String(v.s)}"`}${v.t === undefined ? "" : ` t="${v.t}"`}><v>${v.v}</v></c>`
                  : `<c r="${col(ci)}${String(ri + 1)}" t="s"><v>${String(shared.indexOf(v))}</v></c>`,
            )
            .join("") +
          `</row>`,
      )
      .join("") +
    `</sheetData></worksheet>`;

  return zipOf([["xl/sharedStrings.xml", sharedXml], ["xl/worksheets/sheet1.xml", sheetXml], ...extra]);
}

/** A cell written with its own style index and type, as Excel writes a date or a TRUE. */
interface RawCell {
  readonly v: string;
  readonly s?: number;
  readonly t?: string;
}

/**
 * The styles part of the QA sheet that found this (2026-09-30), cut down: style
 * 0 is General, 1 a built-in date (14), 2 the custom `[$-14009]yyyy/mm/dd;@`
 * Incorporated On carried, 3 the custom `mm/dd` Financial Year End carried, 4
 * a time of day (21), 5 a custom money format with a bracketed locale.
 */
const STYLES: [string, string] = [
  "xl/styles.xml",
  `<?xml version="1.0" encoding="UTF-8"?><styleSheet><numFmts count="3">` +
    `<numFmt numFmtId="164" formatCode="[$-14009]yyyy/mm/dd;@"/>` +
    `<numFmt numFmtId="165" formatCode="mm/dd"/>` +
    `<numFmt numFmtId="166" formatCode="[$&#8377;-4009]\\ #,##0.00"/>` +
    `</numFmts><cellXfs count="6">` +
    `<xf numFmtId="0" fontId="0"/><xf numFmtId="14" fontId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="164" fontId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="21" fontId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" applyNumberFormat="1"/>` +
    `</cellXfs></styleSheet>`,
];

const reader = new NodeSheetReader();
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("reading a CSV", () => {
  it("keeps a comma inside a quoted address in one field", () => {
    expect(parseCsv('Client Name,Registered Address\nAlpha,"12, MG Road, Bengaluru"')).toEqual([
      ["Client Name", "Registered Address"],
      ["Alpha", "12, MG Road, Bengaluru"],
    ]);
  });

  it("reads a doubled quote as one quote, and a newline inside quotes as part of the field", () => {
    expect(parseCsv('Name\n"A ""S"" D"\n"line one\nline two"')).toEqual([["Name"], ['A "S" D'], ["line one\nline two"]]);
  });

  it("drops the byte-order mark Excel writes, Windows line endings, and trailing blank rows", () => {
    expect(parseCsv("﻿Client Name,Country\r\nAlpha,IN\r\n\r\n,\r\n")).toEqual([
      ["Client Name", "Country"],
      ["Alpha", "IN"],
    ]);
  });

  it("is what a .csv upload becomes", () => {
    expect(reader.grid(bytes("Client Name,Country\nAlpha,IN"), "clients.csv")).toEqual([
      ["Client Name", "Country"],
      ["Alpha", "IN"],
    ]);
  });

  it("keeps a blank line in the middle, so every row after it keeps the number the file gives it", () => {
    const rows = parseCsv("Client Name,Country\nAlpha,IN\n\nBeta,AE");
    expect(rows).toHaveLength(4);
    expect(rows[3]).toEqual(["Beta", "AE"]);
    // Which is the whole point: Beta is on line 4 of the file, and a finding
    // against it has to say 4.
    const sheet = rowsOf(rows, CLIENT_SHEET_MARKER) ?? [];
    expect(sheet.map((r) => r.lineNo)).toEqual([2, 4]);
  });

  it("reads a sheet saved with semicolons, as Excel writes it where that is the list separator", () => {
    expect(parseCsv('Client Name;Registered Address\nAlpha;"12, MG Road"')).toEqual([
      ["Client Name", "Registered Address"],
      ["Alpha", "12, MG Road"],
    ]);
  });

  it("reads a tab-separated sheet, which is what Excel's Text (Tab delimited) writes", () => {
    expect(reader.grid(bytes("Client Name\tCountry\nAlpha\tIN"), "clients.txt")).toEqual([
      ["Client Name", "Country"],
      ["Alpha", "IN"],
    ]);
  });

  it("takes the delimiter from the header line, not from a cell under it", () => {
    // Comma-separated, and the first address holds two semicolons: counting the
    // whole file would read the sheet as one column.
    expect(parseCsv('Client Name,Registered Address\nAlpha,"A; B; C"')).toEqual([
      ["Client Name", "Registered Address"],
      ["Alpha", "A; B; C"],
    ]);
  });

  it("reads a CSV saved as UTF-16, which is what Excel's Unicode Text writes", () => {
    const text = "Client Name,Country\nAlpha,IN";
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]);
    const expected = [
      ["Client Name", "Country"],
      ["Alpha", "IN"],
    ];
    expect(reader.grid(new Uint8Array(le), "clients.csv")).toEqual(expected);
    expect(reader.grid(new Uint8Array(be), "clients.csv")).toEqual(expected);
  });

  it("reads a Windows line ending inside a quoted address as one newline, with no stray carriage return", () => {
    expect(parseCsv('Name,Address\r\nAlpha,"12 MG Road\r\nBengaluru"\r\n')).toEqual([
      ["Name", "Address"],
      ["Alpha", "12 MG Road\nBengaluru"],
    ]);
  });
});

describe("reading a workbook", () => {
  it("takes the first worksheet apart into a grid, resolving shared strings", () => {
    const book = xlsx(
      ["Client Name", "Country", "A S D & Associates", "IN"],
      [
        ["Client Name", "Country"],
        ["A S D & Associates", "IN"],
        [2024, "IN"],
      ],
    );
    expect(reader.grid(book, "clients.xlsx")).toEqual([
      ["Client Name", "Country"],
      ["A S D & Associates", "IN"],
      ["2024", "IN"],
    ]);
  });

  it("reads a number Excel formats as a date as the day it shows, and every other number as the number", () => {
    const book = xlsx(
      ["Incorporated On", "Financial Year End", "Fee", "At"],
      [
        ["Incorporated On", "Financial Year End", "Fee", "At"],
        // The QA sheet's own cells: 43781 shown as 2019/11/12, 47938 as 03/31.
        [{ v: "43781", s: 2 }, { v: "47938", s: 3 }, { v: "50000", s: 5 }, { v: "0.5", s: 4 }],
        [{ v: "44147", s: 1 }, { v: "41274", s: 3 }, { v: "43781", s: 0 }, { v: "43781.75", s: 1 }],
      ],
      [STYLES],
    );
    expect(reader.grid(book, "clients.xlsx")).toEqual([
      ["Incorporated On", "Financial Year End", "Fee", "At"],
      ["2019-11-12", "2031-03-31", "50000", "0.5"],
      ["2020-11-12", "2012-12-31", "43781", "2019-11-12"],
    ]);
  });

  it("counts from 1904 when the workbook says so, and refuses the fictional 29 February 1900", () => {
    const book = xlsx(
      ["D"],
      [["D"], [{ v: "42322", s: 1 }], [{ v: "60", s: 1 }]],
      [STYLES, ["xl/workbook.xml", `<workbook><workbookPr date1904="1"/></workbook>`]],
    );
    expect(reader.grid(book, "clients.xlsx")).toEqual([["D"], ["2019-11-15"], ["1904-03-01"]]);
    expect(excelSerialToDay(60, false)).toBeNull();
    expect(excelSerialToDay(59, false)).toBe("1900-02-28");
    expect(excelSerialToDay(61, false)).toBe("1900-03-01");
    expect(excelSerialToDay(1, false)).toBe("1900-01-01");
    expect(excelSerialToDay(0, false)).toBeNull();
  });

  it("reads a TRUE Excel stored as a boolean as the word Portal Invite wants", () => {
    const book = xlsx(["Portal Invite"], [["Portal Invite"], [{ v: "1", t: "b" }], [{ v: "0", t: "b" }]]);
    expect(reader.grid(book, "clients.xlsx")).toEqual([["Portal Invite"], ["TRUE"], ["FALSE"]]);
  });

  it("tells a date format from a number format by its day and year tokens, not its brackets or literals", () => {
    expect(isDateFormatCode("[$-14009]yyyy/mm/dd;@")).toBe(true);
    expect(isDateFormatCode("mm/dd")).toBe(true);
    expect(isDateFormatCode("d-mmm-yy")).toBe(true);
    expect(isDateFormatCode("[$₹-4009]\\ #,##0.00")).toBe(false);
    expect(isDateFormatCode('0.00" days"')).toBe(false);
    expect(isDateFormatCode("h:mm:ss")).toBe(false);
    expect(isDateFormatCode("[h]:mm")).toBe(false);
  });

  it("recognises a workbook by its signature even with the wrong extension", () => {
    const book = xlsx(["X"], [["X"]]);
    expect(reader.grid(book, "clients")).toEqual([["X"]]);
  });

  it("refuses what it cannot read, naming the file and what to do", () => {
    expect(() => reader.grid(bytes("hello"), "clients.pdf")).toThrow(SheetUnreadable);
    expect(() => reader.grid(bytes("hello"), "clients.xls")).toThrow(/save it as \.xlsx or \.csv/);
    expect(() => reader.grid(new Uint8Array([0x50, 0x4b, 3, 4]), "clients.xlsx")).toThrow(/no worksheet/);
  });

  it("keeps the cell after an empty one — a blank formatted cell is not the start of the next cell", () => {
    // Excel writes a cell somebody formatted and left empty as `<c r="C1" s="2"/>`.
    // Read as the START of a cell, it swallowed everything up to the next `</c>`
    // and took that cell's value for its own: on QA the Country went missing and
    // its shared-string INDEX turned up in Client Since (2026-10-01).
    const book = rawBook(
      `<row r="1">` +
        `<c r="A1" t="s"><v>0</v></c><c r="B1" s="2"/><c r="C1" s="2"/>` +
        `<c r="D1" t="s"><v>1</v></c><c r="E1" s="2"/><c r="F1" t="s"><v>2</v></c>` +
        `</row>`,
      [sst("Alpha", "IN", "skohli@10x.global")],
    );
    expect(reader.grid(book, "clients.xlsx")).toEqual([["Alpha", "", "", "IN", "", "skohli@10x.global"]]);
  });

  it("numbers every row as Excel does, through a row it wrote empty and a row it left out", () => {
    const book = rawBook(
      `<row r="1"><c r="A1" t="s"><v>0</v></c></row>` +
        `<row r="2" spans="1:3"/>` +
        `<row r="4"><c r="A4" t="s"><v>1</v></c></row>`,
      [sst("Client Name", "Alpha")],
    );
    const grid = reader.grid(book, "clients.xlsx");
    expect(grid).toHaveLength(4);
    expect(grid[0]).toEqual(["Client Name"]);
    expect(grid[3]).toEqual(["Alpha"]);
    const sheet = rowsOf(grid, CLIENT_SHEET_MARKER) ?? [];
    expect(sheet.map((r) => r.lineNo)).toEqual([4]);
  });

  it("resolves the shared strings after an empty one, which does not shift them", () => {
    const book = rawBook(
      `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c></row>`,
      [["xl/sharedStrings.xml", `<sst><si><t>Client Name</t></si><si/><si><t>Country</t></si></sst>`]],
    );
    expect(reader.grid(book, "clients.xlsx")).toEqual([["Client Name", "Country"]]);
  });

  it("reads the workbook's first tab, which is not always the lowest-numbered sheet file", () => {
    // Reorder or delete a tab in Excel and the file names stop matching the
    // tabs; the sheet somebody filled in is the first TAB.
    const book = zipOf([
      [
        "xl/workbook.xml",
        `<workbook><sheets><sheet name="clients" sheetId="2" r:id="rId1"/>` +
          `<sheet name="Instructions" sheetId="1" r:id="rId2"/></sheets></workbook>`,
      ],
      [
        "xl/_rels/workbook.xml.rels",
        `<Relationships><Relationship Target="worksheets/sheet2.xml" Id="rId1"/>` +
          `<Relationship Id="rId2" Target="worksheets/sheet1.xml"/></Relationships>`,
      ],
      sst("Fill the next tab in", "Client Name"),
      [
        "xl/worksheets/sheet1.xml",
        `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`,
      ],
      [
        "xl/worksheets/sheet2.xml",
        `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>1</v></c></row></sheetData></worksheet>`,
      ],
    ]);
    expect(reader.grid(book, "clients.xlsx")).toEqual([["Client Name"]]);
  });

  it("reads a workbook whose local headers carry no sizes, as one streamed out of a web app", () => {
    const book = zipOf(
      [
        sst("Client Name", "Alpha"),
        [
          "xl/worksheets/sheet1.xml",
          `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row>` +
            `<row r="2"><c r="A2" t="s"><v>1</v></c></row></sheetData></worksheet>`,
        ],
      ],
      { central: true, descriptor: true },
    );
    expect(reader.grid(book, "clients.xlsx")).toEqual([["Client Name"], ["Alpha"]]);
  });

  it("reads the QA sheet's own shape: a blank formatted cell before the Country and the Key Manager", () => {
    // Row 2 of `clients-corrected (1).xlsx`, cut to the columns that broke: E
    // and P were formatted and left empty, and G (Country) and V (Key Manager)
    // are what the reader lost.
    const header =
      `<row r="1">` +
      [
        "Client Name (registered name, spelled the same on all 3 sheets)",
        "Known As",
        "Industry",
        "Website",
        "Client Since (YYYY-MM-DD, when the relationship began)",
        "Group",
        "Country (2 letters: IN, AE, SG, GB, US)",
        "Entity Type",
        "Incorporated On",
        "Financial Year End (MM-DD, e.g. 03-31)",
        "Registered Address",
        "PAN",
        "GSTIN",
        "CIN",
        "LLPIN",
        "TAN",
        "UEN",
        "TRN",
        "EIN",
        "CRN",
        "VAT",
        "Key Manager (login email of the colleague who owns this client)",
      ]
        .map((h, i) => `<c r="${String.fromCharCode(65 + i)}1" t="inlineStr"><is><t>${h}</t></is></c>`)
        .join("") +
      `</row>`;
    const book = rawBook(
      `${header}<row r="2" spans="1:31"><c r="A2" t="s"><v>0</v></c><c r="E2" s="2"/>` +
        `<c r="G2" t="s"><v>1</v></c><c r="H2" t="s"><v>2</v></c><c r="I2" t="s"><v>3</v></c>` +
        `<c r="J2" s="3"><v>46112</v></c><c r="P2" s="2"/><c r="V2" t="s"><v>4</v></c></row>`,
      [sst("RT Trends", "IN", "private_limited", "2008-10-11", "skohli@10x.global"), STYLES],
    );
    const sheet = rowsOf(reader.grid(book, "clients.xlsx"), CLIENT_SHEET_MARKER) ?? [];
    const row = clientRowsOf(sheet)[0];
    expect(row?.lineNo).toBe(2);
    expect(row?.legalName).toBe("RT Trends");
    expect(row?.clientSince).toBeNull();
    expect(row?.jurisdiction).toBe("IN");
    expect(row?.entityType).toBe("private_limited");
    expect(row?.incorporatedOn).toBe("2008-10-11");
    expect(row?.financialYearEnd).toBe("03-31");
    expect(row?.identifiers).toEqual([]);
    expect(row?.keyManagerEmail).toBe("skohli@10x.global");
  });
});
