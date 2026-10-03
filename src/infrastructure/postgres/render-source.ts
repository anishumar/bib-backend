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
import { isLetterBillingTiming } from "../../domain/engagement/model";
import { readClauseBody, readServiceBody } from "../../domain/config/model";
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { DocumentKind } from "../../domain/filestore/model";
import type {
  BillingFrequency,
  BlockKind,
  DocumentTerms,
  OutOfPocketEstimate,
} from "../../domain/document/model";
import { resolveTerms } from "../../domain/document/model";
import type { FeeGroup, LetterLayout } from "../../domain/engagement/model";
import { planAnnexure } from "../../domain/engagement/annexure";
import type { AnnexurePlan, PlanLine } from "../../domain/engagement/annexure";
import { planProposal } from "../../domain/proposal/document";
import type { ProposalPlan } from "../../domain/proposal/document";
import type {
  CoverLine,
  Flow,
  RenderableDocument,
  RenderableImage,
  Section,
  SignatureBlock,
} from "../../domain/render/model";
import { isDrawableImage } from "../../domain/render/model";
import { CLIENT_DATE_ANCHOR, CLIENT_SIGN_ANCHOR } from "../../domain/render/model";
import type { DescribedDocument, RenderSource } from "../../usecase/render/ports";
import { isoInstant, utcDayOf, zoneDayOf } from "./instant";

/** A letter as its layout draws it; `letter` adds whether it went out. */
type LetterDrawn = Omit<DescribedDocument, "isOut">;

/** What this source can describe. Anything else is refused BY NAME rather than
 *  producing an empty document. */
const RENDERABLE: readonly DocumentKind[] = ["engagement_letter", "invoice", "proposal"];

interface LetterRow {
  /** Whose letter this is. Read for FILING the rendered PDF, never drawn on
   *  it — see `DescribedDocument`. */
  party_id: string;
  ref: string;
  title: string;
  /** Which layout it prints in (0083) — decides everything below the head. */
  layout: LetterLayout;
  /** Whether it is still a draft — the only state a preview fills in. */
  status: string;
  issuing_entity_party_id: string;
  /** The firm's standing signatory and the issuer's signature in force: what
   *  Send would pin, read for a draft's preview (2026-09-28). */
  standing_user_id: string | null;
  standing_title: string | null;
  standing_name: string | null;
  standing_email: string | null;
  standing_signature_version_id: string | null;
  jurisdiction: string;
  currency: string;
  background: string | null;
  advance_required: boolean;
  advance_amount: string | null;
  /** The person it is written to, by name — the Annexure letter's addressee
   *  and salutation. */
  addressee_name: string | null;
  /** The firm signatory's address, printed under their name on the Annexure
   *  letter's cover — "you may reach out to the undersigned". A read-time join,
   *  like the name, so an erased account stops resolving. */
  firm_signatory_email: string | null;
  issued_on: string | null;
  effective_from: string | null;
  signed_at: string | null;
  signed_by_name: string | null;
  signed_by_title: string | null;
  firm_signatory_title: string | null;
  firm_signatory_name: string | null;
  firm_signature_version_id: string | null;
  created_on: string;
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
  billing_timing: string | null;
  billing_on: string | null;
  pricing_note: string | null;
  line_total: string | null;
}

interface BlockRow {
  /** The block's id — the anchor a screen edits it by (`block:<id>`). */
  id: string;
  kind: string;
  body: string;
  is_heading: boolean;
}

interface ClauseRow {
  /** The body AS PINNED — the wording the client agreed to, never the library's
   *  wording today. Read through `readClauseBody`, which is the one function
   *  allowed to say what a clause body's shape is. */
  body: Record<string, unknown>;
}

