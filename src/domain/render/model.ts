// What a document looks like, with nothing about PDFs (T3.8). Pure, stdlib only.
// Letters and invoicing each build a `RenderableDocument`; one renderer turns it into bytes.
// The renderer reads no database (a renderer holding repositories would duplicate two
// services' read logic, and the copy would drift unseen). Fonts, colours, margins and page
// size are the renderer's; this is only the STRUCTURE the business owns.

/** The firm's prose. Its line breaks are preserved: "under 1,000 entries; under 8 bank
 *  accounts" is what protects the firm in a dispute (G1.7). */
export interface Section {
  readonly heading: string | null;
  readonly paragraphs: readonly string[];
}

export type Align = "left" | "right";

export interface Column {
  readonly label: string;
  readonly align: Align;
  /** A width weight, normalised by the renderer: proportions, not points. */
  readonly weight: number;
}

export interface LineTable {
  readonly columns: readonly Column[];
  /** Already formatted. Money is a decimal STRING the caller formatted: the renderer
   *  never makes an amount a number, and only the caller knows the currency. */
  readonly rows: readonly (readonly string[])[];
  /** Per-row `Anchor`, by position in `rows`. Never drawn. */
  readonly rowAnchors?: readonly (Anchor | null)[] | undefined;
  /** Keep on one page when it fits (CA#60, audit 2026-10-03), so a Summary of Fees never
   *  starts with one row at a page foot. Longer tables still break, header repeated.
   *  Absent: breaks wherever the page ends, as every document already out was drawn. */
  readonly keepTogether?: boolean | undefined;
  /** Lines of following flow kept with the table (the Summary of Fees total). Only with `keepTogether`. */
  readonly keepWithNextLines?: number | undefined;
}

/**
 * Which piece of the record a drawn thing prints (`proposal.background`, `line:<id>.scope`,
 * `block:<id>`, `fee:line:<id>`), so a screen can locate it on the PDF and open its editor.
 * NEVER DRAWN: `renderWithAnchors` reports positions as a side output of the same pass, and
 * a test proves by hash the bytes are identical either way.
 */
export type Anchor = string;

/** One rectangle per page an anchored piece touched, in PDF points from the page's
 *  TOP-LEFT (as a screen measures), the union of its text lines. `page` counts from 1. */
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
  /** Address, registration number, GSTIN: one per line, in the order given. */
  readonly lines: readonly string[];
}

/** A raster image the document carries: the firm's logo or a signature. */
export interface RenderableImage {
  readonly bytes: Uint8Array;
  /** Only what the renderer can decode; the caller refuses anything else, never drops it silently. */
  readonly mediaType: "image/png" | "image/jpeg";
}

/** What the renderer can embed. Exported so upload refuses a logo or signature at the door,
 *  telling the person who chose it. Keep in step with `RenderableImage["mediaType"]`. */
export const DRAWABLE_IMAGE_MEDIA_TYPES: readonly RenderableImage["mediaType"][] = [
  "image/png",
  "image/jpeg",
];

/** The one guard both the upload path and the render source ask, so they cannot drift. */
export function isDrawableImage(mediaType: string): mediaType is RenderableImage["mediaType"] {
  return (DRAWABLE_IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType);
}

/**
 * Where the e-sign provider puts the client's signature and date. DocuSign places a field
 * by searching the PDF's TEXT, so the renderer prints these in the page colour (invisible).
 * One constant shared by the letter's render source and the DocuSign adapter: a mismatch
 * sends an envelope with nowhere to sign. Text no letter contains, because a field lands
 * at EVERY match.
 */
export const CLIENT_SIGN_ANCHOR = "/bib-client-sign/";
export const CLIENT_DATE_ANCHOR = "/bib-client-date/";

