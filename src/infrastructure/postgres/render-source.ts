// Turning the product's own records into a document description (T3.8).
//
// This adapter is the ONLY thing that knows both what an engagement letter is
// and what a rendered document looks like. The renderer holds no repository and
// the engagement module knows nothing about PDFs; they meet at
// `RenderableDocument` and nowhere else.
//
// ── MONEY IS WRITTEN WITH ITS ISO CODE, NOT ITS SYMBOL ─────────────────────
//
// "INR 18,000.00", never "₹18,000.00", and this is now a PRODUCT decision
// rather than a technical one.
//
// It began as both. The built-in PDF fonts could not draw the rupee sign at
// all, so the ISO code was the only option — and T3.9 removed that constraint:
// the renderer carries Noto Sans latin-ext and draws ₹ perfectly well now.
//
// The choice stands anyway, on the reason that was always the stronger of the
// two. This is a CROSS-BORDER product — G1.8 exists because a letter issued by
// the US entity must not print Indian law — and the same invoice may be read in
// Dubai or Delaware by somebody for whom a bare symbol is ambiguous or simply
// unfamiliar. A three-letter ISO code is unambiguous everywhere, and a firm that
// wants the symbol can now have it by changing this one function.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { DocumentKind } from "../../domain/filestore/model";
import type { RenderableDocument, Section } from "../../domain/render/model";
import type { RenderSource } from "../../usecase/render/ports";

/** What this source can describe. Anything else is refused BY NAME rather than
 *  producing an empty document. */
const RENDERABLE: readonly DocumentKind[] = ["engagement_letter", "invoice"];

interface LetterRow {
  ref: string;
  title: string;
  jurisdiction: string;
  currency: string;
  background: string | null;
  issued_on: string | null;
  effective_from: string | null;
  signed_at: string | null;
  signed_by_name: string | null;
  signed_by_title: string | null;
  firm_signatory_title: string | null;
  created_at: string;
  client_name: string;
  entity_name: string;
  entity_jurisdiction: string | null;
}

interface LetterLineRow {
  description: string;
  quantity: string;
  unit_amount: string | null;
  discount_percent: string;
  billing_frequency: string | null;
  pricing_note: string | null;
  line_total: string | null;
}

interface BlockRow {
  kind: string;
  body: string;
  is_heading: boolean;
}

interface InvoiceRow {
  number: string;
  currency: string;
  issued_on: string | null;
  due_on: string | null;
  created_at: string;
  irn: string | null;
  client_name: string;
  entity_name: string;
  gross: string;
  discount: string;
  net: string;
  tax: string;
  total: string;
}

interface InvoiceLineRow {
  description: string;
  quantity: string;
  unit_amount: string;
  discount_percent: string;
  tax_percent: string;
  amount: string;
}

interface LogoRow {
  media_type: string;
  storage_key: string;
}

/**
 * A decimal string, grouped for reading, with its ISO code.
 *
 * The amount NEVER becomes a number: `Intl.NumberFormat` formats a decimal
 * string exactly, and `Number(amount)` would undo the whole arrangement at the
 * last possible moment — on a document a client is invoiced from.
 */
function money(amount: string | null, currency: string): string {
  // WORDS, not a dash, and certainly not an em dash. Two reasons: an em dash is
  // U+2014 and outside what the built-in PDF fonts can draw — the renderer's
  // own guard caught this on the first real document, which is what that guard
  // is for — and a dash in a fee column on a legal document is ambiguous
  // between "nothing" and "not stated". This says which.
  if (amount === null) return "Not stated";
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount as unknown as number);
  return `${currency} ${formatted}`;
}

/** ISO date to something a client reads. Deliberately not locale-dependent —
 *  the same document must render identically on every machine, which is the
 *  determinism requirement reaching all the way out to a date format. */
function longDate(iso: string | null): string {
  if (iso === null) return "Not stated";
  const [y, m, d] = iso.slice(0, 10).split("-");
  const months = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const monthName = months[Number(m) - 1] ?? m ?? "";
  return `${String(Number(d))} ${monthName} ${y ?? ""}`;
}

const FREQUENCY_LABELS: Readonly<Record<string, string>> = {
  one_time: "One-off",
  monthly: "Monthly",
  quarterly: "Quarterly",
  annually: "Annually",
  custom: "Custom",
};

export class PostgresRenderSource implements RenderSource {
  constructor(
    private readonly app: Db,
    /** Fetches a stored version's bytes — the firm's logo. Injected rather than
     *  read here, because the blob store is the document store's business and
     *  this adapter should not learn where bytes live. */
    private readonly readBlob: (input: {
      tenantId: string;
      storageKey: string;
    }) => Promise<Uint8Array | null>,
  ) {}

  supports(kind: DocumentKind): boolean {
    return RENDERABLE.includes(kind);
  }

