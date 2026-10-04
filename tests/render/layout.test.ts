// The renderer's pure rules, and the one property the engine was chosen for.
import { gstPrint, tdsRows } from "../../src/domain/invoice/gst-print";
import { amountInWords, documentMoney } from "../../src/domain/render/money";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import fontkit from "@pdf-lib/fontkit";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { CLIENT_DATE_ANCHOR, CLIENT_SIGN_ANCHOR, wrapParagraph } from "../../src/domain/render/model";
import { PdfLibRenderer } from "../../src/infrastructure/render/pdf-renderer";
import { RenderError } from "../../src/domain/render/errors";
import type { Flow, RenderableDocument, RenderableImage } from "../../src/domain/render/model";

function doc(overrides: Partial<RenderableDocument> = {}): RenderableDocument {
  return {
    documentTitle: "Engagement Letter",
    reference: "EL-2026-0001",
    issuer: { name: "The Firm LLP", lines: ["Registered in IN"] },
    recipient: { name: "Kaveri Foods Private Limited", lines: [] },
    recipientLabel: "To",
    meta: [{ label: "Dated", value: "30 August 2026" }],
    sections: [{ heading: "Scope", paragraphs: ["Monthly GST compliance."] }],
    table: {
      columns: [
        { label: "Service", align: "left", weight: 6 },
        { label: "Fee", align: "right", weight: 2 },
      ],
      rows: [["GST filing", "INR 18,000.00"]],
    },
    totals: [{ label: "Total", value: "INR 18,000.00", emphasis: true }],
    footer: "The Firm LLP",
    logo: null,
    issuedOn: "2026-08-30",
    ...overrides,
  };
}

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

describe("the renderer is a pure function of its input", () => {
  it("produces IDENTICAL bytes for identical input", async () => {
    // THE PROPERTY THE ENGINE WAS CHOSEN FOR. A rendered document's content hash
    // is evidence — it proves the file a client holds is the one the firm issued
    // — so re-rendering unchanged data has to reproduce it exactly. A headless
    // browser cannot promise this across versions; that is why this is pdf-lib.
    const renderer = new PdfLibRenderer();
    expect(sha(await renderer.render(doc()))).toBe(sha(await renderer.render(doc())));
  });

  it("does not read the clock", async () => {
    // The specific failure this guards: pdf-lib writes CreationDate and ModDate
    // from the system clock by default, so without pinning them the assertion
    // above would pass inside one millisecond and fail in production.
    const renderer = new PdfLibRenderer();
    const a = await renderer.render(doc());
    await new Promise((r) => setTimeout(r, 1100));
    expect(sha(await renderer.render(doc()))).toBe(sha(a));
  });

  it("changes its bytes when the CONTENT changes", async () => {
    // The control. Without it a renderer returning a constant passes both above.
    const renderer = new PdfLibRenderer();
    const a = await renderer.render(doc());
    const b = await renderer.render(doc({ reference: "EL-2026-0002" }));
    expect(sha(a)).not.toBe(sha(b));
  });

  it("produces a real PDF", async () => {
    const bytes = await new PdfLibRenderer().render(doc());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });
});

