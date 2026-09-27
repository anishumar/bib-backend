// Postgres adapter for proposals. Every method runs under withTenant, so the
// RLS tenant wall applies to each statement. timestamptz arrives as a Date and
// leaves as an ISO 8601 string; `numeric` arrives as a string and stays one —
// this is the door where Postgres types become ours, and the one place that
// would be tempted to turn money into a JavaScript number.
//
// THE TOTALS ARE NOT COMPUTED HERE EITHER. They come from crm.proposal_totals
// and crm.proposal_line_amount (migration 0013), which hold the arithmetic once
// in `numeric` — exact, where a JavaScript number cannot hold 1499.50. This file
// selects the figures and turns them into strings; it never adds two of them
// together.
import type { Db } from "../../db/pool";
import { VIEW_DEDUPE_MINUTES } from "../../domain/proposal/model";
import { withTenant } from "../../db/tenant";
import { toDay } from "./day";
import { zoneDayOf } from "./instant";
import { insertDocumentBlocks, strikeDocumentBlocks } from "./block-repository";
import type { Proposal, ProposalLine, ProposalStatus } from "../../domain/proposal/model";
import { ProposalCitedByLetter } from "../../domain/proposal/errors";
import { readServiceBody } from "../../domain/config/model";
import { resolveTerms } from "../../domain/document/model";
import type { BillingFrequency, OutOfPocketEstimate } from "../../domain/document/model";
import type {
  FiledPdf,
  LineEdit,
  NewClientAnswer,
  NewProposal,
  NewProposalEmail,
  NewProposalLine,
  PinnedService,
  ProposalEmail,
  ProposalFilters,
  ProposalLineRecord,
  ProposalRecord,
  ProposalRepository,
  ProposalRevision,
  ProposalSummary,
  ProseLine,
  SharedProposalRecord,
} from "../../usecase/proposal/ports";

interface ProposalRow {
  id: string;
  tenant_id: string;
  ref: string;
  party_id: string;
  issuing_entity_party_id: string;
  lead_id: string | null;
  title: string;
  status: ProposalStatus;
  currency: string;
  fx_rate: string;
  fx_rate_date: Date;
  valid_until: Date | null;
  sent_at: Date | null;
  decided_at: Date | null;
  discount_approved_by: string | null;
  discount_approved_at: Date | null;
  first_viewed_at: Date | null;
  last_viewed_at: Date | null;
  view_count: number;
  declined_reason: string | null;
  background: string | null;
  addressed_to_party_id: string | null;
  prepared_by_user_id: string | null;
  sent_pdf_version_id: string | null;
  deleted_at: Date | null;
  deleted_by_user_id: string | null;
}

/**
 * Every column of the proposal row, in one place (0084 added three, and the
 * list appeared in six statements — a column added to five of them is a field
 * that reads as null on whichever one nobody happened to open). `PROPOSAL_COLUMNS_P`
 * is the same list qualified for the joined reads.
 */
const PROPOSAL_COLUMN_NAMES = [
  "id", "tenant_id", "ref", "party_id", "issuing_entity_party_id", "lead_id", "title", "status",
  "currency", "fx_rate", "fx_rate_date", "valid_until", "sent_at", "decided_at",
  "discount_approved_by", "discount_approved_at", "first_viewed_at", "last_viewed_at",
  "view_count", "declined_reason", "background", "addressed_to_party_id", "prepared_by_user_id",
  "sent_pdf_version_id", "deleted_at", "deleted_by_user_id",
] as const;
const PROPOSAL_COLUMNS = PROPOSAL_COLUMN_NAMES.join(", ");
const PROPOSAL_COLUMNS_P = PROPOSAL_COLUMN_NAMES.map((c) => `p.${c}`).join(", ");

interface LineRow {
  id: string;
  tenant_id: string;
  proposal_id: string;
  entity_party_id: string | null;
  service_version_id: string;
  description: string;
  position: number;
  quantity: string;
  /** Nullable since 0023: an unpriced line is "as mutually agreed", never zero. */
  unit_amount: string | null;
  currency: string;
  discount_percent: string;
  jurisdiction: string | null;
  billing_frequency: BillingFrequency | null;
  scope_override: string | null;
  client_obligations_override: string | null;
  volume_limits_override: string | null;
  exclusions_override: string | null;
  oop_estimate_min: string | null;
  oop_estimate_max: string | null;
  oop_currency: string | null;
  pricing_note: string | null;
}

/** Every column of a line, in one place: the SELECT list appears in four
 *  queries and a column added to three of them is a field that reads as null on
 *  whichever read nobody happened to open. */
const LINE_COLUMNS = `id, tenant_id, proposal_id, entity_party_id, service_version_id,
                      description, position, quantity, unit_amount, currency, discount_percent,
                      jurisdiction, billing_frequency, scope_override,
                      client_obligations_override, volume_limits_override, exclusions_override,
                      oop_estimate_min, oop_estimate_max, oop_currency, pricing_note`;

interface TotalsRow {
  gross: string | null;
  discount: string | null;
  net: string | null;
  line_count: string;
  unpriced_line_count: string;
}

function toProposal(r: ProposalRow): Proposal {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    ref: r.ref,
    partyId: r.party_id,
    issuingEntityPartyId: r.issuing_entity_party_id,
    leadId: r.lead_id,
    title: r.title,
    status: r.status,
    currency: r.currency,
    fxRate: r.fx_rate,
    fxRateDate: toDay(r.fx_rate_date),
    validUntil: r.valid_until === null ? null : toDay(r.valid_until),
    sentAt: r.sent_at?.toISOString() ?? null,
    decidedAt: r.decided_at?.toISOString() ?? null,
    discountApprovedBy: r.discount_approved_by,
    discountApprovedAt: r.discount_approved_at?.toISOString() ?? null,
    firstViewedAt: r.first_viewed_at?.toISOString() ?? null,
    lastViewedAt: r.last_viewed_at?.toISOString() ?? null,
    viewCount: r.view_count,
    declinedReason: r.declined_reason,
    background: r.background,
    addressedToPartyId: r.addressed_to_party_id,
    preparedByUserId: r.prepared_by_user_id,
    sentPdfVersionId: r.sent_pdf_version_id,
    deletedAt: r.deleted_at?.toISOString() ?? null,
    deletedByUserId: r.deleted_by_user_id,
  };
}

