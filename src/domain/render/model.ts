// What a document LOOKS LIKE, described without saying anything about PDFs
// (T3.8). Pure — stdlib only.
//
// THIS TYPE IS THE WHOLE POINT OF THE TASK'S DECOMPOSITION. The renderer must
// not read the database and the modules that hold the data must not know what a
// PDF is, so they meet here: engagement letters and invoicing each build a
// `RenderableDocument`, and one renderer turns it into bytes.
//
// The alternative — a renderer holding repositories — was considered and is
// worse in a specific way rather than merely inelegant: it would duplicate read
// logic that already exists in two services, and the duplicate would be the one
// that drifts, because nothing renders often enough for anyone to notice.
//
// ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
//
// No fonts, no colours, no margins, no page size. Those are the RENDERER's, and
// putting them here would mean a firm's engagement letter module had opinions
// about typography. What is here is the document's STRUCTURE — what it says and
// in what order — which is the part the business owns.

/** A block of the firm's own prose. Line breaks inside a paragraph are the
 *  firm's and are preserved: "under 1,000 entries; under 8 bank accounts" is
 *  what protects the firm in a dispute (G1.7). */
export interface Section {
  readonly heading: string | null;
  readonly paragraphs: readonly string[];
}

export type Align = "left" | "right";

export interface Column {
  readonly label: string;
  readonly align: Align;
  /** Share of the table's width, as a weight. Normalised by the renderer, so
   *  these are proportions and not points — the business does not know how wide
   *  the page is. */
  readonly weight: number;
}

export interface LineTable {
  readonly columns: readonly Column[];
  /** Already formatted. Money arrives as a decimal STRING the caller has
   *  formatted, because the renderer must never turn an amount into a number
   *  and the caller is the only thing that knows the currency. */
  readonly rows: readonly (readonly string[])[];
}

/** A label/value pair at the head of the document — reference, date, whose law. */
export interface MetaRow {
  readonly label: string;
  readonly value: string;
}

/** A total under the table. `emphasis` is the one the eye should land on. */
export interface TotalRow {
  readonly label: string;
  readonly value: string;
  readonly emphasis: boolean;
}

export interface RenderableParty {
  readonly name: string;
  /** Address, registration number, GSTIN — whatever the document should show
   *  under the name. Each on its own line, in the order given. */
  readonly lines: readonly string[];
}

/** A raster image the document carries — the firm's logo or a signature. */
export interface RenderableImage {
  readonly bytes: Uint8Array;
  /** Only what the renderer can actually decode. Anything else is refused by
   *  the caller rather than silently dropped. */
  readonly mediaType: "image/png" | "image/jpeg";
}

/**
 * What the renderer can actually embed, as a list rather than as two string
 * comparisons repeated in three files.
 *
 * Exported because the DOOR needs it: a logo or a signature is refused at upload
 * against this, so the person who chose the file is the one told about it. Keep
 * it and `RenderableImage["mediaType"]` in step — the type is what the renderer
 * is held to, and this is the same statement in a form a caller can check.
 */
export const DRAWABLE_IMAGE_MEDIA_TYPES: readonly RenderableImage["mediaType"][] = [
  "image/png",
  "image/jpeg",
];

/** Whether the renderer could draw bytes of this type — the guard the upload
 *  path and the render source both ask, so they cannot drift apart. */
export function isDrawableImage(mediaType: string): mediaType is RenderableImage["mediaType"] {
  return (DRAWABLE_IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType);
}

/**
 * Where an e-signature provider puts the client's signature and the date.
 *
 * DocuSign places a field by searching the PDF's TEXT for a string (an anchor),
 * so the renderer prints these in the page colour where the signature goes.
 * Invisible on paper, found by the provider. Declared here, in the one module
 * both the letter's render source and the DocuSign adapter import, so the
 * string printed and the string searched for are the same constant — a
 * mismatch would send the client an envelope with nowhere to sign.
 *
 * Deliberately text no letter would ever contain: the provider places a field
 * at EVERY match, and a real sentence matching would put a signature box in
 * the middle of a clause.
 */