  async describe(input: {
    readonly tenantId: string;
    readonly kind: DocumentKind;
    readonly subjectRef: string;
  }): Promise<RenderableDocument | null> {
    if (input.kind === "engagement_letter") return this.letter(input.tenantId, input.subjectRef);
    if (input.kind === "invoice") return this.invoice(input.tenantId, input.subjectRef);
    return null;
  }

  private async letter(tenantId: string, letterId: string): Promise<RenderableDocument | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<LetterRow[]>`
        SELECT el.ref, el.title, el.jurisdiction, el.currency, el.background,
               el.issued_on::text, el.effective_from::text, el.signed_at::text,
               el.signed_by_name, el.signed_by_title, el.firm_signatory_title,
               el.created_at::text,
               client.display_name AS client_name,
               entity.display_name AS entity_name,
               le.jurisdiction     AS entity_jurisdiction
        FROM crm.engagement_letter el
        JOIN core.party client ON client.id = el.party_id
        JOIN core.party entity ON entity.id = el.issuing_entity_party_id
        LEFT JOIN core.legal_entity le ON le.party_id = entity.id
        WHERE el.id = ${letterId}
      `;
      if (!row) return null;

      const lines = await db<LetterLineRow[]>`
        SELECT l.description, l.quantity::text, l.unit_amount::text,
               l.discount_percent::text, l.billing_frequency, l.pricing_note,
               CASE WHEN l.unit_amount IS NULL THEN NULL
                    ELSE round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100), 2)::text
               END AS line_total
        FROM crm.engagement_letter_line l
        WHERE l.engagement_letter_id = ${letterId} AND l.removed_at IS NULL
        ORDER BY l.position
      `;

      const blocks = await db<BlockRow[]>`
        SELECT kind, body, is_heading
        FROM crm.document_block
        WHERE engagement_letter_id = ${letterId} AND removed_at IS NULL
        ORDER BY sort_order
      `;

      const sections: Section[] = [];
      if (row.background !== null && row.background.trim() !== "") {
        sections.push({ heading: "Background", paragraphs: [row.background] });
      }
      // The firm's own prose, grouped by kind and in the firm's own order. A
      // heading block starts a section rather than becoming a paragraph — that
      // is what `is_heading` is for (G1.7).
      const byKind = new Map<string, string[]>();
      for (const b of blocks) {
        const label = b.is_heading ? b.body : null;
        if (label !== null) {
          byKind.set(label, []);
          continue;
        }
        const current = [...byKind.keys()].pop() ?? BLOCK_HEADINGS[b.kind] ?? "Terms";
        const list = byKind.get(current) ?? [];
        list.push(b.body);
        byKind.set(current, list);
      }
      for (const [heading, paragraphs] of byKind) {
        if (paragraphs.length > 0) sections.push({ heading, paragraphs });
      }

      const priced = lines.some((l) => l.line_total !== null);
      const subtotal = lines.reduce(
        (sum, l) => sum + (l.line_total === null ? 0 : Number(l.line_total)),
        0,
      );