/** The out-of-pocket range as ONE value or none. The three columns move
 *  together (`proposal_line_oop_is_whole_chk`), so the type says what the
 *  constraint says and no caller has to test three nulls. */
function toOopEstimate(r: LineRow): OutOfPocketEstimate | null {
  if (r.oop_estimate_min === null || r.oop_estimate_max === null || r.oop_currency === null) {
    return null;
  }
  return { min: r.oop_estimate_min, max: r.oop_estimate_max, currency: r.oop_currency };
}

function toLine(r: LineRow): ProposalLine {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    proposalId: r.proposal_id,
    entityPartyId: r.entity_party_id,
    serviceVersionId: r.service_version_id,
    description: r.description,
    position: r.position,
    quantity: r.quantity,
    unitAmount: r.unit_amount,
    currency: r.currency,
    discountPercent: r.discount_percent,
    jurisdiction: r.jurisdiction,
    billingFrequency: r.billing_frequency,
    scopeOverride: r.scope_override,
    clientObligationsOverride: r.client_obligations_override,
    volumeLimitsOverride: r.volume_limits_override,
    exclusionsOverride: r.exclusions_override,
    oopEstimate: toOopEstimate(r),
    pricingNote: r.pricing_note,
  };
}

/**
 * An empty proposal sums to nulls, not to zeroes — SUM over no rows is null.
 * Zero in the quote's own currency is the honest reading of "nothing yet".
 *
 * SINCE 0023 A NULL SUM HAS A SECOND CAUSE: every live line is unpriced, so
 * `sum()` had nothing to add. Zero is still the right FIGURE — the priced part
 * of this document comes to nothing — and it is `unpricedLineCount` beside it
 * that stops the zero reading as "this work is free". The two are read together
 * or the total is a lie; that is the whole reason the count is on this type
 * rather than somewhere a caller can forget to ask for.
 */
function toTotals(r: TotalsRow | undefined, currency: string): ProposalRecord["totals"] {
  return {
    gross: r?.gross ?? "0",
    discount: r?.discount ?? "0",
    net: r?.net ?? "0",
    currency,
    unpricedLineCount: Number(r?.unpriced_line_count ?? 0),
  };
}

export class PostgresProposalRepository implements ProposalRepository {
  constructor(private readonly app: Db) {}

  async create(p: NewProposal): Promise<Proposal> {
    return withTenant(this.app, p.tenantId, async (db) => {
      // status is the column default ('draft'): a proposal starts as a draft and
      // that is not the caller's to state.
      const [row] = await db<ProposalRow[]>`
        INSERT INTO crm.proposal
          (id, tenant_id, ref, party_id, issuing_entity_party_id, lead_id, title,
           currency, fx_rate, fx_rate_date, valid_until,
           background, addressed_to_party_id, prepared_by_user_id)
        VALUES
          (${p.id}, ${p.tenantId}, ${p.ref}, ${p.partyId}, ${p.issuingEntityPartyId},
           ${p.leadId}, ${p.title},
           ${p.currency}, ${p.fxRate}, ${p.fxRateDate}, ${p.validUntil},
           ${p.background}, ${p.addressedToPartyId}, ${p.preparedByUserId})
        RETURNING ${db.unsafe(PROPOSAL_COLUMNS)}
      `;
      if (!row) throw new Error("proposal insert returned no row");
      return toProposal(row);
    });
  }

