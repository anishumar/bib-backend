import { deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { SheetUnreadable } from "../../src/domain/clientimport/errors";
import {
  excelSerialToDay,
  isDateFormatCode,
  NodeSheetReader,
  parseCsv,
} from "../../src/infrastructure/sheet/grid-reader";

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

  const entries: [string, Buffer][] = [
    ["xl/sharedStrings.xml", Buffer.from(sharedXml, "utf8")],
    ["xl/worksheets/sheet1.xml", Buffer.from(sheetXml, "utf8")],
    ...extra.map(([name, xml]): [string, Buffer] => [name, Buffer.from(xml, "utf8")]),
  ];
  const parts: Buffer[] = [];
  for (const [name, raw] of entries) {
    const data = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt32LE(0, 10);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    parts.push(header, nameBuf, data);
  }
  return new Uint8Array(Buffer.concat(parts));
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
});
