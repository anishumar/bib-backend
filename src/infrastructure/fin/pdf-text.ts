// The PDF text port (`usecase/fin/reading.ts` `PdfTextReader`) on pdf.js
// (docs/FIN_BUILD_PLAN.md F2.3). The ONLY file in the product that imports
// `pdfjs-dist`; nothing of pdf.js's crosses the port.
//
// ── WHY PDF.JS, AND HOW IT IS HELD ───────────────────────────────────────────
//
// It is Mozilla's, pure JavaScript (no native code to build into the image),
// and it reports each text run with the matrix it was drawn at, which is what
// a statement parser needs: WHERE every word is, not only what it says. It is
// used in Node with the "legacy" build and no worker thread (pdf.js runs its
// parser on the calling thread when it finds no worker), and three switches are
// set on every document, each for a reason:
//
//   useWasm: false           pdf.js builds WebAssembly at run time, for a PDF's
//                            PostScript functions and for image decoding. Text
//                            extraction needs neither, and the PDF is a
//                            stranger's: nothing of it is compiled here. (The
//                            older `isEvalSupported` switch is gone in pdf.js 6
//                            with the `new Function` compiler it guarded; the
//                            JavaScript path now interprets.)
//   useSystemFonts: false    no font on the host is read; the job's container
//                            has none and must not start depending on any.
//   disableFontFace: true    there is no page to draw on; text positions come
//                            from the PDF's own font metrics.
//
// ── LOADED ON FIRST USE ──────────────────────────────────────────────────────
//
// `setup/fin.ts` is imported by the API's composition root too, and the API
// never reads a PDF. So pdf.js (a megabyte of JavaScript) is imported the first
// time a PDF is read, in the fin job, and never by a process that has no use
// for it. Ground rule 4: fin can fail without BiB failing.
//
// ── COORDINATES: THE PAGE'S TOP-LEFT, IN POINTS ──────────────────────────────
//
// pdf.js reports each run's origin in PDF user space, whose origin is the
// page's BOTTOM-left with y growing upward, and whose box may not even start at
// zero. The port promises the TOP-left with y growing down. So each run's
// matrix is multiplied by the page's own viewport transform at scale 1, which
// moves the origin, flips y and applies the page's /Rotate, exactly as pdf.js
// itself does before drawing; the run's baseline lands at the transformed
// origin, and its box top is one text-height above that. Width and height are
// the run's own extent in points, along and across its line.
//
// ── BOUNDED ──────────────────────────────────────────────────────────────────
//
// A stranger's PDF can be built to be expensive: tens of thousands of pages,
// or a page with a million text runs. Bytes, pages and text runs each have a
// ceiling, and passing one is `PdfUnreadable("too_large")`, a person's problem
// rather than the job's memory.
import type { PdfText, PdfTextItem, PdfTextPage } from "../../domain/fin/lines";
import { PdfUnreadable } from "../../domain/fin/errors";
import { hasReadableTextLayer } from "../../domain/fin/pdf-text";
import type { PdfTextReader } from "../../usecase/fin/reading";
// Types only, erased from the build: the module itself is imported on first use.
import type * as PdfJsModule from "pdfjs-dist/legacy/build/pdf.mjs";

type PdfJs = typeof PdfJsModule;

/** Twice the upload limit's default: the upload limit decides, this only
 *  stops a file that reached the job some other way. */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
/** A year of a busy account's statements is a few dozen pages. */
export const MAX_PDF_PAGES = 200;
/** A dense statement page carries about 250 runs. */
export const MAX_PDF_TEXT_ITEMS = 250_000;

export interface PdfJsTextReaderLimits {
  readonly maxBytes: number;
  readonly maxPages: number;
  readonly maxTextItems: number;
}

let loading: Promise<PdfJs> | null = null;

function pdfjs(): Promise<PdfJs> {
  loading ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return loading;
}

/** pdf.js's own exception classes, told apart by name: an import of their
 *  classes would load the library at module load, which is what `pdfjs()`
 *  exists to avoid. */
function reasonFor(err: unknown): "encrypted" | "damaged" {
  return err instanceof Error && err.name === "PasswordException" ? "encrypted" : "damaged";
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** a·b for two PDF matrices [a b c d e f]. */
function multiply(m1: readonly number[], m2: readonly number[]): readonly number[] {
  const [a1 = 1, b1 = 0, c1 = 0, d1 = 1, e1 = 0, f1 = 0] = m1;
  const [a2 = 1, b2 = 0, c2 = 0, d2 = 1, e2 = 0, f2 = 0] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/** One text run in the port's coordinates: `viewport` is the page's viewport
 *  transform at scale 1, `matrix` the run's own text matrix. Exported for the
 *  coordinate test, which pins the arithmetic without a PDF. */
export function placeRun(
  text: string,
  matrix: readonly number[],
  width: number,
  height: number,
  viewport: readonly number[],
): PdfTextItem {
  const m = multiply(viewport, matrix);
  const x = m[4] ?? 0;
  const baseline = m[5] ?? 0;
  return { text, x, y: baseline - height, width, height };
}

export class PdfJsTextReader implements PdfTextReader {
  private readonly limits: PdfJsTextReaderLimits;

  constructor(limits: Partial<PdfJsTextReaderLimits> = {}) {
    this.limits = {
      maxBytes: limits.maxBytes ?? MAX_PDF_BYTES,
      maxPages: limits.maxPages ?? MAX_PDF_PAGES,
      maxTextItems: limits.maxTextItems ?? MAX_PDF_TEXT_ITEMS,
    };
  }

  async read(bytes: Uint8Array): Promise<PdfText> {
    if (bytes.length > this.limits.maxBytes) {
      throw new PdfUnreadable("too_large", `${bytes.length} bytes, over the ${this.limits.maxBytes} a PDF may be`);
    }
    const lib = await pdfjs();
    // A copy: pdf.js takes ownership of the buffer it is handed, and the read
    // sweep offers the same bytes to the next reader when this one says no.
    const task = lib.getDocument({
      data: new Uint8Array(bytes),
      useWasm: false,
      useSystemFonts: false,
      disableFontFace: true,
      stopAtErrors: false,
      verbosity: lib.VerbosityLevel.ERRORS,
    });
    try {
      let doc;
      try {
        doc = await task.promise;
      } catch (err) {
        throw new PdfUnreadable(reasonFor(err), messageOf(err));
      }
      if (doc.numPages > this.limits.maxPages) {
        throw new PdfUnreadable("too_large", `${doc.numPages} pages, over the ${this.limits.maxPages} a PDF may have`);
      }
      const pages: PdfTextPage[] = [];
      let items = 0;
      for (let number = 1; number <= doc.numPages; number += 1) {
        let page;
        let content;
        try {
          page = await doc.getPage(number);
          content = await page.getTextContent();
        } catch (err) {
          throw new PdfUnreadable("damaged", `page ${number}: ${messageOf(err)}`);
        }
        const viewport = page.getViewport({ scale: 1 });
        const runs: PdfTextItem[] = [];
        for (const item of content.items) {
          if (!("str" in item)) continue;
          items += 1;
          if (items > this.limits.maxTextItems) {
            throw new PdfUnreadable("too_large", `more than ${this.limits.maxTextItems} text runs`);
          }
          if (item.str.trim() === "") continue;
          runs.push(placeRun(item.str, item.transform, item.width, item.height, viewport.transform));
        }
        pages.push({ number, width: viewport.width, height: viewport.height, items: runs });
        page.cleanup();
      }
      return { pages, hasTextLayer: hasReadableTextLayer(pages) };
    } finally {
      await task.destroy();
    }
  }
}
