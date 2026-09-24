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
import type { PDFPage } from "pdf-lib";
import { FontSet } from "./font-set";
import type { RenderableDocument, Section, SignatureBlock } from "../../domain/render/model";
import { wrapParagraph } from "../../domain/render/model";
import { UnrenderableText } from "../../domain/render/errors";
import type { DocumentRenderer } from "../../usecase/render/ports";

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

interface Cursor {
  page: PDFPage;
  y: number;
}

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
  }
}

export class PdfLibRenderer implements DocumentRenderer {
  readonly kind = "pdf-lib";
  readonly mediaType = "application/pdf";

  async render(doc: RenderableDocument): Promise<Uint8Array> {
    // CHECKED UP FRONT, and this is deliberate. pdf-lib raises on the character
    // it cannot encode, deep inside a draw call, with a message naming neither
    // the field nor the document. Scanning first means the refusal says WHERE —
    // and it means a half-drawn page is never produced.
    const pdf = await PDFDocument.create();

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
    // anything is drawn, so a half-page is never produced.
    assertRenderable(doc, fonts);

    const body = new Face(fonts, false);
    const bold = new Face(fonts, true);

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

    return pdf.save();
  }

  // ── Layout primitives ────────────────────────────────────────────────────

  /** Move down, starting a new page when the next block will not fit. */
  private advance(pdf: PDFDocument, cursor: Cursor, height: number): void {
    if (cursor.y - height < MARGIN_BOTTOM) {
      cursor.page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      cursor.y = PAGE_HEIGHT - MARGIN_TOP;
    }
    cursor.y -= height;
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
    if (doc.logo !== null) {
      const image =
        doc.logo.mediaType === "image/png"
          ? await pdf.embedPng(doc.logo.bytes)
          : await pdf.embedJpg(doc.logo.bytes);
      const maxH = 34;
      const scale = Math.min(maxH / image.height, 160 / image.width, 1);
      const w = image.width * scale;
      const h = image.height * scale;
      this.advance(pdf, cursor, h);
      cursor.page.drawImage(image, { x: MARGIN_X, y: cursor.y, width: w, height: h });
      this.advance(pdf, cursor, 14);
    }

    this.advance(pdf, cursor, SIZE_TITLE);
    this.text(cursor, doc.documentTitle, { size: SIZE_TITLE, font: bold });
    this.textRight(cursor, doc.reference, PAGE_WIDTH - MARGIN_X, { size: SIZE_BODY, font: body, color: MUTED });
    this.rule(pdf, cursor);
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
  ): Promise<void> {
    const lineWidth = 220;
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
    this.advance(pdf, cursor, 28 + gap + under * SIZE_BODY * LEADING);
    cursor.y += gap + under * SIZE_BODY * LEADING;

    this.text(cursor, block.heading, { size: SIZE_BODY, font: bold });
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
}

/**
 * Every string the document will draw, checked against what WinAnsi covers.
 *
 * The standard PDF fonts encode Latin-1 and no more. `\t` and `\n` are allowed
 * through because the layout handles them; everything else outside the range is
 * refused by name.
 */
function assertRenderable(doc: RenderableDocument, fonts: FontSet): void {
  const check = (field: string, value: string | null): void => {
    if (value === null) return;
    for (const ch of value) {
      if (ch === "\n" || ch === "\t") continue;
      const code = ch.codePointAt(0) ?? 0;
      if (fonts.canRender(code)) continue;
      throw new UnrenderableText(field, ch);
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
  doc.signatures?.forEach((b) => {
    check("a signature block's heading", b.heading);
    b.lines.forEach((l) => { check(`the signature block "${b.heading}"`, l); });
    check("a signature anchor", b.signAnchor);
    check("a signature anchor", b.dateAnchor);
  });
}