  async findById(tenantId: string, proposalId: string): Promise<Proposal | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<ProposalRow[]>`
        SELECT ${db.unsafe(PROPOSAL_COLUMNS)}
        FROM crm.proposal WHERE id = ${proposalId}
      `;
      return row ? toProposal(row) : null;
    });
  }

  async describe(tenantId: string, proposalId: string): Promise<ProposalRecord | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [head] = await db<
        (ProposalRow & {
          party_display_name: string;
          issuer_display_name: string;
          approver_display_name: string | null;
          approver_email: string | null;
          addressee_display_name: string | null;
          addressee_email: string | null;
          preparer_display_name: string | null;
          preparer_email: string | null;
          firm_name: string;
          pdf_document_id: string | null;
          pdf_content_hash: string | null;
          pdf_filename: string | null;
          deleter_display_name: string | null;
          deleter_email: string | null;
          issuer_jurisdiction: string | null;
          addressee_phone: string | null;
          issued_on: string;
        })[]
      >`
        SELECT ${db.unsafe(PROPOSAL_COLUMNS_P)},
               party.display_name AS party_display_name,
               issuer.display_name AS issuer_display_name,
               approver.display_name AS approver_display_name,
               approver.email AS approver_email,
               addressee.display_name AS addressee_display_name,
               addressee_email.value AS addressee_email,
               preparer.display_name AS preparer_display_name,
               preparer.email::text AS preparer_email,
               firm.name AS firm_name,
               pdf.document_id AS pdf_document_id,
               pdf.content_hash AS pdf_content_hash,
               pdf.filename AS pdf_filename,
               deleter.display_name AS deleter_display_name,
               deleter.email::text AS deleter_email,
               issuer_le.jurisdiction AS issuer_jurisdiction,
               addressee_phone.value AS addressee_phone,
               -- The day the PDF's running header prints (0084): sent, else
               -- drafted, as the FIRM's day — the render source's own expression.
               ${db.unsafe(zoneDayOf("coalesce(p.sent_at, p.created_at)", "firm.time_zone", "issued_on"))}
        FROM crm.proposal p
        JOIN core.party party ON party.id = p.party_id
        -- WHICH OF OUR COMPANIES is offering, by name. An inner join: the
        -- column is NOT NULL and carries the tenant, so a proposal with no
        -- resolvable issuer is corruption rather than a state to render.
        JOIN core.party issuer ON issuer.id = p.issuing_entity_party_id
        -- Where that company is registered (T6.18). LEFT: the fallback entity
        -- every firm is seeded with has no legal-entity row.
        LEFT JOIN core.legal_entity issuer_le ON issuer_le.party_id = p.issuing_entity_party_id
        JOIN tenancy.tenant firm ON firm.id = p.tenant_id
        LEFT JOIN tenancy.user_account approver ON approver.id = p.discount_approved_by
        -- The cover's two names (0084), read-time joins: an erased account
        -- stops resolving and the cover then names nobody.
        LEFT JOIN core.party addressee ON addressee.id = p.addressed_to_party_id
        -- Where Send offers to email it (0085): that person's email identifier
        -- in force today, the primary one first. An offer, never a default the
        -- colleague cannot see — the address is in the box before they press.
        LEFT JOIN LATERAL (
          SELECT i.value::text AS value
          FROM core.party_identifier i
          WHERE i.party_id = p.addressed_to_party_id
            AND i.type = 'email'
            AND (i.valid_to IS NULL OR i.valid_to >= current_date)
          ORDER BY i.is_primary DESC, i.created_at DESC
          LIMIT 1
        ) addressee_email ON true
        -- The same person's phone, the same way — what "Send on WhatsApp"
        -- opens a chat with (T6.18).
        LEFT JOIN LATERAL (
          SELECT i.value::text AS value
          FROM core.party_identifier i
          WHERE i.party_id = p.addressed_to_party_id
            AND i.type = 'phone'
            AND (i.valid_to IS NULL OR i.valid_to >= current_date)
          ORDER BY i.is_primary DESC, i.created_at DESC
          LIMIT 1
        ) addressee_phone ON true
        LEFT JOIN tenancy.user_account preparer ON preparer.id = p.prepared_by_user_id
        -- The PDF of record (0085), once pinned.
        LEFT JOIN files.document_version pdf ON pdf.id = p.sent_pdf_version_id
        -- Who deleted it (0086) — deleted or not, one proposal always opens.
        LEFT JOIN tenancy.user_account deleter ON deleter.id = p.deleted_by_user_id
        WHERE p.id = ${proposalId}
      `;
      if (!head) return null;

      // Every email bib sent it in (0085), newest first, with the fingerprint
      // of the PDF each one attached.
      const emails = await db<
        {
          id: string;
          to_email: string;
          note: string | null;
          sent_at: Date;
          sent_by: string | null;
          sender_display_name: string | null;
          sender_email: string | null;
          pdf_content_hash: string;
        }[]
      >`
        SELECT e.id, e.to_email, e.note, e.sent_at, e.sent_by,
               sender.display_name AS sender_display_name,
               sender.email::text AS sender_email,
               v.content_hash AS pdf_content_hash
        FROM crm.proposal_email e
        JOIN files.document_version v ON v.id = e.pdf_version_id
        LEFT JOIN tenancy.user_account sender ON sender.id = e.sent_by
        WHERE e.proposal_id = ${proposalId}
        ORDER BY e.sent_at DESC, e.created_at DESC
      `;

      // The CLIENT's answer and its evidence (0085). Absent when unanswered,
      // and when a colleague recorded the answer.
      const [answer] = await db<
        {
          decision: "accepted" | "rejected";
          signer_name: string;
          statement: string | null;
          decided_at: Date;
          ip_address: string | null;
          user_agent: string | null;
          emailed_to: string | null;
          pdf_version_id: string | null;
          pdf_document_id: string | null;
          pdf_content_hash: string | null;
          pdf_filename: string | null;
        }[]
      >`
        SELECT d.decision, d.signer_name, d.statement, d.decided_at, d.ip_address, d.user_agent,
               e.to_email AS emailed_to,
               v.id AS pdf_version_id, v.document_id AS pdf_document_id,
               v.content_hash AS pdf_content_hash, v.filename AS pdf_filename
        FROM crm.proposal_client_decision d
        LEFT JOIN crm.proposal_email e ON e.id = d.email_id
        LEFT JOIN files.document_version v ON v.id = d.pdf_version_id
        WHERE d.proposal_id = ${proposalId}
      `;

      // The lines, each with the catalogue version it was PINNED to — its code,
      // its Dept, its SLA, its scope blocks and its list price AS THEY WERE,
      // which is the question the pin exists to answer and the reason this join
      // reads config.version by id rather than looking the service up live.
      // ONE join for the whole document: a screen wanting to print `A1` used to
      // call the registry once per line.
      const lines = await db<
        (LineRow & {
          net: string | null;
          service_key: string;
          service_version: number;
          service_body: Record<string, unknown>;
          entity_display_name: string | null;
        })[]
      >`
        SELECT l.id, l.tenant_id, l.proposal_id, l.entity_party_id, l.service_version_id,
               l.description,
               l.position, l.quantity, l.unit_amount, l.currency, l.discount_percent,
               l.jurisdiction, l.billing_frequency, l.scope_override,
               l.client_obligations_override, l.volume_limits_override, l.exclusions_override,
               l.oop_estimate_min, l.oop_estimate_max, l.oop_currency, l.pricing_note,
               -- NULL for an unpriced line, straight out of the view: there is
               -- no net of an amount that does not exist, and 0 here would sum
               -- into the document's total as a line the client gets free.
               a.net,
               e.key AS service_key,
               v.version AS service_version,
               v.body AS service_body,
               entity.display_name AS entity_display_name
        FROM crm.proposal_line l
        JOIN crm.proposal_line_amount a ON a.id = l.id
        JOIN config.version v ON v.id = l.service_version_id
        JOIN config.entry e ON e.id = v.entry_id
        -- LEFT, because a proposal line naming no entity is a real line: the
        -- prospect may hold none yet, or the entity is this line's own output.
        LEFT JOIN core.party entity ON entity.id = l.entity_party_id
        WHERE l.proposal_id = ${proposalId} AND l.removed_at IS NULL
        ORDER BY l.position
      `;

      const [totals] = await db<TotalsRow[]>`
        SELECT line_count, gross, discount, net, unpriced_line_count
        FROM crm.proposal_totals WHERE proposal_id = ${proposalId}
      `;

      // THE MONEY PER FREQUENCY (T6.18, D8), added by the database from the same
      // per-line view the document total comes from. `sum` skips an unpriced
      // line's NULL, and the count beside it says so. Reading order: monthly
      // first, lines that state no frequency last.
      const byFrequency = await db<
        {
          frequency: BillingFrequency | null;
          net: string | null;
          line_count: string;
          unpriced_line_count: string;
        }[]
      >`
        SELECT l.billing_frequency AS frequency,
               sum(a.net)::text AS net,
               count(*) AS line_count,
               count(*) FILTER (WHERE l.unit_amount IS NULL) AS unpriced_line_count
        FROM crm.proposal_line l
        JOIN crm.proposal_line_amount a ON a.id = l.id
        WHERE l.proposal_id = ${proposalId} AND l.removed_at IS NULL
        GROUP BY l.billing_frequency
        ORDER BY coalesce(array_position(
                   ARRAY['monthly', 'quarterly', 'annually', 'one_time', 'custom'],
                   l.billing_frequency::text), 99)
      `;

      // The firm's Depts and delivery teams, retired rows included — the render
      // source's read, so a line's Dept name and a section's letter are the
      // PDF's.
      const axes = await db<
        { axis: "dept" | "team"; code: string; name: string; sort_order: number }[]
      >`
        SELECT axis, code, name, sort_order FROM tenancy.service_axis
      `;
      const axisName = (axis: "dept" | "team", code: string | null) =>
        code === null
          ? null
          : { code, name: axes.find((a) => a.axis === axis && a.code === code)?.name ?? null };

      return {
        proposal: toProposal(head),
        party: { id: head.party_id, displayName: head.party_display_name },
        issuingEntity: {
          id: head.issuing_entity_party_id,
          displayName: head.issuer_display_name,
        },
        issuer: {
          partyId: head.issuing_entity_party_id,
          name: head.issuer_display_name,
          jurisdiction: head.issuer_jurisdiction,
        },
        issuedOn: head.issued_on,
        totalsByFrequency: byFrequency.map((f) => ({
          frequency: f.frequency,
          net: f.net ?? "0",
          lineCount: Number(f.line_count),
          unpricedLineCount: Number(f.unpriced_line_count),
        })),
        depts: axes
          .filter((a) => a.axis === "dept")
          .map((a) => ({ code: a.code, name: a.name, sortOrder: a.sort_order })),
        lines: lines.map((r): ProposalLineRecord => {
          const service = toPinnedService(r.service_key, r.service_version, r.service_body);
          return {
            line: toLine(r),
            entity:
              r.entity_party_id === null || r.entity_display_name === null
                ? null
                : { id: r.entity_party_id, displayName: r.entity_display_name },
            service,
            dept: axisName("dept", service.module),
            team: axisName("team", service.group),
            // OVERRIDE ELSE CATALOGUE, resolved once, by the domain — never by
            // this adapter and never by a screen. The catalogue's half comes
            // out of the SAME pinned body the join already read, so the words
            // that print are the version's, not today's.
            terms: resolveTerms(
              {
                scope: r.scope_override,
                clientObligations: r.client_obligations_override,
                volumeLimits: r.volume_limits_override,
                exclusions: r.exclusions_override,
              },
              readServiceBody(r.service_body),
            ),
            net: r.net,
          };
        }),
        totals: toTotals(totals, head.currency),
        // email is the discriminator, not the id: an account always has an
        // address and may have no name.
        approvedBy:
          head.discount_approved_by === null || head.approver_email === null
            ? null
            : {
                userId: head.discount_approved_by,
                displayName: head.approver_display_name,
                email: head.approver_email,
              },
        addressee:
          head.addressed_to_party_id === null || head.addressee_display_name === null
            ? null
            : {
                id: head.addressed_to_party_id,
                displayName: head.addressee_display_name,
                email: head.addressee_email,
                phone: head.addressee_phone,
              },
        preparedBy:
          head.prepared_by_user_id === null || head.preparer_email === null
            ? null
            : {
                userId: head.prepared_by_user_id,
                displayName: head.preparer_display_name,
                email: head.preparer_email,
              },
        firmName: head.firm_name,
        sentPdf:
          head.sent_pdf_version_id === null ||
          head.pdf_document_id === null ||
          head.pdf_content_hash === null ||
          head.pdf_filename === null
            ? null
            : {
                documentId: head.pdf_document_id,
                versionId: head.sent_pdf_version_id,
                contentHash: head.pdf_content_hash,
                filename: head.pdf_filename,
              },
        emails: emails.map((e) => ({
          id: e.id,
          to: e.to_email,
          note: e.note,
          sentAt: e.sent_at.toISOString(),
          sentBy:
            e.sent_by === null || e.sender_email === null
              ? null
              : { userId: e.sent_by, displayName: e.sender_display_name, email: e.sender_email },
          pdfContentHash: e.pdf_content_hash,
        })),
        clientDecision:
          answer === undefined
            ? null
            : {
                decision: answer.decision,
                signerName: answer.signer_name,
                statement: answer.statement,
                decidedAt: answer.decided_at.toISOString(),
                ipAddress: answer.ip_address,
                userAgent: answer.user_agent,
                emailedTo: answer.emailed_to,
                pdf:
                  answer.pdf_version_id === null ||
                  answer.pdf_document_id === null ||
                  answer.pdf_content_hash === null ||
                  answer.pdf_filename === null
                    ? null
                    : {
                        documentId: answer.pdf_document_id,
                        versionId: answer.pdf_version_id,
                        contentHash: answer.pdf_content_hash,
                        filename: answer.pdf_filename,
                      },
              },
        deletedBy:
          head.deleted_by_user_id === null || head.deleter_email === null
            ? null
            : {
                userId: head.deleted_by_user_id,
                displayName: head.deleter_display_name,
                email: head.deleter_email,
              },
      };
    });
  }

  async list(tenantId: string, filters: ProposalFilters): Promise<readonly ProposalSummary[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // The totals come from a LATERAL, so thirty proposals cost one query
      // rather than thirty-one. The list is the screen this is for.
      const rows = await db<
        (ProposalRow & {
          party_display_name: string;
          issuer_display_name: string;
          gross: string | null;
          discount: string | null;
          net: string | null;
          line_count: string;
          unpriced_line_count: string;
        })[]
      >`
        SELECT ${db.unsafe(PROPOSAL_COLUMNS_P)},
               party.display_name AS party_display_name,
               issuer.display_name AS issuer_display_name,
               t.gross, t.discount, t.net, coalesce(t.line_count, 0) AS line_count,
               coalesce(t.unpriced_line_count, 0) AS unpriced_line_count
        FROM crm.proposal p
        JOIN core.party party ON party.id = p.party_id
        JOIN core.party issuer ON issuer.id = p.issuing_entity_party_id
        -- LEFT, because a proposal with no lines has no row in the view at all:
        -- SUM over nothing is null, and the mapper reads that as zero.
        LEFT JOIN crm.proposal_totals t ON t.proposal_id = p.id
        WHERE (${filters.status ?? null}::text IS NULL OR p.status = ${filters.status ?? null})
          AND (${filters.partyId ?? null}::uuid IS NULL OR p.party_id = ${filters.partyId ?? null})
          -- A deleted draft was never an offer (0086): not in the list, under
          -- any status filter, and not in any count taken from it.
          AND p.deleted_at IS NULL
        ORDER BY p.created_at DESC
      `;
      return rows.map(
        (r): ProposalSummary => ({
          proposal: toProposal(r),
          party: { id: r.party_id, displayName: r.party_display_name },
          issuingEntity: { id: r.issuing_entity_party_id, displayName: r.issuer_display_name },
          totals: toTotals(r, r.currency),
          lineCount: Number(r.line_count),
        }),
      );
    });
  }

  async addLine(l: NewProposalLine, lapseDiscountApproval = false): Promise<ProposalLine> {
    return withTenant(this.app, l.tenantId, async (db) => {
      if (lapseDiscountApproval) await lapseApproval(db, l.proposalId);
      // The position is assigned HERE, under the same statement that inserts,
      // rather than computed by the caller and passed down: two people adding a
      // line to one draft would otherwise race for the same number and one of
      // them would lose to the unique index for no reason they could act on.
      const [row] = await db.unsafe<LineRow[]>(
        `
        INSERT INTO crm.proposal_line
          (id, tenant_id, proposal_id, entity_party_id, service_version_id, description,
           position, quantity, unit_amount, currency, discount_percent,
           jurisdiction, billing_frequency, scope_override, client_obligations_override,
           volume_limits_override, exclusions_override,
           oop_estimate_min, oop_estimate_max, oop_currency, pricing_note)
        SELECT $1, $2, $3, $4, $5, $6,
               coalesce(max(position), 0) + 1,
               $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
        FROM crm.proposal_line
        WHERE proposal_id = $3 AND removed_at IS NULL
        RETURNING ${LINE_COLUMNS}
      `,
        [
          l.id,
          l.tenantId,
          l.proposalId,
          l.entityPartyId,
          l.serviceVersionId,
          l.description,
          l.quantity,
          l.unitAmount,
          l.currency,
          l.discountPercent,
          l.jurisdiction,
          l.billingFrequency,
          l.scopeOverride,
          l.clientObligationsOverride,
          l.volumeLimitsOverride,
          l.exclusionsOverride,
          l.oopEstimate?.min ?? null,
          l.oopEstimate?.max ?? null,
          l.oopEstimate?.currency ?? null,
          l.pricingNote,
        ],
      );
      if (!row) throw new Error("proposal line insert returned no row");
      return toLine(row);
    });
  }

  async updateLine(
    tenantId: string,
    proposalId: string,
    lineId: string,
    edit: LineEdit,
    lapseDiscountApproval: boolean,
  ): Promise<ProposalLine | null> {
    return withTenant(this.app, tenantId, async (db) => {
      // A live line of a live DRAFT, repeated in the WHERE: a proposal sent or
      // deleted since the use case read it is left exactly as it stands, and
      // null comes back rather than a changed row the client never saw.
      const [row] = await db.unsafe<LineRow[]>(
        `
        UPDATE crm.proposal_line l
           SET description = $4, quantity = $5, unit_amount = $6, discount_percent = $7,
               jurisdiction = $8, billing_frequency = $9, scope_override = $10,
               client_obligations_override = $11, volume_limits_override = $12,
               exclusions_override = $13, oop_estimate_min = $14, oop_estimate_max = $15,
               oop_currency = $16, pricing_note = $17
          FROM crm.proposal p
         WHERE l.id = $1 AND l.proposal_id = $2 AND l.tenant_id = $3 AND l.removed_at IS NULL
           AND p.id = l.proposal_id AND p.status = 'draft' AND p.deleted_at IS NULL
        RETURNING ${LINE_COLUMNS.split(",").map((c) => `l.${c.trim()}`).join(", ")}
      `,
        [
          lineId,
          proposalId,
          tenantId,
          edit.description,
          edit.quantity,
          edit.unitAmount,
          edit.discountPercent,
          edit.jurisdiction,
          edit.billingFrequency,
          edit.scopeOverride,
          edit.clientObligationsOverride,
          edit.volumeLimitsOverride,
          edit.exclusionsOverride,
          edit.oopEstimate?.min ?? null,
          edit.oopEstimate?.max ?? null,
          edit.oopEstimate?.currency ?? null,
          edit.pricingNote,
        ],
      );
      if (!row) return null;
      // In the SAME transaction: an approval can never be read as covering a
      // discount it was not given for, even for the instant between two
      // statements.
      if (lapseDiscountApproval) await lapseApproval(db, proposalId);
      return toLine(row);
    });
  }

  async removeLine(tenantId: string, proposalId: string, lineId: string): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      await db`
        UPDATE crm.proposal_line SET removed_at = now()
        WHERE id = ${lineId} AND proposal_id = ${proposalId} AND removed_at IS NULL
      `;
    });
  }

  async listLines(tenantId: string, proposalId: string): Promise<readonly ProposalLine[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db.unsafe<LineRow[]>(
        `SELECT ${LINE_COLUMNS} FROM crm.proposal_line
          WHERE proposal_id = $1 AND removed_at IS NULL ORDER BY position`,
        [proposalId],
      );
      return rows.map(toLine);
    });
  }

  async setStatus(
    tenantId: string,
    proposalId: string,
    status: ProposalStatus,
    at: string,
    declinedReason: string | null,
  ): Promise<Proposal> {
    return withTenant(this.app, tenantId, async (db) => {
      // The status and its date move in ONE statement. The CHECK constraints in
      // 0011 refuse a row that claims to be sent with no sent_at, so writing
      // them separately would not merely be untidy — it would fail.
      const [row] = await db<ProposalRow[]>`
        UPDATE crm.proposal
           SET status = ${status},
               -- The casts are load-bearing, not decoration. A bare parameter
               -- inside a CASE whose other branch is NULL has nothing to infer a
               -- type from, so Postgres calls it text and refuses to assign it
               -- to a timestamptz column. It failed only on the transition
               -- paths, which is why the end-to-end walk caught it and the
               -- earlier integration test — which never sent a proposal — did
               -- not.
               sent_at = CASE WHEN ${status} = 'draft' THEN NULL
                              ELSE coalesce(sent_at, ${at}::timestamptz) END,
               decided_at = CASE
                              WHEN ${status} IN ('accepted', 'rejected', 'expired')
                              THEN ${at}::timestamptz
                              ELSE NULL
                            END,
               -- In the SAME statement as the status, because
               -- proposal_declined_reason_when_rejected_chk (0022) holds the
               -- two together: a reason written a moment before or after the
               -- status it belongs to would be refused by the constraint.
               declined_reason = ${declinedReason}
         WHERE id = ${proposalId}
        RETURNING ${db.unsafe(PROPOSAL_COLUMNS)}
      `;
      if (!row) throw new Error(`proposal ${proposalId} vanished mid-transition`);
      return toProposal(row);
    });
  }

  async attachShareToken(tenantId: string, proposalId: string, digest: string): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      await db`
        UPDATE crm.proposal SET share_token_digest = ${digest} WHERE id = ${proposalId}
      `;
    });
  }

  /**
   * Resolve a share link, inside the tenant its token named.
   *
   * An ordinary withTenant read — which is the entire point of putting the
   * tenant in the token (0014). Looking a digest up across every firm would
   * need a query RLS does not scope, on a table that holds money.
   */
  async findShared(tenantId: string, digest: string): Promise<SharedProposalRecord | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [head] = await db<
        {
          id: string;
          ref: string;
          title: string;
          status: ProposalStatus;
          currency: string;
          valid_until: Date | null;
          sent_at: Date | null;
          firm_name: string;
          issuer_display_name: string;
          party_display_name: string;
          gross: string | null;
          discount: string | null;
          net: string | null;
          unpriced_line_count: string | null;
          answer_decision: "accepted" | "rejected" | null;
          answer_signer_name: string | null;
          answer_decided_at: Date | null;
        }[]
      >`
        SELECT p.id, p.ref, p.title, p.status, p.currency, p.valid_until, p.sent_at,
               firm.name AS firm_name,
               issuer.display_name AS issuer_display_name,
               party.display_name AS party_display_name,
               t.gross, t.discount, t.net, t.unpriced_line_count,
               answer.decision AS answer_decision,
               answer.signer_name AS answer_signer_name,
               answer.decided_at AS answer_decided_at
        FROM crm.proposal p
        JOIN core.party party ON party.id = p.party_id
        -- The recipient is told which of our companies is offering. It is not
        -- always the group name above it, and a client is entitled to know
        -- which company they would be contracting with.
        JOIN core.party issuer ON issuer.id = p.issuing_entity_party_id
        JOIN tenancy.tenant firm ON firm.id = p.tenant_id
        LEFT JOIN crm.proposal_totals t ON t.proposal_id = p.id
        -- The answer given on this page, by name and date (0085). The address
        -- and browser in the same row are the firm's, not the reader's, and are
        -- not selected here.
        LEFT JOIN crm.proposal_client_decision answer ON answer.proposal_id = p.id
        WHERE p.share_token_digest = ${digest}
      `;
      if (!head) return null;

      const lines = await db<
        {
          description: string;
          quantity: string;
          unit_amount: string | null;
          discount_percent: string;
          net: string | null;
          pricing_note: string | null;
          billing_frequency: BillingFrequency | null;
          oop_estimate_min: string | null;
          oop_estimate_max: string | null;
          oop_currency: string | null;
        }[]
      >`
        SELECT l.description, l.quantity, l.unit_amount, l.discount_percent, a.net,
               -- What the RECIPIENT reads where a figure would be, how often
               -- they will be invoiced, and what they are told to expect to
               -- reimburse. The four scope blocks are deliberately not here:
               -- this route is a PUBLIC path and widening what an
               -- unauthenticated link exposes is its own decision. The
               -- document's PROSE blocks are added by the use case.
               l.pricing_note, l.billing_frequency,
               l.oop_estimate_min, l.oop_estimate_max, l.oop_currency
        FROM crm.proposal_line l
        JOIN crm.proposal_line_amount a ON a.id = l.id
        WHERE l.proposal_id = ${head.id} AND l.removed_at IS NULL
        ORDER BY l.position
      `;

      return {
        id: head.id,
        ref: head.ref,
        firmName: head.firm_name,
        issuedBy: head.issuer_display_name,
        addressedTo: head.party_display_name,
        title: head.title,
        status: head.status,
        currency: head.currency,
        validUntil: head.valid_until === null ? null : toDay(head.valid_until),
        sentAt: head.sent_at?.toISOString() ?? null,
        lines: lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitAmount: l.unit_amount,
          discountPercent: l.discount_percent,
          net: l.net,
          pricingNote: l.pricing_note,
          billingFrequency: l.billing_frequency,
          oopEstimate:
            l.oop_estimate_min === null ||
            l.oop_estimate_max === null ||
            l.oop_currency === null
              ? null
              : {
                  min: l.oop_estimate_min,
                  max: l.oop_estimate_max,
                  currency: l.oop_currency,
                },
        })),
        totals: {
          gross: head.gross ?? "0",
          discount: head.discount ?? "0",
          net: head.net ?? "0",
          currency: head.currency,
          // The recipient is told the same thing a partner is: how many lines
          // this figure does not cover. A client reading a total that quietly
          // omits two "as mutually agreed" lines is the worst place for this to
          // go wrong.
          unpricedLineCount: Number(head.unpriced_line_count ?? 0),
        },
        answer:
          head.answer_decision === null ||
          head.answer_signer_name === null ||
          head.answer_decided_at === null
            ? null
            : {
                decision: head.answer_decision,
                signerName: head.answer_signer_name,
                decidedAt: head.answer_decided_at.toISOString(),
              },
      };
    });
  }

  async recordView(tenantId: string, proposalId: string, at: string): Promise<boolean> {
    return withTenant(this.app, tenantId, async (db) => {
      // One statement: the count and the first-view date move together, which
      // is what the CHECK in 0014 requires, and `first_viewed_at IS NULL`
      // before the update is what makes the returned flag true exactly once
      // even if two opens land at the same moment.
      const [row] = await db<{ was_first: boolean }[]>`
        UPDATE crm.proposal
           -- The count advances only when the last open was long enough ago to
           -- be a separate reading. The link is PUBLIC, so counting requests
           -- meant counting refreshes, link previews and back buttons — see
           -- VIEW_DEDUPE_MINUTES. The DATE moves every time, because "they
           -- opened it again yesterday" is true however briefly.
           SET view_count = view_count + CASE
                 WHEN last_viewed_at IS NULL
                   OR last_viewed_at < ${at}::timestamptz
                      - make_interval(mins => ${VIEW_DEDUPE_MINUTES})
                 THEN 1 ELSE 0
               END,
               first_viewed_at = coalesce(first_viewed_at, ${at}::timestamptz),
               last_viewed_at = ${at}::timestamptz
         WHERE id = ${proposalId}
        RETURNING (view_count = 1) AS was_first
      `;
      return row?.was_first ?? false;
    });
  }

  async recordDiscountApproval(
    tenantId: string,
    proposalId: string,
    approvedByUserId: string,
    at: string,
  ): Promise<Proposal> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<ProposalRow[]>`
        UPDATE crm.proposal
           SET discount_approved_by = ${approvedByUserId}, discount_approved_at = ${at}
         WHERE id = ${proposalId}
        RETURNING ${db.unsafe(PROPOSAL_COLUMNS)}
      `;
      if (!row) throw new Error(`proposal ${proposalId} vanished mid-approval`);
      return toProposal(row);
    });
  }

  async revise(
    tenantId: string,
    proposalId: string,
    change: ProposalRevision,
    prose: readonly ProseLine[] | null = null,
  ): Promise<Proposal | null> {
    return withTenant(this.app, tenantId, async (db) => {
      // One statement, each column kept unless the change names it. "Names it"
      // is a separate boolean per field because NULL is a real value here —
      // clearing the background is a change, not an absence of one.
      const has = (k: keyof ProposalRevision): boolean => change[k] !== undefined;
      const [row] = await db<ProposalRow[]>`
        UPDATE crm.proposal
           SET title = CASE WHEN ${has("title")} THEN ${change.title ?? null} ELSE title END,
               valid_until = CASE WHEN ${has("validUntil")} THEN ${change.validUntil ?? null}::date
                                  ELSE valid_until END,
               background = CASE WHEN ${has("background")} THEN ${change.background ?? null}
                                 ELSE background END,
               addressed_to_party_id = CASE WHEN ${has("addressedToPartyId")}
                                            THEN ${change.addressedToPartyId ?? null}::uuid
                                            ELSE addressed_to_party_id END,
               prepared_by_user_id = CASE WHEN ${has("preparedByUserId")}
                                          THEN ${change.preparedByUserId ?? null}::uuid
                                          ELSE prepared_by_user_id END,
               issuing_entity_party_id = CASE WHEN ${has("issuingEntityPartyId")}
                                              THEN ${change.issuingEntityPartyId ?? null}::uuid
                                              ELSE issuing_entity_party_id END,
               -- The currency cascades to the lines through their key (0312):
               -- only lines struck off this draft, because the WHERE below
               -- refuses a new currency while any line is live.
               currency = CASE WHEN ${has("currency")} THEN ${change.currency ?? null}
                               ELSE currency END,
               fx_rate = CASE WHEN ${has("fxRate")} THEN ${change.fxRate ?? null}::numeric
                              ELSE fx_rate END,
               fx_rate_date = CASE WHEN ${has("fxRateDate")} THEN ${change.fxRateDate ?? null}::date
                                   ELSE fx_rate_date END
         -- A live draft only, repeated here: a proposal sent or deleted since the
         -- service read it is left exactly as it stands.
         WHERE id = ${proposalId} AND status = 'draft' AND deleted_at IS NULL
           -- And a new currency only over no live line, for the same reason: a
           -- line quoted a moment ago is priced in the old one.
           AND (${change.currency ?? null}::text IS NULL
                OR currency = ${change.currency ?? null}
                OR NOT EXISTS (SELECT 1 FROM crm.proposal_line l
                               WHERE l.proposal_id = ${proposalId} AND l.removed_at IS NULL))
        RETURNING ${db.unsafe(PROPOSAL_COLUMNS)}
      `;
      if (!row) return null;
      // THE NEW ISSUER'S PROSE, in the same transaction (T6.18, D9): the old
      // lines struck off, the new company's standard set written in their place.
      if (prose !== null) {
        const owner = { kind: "proposal" as const, id: proposalId };
        await strikeDocumentBlocks(db, owner);
        await insertDocumentBlocks(
          db,
          prose.map((p) => ({ ...p, tenantId, owner })),
        );
      }
      return toProposal(row);
    });
  }

  // ── 0085: the proposal by email, and the client's own answer ─────────────

  async findIdByShareDigest(tenantId: string, digest: string): Promise<string | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ id: string }[]>`
        SELECT id FROM crm.proposal WHERE share_token_digest = ${digest}
      `;
      return row?.id ?? null;
    });
  }

  async pinSentPdf(tenantId: string, proposalId: string, versionId: string): Promise<string> {
    return withTenant(this.app, tenantId, async (db) => {
      // `coalesce` keeps whatever is pinned already: the FIRST render to arrive
      // is the record, and one racing it a moment later is handed that one back
      // rather than replacing a file somebody may already have been sent.
      const [row] = await db<{ sent_pdf_version_id: string }[]>`
        UPDATE crm.proposal
           SET sent_pdf_version_id = coalesce(sent_pdf_version_id, ${versionId}::uuid)
         WHERE id = ${proposalId}
        RETURNING sent_pdf_version_id
      `;
      if (!row) throw new Error(`proposal ${proposalId} vanished while its PDF was pinned`);
      return row.sent_pdf_version_id;
    });
  }

  async findPdf(tenantId: string, versionId: string): Promise<FiledPdf | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<
        { id: string; document_id: string; content_hash: string; filename: string }[]
      >`
        SELECT id, document_id, content_hash, filename
        FROM files.document_version WHERE id = ${versionId}
      `;
      return row
        ? {
            documentId: row.document_id,
            versionId: row.id,
            contentHash: row.content_hash,
            filename: row.filename,
          }
        : null;
    });
  }

  async recordEmail(email: NewProposalEmail): Promise<ProposalEmail> {
    return withTenant(this.app, email.tenantId, async (db) => {
      await db`
        INSERT INTO crm.proposal_email
          (id, tenant_id, proposal_id, to_email, note, pdf_version_id, link_digest, sent_by, sent_at)
        VALUES
          (${email.id}, ${email.tenantId}, ${email.proposalId}, ${email.toEmail}, ${email.note},
           ${email.pdfVersionId}, ${email.linkDigest}, ${email.sentBy}, ${email.sentAt})
      `;
      return {
        id: email.id,
        tenantId: email.tenantId,
        proposalId: email.proposalId,
        toEmail: email.toEmail,
        note: email.note,
        pdfVersionId: email.pdfVersionId,
        sentBy: email.sentBy,
        sentAt: email.sentAt,
      };
    });
  }

  async findEmailByLink(
    tenantId: string,
    proposalId: string,
    digest: string,
  ): Promise<ProposalEmail | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<
        {
          id: string;
          tenant_id: string;
          proposal_id: string;
          to_email: string;
          note: string | null;
          pdf_version_id: string;
          sent_by: string | null;
          sent_at: Date;
        }[]
      >`
        SELECT id, tenant_id, proposal_id, to_email, note, pdf_version_id, sent_by, sent_at
        FROM crm.proposal_email
        WHERE proposal_id = ${proposalId} AND link_digest = ${digest}
        ORDER BY sent_at DESC
        LIMIT 1
      `;
      return row
        ? {
            id: row.id,
            tenantId: row.tenant_id,
            proposalId: row.proposal_id,
            toEmail: row.to_email,
            note: row.note,
            pdfVersionId: row.pdf_version_id,
            sentBy: row.sent_by,
            sentAt: row.sent_at.toISOString(),
          }
        : null;
    });
  }

  async recordClientAnswer(answer: NewClientAnswer): Promise<Proposal | null> {
    return withTenant(this.app, answer.tenantId, async (db) => {
      // ONLY WHILE IT IS SENT, in the statement that moves it. A second answer
      // from another tab reads `sent` in the service a moment before the first
      // lands; without this WHERE it would overwrite the first answer and then
      // fail on the evidence row's UNIQUE, leaving a status nobody's evidence
      // backs. Same columns `setStatus` moves, in one statement, for its reason.
      const [row] = await db<ProposalRow[]>`
        UPDATE crm.proposal
           SET status = ${answer.decision},
               decided_at = ${answer.decidedAt}::timestamptz,
               declined_reason = ${answer.declinedReason}
         WHERE id = ${answer.proposalId} AND status = 'sent'
        RETURNING ${db.unsafe(PROPOSAL_COLUMNS)}
      `;
      if (!row) return null;
      await db`
        INSERT INTO crm.proposal_client_decision
          (id, tenant_id, proposal_id, decision, signer_name, statement, email_id,
           pdf_version_id, ip_address, user_agent, decided_at)
        VALUES
          (${answer.id}, ${answer.tenantId}, ${answer.proposalId}, ${answer.decision},
           ${answer.signerName}, ${answer.statement}, ${answer.emailId}, ${answer.pdfVersionId},
           ${answer.ipAddress}, ${answer.userAgent}, ${answer.decidedAt})
      `;
      return toProposal(row);
    });
  }

  async liveLetterRefs(tenantId: string, proposalId: string): Promise<readonly string[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // `trg_proposal_guard_deletion`'s own probe, so the page and the wall
      // agree about which letters stand in the way.
      const rows = await db<{ ref: string }[]>`
        SELECT ref FROM crm.engagement_letter
        WHERE proposal_id = ${proposalId} AND deleted_at IS NULL
        ORDER BY ref
      `;
      return rows.map((r) => r.ref);
    });
  }

  async markDeleted(
    tenantId: string,
    proposalId: string,
    deletedByUserId: string | null,
  ): Promise<Proposal | null> {
    return withTenant(this.app, tenantId, async (db) => {
      // Only these two columns: the trigger refuses a deletion that changes
      // anything else. `now()` belongs to the transaction making the change.
      const rows = await db<ProposalRow[]>`
        UPDATE crm.proposal
           SET deleted_at = now(), deleted_by_user_id = ${deletedByUserId}
         WHERE id = ${proposalId} AND status = 'draft' AND deleted_at IS NULL
        RETURNING ${db.unsafe(PROPOSAL_COLUMNS)}
      `.catch((err: unknown) => {
        // A letter drafted citing it between the service's check and this
        // statement: the wall caught what the check could not, and names it.
        const letters = citedBy(err);
        throw letters === null ? err : new ProposalCitedByLetter(letters);
      });
      const row = rows[0];
      return row ? toProposal(row) : null;
    });
  }
}