export const CLIENT_SIGN_ANCHOR = "/bib-client-sign/";
export const CLIENT_DATE_ANCHOR = "/bib-client-date/";

/**
 * One party's signature block: who signs for whom, and what goes under the
 * line. A letter carries the firm's (snapshotted when it was sent) and the
 * client's.
 */
export interface SignatureBlock {
  /** "For Cobalt Foods Private Limited". */
  readonly heading: string;
  /** Printed under the signature line — a name, a capacity. */
  readonly lines: readonly string[];
  /**
   * The mark drawn ON the signature line — the firm's signature image.
   *
   * ON THE BLOCK AND NOT ON THE DOCUMENT, deliberately. A document-level
   * `signature` field beside `logo` would be reachable from either block, and
   * the block it must never reach is the CLIENT's: drawing a mark on the line a
   * client has not signed is forgery, and the provider stamps that line itself.
   * Here the type says which half may carry one, so the answer cannot be got
   * wrong by a later edit to the render source.
   *
   * Null is ordinary — a firm that has uploaded no signature, and every letter
   * issued before the mark was pinned, get the bare rule they already had.
   */
  readonly image?: RenderableImage | null | undefined;
  /** Invisible text on the signature line, for a provider to find. Null on a
   *  block nobody will sign electronically — the firm's, which it signed by
   *  sending. */
  readonly signAnchor: string | null;
  /** The same, beside "Date". */
  readonly dateAnchor: string | null;
}

export interface RenderableDocument {
  /** "Engagement Letter", "Tax Invoice" — what the page is headed. */
  readonly documentTitle: string;
  /** The firm's own reference. Printed prominently: it is how a client refers
   *  to this document on the phone. */
  readonly reference: string;
  readonly issuer: RenderableParty;
  readonly recipient: RenderableParty;
  readonly recipientLabel: string;
  readonly meta: readonly MetaRow[];
  readonly sections: readonly Section[];
  readonly table: LineTable | null;
  readonly totals: readonly TotalRow[];
  /**
   * The agreement's TERMS — an engagement letter's pinned clauses.
   *
   * Separate from `sections` and not merged into it, because they print in a
   * different PLACE: `sections` is the firm's prose about the work and runs
   * before the fee table, and terms are what both sides are bound to, which on
   * every engagement letter ever written comes after the commercials and
   * immediately before the signatures. One array could not say both.
   *
   * Optional, so a document with no terms — an invoice — draws nothing here and
   * its bytes do not move.
   */
  readonly terms?: readonly Section[] | undefined;
  readonly footer: string | null;
  /** Signature blocks after the totals. Absent on a document nobody signs —
   *  an invoice — and then nothing is drawn, so its bytes do not move. */
  readonly signatures?: readonly SignatureBlock[] | undefined;
  readonly logo: RenderableImage | null;
  /**
   * The instant the document was ISSUED, as an ISO date.
   *
   * Load-bearing for determinism, not decoration. A PDF carries a creation
   * timestamp in its metadata; if the renderer used a clock, re-rendering the
   * same letter would produce different bytes and therefore a different content
   * hash — which would break the one thing this document's hash is for. So the
   * date comes from the DOCUMENT, and rendering is a pure function of this
   * structure.
   */
  readonly issuedOn: string;
}

/**
 * Break a paragraph into lines that fit a width.
 *
 * In the domain rather than the renderer because it is the one piece of layout
 * that is testable without a PDF, and because getting it wrong is invisible in
 * a byte comparison and obvious to a client. `measure` is injected so this stays
 * pure: the renderer knows what a font is, this knows what a line is.
 *
 * A word longer than the whole line is NOT broken mid-word — it overflows. That
 * is deliberate: the things that are too long here are reference numbers and
 * GSTINs, and hyphenating one produces a document a client cannot use.
 */
export function wrapParagraph(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
): readonly string[] {
  const out: string[] = [];
  // The firm's own line breaks survive — a paragraph is wrapped between them,
  // never across them.
  for (const hard of text.split("\n")) {
    const words = hard.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line === "" ? word : `${line} ${word}`;
      if (line !== "" && measure(candidate) > maxWidth) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out;
}
