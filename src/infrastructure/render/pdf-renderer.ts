// The renderer registered today: pdf-lib, drawing the page directly (T3.8).
//
// ── WHY THIS ENGINE AND NOT A HEADLESS BROWSER ─────────────────────────────
//
// The obvious approach is HTML + CSS through Chromium, and it was rejected on
// one requirement that outranks fidelity here: **a rendered document's content
// hash is evidence.** `crm.engagement_letter.signed_content_hash` exists so that
// "is the file the client holds the one we issued" is a comparison rather than a
// matter of trust, and `files.document_version.content_hash` is what it compares
// against.
//
// A headless browser does not guarantee byte-identical output for identical
// input across versions — font hinting, image encoders and the PDF writer all
// move between Chromium releases. A firm would upgrade a base image and every
// re-render would stop matching, with nothing to say why. It also puts ~300 MB
// of browser in the container and a process to supervise.
//
// pdf-lib is pure JavaScript with four pure-JS dependencies and no native
// modules, and it draws exactly what it is told. The cost, stated rather than
// discovered: **layout is hand-built.** There is no CSS, no float, no automatic
// table. What is below is a small column-and-flow engine, and it is the honest
// price of a document whose bytes are reproducible.
//
// It is a one-file decision, behind `DocumentRenderer`. If a firm ever needs
// fidelity this cannot give, the replacement plugs in here and nothing above
// changes — but it would have to answer the determinism question first.
//
// ── DETERMINISM, AND THE TWO THINGS THAT BREAK IT ──────────────────────────
//
// pdf-lib writes CreationDate and ModDate into the document's metadata from the
// system clock by default. Left alone, rendering the same letter twice produces
// different bytes, and the whole argument above collapses. Both are pinned from
// the DOCUMENT's own issue date.
//
// It also writes a Producer string carrying its own version. Pinned too — an
// npm upgrade must not silently change every future document's hash while the
// content is identical.
//
// ── FONTS (T3.9) ───────────────────────────────────────────────────────────
//
// Noto Sans, embedded as a CHAIN of three subsets with fallback — see
// `font-set.ts` for why one font was not enough. The built-in PDF fonts this
// shipped on first covered Latin-1 and nothing else, which made the rupee sign
// undrawable in an Indian compliance product.
//
// Determinism survives it: the fonts are files on disk, embedded identically
// every time, and subsetting is a function of which glyphs the document uses.
// The test that renders twice a second apart covers this.
import { PDFDocument, rgb } from "pdf-lib";
import type { PDFImage, PDFPage } from "pdf-lib";
import { FontSet } from "./font-set";
import type {
  AnnexureLetter,
  CoverLine,
  Flow,
  LineTable,
  PlacedAnchor,
  ProposalDocument,
  RenderableDocument,
  RenderableImage,
  Section,
  SignatureBlock,
  TotalRow,
} from "../../domain/render/model";
import { wrapParagraph } from "../../domain/render/model";
import { UnrenderableText } from "../../domain/render/errors";
import type { DocumentRenderer, RenderedWithAnchors } from "../../usecase/render/ports";

// A4 in points, and the margins a business letter uses. Constants rather than
// configuration: a firm choosing its own page geometry is not a request anybody
// has made, and every one of these would have to be threaded through the
// document description to honour it.
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 56;
const MARGIN_TOP = 56;
const MARGIN_BOTTOM = 64;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;

const SIZE_TITLE = 18;
const SIZE_HEADING = 11;
const SIZE_BODY = 9.5;
const SIZE_SMALL = 8;
const LEADING = 1.45;
/** How tall a signature mark may be drawn. A real signature on paper is about
 *  the height of two lines of text; letting the uploaded file decide would put a
 *  1000px scan across half the page. */
const SIGNATURE_MAX_HEIGHT = 30;

const INK = rgb(0.11, 0.12, 0.14);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.85, 0.87, 0.9);
/** The page colour. Used for exactly one thing: the anchors a signature
 *  provider searches for, which must be in the text and must not be seen. */
const PAPER = rgb(1, 1, 1);

/** How far a bulleted line's text sits from the margin, and where its bullet
 *  is drawn inside that — the firm's scope blocks are written as lists. */
const BULLET_INDENT = 12;
/** What a paragraph line has to start with to be drawn as a bullet: the three
 *  marks people type, and the en dash Word turns a hyphen into. */
const BULLET = /^\s*[-*\u2022\u2013]\s+/;

/** The proposal's section headings (0084) — the deep red of the firm's
 *  template. A property of the proposal LAYOUT, like its sizes, not of any
 *  one firm's data. */
const ACCENT = rgb(0.639, 0.067, 0.204);
/** Text drawn over the cover artwork's dark band — "Prepared by". */
const ON_ARTWORK = rgb(1, 1, 1);

/**
 * WHERE on the cover artwork the two name blocks go, as fractions of the
 * artwork's own width and height — the positions in the firm's template
 * (10X Global's proposal, 2026). Relative to the ARTWORK rather than the page,
 * so they stay over the same part of the design however it is scaled: "Prepared
 * for" in the light area right of the upper photograph, "Prepared by" in white
 * on the block at the foot. An artwork designed for this cover leaves those two
 * places clear.
 */
const PREPARED_FOR_AT = { x: 0.616, y: 0.409 } as const;
const PREPARED_BY_AT = { x: 0.603, y: 0.779 } as const;

/** Where the header's logo sits on a proposal page, and where its text starts. */
const PROPOSAL_HEADER_TOP = 35;
const PROPOSAL_LOGO_MAX_HEIGHT = 20;
const PROPOSAL_BODY_TOP = 80;

interface Cursor {
  page: PDFPage;
  y: number;
  /**
   * How a page this cursor breaks onto is started. Absent — every letter and
   * invoice — it is a blank page with the text starting at the top margin,
   * exactly as it always was. The proposal's draws the logo and the running
   * line first (0084).
   */
  readonly turn?: ((cursor: Cursor) => void) | undefined;
}

/**
 * How running text is SET: its size, and how each level of heading looks. The
 * letter's is the constants this file always used, so an Annexure letter draws
 * byte for byte as before; the proposal's is larger and heads its sections in
 * the template's red (0084).
 */
interface FlowStyle {
  readonly body: number;
  readonly headings: Readonly<Record<1 | 2 | 3, { size: number; before: number; color: typeof INK }>>;
}

const LETTER_FLOW: FlowStyle = {
  body: SIZE_BODY,
  headings: {
    1: { size: SIZE_HEADING, before: 16, color: INK },
    2: { size: SIZE_BODY, before: 10, color: INK },
    3: { size: SIZE_BODY, before: 6, color: MUTED },
  },
};

