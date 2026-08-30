// Postgres adapter for engagement letters and the engagements they create.
// Every method runs under withTenant, so the RLS tenant wall applies to each
// statement. `numeric` arrives as a string and stays one — money never becomes
// a JavaScript number on the way through this file.
//
// Two methods here open a transaction of their own inside the tenant scope, and
// both do it for the same reason: the states in between are ones a person would
// have to repair by hand.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
// THE BUG THIS FILE USED TO HAVE. Its own `toDay` read the LOCAL date fields
// and carried a comment saying `toISOString()` "would be wrong east of UTC".
// Both were backwards: postgres.js builds a `date` at UTC midnight, so the
// local fields are the ones that move — a day BACK, west of Greenwich. It never
// showed up because nothing here runs west of Greenwich. `day.ts` carries the
// measurement.
import { toDay } from "./day";
import type {
  Engagement,
  EngagementLetter,
  EngagementStatus,
  LetterClause,
  LetterLine,
  LetterStatus,
} from "../../domain/engagement/model";
import { readClauseBody, readServiceBody } from "../../domain/config/model";
import { resolveTerms } from "../../domain/document/model";
import type { BillingFrequency, OutOfPocketEstimate } from "../../domain/document/model";
import type {
  EngagementRepository,
  FirmSignatureRecord,
  LetterClauseRecord,
  LetterFilters,
  LetterLineRecord,
  LetterRecord,
  LetterSummary,
  NewEngagement,
  NewLetter,
  NewLetterClause,
  NewLetterLine,
  PinnedService,
  SignatureRecord,
} from "../../usecase/engagement/ports";

interface LetterRow {
  id: string;
  tenant_id: string;
  ref: string;
  party_id: string;
  issuing_entity_party_id: string;
  proposal_id: string | null;
  jurisdiction: string;
  title: string;
  status: LetterStatus;
  currency: string;
  fx_rate: string;
  fx_rate_date: Date;
  advance_required: boolean;
  advance_amount: string | null;
  advance_recorded_at: Date | null;
  advance_recorded_by: string | null;
  sent_at: Date | null;
  signed_at: Date | null;
  signed_by_name: string | null;
  signature_method: string | null;
  signature_reference: string | null;
  signed_content_hash: string | null;
  signed_by_title: string | null;
  withdrawn_at: Date | null;
  background: string | null;
  addressed_to_party_id: string | null;
  issued_on: Date | null;
  supersedes_id: string | null;
  effective_from: Date | null;
  firm_signatory_user_id: string | null;
  firm_signatory_title: string | null;
  firm_signed_at: Date | null;
}

interface LineRow {
  id: string;
  tenant_id: string;
  engagement_letter_id: string;
  entity_party_id: string;
  service_version_id: string;
  description: string;
  position: number;
  quantity: string;
  /** Nullable since 0023: an agreed line may genuinely be "as mutually agreed". */
  unit_amount: string | null;
  currency: string;
  discount_percent: string;
  effective_from: Date | null;
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

/** Every column of a line, in one place: the SELECT list appears in three
 *  queries and a column added to two of them reads as null on the third. */
const LINE_COLUMNS = `id, tenant_id, engagement_letter_id, entity_party_id, service_version_id,
                      description, position, quantity, unit_amount, currency, discount_percent,
                      effective_from, jurisdiction, billing_frequency, scope_override,
                      client_obligations_override, volume_limits_override, exclusions_override,
                      oop_estimate_min, oop_estimate_max, oop_currency, pricing_note`;

/** The out-of-pocket range as ONE value or none — the three columns move
 *  together (`el_line_oop_is_whole_chk`). */
function toOopEstimate(r: LineRow): OutOfPocketEstimate | null {
  if (r.oop_estimate_min === null || r.oop_estimate_max === null || r.oop_currency === null) {
    return null;
  }
  return { min: r.oop_estimate_min, max: r.oop_estimate_max, currency: r.oop_currency };
}

interface ClauseRow {
  id: string;
  tenant_id: string;
  engagement_letter_id: string;
  clause_version_id: string;
  position: number;
}

interface EngagementRow {
  id: string;
  tenant_id: string;
  engagement_letter_id: string;
  engagement_letter_line_id: string;
  party_id: string;
  entity_party_id: string;
  status: EngagementStatus;
  activated_at: Date | null;
  effective_from: Date;
  ends_on: Date | null;
}



function toLetter(r: LetterRow): EngagementLetter {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    ref: r.ref,
    partyId: r.party_id,
    issuingEntityPartyId: r.issuing_entity_party_id,
    proposalId: r.proposal_id,
    jurisdiction: r.jurisdiction,
    title: r.title,
    status: r.status,
    currency: r.currency,
    fxRate: r.fx_rate,
    fxRateDate: toDay(r.fx_rate_date),
    advanceRequired: r.advance_required,
    advanceAmount: r.advance_amount,
    advanceRecordedAt: r.advance_recorded_at?.toISOString() ?? null,
    advanceRecordedBy: r.advance_recorded_by,
    sentAt: r.sent_at?.toISOString() ?? null,
    signedAt: r.signed_at?.toISOString() ?? null,
    signedByName: r.signed_by_name,
    signatureMethod: r.signature_method,
    signatureReference: r.signature_reference,
    signedContentHash: r.signed_content_hash,
    signedByTitle: r.signed_by_title,
    withdrawnAt: r.withdrawn_at?.toISOString() ?? null,
    background: r.background,
    addressedToPartyId: r.addressed_to_party_id,
    issuedOn: r.issued_on === null ? null : toDay(r.issued_on),
    supersedesId: r.supersedes_id,
    effectiveFrom: r.effective_from === null ? null : toDay(r.effective_from),
    firmSignatoryUserId: r.firm_signatory_user_id,
    firmSignatoryTitle: r.firm_signatory_title,
    firmSignedAt: r.firm_signed_at?.toISOString() ?? null,
  };
}

