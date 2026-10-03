// Where the renderer drew each editable piece (2026-09-28) — and the one
// property that makes it safe: the anchors are a SIDE OUTPUT of the drawing
// pass, and the bytes are the same whether they are collected or not, and
// whether a document carries anchor keys or not. A rendered document's hash is
// evidence (T3.8), so a preview that moved a single byte would be a different
// document from the one Send files.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PdfLibRenderer } from "../../src/infrastructure/render/pdf-renderer";
import type { Flow, RenderableDocument, RenderableImage } from "../../src/domain/render/model";

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** A 1×1 PNG — real bytes, because `embedPng` parses them. */
const PNG: RenderableImage = {
  bytes: Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  ),
  mediaType: "image/png",
};

function base(overrides: Partial<RenderableDocument>): RenderableDocument {
  return {
    documentTitle: "Proposal",
    reference: "PR-2026-0001",
    issuer: { name: "10x Global Private Limited", lines: [] },
    recipient: { name: "Nexus Fintech", lines: [] },
    recipientLabel: "Prepared for",
    meta: [],
    sections: [],
    table: null,
    totals: [],
    footer: null,
    logo: PNG,
    issuedOn: "2026-09-28",
    ...overrides,
  };
}

/** Removes every anchor key, so the same document can be drawn without them. */
function stripped(flow: readonly Flow[]): Flow[] {
  return flow.map((piece) => {
    const { anchor: _anchor, ...rest } = piece;
    if (rest.kind !== "table") return rest;
    const { rowAnchors: _rows, ...table } = rest.table;
    return { ...rest, table };
  });
}

function proposal(opts: { anchored: boolean; artwork: RenderableImage | null; services?: number }): RenderableDocument {
  const services = opts.services ?? 2;
  const items: Flow[] = Array.from({ length: services }, (_, i): Flow[] => {
    const id = `line-${String(i + 1)}`;
    return [
      { kind: "heading", level: 2, text: `H${String(i + 1)}. Transfer pricing audit`, anchor: `line:${id}.name` },
      {
        kind: "paragraph",
        text: "- Benchmarking study.\n- Form 3CEB, certified and filed.\n- A long line that wraps ".repeat(3),
        anchor: `line:${id}.scope`,
      },
      { kind: "heading", level: 3, text: "Exclusions", anchor: `line:${id}.exclusions` },
      { kind: "paragraph", text: "Statutory fees.", anchor: `line:${id}.exclusions` },
      { kind: "paragraph", lead: "Fees", text: `H${String(i + 1)}: INR 12,50,000 Yearly`, anchor: `fee:line:${id}` },
    ];
  }).flat();
  const flow: Flow[] = [
    { kind: "heading", level: 1, text: "Background", anchor: "proposal.background" },
    { kind: "paragraph", text: "Nexus Fintech provides payment services.", anchor: "proposal.background" },
    { kind: "heading", level: 1, text: "A. Financial Reporting & Compliance" },
    ...items,
    { kind: "heading", level: 1, text: "Summary of Fees" },
    {
      kind: "table",
      table: {
        columns: [
          { label: "Sub Section", align: "left", weight: 1 },
          { label: "Fees", align: "left", weight: 2 },
        ],
        rows: Array.from({ length: services }, (_, i) => [`H${String(i + 1)}`, "INR 12,50,000"]),
        rowAnchors: Array.from({ length: services }, (_, i) => `fee:line:line-${String(i + 1)}`),
      },
    },
    { kind: "heading", level: 1, text: "Commercials", anchor: "add:commercial" },
    { kind: "paragraph", text: "- Invoices are payable within 15 days.", anchor: "block:b1" },
  ];
  return base({
    proposal: {
      cover: {
        artwork: opts.artwork,
        title: "Proposal for Services",
        subtitle: "Compliance support FY 2026-27",
        preparedFor: [
          { text: "Priya Sharma", bold: true },
          { text: "Nexus Fintech", bold: true },
        ],
        preparedBy: [
          { text: "Siddharth Kohli", bold: true },
          { text: "10x Global Private Limited", bold: true },
        ],
        ...(opts.anchored
          ? { anchors: { subtitle: "proposal.title", preparedFor: "proposal.preparedFor", preparedBy: "proposal.preparedBy" } }
          : {}),
      },
      running: "PR-2026-0001  ·  28 September 2026",
      flow: opts.anchored ? flow : stripped(flow),
    },
  });
}

function letter(anchored: boolean): RenderableDocument {
  const body: Flow[] = [
    { kind: "paragraph", text: "We are pleased to set out the terms of our engagement.", anchor: "block:c1" },
  ];
  const annexure: Flow[] = [
    { kind: "heading", level: 1, text: "A. Ongoing recurring services", anchor: "section:g1.title" },
    { kind: "paragraph", text: "One monthly fee covers the work below.", anchor: "section:g1.intro" },
    { kind: "heading", level: 2, text: "A1. Accounting", anchor: "line:l1.name" },
    { kind: "paragraph", text: "- Monthly books.", anchor: "line:l1.scope" },
    { kind: "heading", level: 1, text: "Summary of Fees" },
    {
      kind: "table",
      table: {
        columns: [
          { label: "Section", align: "left", weight: 1 },
          { label: "Fee", align: "left", weight: 2 },
        ],
        rows: [["A", "INR 45,000.00 per month"]],
        rowAnchors: ["fee:group:g1"],
      },
    },
  ];
  return base({
    documentTitle: "Engagement letter",
    reference: "EL-2026-0001",
    recipientLabel: "To",
    footer: "10x Global Private Limited",
    annexureLetter: {
      cover: {
        dateLine: "Dated 28 September 2026",
        addressee: ["Priya Sharma", "Nexus Fintech"],
        subject: "Subject: Accounting and compliance",
        salutation: "Dear Priya Sharma,",
        body: anchored ? body : stripped(body),
        closing: "Yours sincerely,",
        firm: null,
        acceptanceHeading: "Acceptance",
        acceptance: [],
        client: {
          heading: "Accepted for and on behalf of Nexus Fintech",
          lines: ["Name and capacity"],
          signAnchor: "/bib-client-sign/",
          dateAnchor: "/bib-client-date/",
        },
        ...(anchored
          ? {
              anchors: {
                date: "letter.issuedOn",
                addressee: "letter.addressedTo",
                subject: "letter.subject",
                salutation: "letter.addressedTo",
              },
            }
          : {}),
      },
      annexures: [
        {
          label: "Annexure 1",
          title: "Scope of Services, Deliverables & Fees",
          flow: anchored ? annexure : stripped(annexure),
        },
      ],
    },
  });
}