/** One party's signature block. A letter carries the firm's (snapshotted at send) and the client's. */
export interface SignatureBlock {
  /** "For Cobalt Foods Private Limited". */
  readonly heading: string;
  /** Printed under the signature line: a name, a capacity. */
  readonly lines: readonly string[];
  /**
   * The firm's signature image drawn ON the line. On the block, not the document, so the
   * type keeps it off the CLIENT's block: a mark on a line the client has not signed is
   * forgery, and the provider stamps that line itself. Null is ordinary (no upload, or a
   * letter issued before the mark was pinned): the bare rule.
   */
  readonly image?: RenderableImage | null | undefined;
  /** Invisible text on the line for a provider to find. Null on the firm's block (signed by sending). */
  readonly signAnchor: string | null;
  /** The same, beside "Date". */
  readonly dateAnchor: string | null;
}

// The Annexure letter (0083): a cover letter on page one, then Annexure 1 (scope,
// deliverables and fees) and Annexure 2 (the terms), each on its own page. Structure only.

/**
 * One piece of an annexure's running text, in order. Heading LEVEL is outline, never size:
 * 1 = an annexure section ("B. Ongoing recurring services"), 2 = a service ("B1. Accounting
 * / CAS"), 3 = a labelled part ("Exclusions"). A paragraph keeps the firm's line breaks;
 * a line starting "- ", "• " or "* " is a bullet.
 */
export type Flow = (
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3; readonly text: string }
  | {
      readonly kind: "paragraph";
      readonly text: string;
      readonly muted?: boolean | undefined;
      /** A label run into the first line in heading weight, read as part of the sentence:
       *  the proposal's "Fees H3: INR 50,000 Yearly" (0084). */
      readonly lead?: string | undefined;
    }
  | { readonly kind: "table"; readonly table: LineTable }
  | { readonly kind: "figures"; readonly rows: readonly TotalRow[] }
) & {
  /** See `Anchor`. Never drawn. */
  readonly anchor?: Anchor | undefined;
};

export interface Annexure {
  /** "Annexure 1". */
  readonly label: string;
  /** "Scope of Services, Deliverables & Fees". */
  readonly title: string;
  readonly flow: readonly Flow[];
}