      return {
        documentTitle: row.title,
        reference: row.ref,
        issuer: {
          name: row.entity_name,
          lines: [row.entity_jurisdiction === null ? "" : `Registered in ${row.entity_jurisdiction}`]
            .filter((l) => l !== ""),
        },
        recipient: { name: row.client_name, lines: [] },
        recipientLabel: "To",
        meta: [
          { label: "Dated", value: longDate(row.issued_on ?? row.created_at.slice(0, 10)) },
          { label: "Effective from", value: longDate(row.effective_from) },
          { label: "Governing law", value: row.jurisdiction },
        ],
        sections,
        table:
          lines.length === 0
            ? null
            : {
                columns: [
                  { label: "Service", align: "left", weight: 6 },
                  { label: "Billing", align: "left", weight: 2 },
                  { label: "Fee", align: "right", weight: 2 },
                ],
                rows: lines.map((l) => [
                  l.description,
                  l.billing_frequency === null
                    ? "Not stated"
                    : (FREQUENCY_LABELS[l.billing_frequency] ?? l.billing_frequency),
                  // An unpriced line prints its REASON, never a blank and never
                  // a zero. G1.6's rule carried onto paper: a blank in a fee
                  // column reads as free.
                  l.line_total === null
                    ? (l.pricing_note ?? "To be agreed")
                    : money(l.line_total, row.currency),
                ]),
              },
        totals: priced
          ? [{ label: "Total", value: money(subtotal.toFixed(2), row.currency), emphasis: true }]
          : [],
        footer: row.signed_by_name === null
          ? row.entity_name
          : `${row.entity_name}   ·   signed by ${row.signed_by_name}${row.signed_by_title === null ? "" : `, ${row.signed_by_title}`}`,
        logo: await this.logo(db, tenantId, letterId, "engagement_letter"),
        issuedOn: (row.issued_on ?? row.created_at).slice(0, 10),
      };
    });
  }

  private async invoice(tenantId: string, invoiceId: string): Promise<RenderableDocument | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<InvoiceRow[]>`
        SELECT i.number, i.currency, i.issued_on::text, i.due_on::text,
               i.created_at::text, i.irn,
               client.display_name AS client_name,
               entity.display_name AS entity_name,
               t.gross::text, t.discount::text, t.net::text, t.tax::text, t.total::text
        FROM crm.invoice i
        JOIN core.party client ON client.id = i.party_id
        JOIN core.party entity ON entity.id = i.entity_party_id
        JOIN crm.invoice_totals t ON t.invoice_id = i.id AND t.tenant_id = i.tenant_id
        WHERE i.id = ${invoiceId}
      `;
      if (!row) return null;

      const lines = await db<InvoiceLineRow[]>`
        SELECT l.description, l.quantity::text, l.unit_amount::text,
               l.discount_percent::text, l.tax_percent::text,
               a.net::text AS amount
        FROM crm.invoice_line l
        JOIN crm.invoice_line_amount a ON a.invoice_line_id = l.id
        WHERE l.invoice_id = ${invoiceId}
        ORDER BY l.position
      `;

      const meta = [
        { label: "Invoice date", value: longDate(row.issued_on ?? row.created_at.slice(0, 10)) },
        { label: "Due", value: longDate(row.due_on) },
      ];
      // The government registry's identifier, when the firm has recorded one.
      // Absent is ordinary — nothing in this product talks to the IRP yet.
      if (row.irn !== null) meta.push({ label: "IRN", value: row.irn });

      return {
        documentTitle: "Tax Invoice",
        reference: row.number,
        issuer: { name: row.entity_name, lines: [] },
        recipient: { name: row.client_name, lines: [] },
        recipientLabel: "Billed to",
        meta,
        sections: [],
        table: {
          columns: [
            { label: "Description", align: "left", weight: 6 },
            { label: "Qty", align: "right", weight: 1 },
            { label: "Rate", align: "right", weight: 2 },
            { label: "Amount", align: "right", weight: 2 },
          ],
          rows: lines.map((l) => [
            l.description,
            String(Number(l.quantity)),
            money(l.unit_amount, row.currency),
            money(l.amount, row.currency),
          ]),
        },
        totals: [
          { label: "Sub-total", value: money(row.gross, row.currency), emphasis: false },
          ...(Number(row.discount) > 0
            ? [{ label: "Discount", value: money(row.discount, row.currency), emphasis: false }]
            : []),
          ...(Number(row.tax) > 0
            ? [{ label: "Tax", value: money(row.tax, row.currency), emphasis: false }]
            : []),
          { label: "Total", value: money(row.total, row.currency), emphasis: true },
        ],
        footer: row.entity_name,
        logo: await this.logo(db, tenantId, invoiceId, "invoice"),
        issuedOn: (row.issued_on ?? row.created_at).slice(0, 10),
      };
    });
  }

  /**
   * The issuing entity's logo, if the firm has set one.
   *
   * Resolved through the issuing entity, which is G1.2's rule reaching the page:
   * a letter the US entity issued prints the US entity's mark. Null is an
   * ordinary answer — a firm that has uploaded nothing still gets a usable
   * document, which is why this never throws.
   */
  private async logo(
    db: Db,
    tenantId: string,
    subjectId: string,
    kind: "engagement_letter" | "invoice",
  ): Promise<RenderableDocument["logo"]> {
    const [row] =
      kind === "engagement_letter"
        ? await db<LogoRow[]>`
            SELECT v.media_type, v.storage_key
            FROM crm.engagement_letter el
            JOIN files.brand_asset b
              ON b.entity_party_id = el.issuing_entity_party_id
             AND b.tenant_id = el.tenant_id AND b.kind = 'logo' AND b.is_active
            JOIN files.document_version v ON v.id = b.document_version_id
            WHERE el.id = ${subjectId}
          `
        : await db<LogoRow[]>`
            SELECT v.media_type, v.storage_key
            FROM crm.invoice i
            JOIN files.brand_asset b
              ON b.entity_party_id = i.entity_party_id
             AND b.tenant_id = i.tenant_id AND b.kind = 'logo' AND b.is_active
            JOIN files.document_version v ON v.id = b.document_version_id
            WHERE i.id = ${subjectId}
          `;
    if (!row) return null;
    if (row.media_type !== "image/png" && row.media_type !== "image/jpeg") {
      // A PDF letterhead is a legitimate brand asset and is not something the
      // renderer can draw as an image. Skipped rather than refused: the
      // document is still correct without it.
      return null;
    }
    const bytes = await this.readBlob({ tenantId, storageKey: row.storage_key });
    if (bytes === null) return null;
    return { bytes, mediaType: row.media_type };
  }
}

const BLOCK_HEADINGS: Readonly<Record<string, string>> = {
  exclusion: "Exclusions",
  commercial: "Commercial terms",
  team: "The team",
};
