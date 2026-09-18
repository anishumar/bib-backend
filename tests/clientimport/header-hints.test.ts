// The hint IN the header cell (2026-09-18).
//
// Nobody reads a guide. The sheets this product hands out therefore carry the
// format, the vocabulary and the one cross-sheet rule in the header cell
// itself — `Started On (YYYY-MM-DD)`, `Company (exactly the Client Name from
// 1-clients)` — and the reader has to treat that header as the same column as
// a plain `Started On`, because a person may keep the hint, shorten it, or
// delete it, and all three sheets must load.
import { describe, expect, it } from "vitest";
import {
  CLIENT_COLUMNS,
  CLIENT_SHEET_MARKER,
  ENGAGEMENT_COLUMNS,
  IDENTIFIER_COLUMNS,
  PEOPLE_COLUMNS,
  SPOC_COLUMN_TEMPLATE,
  headerKey,
  headerWithHint,
  rowsOf,
  spocPairHeaders,
} from "../../src/domain/clientimport/model";

const ALL = [...CLIENT_COLUMNS, ...PEOPLE_COLUMNS, ...ENGAGEMENT_COLUMNS];

describe("a header with its hint in brackets", () => {
  it("is the same column as the plain header, kept, shortened or deleted", () => {
    const plain = ["Client Name", "Country", "Entity Type", "SPOC 1 Dept", "SPOC 1 Email"];
    const hinted = [
      headerWithHint("Client Name", "registered name, spelled the same on all 3 sheets"),
      "Country (2 letters: IN, AE, SG, GB, US)",
      "Entity Type (private_l", // somebody cut the hint short in Excel
      "SPOC 1 Dept (your Dept code: TRC, FRC, RAA)",
      "SPOC 1 Email (that colleague's login email)",
    ];
    const values = ["Eternz Fashion Private Limited", "IN", "private_limited", "FRC", "rohan@10xglobal.test"];
    const [a] = rowsOf([plain, values], CLIENT_SHEET_MARKER) ?? [];
    const [b] = rowsOf([hinted, values], CLIENT_SHEET_MARKER) ?? [];
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    for (const h of plain) expect(b?.cell(h)).toBe(a?.cell(h));
    // The SPOC scan reads `row.headers`, so those come back WITHOUT the hint.
    expect(b?.headers).toEqual(plain);
  });

  it("finds the header row by its marker even when the marker carries a hint", () => {
    const grid = [
      ["Some title somebody typed above the table"],
      ["Client Name (registered name)", "Country (2 letters)"],
      ["Kaveri Foods Private Limited", "IN"],
    ];
    const rows = rowsOf(grid, CLIENT_SHEET_MARKER);
    expect(rows?.[0]?.cell("Client Name")).toBe("Kaveri Foods Private Limited");
    expect(rows?.[0]?.lineNo).toBe(3);
  });

  it("never touches a VALUE — a client called Kaveri (India) keeps its brackets", () => {
    const rows = rowsOf([["Client Name (registered name)"], ["Kaveri (India) Private Limited"]], CLIENT_SHEET_MARKER);
    expect(rows?.[0]?.cell("Client Name")).toBe("Kaveri (India) Private Limited");
  });

  it("round-trips: what a sheet prints, the reader keys back to the header", () => {
    for (const c of ALL) {
      expect(headerKey(headerWithHint(c.header, c.hint))).toBe(headerKey(c.header));
    }
    for (const [dept, email] of [spocPairHeaders(1), spocPairHeaders(12)]) {
      expect(headerKey(`${dept} (your Dept code: FRC)`)).toBe(headerKey(dept));
      expect(headerKey(`${email} (that colleague's login email)`)).toBe(headerKey(email));
    }
  });
});

describe("every column's hint", () => {
  it("is short, and carries no bracket of its own — a bracket would cut the header in the wrong place", () => {
    for (const c of [...ALL, ...IDENTIFIER_COLUMNS]) {
      expect(c.hint, c.header).not.toMatch(/[()]/);
      expect(c.hint.length, c.header).toBeLessThanOrEqual(72);
    }
  });

  it("is present on every REQUIRED column — those are the cells that stop a load", () => {
    for (const c of ALL.filter((x) => x.required && x.header !== SPOC_COLUMN_TEMPLATE)) {
      expect(c.hint, c.header).not.toBe("");
    }
  });

  it("puts the cross-sheet rule on the two columns that point back at the client sheet", () => {
    const client = PEOPLE_COLUMNS.find((c) => c.header === "Client");
    const company = ENGAGEMENT_COLUMNS.find((c) => c.header === "Company");
    expect(client?.hint).toMatch(/Client Name from 1-clients/);
    expect(company?.hint).toMatch(/Client Name from 1-clients/);
  });

  it("says the date format on every date column", () => {
    for (const h of ["Client Since", "Incorporated On", "Since", "Started On"]) {
      const c = ALL.find((x) => x.header === h);
      expect(c?.hint, h).toMatch(/YYYY-MM-DD/);
    }
    expect(ALL.find((x) => x.header === "Financial Year End")?.hint).toMatch(/MM-DD/);
  });
});
