// The renderer's fonts and the fallback chain between them (T3.9). Built-in PDF fonts are
// Latin-1 only (no rupee sign, no Devanagari client names), and no single file covers what
// we need. Measured with `hasGlyphForCodePoint`:
//   latin       basic range, em dash; NO rupee sign
//   latin-ext   rupee sign, Polish, ruble; NOT the basic range
//   devanagari  Devanagari, rupee sign
//   math        ≤ ≥ ≠ ≈, arrows, ✓, box and geometric shapes
//   symbols-2   ✔ ✗ ☐ ⚠ and the other dingbats
// So text is segmented into runs, each drawn by the first font that can (as a browser does).
// Noto Sans, SIL OFL 1.1 (permits embedding and redistribution), from npm
// (`@fontsource/noto-sans`), never a committed binary. `subset: true` embeds only used glyphs.
// Math and Symbols 2 are ON DEMAND (QA 2026-09-29: the standard service template writes
// "≤1,000 entries" and every proposal quoting it was refused). Always embedding them would
// change the bytes of letters issued before them (layout.test.ts pins those hashes), so `load`
// only probes coverage and `prepare` embeds one when a drawn character needs it.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
// Load-bearing shim: `@pdf-lib/fontkit` is a UMD bundle compiled with regenerator but shipped
// without its runtime, so it throws `regeneratorRuntime is not defined` on fonts with complex
// shaping tables (Devanagari, not Latin). `fontkit` 2.x is no substitute: it changed the subset
// API pdf-lib 1.x calls (`subset.encodeStream is not a function`).
import "regenerator-runtime/runtime.js";
import fontkit from "@pdf-lib/fontkit";
import type { PDFDocument, PDFFont } from "pdf-lib";

// Upstream subsetter defect that draws NOTHING rather than throwing. Under 64 KB
// `@pdf-lib/fontkit` writes the SHORT loca format (offsets halved, `offsets[i] >>>= 1`) without
// padding glyphs to even length, so FreeType (Chrome, MuPDF) draws glyphs after an odd-length
// one as blank. The Noto text fonts are all even; Math and Symbols 2 have 1000+ odd glyphs each
// (≠ → ✔ ✗ ☐ ⚠ came out blank). Fix: one zero pad byte after an odd glyph, by wrapping each
// subset THIS module's fonts create (not the library prototype). Even-only fonts get an
// identical subset, so text-only documents keep their bytes.
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
      // The bundle's own Buffer class: its stream refuses Node's ("Invalid non-string/buffer chunk").
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
  readonly pkg: string;
  /** The file name before `-<weight>-normal.woff`. */
  readonly stem: string;
  /** Math and Symbols 2 have no 700, so a symbol in a bold heading draws regular. */
  readonly hasBold: boolean;
  /** Embedded only when a document uses it (see the file header). */
  readonly onDemand: boolean;
}

/** Priority order. `latin` first (nearly every character resolves there); symbol fonts last,
 *  Math before Symbols 2 since it also carries → and ✓ and one font for both reads evenly. */
const CHAIN: readonly ChainFont[] = [
  { pkg: "@fontsource/noto-sans", stem: "noto-sans-latin", hasBold: true, onDemand: false },
  { pkg: "@fontsource/noto-sans", stem: "noto-sans-latin-ext", hasBold: true, onDemand: false },
  { pkg: "@fontsource/noto-sans", stem: "noto-sans-devanagari", hasBold: true, onDemand: false },
  { pkg: "@fontsource/noto-sans-math", stem: "noto-sans-math-latin", hasBold: false, onDemand: true },
  { pkg: "@fontsource/noto-sans-symbols-2", stem: "noto-sans-symbols-2-symbols", hasBold: false, onDemand: true },
];

/** U+FE0E/U+FE0F only pick plain or colour style for the sign before them (a phone types
 *  "⚠" + U+FE0F). Skipped, not refused: refusing would refuse a warning sign. */
function isStyleSelector(codePoint: number): boolean {
  return codePoint === 0xfe0e || codePoint === 0xfe0f;
}

const require = createRequire(import.meta.url);

function fontPath(font: ChainFont, weight: 400 | 700): string {
  // Via the package, not a node_modules path, so bundlers and hoisting still work.
  return require.resolve(`${font.pkg}/files/${font.stem}-${String(weight)}-normal.woff`);
}

interface Loaded {
  readonly font: ChainFont;
  readonly regularBytes: Uint8Array;
  readonly covers: (codePoint: number) => boolean;
  /** Null until embedded (for an on-demand font, until a drawn character needs it). */
  embedded: { readonly regular: PDFFont; readonly bold: PDFFont } | null;
}

/** One run of text that a single font can draw. */
export interface Run {
  readonly text: string;
  readonly fontIndex: number;
}

/** A document's fonts and fallback. One per render: pdf-lib embeds into one document, so a
 *  shared instance would leak glyphs between documents. */
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
      // Ask the file what it covers; a Unicode range table would drift when fonts update.
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

  /** Whether any loaded font can draw this. The renderer's guard asks this, not a hardcoded range. */
  canRender(codePoint: number): boolean {
    return isStyleSelector(codePoint) || this.fonts.some((f) => f.covers(codePoint));
  }

  /** Embed the on-demand fonts the document's characters (as walked by the guard) resolve
   *  to, in chain order so the bytes stay a pure function of content. */
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

  /** Split text into runs, one font each; same-font neighbours merge, so English is one run. */
  segment(text: string): readonly Run[] {
    const runs: Run[] = [];
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0;
      if (isStyleSelector(code)) continue;
      const index = this.fonts.findIndex((f) => f.covers(code));
      // -1 is unreachable (the guard runs first); fall back rather than throw mid-draw.
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
    // Only a drawn string `assertRenderable` skipped reaches this; loud beats a missing glyph.
    if (f.embedded === null) {
      throw new Error(`${f.font.stem} was never prepared for this document: its text skipped the guard`);
    }
    return bold ? f.embedded.bold : f.embedded.regular;
  }

  /** Width of text spanning several fonts, for wrapping and right-alignment. */
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
    // The real 700 file; a font without one shares its regular embedding, never a fake bold.
    bold: f.font.hasBold
      ? await pdf.embedFont(readFileSync(fontPath(f.font, 700)), { subset: true })
      : regular,
  };
}