const PROPOSAL_FLOW: FlowStyle = {
  body: 10,
  headings: {
    1: { size: 11, before: 16, color: ACCENT },
    2: { size: 10, before: 8, color: INK },
    3: { size: 10, before: 6, color: INK },
  },
};

/**
 * One weight of the chain, with the two operations the layout needs.
 *
 * It exists so the drawing code below reads exactly as it did when there was a
 * single `PDFFont` — `widthOfTextAtSize` and a draw — while underneath, text
 * that spans scripts is segmented and drawn run by run.
 */
class Face {
  constructor(
    private readonly fonts: FontSet,
    private readonly bold: boolean,
    /** Where anchored pieces land — null on every render that files a
     *  document, so those draw exactly as they always did. */
    private readonly tracker: AnchorTracker | null = null,
  ) {}

  widthOfTextAtSize(text: string, size: number): number {
    return this.fonts.widthOf(text, size, this.bold);
  }

  /** Draws left to right, advancing by each run's measured width. A document in
   *  one script is one run and one draw call. */
  draw(page: PDFPage, text: string, x: number, y: number, size: number, color: typeof INK): void {
    let cursorX = x;
    for (const run of this.fonts.segment(text)) {
      const font = this.fonts.font(run.fontIndex, this.bold);
      page.drawText(run.text, { x: cursorX, y, size, font, color });
      cursorX += font.widthOfTextAtSize(run.text, size);
    }
    // READ-ONLY: what was just drawn, measured. Nothing above changes with it.
    this.tracker?.touch(page, x, y, cursorX - x, size);
  }

  /** Everything drawn until `end` prints this piece of the record. */
  begin(anchor: string | undefined): void {
    this.tracker?.begin(anchor);
  }

  end(): void {
    this.tracker?.end();
  }

  /** Drawn but belonging to no piece — a page's running head, drawn while a
   *  paragraph breaks across the page. */
  quiet(draw: () => void): void {
    if (this.tracker === null) {
      draw();
      return;
    }
    this.tracker.pause();
    try {
      draw();
    } finally {
      this.tracker.resume();
    }
  }
}

/**
 * WHERE EACH ANCHORED PIECE WAS DRAWN (2026-09-28): the union of every line of
 * text drawn for it, per page. A side output of the one drawing pass — it
 * reads the coordinates the draw calls were given and writes nothing to the
 * document, so a render that collects them produces the same bytes as one that
 * does not (`tests/render/anchors.test.ts` hashes both).
 */
class AnchorTracker {
  /** Each piece being drawn, with its OCCURRENCE: one key drawn in two places
   *  (a fee's line and its Summary row) is two rectangles, never their union. */
  private readonly stack: ({ key: string; occurrence: number } | null)[] = [];
  private occurrences = 0;
  private paused = 0;
  /** In the order first drawn — the document's own order. */
  private readonly boxes = new Map<string, { key: string; page: number; x0: number; y0: number; x1: number; y1: number }>();

  constructor(private readonly pdf: PDFDocument) {}

  begin(anchor: string | undefined): void {
    this.occurrences += 1;
    this.stack.push(anchor === undefined || anchor === "" ? null : { key: anchor, occurrence: this.occurrences });
  }

  end(): void {
    this.stack.pop();
  }

  pause(): void {
    this.paused += 1;
  }

  resume(): void {
    this.paused -= 1;
  }

  touch(page: PDFPage, x: number, baseline: number, width: number, size: number): void {
    if (this.paused > 0) return;
    // The innermost piece being drawn owns the text.
    let open: { key: string; occurrence: number } | null = null;
    for (let i = this.stack.length - 1; i >= 0 && open === null; i -= 1) open = this.stack[i] ?? null;
    if (open === null) return;
    const key = open.key;
    const index = this.pdf.getPages().indexOf(page);
    if (index < 0) return;
    // A line's box from its ascent to its descent, in points from the TOP.
    const height = page.getHeight();
    const top = height - (baseline + size * 0.95);
    const bottom = height - (baseline - size * 0.3);
    const id = `${String(open.occurrence)}\u0000${String(index)}`;
    const box = this.boxes.get(id);
    if (box === undefined) {
      this.boxes.set(id, { key, page: index + 1, x0: x, y0: top, x1: x + width, y1: bottom });
      return;
    }
    box.x0 = Math.min(box.x0, x);
    box.y0 = Math.min(box.y0, top);
    box.x1 = Math.max(box.x1, x + width);
    box.y1 = Math.max(box.y1, bottom);
  }

  placed(): PlacedAnchor[] {
    const round = (n: number): number => Math.round(n * 100) / 100;
    return [...this.boxes.values()].map((b) => ({
      key: b.key,
      page: b.page,
      x: round(b.x0),
      y: round(b.y0),
      width: round(b.x1 - b.x0),
      height: round(b.y1 - b.y0),
    }));
  }
}

export class PdfLibRenderer implements DocumentRenderer {
  readonly kind = "pdf-lib";
  readonly mediaType = "application/pdf";

  async render(doc: RenderableDocument): Promise<Uint8Array> {
    return (await this.draw(doc, false)).bytes;
  }

  /** The same pass, reporting where each anchored piece landed. */
  async renderWithAnchors(doc: RenderableDocument): Promise<RenderedWithAnchors> {
    return this.draw(doc, true);
  }

