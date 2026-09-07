import { deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { SheetUnreadable } from "../../src/domain/clientimport/errors";
import { NodeSheetReader, parseCsv } from "../../src/infrastructure/sheet/grid-reader";

/**
 * A minimal .xlsx: a zip holding `xl/sharedStrings.xml` and one worksheet,
 * written the way Excel writes them — local file headers, raw deflate — and
 * nothing else. Enough to prove the reader takes a real workbook apart.
 */
function xlsx(shared: readonly string[], rows: readonly (readonly (string | number)[])[]): Uint8Array {
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
