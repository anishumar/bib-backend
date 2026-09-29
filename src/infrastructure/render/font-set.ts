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
//   math         — ≤ ≥ ≠ ≈, arrows, ✓, and the box and geometric shapes.
//   symbols-2    — ✔ ✗ ☐ ⚠ and the rest of the dingbats.
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
//
// ── THE SYMBOL FONTS ARE EMBEDDED ONLY WHEN A DOCUMENT NEEDS THEM ──────────
//
// Math and Symbols 2 joined after documents had been issued (found on QA,
// 2026-09-29: the firm's standard service template writes its volume limits as
// "≤1,000 entries", and every proposal quoting it was refused). Embedding them
// into every document the way the first three are would add two fonts to a
// plain letter and change its bytes, and a letter issued before them must
// re-render as the document its client holds (layout.test.ts pins those
// hashes). So they are ON DEMAND: `load` only asks what they cover, and
// `prepare` embeds one into this document when a character it will draw
// resolves to it. A document with no symbol in it is byte-for-byte what it was.
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

// A SECOND UPSTREAM DEFECT, IN THE SUBSETTER, and this one draws NOTHING rather
// than throwing — found by looking at a rendered page after every test was green.
//
// `@pdf-lib/fontkit` writes a subset under 64 KB with the SHORT loca format,
// which stores each glyph's offset halved (`offsets[i] >>>= 1`), and never pads
// a glyph to an even length first. Any glyph after an odd-length one therefore
// starts a byte early or ends a byte short, and a viewer's rasteriser (FreeType,
// under Chrome and MuPDF) draws a short glyph as empty space. The Noto Sans text
// fonts store every glyph at an even length and never met it; Noto Sans Math and
// Symbols 2 have well over a thousand odd-length glyphs each, and ≠ → ✔ ✗ ☐ ⚠
// came out blank.
//
// The fix is the padding the format assumes: one zero byte after an odd-length
// glyph, as a font compiler writes. Glyph data is read by its own structure, so
// a trailing byte is never read as part of it. It is applied to THIS module's
// fonts only (pdf-lib calls `create` on whatever fontkit it is given), by
// wrapping the subset each font creates, not the library's prototype. A font
// with no odd-length glyph gets the identical subset, which is why every
// document drawn in the text fonts alone keeps its bytes.
interface SubsetInternals {
  glyf: Uint8Array[];
  offset: number;
  _addGlyph(gid: number): number;
}

function padOddGlyphs<S>(subset: S): S {
  const s = subset as unknown as SubsetInternals;
  const addGlyph = s._addGlyph.bind(s);
  s._addGlyph = (gid) => {
    const index = addGlyph(gid);
    const data = s.glyf[index];
    if (data !== undefined && data.length % 2 === 1) {
      // The bundle's own Buffer class, not Node's: its stream refuses any chunk
      // its polyfill does not recognise ("Invalid non-string/buffer chunk").
      const SameBuffer = data.constructor as unknown as { alloc(size: number): Uint8Array };
      const padded = SameBuffer.alloc(data.length + 1);
      padded.set(data);
      s.glyf[index] = padded;
      s.offset += 1;
    }
    return index;
  };
  return subset;
}

const evenGlyphFontkit: Parameters<PDFDocument["registerFontkit"]>[0] = {
  create(bytes, postscriptName) {
    const font = fontkit.create(bytes, postscriptName);
    const createSubset = font.createSubset.bind(font);
    font.createSubset = () => padOddGlyphs(createSubset());
    return font;
  },
};

interface ChainFont {
  /** The npm package the files ship in. */
  readonly pkg: string;
  /** The file name before `-<weight>-normal.woff`. */
  readonly stem: string;
  /** Whether a 700 file exists. Math and Symbols 2 are published in one
   *  weight, so a symbol inside a bold heading draws at regular weight. */
  readonly hasBold: boolean;
  /** Embedded only when a document uses it. See the file header. */
  readonly onDemand: boolean;
}

/**
 * The chain, in priority order.
 *
 * `latin` first because almost every document is entirely within it, so almost
 * every character resolves on the first probe. The symbol fonts come last, so
 * they are reached only by what the text fonts cannot draw; Math before
 * Symbols 2 because it also carries → and ✓, and one font for both reads evenly.
 */