function toLine(r: LineRow): LetterLine {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    engagementLetterId: r.engagement_letter_id,
    entityPartyId: r.entity_party_id,
    serviceVersionId: r.service_version_id,
    description: r.description,
    position: r.position,
    quantity: r.quantity,
    unitAmount: r.unit_amount,
    currency: r.currency,
    discountPercent: r.discount_percent,
    effectiveFrom: r.effective_from === null ? null : toDay(r.effective_from),
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

function toClause(r: ClauseRow): LetterClause {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    engagementLetterId: r.engagement_letter_id,
    clauseVersionId: r.clause_version_id,
    position: r.position,
  };
}

/**
 * The pinned catalogue row, out of the frozen jsonb the join already selected.
 *
 * `readServiceBody` (domain/config) rather than reaching into the body by name
 * here, for the reason `readClauseBody` is used two functions down: it is the
 * ONE reader for `kind='service'`, it normalises, and every field FALLS BACK
 * rather than throwing — which a PINNED version needs, because the body being
 * read may predate the field being asked for and a pin must always resolve. On a
 * signed letter that matters more than anywhere else: a read that threw would
 * make the record of what a client agreed to unreadable.
 *
 * The name falls back to the registry KEY when a stored body somehow has none.
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

function toEngagement(r: EngagementRow): Engagement {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    engagementLetterId: r.engagement_letter_id,
    engagementLetterLineId: r.engagement_letter_line_id,
    partyId: r.party_id,
    entityPartyId: r.entity_party_id,
    status: r.status,
    activatedAt: r.activated_at?.toISOString() ?? null,
    effectiveFrom: toDay(r.effective_from),
    endsOn: r.ends_on === null ? null : toDay(r.ends_on),
  };
}

export class PostgresEngagementRepository implements EngagementRepository {
  constructor(private readonly app: Db) {}

  async create(l: NewLetter): Promise<EngagementLetter> {
    return withTenant(this.app, l.tenantId, async (db) => {
      const [row] = await db<LetterRow[]>`
        INSERT INTO crm.engagement_letter
          (id, tenant_id, ref, party_id, issuing_entity_party_id, proposal_id, jurisdiction,
           title, currency, fx_rate, fx_rate_date, advance_required, advance_amount,
           background, addressed_to_party_id, issued_on, supersedes_id, effective_from)
        VALUES
          (${l.id}, ${l.tenantId}, ${l.ref}, ${l.partyId}, ${l.issuingEntityPartyId},
           ${l.proposalId}, ${l.jurisdiction}, ${l.title},
           ${l.currency}, ${l.fxRate}, ${l.fxRateDate}, ${l.advanceRequired}, ${l.advanceAmount},
           ${l.background}, ${l.addressedToPartyId}, ${l.issuedOn}, ${l.supersedesId},
           ${l.effectiveFrom})
        RETURNING id, tenant_id, ref, party_id, issuing_entity_party_id, proposal_id,
                  jurisdiction, title, status, currency, fx_rate, fx_rate_date, advance_required, advance_amount,
                  advance_recorded_at, advance_recorded_by, sent_at, signed_at, signed_by_name,
                  signature_method, signature_reference, signed_content_hash, signed_by_title,
                  withdrawn_at, background, addressed_to_party_id, issued_on, supersedes_id,
                  effective_from, firm_signatory_user_id, firm_signatory_title, firm_signed_at
      `;
      if (!row) throw new Error("engagement letter insert returned no row");
      return toLetter(row);
    });
  }

  async findLetter(tenantId: string, letterId: string): Promise<EngagementLetter | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<LetterRow[]>`
        SELECT id, tenant_id, ref, party_id, issuing_entity_party_id, proposal_id,
               jurisdiction, title, status, currency, fx_rate, fx_rate_date, advance_required, advance_amount,
               advance_recorded_at, advance_recorded_by, sent_at, signed_at, signed_by_name,
               signature_method, signature_reference, signed_content_hash, signed_by_title,
                  withdrawn_at, background, addressed_to_party_id, issued_on, supersedes_id,
                  effective_from, firm_signatory_user_id, firm_signatory_title, firm_signed_at
        FROM crm.engagement_letter WHERE id = ${letterId}
      `;
      return row ? toLetter(row) : null;
    });
  }

  async describeLetter(tenantId: string, letterId: string): Promise<LetterRecord | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [head] = await db<
        (LetterRow & {
          party_display_name: string;
          issuer_display_name: string;
          addressee_display_name: string | null;
          firm_signatory_display_name: string | null;
          supersedes_ref: string | null;
          superseded_by_id: string | null;
          superseded_by_ref: string | null;
        })[]
      >`
        SELECT l.id, l.tenant_id, l.ref, l.party_id, l.issuing_entity_party_id,
               l.proposal_id, l.jurisdiction, l.title, l.status,
               l.currency, l.fx_rate, l.fx_rate_date, l.advance_required, l.advance_amount,
               l.advance_recorded_at, l.advance_recorded_by, l.sent_at, l.signed_at,
               l.signed_by_name, l.signature_method, l.signature_reference,
               l.signed_content_hash, l.signed_by_title, l.withdrawn_at,
               l.background, l.addressed_to_party_id, l.issued_on, l.supersedes_id,
               l.effective_from, l.firm_signatory_user_id, l.firm_signatory_title,
               l.firm_signed_at,
               party.display_name AS party_display_name,
               issuer.display_name AS issuer_display_name,
               addressee.display_name AS addressee_display_name,
               signatory.display_name AS firm_signatory_display_name,
               previous.ref AS supersedes_ref,
               successor.id  AS superseded_by_id,
               successor.ref AS superseded_by_ref
        FROM crm.engagement_letter l
        JOIN core.party party ON party.id = l.party_id
        -- WHICH OF OUR COMPANIES is contracting, by name — the letterhead and
        -- the signature block both print it. An inner join: the column is NOT
        -- NULL and carries the tenant, so an unresolvable issuer is corruption
        -- rather than a state to render.
        JOIN core.party issuer ON issuer.id = l.issuing_entity_party_id
        -- WHO the letter is written to, by name. LEFT: a letter addressed to no
        -- individual is ordinary, and the c/o organization is the client above.
        LEFT JOIN core.party addressee ON addressee.id = l.addressed_to_party_id
        -- WHO BOUND THE FIRM, by name. The name is a JOIN and not a stored
        -- field, for the reason the ledger's actor name is: an erased account
        -- stops resolving and the letter survives. The TITLE is stored on the
        -- letter, because it is what the document said and a promotion must not
        -- restate it.
        LEFT JOIN tenancy.user_account signatory ON signatory.id = l.firm_signatory_user_id
        -- LINEAGE, both directions. Backwards: which agreement this replaced.
        -- Forwards: whether this one is still the agreement — the question the
        -- screen showing a signed letter cannot otherwise answer. A withdrawn
        -- successor does not count, which is exactly the predicate
        -- el_one_live_successor_per_letter uses to keep it single.
        LEFT JOIN crm.engagement_letter previous ON previous.id = l.supersedes_id
        LEFT JOIN crm.engagement_letter successor
               ON successor.supersedes_id = l.id AND successor.status <> 'withdrawn'
        WHERE l.id = ${letterId}
      `;
      if (!head) return null;

      const lines = await db<
        (LineRow & {
          net: string | null;
          service_key: string;
          service_version: number;
          service_body: Record<string, unknown>;
          entity_display_name: string;
        })[]
      >`
        SELECT l.id, l.tenant_id, l.engagement_letter_id, l.entity_party_id,
               l.service_version_id, l.description,
               l.position, l.quantity, l.unit_amount, l.currency, l.discount_percent,
               l.effective_from, l.jurisdiction, l.billing_frequency, l.scope_override,
               l.client_obligations_override, l.volume_limits_override, l.exclusions_override,
               l.oop_estimate_min, l.oop_estimate_max, l.oop_currency, l.pricing_note,
               -- NULL for an unpriced line, and deliberately not coalesced:
               -- there is no net of an amount that does not exist, and a zero
               -- here would be a line the client gets free.
               round(l.unit_amount * l.quantity * (1 - l.discount_percent / 100), 4) AS net,
               e.key AS service_key, v.version AS service_version, v.body AS service_body,
               entity.display_name AS entity_display_name
        FROM crm.engagement_letter_line l
        JOIN config.version v ON v.id = l.service_version_id
        JOIN config.entry e ON e.id = v.entry_id
        -- The entity by NAME, in the query rather than per row on a screen.
        -- This is where a group client's four companies are told apart, so a
        -- column of uuids is the one thing this read must not return.
        JOIN core.party entity ON entity.id = l.entity_party_id
        WHERE l.engagement_letter_id = ${letterId} AND l.removed_at IS NULL
        ORDER BY l.position
      `;

      // The clauses, with the wording AS PINNED. This join is the whole design:
      // reading a signed letter must show what was agreed, not what the library
      // says today.
      const clauses = await db<
        (ClauseRow & { clause_key: string; clause_version: number; clause_body: Record<string, unknown> })[]
      >`
        SELECT c.id, c.tenant_id, c.engagement_letter_id, c.clause_version_id, c.position,
               e.key AS clause_key, v.version AS clause_version, v.body AS clause_body
        FROM crm.engagement_letter_clause c
        JOIN config.version v ON v.id = c.clause_version_id
        JOIN config.entry e ON e.id = v.entry_id
        WHERE c.engagement_letter_id = ${letterId}
        ORDER BY c.position
      `;

      // The letter's arithmetic is written here rather than in a view — the
      // proposal's lives in crm.proposal_totals (0013) — and BOTH now answer the
      // same question about an unpriced line the same way: `sum` skips it, and
      // `unpriced_line_count` says how many the figures leave out. Without that
      // count the three sums silently understate a letter and nothing on the row
      // says so.
      const [totals] = await db<
        {
          gross: string | null;
          discount: string | null;
          net: string | null;
          unpriced_line_count: string;
        }[]
      >`
        SELECT coalesce(sum(round(unit_amount * quantity, 4)), 0) AS gross,
               coalesce(sum(round(unit_amount * quantity, 4)
                          - round(unit_amount * quantity * (1 - discount_percent / 100), 4)), 0)
                 AS discount,
               coalesce(sum(round(unit_amount * quantity * (1 - discount_percent / 100), 4)), 0)
                 AS net,
               count(*) FILTER (WHERE unit_amount IS NULL) AS unpriced_line_count
        FROM crm.engagement_letter_line
        WHERE engagement_letter_id = ${letterId} AND removed_at IS NULL
      `;

      const engagements = await db<EngagementRow[]>`
        SELECT id, tenant_id, engagement_letter_id, engagement_letter_line_id, party_id,
               entity_party_id, status, activated_at, effective_from, ends_on
        FROM crm.engagement WHERE engagement_letter_id = ${letterId}
      `;

      return {
        letter: toLetter(head),
        party: { id: head.party_id, displayName: head.party_display_name },
        issuingEntity: {
          id: head.issuing_entity_party_id,
          displayName: head.issuer_display_name,
        },
        addressedTo:
          head.addressed_to_party_id === null
            ? null
            : {
                id: head.addressed_to_party_id,
                displayName: head.addressee_display_name ?? head.addressed_to_party_id,
              },
        // All three columns move together (el_firm_signature_is_whole_chk), so
        // one check settles the block. The display name may still be null — an
        // erased account — and the caller is told so rather than shown a uuid.
        firmSignatory:
          head.firm_signatory_user_id === null ||
          head.firm_signatory_title === null ||
          head.firm_signed_at === null
            ? null
            : {
                userId: head.firm_signatory_user_id,
                displayName: head.firm_signatory_display_name,
                title: head.firm_signatory_title,
                signedAt: head.firm_signed_at.toISOString(),
              },
        supersedes:
          head.supersedes_id === null || head.supersedes_ref === null
            ? null
            : { id: head.supersedes_id, ref: head.supersedes_ref },
        supersededBy:
          head.superseded_by_id === null || head.superseded_by_ref === null
            ? null
            : { id: head.superseded_by_id, ref: head.superseded_by_ref },
        lines: lines.map(
          (r): LetterLineRecord => ({
            line: toLine(r),
            entity: { id: r.entity_party_id, displayName: r.entity_display_name },
            service: toPinnedService(r.service_key, r.service_version, r.service_body),
            // OVERRIDE ELSE CATALOGUE, resolved once, by the domain. On a signed
            // letter both halves are frozen — the override by the line trigger
            // (0017), the catalogue's words by the config freeze (0005) — which
            // is what makes an issued document reproducible.
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
          }),
        ),
        clauses: clauses.map((r): LetterClauseRecord => {
          const body = readClauseBody(r.clause_body);
          return {
            clause: toClause(r),
            key: r.clause_key,
            version: r.clause_version,
            title: body.title,
            text: body.text,
            // The STRUCTURED terms, from the PINNED body — so a signed letter
            // answers "whose law does this name" with what the client agreed
            // to, not with what the clause says today.
            governingLaw: body.governingLaw,
            courts: body.courts,
          };
        }),
        totals: {
          gross: totals?.gross ?? "0",
          discount: totals?.discount ?? "0",
          net: totals?.net ?? "0",
          currency: head.currency,
          unpricedLineCount: Number(totals?.unpriced_line_count ?? 0),
        },
        engagements: engagements.map(toEngagement),
      };
    });
  }

  async listLetters(tenantId: string, filters: LetterFilters): Promise<readonly LetterSummary[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<
        (LetterRow & {
          party_display_name: string;
          issuer_display_name: string;
          gross: string | null;
          discount: string | null;
          net: string | null;
          line_count: string;
          unpriced_line_count: string;
        })[]
      >`
        SELECT l.id, l.tenant_id, l.ref, l.party_id, l.issuing_entity_party_id,
               l.proposal_id, l.jurisdiction, l.title, l.status,
               l.currency, l.fx_rate, l.fx_rate_date, l.advance_required, l.advance_amount,
               l.advance_recorded_at, l.advance_recorded_by, l.sent_at, l.signed_at,
               l.signed_by_name, l.signature_method, l.signature_reference,
               l.signed_content_hash, l.signed_by_title, l.withdrawn_at,
               l.background, l.addressed_to_party_id, l.issued_on, l.supersedes_id,
               l.effective_from, l.firm_signatory_user_id, l.firm_signatory_title,
               l.firm_signed_at,
               party.display_name AS party_display_name,
               issuer.display_name AS issuer_display_name,
               t.gross, t.discount, t.net, coalesce(t.line_count, 0) AS line_count,
               coalesce(t.unpriced_line_count, 0) AS unpriced_line_count
        FROM crm.engagement_letter l
        JOIN core.party party ON party.id = l.party_id
        JOIN core.party issuer ON issuer.id = l.issuing_entity_party_id
        LEFT JOIN LATERAL (
          SELECT coalesce(sum(round(unit_amount * quantity, 4)), 0) AS gross,
                 coalesce(sum(round(unit_amount * quantity, 4)
                            - round(unit_amount * quantity * (1 - discount_percent / 100), 4)), 0)
                   AS discount,
                 coalesce(sum(round(unit_amount * quantity * (1 - discount_percent / 100), 4)), 0)
                   AS net,
                 count(*) AS line_count,
                 count(*) FILTER (WHERE unit_amount IS NULL) AS unpriced_line_count
          FROM crm.engagement_letter_line
          WHERE engagement_letter_id = l.id AND removed_at IS NULL
        ) t ON true
        WHERE (${filters.status ?? null}::text IS NULL OR l.status = ${filters.status ?? null})
          AND (${filters.partyId ?? null}::uuid IS NULL OR l.party_id = ${filters.partyId ?? null})
        ORDER BY l.created_at DESC
      `;
      return rows.map(
        (r): LetterSummary => ({
          letter: toLetter(r),
          party: { id: r.party_id, displayName: r.party_display_name },
          issuingEntity: { id: r.issuing_entity_party_id, displayName: r.issuer_display_name },
          totals: {
            gross: r.gross ?? "0",
            discount: r.discount ?? "0",
            net: r.net ?? "0",
            currency: r.currency,
            unpricedLineCount: Number(r.unpriced_line_count),
          },
          lineCount: Number(r.line_count),
        }),
      );
    });
  }

  async addLine(l: NewLetterLine): Promise<LetterLine> {
    return withTenant(this.app, l.tenantId, async (db) => {
      // The position is assigned in the same statement that inserts, so two
      // people adding a line to one draft cannot race for the same number.
      const [row] = await db.unsafe<LineRow[]>(
        `
        INSERT INTO crm.engagement_letter_line
          (id, tenant_id, engagement_letter_id, entity_party_id, service_version_id,
           description, position, quantity, unit_amount, currency, discount_percent,
           effective_from, jurisdiction, billing_frequency, scope_override,
           client_obligations_override, volume_limits_override, exclusions_override,
           oop_estimate_min, oop_estimate_max, oop_currency, pricing_note)
        SELECT $1, $2, $3, $4, $5, $6, coalesce(max(position), 0) + 1,
               $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
        FROM crm.engagement_letter_line
        WHERE engagement_letter_id = $3 AND removed_at IS NULL
        RETURNING ${LINE_COLUMNS}
      `,
        [
          l.id,
          l.tenantId,
          l.engagementLetterId,
          l.entityPartyId,
          l.serviceVersionId,
          l.description,
          l.quantity,
          l.unitAmount,
          l.currency,
          l.discountPercent,
          l.effectiveFrom,
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
      if (!row) throw new Error("engagement letter line insert returned no row");
      return toLine(row);
    });
  }

  async removeLine(tenantId: string, letterId: string, lineId: string): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      await db`
        UPDATE crm.engagement_letter_line SET removed_at = now()
        WHERE id = ${lineId} AND engagement_letter_id = ${letterId} AND removed_at IS NULL
      `;
    });
  }

  async listLines(tenantId: string, letterId: string): Promise<readonly LetterLine[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // Every column, because `signAndFanOut` hashes what this returns: a line
      // read without its overrides would be signed for without its scope.
      const rows = await db.unsafe<LineRow[]>(
        `SELECT ${LINE_COLUMNS} FROM crm.engagement_letter_line
          WHERE engagement_letter_id = $1 AND removed_at IS NULL ORDER BY position`,
        [letterId],
      );
      return rows.map(toLine);
    });
  }

  async addClause(c: NewLetterClause): Promise<LetterClause> {
    return withTenant(this.app, c.tenantId, async (db) => {
      const [row] = await db<ClauseRow[]>`
        INSERT INTO crm.engagement_letter_clause
          (id, tenant_id, engagement_letter_id, clause_version_id, position)
        SELECT ${c.id}, ${c.tenantId}, ${c.engagementLetterId}, ${c.clauseVersionId},
               coalesce(max(position), 0) + 1
        FROM crm.engagement_letter_clause
        WHERE engagement_letter_id = ${c.engagementLetterId}
        RETURNING id, tenant_id, engagement_letter_id, clause_version_id, position
      `;
      if (!row) throw new Error("engagement letter clause insert returned no row");
      return toClause(row);
    });
  }

  async listClauses(tenantId: string, letterId: string): Promise<readonly LetterClause[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<ClauseRow[]>`
        SELECT id, tenant_id, engagement_letter_id, clause_version_id, position
        FROM crm.engagement_letter_clause
        WHERE engagement_letter_id = ${letterId}
        ORDER BY position
      `;
      return rows.map(toClause);
    });
  }

  async setStatus(
    tenantId: string,
    letterId: string,
    status: LetterStatus,
    at: string,
  ): Promise<EngagementLetter> {
    return withTenant(this.app, tenantId, async (db) => {
      // The casts are load-bearing: a bare parameter inside a CASE whose other
      // branch is NULL has no type to infer, so Postgres calls it text and
      // refuses to assign it to a timestamptz. Learnt on proposals.
      const [row] = await db<LetterRow[]>`
        UPDATE crm.engagement_letter
           SET status = ${status},
               sent_at = CASE WHEN ${status} = 'draft' THEN NULL
                              ELSE coalesce(sent_at, ${at}::timestamptz) END,
               withdrawn_at = CASE WHEN ${status} = 'withdrawn' THEN ${at}::timestamptz
                                   ELSE NULL END
         WHERE id = ${letterId}
        RETURNING id, tenant_id, ref, party_id, issuing_entity_party_id, proposal_id,
                  jurisdiction, title, status, currency, fx_rate, fx_rate_date, advance_required, advance_amount,
                  advance_recorded_at, advance_recorded_by, sent_at, signed_at, signed_by_name,
                  signature_method, signature_reference, signed_content_hash, signed_by_title,
                  withdrawn_at, background, addressed_to_party_id, issued_on, supersedes_id,
                  effective_from, firm_signatory_user_id, firm_signatory_title, firm_signed_at
      `;
      if (!row) throw new Error(`engagement letter ${letterId} vanished mid-transition`);
      return toLetter(row);
    });
  }

  /**
   * SEND IT: the status, the date the document carries, and the firm's own
   * signature, in ONE statement.
   *
   * `coalesce(issued_on, ...)` is the whole reason this is not `setStatus`: a
   * letter the drafter dated keeps its date, and one they did not is dated the
   * day it went out. Doing that as a read-then-write would leave a window in
   * which two people sending the same draft could date it differently.
   *
   * The firm's three signature columns are written together or not at all,
   * which is what the null-object parameter buys — `el_firm_signature_is_whole_chk`
   * (0022) would refuse anything else, and refusing at the constraint is a 500.
   */
  async markSent(
    tenantId: string,
    letterId: string,
    at: string,
    issuedOnFallback: string,
    firm: FirmSignatureRecord | null,
  ): Promise<EngagementLetter> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<LetterRow[]>`
        UPDATE crm.engagement_letter
           SET status = 'sent',
               sent_at = coalesce(sent_at, ${at}::timestamptz),
               issued_on = coalesce(issued_on, ${issuedOnFallback}::date),
               firm_signatory_user_id = ${firm?.userId ?? null},
               firm_signatory_title   = ${firm?.title ?? null},
               firm_signed_at         = ${firm?.signedAt ?? null}::timestamptz
         WHERE id = ${letterId} AND status = 'draft'
        RETURNING id, tenant_id, ref, party_id, issuing_entity_party_id, proposal_id,
                  jurisdiction, title, status, currency, fx_rate, fx_rate_date, advance_required, advance_amount,
                  advance_recorded_at, advance_recorded_by, sent_at, signed_at, signed_by_name,
                  signature_method, signature_reference, signed_content_hash, signed_by_title,
                  withdrawn_at, background, addressed_to_party_id, issued_on, supersedes_id,
                  effective_from, firm_signatory_user_id, firm_signatory_title, firm_signed_at
      `;
      // `AND status = 'draft'` makes the transition its own lock, the same
      // trick the signature uses: two people sending one draft cannot both find
      // it there, so the second gets no row rather than a second signature
      // block stamped over the first.
      if (!row) {
        throw new Error(
          `engagement letter ${letterId} was not a draft when it was sent — ` +
            `it may have been sent or withdrawn concurrently`,
        );
      }
      return toLetter(row);
    });
  }

  /**
   * The live letter that supersedes this one.
   *
   * `status <> 'withdrawn'` matches the partial unique index exactly, which is
   * what makes "the live successor" a single row rather than the first of
   * several: a replacement that was drafted and pulled is not a replacement.
   */
  async findSuccessor(tenantId: string, letterId: string): Promise<EngagementLetter | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<LetterRow[]>`
        SELECT id, tenant_id, ref, party_id, issuing_entity_party_id, proposal_id,
               jurisdiction, title, status, currency, fx_rate, fx_rate_date, advance_required, advance_amount,
               advance_recorded_at, advance_recorded_by, sent_at, signed_at, signed_by_name,
               signature_method, signature_reference, signed_content_hash, signed_by_title,
               withdrawn_at, background, addressed_to_party_id, issued_on, supersedes_id,
               effective_from, firm_signatory_user_id, firm_signatory_title, firm_signed_at
        FROM crm.engagement_letter
        WHERE supersedes_id = ${letterId} AND status <> 'withdrawn'
      `;
      return row ? toLetter(row) : null;
    });
  }

  /**
   * THE FAN-OUT. One transaction, and that is the whole point of the method
   * existing at all: a letter signed with no engagements is a client committed
   * to work nobody scheduled, and engagements with no signature is work nobody
   * agreed to. Both are repairable only by hand.
   */
  async signAndFanOut(
    tenantId: string,
    letterId: string,
    signature: SignatureRecord,
    engagements: readonly NewEngagement[],
  ): Promise<{ letter: EngagementLetter; engagements: readonly Engagement[] }> {
    return withTenant(this.app, tenantId, async (db) => {
      const [letter] = await db<LetterRow[]>`
        UPDATE crm.engagement_letter
           SET status = 'signed',
               signed_at = ${signature.signedAt}::timestamptz,
               signed_by_name = ${signature.signedByName},
               signed_by_title = ${signature.signedByTitle},
               signature_method = ${signature.signatureMethod},
               signature_reference = ${signature.signatureReference},
               signed_content_hash = ${signature.signedContentHash}
         WHERE id = ${letterId} AND status = 'sent'
        RETURNING id, tenant_id, ref, party_id, issuing_entity_party_id, proposal_id,
                  jurisdiction, title, status, currency, fx_rate, fx_rate_date, advance_required, advance_amount,
                  advance_recorded_at, advance_recorded_by, sent_at, signed_at, signed_by_name,
                  signature_method, signature_reference, signed_content_hash, signed_by_title,
                  withdrawn_at, background, addressed_to_party_id, issued_on, supersedes_id,
                  effective_from, firm_signatory_user_id, firm_signatory_title, firm_signed_at
      `;
      // `AND status = 'sent'` makes the transition itself the lock: two
      // concurrent signatures cannot both find the row in that state, so the
      // second gets no row rather than a second fan-out.
      if (!letter) {
        throw new Error(
          `engagement letter ${letterId} was not in 'sent' state when the signature landed — ` +
            `it may have been signed or withdrawn concurrently`,
        );
      }

      const created: Engagement[] = [];
      for (const e of engagements) {
        const [row] = await db<EngagementRow[]>`
          INSERT INTO crm.engagement
            (id, tenant_id, engagement_letter_id, engagement_letter_line_id, party_id,
             entity_party_id, status, activated_at, effective_from)
          VALUES
            (${e.id}, ${e.tenantId}, ${e.engagementLetterId}, ${e.engagementLetterLineId},
             ${e.partyId}, ${e.entityPartyId}, ${e.status}, ${e.activatedAt}::timestamptz,
             ${e.effectiveFrom})
          RETURNING id, tenant_id, engagement_letter_id, engagement_letter_line_id, party_id,
                    entity_party_id, status, activated_at, effective_from, ends_on
        `;
        if (!row) throw new Error("engagement insert returned no row");
        created.push(toEngagement(row));
      }
      return { letter: toLetter(letter), engagements: created };
    });
  }

  async recordAdvance(
    tenantId: string,
    letterId: string,
    recordedByUserId: string,
    at: string,
  ): Promise<{ letter: EngagementLetter; released: readonly Engagement[] }> {
    return withTenant(this.app, tenantId, async (db) => {
      const [letter] = await db<LetterRow[]>`
        UPDATE crm.engagement_letter
           SET advance_recorded_at = ${at}::timestamptz, advance_recorded_by = ${recordedByUserId}
         WHERE id = ${letterId} AND advance_recorded_at IS NULL
        RETURNING id, tenant_id, ref, party_id, issuing_entity_party_id, proposal_id,
                  jurisdiction, title, status, currency, fx_rate, fx_rate_date, advance_required, advance_amount,
                  advance_recorded_at, advance_recorded_by, sent_at, signed_at, signed_by_name,
                  signature_method, signature_reference, signed_content_hash, signed_by_title,
                  withdrawn_at, background, addressed_to_party_id, issued_on, supersedes_id,
                  effective_from, firm_signatory_user_id, firm_signatory_title, firm_signed_at
      `;
      // Same trick as the signature: `advance_recorded_at IS NULL` is the lock,
      // so two clicks cannot both release the engagements.
      if (!letter) {
        throw new Error(`the advance on engagement letter ${letterId} was already recorded`);
      }

      const released = await db<EngagementRow[]>`
        UPDATE crm.engagement
           SET status = 'active', activated_at = ${at}::timestamptz
         WHERE engagement_letter_id = ${letterId} AND status = 'pending_advance'
        RETURNING id, tenant_id, engagement_letter_id, engagement_letter_line_id, party_id,
                  entity_party_id, status, activated_at, effective_from, ends_on
      `;
      return { letter: toLetter(letter), released: released.map(toEngagement) };
    });
  }

  async listEngagements(tenantId: string, letterId: string): Promise<readonly Engagement[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<EngagementRow[]>`
        SELECT id, tenant_id, engagement_letter_id, engagement_letter_line_id, party_id,
               entity_party_id, status, activated_at, effective_from, ends_on
        FROM crm.engagement WHERE engagement_letter_id = ${letterId}
        ORDER BY created_at
      `;
      return rows.map(toEngagement);
    });
  }
}
