// The renderer's pure rules, and the one property the engine was chosen for.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { wrapParagraph } from "../../src/domain/render/model";
import { PdfLibRenderer } from "../../src/infrastructure/render/pdf-renderer";
import { RenderError } from "../../src/domain/render/errors";
import type { RenderableDocument } from "../../src/domain/render/model";

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

describe("and it still refuses, by name, what the chain does not cover", () => {
  it("refuses CJK — the honest remaining limit", async () => {
    // Noto Sans latin + latin-ext + devanagari does not include CJK, and adding
    // it is another font in the chain rather than a change of approach.
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
