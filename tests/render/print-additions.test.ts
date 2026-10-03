// What the 2026-10-03 audit added to the page, each OPT-IN, so a document that
// does not ask for it draws exactly as before (the pinned hashes in
// layout.test.ts hold that for the classic letter and the invoice):
//
//   - the total in words under an invoice's totals (B12 / CA#1);
//   - a Summary of Fees kept on one page when it fits on one (CA#60);
//   - the issuing company's letterhead at the foot of a proposal's pages
//     after the cover (CA#18).
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { createHash } from "node:crypto";
import { PdfLibRenderer } from "../../src/infrastructure/render/pdf-renderer";
import type { Flow, LineTable, RenderableDocument } from "../../src/domain/render/model";

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

const invoice = (over: Partial<RenderableDocument> = {}): RenderableDocument => ({
  documentTitle: "Tax Invoice",
  reference: "INV/2026-27/0001",
  issuer: { name: "Sharma Mehta & Co", lines: ["12 MG Road", "Maharashtra 411001, India", "GSTIN 27ABCDE1234F1Z5"] },
  recipient: { name: "Deccan Agro Foods Private Limited", lines: ["Plot 4, MIDC", "Maharashtra 411019, India"] },
  recipientLabel: "Billed to",
  meta: [{ label: "Invoice date", value: "3 October 2026" }],
  sections: [],
  table: {
    columns: [
      { label: "Description", align: "left", weight: 6 },
      { label: "Qty", align: "right", weight: 1 },
      { label: "Rate", align: "right", weight: 2 },
      { label: "Amount", align: "right", weight: 2 },
    ],
    rows: [["GST returns for September 2026", "1", "₹5,000.00", "₹5,000.00"]],
  },
  totals: [
    { label: "Sub-total", value: "₹5,000.00", emphasis: false },
    { label: "Tax", value: "₹900.00", emphasis: false },
    { label: "Total", value: "₹5,900.00", emphasis: true },
  ],
  footer: "Sharma Mehta & Co",
  logo: null,
  issuedOn: "2026-10-03",
  ...over,
});

describe("the total in words (B12 / CA#1)", () => {
  it("is drawn only when the document carries it", async () => {
    const r = new PdfLibRenderer();
    const plain = sha(await r.render(invoice()));
    expect(sha(await r.render(invoice({ amountInWords: undefined })))).toBe(plain);
    expect(sha(await r.render(invoice({ amountInWords: "Indian Rupees Five Thousand Nine Hundred Only" })))).not.toBe(
      plain,
    );
  });

  it("is checked against the fonts like every other string", async () => {
    await expect(new PdfLibRenderer().render(invoice({ amountInWords: "株式会社" }))).rejects.toThrow(
      /the amount in words/,
    );
  });
});

/** A proposal whose Summary of Fees starts after `filler` paragraphs. */
function proposal(filler: number, table: Partial<LineTable>, letterhead?: readonly string[]): RenderableDocument {
  const rows = ["A1", "A2", "B1", "B2"].map((code) => [code, `Service ${code}`, "Monthly", "₹12,000"]);
  const flow: Flow[] = [
    ...Array.from({ length: filler }, (_, i): Flow => ({ kind: "paragraph", text: `Paragraph ${String(i + 1)} of the work.` })),
    { kind: "heading", level: 1, text: "Summary of Fees", anchor: "summary" },
    {
      kind: "table",
      table: {
        columns: [
          { label: "Section", align: "left", weight: 1 },
          { label: "Description", align: "left", weight: 4 },
          { label: "Frequency", align: "left", weight: 2 },
          { label: "Fees", align: "left", weight: 2 },
        ],
        rows,
        rowAnchors: rows.map((r) => `fee:${r[0] ?? ""}`),
        ...table,
      },
    },
    { kind: "paragraph", lead: "Total", text: "₹48,000 Monthly" },
  ];
  return invoice({
    documentTitle: "Proposal",
    reference: "PR-2026-0001",
    meta: [],
    table: null,
    totals: [],
    footer: null,
    proposal: {
      cover: {
        artwork: null,
        title: "Proposal for Services",
        subtitle: "Compliance support",
        preparedFor: [{ text: "Deccan Agro Foods Private Limited", bold: true }],
        preparedBy: [{ text: "Sharma Mehta & Co", bold: true }],
      },
      running: "PR-2026-0001  ·  3 October 2026",
      flow,
      ...(letterhead === undefined ? {} : { letterhead }),
    },
  });
}

async function rowPages(doc: RenderableDocument): Promise<number[]> {
  const drawn = await new PdfLibRenderer().renderWithAnchors(doc);
  return drawn.anchors.filter((a) => a.key.startsWith("fee:") || a.key === "summary").map((a) => a.page);
}

describe("a Summary of Fees kept on one page (CA#60)", () => {
  it("starts on the next page, its heading with it, rather than leave a row behind", async () => {
    // Find where the table, left alone, splits across a page.
    let split = -1;
    for (let n = 30; n < 80 && split < 0; n += 1) {
      const pages = await rowPages(proposal(n, {}));
      if (new Set(pages).size > 1) split = n;
    }
    expect(split).toBeGreaterThan(0);
    const kept = await rowPages(proposal(split, { keepTogether: true, keepWithNextLines: 1 }));
    expect(new Set(kept).size).toBe(1);
  });

  it("leaves a table that does not ask exactly as it was", async () => {
    const r = new PdfLibRenderer();
    expect(sha(await r.render(proposal(10, {})))).toBe(sha(await r.render(proposal(10, { keepTogether: undefined }))));
  });
});

describe("the letterhead at the foot of a proposal's pages (CA#18)", () => {
  it("is drawn on the pages after the cover, and nothing without one", async () => {
    const r = new PdfLibRenderer();
    const without = await r.render(proposal(5, {}));
    const withHead = await r.render(
      proposal(5, {}, ["Sharma Mehta & Co · 12 MG Road, Pune · Maharashtra 411001, India", "GSTIN 27ABCDE1234F1Z5 · PAN ABCDE1234F"]),
    );
    expect(sha(withHead)).not.toBe(sha(without));
    expect(sha(await r.render(proposal(5, {}, [])))).toBe(sha(without));
    expect((await PDFDocument.load(withHead)).getPageCount()).toBe((await PDFDocument.load(without)).getPageCount());
  });
});