/** Page one: the firm's letter to the client, with both signatures. */
export interface CoverLetter {
  readonly dateLine: string;
  /** The person, then the organization, one per line. */
  readonly addressee: readonly string[];
  readonly subject: string;
  readonly salutation: string;
  readonly body: readonly Flow[];
  readonly closing: string;
  /** The firm's block, once the letter has gone out carrying one. */
  readonly firm: SignatureBlock | null;
  readonly acceptanceHeading: string;
  /** The firm's own acceptance paragraphs. */
  readonly acceptance: readonly Flow[];
  readonly client: SignatureBlock;
  /** See `Anchor`. */
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

// The proposal (0084), the firm's "Proposal For Services": a full-page artwork COVER with
// prepared-for and prepared-by printed over it, then the proposal under the firm's logo.
// Where the names sit, sizes and heading colours are the renderer's.

/** One line of a name block on the cover. */
export interface CoverLine {
  readonly text: string;
  /** A name is bold; an address or an email is not. */
  readonly bold: boolean;
}

export interface ProposalCover {
  /** The issuing entity's brand asset `proposal_cover`, over the whole first page. Null is
   *  ordinary: the renderer draws a plain cover headed with `title`. */
  readonly artwork: RenderableImage | null;
  /** "Proposal for Services"; printed only on a plain cover (artwork carries its own). */
  readonly title: string;
  /** Printed under the title on a plain cover: the proposal's own title. */
  readonly subtitle: string;
  /** "Prepared for:" the person, then the client. */
  readonly preparedFor: readonly CoverLine[];
  /** "Prepared by:" the colleague, the firm's company, the email. */
  readonly preparedBy: readonly CoverLine[];
  /** See `Anchor`. */
  readonly anchors?: {
    readonly subtitle?: Anchor | undefined;
    readonly preparedFor?: Anchor | undefined;
    readonly preparedBy?: Anchor | undefined;
  } | undefined;
}

export interface ProposalDocument {
  readonly cover: ProposalCover;
  /** Opposite the logo on every page after the cover: the reference and the date. */
  readonly running: string;
  readonly flow: readonly Flow[];
  /** The issuing company's letterhead (CA#18, audit 2026-10-03): address, contacts and
   *  registration numbers at the foot of every page after the cover, one per line. Absent
   *  or empty draws nothing. */
  readonly letterhead?: readonly string[] | undefined;
}

/** What a GST invoice draws after its total in words (Q056). */
export interface TaxInvoicePrint {
  /** "Tax amount in words": Indian Rupees One Thousand Eight Hundred Only. */
  readonly taxInWords: string | null;
  readonly summary: LineTable;
  /** Reverse charge, the LUT declaration, the tax in INR on a foreign invoice. */
  readonly declarations: readonly string[];
  /** Where to pay, one line each; empty draws no block. */
  readonly bank: readonly string[];
  /** "For 10x Global Advisory Private Limited". */
  readonly signatoryFor: string;
}

export interface RenderableDocument {
  /** "Engagement Letter", "Tax Invoice". */
  readonly documentTitle: string;
  /** Printed prominently: it is how a client refers to the document on the phone. */
  readonly reference: string;
  // Each optional field is absent on the documents that predate or lack it, so their bytes do not move.
  /** Printed under the reference: "Original for recipient" on a GST tax invoice (Rule 48:
   *  services are invoiced in duplicate; the supplier's copy is BiB's copy of record). */
  readonly copyMark?: string | undefined;
  readonly issuer: RenderableParty;
  readonly recipient: RenderableParty;
  readonly recipientLabel: string;
  readonly meta: readonly MetaRow[];
  readonly sections: readonly Section[];
  readonly table: LineTable | null;
  readonly totals: readonly TotalRow[];
  /** The total in words under the totals (B12 / CA#1, audit 2026-10-03): "Indian Rupees
   *  Five Thousand Nine Hundred Only". */
  readonly amountInWords?: string | undefined;
  /** A GST tax invoice's block after the total in words (Q056, S5): tax in words, SAC-wise
   *  summary, reverse-charge and LUT declarations, bank details, signatory line. Absent on
   *  a plain invoice and one from before 0370. */
  readonly taxInvoice?: TaxInvoicePrint | undefined;
  /**
   * An engagement letter's pinned clauses. Not merged into `sections` because they print
   * elsewhere: `sections` (prose about the work) runs before the fee table; terms come after
   * the commercials, immediately before the signatures. Absent on an invoice.
   */
  readonly terms?: readonly Section[] | undefined;
  readonly footer: string | null;
  /** Signature blocks after the totals. Absent on a document nobody signs (an invoice). */
  readonly signatures?: readonly SignatureBlock[] | undefined;
  /** The firm's Annexure format (0083). When present the document IS this, and `sections`,
   *  `table`, `totals`, `terms` and `signatures` are not drawn (the source leaves them
   *  empty). Absent on classic letters and invoices. */
  readonly annexureLetter?: AnnexureLetter | undefined;
  /** The proposal (0084). When present the document IS this: cover and flow, nothing else. */
  readonly proposal?: ProposalDocument | undefined;
  readonly logo: RenderableImage | null;
  /**
   * When the document was ISSUED, an ISO date. Load-bearing for determinism: the PDF's
   * creation timestamp comes from here, never a clock, so re-rendering gives the same bytes
   * and the same content hash.
   */
  readonly issuedOn: string;
}

/**
 * Wrap a paragraph to a width. In the domain because it is the one layout piece testable
 * without a PDF, and a mistake is invisible in a byte comparison but obvious to a client.
 * `measure` is injected to keep it pure. A word longer than the line overflows rather than
 * break: those are reference numbers and GSTINs, unusable hyphenated.
 */
export function wrapParagraph(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
): readonly string[] {
  const out: string[] = [];
  // Wrapped between the firm's own line breaks, never across them.
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