/**
 * Clear a DRAFT's discount sign-off (T6.18) — both columns, as the 0011 CHECK
 * holds them together. Only a draft: a sent proposal's approval is part of
 * what went out.
 */
async function lapseApproval(db: Db, proposalId: string): Promise<void> {
  await db`
    UPDATE crm.proposal
       SET discount_approved_by = NULL, discount_approved_at = NULL
     WHERE id = ${proposalId} AND status = 'draft'
  `;
}

/**
 * The letters `trg_proposal_guard_deletion` named in its DETAIL, when its "a
 * live letter cites it" case is what refused — SQLSTATE 23001 with a DETAIL is
 * only ever that case on this table. Null for anything else, which the caller
 * re-throws untouched.
 */
function citedBy(err: unknown): readonly string[] | null {
  if (typeof err !== "object" || err === null) return null;
  const { code, detail } = err as { code?: unknown; detail?: unknown };
  if (code !== "23001" || typeof detail !== "string" || detail === "") return null;
  return detail.split(", ");
}

/**
 * The pinned catalogue row, out of the frozen jsonb the join already selected.
 *
 * `readServiceBody` (domain/config) rather than reaching into the body by name
 * here, and that is the point of it existing: it is the ONE reader for
 * `kind='service'`, it NORMALISES (a currency code is compared, so "inr" beside
 * "INR" would split a total), and every field FALLS BACK rather than throwing —
 * which a pinned version needs, because the body being read may predate the
 * field being asked for and a pin must always resolve. Reading the jsonb by name
 * a second time here is how the two answers drift.
 *
 * The name falls back to the registry KEY when a stored body somehow has none:
 * `readServiceBody` returns "" (it cannot know the key), and a line printing
 * nothing at all is worse than one printing `gst-filing`.
 */
function toPinnedService(
  key: string,
  version: number,
  body: Record<string, unknown>,
): PinnedService {
  const stored = readServiceBody(body);
  return {
    key,
    version,
    ref: stored.ref,
    name: stored.name === "" ? key : stored.name,
    module: stored.module,
    group: stored.group,
    jurisdictions: stored.jurisdictions,
    billingBasis: stored.billingBasis,
    recurrence: stored.recurrence,
    slaDays: stored.slaDays,
    listPrice: stored.listPrice,
    pricingNote: stored.pricingNote,
    scope: stored.scope,
    clientObligations: stored.clientObligations,
    volumeLimits: stored.volumeLimits,
    exclusions: stored.exclusions,
  };
}
