// Whether a PDF's text layer is worth reading (docs/FIN_BUILD_PLAN.md F2.3).
//
// Pure. The PDF text adapter (`infrastructure/fin/pdf-text.ts`) asks this
// after it has pulled every text run out, and writes the answer into
// `PdfText.hasTextLayer`; the statement reader answers `not_mine` when it is
// false, so a scan goes on to the AI reader instead of being parsed as an empty
// statement.
//
// ── THE RULE, AND WHY IT IS A COUNT OF CHARACTERS PER PAGE ──────────────────
//
// A scanned page is an image, and its text layer is EMPTY: every one of the
// training pack's fifteen scanned statement months has zero text runs on every
// page. But "zero" is too strict a test for real scans, which often carry a
// sliver of text that is no reading matter: a scanner app's "Scanned with …"
// stamp, a page number, a fax header line. And a digital statement never has
// LITTLE text: the smallest page in the pack (a card statement with no
// charges) carries several hundred characters.
//
// So a page counts as text when it carries at least `TEXT_PAGE_MIN_CHARS`
// visible characters (whitespace does not count), and the document has a text
// layer when at least HALF its pages do. Half rather than all, because a
// digital statement with a blank or near-blank last page is still digital;
// half rather than one page, because a scan with a typed cover sheet is still
// a scan. A document mixing the two goes to the statement parser, and if the
// scanned pages held transactions, the control figures will not add up and the
// read goes to a person (`control_mismatch`), which is the honest outcome.
//
// What this does NOT detect: a scan that was OCR'd into an invisible text
// layer ("searchable PDF"). That reads as text, and should: the positions are
// real, and the statement parser either reads it or does not recognise it.
import type { PdfTextPage } from "./lines";

/** Visible characters a page needs before it counts as a text page. A page
 *  number or a scanner's stamp stays under it; any statement page is far over. */
export const TEXT_PAGE_MIN_CHARS = 25;

/** How many visible (non-whitespace) characters a page's text runs carry. */
export function visibleChars(page: PdfTextPage): number {
  let n = 0;
  for (const item of page.items) n += item.text.replace(/\s+/gu, "").length;
  return n;
}

/** Whether a document's text layer is worth reading: at least half of its
 *  pages are text pages. A document with no pages has none. */
export function hasReadableTextLayer(pages: readonly PdfTextPage[]): boolean {
  if (pages.length === 0) return false;
  const textPages = pages.filter((p) => visibleChars(p) >= TEXT_PAGE_MIN_CHARS).length;
  return textPages * 2 >= pages.length;
}