  private async draw(doc: RenderableDocument, collect: boolean): Promise<RenderedWithAnchors> {
    // CHECKED UP FRONT, and this is deliberate. pdf-lib raises on the character
    // it cannot encode, deep inside a draw call, with a message naming neither
    // the field nor the document. Scanning first means the refusal says WHERE —
    // and it means a half-drawn page is never produced.
    const pdf = await PDFDocument.create();
    const tracker = collect ? new AnchorTracker(pdf) : null;
    const done = async (): Promise<RenderedWithAnchors> => ({
      bytes: await pdf.save(),
      anchors: tracker === null ? [] : tracker.placed(),
      pageCount: pdf.getPageCount(),
    });

    // ── The determinism block. See the file header. ──────────────────────
    // Parsed from the document's own issue date, at midday UTC so that a
    // timezone cannot move it across a date boundary and change the bytes.
    const issued = new Date(`${doc.issuedOn}T12:00:00.000Z`);
    pdf.setCreationDate(issued);
    pdf.setModificationDate(issued);
    pdf.setProducer("BiB");
    pdf.setCreator("BiB");
    pdf.setTitle(`${doc.documentTitle} ${doc.reference}`);

    // The font chain, loaded into THIS document. Fonts embed into a specific
    // PDF, so a shared instance would leak one document's glyph subset into
    // another's.
    const fonts = await FontSet.load(pdf);
    // CHECKED AGAINST THE FONTS ACTUALLY LOADED, not a hardcoded range. The
    // guard therefore cannot lie about what this renderer can draw, and it
    // narrows on its own the day the chain gains a script. It runs BEFORE
    // anything is drawn, so a half-page is never produced. What it walked is
    // every character the document draws, so it is also what decides which
    // of the on-demand symbol fonts this document embeds.
    await fonts.prepare(assertRenderable(doc, fonts));

    const body = new Face(fonts, false, tracker);
    const bold = new Face(fonts, true, tracker);

    // THE ANNEXURE LETTER (0083) draws pages of its own. Branching HERE — after
    // the setup every document shares and before the first classic draw — is
    // what keeps every classic letter and every invoice byte-identical: nothing
    // from this line down changes for them, and a letter issued before 0083
    // must re-render as the document its client holds.
    if (doc.annexureLetter !== undefined) {
      await this.drawAnnexureLetter(pdf, doc, doc.annexureLetter, body, bold);
      if (doc.footer !== null) body.quiet(() => { this.drawFooter(pdf, doc, body); });
      return done();
    }
    // THE PROPOSAL (0084), for the same reason and in the same place.
    if (doc.proposal !== undefined) {
      await this.drawProposal(pdf, doc, doc.proposal, body, bold);
      if (doc.footer !== null) body.quiet(() => { this.drawFooter(pdf, doc, body); });
      return done();
    }

    const cursor: Cursor = { page: pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]), y: 0 };
    cursor.y = PAGE_HEIGHT - MARGIN_TOP;

    await this.drawHead(pdf, cursor, doc, body, bold);
    this.drawParties(cursor, doc, body, bold, pdf);
    this.drawMeta(cursor, doc, body, bold, pdf);
    for (const section of doc.sections) this.drawSection(cursor, section, body, bold, pdf);
    if (doc.table !== null) this.drawTable(cursor, doc, body, bold, pdf);
    if (doc.totals.length > 0) this.drawTotals(cursor, doc, body, bold, pdf);
    // THE TERMS, after the commercials and before the signatures — where an
    // engagement letter has always put them, and where the client is reading
    // when they reach the line they sign on.
    for (const term of doc.terms ?? []) this.drawSection(cursor, term, body, bold, pdf);
    for (const block of doc.signatures ?? []) {
      await this.drawSignature(cursor, block, body, bold, pdf);
    }
    if (doc.footer !== null) this.drawFooter(pdf, doc, body);

    return done();
  }

  // ── Layout primitives ────────────────────────────────────────────────────

  /** Move down, starting a new page when the next block will not fit. */
  private advance(pdf: PDFDocument, cursor: Cursor, height: number): void {
    if (cursor.y - height < MARGIN_BOTTOM) this.newPage(pdf, cursor);
    cursor.y -= height;
  }

  /** Break onto a new page — the cursor's own way if it has one (0084). */
  private newPage(pdf: PDFDocument, cursor: Cursor): void {
    if (cursor.turn !== undefined) {
      cursor.turn(cursor);
      return;
    }
    cursor.page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    cursor.y = PAGE_HEIGHT - MARGIN_TOP;
  }

  private text(
    cursor: Cursor,
    value: string,
    opts: { x?: number; size?: number; font: Face; color?: typeof INK },
  ): void {
    opts.font.draw(
      cursor.page,
      value,
      opts.x ?? MARGIN_X,
      cursor.y,
      opts.size ?? SIZE_BODY,
      opts.color ?? INK,
    );
  }

  /** Right-aligned, which a money column needs and pdf-lib does not do. */
  private textRight(
    cursor: Cursor,
    value: string,
    right: number,
    opts: { size?: number; font: Face; color?: typeof INK },
  ): void {
    const size = opts.size ?? SIZE_BODY;
    const width = opts.font.widthOfTextAtSize(value, size);
    opts.font.draw(cursor.page, value, right - width, cursor.y, size, opts.color ?? INK);
  }

  private rule(pdf: PDFDocument, cursor: Cursor): void {
    this.advance(pdf, cursor, 10);
    cursor.page.drawLine({
      start: { x: MARGIN_X, y: cursor.y },
      end: { x: PAGE_WIDTH - MARGIN_X, y: cursor.y },
      thickness: 0.75,
      color: RULE,
    });
  }

  // ── Blocks ───────────────────────────────────────────────────────────────

  private async drawHead(
    pdf: PDFDocument,
    cursor: Cursor,
    doc: RenderableDocument,
    body: Face,
    bold: Face,
  ): Promise<void> {
    // The logo, when the firm has set one for this issuing entity. Absent is an
    // ordinary state and the document simply leads with its title — a firm that
    // has not uploaded a logo still gets a usable letter.
    if (doc.logo !== null) await this.drawLogo(pdf, cursor, doc.logo);

    this.advance(pdf, cursor, SIZE_TITLE);
    this.text(cursor, doc.documentTitle, { size: SIZE_TITLE, font: bold });
    this.textRight(cursor, doc.reference, PAGE_WIDTH - MARGIN_X, { size: SIZE_BODY, font: body, color: MUTED });
    this.rule(pdf, cursor);
  }

  /** The firm's mark at the head of page one — the classic head's and the
   *  Annexure letterhead's, drawn by one method so the two cannot drift. */
  private async drawLogo(pdf: PDFDocument, cursor: Cursor, logo: RenderableImage): Promise<void> {
    const image =
      logo.mediaType === "image/png" ? await pdf.embedPng(logo.bytes) : await pdf.embedJpg(logo.bytes);
    const maxH = 34;
    const scale = Math.min(maxH / image.height, 160 / image.width, 1);
    const w = image.width * scale;
    const h = image.height * scale;
    this.advance(pdf, cursor, h);
    cursor.page.drawImage(image, { x: MARGIN_X, y: cursor.y, width: w, height: h });
    this.advance(pdf, cursor, 14);
  }

  private drawParties(
    cursor: Cursor,
    doc: RenderableDocument,
    body: Face,
    bold: Face,
    pdf: PDFDocument,
  ): void {
    const rightX = MARGIN_X + CONTENT_WIDTH / 2;
    this.advance(pdf, cursor, 22);
    this.text(cursor, "From", { size: SIZE_SMALL, font: bold, color: MUTED });
    this.text(cursor, doc.recipientLabel, { x: rightX, size: SIZE_SMALL, font: bold, color: MUTED });

    this.advance(pdf, cursor, SIZE_BODY * LEADING);
    this.text(cursor, doc.issuer.name, { font: bold });
    this.text(cursor, doc.recipient.name, { x: rightX, font: bold });

    // Two columns advancing together, so the block is as tall as the longer of
    // the two rather than overlapping.
    const rows = Math.max(doc.issuer.lines.length, doc.recipient.lines.length);
    for (let i = 0; i < rows; i += 1) {
      this.advance(pdf, cursor, SIZE_BODY * LEADING);
      const left = doc.issuer.lines[i];
      const right = doc.recipient.lines[i];
      if (left !== undefined) this.text(cursor, left, { font: body, color: MUTED });
      if (right !== undefined) this.text(cursor, right, { x: rightX, font: body, color: MUTED });
    }
  }

  private drawMeta(
    cursor: Cursor,
    doc: RenderableDocument,
    body: Face,
    bold: Face,
    pdf: PDFDocument,
  ): void {
    if (doc.meta.length === 0) return;
    this.rule(pdf, cursor);
    this.advance(pdf, cursor, 18);
    let x = MARGIN_X;
    const per = CONTENT_WIDTH / doc.meta.length;
    for (const row of doc.meta) {
      bold.draw(cursor.page, row.label, x, cursor.y, SIZE_SMALL, MUTED);
      body.draw(cursor.page, row.value, x, cursor.y - SIZE_BODY * LEADING, SIZE_BODY, INK);
      x += per;
    }
    this.advance(pdf, cursor, SIZE_BODY * LEADING);
  }

  private drawSection(
    cursor: Cursor,
    section: Section,
    body: Face,
    bold: Face,
    pdf: PDFDocument,
  ): void {
    this.advance(pdf, cursor, 22);
    if (section.heading !== null) {
      this.text(cursor, section.heading, { size: SIZE_HEADING, font: bold });
      this.advance(pdf, cursor, SIZE_HEADING * LEADING);
    }
    for (const paragraph of section.paragraphs) {
      const lines = wrapParagraph(paragraph, CONTENT_WIDTH, (s) =>
        body.widthOfTextAtSize(s, SIZE_BODY),
      );
      for (const line of lines) {
        this.text(cursor, line, { font: body });
        this.advance(pdf, cursor, SIZE_BODY * LEADING);
      }
      this.advance(pdf, cursor, 6);
    }
  }

  private drawTable(
    cursor: Cursor,
    doc: RenderableDocument,
    body: Face,
    bold: Face,
    pdf: PDFDocument,
  ): void {
    const table = doc.table;
    if (table === null) return;

    const totalWeight = table.columns.reduce((n, c) => n + c.weight, 0);
    const widths = table.columns.map((c) => (c.weight / totalWeight) * CONTENT_WIDTH);
    const edges: number[] = [];
    let acc = MARGIN_X;
    for (const w of widths) {
      edges.push(acc);
      acc += w;
    }

    this.advance(pdf, cursor, 24);
    table.columns.forEach((col, i) => {
      const x = edges[i] ?? MARGIN_X;
      const w = widths[i] ?? 0;
      if (col.align === "right") {
        this.textRight(cursor, col.label, x + w, { size: SIZE_SMALL, font: bold, color: MUTED });
      } else {
        this.text(cursor, col.label, { x, size: SIZE_SMALL, font: bold, color: MUTED });
      }
    });
    this.rule(pdf, cursor);

    for (const row of table.rows) {
      // The description column wraps; everything else is a short value. The
      // row is as tall as its tallest cell, which is what stops a long service
      // name overprinting the row beneath it.
      const wrapped = row.map((cell, i) => {
        const col = table.columns[i];
        const w = widths[i] ?? CONTENT_WIDTH;
        if (col?.align === "right") return [cell];
        return wrapParagraph(cell, w - 8, (s) => body.widthOfTextAtSize(s, SIZE_BODY));
      });
      const height = Math.max(...wrapped.map((c) => c.length)) * SIZE_BODY * LEADING;
      this.advance(pdf, cursor, 14);
      const top = cursor.y;
      wrapped.forEach((cell, i) => {
        const x = edges[i] ?? MARGIN_X;
        const w = widths[i] ?? 0;
        const align = table.columns[i]?.align ?? "left";
        cell.forEach((line, j) => {
          const y = top - j * SIZE_BODY * LEADING;
          if (align === "right") {
            const lw = body.widthOfTextAtSize(line, SIZE_BODY);
            body.draw(cursor.page, line, x + w - lw, y, SIZE_BODY, INK);
          } else {
            body.draw(cursor.page, line, x, y, SIZE_BODY, INK);
          }
        });
      });
      cursor.y = top - height + SIZE_BODY * LEADING;
    }
    this.rule(pdf, cursor);
  }

  private drawTotals(
    cursor: Cursor,
    doc: RenderableDocument,
    body: Face,
    bold: Face,
    pdf: PDFDocument,
  ): void {
    const right = PAGE_WIDTH - MARGIN_X;
    for (const total of doc.totals) {
      this.advance(pdf, cursor, 16);
      const font = total.emphasis ? bold : body;
      this.textRight(cursor, total.value, right, { font, size: SIZE_BODY });
      this.textRight(cursor, total.label, right - 110, {
        font,
        size: SIZE_BODY,
        color: total.emphasis ? INK : MUTED,
      });
    }
  }

  /**
   * One signature block: the heading, room to sign, a line, and what goes
   * under it. Kept on ONE page — `advance` is asked for the whole height first
   * — because a signature line stranded at the foot of a page with its name
   * over the break is a block nobody can tell is complete.
   */
  private async drawSignature(
    cursor: Cursor,
    block: SignatureBlock,
    body: Face,
    bold: Face,
    pdf: PDFDocument,
    // The Annexure letter's acceptance heading names the client AND every
    // company it signs for, which does not fit on one line. OFF for the classic
    // letter, whose block must draw exactly as it always has.
    wrapHeading = false,
  ): Promise<void> {
    const lineWidth = 220;
    const headingLines = wrapHeading
      ? wrapParagraph(block.heading, CONTENT_WIDTH, (t) => bold.widthOfTextAtSize(t, SIZE_BODY))
      : [block.heading];
    const headingExtra = (headingLines.length - 1) * SIZE_BODY * LEADING;
    // The mark, embedded BEFORE any space is reserved: its height decides how
    // much room the block needs, and asking for that room afterwards is what
    // would let a tall signature overrun the page the block was kept on.
    const image =
      block.image === null || block.image === undefined
        ? null
        : block.image.mediaType === "image/png"
          ? await pdf.embedPng(block.image.bytes)
          : await pdf.embedJpg(block.image.bytes);
    // Scaled to sit ON the rule rather than to fill it — a signature wider than
    // the line it is written over reads as a graphic pasted on the page. Capped
    // on both axes and never enlarged, the logo's arrangement exactly.
    const scale =
      image === null ? 0 : Math.min(SIGNATURE_MAX_HEIGHT / image.height, (lineWidth - 8) / image.width, 1);
    const markHeight = image === null ? 0 : image.height * scale;

    const under = block.lines.length + (block.dateAnchor === null ? 0 : 1);
    // The gap between the heading and the rule is the greater of the standing
    // 34pt and what the mark actually needs, so a tall signature pushes the rule
    // down instead of being drawn through the heading above it.
    const gap = Math.max(34, markHeight + 8);
    this.advance(pdf, cursor, 28 + gap + under * SIZE_BODY * LEADING + headingExtra);
    cursor.y += gap + under * SIZE_BODY * LEADING + headingExtra;

    headingLines.forEach((line, i) => {
      // The room for every line was reserved above, so this moves within it.
      if (i > 0) cursor.y -= SIZE_BODY * LEADING;
      this.text(cursor, line, { size: SIZE_BODY, font: bold });
    });
    this.advance(pdf, cursor, gap);
    if (block.signAnchor !== null) {
      this.text(cursor, block.signAnchor, { x: MARGIN_X + 2, font: body, color: PAPER });
    }
    // ON the rule: `cursor.y - 4` is the rule, so the mark sits just above it,
    // the way a signature sits on a printed line.
    if (image !== null) {
      cursor.page.drawImage(image, {
        x: MARGIN_X + 4,
        y: cursor.y - 2,
        width: image.width * scale,
        height: markHeight,
      });
    }
    cursor.page.drawLine({
      start: { x: MARGIN_X, y: cursor.y - 4 },
      end: { x: MARGIN_X + lineWidth, y: cursor.y - 4 },
      thickness: 0.75,
      color: INK,
    });
    for (const line of block.lines) {
      this.advance(pdf, cursor, SIZE_BODY * LEADING);
      this.text(cursor, line, { font: body, color: MUTED });
    }
    if (block.dateAnchor !== null) {
      this.advance(pdf, cursor, SIZE_BODY * LEADING);
      this.text(cursor, "Date", { font: body, color: MUTED });
      this.text(cursor, block.dateAnchor, { x: MARGIN_X + 40, font: body, color: PAPER });
    }
  }

  /** Footer on EVERY page, not just the last: a page of an engagement letter
   *  that arrives on its own must still say which document it belongs to. */
  private drawFooter(pdf: PDFDocument, doc: RenderableDocument, body: Face): void {
    const pages = pdf.getPages();
    pages.forEach((page, i) => {
      const label = `${doc.footer ?? ""}   ·   ${doc.reference}   ·   page ${String(i + 1)} of ${String(pages.length)}`;
      body.draw(page, label, MARGIN_X, MARGIN_BOTTOM - 26, SIZE_SMALL, MUTED);
    });
  }

  // ── The Annexure letter (0083) ───────────────────────────────────────────
  //
  // Page one is a LETTER — letterhead, date, addressee, subject, the firm's
  // paragraphs, its signature, then the acceptance and the client's. Each
  // annexure starts a page of its own, as the firm's own template does, so
  // "Annexure 2, clause 8" is a place a reader can turn to.
  //
  // Everything here is new code that nothing classic calls. The one shared
  // method it borrows, `drawSignature`, is asked to wrap its heading only here.

  private async drawAnnexureLetter(
    pdf: PDFDocument,
    doc: RenderableDocument,
    letter: AnnexureLetter,
    body: Face,
    bold: Face,
  ): Promise<void> {
    const cursor: Cursor = { page: pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]), y: PAGE_HEIGHT - MARGIN_TOP };
    const cover = letter.cover;

    // Letterhead: the mark, the issuing company and its reference.
    if (doc.logo !== null) await this.drawLogo(pdf, cursor, doc.logo);
    this.advance(pdf, cursor, SIZE_HEADING);
    this.text(cursor, doc.issuer.name, { size: SIZE_HEADING, font: bold });
    this.textRight(cursor, doc.reference, PAGE_WIDTH - MARGIN_X, {
      size: SIZE_BODY,
      font: body,
      color: MUTED,
    });
    for (const line of doc.issuer.lines) {
      this.advance(pdf, cursor, SIZE_SMALL * LEADING);
      this.text(cursor, line, { size: SIZE_SMALL, font: body, color: MUTED });
    }
    this.rule(pdf, cursor);

    // Date, addressee, subject, salutation — the order every letter has.
    const marks = cover.anchors;
    this.advance(pdf, cursor, 8);
    body.begin(marks?.date);
    this.drawLines(pdf, cursor, cover.dateLine, body, SIZE_BODY, INK);
    body.end();
    this.advance(pdf, cursor, 8);
    body.begin(marks?.addressee);
    for (const line of cover.addressee) this.drawLines(pdf, cursor, line, body, SIZE_BODY, INK);
    body.end();
    this.advance(pdf, cursor, 10);
    body.begin(marks?.subject);
    this.drawLines(pdf, cursor, cover.subject, bold, SIZE_BODY, INK);
    body.end();
    this.advance(pdf, cursor, 10);
    body.begin(marks?.salutation);
    this.drawLines(pdf, cursor, cover.salutation, body, SIZE_BODY, INK);
    body.end();
    this.advance(pdf, cursor, 4);

    this.drawFlow(pdf, cursor, cover.body, body, bold);

    this.advance(pdf, cursor, 6);
    this.drawLines(pdf, cursor, cover.closing, body, SIZE_BODY, INK);
    if (cover.firm !== null) await this.drawSignature(cursor, cover.firm, body, bold, pdf, true);

    this.drawFlowHeading(pdf, cursor, 1, cover.acceptanceHeading, bold);
    this.drawFlow(pdf, cursor, cover.acceptance, body, bold);
    await this.drawSignature(cursor, cover.client, body, bold, pdf, true);

    for (const annexure of letter.annexures) {
      cursor.page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      cursor.y = PAGE_HEIGHT - MARGIN_TOP;
      this.advance(pdf, cursor, SIZE_SMALL);
      this.text(cursor, annexure.label, { size: SIZE_SMALL, font: bold, color: MUTED });
      this.advance(pdf, cursor, 6);
      this.drawLines(pdf, cursor, annexure.title, bold, SIZE_TITLE, INK);
      this.rule(pdf, cursor);
      this.drawFlow(pdf, cursor, annexure.flow, body, bold);
    }
  }

  // ── The proposal (0084) ──────────────────────────────────────────────────
  //
  // Page one is the COVER: the firm's artwork over the whole page, with who the
  // proposal is prepared for and by printed on it where the design leaves room.
  // Every page after it carries the logo and the running line, and the text
  // flows under them. New code nothing else calls; the flow primitives it
  // shares are asked for the proposal's style only here.

  private async drawProposal(
    pdf: PDFDocument,
    doc: RenderableDocument,
    proposal: ProposalDocument,
    body: Face,
    bold: Face,
  ): Promise<void> {
    const coverPage = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const cover = proposal.cover;
    if (cover.artwork !== null) {
      const art = await this.embed(pdf, cover.artwork);
      // COVER, not contain: the artwork fills the page and keeps its
      // proportions, and whatever overhangs is off the paper. Stretching it to
      // A4, as a word processor does, distorts the photographs in it.
      const scale = Math.max(PAGE_WIDTH / art.width, PAGE_HEIGHT / art.height);
      const w = art.width * scale;
      const h = art.height * scale;
      const left = (PAGE_WIDTH - w) / 2;
      const top = (PAGE_HEIGHT - h) / 2;
      coverPage.drawImage(art, { x: left, y: PAGE_HEIGHT - top - h, width: w, height: h });
      body.begin(cover.anchors?.preparedFor);
      this.drawCoverBlock(coverPage, "Prepared for", cover.preparedFor, {
        x: left + PREPARED_FOR_AT.x * w,
        top: top + PREPARED_FOR_AT.y * h,
        color: INK,
      }, body, bold);
      body.end();
      body.begin(cover.anchors?.preparedBy);
      this.drawCoverBlock(coverPage, "Prepared by", cover.preparedBy, {
        x: left + PREPARED_BY_AT.x * w,
        top: top + PREPARED_BY_AT.y * h,
        color: ON_ARTWORK,
      }, body, bold);
      body.end();
    } else {
      // A PLAIN COVER, for a firm that has uploaded no artwork: the logo, the
      // title, the proposal's own title, and the same two blocks.
      const cursor: Cursor = { page: coverPage, y: PAGE_HEIGHT - MARGIN_TOP };
      if (doc.logo !== null) await this.drawLogo(pdf, cursor, doc.logo);
      let y = PAGE_HEIGHT * 0.62;
      for (const line of wrapParagraph(cover.title, CONTENT_WIDTH, (t) => bold.widthOfTextAtSize(t, 30))) {
        bold.draw(coverPage, line, MARGIN_X, y, 30, INK);
        y -= 30 * 1.2;
      }
      y -= 6;
      body.begin(cover.anchors?.subtitle);
      for (const line of wrapParagraph(cover.subtitle, CONTENT_WIDTH, (t) => body.widthOfTextAtSize(t, 13))) {
        body.draw(coverPage, line, MARGIN_X, y, 13, MUTED);
        y -= 13 * LEADING;
      }
      body.end();
      body.begin(cover.anchors?.preparedFor);
      this.drawCoverBlock(coverPage, "Prepared for", cover.preparedFor, {
        x: MARGIN_X,
        top: PAGE_HEIGHT * 0.52,
        color: INK,
      }, body, bold);
      body.end();
      body.begin(cover.anchors?.preparedBy);
      this.drawCoverBlock(coverPage, "Prepared by", cover.preparedBy, {
        x: MARGIN_X,
        top: PAGE_HEIGHT * 0.72,
        color: INK,
      }, body, bold);
      body.end();
    }

    // Every page after the cover: the logo, the running line, then the text.
    const logo = doc.logo === null ? null : await this.embed(pdf, doc.logo);
    const turn = (c: Cursor): void => {
      c.page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      const baseline = PAGE_HEIGHT - PROPOSAL_HEADER_TOP - PROPOSAL_LOGO_MAX_HEIGHT;
      if (logo !== null) {
        const scale = Math.min(PROPOSAL_LOGO_MAX_HEIGHT / logo.height, 140 / logo.width, 1);
        c.page.drawImage(logo, {
          x: MARGIN_X,
          y: baseline,
          width: logo.width * scale,
          height: logo.height * scale,
        });
      }
      const running = proposal.running;
      // The running head belongs to no piece, even when a paragraph that is
      // being drawn is what turned the page.
      body.quiet(() => {
        body.draw(
          c.page,
          running,
          PAGE_WIDTH - MARGIN_X - body.widthOfTextAtSize(running, SIZE_SMALL),
          baseline + 2,
          SIZE_SMALL,
          MUTED,
        );
      });
      c.y = PAGE_HEIGHT - PROPOSAL_BODY_TOP;
    };
    const cursor: Cursor = { page: coverPage, y: 0, turn };
    turn(cursor);
    this.drawFlow(pdf, cursor, proposal.flow, body, bold, PROPOSAL_FLOW);
  }

  /** "Prepared for:" and the lines under it — underlined label, then each
   *  line in its own weight, wrapped to the room left on the page. */
  private drawCoverBlock(
    page: PDFPage,
    label: string,
    lines: readonly CoverLine[],
    at: { readonly x: number; readonly top: number; readonly color: typeof INK },
    body: Face,
    bold: Face,
  ): void {
    const labelSize = 12;
    const size = 11;
    const width = PAGE_WIDTH - at.x - 24;
    let y = PAGE_HEIGHT - at.top - labelSize;
    bold.draw(page, label, at.x, y, labelSize, at.color);
    const labelWidth = bold.widthOfTextAtSize(label, labelSize);
    bold.draw(page, ":", at.x + labelWidth, y, labelSize, at.color);
    page.drawLine({
      start: { x: at.x, y: y - 2 },
      end: { x: at.x + labelWidth, y: y - 2 },
      thickness: 0.8,
      color: at.color,
    });
    y -= labelSize * 0.9;
    for (const line of lines) {
      const face = line.bold ? bold : body;
      for (const part of wrapParagraph(line.text, width, (t) => face.widthOfTextAtSize(t, size))) {
        y -= size * LEADING;
        face.draw(page, part, at.x, y, size, at.color);
      }
    }
  }

  /** An image into this document — PNG or JPEG, the two it can draw. */
  private async embed(pdf: PDFDocument, image: RenderableImage): Promise<PDFImage> {
    return image.mediaType === "image/png" ? pdf.embedPng(image.bytes) : pdf.embedJpg(image.bytes);
  }

  /** Text wrapped to the page, one line per advance. */
  private drawLines(
    pdf: PDFDocument,
    cursor: Cursor,
    value: string,
    font: Face,
    size: number,
    color: typeof INK,
  ): void {
    for (const line of wrapParagraph(value, CONTENT_WIDTH, (t) => font.widthOfTextAtSize(t, size))) {
      this.advance(pdf, cursor, size * LEADING);
      font.draw(cursor.page, line, MARGIN_X, cursor.y, size, color);
    }
  }

  /** Start a page when fewer than `height` points are left on this one. */
  private ensureRoom(pdf: PDFDocument, cursor: Cursor, height: number): void {
    if (cursor.y - height < MARGIN_BOTTOM) this.newPage(pdf, cursor);
  }

  private drawFlow(
    pdf: PDFDocument,
    cursor: Cursor,
    flow: readonly Flow[],
    body: Face,
    bold: Face,
    style: FlowStyle = LETTER_FLOW,
  ): void {
    for (const piece of flow) {
      body.begin(piece.anchor);
      if (piece.kind === "heading") this.drawFlowHeading(pdf, cursor, piece.level, piece.text, bold, style);
      else if (piece.kind === "paragraph") {
        this.drawFlowParagraph(pdf, cursor, piece.text, piece.muted === true, body, style, piece.lead, bold);
      } else if (piece.kind === "table") this.drawFlowTable(pdf, cursor, piece.table, body, bold, style);
      else this.drawFigures(pdf, cursor, piece.rows, body, bold);
      body.end();
    }
  }

  /**
   * A heading, KEPT WITH WHAT FOLLOWS: the heading and two lines of text below
   * it go on one page, so a section never ends a page with its own title.
   */
  private drawFlowHeading(
    pdf: PDFDocument,
    cursor: Cursor,
    level: 1 | 2 | 3,
    text: string,
    bold: Face,
    style: FlowStyle = LETTER_FLOW,
  ): void {
    const { size, before, color } = style.headings[level];
    const lines = wrapParagraph(text, CONTENT_WIDTH, (t) => bold.widthOfTextAtSize(t, size));
    this.ensureRoom(pdf, cursor, before + lines.length * size * LEADING + 2 * style.body * LEADING);
    cursor.y -= before;
    for (const line of lines) {
      this.advance(pdf, cursor, size * LEADING);
      bold.draw(cursor.page, line, MARGIN_X, cursor.y, size, color);
    }
    cursor.y -= 2;
  }

  /** The firm's prose, its own line breaks kept and its bullets hung. */
  private drawFlowParagraph(
    pdf: PDFDocument,
    cursor: Cursor,
    text: string,
    muted: boolean,
    body: Face,
    style: FlowStyle = LETTER_FLOW,
    lead?: string,
    bold?: Face,
  ): void {
    const color = muted ? MUTED : INK;
    const size = style.body;
    // A LABEL run into the first line (0084): "Fees" in the heading weight,
    // then the sentence it starts, wrapping under the label's full width.
    let hards = text.split("\n");
    if (lead !== undefined && bold !== undefined) {
      const leadWidth = bold.widthOfTextAtSize(`${lead} `, size);
      const [first = "", ...rest] = hards;
      const lines = wrapAfterLabel(first, CONTENT_WIDTH - leadWidth, CONTENT_WIDTH, (t) =>
        body.widthOfTextAtSize(t, size),
      );
      lines.forEach((line, i) => {
        this.advance(pdf, cursor, size * LEADING);
        if (i === 0) {
          bold.draw(cursor.page, lead, MARGIN_X, cursor.y, size, INK);
          body.draw(cursor.page, line, MARGIN_X + leadWidth, cursor.y, size, color);
        } else {
          body.draw(cursor.page, line, MARGIN_X, cursor.y, size, color);
        }
      });
      hards = rest;
    }
    // An indented line straight after a bullet belongs to it and hangs under
    // its text, the way the firm writes a two-line item.
    let hanging = false;
    for (const hard of hards) {
      const bullet = BULLET.exec(hard);
      const continues: boolean = bullet === null && hanging && /^\s+\S/.test(hard);
      hanging = bullet !== null || continues;
      const content = bullet === null ? hard : hard.slice(bullet[0].length);
      const indent = bullet === null && !continues ? 0 : BULLET_INDENT;
      const lines = wrapParagraph(content, CONTENT_WIDTH - indent, (t) =>
        body.widthOfTextAtSize(t, size),
      );
      lines.forEach((line, i) => {
        this.advance(pdf, cursor, size * LEADING);
        if (bullet !== null && i === 0) {
          body.draw(cursor.page, "\u2022", MARGIN_X + 2, cursor.y, size, color);
        }
        body.draw(cursor.page, line, MARGIN_X + indent, cursor.y, size, color);
      });
    }
    cursor.y -= 4;
  }

  /**
   * A table whose every cell wraps, with each row kept whole and the header
   * repeated on a new page. The classic `drawTable` wraps only its left column
   * and never breaks a row across pages; this is the Summary of Fees, whose fee
   * cell carries a second line ("40% advance, 60% on completion") and whose rows
   * can be long.
   */
  private drawFlowTable(
    pdf: PDFDocument,
    cursor: Cursor,
    table: LineTable,
    body: Face,
    bold: Face,
    style: FlowStyle = LETTER_FLOW,
  ): void {
    const size = style.body;
    const totalWeight = table.columns.reduce((n, c) => n + c.weight, 0);
    const widths = table.columns.map((c) => (c.weight / totalWeight) * CONTENT_WIDTH);
    const edges: number[] = [];
    let acc = MARGIN_X;
    for (const w of widths) {
      edges.push(acc);
      acc += w;
    }
    const line = (y: number): void => {
      cursor.page.drawLine({
        start: { x: MARGIN_X, y },
        end: { x: PAGE_WIDTH - MARGIN_X, y },
        thickness: 0.75,
        color: RULE,
      });
    };
    const header = (): void => {
      this.advance(pdf, cursor, 14 + SIZE_SMALL);
      table.columns.forEach((col, i) => {
        const x = edges[i] ?? MARGIN_X;
        const w = widths[i] ?? 0;
        if (col.align === "right") {
          this.textRight(cursor, col.label, x + w - 4, { size: SIZE_SMALL, font: bold, color: MUTED });
        } else {
          this.text(cursor, col.label, { x, size: SIZE_SMALL, font: bold, color: MUTED });
        }
      });
      cursor.y -= 6;
      line(cursor.y);
    };

    const wrappedRows = table.rows.map((row) =>
      row.map((cell, i) =>
        wrapParagraph(cell, (widths[i] ?? CONTENT_WIDTH) - 8, (t) => body.widthOfTextAtSize(t, size)),
      ),
    );
    const heightOf = (cells: readonly (readonly string[])[]): number =>
      Math.max(1, ...cells.map((c) => c.length)) * size * LEADING + 8;

    // The header and the first row together, or neither.
    this.ensureRoom(pdf, cursor, 20 + 14 + heightOf(wrappedRows[0] ?? []));
    body.quiet(header);
    for (const [r, cells] of wrappedRows.entries()) {
      const height = heightOf(cells);
      if (cursor.y - height < MARGIN_BOTTOM) {
        body.quiet(() => {
          this.newPage(pdf, cursor);
          header();
        });
      }
      body.begin(table.rowAnchors?.[r] ?? undefined);
      const first = cursor.y - 4 - size;
      cells.forEach((cellLines, i) => {
        const x = edges[i] ?? MARGIN_X;
        const w = widths[i] ?? 0;
        const align = table.columns[i]?.align ?? "left";
        cellLines.forEach((text, j) => {
          const y = first - j * size * LEADING;
          if (align === "right") {
            const tw = body.widthOfTextAtSize(text, size);
            body.draw(cursor.page, text, x + w - 4 - tw, y, size, INK);
          } else {
            body.draw(cursor.page, text, x, y, size, INK);
          }
        });
      });
      body.end();
      cursor.y -= height;
      line(cursor.y);
    }
    cursor.y -= 4;
  }

  /** Label-and-figure rows under a table, right-aligned like the classic
   *  totals. */
  private drawFigures(
    pdf: PDFDocument,
    cursor: Cursor,
    rows: readonly TotalRow[],
    body: Face,
    bold: Face,
  ): void {
    const right = PAGE_WIDTH - MARGIN_X;
    for (const row of rows) {
      this.advance(pdf, cursor, 16);
      const font = row.emphasis ? bold : body;
      this.textRight(cursor, row.value, right - 4, { font, size: SIZE_BODY });
      this.textRight(cursor, row.label, right - 124, {
        font,
        size: SIZE_BODY,
        color: row.emphasis ? INK : MUTED,
      });
    }
  }
}

