// The PDF text adapter on pdf.js (docs/FIN_BUILD_PLAN.md F2.3): coordinates
// from the page's top-left, the scan heuristic, and every refusal. Fixtures are
// built here with pdf-lib (already a dependency, for rendering) or by hand, so
// nothing binary is committed. The pack's own scanned months are read by
// `statement-pdf-pack.test.ts`.
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { PdfUnreadable } from "../../src/domain/fin/errors";
import type { PdfTextPage } from "../../src/domain/fin/lines";
import { TEXT_PAGE_MIN_CHARS, hasReadableTextLayer, visibleChars } from "../../src/domain/fin/pdf-text";
import { PdfJsTextReader, placeRun } from "../../src/infrastructure/fin/pdf-text";

// pdf.js is loaded on the first read, a second or more on a loaded machine.
vi.setConfig({ testTimeout: 30_000 });

const reader = new PdfJsTextReader();

async function onePage(draw: (page: ReturnType<PDFDocument["addPage"]>, font: Awaited<ReturnType<PDFDocument["embedFont"]>>) => void): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  draw(page, font);
  return doc.save();
}

/** A PDF written by hand: the objects, an xref table with true offsets, and a
 *  trailer. For what pdf-lib will not write (an encryption dictionary). */
function handWritten(objects: readonly string[], trailer: string): Uint8Array {
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const hex = (n: number, seed: number): string =>
  Array.from({ length: n }, (_, i) => ((i * 37 + seed) & 255).toString(16).padStart(2, "0")).join("");

describe("coordinates: PDF points from the page's top-left", () => {
  it("turns pdf.js's bottom-left origin into the top-left, the box's top one text-height above the baseline", async () => {
    let width = 0;
    const bytes = await onePage((page, font) => {
      page.drawText("Statement", { x: 72, y: 700, size: 12, font });
      width = font.widthOfTextAtSize("Statement", 12);
    });
    const text = await reader.read(bytes);
    expect(text.pages).toHaveLength(1);
    const page = text.pages[0]!;
    expect([page.number, page.width, page.height]).toEqual([1, 612, 792]);
    const item = page.items[0]!;
    expect(item.text).toBe("Statement");
    expect(item.x).toBeCloseTo(72, 3);
    expect(item.y).toBeCloseTo(792 - 700 - 12, 3);
    expect(item.height).toBeCloseTo(12, 3);
    expect(item.width).toBeCloseTo(width, 1);
  });

  it("measures from the page box, wherever the box starts", async () => {
    const bytes = await onePage((page, font) => {
      page.setMediaBox(100, 200, 612, 792);
      page.drawText("Offset", { x: 172, y: 900, size: 12, font });
    });
    const item = (await reader.read(bytes)).pages[0]!.items[0]!;
    expect([item.x, item.y]).toEqual([expect.closeTo(72, 3), expect.closeTo(80, 3)]);
  });

  it("applies the page's /Rotate, as a viewer shows it", async () => {
    const bytes = await onePage((page, font) => {
      page.setRotation(degrees(90));
      page.drawText("Turned", { x: 72, y: 700, size: 12, font });
    });
    const page = (await reader.read(bytes)).pages[0]!;
    expect([page.width, page.height]).toEqual([792, 612]);
    const item = page.items[0]!;
    // Turned a quarter clockwise, the user-space point (72, 700) is drawn at
    // (700, 72) from the top-left.
    expect([item.x, item.y + item.height]).toEqual([expect.closeTo(700, 3), expect.closeTo(72, 3)]);
  });

  it("is one matrix product, pinned without a PDF", () => {
    // An unrotated 612 x 792 page's viewport flips y about its height.
    expect(placeRun("x", [10, 0, 0, 10, 50, 600], 20, 10, [1, 0, 0, -1, 0, 792])).toEqual({
      text: "x",
      x: 50,
      y: 182,
      width: 20,
      height: 10,
    });
  });
});

describe("whether a PDF has a text layer worth reading", () => {
  const p = (number: number, ...texts: string[]): PdfTextPage => ({
    number,
    width: 612,
    height: 792,
    items: texts.map((text, i) => ({ text, x: 36, y: 40 + i * 12, width: 100, height: 8 })),
  });
  const statementPage = p(1, "Merlion Bank Statement of Account", "03 Feb GIRO DEBIT 503.58 133,401.31");

  it("counts visible characters, not spaces", () => {
    expect(visibleChars(p(1, "  a b  ", "\tc\n"))).toBe(3);
  });

  it("a scanner's stamp alone is no text layer; a statement page is one", () => {
    expect("ScannedwithCamScanner".length).toBeLessThan(TEXT_PAGE_MIN_CHARS);
    expect(hasReadableTextLayer([p(1, "Scanned with CamScanner")])).toBe(false);
    expect(hasReadableTextLayer([statementPage])).toBe(true);
  });

  it("needs at least half the pages to be text pages, and a document with none has none", () => {
    expect(hasReadableTextLayer([statementPage, p(2)])).toBe(true);
    expect(hasReadableTextLayer([statementPage, p(2), p(3, "12")])).toBe(false);
    expect(hasReadableTextLayer([])).toBe(false);
  });

  it("an image-only page, as a scanner writes it, reads as a scan", async () => {
    const doc = await PDFDocument.create();
    // A 1 x 1 grey PNG standing in for the scanned page.
    const png = await doc.embedPng(
      Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==", "base64")),
    );
    doc.addPage([612, 792]).drawImage(png, { x: 0, y: 0, width: 612, height: 792 });
    const text = await reader.read(await doc.save());
    expect(text.pages[0]?.items).toEqual([]);
    expect(text.hasTextLayer).toBe(false);
  });
});

describe("what the adapter refuses", () => {
  async function refusal(bytes: Uint8Array, r = reader): Promise<PdfUnreadable> {
    try {
      await r.read(bytes);
    } catch (err) {
      if (err instanceof PdfUnreadable) return err;
      throw err;
    }
    throw new Error("expected PdfUnreadable");
  }

  it("bytes that are no PDF, an empty file and a cut-off one are damaged", async () => {
    const whole = await onePage((page, font) => page.drawText("x", { x: 72, y: 700, size: 12, font }));
    for (const bytes of [new TextEncoder().encode("hello, this is not a pdf"), new Uint8Array(0), whole.subarray(0, 40)]) {
      expect((await refusal(bytes)).reason).toBe("damaged");
    }
  });

  it("a PDF locked with a password is encrypted, and says what to ask the client for", async () => {
    const locked = handWritten(
      [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
        // The standard security handler with an owner and user hash no empty
        // password matches: a viewer would ask for the password.
        `<< /Filter /Standard /V 1 /R 2 /O <${hex(32, 1)}> /U <${hex(32, 2)}> /P -4 >>`,
      ],
      `/Encrypt 4 0 R /ID [<${hex(16, 3)}> <${hex(16, 3)}>]`,
    );
    const err = await refusal(locked);
    expect(err.reason).toBe("encrypted");
    expect(err.code).toBe("FIN_PDF_UNREADABLE");
    expect(err.message).toMatch(/password/u);
  });

  it("more pages, or more bytes, than a statement can have are too large, before the pages are read", async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i += 1) doc.addPage([612, 792]);
    const bytes = await doc.save();
    expect((await refusal(bytes, new PdfJsTextReader({ maxPages: 2 }))).reason).toBe("too_large");
    expect((await refusal(bytes, new PdfJsTextReader({ maxBytes: 100 }))).reason).toBe("too_large");
  });

  it("does not consume the caller's bytes: the next reader is offered the same file", async () => {
    const bytes = await onePage((page, font) => page.drawText("Kept", { x: 72, y: 700, size: 12, font }));
    const before = Buffer.from(bytes).toString("base64");
    await reader.read(bytes);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(Buffer.from(bytes).toString("base64")).toBe(before);
  });
});
