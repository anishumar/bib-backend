// The document store's pure rules, and the one thing they are written in two
// places (T3.6).
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRAND_ASSET_KINDS,
  DOCUMENT_KINDS,
  DOCUMENT_ORIGINS,
  SUBJECT_KINDS,
  contentDispositionFor,
  isContentHash,
  normaliseMediaType,
  safeFilename,
} from "../../src/domain/filestore/model";

/**
 * The CHECK constraint's members, read out of the NEWEST migration that states
 * it — not out of 0037.
 *
 * The same instinct as tests/ledger/contract-parity.test.ts and
 * tests/config/seed-parity.test.ts: SQL cannot import TypeScript, so the
 * duplication is unavoidable — the DRIFT is not. A kind added to the union and
 * not to the CHECK is a value the service will happily accept and the database
 * will reject at 3am; the reverse is a value the database allows that nothing in
 * the product can produce or read.
 *
 * ── AND "NEWEST" IS T6.6's CORRECTION, NOT A TIDY-UP ─────────────────────
 *
 * This was pinned to `0037_document_store.up.sql`, and 0063 widened
 * `subject_kind` by DROPPING that CHECK and adding a new one — which an applied
 * migration must do, because it cannot be edited. So the test went on reading
 * seven members out of a constraint the database no longer had, and would have
 * stayed green while the union and the live CHECK disagreed. Exactly the drift
 * it was written to catch, hidden by where it was looking.
 *
 * `seed-parity.test.ts` had already solved this and stated why: a test pinned to
 * the first migration makes the CORRECT fix look like a regression, and the
 * tempting way out of a red build is to edit an applied migration.
 */
function checkMembers(constraint: string): string[] {
  const carriers = readdirSync("migrations")
    .filter((f) => f.endsWith(".up.sql"))
    .filter((f) => readFileSync(`migrations/${f}`, "utf8").includes(constraint))
    .sort(); // NNNN_ prefixes are zero-padded, so lexicographic IS numeric

  const file = carriers.at(-1);
  if (file === undefined) {
    throw new Error(`no migration in migrations/ states ${constraint} any more`);
  }
  const sql = readFileSync(`migrations/${file}`, "utf8");
  const at = sql.lastIndexOf(constraint);
  // From the needle, never from the file: a migration that states one CHECK
  // usually states others, and searching from the top finds whichever came
  // first rather than the one asked for.
  const open = sql.indexOf("(", sql.indexOf("CHECK", at));
  const close = sql.indexOf(")", open);
  return [...sql.slice(open, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string).sort();
}

describe("the closed sets agree with the database", () => {
  it("document kinds", () => {
    expect(checkMembers("  kind        text NOT NULL CHECK")).toEqual(
      [...DOCUMENT_KINDS].sort(),
    );
  });

  it("document origins", () => {
    expect(checkMembers("  origin      text NOT NULL CHECK")).toEqual(
      [...DOCUMENT_ORIGINS].sort(),
    );
  });

  it("subject kinds", () => {
    // 0063 widened this one, so it is read out of THAT migration rather than
    // 0037's — see `checkMembers`. The needle is the CHECK's own predicate
    // because 0063 states it as an ALTER, where the column declaration the
    // other three anchor on does not appear.
    //
    // The other three needles carry their LEADING INDENTATION deliberately:
    // `kind        text NOT NULL CHECK` is a substring of 0063's
    // `ask_kind        text NOT NULL CHECK`, so without the two spaces in front
    // this test would compare the document kinds against the three kinds of ask
    // and be perfectly confident about it.
    expect(checkMembers("CHECK (subject_kind IN (")).toEqual([...SUBJECT_KINDS].sort());
  });

  it("brand asset kinds", () => {
    expect(checkMembers("  kind                text NOT NULL CHECK")).toEqual(
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

describe("contentDispositionFor", () => {
  // The header that answered 500. Both byte routes spliced the filename into
  // `attachment; filename="…"` with only the quote stripped — and an HTTP
  // header value is a ByteString, so the first file named in an Indian
  // language could be uploaded, was stored correctly, and could not be
  // fetched. `जीएसटी चालान.txt` is not an edge case at a firm in this market.
  it("survives a name the old header could not hold at all", () => {
    const header = contentDispositionFor("जीएसटी चालान.txt");
    // Every byte under 256, which is the property that was violated.
    expect([...header].every((ch) => ch.charCodeAt(0) < 256)).toBe(true);
    expect(header).toContain("filename*=UTF-8''");
    // And the real name is recoverable from it.
    expect(decodeURIComponent(header.split("filename*=UTF-8''")[1] ?? "")).toBe(
      "जीएसटी चालान.txt",
    );
  });

  it("leaves an ASCII name exactly as it was", () => {
    // No behaviour change for the files that already worked.
    expect(contentDispositionFor("invoice-2026.pdf")).toContain('filename="invoice-2026.pdf"');
  });

  it("keeps an extension in the ASCII fallback", () => {
    // `_` rather than dropping the character, so a reader whose client ignores
    // filename* still gets something with a .txt on the end rather than ".txt".
    const header = contentDispositionFor("चालान.txt");
    expect(header).toContain('filename="_____.txt"');
  });

  it("refuses to let a name escape the quoted string", () => {
    // A quote would end the quoted string; a backslash would escape whatever
    // came next. Both are removed rather than encoded, because neither belongs
    // in a filename anybody meant to give a file.
    const header = contentDispositionFor('a"b\\c.txt');
    expect(header).toContain('filename="abc.txt"');
  });

  it("survives the separator characters that break a header value", () => {
    // U+2028 is the one the audit found: it is not a control character, so
    // `safeFilename` keeps it, and it is above 255, so the header could not be
    // built.
    const header = contentDispositionFor("in\u2028voice.txt");
    expect([...header].every((ch) => ch.charCodeAt(0) < 256)).toBe(true);
  });

  it("still names something when the whole name is non-ASCII", () => {
    expect(contentDispositionFor("चालान")).toContain('filename="');
  });
});