describe("the font chain draws what the built-in fonts could not (T3.9)", () => {
  // Every one of these was a REFUSAL on T3.8's built-in fonts, which encoded
  // Latin-1 and nothing else. They are the reason the chain exists.

  it("draws the rupee sign — the one this product hits first", async () => {
    const bytes = await new PdfLibRenderer().render(
      doc({ totals: [{ label: "Total", value: "₹18,000.00", emphasis: true }] }),
    );
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("draws Devanagari, so a client's registered name can be its real one", async () => {
    const bytes = await new PdfLibRenderer().render(
      doc({ recipient: { name: "कावेरी फूड्स", lines: [] } }),
    );
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("draws an em dash and Latin-Extended accents", async () => {
    const bytes = await new PdfLibRenderer().render(
      doc({
        footer: "this — dash — is fine now",
        recipient: { name: "Société Générale Zürich Łódź", lines: ["Ñ"] },
      }),
    );
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("draws MIXED scripts in one string, which is what the segmentation is for", async () => {
    // A line no single font in the chain can draw on its own: the Latin word
    // comes from one file, the rupee from another, the Devanagari from a third.
    const bytes = await new PdfLibRenderer().render(
      doc({ sections: [{ heading: "Fee", paragraphs: ["Total ₹1,000 — कावेरी"] }] }),
    );
    expect(bytes.byteLength).toBeGreaterThan(0);
  });
});

interface ProbeGlyph {
  readonly id: number;
  readonly path: { toSVG(): string };
}
interface ProbeFont {
  layout(text: string): { glyphs: ProbeGlyph[] };
  getGlyph(id: number): ProbeGlyph;
  hasGlyphForCodePoint(codePoint: number): boolean;
  glyphForCodePoint(codePoint: number): ProbeGlyph;
  readonly loca: { readonly offsets: readonly number[] };
}
const probeFont = (bytes: Uint8Array): ProbeFont =>
  fontkit.create(Buffer.from(bytes)) as unknown as ProbeFont;
const requireFont = createRequire(import.meta.url);
const SOURCE_FONTS: readonly ProbeFont[] = [
  ...["latin", "latin-ext", "devanagari"].flatMap((s) =>
    [400, 700].map((w) => `@fontsource/noto-sans/files/noto-sans-${s}-${String(w)}-normal.woff`)),
  "@fontsource/noto-sans-math/files/noto-sans-math-latin-400-normal.woff",
  "@fontsource/noto-sans-symbols-2/files/noto-sans-symbols-2-symbols-400-normal.woff",
].map((p) => probeFont(readFileSync(requireFont.resolve(p))));
const glyphBytes = (f: ProbeFont, id: number): number =>
  (f.loca.offsets[id + 1] ?? 0) - (f.loca.offsets[id] ?? 0);

/** The glyphs a source font could have drawn this text with: its own glyph for
 *  one character (a Devanagari vowel sign laid out alone gains a dotted
 *  circle), or the one glyph a ligature lays out as. */
function candidates(source: ProbeFont, text: string): ProbeGlyph[] {
  const chars = [...text];
  const code = chars.length === 1 ? (text.codePointAt(0) ?? 0) : null;
  const direct = code !== null && source.hasGlyphForCodePoint(code) ? [source.glyphForCodePoint(code)] : [];
  const run = source.layout(text).glyphs;
  return [...direct, ...(run.length === 1 ? run : [])].filter((g) => g.id !== 0);
}

/**
 * Every glyph a PDF embeds, held to the font file it came from: the same
 * outline, and not one byte shorter. The second half is the one a reader sees.
 * A viewer's rasteriser (FreeType, under Chrome and MuPDF) draws NOTHING for a
 * glyph whose data is cut short, while a parser reading from the glyph's start
 * decodes it perfectly, so an outline check alone passes a blank symbol.
 * Answers one line per broken glyph.
 */
async function brokenGlyphs(bytes: Uint8Array): Promise<string[]> {
  const pdf = await PDFDocument.load(bytes);
  const ctx = pdf.context;
  const dict = (from: PDFDict, key: string): PDFDict => ctx.lookup(from.get(PDFName.of(key)), PDFDict);
  const stream = (from: PDFDict, key: string): Buffer => {
    const raw = ctx.lookup(from.get(PDFName.of(key)));
    if (!(raw instanceof PDFRawStream)) throw new Error(`${key} is not a stream`);
    return Buffer.from(decodePDFRawStream(raw).decode());
  };
  const broken: string[] = [];
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || obj.get(PDFName.of("Subtype")) !== PDFName.of("Type0")) continue;
    const cid = ctx.lookup(ctx.lookup(obj.get(PDFName.of("DescendantFonts")), PDFArray).get(0), PDFDict);
    const embedded = probeFont(stream(dict(cid, "FontDescriptor"), "FontFile2"));
    // The ToUnicode map says which text each glyph id draws; a ligature is one
    // glyph for several characters, so the source is found by laying it out.
    const cmap = stream(obj, "ToUnicode").toString("latin1");
    for (const [, gidHex, textHex] of cmap.matchAll(/<([0-9A-Fa-f]{4})> <([0-9A-Fa-f]+)>/g)) {
      const gid = parseInt(gidHex ?? "", 16);
      const text = Buffer.from(textHex ?? "", "hex").swap16().toString("utf16le");
      let outline: string;
      try {
        outline = embedded.getGlyph(gid).path.toSVG();
      } catch {
        outline = "unreadable";
      }
      const whole = SOURCE_FONTS.some((source) =>
        candidates(source, text).some((glyph) =>
          glyph.path.toSVG() === outline && glyphBytes(embedded, gid) >= glyphBytes(source, glyph.id)));
      if (!whole) broken.push(`${JSON.stringify(text)} (glyph ${String(gid)})`);
    }
  }
  return broken;
}

/** Every font a PDF carries, by its PostScript name ("ABCDEF+NotoSansMath-Regular"). */
async function fontNames(bytes: Uint8Array): Promise<string[]> {
  const { PDFDocument, PDFDict, PDFName } = await import("pdf-lib");
  const pdf = await PDFDocument.load(bytes);
  const names: string[] = [];
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || obj.get(PDFName.of("Type")) !== PDFName.of("Font")) continue;
    const base = obj.get(PDFName.of("BaseFont"));
    if (base instanceof PDFName) names.push(base.decodeText());
  }
  return names;
}

describe("the symbols fallback draws what a firm's templates actually write", () => {
  it("draws ≤ and ≥ — the standard service template writes volume limits with them", async () => {
    // Found on QA, 2026-09-29: the catalogue brought over from the firm's
    // previous app words its volume limits as "≤1,000 entries; ≤300 vendor/≤200
    // customer invoices", and every proposal quoting that service was refused.
    // Neither sign is in any of the three Noto Sans files; Noto Sans Math has both.
    const bytes = await new PdfLibRenderer().render(
      doc({
        sections: [{
          heading: "Volume limits",
          paragraphs: ["≤1,000 entries; ≤8 bank accounts; GSTR-9C (turnover ≥ ₹2 cr)"],
        }],
      }),
    );
    expect(await fontNames(bytes)).toContainEqual(expect.stringContaining("NotoSansMath"));
  });

  it("draws the other signs people type into a scope: ≠ ≈ → ✓ ✔ ✗ ☐ ⚠", async () => {
    const bytes = await new PdfLibRenderer().render(
      doc({ sections: [{ heading: "Checks", paragraphs: ["maker ≠ checker ≈ → ✓ ✔ ✗ ☐ ⚠"] }] }),
    );
    const names = await fontNames(bytes);
    expect(names).toContainEqual(expect.stringContaining("NotoSansMath"));
    expect(names).toContainEqual(expect.stringContaining("NotoSansSymbols2"));
  });

  it("draws a warning sign typed from a phone's emoji keyboard, which appends an invisible U+FE0F", async () => {
    // "⚠️" is TWO characters: the sign, then a variation selector asking for
    // the colourful style. The selector draws nothing, so the PDF draws the
    // sign and leaves the request out — nothing visible is lost.
    const bytes = await new PdfLibRenderer().render(
      doc({ sections: [{ heading: "Note", paragraphs: ["⚠️ Due by the 7th"] }] }),
    );
    expect(await fontNames(bytes)).toContainEqual(expect.stringContaining("NotoSansSymbols2"));
  });

  it("embeds every glyph WHOLE, so a symbol is drawn and not left blank", async () => {
    // Found by looking at the page, after every test above was green: ≠ → ✔ ✗
    // ☐ ⚠ took up their space and drew nothing. @pdf-lib/fontkit writes a small
    // subset with the short loca format, which stores each glyph's offset
    // halved, and never pads a glyph to an even length first. The Noto Sans
    // text fonts have no odd-length glyph, so they never met it; Math and
    // Symbols 2 have well over a thousand each, and every glyph after the first
    // one was cut short or read from the wrong byte.
    const bytes = await new PdfLibRenderer().render(
      doc({
        sections: [{
          heading: "Symbols",
          paragraphs: ["≤1,000 ≥ ₹2 cr ≠ ≈ → ← ✓ ✔ ✗ ☐ ☑ ⚠ ★ ● ■ ▶ ─ ∞ √ ±", "कावेरी — Société Łódź"],
        }],
      }),
    );
    expect(await brokenGlyphs(bytes)).toEqual([]);
  });

  it("embeds the symbol fonts ONLY into a document that uses them", async () => {
    // The chain grew; the documents already issued must not. A plain letter
    // carries exactly the fonts it carried before these were added, which is
    // what keeps it re-rendering to the bytes its client holds.
    const names = await fontNames(await new PdfLibRenderer().render(doc()));
    // The control: without it an empty list would pass the line below.
    expect(names).toContainEqual(expect.stringContaining("NotoSans-"));
    expect(names.some((n) => n.includes("NotoSansMath") || n.includes("NotoSansSymbols"))).toBe(false);
  });
});

describe("and it still refuses, by name, what the chain does not cover", () => {
  it("refuses CJK — the honest remaining limit", async () => {
    // No font in the chain (Noto Sans latin, latin-ext and devanagari, then
    // Noto Sans Math and Symbols 2) includes CJK, and adding it is another font
    // in the chain rather than a change of approach.
    // Refusing beats mangling: a client's name with a character missing on a
    // legal document is worse than producing nothing.
    await expect(
      new PdfLibRenderer().render(doc({ recipient: { name: "株式会社", lines: [] } })),
    ).rejects.toThrow(RenderError);
  });

  it("names the character and the field it appeared in", async () => {
    await expect(
      new PdfLibRenderer().render(doc({ footer: "株" })),
    ).rejects.toThrow(/the footer contains/);
  });

  it("refuses a colour emoji — no font in the chain carries one", async () => {
    await expect(
      new PdfLibRenderer().render(doc({ footer: "Filed ✅" })),
    ).rejects.toThrow(/the footer contains "✅"/);
  });

  it("refuses BEFORE drawing, so no half-page is produced", async () => {
    // The guard runs against the fonts actually loaded, before the first draw.
    await expect(
      new PdfLibRenderer().render(doc({ documentTitle: "株式会社" })),
    ).rejects.toThrow(RenderError);
  });
});

describe("wrapping a paragraph", () => {
  // One point per character, so the arithmetic in the test is legible.
  const measure = (s: string): number => s.length;

  it("breaks on words to fit the width", () => {
    expect(wrapParagraph("aaa bbb ccc ddd", 7, measure)).toEqual(["aaa bbb", "ccc ddd"]);
  });

  it("keeps the firm's OWN line breaks", () => {
    // "under 1,000 entries; under 8 bank accounts" is what protects the firm in
    // a dispute (G1.7), and its shape is part of the meaning.
    expect(wrapParagraph("one\ntwo", 100, measure)).toEqual(["one", "two"]);
  });

  it("does not hyphenate a word longer than the line", () => {
    // The long things here are GSTINs and reference numbers. Breaking one
    // produces a document a client cannot use.
    expect(wrapParagraph("36AAAA0000A1Z5", 5, measure)).toEqual(["36AAAA0000A1Z5"]);
  });

  it("preserves an empty line rather than collapsing it", () => {
    expect(wrapParagraph("a\n\nb", 10, measure)).toEqual(["a", "", "b"]);
  });
});

describe("signature blocks (0080)", () => {
  const blocks: RenderableDocument["signatures"] = [
    { heading: "For The Firm LLP", lines: ["A. Partner", "Partner"], signAnchor: null, dateAnchor: null },
    {
      heading: "Accepted for and on behalf of Kaveri Foods Private Limited",
      lines: ["Name and capacity"],
      signAnchor: CLIENT_SIGN_ANCHOR,
      dateAnchor: CLIENT_DATE_ANCHOR,
    },
  ];

  it("are deterministic like everything else on the page", async () => {
    const r = new PdfLibRenderer();
    expect(sha(await r.render(doc({ signatures: blocks })))).toBe(
      sha(await r.render(doc({ signatures: blocks }))),
    );
  });

  it("move nothing on a document that has none — an invoice's bytes are what they were", async () => {
    const r = new PdfLibRenderer();
    const without = sha(await r.render(doc()));
    expect(sha(await r.render(doc({ signatures: undefined })))).toBe(without);
    expect(sha(await r.render(doc({ signatures: [] })))).toBe(without);
    expect(sha(await r.render(doc({ signatures: blocks })))).not.toBe(without);
  });

  it("are checked against the font chain with everything else, by name", async () => {
    await expect(
      new PdfLibRenderer().render(
        doc({ signatures: [{ heading: "For 株式会社", lines: [], signAnchor: null, dateAnchor: null }] }),
      ),
    ).rejects.toThrow(/signature block's heading/);
  });
});

describe("the firm's signature image (0081)", () => {
  /** A 1×1 PNG. Real bytes, because `embedPng` parses them. */
  const MARK = {
    bytes: Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    ),
    mediaType: "image/png" as const,
  };

  const firmBlock = (
    image: RenderableImage | null | undefined,
  ): RenderableDocument["signatures"] => [
    { heading: "For The Firm LLP", lines: ["A. Partner", "Partner"], signAnchor: null, dateAnchor: null, image },
  ];

  it("is drawn — the whole point, and the thing that was missing", async () => {
    const r = new PdfLibRenderer();
    const bare = sha(await r.render(doc({ signatures: firmBlock(null) })));
    expect(sha(await r.render(doc({ signatures: firmBlock(MARK) })))).not.toBe(bare);
  });

  it("stays deterministic with a mark on the page", async () => {
    const r = new PdfLibRenderer();
    expect(sha(await r.render(doc({ signatures: firmBlock(MARK) })))).toBe(
      sha(await r.render(doc({ signatures: firmBlock(MARK) }))),
    );
  });

  it("moves nothing when absent, so every letter issued before it re-renders byte-identical", async () => {
    const r = new PdfLibRenderer();
    const bare = sha(await r.render(doc({ signatures: firmBlock(null) })));
    expect(sha(await r.render(doc({ signatures: firmBlock(undefined) })))).toBe(bare);
  });
});

describe("the terms — a contract's actual clauses", () => {
  const terms = [
    { heading: "Confidentiality", paragraphs: ["Each party keeps the other in confidence."] },
    { heading: "Client responsibilities", paragraphs: ["The client provides complete records."] },
  ];

  it("reach the page — until this they were pinned, hashed, and absent from the PDF", async () => {
    const r = new PdfLibRenderer();
    expect(sha(await r.render(doc({ terms })))).not.toBe(sha(await r.render(doc())));
  });

  it("move nothing on a document that has none — an invoice's bytes are what they were", async () => {
    const r = new PdfLibRenderer();
    const without = sha(await r.render(doc()));
    expect(sha(await r.render(doc({ terms: undefined })))).toBe(without);
    expect(sha(await r.render(doc({ terms: [] })))).toBe(without);
  });

  it("are checked against the font chain by name, like the firm's own prose", async () => {
    await expect(
      new PdfLibRenderer().render(doc({ terms: [{ heading: "Governing law", paragraphs: ["株式会社"] }] })),
    ).rejects.toThrow(/the term "Governing law"/);
  });
});

// ── 0083 · the classic letter's bytes, PINNED ───────────────────────────────
//
// Every letter issued before 0083 is `classic`, and 0083 added a whole second
// layout to this file. The tests above prove the renderer is consistent with
// ITSELF; these prove it is consistent with the renderer that issued those
// letters. The two hashes were taken from the code as it stood before 0083 —
// a classic letter with every part a letter has, and an invoice — and a change
// that moves either one changes the PDF of every document already issued.
//
// If one of these fails, do not update the constant to make it pass. Find out
// what moved: a re-render that no longer matches is a signed letter whose
// `bib_content_hash` stamp and whose filed copy no longer agree with what this
// product produces. Changing them is a decision, taken out loud.
describe("the classic letter and the invoice render exactly as they did before 0083", () => {
  const classic: RenderableDocument = {
    documentTitle: "Engagement Letter",
    reference: "EL-2026-0001",
    issuer: { name: "The Firm LLP", lines: ["Registered in IN"] },
    recipient: { name: "Kaveri Foods Private Limited", lines: [] },
    recipientLabel: "To",
    meta: [
      { label: "Dated", value: "30 August 2026" },
      { label: "Effective from", value: "1 September 2026" },
      { label: "Governing law", value: "IN" },
    ],
    sections: [
      { heading: "Background", paragraphs: ["Why they are buying.\nSecond line."] },
      { heading: "Exclusions", paragraphs: ["Audit", "Litigation"] },
    ],
    table: {
      columns: [
        { label: "Service", align: "left", weight: 6 },
        { label: "Billing", align: "left", weight: 2 },
        { label: "Fee", align: "right", weight: 2 },
      ],
      rows: [
        [
          "GST filing for a long description that wraps across more than one line of the table",
          "Monthly",
          "INR 18,000.00",
        ],
        ["Audit support", "One-off", "As mutually agreed"],
      ],
    },
    totals: [{ label: "Total", value: "INR 18,000.00", emphasis: true }],
    terms: [
      { heading: "Confidentiality", paragraphs: ["We keep it confidential."] },
      { heading: "Governing law", paragraphs: ["Laws of India."] },
    ],
    footer: "The Firm LLP",
    signatures: [
      { heading: "For The Firm LLP", lines: ["A Partner", "Director"], image: null, signAnchor: null, dateAnchor: null },
      {
        heading: "Accepted for and on behalf of Kaveri Foods Private Limited",
        lines: ["Name and capacity"],
        signAnchor: CLIENT_SIGN_ANCHOR,
        dateAnchor: CLIENT_DATE_ANCHOR,
      },
    ],
    logo: null,
    issuedOn: "2026-08-30",
  };
  const invoice: RenderableDocument = {
    ...classic,
    documentTitle: "Tax Invoice",
    reference: "INV/2026-27/0001",
    recipientLabel: "Billed to",
    sections: [],
    terms: undefined,
    signatures: undefined,
    table: {
      columns: [
        { label: "Description", align: "left", weight: 6 },
        { label: "Qty", align: "right", weight: 1 },
        { label: "Rate", align: "right", weight: 2 },
        { label: "Amount", align: "right", weight: 2 },
      ],
      rows: [["GST", "1", "INR 100.00", "INR 100.00"]],
    },
    totals: [
      { label: "Sub-total", value: "INR 100.00", emphasis: false },
      { label: "Total", value: "INR 118.00", emphasis: true },
    ],
  };

  it("a classic letter", async () => {
    expect(sha(await new PdfLibRenderer().render(classic))).toBe(
      "c77babe79e826ed401cfd661185c9b19c6ac068bc793ad2f4c229306d665455b",
    );
  });

  it("an invoice", async () => {
    expect(sha(await new PdfLibRenderer().render(invoice))).toBe(
      "25208dc33fbead3761b4afa5780ea2ec65dd65886feeae8650007ff9fed53809",
    );
  });
});

// THE GST TAX INVOICE (Q056, S5): a NEW layout, pinned here on its first day.
// The plain invoice above did not move (its hash is unchanged): a GST invoice
// is a different document, drawn only for an invoice issued since 0370 by an
// Indian company with a GSTIN.
describe("the GST tax invoice (Q056)", () => {
  const money = (a: string): string => documentMoney(a, "INR", { minorUnits: "always" });
  const gst = gstPrint({
    treatment: "gst_intra",
    currency: "INR",
    money,
    countryName: (c) => c,
    supplierName: "10x Global Advisory Private Limited",
    placeOfSupplyStateCode: "27",
    placeOfSupplyCountry: null,
    lines: [
      { description: "Monthly bookkeeping, September 2026", sac: "998222", quantity: "1", unitAmount: "25000", taxPercent: "18", net: "25000.0000" },
      { description: "TDS return, Q2", sac: "998231", quantity: "1", unitAmount: "5000", taxPercent: "18", net: "5000.0000" },
    ],
    summary: [
      { sac: "998222", taxPercent: "18", taxable: "25000.0000", cgst: "2250.0000", sgst: "2250.0000", utgst: "0", igst: "0", tax: "4500.0000" },
      { sac: "998231", taxPercent: "18", taxable: "5000.0000", cgst: "450.0000", sgst: "450.0000", utgst: "0", igst: "0", tax: "900.0000" },
    ],
    totals: {
      gross: "30000.0000",
      discount: "0.0000",
      net: "30000.0000",
      tax: "5400.0000",
      total: "35400.0000",
      cgst: "2700.0000",
      sgst: "2700.0000",
      utgst: "0.0000",
      igst: "0.0000",
    },
    taxInInr: null,
    lut: null,
    bank: {
      accountName: "10x Global Advisory Pvt Ltd",
      accountNumber: "50200012345678",
      bankName: "HDFC Bank",
      branch: "Fort, Mumbai",
      ifsc: "HDFC0001234",
      swift: null,
      iban: null,
    },
  });
  const doc: RenderableDocument = {
    documentTitle: "Tax Invoice",
    reference: "INV/2026-27/0007",
    issuer: { name: "10x Global Advisory Private Limited", lines: ["Nariman Point, Mumbai", "GSTIN 27ABCDE1234F1Z5", "State: Maharashtra (27)"] },
    recipient: { name: "Meridian Textiles Private Limited", lines: ["Lower Parel, Mumbai", "GSTIN 27AAACM1234K1Z9", "State: Maharashtra (27)"] },
    recipientLabel: "Billed to",
    meta: [
      { label: "Invoice date", value: "5 October 2026" },
      { label: "Due", value: "20 October 2026" },
      ...gst.meta,
    ],
    sections: [],
    table: gst.table,
    totals: [
      ...gst.totals,
      ...tdsRows({ section: "194J", percent: "10", tds: "3000.0000", netPayable: "32400.0000", money }),
    ],
    amountInWords: amountInWords("35400.0000", "INR"),
    taxInvoice: gst.print,
    footer: "10x Global Advisory Private Limited",
    logo: null,
    issuedOn: "2026-10-05",
  };

  it("renders to the same bytes every time", async () => {
    const a = await new PdfLibRenderer().render(doc);
    const b = await new PdfLibRenderer().render(doc);
    expect(sha(a)).toBe(sha(b));
  });

  it("renders as pinned", async () => {
    expect(sha(await new PdfLibRenderer().render(doc))).toBe(
      "aecfb6ec139dab0532177f6a99107634a76d5f5f5fe8de0550d87963d7426b40",
    );
  });
});

describe("the Annexure letter (0083)", () => {
  const annexure = (cell = "USD 5,000.00 per month"): RenderableDocument =>
    doc({
      documentTitle: "Engagement Letter for MyDojo, Inc.",
      meta: [],
      sections: [],
      table: null,
      totals: [],
      annexureLetter: {
        cover: {
          dateLine: "Dated 28 June 2026",
          addressee: ["Bowen Liu", "MyDojo, Inc."],
          subject: "Subject: Engagement Letter for MyDojo, Inc. — period commencing 1 July 2026",
          salutation: "Dear Bowen Liu,",
          body: [{ kind: "paragraph", text: "This letter confirms our engagement." }],
          closing: "Yours sincerely,",
          firm: { heading: "For 10X Global Inc.", lines: ["Siddharth Kohli", "Director"], signAnchor: null, dateAnchor: null },
          acceptanceHeading: "Acceptance",
          acceptance: [{ kind: "paragraph", text: "The terms are accepted." }],
          client: {
            heading:
              "Accepted for and on behalf of MyDojo, Inc., for itself and on behalf of PrepWorks, " +
              "Maths Genie and MyDojo HK Limited",
            lines: ["Name and capacity"],
            signAnchor: CLIENT_SIGN_ANCHOR,
            dateAnchor: CLIENT_DATE_ANCHOR,
          },
        },
        annexures: [
          {
            label: "Annexure 1",
            title: "Scope of Services, Deliverables & Fees",
            flow: [
              { kind: "heading", level: 1, text: "B. Ongoing Recurring Services" },
              { kind: "heading", level: 2, text: "B1. Accounting / CAS" },
              { kind: "paragraph", text: "- Daily bookkeeping.\n- Monthly financial statements." },
              {
                kind: "table",
                table: {
                  columns: [
                    { label: "Section", align: "left", weight: 1 },
                    { label: "Fee", align: "left", weight: 3 },
                  ],
                  rows: [["B", cell]],
                },
              },
              { kind: "figures", rows: [{ label: "Advance", value: "USD 16,000.00", emphasis: true }] },
            ],
          },
          {
            label: "Annexure 2",
            title: "Standard Terms & Conditions",
            flow: [{ kind: "heading", level: 2, text: "1. Services" }],
          },
        ],
      },
    });

  it("renders, and to the same bytes every time", async () => {
    const r = new PdfLibRenderer();
    const first = await r.render(annexure());
    expect(new TextDecoder().decode(first.slice(0, 5))).toBe("%PDF-");
    expect(sha(await r.render(annexure()))).toBe(sha(first));
  });

  it("is a different document from the classic one built from the same head", async () => {
    const r = new PdfLibRenderer();
    expect(sha(await r.render(annexure()))).not.toBe(sha(await r.render(doc())));
  });

  it("refuses what the font chain cannot draw, naming where it is", async () => {
    await expect(new PdfLibRenderer().render(annexure("株式会社"))).rejects.toThrow(
      /row 1 of the table in Annexure 1/,
    );
  });
});

describe("the proposal (0084)", () => {
  /** A 1×1 PNG — real bytes, because `embedPng` parses them. */
  const PNG = {
    bytes: Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    ),
    mediaType: "image/png" as const,
  };

  const proposal = (
    opts: { artwork?: RenderableImage | null; client?: string; services?: number } = {},
  ): RenderableDocument => {
    const services = opts.services ?? 1;
    const items: Flow[] = Array.from({ length: services }, (_, i): Flow[] => [
      { kind: "heading" as const, level: 2 as const, text: `H${String(i + 1)}. Transfer pricing audit — Form 3CEB` },
      { kind: "paragraph" as const, text: "- Benchmarking study.\n- Form 3CEB, certified and filed." },
      { kind: "paragraph" as const, lead: "Fees", text: `H${String(i + 1)}: INR 50,000 Yearly` },
    ]).flat();
    return doc({
      documentTitle: "Proposal",
      reference: "PR-2026-0001",
      meta: [],
      sections: [],
      table: null,
      totals: [],
      footer: null,
      logo: PNG,
      proposal: {
        cover: {
          artwork: opts.artwork === undefined ? PNG : opts.artwork,
          title: "Proposal for Services",
          subtitle: "Compliance support FY 2026-27",
          preparedFor: [
            { text: "Priya Sharma", bold: true },
            { text: opts.client ?? "Nexus Fintech", bold: true },
          ],
          preparedBy: [
            { text: "Siddharth Kohli", bold: true },
            { text: "10x Global Private Limited", bold: true },
            { text: "siddharth@10xglobal.in", bold: false },
          ],
        },
        running: "PR-2026-0001  ·  26 September 2026",
        flow: [
          { kind: "heading", level: 1, text: "Background" },
          { kind: "paragraph", text: "Nexus Fintech provides payment services to its clients." },
          { kind: "heading", level: 1, text: "A. Financial Reporting & Compliance" },
          { kind: "heading", level: 3, text: "Our responsibilities:" },
          ...items,
          { kind: "heading", level: 1, text: "Summary of Fees" },
          {
            kind: "table",
            table: {
              columns: [
                { label: "Section", align: "left", weight: 1 },
                { label: "Sub Section", align: "left", weight: 1 },
                { label: "Fees", align: "left", weight: 2 },
              ],
              rows: [["A", "H1", "INR 50,000"]],
            },
          },
        ],
      },
    });
  };

  it("renders, and to the same bytes every time", async () => {
    const r = new PdfLibRenderer();
    const first = await r.render(proposal());
    expect(new TextDecoder().decode(first.slice(0, 5))).toBe("%PDF-");
    expect(sha(await r.render(proposal()))).toBe(sha(first));
  });

  it("draws the firm's artwork on the cover — and a plain cover without one", async () => {
    const r = new PdfLibRenderer();
    expect(sha(await r.render(proposal({ artwork: null })))).not.toBe(sha(await r.render(proposal())));
  });

  it("puts the cover on a page of its own and flows the rest across as many as it needs", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const short = await PDFDocument.load(await new PdfLibRenderer().render(proposal()));
    expect(short.getPageCount()).toBe(2);
    const long = await PDFDocument.load(await new PdfLibRenderer().render(proposal({ services: 40 })));
    expect(long.getPageCount()).toBeGreaterThan(3);
  });

  it("refuses what the font chain cannot draw on the cover, naming where it is", async () => {
    await expect(new PdfLibRenderer().render(proposal({ client: "株式会社" }))).rejects.toThrow(
      /"Prepared for" line 2/,
    );
  });
});