describe("anchors are never drawn", () => {
  it("a proposal: the same bytes rendered with and without collecting them", async () => {
    const r = new PdfLibRenderer();
    for (const artwork of [PNG, null]) {
      const doc = proposal({ anchored: true, artwork });
      const plain = await r.render(doc);
      const collected = await r.renderWithAnchors(doc);
      expect(sha(collected.bytes)).toBe(sha(plain));
      expect(collected.anchors.length).toBeGreaterThan(0);
    }
  });

  it("a proposal: the same bytes whether the document carries anchor keys or not", async () => {
    const r = new PdfLibRenderer();
    for (const artwork of [PNG, null]) {
      const withKeys = await r.render(proposal({ anchored: true, artwork }));
      const withoutKeys = await r.render(proposal({ anchored: false, artwork }));
      expect(sha(withKeys)).toBe(sha(withoutKeys));
    }
  });

  it("an Annexure letter: the same bytes both ways", async () => {
    const r = new PdfLibRenderer();
    const plain = await r.render(letter(true));
    expect(sha((await r.renderWithAnchors(letter(true))).bytes)).toBe(sha(plain));
    expect(sha(await r.render(letter(false)))).toBe(sha(plain));
  });

  it("a document with no anchors reports none, and its bytes do not move", async () => {
    const r = new PdfLibRenderer();
    const doc = proposal({ anchored: false, artwork: PNG });
    const collected = await r.renderWithAnchors(doc);
    expect(collected.anchors).toEqual([]);
    expect(sha(collected.bytes)).toBe(sha(await r.render(doc)));
  });
});

describe("where each piece was drawn", () => {
  it("puts the cover's names on page 1 and the flow after it", async () => {
    const { anchors, pageCount } = await new PdfLibRenderer().renderWithAnchors(
      proposal({ anchored: true, artwork: PNG }),
    );
    const on = (key: string) => anchors.filter((a) => a.key === key);
    expect(on("proposal.preparedFor").map((a) => a.page)).toEqual([1]);
    expect(on("proposal.preparedBy").map((a) => a.page)).toEqual([1]);
    // With artwork the cover prints no title of its own.
    expect(on("proposal.title")).toEqual([]);
    expect(on("proposal.background")[0]?.page).toBe(2);
    expect(on("fee:line:line-1").length).toBeGreaterThanOrEqual(2); // the fee line and its Summary row
    expect(pageCount).toBeGreaterThanOrEqual(2);
    for (const a of anchors) {
      expect(a.page).toBeGreaterThanOrEqual(1);
      expect(a.page).toBeLessThanOrEqual(pageCount);
      expect(a.width).toBeGreaterThan(0);
      expect(a.height).toBeGreaterThan(0);
      // Measured from the TOP of an A4 page.
      expect(a.y).toBeGreaterThanOrEqual(0);
      expect(a.y + a.height).toBeLessThanOrEqual(841.89);
      expect(a.x + a.width).toBeLessThanOrEqual(595.28);
    }
  });

  it("measures the plain cover's title, and keeps a piece in document order", async () => {
    const { anchors } = await new PdfLibRenderer().renderWithAnchors(proposal({ anchored: true, artwork: null }));
    const title = anchors.find((a) => a.key === "proposal.title");
    expect(title?.page).toBe(1);
    const background = anchors.find((a) => a.key === "proposal.background");
    const scope = anchors.find((a) => a.key === "line:line-1.scope");
    expect(background !== undefined && scope !== undefined && background.y < scope.y).toBe(true);
  });

  it("gives a piece broken across pages one rectangle per page, never the running head", async () => {
    const { anchors } = await new PdfLibRenderer().renderWithAnchors(
      proposal({ anchored: true, artwork: PNG, services: 30 }),
    );
    const pages = new Set(anchors.map((a) => a.page));
    expect(pages.size).toBeGreaterThan(3);
    // The running head sits above 80pt from the top; no piece reaches into it.
    for (const a of anchors.filter((x) => x.page > 1)) expect(a.y).toBeGreaterThan(60);
  });

  it("places the letter's head, its sections and its fee rows", async () => {
    const { anchors } = await new PdfLibRenderer().renderWithAnchors(letter(true));
    const keys = new Set(anchors.map((a) => a.key));
    for (const key of [
      "letter.issuedOn",
      "letter.addressedTo",
      "letter.subject",
      "block:c1",
      "section:g1.title",
      "section:g1.intro",
      "line:l1.name",
      "line:l1.scope",
      "fee:group:g1",
    ]) {
      expect(keys.has(key)).toBe(true);
    }
    expect(anchors.find((a) => a.key === "letter.subject")?.page).toBe(1);
    expect(anchors.find((a) => a.key === "fee:group:g1")?.page).toBe(2);
  });
});

// Money on documents, lakhs included, is tested in document-money.test.ts.
