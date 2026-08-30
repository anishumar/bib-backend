// The renderer's fonts, and the fallback between them (T3.9).
//
// ── WHY THIS IS A CHAIN AND NOT A FONT ─────────────────────────────────────
//
// T3.8 shipped on the built-in PDF fonts, which encode Latin-1 and nothing
// else — so the rupee sign was undrawable in an Indian compliance product, and
// a client whose registered name is in Devanagari could not have a document at
// all. The renderer refused loudly rather than mangling, which was the right
// failure, but it was still a failure.
//
// The fix is not "embed a Unicode font", because there is no single file that
// covers what this product needs at a size worth shipping. Measured, not
// assumed — `hasGlyphForCodePoint` over the actual files says:
//
//   latin        — the basic range, and the em dash. NO rupee sign.
//   latin-ext    — the rupee sign, Polish, the ruble. NOT the basic range.
//   devanagari   — Devanagari, and the rupee sign again.
//
// So text is SEGMENTED into runs, each drawn with the first font in the chain
// that can draw it. That is what a browser does, and it is the part pdf-lib
// leaves to the caller.
//
// ── LICENSING, STATED BECAUSE IT IS THE REASON THIS WAS ITS OWN TASK ───────
//
// Noto Sans, SIL Open Font License 1.1, which expressly permits embedding and
// redistribution. It arrives as an npm dependency (`@fontsource/noto-sans`)
// rather than a binary committed to this repo — so it is versioned, auditable
// and updated like any other dependency, and nobody has to decide whether a
// font in `git log` was licensed.
//
// ── SUBSETTING IS WHAT MAKES THREE FONTS FREE ──────────────────────────────
//
// `subset: true` embeds only the glyphs actually used. A letter in plain English
// carries a few hundred bytes of Latin and NOTHING of the other two, because
// nothing referenced them. The chain costs what it is used for.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
// A SHIM FOR AN UPSTREAM BUNDLING DEFECT, and it is load-bearing rather than
// decorative — so it is stated here rather than left as a mystery import.
//
// `@pdf-lib/fontkit` is a UMD bundle compiled with regenerator but shipped
// without its runtime. It throws `regeneratorRuntime is not defined` the moment
// it walks a font with complex shaping tables. Latin does not have them and
// Devanagari does, so the failure appears ONLY on the script this task exists
// to support — which is why it was invisible until the last test.
//
// `fontkit` proper (2.x) was tried first and is worse: it changed the subset
// API that pdf-lib 1.x calls, so it fails with `subset.encodeStream is not a
// function` on every font. This bundle is the one pdf-lib expects, and this
// import is the documented way to make it work.
import "regenerator-runtime/runtime.js";
import fontkit from "@pdf-lib/fontkit";
import type { PDFDocument, PDFFont } from "pdf-lib";

/**
 * The chain, in priority order.
 *
 * `latin` first because almost every document is entirely within it, so almost
 * every character resolves on the first probe.
 */
const CHAIN = ["latin", "latin-ext", "devanagari"] as const;

const require = createRequire(import.meta.url);

function fontPath(subset: string, weight: 400 | 700): string {
  // Resolved through the package rather than a hardcoded node_modules path, so
  // it keeps working under a bundler, a monorepo hoist, or a different
  // installer layout.
  return require.resolve(
    `@fontsource/noto-sans/files/noto-sans-${subset}-${String(weight)}-normal.woff`,
  );
}

interface Loaded {
  readonly regular: PDFFont;
  readonly bold: PDFFont;
  readonly covers: (codePoint: number) => boolean;
}

/** One run of text that a single font can draw. */
export interface Run {
  readonly text: string;
  readonly fontIndex: number;
}

/**
 * The fonts a document is drawn with, and the fallback between them.
 *
 * Built once per render — pdf-lib embeds fonts into a specific document, so a
 * shared instance across documents would leak glyphs from one into another.
 */
export class FontSet {
  private constructor(private readonly fonts: readonly Loaded[]) {}

  static async load(pdf: PDFDocument): Promise<FontSet> {
    pdf.registerFontkit(fontkit);
    const fonts: Loaded[] = [];
    for (const subset of CHAIN) {
      const bytes = readFileSync(fontPath(subset, 400));
      // fontkit is asked directly what the file covers, rather than this file
      // carrying a table of Unicode ranges that would drift from the fonts the
      // day they are updated.
      const probe = fontkit.create(bytes) as unknown as {
        hasGlyphForCodePoint: (c: number) => boolean;
      };
      fonts.push({
        regular: await pdf.embedFont(bytes, { subset: true }),
        // The 700 weight, not the 400 file a second time. Embedding the same
        // bytes twice would produce a "bold" that is visually identical to the
        // body and a document where nothing a reader should notice stands out.
        bold: await pdf.embedFont(readFileSync(fontPath(subset, 700)), { subset: true }),
        covers: (c) => probe.hasGlyphForCodePoint(c),
      });
    }
    return new FontSet(fonts);
  }

  /** Whether ANY font in the chain can draw this character. What the renderer's
   *  guard asks, so the refusal is derived from the fonts actually loaded rather
   *  than from a hardcoded range that would lie the moment the chain changes. */
  canRender(codePoint: number): boolean {
    return this.fonts.some((f) => f.covers(codePoint));
  }

  /**
   * Split text into runs, each drawable by one font.
   *
   * Adjacent characters resolving to the same font are merged, so ordinary
   * English text is ONE run and costs one draw call.
   */
  segment(text: string): readonly Run[] {
    const runs: Run[] = [];
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0;
      const index = this.fonts.findIndex((f) => f.covers(code));
      // -1 cannot reach here — the guard runs first — but a space is the safe
      // answer if it ever did, rather than throwing mid-draw.
      const resolved = index < 0 ? 0 : index;
      const last = runs[runs.length - 1];
      if (last !== undefined && last.fontIndex === resolved) {
        runs[runs.length - 1] = { text: last.text + ch, fontIndex: resolved };
      } else {
        runs.push({ text: ch, fontIndex: resolved });
      }
    }
    return runs;
  }

  font(index: number, bold: boolean): PDFFont {
    const f = this.fonts[index] ?? this.fonts[0];
    if (f === undefined) throw new Error("no fonts loaded");
    return bold ? f.bold : f.regular;
  }

  /** Width of text that may span several fonts — what wrapping and
   *  right-alignment both need, and what a single PDFFont cannot answer. */
  widthOf(text: string, size: number, bold: boolean): number {
    return this.segment(text).reduce(
      (w, run) => w + this.font(run.fontIndex, bold).widthOfTextAtSize(run.text, size),
      0,
    );
  }
}
