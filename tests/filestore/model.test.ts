// The document store's pure rules, and the one thing they are written in two
// places (T3.6).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRAND_ASSET_KINDS,
  DOCUMENT_KINDS,
  DOCUMENT_ORIGINS,
  SUBJECT_KINDS,
  isContentHash,
  normaliseMediaType,
  safeFilename,
} from "../../src/domain/filestore/model";

const MIGRATION = "migrations/0037_document_store.up.sql";

/**
 * The CHECK constraint's members, read out of the migration.
 *
 * The same instinct as tests/ledger/contract-parity.test.ts and
 * tests/config/seed-parity.test.ts: SQL cannot import TypeScript, so the
 * duplication is unavoidable — the DRIFT is not. A kind added to the union and
 * not to the CHECK is a value the service will happily accept and the database
 * will reject at 3am; the reverse is a value the database allows that nothing
 * in the product can produce or read.
 */
function checkMembers(constraint: string): string[] {
  const sql = readFileSync(MIGRATION, "utf8");
  const at = sql.indexOf(constraint);
  if (at < 0) throw new Error(`${MIGRATION} no longer contains ${constraint}`);
  const open = sql.indexOf("(", sql.indexOf("CHECK", at));
  const close = sql.indexOf(")", open);
  return [...sql.slice(open, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string).sort();
}

describe("the closed sets agree with the database", () => {
  it("document kinds", () => {
    expect(checkMembers("kind        text NOT NULL CHECK")).toEqual([...DOCUMENT_KINDS].sort());
  });

  it("document origins", () => {
    expect(checkMembers("origin      text NOT NULL CHECK")).toEqual([...DOCUMENT_ORIGINS].sort());
  });

  it("subject kinds", () => {
    expect(checkMembers("subject_kind  text NOT NULL CHECK")).toEqual([...SUBJECT_KINDS].sort());
  });

  it("brand asset kinds", () => {
    expect(checkMembers("kind                text NOT NULL CHECK")).toEqual(
      [...BRAND_ASSET_KINDS].sort(),
    );
  });
});

describe("media types", () => {
  it("normalises case and drops transfer parameters", () => {
    // The parameter is a property of a TRANSFER, not of stored bytes. Keeping
    // it would make two uploads of the same file compare unequal on a field
    // nobody looks at.
    expect(normaliseMediaType("Application/PDF")).toBe("application/pdf");
    expect(normaliseMediaType("text/csv; charset=UTF-8")).toBe("text/csv");
  });

  it("refuses anything that could carry a header separator", () => {
    // This value is echoed into a Content-Type header on download. Refusing it
    // here is what makes that safe without escaping at the door.
    expect(normaliseMediaType("text/html\r\nX-Evil: 1")).toBeNull();
    expect(normaliseMediaType("not-a-media-type")).toBeNull();
    expect(normaliseMediaType("")).toBeNull();
    expect(normaliseMediaType("   ")).toBeNull();
  });
});

describe("filenames are labels, never paths", () => {
  it("keeps the basename of a Windows path rather than refusing it", () => {
    // A browser on Windows genuinely sends this for an ordinary upload.
    // Refusing it would reject a correct file.
    expect(safeFilename("C:\\Users\\anish\\Documents\\pan.pdf")).toBe("pan.pdf");
    expect(safeFilename("/tmp/scan_0043.pdf")).toBe("scan_0043.pdf");
  });

  it("strips traversal and control characters", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("re\u0000port.pdf")).toBe("report.pdf");
    // A quote would break out of the Content-Disposition filename.
    expect(safeFilename('in"voice.pdf')).toBe("invoice.pdf");
  });

  it("refuses what leaves nothing usable", () => {
    expect(safeFilename("")).toBeNull();
    expect(safeFilename("   ")).toBeNull();
    expect(safeFilename("..")).toBeNull();
    expect(safeFilename("/")).toBeNull();
  });

  it("caps the length", () => {
    expect(safeFilename(`${"a".repeat(400)}.pdf`)).toHaveLength(255);
  });
});

describe("content hashes", () => {
  it("accepts a lower-case hex sha-256 and nothing else", () => {
    expect(isContentHash("a".repeat(64))).toBe(true);
    // Upper case would compare unequal to an identical file's digest and look
    // like tampering, which is why the column has the same CHECK.
    expect(isContentHash("A".repeat(64))).toBe(false);
    expect(isContentHash("a".repeat(63))).toBe(false);
    expect(isContentHash("")).toBe(false);
  });
});
