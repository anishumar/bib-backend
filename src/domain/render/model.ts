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
  /** Which piece of the record each row prints, by the same position as
   *  `rows` — see `Anchor`. Never drawn. */
  readonly rowAnchors?: readonly (Anchor | null)[] | undefined;
  /**
   * Kept on ONE page when it fits on one (CA#60, audit 2026-10-03): a Summary
   * of Fees that would start at the foot of a page with one row on it starts
   * on the next page instead. A table longer than a page still breaks, with
   * its header repeated. Absent, the table breaks wherever the page ends, as
   * every document already out was drawn.
   */
  readonly keepTogether?: boolean | undefined;
  /** How many lines of the flow after the table to keep with it (the total
   *  under a Summary of Fees). Only with `keepTogether`. */
  readonly keepWithNextLines?: number | undefined;
}

/**
 * WHICH PIECE OF THE RECORD a drawn thing prints — `proposal.background`,
 * `line:<id>.scope`, `block:<id>`, `fee:line:<id>` — so a screen showing the
 * PDF can say where on the page that piece sits, and open its editor there.
 *
 * NEVER DRAWN, and that is the whole contract. The renderer reports where it
 * drew an anchored piece only when asked (`renderWithAnchors`), as a side
 * output of the same pass; the bytes are the same either way, which a test
 * proves by hash. An anchor is a key a screen understands, not a word on paper.
 */
export type Anchor = string;

/**
 * Where an anchored piece was drawn: one rectangle per page it touched, in
 * PDF points from the page's TOP-LEFT corner (the way a screen measures), the
 * union of every line of text drawn for it on that page. `page` counts from 1.
 */
export interface PlacedAnchor {
  readonly key: Anchor;
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
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

// ── The Annexure letter (0083) ───────────────────────────────────────────────
//
// The firm's own engagement-letter format: a cover letter on page one, then
// Annexure 1 (scope, deliverables and fees) and Annexure 2 (the terms), each on
// a page of its own. Still STRUCTURE only — which headings, which paragraphs, in
// what order — and nothing about how big anything is.

/**
 * One piece of an annexure's running text, drawn in order.
 *
 * A heading's LEVEL is its place in the document's outline — 1 is a section of
 * an annexure ("B. Ongoing recurring services"), 2 is one service inside it
 * ("B1. Accounting / CAS"), 3 is a labelled part of one ("Exclusions") — never a
 * size. A paragraph keeps the firm's own line breaks, and a line that starts
 * with "- ", "• " or "* " is a bullet.
 */
export type Flow = (
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3; readonly text: string }
  | {
      readonly kind: "paragraph";
      readonly text: string;
      readonly muted?: boolean | undefined;
      /**
       * A LABEL run into the paragraph's first line in the heading weight —
       * the proposal's "Fees H3: INR 50,000 Yearly" (0084). A label and not a
       * heading, because it is read as part of the sentence it starts.
       */
      readonly lead?: string | undefined;
    }
  | { readonly kind: "table"; readonly table: LineTable }
  | { readonly kind: "figures"; readonly rows: readonly TotalRow[] }
) & {
  /** The piece of the record this prints, for a screen — never drawn. */
  readonly anchor?: Anchor | undefined;
};

export interface Annexure {
  /** "Annexure 1". */
  readonly label: string;
  /** "Scope of Services, Deliverables & Fees". */
  readonly title: string;
  readonly flow: readonly Flow[];
}

/** Page one: a letter, from the firm to the client, with both signatures. */
export interface CoverLetter {
  readonly dateLine: string;
  /** The person, then the organization, one per line. */
  readonly addressee: readonly string[];
  readonly subject: string;
  readonly salutation: string;
  /** The firm's own cover paragraphs. */
  readonly body: readonly Flow[];
  readonly closing: string;
  /** The firm's block, once the letter has gone out carrying one. */
  readonly firm: SignatureBlock | null;
  readonly acceptanceHeading: string;
  /** What the client accepts under — the firm's own acceptance paragraphs. */
  readonly acceptance: readonly Flow[];
  readonly client: SignatureBlock;
  /** Which piece of the letter each head line prints — see `Anchor`. */
  readonly anchors?: {
    readonly date?: Anchor | undefined;
    readonly addressee?: Anchor | undefined;
    readonly subject?: Anchor | undefined;
    readonly salutation?: Anchor | undefined;
  } | undefined;
}