const CHAIN: readonly ChainFont[] = [
  { pkg: "@fontsource/noto-sans", stem: "noto-sans-latin", hasBold: true, onDemand: false },
  { pkg: "@fontsource/noto-sans", stem: "noto-sans-latin-ext", hasBold: true, onDemand: false },
  { pkg: "@fontsource/noto-sans", stem: "noto-sans-devanagari", hasBold: true, onDemand: false },
  { pkg: "@fontsource/noto-sans-math", stem: "noto-sans-math-latin", hasBold: false, onDemand: true },
  { pkg: "@fontsource/noto-sans-symbols-2", stem: "noto-sans-symbols-2-symbols", hasBold: false, onDemand: true },
];

/**
 * U+FE0E and U+FE0F draw nothing: they only ask for the plain or the colourful
 * style of the sign before them, and a phone's emoji keyboard types "⚠" as "⚠"
 * followed by U+FE0F. The sign is drawn and the request is left out, so nothing
 * a reader could see is lost. Refusing it would refuse a warning sign.
 */
function isStyleSelector(codePoint: number): boolean {
  return codePoint === 0xfe0e || codePoint === 0xfe0f;
}

const require = createRequire(import.meta.url);

function fontPath(font: ChainFont, weight: 400 | 700): string {
  // Resolved through the package rather than a hardcoded node_modules path, so
  // it keeps working under a bundler, a monorepo hoist, or a different
  // installer layout.
  return require.resolve(`${font.pkg}/files/${font.stem}-${String(weight)}-normal.woff`);
}

interface Loaded {
  readonly font: ChainFont;
  readonly regularBytes: Uint8Array;
  readonly covers: (codePoint: number) => boolean;
  /** Null until embedded into this document, which for an on-demand font is
   *  until a character the document draws needs it. */
  embedded: { readonly regular: PDFFont; readonly bold: PDFFont } | null;
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
  private constructor(
    private readonly pdf: PDFDocument,
    private readonly fonts: readonly Loaded[],
  ) {}

  static async load(pdf: PDFDocument): Promise<FontSet> {
    pdf.registerFontkit(evenGlyphFontkit);
    const fonts: Loaded[] = [];
    for (const font of CHAIN) {
      const bytes = readFileSync(fontPath(font, 400));
      // fontkit is asked directly what the file covers, rather than this file
      // carrying a table of Unicode ranges that would drift from the fonts the
      // day they are updated.
      const probe = fontkit.create(bytes) as unknown as {
        hasGlyphForCodePoint: (c: number) => boolean;
      };
      const loaded: Loaded = {
        font,
        regularBytes: bytes,
        covers: (c) => probe.hasGlyphForCodePoint(c),
        embedded: null,
      };
      if (!font.onDemand) await embed(pdf, loaded);
      fonts.push(loaded);
    }
    return new FontSet(pdf, fonts);
  }

  /** Whether ANY font in the chain can draw this character. What the renderer's
   *  guard asks, so the refusal is derived from the fonts actually loaded rather
   *  than from a hardcoded range that would lie the moment the chain changes. */
  canRender(codePoint: number): boolean {
    return isStyleSelector(codePoint) || this.fonts.some((f) => f.covers(codePoint));
  }

  /**
   * Embed the on-demand fonts these characters resolve to: every character the
   * document will draw, which is what the renderer's guard has just walked.
   *
   * In chain order, not the order the characters arrive in, so one document
   * always embeds its fonts in one order and its bytes stay a pure function of
   * its content.
   */
  async prepare(codePoints: Iterable<number>): Promise<void> {
    const needed = new Set<number>();
    for (const c of codePoints) {
      if (isStyleSelector(c)) continue;
      const index = this.fonts.findIndex((f) => f.covers(c));
      if (index >= 0) needed.add(index);
    }
    for (const [index, f] of this.fonts.entries()) {
      if (needed.has(index) && f.embedded === null) await embed(this.pdf, f);
    }
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
      if (isStyleSelector(code)) continue;
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
    // Reachable only by a string the renderer draws that `assertRenderable`
    // does not walk. Loud, because the quiet alternative is a missing glyph on
    // a client's document.
    if (f.embedded === null) {
      throw new Error(`${f.font.stem} was never prepared for this document: its text skipped the guard`);
    }
    return bold ? f.embedded.bold : f.embedded.regular;
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

async function embed(pdf: PDFDocument, f: Loaded): Promise<void> {
  const regular = await pdf.embedFont(f.regularBytes, { subset: true });
  f.embedded = {
    regular,
    // The 700 weight, not the 400 file a second time. Embedding the same bytes
    // twice would produce a "bold" that is visually identical to the body and a
    // document where nothing a reader should notice stands out. A font with no
    // 700 shares its one embedding rather than faking one.
    bold: f.font.hasBold
      ? await pdf.embedFont(readFileSync(fontPath(f.font, 700)), { subset: true })
      : regular,
  };
}