interface InvoiceRow {
  /** Whose invoice this is. Read for FILING the rendered PDF, never drawn on
   *  it — see `DescribedDocument`. */
  party_id: string;
  /** Null on a draft: the number is drawn when it is issued (0322). */
  number: string | null;
  currency: string;
  issued_on: string | null;
  due_on: string | null;
  created_on: string;
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
    readonly asIfSentOn?: string | undefined;
  }): Promise<DescribedDocument | null> {
    if (input.kind === "engagement_letter") {
      return this.letter(input.tenantId, input.subjectRef, input.asIfSentOn);
    }
    if (input.kind === "invoice") return this.invoice(input.tenantId, input.subjectRef);
    if (input.kind === "proposal") {
      return this.proposal(input.tenantId, input.subjectRef, input.asIfSentOn);
    }
    return null;
  }

  /**
   * THE FIRM'S "PROPOSAL FOR SERVICES" (0084): a cover, then Background, the
   * in-scope services, the work in sections by the firm's own Dept, the
   * Summary of Fees and the Notes.
   *
   * Every word is the firm's or the client's own except the headings of the
   * firm's template and the sentences that restate a TERM the proposal holds —
   * a fee, an out-of-pocket range, the day it lapses. `planProposal` decides
   * the structure and is tested without a page.
   */
  private async proposal(
    tenantId: string,
    proposalId: string,
    asIfSentOn: string | undefined,
  ): Promise<DescribedDocument | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<ProposalHeadRow[]>`
        SELECT p.party_id, p.ref, p.title, p.currency, p.valid_until::text, p.background,
               p.issuing_entity_party_id, p.status, p.addressed_to_party_id,
               -- The FIRM's day (T6.18): a proposal sent at 02:15 in Delhi is
               -- dated that day, not the UTC day before.
               ${db.unsafe(zoneDayOf("p.sent_at", "firm.time_zone", "sent_on"))},
               ${db.unsafe(zoneDayOf("p.created_at", "firm.time_zone", "created_on"))},
               client.display_name AS client_name,
               entity.display_name AS entity_name,
               addressee.display_name AS addressee_name,
               -- Read-time joins, like the letter's signatory: an erased
               -- account stops resolving and the cover then names nobody.
               preparer.display_name AS preparer_name,
               preparer.email::text AS preparer_email
        FROM crm.proposal p
        JOIN core.party client ON client.id = p.party_id
        JOIN core.party entity ON entity.id = p.issuing_entity_party_id
        JOIN tenancy.tenant firm ON firm.id = p.tenant_id
        LEFT JOIN core.party addressee ON addressee.id = p.addressed_to_party_id
        LEFT JOIN tenancy.user_account preparer ON preparer.id = p.prepared_by_user_id
        WHERE p.id = ${proposalId}
      `;
      if (!row) return null;

      const lines = await db<ProposalLineRow[]>`
        SELECT l.id, l.position, l.description, l.billing_frequency, l.pricing_note,
               l.scope_override, l.client_obligations_override, l.volume_limits_override,
               l.exclusions_override, l.oop_estimate_min::text, l.oop_estimate_max::text,
               l.oop_currency,
               CASE WHEN l.unit_amount IS NULL THEN NULL
                    ELSE round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100), 2)::text
               END AS line_total,
               entity.display_name AS subject,
               v.body AS service_body
        FROM crm.proposal_line l
        JOIN config.version v ON v.id = l.service_version_id
        -- LEFT: a proposal line may name no company — a prospect may hold none.
        LEFT JOIN core.party entity ON entity.id = l.entity_party_id
        WHERE l.proposal_id = ${proposalId} AND l.removed_at IS NULL
        ORDER BY l.position
      `;

      // THE MONEY PER FREQUENCY (T6.18, D8), summed by the database from the
      // same per-line view the staff read's `totalsByFrequency` comes from, so
      // the paper and the screen print one set of figures.
      const byFrequency = await db<
        { frequency: string | null; net: string | null; unpriced: number }[]
      >`
        SELECT l.billing_frequency AS frequency, sum(a.net)::text AS net,
               (count(*) FILTER (WHERE l.unit_amount IS NULL))::int AS unpriced
        FROM crm.proposal_line l
        JOIN crm.proposal_line_amount a ON a.id = l.id
        WHERE l.proposal_id = ${proposalId} AND l.removed_at IS NULL
        GROUP BY l.billing_frequency
        ORDER BY coalesce(array_position(
                   ARRAY['monthly', 'quarterly', 'annually', 'one_time', 'custom'],
                   l.billing_frequency::text), 99)
      `;

      // The firm's Depts, retired ones included: a quote pinned to a Dept the
      // firm has since retired still names it.
      const depts = await db<{ code: string; name: string; sort_order: number }[]>`
        SELECT code, name, sort_order FROM tenancy.service_axis WHERE axis = 'dept'
      `;

      const blocks = await db<BlockRow[]>`
        SELECT id, kind, body, is_heading
        FROM crm.document_block
        WHERE proposal_id = ${proposalId} AND removed_at IS NULL
        ORDER BY sort_order
      `;

      const plan = planProposal({
        depts: depts.map((d) => ({ code: d.code, name: d.name, sortOrder: d.sort_order })),
        lines: lines.map((l) => {
          const service = readServiceBody(l.service_body);
          return {
            id: l.id,
            position: l.position,
            // The PINNED version's code and Dept — what the catalogue said when
            // the service was quoted.
            ref: service.ref,
            deptCode: service.module,
            description: l.description,
            subject: l.subject,
            // OVERRIDE ELSE THE PINNED CATALOGUE — the proposal screen's own
            // resolution, so the page and the PDF cannot differ.
            terms: resolveTerms(
              {
                scope: l.scope_override,
                clientObligations: l.client_obligations_override,
                volumeLimits: l.volume_limits_override,
                exclusions: l.exclusions_override,
              },
              service,
            ),
            billingFrequency: l.billing_frequency,
            net: l.line_total,
            pricingNote: l.pricing_note,
            oopEstimate:
              l.oop_estimate_min === null || l.oop_estimate_max === null || l.oop_currency === null
                ? null
                : { min: l.oop_estimate_min, max: l.oop_estimate_max, currency: l.oop_currency },
          };
        }),
      });

      const byKind = (kind: BlockKind): BlockRow[] => blocks.filter((b) => b.kind === kind);
      const notes = [
        ...noteFlow("Team Deployment", byKind("team"), "team"),
        ...noteFlow("General scope exclusions", byKind("exclusion"), "exclusion"),
        ...noteFlow("Commercials", byKind("commercial"), "commercial"),
      ];

      // A PREVIEW of a draft is dated the day Send will date it (the firm's
      // day, `zoneDayOf(sent_at)` above): nothing else about a proposal moves
      // when it is sent, so an unedited draft previews Send's own bytes.
      const previewing = asIfSentOn !== undefined && row.status === "draft";
      const issuedOn = previewing ? asIfSentOn : (row.sent_on ?? row.created_on);
      const cover = await this.brandImage(db, tenantId, row.issuing_entity_party_id, "proposal_cover");

      const preparedBy: CoverLine[] = [];
      if (row.preparer_name !== null) preparedBy.push({ text: row.preparer_name, bold: true });
      preparedBy.push({ text: row.entity_name, bold: true });
      if (row.preparer_email !== null) preparedBy.push({ text: row.preparer_email, bold: false });

      const document: RenderableDocument = {
        documentTitle: "Proposal",
        reference: row.ref,
        issuer: { name: row.entity_name, lines: [] },
        recipient: { name: row.client_name, lines: [] },
        recipientLabel: "Prepared for",
        meta: [],
        sections: [],
        table: null,
        totals: [],
        // No footer: the firm's template carries none, and every page after the
        // cover already names the reference beside the logo.
        footer: null,
        proposal: {
          cover: {
            artwork: cover,
            title: "Proposal for Services",
            subtitle: row.title,
            // The person, then the client — ONCE when they are the same party:
            // a person who is the client, addressed to themselves, printed
            // "Asha Verma / Asha Verma" (2026-09-28).
            preparedFor: [
              ...(row.addressee_name === null || row.addressed_to_party_id === row.party_id
                ? []
                : [{ text: row.addressee_name, bold: true }]),
              { text: row.client_name, bold: true },
            ],
            preparedBy,
            anchors: {
              subtitle: "proposal.title",
              preparedFor: "proposal.preparedFor",
              preparedBy: "proposal.preparedBy",
            },
          },
          running: `${row.ref}  ·  ${longDate(issuedOn)}`,
          flow: [
            ...(row.background === null || row.background.trim() === ""
              ? []
              : [heading(1, "Background", "proposal.background"), paragraph(row.background, false, "proposal.background")]),
            ...inScopeFlow(plan),
            ...proposalSectionsFlow(plan, row.currency),
            ...proposalFeesFlow(plan, row.currency),
            ...proposalTotalsFlow(byFrequency, row.currency),
            ...(row.valid_until === null
              ? []
              : [paragraph(`This proposal is valid until ${longDate(row.valid_until)}.`, true, "proposal.validUntil")]),
            ...(notes.length === 0 ? [] : [heading(1, "Notes"), ...notes]),
          ],
        },
        logo: await this.brandImage(db, tenantId, row.issuing_entity_party_id, "logo"),
        issuedOn,
      };
      return {
        document,
        partyId: row.party_id,
        isOut: row.status !== "draft",
        issuingEntity: { partyId: row.issuing_entity_party_id, name: row.entity_name },
        ...(previewing ? { datedAsIfSent: issuedOn } : {}),
      };
    });
  }

  /**
   * One of the issuing entity's marks in force now — its logo or its proposal
   * cover — or null. "In force now" is the right question for a proposal: it
   * is an offer, re-rendered whenever the firm presses the button, and never
   * evidence the way a signed letter's pinned signature is. A media type the
   * renderer cannot draw is skipped rather than refused (the upload refuses
   * it now; older rows may hold anything).
   */
  private async brandImage(
    db: Db,
    tenantId: string,
    entityPartyId: string,
    kind: "logo" | "proposal_cover",
  ): Promise<RenderableImage | null> {
    const [row] = await db<LogoRow[]>`
      SELECT v.media_type, v.storage_key
      FROM files.brand_asset b
      JOIN files.document_version v ON v.id = b.document_version_id
      WHERE b.entity_party_id = ${entityPartyId} AND b.kind = ${kind} AND b.is_active
    `;
    if (!row || !isDrawableImage(row.media_type)) return null;
    const bytes = await this.readBlob({ tenantId, storageKey: row.storage_key });
    if (bytes === null) return null;
    return { bytes, mediaType: row.media_type };
  }

  private async letter(
    tenantId: string,
    letterId: string,
    asIfSentOn: string | undefined,
  ): Promise<DescribedDocument | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [head] = await db<LetterRow[]>`
        SELECT el.party_id, el.ref, el.title, el.layout, el.jurisdiction, el.currency,
               el.status, el.issuing_entity_party_id,
               -- WHO SEND WOULD SIGN FOR THE FIRM, read for a draft's preview
               -- only: the standing signatory on the tenant and the issuer's
               -- signature in force — the two things Send pins (0081).
               firm.firm_signatory_user_id AS standing_user_id,
               firm.firm_signatory_title AS standing_title,
               standing.display_name AS standing_name,
               standing.email::text AS standing_email,
               (SELECT b.document_version_id FROM files.brand_asset b
                 WHERE b.entity_party_id = el.issuing_entity_party_id
                   AND b.tenant_id = el.tenant_id AND b.kind = 'signature' AND b.is_active
               ) AS standing_signature_version_id,
               el.background, el.advance_required, el.advance_amount::text,
               addressee.display_name AS addressee_name,
               signatory.email::text AS firm_signatory_email,
               el.issued_on::text, el.effective_from::text,
               ${db.unsafe(isoInstant("el.signed_at", "signed_at"))},
               el.signed_by_name, el.signed_by_title, el.firm_signatory_title,
               el.firm_signature_version_id,
               ${db.unsafe(utcDayOf("el.created_at", "created_on"))},
               client.display_name AS client_name,
               entity.display_name AS entity_name,
               le.jurisdiction     AS entity_jurisdiction,
               -- The firm's signatory BY NAME, a read-time join like the
               -- ledger's actor: the letter snapshots the account and the
               -- capacity, and an erased account stops resolving.
               signatory.display_name AS firm_signatory_name
        FROM crm.engagement_letter el
        JOIN core.party client ON client.id = el.party_id
        JOIN core.party entity ON entity.id = el.issuing_entity_party_id
        JOIN tenancy.tenant firm ON firm.id = el.tenant_id
        LEFT JOIN core.legal_entity le ON le.party_id = entity.id
        LEFT JOIN tenancy.user_account signatory ON signatory.id = el.firm_signatory_user_id
        LEFT JOIN tenancy.user_account standing ON standing.id = firm.firm_signatory_user_id
        LEFT JOIN core.party addressee ON addressee.id = el.addressed_to_party_id
        WHERE el.id = ${letterId}
      `;
      if (!head) return null;

      // A PREVIEW of a draft reads as Send will leave it (2026-09-28): dated on
      // the day given unless the drafter set a date, and carrying the firm's
      // block when the firm names a signatory — exactly what `send` stamps
      // (`EngagementService.send`, `markSent`). A letter already out is its
      // frozen self, and so is a draft rendered for filing.
      const previewing = asIfSentOn !== undefined && head.status === "draft";
      const standing = previewing && head.standing_user_id !== null && head.standing_title !== null;
      const row: LetterRow = !previewing
        ? head
        : {
            ...head,
            issued_on: head.issued_on ?? asIfSentOn ?? null,
            firm_signatory_title: standing ? head.standing_title : null,
            firm_signatory_name: standing ? head.standing_name : null,
            firm_signatory_email: standing ? head.standing_email : null,
            firm_signature_version_id: standing ? head.standing_signature_version_id : null,
          };
      const described = await this.letterDocument(db, tenantId, letterId, row);
      return {
        ...described,
        isOut: head.status !== "draft",
        issuingEntity: { partyId: row.issuing_entity_party_id, name: row.entity_name },
        // Only when the preview supplied the date: a date the drafter set is
        // the letter's own, and prints the same either way.
        ...(previewing && head.issued_on === null && row.issued_on !== null
          ? { datedAsIfSent: row.issued_on }
          : {}),
      };
    });
  }

  private async letterDocument(
    db: Db,
    tenantId: string,
    letterId: string,
    row: LetterRow,
  ): Promise<LetterDrawn> {

    // THE LAYOUT DECIDES THE DOCUMENT (0083). Everything below this branch is
    // the classic letter exactly as it was, because a letter issued in it
    // must re-render as the document its client holds.
    if (row.layout === "annexure") return this.annexureLetter(db, tenantId, letterId, row);

    const lines = await db<LetterLineRow[]>`
      SELECT l.description, l.quantity::text, l.unit_amount::text,
             l.discount_percent::text, l.billing_frequency, l.pricing_note,
             l.billing_timing, l.billing_on::text AS billing_on,
             CASE WHEN l.unit_amount IS NULL THEN NULL
                  ELSE round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100), 2)::text
             END AS line_total
      FROM crm.engagement_letter_line l
      WHERE l.engagement_letter_id = ${letterId} AND l.removed_at IS NULL
      ORDER BY l.position
    `;

    const blocks = await db<BlockRow[]>`
      SELECT id, kind, body, is_heading
      FROM crm.document_block
      WHERE engagement_letter_id = ${letterId} AND removed_at IS NULL
      ORDER BY sort_order
    `;

    // THE TERMS, AS PINNED. This join is what puts a contract's actual terms on
    // the contract: until it existed the renderer read `crm.document_block`
    // and nothing else, so Confidentiality, Client responsibilities and every
    // other clause were shown on the firm's screen, frozen into the content
    // hash, checked against the issuing entity's law by `addClause` — and
    // absent from the PDF the client was sent and signed. `crm.engagement_letter`
    // refuses to go out without clauses precisely because "a signed contract
    // with no terms is enforceable as whatever a court reads into it", and
    // that refusal was guarding a document that then printed none of them.
    //
    // Through `config.version`, exactly as `EngagementRepository` reads them,
    // because a signed letter must show what was AGREED and not what the
    // library says today.
    const clauses = await db<ClauseRow[]>`
      SELECT v.body
      FROM crm.engagement_letter_clause c
      JOIN config.version v ON v.id = c.clause_version_id
      WHERE c.engagement_letter_id = ${letterId}
      ORDER BY c.position
    `;

    const sections: Section[] = [];
    if (row.background !== null && row.background.trim() !== "") {
      sections.push({ heading: "Background", paragraphs: [row.background] });
    }
    // The firm's own prose, grouped by kind and in the firm's own order. A
    // heading block starts a section rather than becoming a paragraph — that
    // is what `is_heading` is for (G1.7).
    //
    // A CHANGE OF KIND ALSO STARTS ONE, and leaving that out was a real bug.
    // This walked the map's keys and took the LAST one inserted, consulting
    // `BLOCK_HEADINGS` only while the map was still EMPTY — so the kind chose
    // a heading for the first section and never again. Every block after the
    // first heading landed under it whatever its kind, which on the firm's own
    // letter printed "Invoices are payable within 15 days of issue" — a
    // commercial term — under the heading "Engagement Partner". The document
    // was not wrong about its words, it was wrong about what they were about.
    const built: { heading: string; kind: string; paragraphs: string[] }[] = [];
    let open: { heading: string; kind: string; paragraphs: string[] } | null = null;
    for (const b of blocks) {
      // The firm's own heading wins over the derived one, and it stays open
      // for every block of ITS kind that follows — the team block is a table
      // with headings, which is what `is_heading` was built for.
      if (b.is_heading) {
        open = { heading: b.body, kind: b.kind, paragraphs: [] };
        built.push(open);
        continue;
      }
      if (open === null || open.kind !== b.kind) {
        open = { heading: BLOCK_HEADINGS[b.kind] ?? "Terms", kind: b.kind, paragraphs: [] };
        built.push(open);
      }
      open.paragraphs.push(b.body);
    }
    for (const section of built) {
      if (section.paragraphs.length > 0) {
        sections.push({ heading: section.heading, paragraphs: section.paragraphs });
      }
    }

    // THE TOTALS, ONE PER FREQUENCY, SUMMED BY THE DATABASE (B46, audit
    // 2026-10-03). This was `Number()` summed and `toFixed(2)`: binary
    // floating point on money, and one "Total" adding a monthly fee to a
    // one-off one, which is a figure nobody owes. A letter whose priced lines
    // all bill alike keeps its one "Total", the same figure as before.
    const byFrequency = await db<{ frequency: string | null; total: string }[]>`
      SELECT l.billing_frequency AS frequency,
             sum(round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100), 2))::text AS total
        FROM crm.engagement_letter_line l
       WHERE l.engagement_letter_id = ${letterId} AND l.removed_at IS NULL AND l.unit_amount IS NOT NULL
       GROUP BY l.billing_frequency
       ORDER BY coalesce(array_position(
                  ARRAY['monthly', 'quarterly', 'annually', 'one_time', 'custom'],
                  l.billing_frequency::text), 99)
    `;

    const document: RenderableDocument = {
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
        { label: "Dated", value: longDate(row.issued_on ?? row.created_on) },
        { label: "Effective from", value: longDate(row.effective_from) },
        { label: "Governing law", value: row.jurisdiction },
      ],
      sections,
      // Heading + body, the same shape the firm's prose takes, so the renderer
      // draws a term exactly as it draws an exclusion. The TITLE is the
      // heading: a clause whose words print with no name is one nobody can
      // refer to in the conversation where it matters.
      terms: clauses.map((c) => {
        const clause = readClauseBody(c.body);
        return { heading: clause.title, paragraphs: [clause.text] };
      }),
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
                  : (FREQUENCY_LABELS[l.billing_frequency] ?? l.billing_frequency) +
                    // When it is invoiced (0319), printed only when the letter
                    // says: a letter without it renders byte for byte as before.
                    withComma(billedWhen(l.billing_frequency, l.billing_timing, l.billing_on)),
                // An unpriced line prints its REASON, never a blank and never
                // a zero. G1.6's rule carried onto paper: a blank in a fee
                // column reads as free.
                l.line_total === null
                  ? (l.pricing_note ?? "To be agreed")
                  : money(l.line_total, row.currency),
              ]),
            },
      totals:
        byFrequency.length === 1
          ? [{ label: "Total", value: money(byFrequency[0]?.total ?? "0", row.currency), emphasis: true }]
          : byFrequency.map((f) => ({
              label: `Total, ${(f.frequency === null ? "frequency not stated" : (FREQUENCY_LABELS[f.frequency] ?? f.frequency)).toLowerCase()}`,
              value: money(f.total, row.currency),
              emphasis: true,
            })),
      footer: row.signed_by_name === null
        ? row.entity_name
        : `${row.entity_name}   ·   signed by ${row.signed_by_name}${row.signed_by_title === null ? "" : `, ${row.signed_by_title}`}`,
      // BOTH halves of the signature block. The firm's prints once the
      // letter has gone out carrying it (0022 snapshots it at send); the
      // client's always prints, with the anchors DocuSign places its fields
      // on — invisible on paper, and harmless on a letter signed in ink.
      signatures: [
        ...(row.firm_signatory_title === null
          ? []
          : [
              {
                heading: `For ${row.entity_name}`,
                lines: [row.firm_signatory_name ?? "", row.firm_signatory_title].filter(
                  (l) => l.trim() !== "",
                ),
                // THE MARK THIS LETTER WAS ISSUED UNDER (0081), read from the
                // version PINNED at send and never from whatever is active
                // now. On the firm's block only: the client's is signed by
                // the provider, and drawing anything on a line the client has
                // not signed would be a forgery this product produced itself.
                image: await this.signature(db, tenantId, row.firm_signature_version_id),
                signAnchor: null,
                dateAnchor: null,
              },
            ]),
        {
          heading: `Accepted for and on behalf of ${row.client_name}`,
          lines: [
            row.signed_by_name === null
              ? "Name and capacity"
              : `${row.signed_by_name}${row.signed_by_title === null ? "" : `, ${row.signed_by_title}`}`,
          ],
          signAnchor: CLIENT_SIGN_ANCHOR,
          dateAnchor: CLIENT_DATE_ANCHOR,
        },
      ],
      logo: await this.logo(db, tenantId, letterId, "engagement_letter"),
      issuedOn: row.issued_on ?? row.created_on,
    };
    return { document, partyId: row.party_id };
  }

  /**
   * THE FIRM'S OWN FORMAT (0083): a cover letter, Annexure 1 — scope,
   * deliverables and fees — and Annexure 2, the terms.
   *
   * What goes WHERE follows the firm's template (the MyDojo letter of July 2026)
   * and every word on it is the firm's or the client's own: the cover and
   * acceptance paragraphs are the letter's own blocks, the scope is each line's
   * four blocks, the fee groups are the letter's sections. The only sentences
   * this product writes are the ones that restate a TERM the letter already
   * holds — the advance, an out-of-pocket range, which companies a service is
   * for — because a term that is hashed and frozen and absent from the PDF is
   * exactly the failure the terms join above was built to end.
   */
  private async annexureLetter(
    db: Db,
    tenantId: string,
    letterId: string,
    row: LetterRow,
  ): Promise<LetterDrawn> {
    const lines = await db<AnnexureLineRow[]>`
      SELECT l.id, l.position, l.fee_group_id, l.entity_party_id,
             entity.display_name AS entity_name, l.service_version_id, l.description,
             l.billing_frequency, l.effective_from::text, l.pricing_note,
             l.scope_override, l.client_obligations_override, l.volume_limits_override,
             l.exclusions_override, l.oop_estimate_min::text, l.oop_estimate_max::text,
             l.oop_currency, l.billing_timing, l.billing_on::text AS billing_on,
             l.advance_amount::text AS advance_amount,
             CASE WHEN l.unit_amount IS NULL THEN NULL
                  ELSE round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100), 2)::text
             END AS line_total,
             v.body AS service_body
      FROM crm.engagement_letter_line l
      JOIN core.party entity ON entity.id = l.entity_party_id
      JOIN config.version v ON v.id = l.service_version_id
      WHERE l.engagement_letter_id = ${letterId} AND l.removed_at IS NULL
      ORDER BY l.position
    `;

    const groups = await db<AnnexureGroupRow[]>`
      SELECT id, tenant_id, engagement_letter_id, position, title, billing_frequency,
             amount::text, currency, payment_terms, fee_description, intro, deliverables,
             client_obligations, billing_timing, billing_on::text AS billing_on
      FROM crm.engagement_letter_fee_group
      WHERE engagement_letter_id = ${letterId} AND removed_at IS NULL
      ORDER BY position
    `;

    const blocks = await db<BlockRow[]>`
      SELECT id, kind, body, is_heading
      FROM crm.document_block
      WHERE engagement_letter_id = ${letterId} AND removed_at IS NULL
      ORDER BY sort_order
    `;

    // As pinned, exactly as the classic letter reads them.
    const clauses = await db<ClauseRow[]>`
      SELECT v.body
      FROM crm.engagement_letter_clause c
      JOIN config.version v ON v.id = c.clause_version_id
      WHERE c.engagement_letter_id = ${letterId}
      ORDER BY c.position
    `;

    const plan = planAnnexure({
      letterEffectiveFrom: row.effective_from,
      feeGroups: groups.map(toFeeGroup),
      lines: lines.map(
        (l): PlanLine => ({
          id: l.id,
          position: l.position,
          feeGroupId: l.fee_group_id,
          entityPartyId: l.entity_party_id,
          entityName: l.entity_name,
          serviceVersionId: l.service_version_id,
          description: l.description,
          // OVERRIDE ELSE THE PINNED CATALOGUE — the same resolution the
          // letter's own screen shows, so the page and the PDF cannot differ.
          terms: resolveTerms(
            {
              scope: l.scope_override,
              clientObligations: l.client_obligations_override,
              volumeLimits: l.volume_limits_override,
              exclusions: l.exclusions_override,
            },
            readServiceBody(l.service_body),
          ),
          billingFrequency: l.billing_frequency,
          billingTiming: isLetterBillingTiming(l.billing_timing) ? l.billing_timing : null,
          billingOn: l.billing_on,
          effectiveFrom: l.effective_from,
          net: l.line_total,
          pricingNote: l.pricing_note,
          oopEstimate:
            l.oop_estimate_min === null || l.oop_estimate_max === null || l.oop_currency === null
              ? null
              : { min: l.oop_estimate_min, max: l.oop_estimate_max, currency: l.oop_currency },
        }),
      ),
    });

    const byKind = (kind: BlockKind): BlockRow[] => blocks.filter((b) => b.kind === kind);

    // The companies the client signs for besides itself — every company a line
    // is for, in the order the letter lists them.
    const others: string[] = [];
    for (const l of lines) {
      if (l.entity_party_id !== row.party_id && !others.includes(l.entity_name)) {
        others.push(l.entity_name);
      }
    }

    const firm: SignatureBlock | null =
      row.firm_signatory_title === null
        ? null
        : {
            heading: `For ${row.entity_name}`,
            lines: [row.firm_signatory_name ?? "", row.firm_signatory_title, row.firm_signatory_email ?? ""]
              .filter((l) => l.trim() !== ""),
            // Pinned at send, never looked up now (0081) — the classic letter's
            // rule, for the same reason.
            image: await this.signature(db, tenantId, row.firm_signature_version_id),
            signAnchor: null,
            dateAnchor: null,
          };

    const document: RenderableDocument = {
      documentTitle: row.title,
      reference: row.ref,
      issuer: {
        name: row.entity_name,
        lines: [row.entity_jurisdiction === null ? "" : `Registered in ${row.entity_jurisdiction}`]
          .filter((l) => l !== ""),
      },
      recipient: { name: row.client_name, lines: [] },
      recipientLabel: "To",
      meta: [],
      sections: [],
      table: null,
      totals: [],
      footer: row.signed_by_name === null
        ? row.entity_name
        : `${row.entity_name}   ·   signed by ${row.signed_by_name}${row.signed_by_title === null ? "" : `, ${row.signed_by_title}`}`,
      annexureLetter: {
        cover: {
          dateLine: `Dated ${longDate(row.issued_on ?? row.created_on)}`,
          addressee: [row.addressee_name, row.client_name].filter((l): l is string => l !== null),
          subject:
            `Subject: ${row.title}` +
            (row.effective_from === null
              ? ""
              : ` — period commencing ${longDate(row.effective_from)}`),
          salutation:
            row.addressee_name === null ? "Dear Sir or Madam," : `Dear ${row.addressee_name},`,
          body: blockFlow(byKind("cover"), false),
          closing: "Yours sincerely,",
          firm,
          acceptanceHeading: "Acceptance",
          acceptance: blockFlow(byKind("acceptance"), false),
          anchors: {
            date: "letter.issuedOn",
            addressee: "letter.addressedTo",
            subject: "letter.subject",
            salutation: "letter.addressedTo",
          },
          client: {
            // WHO the client signs for, which is every company a line is for:
            // G0.1 makes a group's work one line per company, and a signature
            // that named only the parent would bind the parent alone.
            heading:
              `Accepted for and on behalf of ${row.client_name}` +
              (others.length === 0 ? "" : `, for itself and on behalf of ${andList(others)}`),
            lines: [
              row.signed_by_name === null
                ? "Name and capacity"
                : `${row.signed_by_name}${row.signed_by_title === null ? "" : `, ${row.signed_by_title}`}`,
            ],
            signAnchor: CLIENT_SIGN_ANCHOR,
            dateAnchor: CLIENT_DATE_ANCHOR,
          },
        },
        annexures: [
          {
            label: "Annexure 1",
            title: "Scope of Services, Deliverables & Fees",
            flow: [
              ...(row.background === null || row.background.trim() === ""
                ? []
                : [heading(1, "Background", "letter.background"), paragraph(row.background, false, "letter.background")]),
              ...scopeFlow(plan),
              ...feesFlow(
                plan,
                row,
                lines.flatMap((l) =>
                  l.advance_amount === null ? [] : [{ description: l.description, amount: l.advance_amount }],
                ),
              ),
              ...titledBlocks("Commercials", byKind("commercial"), "commercial"),
              ...titledBlocks("Team deployment", byKind("team"), "team"),
              ...titledBlocks("General scope exclusions", byKind("exclusion"), "exclusion"),
            ],
          },
          {
            label: "Annexure 2",
            title: "Standard Terms & Conditions",
            flow:
              clauses.length === 0
                ? [paragraph("No terms have been added to this letter yet.", true)]
                : clauses.flatMap((c, i) => {
                    const clause = readClauseBody(c.body);
                    // NUMBERED, because "clause 8" is how a term is referred to
                    // in the conversation where it matters.
                    return [heading(2, `${String(i + 1)}. ${clause.title}`), paragraph(clause.text)];
                  }),
          },
        ],
      },
      logo: await this.logo(db, tenantId, letterId, "engagement_letter"),
      issuedOn: row.issued_on ?? row.created_on,
    };
    return { document, partyId: row.party_id };
  }

  private async invoice(tenantId: string, invoiceId: string): Promise<DescribedDocument | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<InvoiceRow[]>`
        SELECT i.party_id, i.number, i.currency, i.issued_on::text, i.due_on::text,
               ${db.unsafe(utcDayOf("i.created_at", "created_on"))}, i.irn,
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
        { label: "Invoice date", value: longDate(row.issued_on ?? row.created_on) },
        { label: "Due", value: longDate(row.due_on) },
      ];
      // The government registry's identifier, when the firm has recorded one.
      // Absent is ordinary — nothing in this product talks to the IRP yet.
      if (row.irn !== null) meta.push({ label: "IRN", value: row.irn });
      // The engagement letters the lines bill (0318), so a reader can trace
      // the invoice to what the client signed. Only when a line names one: an
      // invoice for a recharge with no engagement prints exactly as before.
      const letters = await db<{ ref: string }[]>`
        SELECT DISTINCT l.ref
          FROM crm.invoice_line il
          JOIN crm.engagement eg ON eg.id = il.engagement_id AND eg.tenant_id = il.tenant_id
          JOIN crm.engagement_letter l ON l.id = eg.engagement_letter_id AND l.tenant_id = eg.tenant_id
         WHERE il.invoice_id = ${invoiceId} AND il.removed_at IS NULL
         ORDER BY l.ref
      `;
      if (letters.length > 0) {
        meta.push({ label: "Engagement letter", value: letters.map((l) => l.ref).join(", ") });
      }

      const document: RenderableDocument = {
        documentTitle: "Tax Invoice",
        // A draft has no number until it is issued (0322); its preview says so.
        reference: row.number ?? "Draft",
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
        issuedOn: row.issued_on ?? row.created_on,
      };
      // Issued means dated: `issued_on` is written by Issue and by nothing
      // else, and a draft cancelled before it was issued never went out.
      return { document, partyId: row.party_id, isOut: row.issued_on !== null };
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
  /**
   * The firm's signature image for ONE letter, by the version it pinned (0081).
   *
   * By VERSION ID and with no `is_active` anywhere: that flag is what makes the
   * logo's lookup answer "the mark in force today", which is the right question
   * for a document being drafted and the wrong one for a document already
   * issued. Re-rendering a 2026 letter after a partner succeeded another must
   * not stamp the successor's signature over the predecessor's printed name.
   *
   * Null is ordinary — no pin, no upload, or a media type the renderer cannot
   * draw — and the block then prints the bare rule it printed before.
   */
  private async signature(
    db: Db,
    tenantId: string,
    versionId: string | null,
  ): Promise<RenderableImage | null> {
    if (versionId === null) return null;
    const [row] = await db<LogoRow[]>`
      SELECT v.media_type, v.storage_key
      FROM files.document_version v
      WHERE v.id = ${versionId}
    `;
    if (!row) return null;
    // Refused at upload since the brand screen learnt to (`BrandAssetNotDrawable`),
    // so this is the older assets' path rather than the ordinary one — and it
    // stays, because a letter pinned before that guard existed may point at any
    // media type at all.
    if (!isDrawableImage(row.media_type)) return null;
    const bytes = await this.readBlob({ tenantId, storageKey: row.storage_key });
    if (bytes === null) return null;
    return { bytes, mediaType: row.media_type };
  }

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

// ── The Annexure letter's pieces (0083) ─────────────────────────────────────

interface AnnexureLineRow {
  id: string;
  position: number;
  fee_group_id: string | null;
  entity_party_id: string;
  entity_name: string;
  service_version_id: string;
  description: string;
  billing_frequency: BillingFrequency | null;
  effective_from: string | null;
  pricing_note: string | null;
  scope_override: string | null;
  client_obligations_override: string | null;
  volume_limits_override: string | null;
  exclusions_override: string | null;
  oop_estimate_min: string | null;
  oop_estimate_max: string | null;
  oop_currency: string | null;
  line_total: string | null;
  service_body: Record<string, unknown>;
  billing_timing: string | null;
  billing_on: string | null;
  advance_amount: string | null;
}

interface AnnexureGroupRow {
  id: string;
  tenant_id: string;
  engagement_letter_id: string;
  position: number;
  title: string;
  billing_frequency: BillingFrequency;
  amount: string;
  currency: string;
  payment_terms: string | null;
  fee_description: string | null;
  intro: string | null;
  deliverables: string | null;
  client_obligations: string | null;
  billing_timing: string | null;
  billing_on: string | null;
}

function toFeeGroup(g: AnnexureGroupRow): FeeGroup {
  return {
    id: g.id,
    tenantId: g.tenant_id,
    engagementLetterId: g.engagement_letter_id,
    position: g.position,
    title: g.title,
    billingFrequency: g.billing_frequency,
    amount: g.amount,
    currency: g.currency,
    paymentTerms: g.payment_terms,
    feeDescription: g.fee_description,
    intro: g.intro,
    deliverables: g.deliverables,
    clientObligations: g.client_obligations,
    billingTiming: isLetterBillingTiming(g.billing_timing) ? g.billing_timing : null,
    billingOn: g.billing_on,
  };
}

/** A piece of running text. `anchor` names the piece of the record it prints,
 *  for a screen (never drawn) — see `Anchor` in the render model. */
function heading(level: 1 | 2 | 3, text: string, anchor?: string): Flow {
  return anchor === undefined ? { kind: "heading", level, text } : { kind: "heading", level, text, anchor };
}

function paragraph(text: string, muted = false, anchor?: string): Flow {
  return anchor === undefined ? { kind: "paragraph", text, muted } : { kind: "paragraph", text, muted, anchor };
}

/** A line's four texts, anchored to the line (the first line of an item that
 *  prints for several companies' lines: its editor changes them all). */
function termsFlow(terms: DocumentTerms, lineId: string | undefined): Flow[] {
  const out: Flow[] = [];
  const at = (field: string): string | undefined =>
    lineId === undefined ? undefined : `line:${lineId}.${field}`;
  if (terms.scope.text !== null) out.push(paragraph(terms.scope.text, false, at("scope")));
  if (terms.volumeLimits.text !== null) {
    out.push(heading(3, "Volume limits", at("volumeLimits")), paragraph(terms.volumeLimits.text, false, at("volumeLimits")));
  }
  if (terms.clientObligations.text !== null) {
    out.push(
      heading(3, "Client's responsibilities", at("clientObligations")),
      paragraph(terms.clientObligations.text, false, at("clientObligations")),
    );
  }
  if (terms.exclusions.text !== null) {
    out.push(heading(3, "Exclusions", at("exclusions")), paragraph(terms.exclusions.text, false, at("exclusions")));
  }
  return out;
}

/** "A", "A and B", "A, B and C" — how a letter names the companies it covers. */
function andList(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;
}

/** "For A, B and C." — ended with a full stop unless the last name already
 *  carries one ("MyDojo, Inc."), which would otherwise print twice. */
function forCompanies(names: readonly string[]): string {
  const list = andList(names);
  return `For ${list}${list.endsWith(".") ? "" : "."}`;
}

/**
 * The firm's own prose, as the Annexure letter prints it: a heading block is a
 * heading; every other line is a PARAGRAPH of the cover letter and the
 * acceptance, and an ITEM of a list everywhere else — which is how the firm's
 * template writes its commercials, its team and its exclusions.
 */
function blockFlow(rows: readonly BlockRow[], asList: boolean): Flow[] {
  return rows.map((b) => {
    const at = `block:${b.id}`;
    if (b.is_heading) return heading(2, b.body, at);
    if (!asList) return paragraph(b.body, false, at);
    // A bullet, and its own later lines indented to hang under it.
    const [first = "", ...rest] = b.body.split("\n");
    return paragraph([`- ${first}`, ...rest.map((l) => `  ${l}`)].join("\n"), false, at);
  });
}

/** A titled list of the letter's prose. The title is where a new line of that
 *  kind is added (`add:<kind>`). */
function titledBlocks(title: string, rows: readonly BlockRow[], kind: string): Flow[] {
  return rows.length === 0 ? [] : [heading(1, title, `add:${kind}`), ...blockFlow(rows, true)];
}

/** Every section and every numbered service in it. */
function scopeFlow(plan: AnnexurePlan): Flow[] {
  const out: Flow[] = [];
  for (const s of plan.sections) {
    const group = s.group;
    const section = (field: string): string | undefined =>
      group === null ? undefined : `section:${group.id}.${field}`;
    out.push(heading(1, `${s.code}. ${s.title}`, section("title")));
    if (s.entityNames !== null) out.push(paragraph(forCompanies(s.entityNames), true));
    if (group !== null && group.intro !== null) out.push(paragraph(group.intro, false, section("intro")));
    for (const item of s.items) {
      const first = item.lineIds[0];
      out.push(heading(2, `${item.code}. ${item.description}`, first === undefined ? undefined : `line:${first}.name`));
      if (item.entityNames !== null) out.push(paragraph(forCompanies(item.entityNames), true));
      if (item.beginsOn !== null) out.push(paragraph(`Begins ${longDate(item.beginsOn)}.`, true));
      out.push(...termsFlow(item.terms, first));
      if (item.oopEstimate !== null) out.push(paragraph(outOfPocket(item.oopEstimate), true));
    }
    if (group !== null && group.deliverables !== null) {
      out.push(
        heading(3, "Deliverables", section("deliverables")),
        paragraph(group.deliverables, false, section("deliverables")),
      );
    }
    if (group !== null && group.clientObligations !== null) {
      out.push(
        heading(3, "Client's responsibilities", section("clientObligations")),
        paragraph(group.clientObligations, false, section("clientObligations")),
      );
    }
  }
  return out;
}

/** The out-of-pocket range, restated: it is a term the client signs for. */
function outOfPocket(o: OutOfPocketEstimate): string {
  return (
    `Out-of-pocket expenses: approximately ${money(o.min, o.currency)} to ` +
    `${money(o.max, o.currency)}, reimbursed at actuals and not part of the fee.`
  );
}

const PER_PERIOD: Readonly<Record<string, string>> = {
  monthly: " per month",
  quarterly: " per quarter",
  annually: " per year",
};

/** The Summary of Fees: one row per fee group, one per line priced on its own. */
function feesFlow(
  plan: AnnexurePlan,
  row: LetterRow,
  lineAdvances: readonly { readonly description: string; readonly amount: string }[],
): Flow[] {
  const out: Flow[] = [heading(1, "Summary of Fees")];
  if (plan.fees.length === 0) {
    out.push(paragraph("No services have been added to this letter yet.", true));
  } else {
    out.push({
      kind: "table",
      table: {
        columns: [
          { label: "Section", align: "left", weight: 1.2 },
          { label: "Description", align: "left", weight: 5 },
          { label: "Frequency", align: "left", weight: 2.3 },
          { label: "Fee", align: "left", weight: 2.7 },
        ],
        rows: plan.fees.map((f) => {
          const frequency =
            f.billingFrequency === null
              ? "Not stated"
              : (FREQUENCY_LABELS[f.billingFrequency] ?? f.billingFrequency);
          // A start date only means something for a fee that recurs.
          const recurring = f.billingFrequency !== null && f.billingFrequency !== "one_time";
          const starts =
            recurring && f.startsOn !== null ? `; starting from ${longDate(f.startsOn)}` : "";
          const billed = billedWhen(f.billingFrequency, f.billingTiming, f.billingOn);
          // An unpriced line prints its REASON, never a blank or a zero (G1.6).
          const fee =
            f.amount === null
              ? (f.pricingNote ?? "To be agreed")
              : `${money(f.amount, row.currency)}${PER_PERIOD[f.billingFrequency ?? ""] ?? ""}` +
                (f.paymentTerms === null ? "" : `\n(${f.paymentTerms})`);
          return [f.code, f.description, `${frequency}${starts}${billed === "" ? "" : `; ${billed}`}`, fee];
        }),
        rowAnchors: plan.fees.map((f) =>
          f.feeGroupId !== null ? `fee:group:${f.feeGroupId}` : f.lineId !== null ? `fee:line:${f.lineId}` : null,
        ),
      },
    });
  }
  // THE ADVANCE, which the classic letter never printed: it is in the content
  // hash and it gates the work, so it belongs on the page the client signs.
  if (row.advance_required && row.advance_amount !== null) {
    out.push({
      kind: "figures",
      rows: [
        {
          label: "Advance, payable before work begins",
          value: money(row.advance_amount, row.currency),
          emphasis: true,
        },
      ],
    });
  }
  // A SERVICE'S OWN ADVANCE (0320), the same way: a term, hashed and frozen,
  // and it holds that service's work. Printed only when a line has one, so a
  // letter without renders exactly as before.
  if (lineAdvances.length > 0) {
    out.push({
      kind: "figures",
      rows: lineAdvances.map((a) => ({
        label: `Advance for ${a.description}, payable before its work begins`,
        value: money(a.amount, row.currency),
        emphasis: true,
      })),
    });
  }
  return out;
}

// ── The proposal's pieces (0084) ────────────────────────────────────────────

interface ProposalHeadRow {
  /** Whose proposal this is — for FILING the PDF, never drawn on it. */
  party_id: string;
  /** Whether it is still a draft — the only state a preview fills in. */
  status: string;
  ref: string;
  title: string;
  currency: string;
  valid_until: string | null;
  background: string | null;
  issuing_entity_party_id: string;
  sent_on: string | null;
  created_on: string;
  client_name: string;
  entity_name: string;
  addressed_to_party_id: string | null;
  addressee_name: string | null;
  preparer_name: string | null;
  preparer_email: string | null;
}

interface ProposalLineRow {
  id: string;
  position: number;
  description: string;
  billing_frequency: BillingFrequency | null;
  pricing_note: string | null;
  scope_override: string | null;
  client_obligations_override: string | null;
  volume_limits_override: string | null;
  exclusions_override: string | null;
  oop_estimate_min: string | null;
  oop_estimate_max: string | null;
  oop_currency: string | null;
  line_total: string | null;
  /** The company the line is for, by name, or null. */
  subject: string | null;
  service_body: Record<string, unknown>;
}

/**
 * Money as the firm's proposal prints it: "INR 50,000" — whole amounts without
 * a fraction, which a quote in round figures always is — and "INR 50,000.50"
 * when there is one. Still the ISO code (see the file header), still never a
 * JavaScript number.
 */
export function wholeMoney(amount: string, currency: string): string {
  const whole = /^-?\d+(\.0+)?$/.test(amount);
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(amount as unknown as number);
  // RUPEES IN LAKHS (2026-09-28): "INR 12,50,000", as an Indian reader writes
  // it and as every screen shows it — the preview now IS this PDF. Regrouped
  // from the western string rather than asked of `en-IN`, which a Node built
  // with small ICU silently answers as en-US: a locale the machine may lack
  // would make the bytes depend on the machine. The PROPOSAL only: a letter or
  // an invoice must re-render byte for byte (`tests/render/layout.test.ts`),
  // and a sent proposal keeps its pinned PDF, so nothing already issued moves.
  return `${currency} ${currency === "INR" ? inLakhs(formatted) : formatted}`;
}

/** "1,250,000.50" to "12,50,000.50": the last three digits, then pairs. */
export function inLakhs(western: string): string {
  const negative = western.startsWith("-");
  const [integer = "", fraction] = (negative ? western.slice(1) : western).split(".");
  const digits = integer.replace(/,/g, "");
  const last = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const pairs = rest.length === 0 ? [] : (rest.match(/(\d{1,2})(?=(\d{2})*$)/g) ?? []);
  const grouped = [...pairs, last].join(",");
  return `${negative ? "-" : ""}${grouped}${fraction === undefined ? "" : `.${fraction}`}`;
}

/** The firm's own words for how often a fee falls due, as its proposal writes
 *  them — "Yearly", where the letter says "Annually". */
const PROPOSAL_FREQUENCY: Readonly<Record<string, string>> = {
  one_time: "One-time",
  monthly: "Monthly",
  quarterly: "Quarterly",
  annually: "Yearly",
  custom: "Custom",
};

/** "H3: INR 50,000 Yearly" — what one service costs. An unpriced line prints
 *  its REASON, never a blank or a zero (G1.6); a priced line keeps its note. */
function proposalFee(
  item: ProposalPlan["sections"][number]["items"][number],
  currency: string,
): string {
  if (item.net === null) return item.pricingNote ?? "To be agreed";
  const frequency =
    item.billingFrequency === null ? "" : ` ${PROPOSAL_FREQUENCY[item.billingFrequency] ?? ""}`;
  const note = item.pricingNote === null ? "" : ` (${item.pricingNote})`;
  return `${wholeMoney(item.net, currency)}${frequency.trimEnd()}${note}`;
}

/** A service as the proposal names it, with its company when that says
 *  something (rule 3 of `planProposal`). */
function namedService(item: ProposalPlan["sections"][number]["items"][number]): string {
  return item.subject === null ? item.description : `${item.description} — ${item.subject}`;
}

/** "In-scope processes / services": every service, under its section's letter. */
function inScopeFlow(plan: ProposalPlan): Flow[] {
  // Not anchored: each row restates a service's name, which is edited where
  // the service is described.
  const rows = plan.sections.flatMap((s) => s.items.map((i) => `${s.code}. ${namedService(i)}`));
  if (rows.length === 0) return [];
  return [heading(1, "In-scope processes / services"), paragraph(rows.join("\n"))];
}

/** Each Dept's section: what the firm undertakes, service by service, and the
 *  fee for each. */
function proposalSectionsFlow(plan: ProposalPlan, currency: string): Flow[] {
  const out: Flow[] = [];
  for (const section of plan.sections) {
    out.push(heading(1, `${section.code}. ${section.title}`));
    // The firm's own label, in a product that serves more than one firm: its
    // template says "10x's Responsibilities", and whose they are is the issuing
    // company named on the cover.
    out.push(heading(3, "Our responsibilities:"));
    for (const item of section.items) {
      out.push(heading(2, `${item.code}. ${item.description}`, `line:${item.lineId}.name`));
      if (item.subject !== null) out.push(paragraph(forCompanies([item.subject]), true));
      out.push(...termsFlow(item.terms, item.lineId));
      if (item.oopEstimate !== null) {
        const o = item.oopEstimate;
        out.push(
          paragraph(
            `Out-of-pocket expenses: approximately ${wholeMoney(o.min, o.currency)} to ` +
              `${wholeMoney(o.max, o.currency)}, reimbursed at actuals and not part of the fee.`,
            true,
          ),
        );
      }
      out.push({
        kind: "paragraph",
        lead: "Fees",
        text: `${item.code}: ${proposalFee(item, currency)}`,
        anchor: `fee:line:${item.lineId}`,
      });
    }
  }
  return out;
}

/** The Summary of Fees: one row per service, with both of its codes. */
function proposalFeesFlow(plan: ProposalPlan, currency: string): Flow[] {
  const rows = plan.sections.flatMap((s) =>
    s.items.map((i) => [
      s.code,
      i.code,
      namedService(i),
      i.billingFrequency === null
        ? "Not stated"
        : (PROPOSAL_FREQUENCY[i.billingFrequency] ?? i.billingFrequency),
      // The fee alone: the frequency has its own column here.
      i.net === null ? (i.pricingNote ?? "To be agreed") : wholeMoney(i.net, currency),
    ]),
  );
  if (rows.length === 0) {
    return [
      heading(1, "Summary of Fees"),
      paragraph("No services have been added to this proposal yet.", true),
    ];
  }
  return [
    heading(1, "Summary of Fees"),
    {
      kind: "table",
      table: {
        columns: [
          { label: "Section", align: "left", weight: 1.3 },
          { label: "Sub Section", align: "left", weight: 1.5 },
          { label: "Description", align: "left", weight: 5 },
          { label: "Frequency", align: "left", weight: 1.9 },
          { label: "Fees", align: "left", weight: 2.3 },
        ],
        rows,
        rowAnchors: plan.sections.flatMap((s) => s.items.map((i) => `fee:line:${i.lineId}`)),
      },
    },
  ];
}

/**
 * The fees per billing frequency, under the Summary of Fees (T6.18, D8) —
 * "INR 50,000 Monthly + INR 1,25,000 Yearly + INR 15,000 One-time", never one
 * mixed net that adds a monthly fee to a one-time one. Summed by the database;
 * a line with no price is counted beside the figures rather than read as zero.
 */
function proposalTotalsFlow(
  rows: readonly { frequency: string | null; net: string | null; unpriced: number }[],
  currency: string,
): Flow[] {
  const priced = rows.filter((r) => r.net !== null);
  const unpriced = rows.reduce((n, r) => n + r.unpriced, 0);
  if (priced.length === 0) return [];
  const figures = priced.map((r) => {
    const amount = wholeMoney(r.net ?? "0", currency);
    return r.frequency === null
      ? `${amount} (frequency not stated)`
      : `${amount} ${PROPOSAL_FREQUENCY[r.frequency] ?? r.frequency}`;
  });
  const tail =
    unpriced === 0
      ? ""
      : `, plus ${String(unpriced)} service${unpriced === 1 ? "" : "s"} as mutually agreed`;
  return [{ kind: "paragraph", lead: "Total", text: `${figures.join(" + ")}${tail}` }];
}

/**
 * One of the Notes — the firm's team, exclusions or commercials — or nothing
 * when the proposal carries none. A heading line of the firm's is printed as
 * the sentence that introduces the list ("The scope of work does not include
 * following-"); every other line is an item of it.
 */
function noteFlow(title: string, rows: readonly BlockRow[], kind: string): Flow[] {
  if (rows.length === 0) return [];
  return [
    heading(1, title, `add:${kind}`),
    ...rows.map((b) => {
      if (b.is_heading) return paragraph(b.body, false, `block:${b.id}`);
      const [first = "", ...rest] = b.body.split("\n");
      return paragraph([`- ${first}`, ...rest.map((l) => `  ${l}`)].join("\n"), false, `block:${b.id}`);
    }),
  ];
}

/** "after each month", "at the start of each quarter", "first invoice on 15
 *  November 2026": when the fee is invoiced (0319), or "" when the letter does
 *  not say, which prints nothing and leaves the document as it was. */
function billedWhen(frequency: string | null, timing: string | null, on: string | null): string {
  const span = ({ monthly: "month", quarterly: "quarter", annually: "year" } as Record<string, string>)[frequency ?? ""];
  if (span === undefined || timing === null) return "";
  if (timing === "arrears") return `billed after each ${span}`;
  if (timing === "advance") return `billed at the start of each ${span}`;
  return timing === "on_date" && on !== null ? `first invoice on ${longDate(on)}` : "";
}

function withComma(words: string): string {
  return words === "" ? "" : `, ${words}`;
}