export interface AnnexureLetter {
  readonly cover: CoverLetter;
  readonly annexures: readonly Annexure[];
}

// ── The proposal (0084) ─────────────────────────────────────────────────────
//
// The firm's "Proposal For Services": a COVER — the firm's own artwork, full
// page, with who it is prepared for and by printed over it — then the proposal
// itself under the firm's logo. Still structure only: WHERE on the artwork the
// two names go, how big anything is and what colour a heading takes are the
// renderer's.

/** One line of a name block on the cover. */
export interface CoverLine {
  readonly text: string;
  /** A name is bold; an address or an email is not. */
  readonly bold: boolean;
}

export interface ProposalCover {
  /**
   * The issuing entity's cover artwork (brand asset `proposal_cover`), drawn
   * over the whole first page. Null is ordinary — a firm that has uploaded
   * none gets a plain cover the renderer draws, headed with `title`.
   */
  readonly artwork: RenderableImage | null;
  /** What a plain cover is headed — "Proposal for Services". The artwork
   *  carries its own, so this prints only without one. */
  readonly title: string;
  /** Printed under the title on a plain cover: the proposal's own title. */
  readonly subtitle: string;
  /** "Prepared for:" — the person, then the client. */
  readonly preparedFor: readonly CoverLine[];
  /** "Prepared by:" — the colleague, the firm's company, the email. */
  readonly preparedBy: readonly CoverLine[];
  /** Which piece of the proposal each cover block prints — see `Anchor`. */
  readonly anchors?: {
    readonly subtitle?: Anchor | undefined;
    readonly preparedFor?: Anchor | undefined;
    readonly preparedBy?: Anchor | undefined;
  } | undefined;
}

export interface ProposalDocument {
  readonly cover: ProposalCover;
  /** The small line opposite the logo on every page after the cover — the
   *  reference and the date, which is how a client refers to it. */
  readonly running: string;
  readonly flow: readonly Flow[];
  /**
   * The issuing company's letterhead (CA#18, audit 2026-10-03): its address,
   * how to reach it and its registration numbers, at the foot of every page
   * after the cover, one entry per line. Absent or empty, nothing is drawn.
   */
  readonly letterhead?: readonly string[] | undefined;
}

/** The block a GST invoice draws after its totals (Q056: drawn after the total in words). */
export interface TaxInvoicePrint {
  /** "Tax amount in words": Indian Rupees One Thousand Eight Hundred Only. */
  readonly taxInWords: string | null;
  /** The SAC-wise tax summary. */
  readonly summary: LineTable;
  /** Reverse charge, the LUT declaration, the tax in INR on a foreign invoice. */
  readonly declarations: readonly string[];
  /** Where to pay, one line each; empty draws no block. */
  readonly bank: readonly string[];
  /** "For 10x Global Advisory Private Limited". */
  readonly signatoryFor: string;
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
   * The emphasised total in words, printed under the totals (B12 / CA#1, audit
   * 2026-10-03): "Indian Rupees Five Thousand Nine Hundred Only". Absent on
   * every document drawn before it, whose bytes therefore do not move.
   */
  readonly amountInWords?: string | undefined;
  /**
   * What a GST tax invoice prints after its total in words (Q056, S5): the tax
   * in words, the SAC-wise tax summary, the reverse-charge and LUT
   * declarations, the bank details and the signatory line. Absent on every
   * other document, and on an invoice from before 0370 or a plain one, whose
   * bytes therefore do not move.
   */
  readonly taxInvoice?: TaxInvoicePrint | undefined;
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
  /**
   * The letter in the firm's Annexure format (0083) — when present, the
   * document IS this: a cover letter and its annexures are drawn, and
   * `sections`, `table`, `totals`, `terms` and `signatures` are not (the source
   * leaves them empty). Absent on every classic letter and every invoice, whose
   * bytes therefore do not move.
   */
  readonly annexureLetter?: AnnexureLetter | undefined;
  /**
   * The proposal (0084) — when present, the document IS this: a cover and the
   * proposal's flow, and nothing else is drawn. Absent on every letter and
   * invoice, whose bytes therefore do not move.
   */
  readonly proposal?: ProposalDocument | undefined;
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