/**
 * A line of text wrapped after a LABEL — the first line has only what the
 * label leaves, the rest the full width. `wrapParagraph`'s rule otherwise: a
 * word longer than a line overflows rather than being broken.
 */
function wrapAfterLabel(
  text: string,
  firstWidth: number,
  width: number,
  measure: (s: string) => number,
): readonly string[] {
  const out: string[] = [];
  let line = "";
  let room = firstWidth;
  for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (line !== "" && measure(candidate) > room) {
      out.push(line);
      line = word;
      room = width;
    } else {
      line = candidate;
    }
  }
  out.push(line);
  return out;
}

/**
 * Every string the document will draw, checked against the font chain.
 *
 * `\t` and `\n` are allowed through because the layout handles them; any other
 * character no font in the chain carries is refused by name. Answers every
 * character it passed, for `FontSet.prepare`.
 */
function assertRenderable(doc: RenderableDocument, fonts: FontSet): ReadonlySet<number> {
  const seen = new Set<number>();
  const check = (field: string, value: string | null): void => {
    if (value === null) return;
    for (const ch of value) {
      if (ch === "\n" || ch === "\t") continue;
      const code = ch.codePointAt(0) ?? 0;
      if (!fonts.canRender(code)) throw new UnrenderableText(field, ch);
      seen.add(code);
    }
  };

  check("the document title", doc.documentTitle);
  check("the reference", doc.reference);
  check("the issuing entity's name", doc.issuer.name);
  doc.issuer.lines.forEach((l, i) => { check(`the issuing entity's address line ${String(i + 1)}`, l); });
  check("the recipient's name", doc.recipient.name);
  doc.recipient.lines.forEach((l, i) => { check(`the recipient's address line ${String(i + 1)}`, l); });
  doc.meta.forEach((m) => { check(`the "${m.label}" field`, m.value); });
  doc.sections.forEach((s) => {
    check("a section heading", s.heading);
    s.paragraphs.forEach((p, i) => { check(`a paragraph of "${s.heading ?? "the document"}" (${String(i + 1)})`, p); });
  });
  doc.terms?.forEach((t) => {
    check("a term's heading", t.heading);
    t.paragraphs.forEach((p, i) => { check(`a paragraph of the term "${t.heading ?? ""}" (${String(i + 1)})`, p); });
  });
  doc.table?.rows.forEach((row, i) => {
    row.forEach((cell) => { check(`row ${String(i + 1)} of the table`, cell); });
  });
  doc.totals.forEach((t) => { check(`the "${t.label}" total`, t.value); });
  check("the footer", doc.footer);
  const block = (b: SignatureBlock): void => {
    check("a signature block's heading", b.heading);
    b.lines.forEach((l) => { check(`the signature block "${b.heading}"`, l); });
    check("a signature anchor", b.signAnchor);
    check("a signature anchor", b.dateAnchor);
  };
  doc.signatures?.forEach(block);

  // The Annexure letter (0083): every string it will draw, by where it is.
  const flow = (where: string, pieces: readonly Flow[]): void => {
    pieces.forEach((piece, i) => {
      const at = `${where} (${String(i + 1)})`;
      if (piece.kind === "heading") check(at, piece.text);
      else if (piece.kind === "paragraph") {
        check(at, piece.text);
        check(at, piece.lead ?? null);
      } else if (piece.kind === "table") {
        piece.table.columns.forEach((c) => { check(`a column heading in ${where}`, c.label); });
        piece.table.rows.forEach((row, r) => {
          row.forEach((cell) => { check(`row ${String(r + 1)} of the table in ${where}`, cell); });
        });
      } else {
        piece.rows.forEach((r) => {
          check(`a figure's label in ${where}`, r.label);
          check(`the "${r.label}" figure in ${where}`, r.value);
        });
      }
    });
  };
  const letter = doc.annexureLetter;
  if (letter !== undefined) {
    const cover = letter.cover;
    check("the cover letter's date", cover.dateLine);
    cover.addressee.forEach((l, i) => { check(`the addressee's line ${String(i + 1)}`, l); });
    check("the subject line", cover.subject);
    check("the salutation", cover.salutation);
    flow("the cover letter", cover.body);
    check("the closing", cover.closing);
    if (cover.firm !== null) block(cover.firm);
    check("the acceptance heading", cover.acceptanceHeading);
    flow("the acceptance", cover.acceptance);
    block(cover.client);
    letter.annexures.forEach((a) => {
      check("an annexure's label", a.label);
      check(`the title of ${a.label}`, a.title);
      flow(a.label, a.flow);
    });
  }

  // The proposal (0084): its cover, its running line and its flow.
  const proposal = doc.proposal;
  if (proposal !== undefined) {
    check("the cover's title", proposal.cover.title);
    check("the proposal's title on the cover", proposal.cover.subtitle);
    proposal.cover.preparedFor.forEach((l, i) => { check(`"Prepared for" line ${String(i + 1)}`, l.text); });
    proposal.cover.preparedBy.forEach((l, i) => { check(`"Prepared by" line ${String(i + 1)}`, l.text); });
    check("the running line", proposal.running);
    flow("the proposal", proposal.flow);
  }
  return seen;
}
