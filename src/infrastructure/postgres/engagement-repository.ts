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
import { insertDocumentBlocks, strikeDocumentBlocks } from "./block-repository";
import type {
  Engagement,
  EngagementLetter,
  EngagementStatus,
  FeeGroup,
  LetterClause,
  LetterLayout,
  LetterLine,
  LetterStatus,
} from "../../domain/engagement/model";
import { sectionCode } from "../../domain/engagement/model";
import { readClauseBody, readServiceBody } from "../../domain/config/model";
import { resolveTerms } from "../../domain/document/model";
import type { BillingFrequency, OutOfPocketEstimate } from "../../domain/document/model";
import type {
  BillableEngagement,
  EngagementRepository,
  FeeGroupEdit,
  FeeGroupRecord,
  FirmSignatureRecord,
  LetterClauseRecord,
  LetterFilters,
  LetterFrequencyTotal,
  LetterLineEdit,
  LetterLineRecord,
  LetterProseLine,
  LetterRecord,
  LetterRevision,
  LetterSummary,
  LinePricing,
  NewEngagement,
  NewFeeGroup,
  NewLetter,
  NewLetterClause,
  NewLetterLine,
  PinnedService,
  SignatureRecord,
} from "../../usecase/engagement/ports";
import { MAX_LIST_ROWS } from "../../db/limits";

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
  layout: LetterLayout;
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
  firm_signature_version_id: string | null;
  firm_signed_at: Date | null;
  deleted_at: Date | null;
  deleted_by_user_id: string | null;
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
  fee_group_id: string | null;
}

/** Every column of a line, in one place: the SELECT list appears in three
 *  queries and a column added to two of them reads as null on the third. */
const LINE_COLUMNS = `id, tenant_id, engagement_letter_id, entity_party_id, service_version_id,
                      description, position, quantity, unit_amount, currency, discount_percent,
                      effective_from, jurisdiction, billing_frequency, scope_override,
                      client_obligations_override, volume_limits_override, exclusions_override,
                      oop_estimate_min, oop_estimate_max, oop_currency, pricing_note,
                      fee_group_id`;

/** Every column of a letter, for the same reason — it appeared SEVEN times,
 *  written out, until 0083 added `layout` and the choice was seven edits or
 *  one. `describeLetter` and `listLetters` prefix theirs and list them there. */
const LETTER_COLUMNS = `id, tenant_id, ref, party_id, issuing_entity_party_id, proposal_id,
                        jurisdiction, title, status, layout, currency, fx_rate, fx_rate_date,
                        advance_required, advance_amount, advance_recorded_at,
                        advance_recorded_by, sent_at, signed_at, signed_by_name,
                        signature_method, signature_reference, signed_content_hash,
                        signed_by_title, withdrawn_at, background, addressed_to_party_id,
                        issued_on, supersedes_id, effective_from, firm_signatory_user_id,
                        firm_signatory_title, firm_signed_at, firm_signature_version_id,
                        deleted_at, deleted_by_user_id`;

interface FeeGroupRow {
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
}

const FEE_GROUP_COLUMNS = `id, tenant_id, engagement_letter_id, position, title,
                           billing_frequency, amount, currency, payment_terms,
                           fee_description, intro, deliverables, client_obligations`;

function toFeeGroup(r: FeeGroupRow): FeeGroup {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    engagementLetterId: r.engagement_letter_id,
    position: r.position,
    title: r.title,
    billingFrequency: r.billing_frequency,
    amount: r.amount,
    currency: r.currency,
    paymentTerms: r.payment_terms,
    feeDescription: r.fee_description,
    intro: r.intro,
    deliverables: r.deliverables,
    clientObligations: r.client_obligations,
  };
}

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
    layout: r.layout,
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
    firmSignatureVersionId: r.firm_signature_version_id,
    firmSignedAt: r.firm_signed_at?.toISOString() ?? null,
    deletedAt: r.deleted_at?.toISOString() ?? null,
    deletedByUserId: r.deleted_by_user_id,
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
    feeGroupId: r.fee_group_id,
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
           title, layout, currency, fx_rate, fx_rate_date, advance_required, advance_amount,
           background, addressed_to_party_id, issued_on, supersedes_id, effective_from)
        VALUES
          (${l.id}, ${l.tenantId}, ${l.ref}, ${l.partyId}, ${l.issuingEntityPartyId},
           ${l.proposalId}, ${l.jurisdiction}, ${l.title}, ${l.layout},
           ${l.currency}, ${l.fxRate}, ${l.fxRateDate}, ${l.advanceRequired}, ${l.advanceAmount},
           ${l.background}, ${l.addressedToPartyId}, ${l.issuedOn}, ${l.supersedesId},
           ${l.effectiveFrom})
        RETURNING ${db.unsafe(LETTER_COLUMNS)}
      `;
      if (!row) throw new Error("engagement letter insert returned no row");
      return toLetter(row);
    });
  }

  async findLetter(tenantId: string, letterId: string): Promise<EngagementLetter | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<LetterRow[]>`
        SELECT ${db.unsafe(LETTER_COLUMNS)}
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
          deleter_display_name: string | null;
          deleter_email: string | null;
          issuer_jurisdiction: string | null;
        })[]
      >`
        SELECT l.id, l.tenant_id, l.ref, l.party_id, l.issuing_entity_party_id,
               l.proposal_id, l.jurisdiction, l.title, l.status, l.layout,
               l.currency, l.fx_rate, l.fx_rate_date, l.advance_required, l.advance_amount,
               l.advance_recorded_at, l.advance_recorded_by, l.sent_at, l.signed_at,
               l.signed_by_name, l.signature_method, l.signature_reference,
               l.signed_content_hash, l.signed_by_title, l.withdrawn_at,
               l.background, l.addressed_to_party_id, l.issued_on, l.supersedes_id,
               l.effective_from, l.firm_signatory_user_id, l.firm_signatory_title,
               l.firm_signed_at, l.firm_signature_version_id, l.deleted_at, l.deleted_by_user_id,
               party.display_name AS party_display_name,
               issuer.display_name AS issuer_display_name,
               addressee.display_name AS addressee_display_name,
               signatory.display_name AS firm_signatory_display_name,
               previous.ref AS supersedes_ref,
               successor.id  AS superseded_by_id,
               successor.ref AS superseded_by_ref,
               deleter.display_name AS deleter_display_name,
               deleter.email::text AS deleter_email,
               issuer_le.jurisdiction AS issuer_jurisdiction
        FROM crm.engagement_letter l
        JOIN core.party party ON party.id = l.party_id
        -- WHICH OF OUR COMPANIES is contracting, by name — the letterhead and
        -- the signature block both print it. An inner join: the column is NOT
        -- NULL and carries the tenant, so an unresolvable issuer is corruption
        -- rather than a state to render.
        JOIN core.party issuer ON issuer.id = l.issuing_entity_party_id
        -- Where that company is REGISTERED (T6.18 S6): whose law the letter's
        -- terms may name. LEFT: every firm's seeded company has no row.
        LEFT JOIN core.legal_entity issuer_le ON issuer_le.party_id = l.issuing_entity_party_id
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
        -- successor does not count, and nor does a draft one deleted as a
        -- mistake (0086) — exactly the predicate el_one_live_successor_per_letter
        -- uses to keep it single.
        LEFT JOIN crm.engagement_letter previous ON previous.id = l.supersedes_id
        LEFT JOIN crm.engagement_letter successor
               ON successor.supersedes_id = l.id AND successor.status <> 'withdrawn'
              AND successor.deleted_at IS NULL
        -- Who deleted it (0086) — deleted or not, one letter always opens.
        LEFT JOIN tenancy.user_account deleter ON deleter.id = l.deleted_by_user_id
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
               l.fee_group_id,
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
      //
      // A FEE GROUP'S fee is counted ONCE, beside the lines priced on their own,
      // and its lines are not "unpriced": the group is their price (0083).
      // Lines carry no amount of their own once grouped, so nothing is counted
      // twice.
      const [totals] = await db<
        {
          gross: string | null;
          discount: string | null;
          net: string | null;
          unpriced_line_count: string;
        }[]
      >`
        -- Two aggregates with no GROUP BY, so each is exactly one row even on a
        -- letter with no lines or no groups — a group added before its services
        -- still shows its fee.
        SELECT t.gross + g.fees AS gross, t.discount, t.net + g.fees AS net,
               t.unpriced_line_count
        FROM (
          SELECT coalesce(sum(round(unit_amount * quantity, 4)), 0) AS gross,
                 coalesce(sum(round(unit_amount * quantity, 4)
                            - round(unit_amount * quantity * (1 - discount_percent / 100), 4)), 0)
                   AS discount,
                 coalesce(sum(round(unit_amount * quantity * (1 - discount_percent / 100), 4)), 0)
                   AS net,
                 count(*) FILTER (WHERE unit_amount IS NULL AND fee_group_id IS NULL)
                   AS unpriced_line_count
          FROM crm.engagement_letter_line
          WHERE engagement_letter_id = ${letterId} AND removed_at IS NULL
        ) t
        CROSS JOIN (
          SELECT coalesce(sum(amount), 0) AS fees
          FROM crm.engagement_letter_fee_group
          WHERE engagement_letter_id = ${letterId} AND removed_at IS NULL
        ) g
      `;

      const groups = await db<FeeGroupRow[]>`
        SELECT ${db.unsafe(FEE_GROUP_COLUMNS)}
        FROM crm.engagement_letter_fee_group
        WHERE engagement_letter_id = ${letterId} AND removed_at IS NULL
        ORDER BY position
      `;

      // THE MONEY PER FREQUENCY (T6.18, D8), added by the database. A line
      // priced on its own counts at its own frequency; a SECTION's fee counts
      // ONCE at the section's, and its lines not at all (they carry no price of
      // their own, 0083) - the same rule the one-figure totals above follow.
      // `sum` skips an unpriced line's NULL and the count beside it says so.
      const byFrequency = await db<
        {
          frequency: BillingFrequency | null;
          net: string | null;
          line_count: string;
          unpriced_line_count: string;
        }[]
      >`
        SELECT x.frequency,
               sum(x.net)::text AS net,
               count(*) AS line_count,
               count(*) FILTER (WHERE x.net IS NULL) AS unpriced_line_count
        FROM (
          SELECT billing_frequency AS frequency,
                 round(unit_amount * quantity * (1 - discount_percent / 100), 4) AS net
          FROM crm.engagement_letter_line
          WHERE engagement_letter_id = ${letterId} AND removed_at IS NULL AND fee_group_id IS NULL
          UNION ALL
          SELECT billing_frequency, amount
          FROM crm.engagement_letter_fee_group
          WHERE engagement_letter_id = ${letterId} AND removed_at IS NULL
        ) x
        GROUP BY x.frequency
        ORDER BY coalesce(array_position(
                   ARRAY['monthly', 'quarterly', 'annually', 'one_time', 'custom'],
                   x.frequency::text), 99)
      `;

      const engagements = await db<EngagementRow[]>`
        SELECT id, tenant_id, engagement_letter_id, engagement_letter_line_id, party_id,
               entity_party_id, status, activated_at, effective_from, ends_on
        FROM crm.engagement WHERE engagement_letter_id = ${letterId}
      `;

      return {
        letter: toLetter(head),
        party: { id: head.party_id, displayName: head.party_display_name },
        issuerJurisdiction: head.issuer_jurisdiction,
        totalsByFrequency: byFrequency.map(
          (f): LetterFrequencyTotal => ({
            frequency: f.frequency,
            net: f.net ?? "0",
            lineCount: Number(f.line_count),
            unpricedLineCount: Number(f.unpriced_line_count),
          }),
        ),
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
        deletedBy:
          head.deleted_by_user_id === null || head.deleter_email === null
            ? null
            : {
                userId: head.deleted_by_user_id,
                displayName: head.deleter_display_name,
                email: head.deleter_email,
              },
        feeGroups: groups.map(
          (g, i): FeeGroupRecord => ({
            group: toFeeGroup(g),
            code: sectionCode(i),
            lineIds: lines.filter((l) => l.fee_group_id === g.id).map((l) => l.id),
          }),
        ),
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
               l.proposal_id, l.jurisdiction, l.title, l.status, l.layout,
               l.currency, l.fx_rate, l.fx_rate_date, l.advance_required, l.advance_amount,
               l.advance_recorded_at, l.advance_recorded_by, l.sent_at, l.signed_at,
               l.signed_by_name, l.signature_method, l.signature_reference,
               l.signed_content_hash, l.signed_by_title, l.withdrawn_at,
               l.background, l.addressed_to_party_id, l.issued_on, l.supersedes_id,
               l.effective_from, l.firm_signatory_user_id, l.firm_signatory_title,
               l.firm_signed_at, l.firm_signature_version_id, l.deleted_at, l.deleted_by_user_id,
               party.display_name AS party_display_name,
               issuer.display_name AS issuer_display_name,
               t.gross + g.fees AS gross, t.discount, t.net + g.fees AS net,
               coalesce(t.line_count, 0) AS line_count,
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
                 -- A grouped line is priced by its group (0083), so it is not
                 -- one of the lines these figures leave out.
                 count(*) FILTER (WHERE unit_amount IS NULL AND fee_group_id IS NULL)
                   AS unpriced_line_count
          FROM crm.engagement_letter_line
          WHERE engagement_letter_id = l.id AND removed_at IS NULL
        ) t ON true
        -- Each live fee group's fee, once (0083) — the same arithmetic as the
        -- letter's own read, so the list and the page cannot disagree.
        LEFT JOIN LATERAL (
          SELECT coalesce(sum(amount), 0) AS fees
          FROM crm.engagement_letter_fee_group
          WHERE engagement_letter_id = l.id AND removed_at IS NULL
        ) g ON true
        WHERE (${filters.status ?? null}::text IS NULL OR l.status = ${filters.status ?? null})
          AND (${filters.partyId ?? null}::uuid IS NULL OR l.party_id = ${filters.partyId ?? null})
          -- A deleted draft was never on the table (0086): not in the list,
          -- under any status filter.
          AND l.deleted_at IS NULL
        ORDER BY l.created_at DESC
        -- A CEILING, not pagination — see MAX_LIST_ROWS.
        LIMIT ${MAX_LIST_ROWS}
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
           oop_estimate_min, oop_estimate_max, oop_currency, pricing_note, fee_group_id)
        SELECT $1, $2, $3, $4, $5, $6, coalesce(max(position), 0) + 1,
               $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
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
          l.feeGroupId,
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
  async updateLine(
    tenantId: string,
    letterId: string,
    lineId: string,
    edit: LetterLineEdit,
  ): Promise<LetterLine | null> {
    return withTenant(this.app, tenantId, async (db) => {
      // Whole values, judged by the service on the line as it will be. The
      // WHERE repeats "a live line of a live draft": a letter sent, deleted or
      // the line pulled since the service read it is left exactly as it is.
      const [row] = await db<LineRow[]>`
        UPDATE crm.engagement_letter_line
           SET entity_party_id = ${edit.entityPartyId},
               description = ${edit.description},
               quantity = ${edit.quantity},
               unit_amount = ${edit.unitAmount}::numeric,
               discount_percent = ${edit.discountPercent},
               effective_from = ${edit.effectiveFrom}::date,
               jurisdiction = ${edit.jurisdiction},
               billing_frequency = ${edit.billingFrequency},
               scope_override = ${edit.scopeOverride},
               client_obligations_override = ${edit.clientObligationsOverride},
               volume_limits_override = ${edit.volumeLimitsOverride},
               exclusions_override = ${edit.exclusionsOverride},
               oop_estimate_min = ${edit.oopEstimate?.min ?? null}::numeric,
               oop_estimate_max = ${edit.oopEstimate?.max ?? null}::numeric,
               oop_currency = ${edit.oopEstimate?.currency ?? null},
               pricing_note = ${edit.pricingNote}
         WHERE id = ${lineId} AND engagement_letter_id = ${letterId} AND removed_at IS NULL
           AND EXISTS (SELECT 1 FROM crm.engagement_letter l
                        WHERE l.id = ${letterId} AND l.status = 'draft' AND l.deleted_at IS NULL)
        RETURNING ${db.unsafe(LINE_COLUMNS)}
      `;
      return row ? toLine(row) : null;
    });
  }

  async revise(
    tenantId: string,
    letterId: string,
    change: LetterRevision,
    prose: readonly LetterProseLine[] | null,
  ): Promise<EngagementLetter | null> {
    return withTenant(this.app, tenantId, async (db) => {
      // One statement, each column kept unless the change names it - the
      // proposal's `revise`, for the same reason: NULL is a real value here,
      // and clearing the Background is a change, not an absence of one.
      const has = (k: keyof LetterRevision): boolean => change[k] !== undefined;
      const [row] = await db<LetterRow[]>`
        UPDATE crm.engagement_letter
           SET title = CASE WHEN ${has("title")} THEN ${change.title ?? null} ELSE title END,
               background = CASE WHEN ${has("background")} THEN ${change.background ?? null}
                                 ELSE background END,
               addressed_to_party_id = CASE WHEN ${has("addressedToPartyId")}
                                            THEN ${change.addressedToPartyId ?? null}::uuid
                                            ELSE addressed_to_party_id END,
               issued_on = CASE WHEN ${has("issuedOn")} THEN ${change.issuedOn ?? null}::date
                                ELSE issued_on END,
               effective_from = CASE WHEN ${has("effectiveFrom")}
                                     THEN ${change.effectiveFrom ?? null}::date
                                     ELSE effective_from END,
               -- The advance's two columns move together (el_advance_is_coherent_chk),
               -- and the service always sends both.
               advance_required = CASE WHEN ${has("advanceRequired")}
                                       THEN ${change.advanceRequired ?? false}
                                       ELSE advance_required END,
               advance_amount = CASE WHEN ${has("advanceRequired")}
                                     THEN ${change.advanceAmount ?? null}::numeric
                                     ELSE advance_amount END,
               jurisdiction = CASE WHEN ${has("jurisdiction")} THEN ${change.jurisdiction ?? null}
                                   ELSE jurisdiction END,
               issuing_entity_party_id = CASE WHEN ${has("issuingEntityPartyId")}
                                              THEN ${change.issuingEntityPartyId ?? null}::uuid
                                              ELSE issuing_entity_party_id END,
               currency = CASE WHEN ${has("currency")} THEN ${change.currency ?? null}
                               ELSE currency END,
               fx_rate = CASE WHEN ${has("fxRate")} THEN ${change.fxRate ?? null}::numeric
                              ELSE fx_rate END,
               fx_rate_date = CASE WHEN ${has("fxRateDate")} THEN ${change.fxRateDate ?? null}::date
                                   ELSE fx_rate_date END
         -- A live draft only, repeated here: a letter sent or deleted since the
         -- service read it is left exactly as it stands.
         WHERE id = ${letterId} AND status = 'draft' AND deleted_at IS NULL
           -- A new currency over NO line or section row at all, live or pulled:
           -- their keys to the letter's currency do not cascade (0017, 0083),
           -- so the row a draft pulled a line off still holds the old one.
           AND (${change.currency ?? null}::text IS NULL
                OR currency = ${change.currency ?? null}
                OR (NOT EXISTS (SELECT 1 FROM crm.engagement_letter_line x
                                 WHERE x.engagement_letter_id = ${letterId})
                    AND NOT EXISTS (SELECT 1 FROM crm.engagement_letter_fee_group g
                                     WHERE g.engagement_letter_id = ${letterId})))
        RETURNING ${db.unsafe(LETTER_COLUMNS)}
      `;
      if (!row) return null;
      // THE NEW COMPANY'S OR COUNTRY'S WORDING, in the same transaction (D9):
      // the old lines struck off, the standard set written in their place, so a
      // draft can never name one company in its head and carry another's prose.
      if (prose !== null) {
        const owner = { kind: "engagement_letter" as const, id: letterId };
        await strikeDocumentBlocks(db, owner);
        await insertDocumentBlocks(
          db,
          prose.map((p) => ({ ...p, tenantId, owner })),
        );
      }
      return toLetter(row);
    });
  }

  async pricesAnything(tenantId: string, letterId: string): Promise<boolean> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ priced: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM crm.engagement_letter_line
                        WHERE engagement_letter_id = ${letterId})
            OR EXISTS (SELECT 1 FROM crm.engagement_letter_fee_group
                        WHERE engagement_letter_id = ${letterId}) AS priced
      `;
      return row?.priced ?? false;
    });
  }


  /**
   * Into a fee group or out of one, with the price the line has afterwards —
   * ONE statement, so no reader sees a line both grouped and priced, which
   * `el_line_grouped_is_unpriced_chk` would refuse half way through anyway.
   */
  async setLinePricing(
    tenantId: string,
    letterId: string,
    lineId: string,
    pricing: LinePricing,
  ): Promise<LetterLine> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db.unsafe<LineRow[]>(
        `
        UPDATE crm.engagement_letter_line
           SET fee_group_id = $4, unit_amount = $5, discount_percent = $6, pricing_note = $7
         WHERE id = $1 AND engagement_letter_id = $2 AND tenant_id = $3 AND removed_at IS NULL
        RETURNING ${LINE_COLUMNS}
      `,
        [
          lineId,
          letterId,
          tenantId,
          pricing.feeGroupId,
          pricing.unitAmount,
          pricing.discountPercent,
          pricing.pricingNote,
        ],
      );
      if (!row) throw new Error(`engagement letter line ${lineId} vanished while being repriced`);
      return toLine(row);
    });
  }

  async addFeeGroup(g: NewFeeGroup): Promise<FeeGroup> {
    return withTenant(this.app, g.tenantId, async (db) => {
      // The position is assigned in the same statement that inserts, after the
      // letter's last LIVE group — the line's own arrangement, for the same
      // reason: two people adding a group to one draft cannot race for it.
      const [row] = await db<FeeGroupRow[]>`
        INSERT INTO crm.engagement_letter_fee_group
          (id, tenant_id, engagement_letter_id, currency, position, title, billing_frequency,
           amount, payment_terms, fee_description, intro, deliverables, client_obligations)
        SELECT ${g.id}, ${g.tenantId}, ${g.engagementLetterId}, ${g.currency},
               coalesce(max(position), 0) + 1, ${g.title}, ${g.billingFrequency}, ${g.amount},
               ${g.paymentTerms}, ${g.feeDescription}, ${g.intro}, ${g.deliverables},
               ${g.clientObligations}
        FROM crm.engagement_letter_fee_group
        WHERE engagement_letter_id = ${g.engagementLetterId} AND removed_at IS NULL
        RETURNING ${db.unsafe(FEE_GROUP_COLUMNS)}
      `;
      if (!row) throw new Error("fee group insert returned no row");
      return toFeeGroup(row);
    });
  }

  async editFeeGroup(
    tenantId: string,
    letterId: string,
    groupId: string,
    edit: FeeGroupEdit,
  ): Promise<FeeGroup> {
    return withTenant(this.app, tenantId, async (db) => {
      // One UPDATE naming every column, each kept as it is unless the edit
      // carries it — `undefined` is "not mentioned", which is different from a
      // prose field the caller cleared to null.
      const keep = (v: unknown): boolean => v === undefined;
      const [row] = await db<FeeGroupRow[]>`
        UPDATE crm.engagement_letter_fee_group
           SET title = CASE WHEN ${keep(edit.title)} THEN title ELSE ${edit.title ?? null} END,
               billing_frequency = CASE WHEN ${keep(edit.billingFrequency)} THEN billing_frequency
                                        ELSE ${edit.billingFrequency ?? null} END,
               amount = CASE WHEN ${keep(edit.amount)} THEN amount
                             ELSE ${edit.amount ?? null}::numeric END,
               payment_terms = CASE WHEN ${keep(edit.paymentTerms)} THEN payment_terms
                                    ELSE ${edit.paymentTerms ?? null} END,
               fee_description = CASE WHEN ${keep(edit.feeDescription)} THEN fee_description
                                      ELSE ${edit.feeDescription ?? null} END,
               intro = CASE WHEN ${keep(edit.intro)} THEN intro ELSE ${edit.intro ?? null} END,
               deliverables = CASE WHEN ${keep(edit.deliverables)} THEN deliverables
                                   ELSE ${edit.deliverables ?? null} END,
               client_obligations = CASE WHEN ${keep(edit.clientObligations)} THEN client_obligations
                                         ELSE ${edit.clientObligations ?? null} END
         WHERE id = ${groupId} AND engagement_letter_id = ${letterId} AND removed_at IS NULL
        RETURNING ${db.unsafe(FEE_GROUP_COLUMNS)}
      `;
      if (!row) throw new Error(`fee group ${groupId} vanished while being edited`);
      return toFeeGroup(row);
    });
  }

  async removeFeeGroup(tenantId: string, letterId: string, groupId: string): Promise<void> {
    await withTenant(this.app, tenantId, async (db) => {
      await db`
        UPDATE crm.engagement_letter_fee_group SET removed_at = now()
        WHERE id = ${groupId} AND engagement_letter_id = ${letterId} AND removed_at IS NULL
      `;
    });
  }

  async listFeeGroups(tenantId: string, letterId: string): Promise<readonly FeeGroup[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<FeeGroupRow[]>`
        SELECT ${db.unsafe(FEE_GROUP_COLUMNS)}
        FROM crm.engagement_letter_fee_group
        WHERE engagement_letter_id = ${letterId} AND removed_at IS NULL
        ORDER BY position
      `;
      return rows.map(toFeeGroup);
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
        RETURNING ${db.unsafe(LETTER_COLUMNS)}
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
               firm_signed_at         = ${firm?.signedAt ?? null}::timestamptz,
               -- THE MARK, PINNED (0081). Written in the same statement as the
               -- three columns above so a letter can never go out with a
               -- signatory recorded and the image resolved a moment later from
               -- a brand asset somebody replaced in between.
               firm_signature_version_id = ${firm?.signatureVersionId ?? null}
         WHERE id = ${letterId} AND status = 'draft'
        RETURNING ${db.unsafe(LETTER_COLUMNS)}
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
        SELECT ${db.unsafe(LETTER_COLUMNS)}
        FROM crm.engagement_letter
        WHERE supersedes_id = ${letterId} AND status <> 'withdrawn' AND deleted_at IS NULL
      `;
      return row ? toLetter(row) : null;
    });
  }

  async markDeleted(
    tenantId: string,
    letterId: string,
    deletedByUserId: string | null,
  ): Promise<EngagementLetter | null> {
    return withTenant(this.app, tenantId, async (db) => {
      // Only these two columns: `trg_el_guard_deletion` refuses a deletion that
      // changes anything else, and the freeze refuses any change to a signed
      // letter before it is even asked. `now()` belongs to this transaction.
      const [row] = await db<LetterRow[]>`
        UPDATE crm.engagement_letter
           SET deleted_at = now(), deleted_by_user_id = ${deletedByUserId}
         WHERE id = ${letterId} AND status = 'draft' AND deleted_at IS NULL
        RETURNING ${db.unsafe(LETTER_COLUMNS)}
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
        RETURNING ${db.unsafe(LETTER_COLUMNS)}
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
        RETURNING ${db.unsafe(LETTER_COLUMNS)}
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

  /**
   * What this client can be billed for, with the terms its letters agreed.
   *
   * ONLY SIGNED letters, because an engagement only exists once one is signed —
   * the join is belt and braces, and it is the column an invoice screen must
   * not be able to reach past.
   *
   * Ordered by the entity and then the letter line's own position, so a group
   * of four companies reads as four blocks in the order the contract lists
   * them rather than in insertion order.
   */
  async listBillable(
    tenantId: string,
    partyId: string,
  ): Promise<readonly BillableEngagement[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<BillableRow[]>`
        SELECT e.id, e.entity_party_id, e.status,
               e.effective_from::text AS effective_from, e.ends_on::text AS ends_on,
               ep.display_name AS entity_name,
               l.id AS letter_id, l.ref AS letter_ref,
               ll.description, ll.quantity::text AS quantity,
               ll.unit_amount::text AS unit_amount, ll.pricing_note,
               ll.currency, ll.discount_percent::text AS discount_percent,
               -- A grouped engagement is billed at its GROUP's period (0083); the
               -- line's own is the service's recurrence, copied at drafting.
               coalesce(g.billing_frequency, ll.billing_frequency) AS billing_frequency,
               g.id AS fee_group_id, g.rank AS fee_group_rank, g.title AS fee_group_title,
               g.amount::text AS fee_group_amount,
               g.billing_frequency AS fee_group_frequency, g.line_count AS fee_group_line_count
          FROM crm.engagement e
          JOIN crm.engagement_letter l
            ON l.id = e.engagement_letter_id AND l.tenant_id = e.tenant_id
          JOIN crm.engagement_letter_line ll
            ON ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
          JOIN core.party ep
            ON ep.id = e.entity_party_id AND ep.tenant_id = e.tenant_id
          -- The group that prices the line, with its section letter (its rank
          -- among the letter's live groups) and how many live lines it covers.
          LEFT JOIN LATERAL (
            SELECT fg.id, fg.title, fg.amount, fg.billing_frequency,
                   (SELECT count(*) FROM crm.engagement_letter_fee_group o
                     WHERE o.engagement_letter_id = fg.engagement_letter_id
                       AND o.removed_at IS NULL AND o.position <= fg.position)::int AS rank,
                   (SELECT count(*) FROM crm.engagement_letter_line m
                     WHERE m.fee_group_id = fg.id AND m.removed_at IS NULL)::int AS line_count
              FROM crm.engagement_letter_fee_group fg
             WHERE fg.id = ll.fee_group_id AND fg.tenant_id = ll.tenant_id
          ) g ON true
         WHERE e.party_id = ${partyId}
         ORDER BY ep.display_name ASC, ll.position ASC
      `;
      return rows.map((r) => ({
        engagementId: r.id,
        entityPartyId: r.entity_party_id,
        entityName: r.entity_name,
        letterId: r.letter_id,
        letterRef: r.letter_ref,
        description: r.description,
        quantity: r.quantity,
        unitAmount: r.unit_amount,
        pricingNote: r.pricing_note,
        currency: r.currency,
        discountPercent: r.discount_percent,
        billingFrequency: r.billing_frequency,
        status: r.status,
        effectiveFrom: r.effective_from,
        endsOn: r.ends_on,
        feeGroup:
          r.fee_group_id === null ||
          r.fee_group_rank === null ||
          r.fee_group_title === null ||
          r.fee_group_amount === null ||
          r.fee_group_frequency === null
            ? null
            : {
                id: r.fee_group_id,
                code: sectionCode(r.fee_group_rank - 1),
                title: r.fee_group_title,
                amount: r.fee_group_amount,
                billingFrequency: r.fee_group_frequency,
                lineCount: r.fee_group_line_count ?? 0,
              },
      }));
    });
  }
}

/** The joined row behind `listBillable`. `::text` on every numeric and date for
 *  the reason at the top of this file: postgres.js turns a `date` into an
 *  INSTANT and a `numeric` into a float, and money is a decimal string here
 *  from the database to the screen. */
interface BillableRow {
  id: string;
  entity_party_id: string;
  entity_name: string;
  letter_id: string;
  letter_ref: string;
  description: string;
  quantity: string;
  unit_amount: string | null;
  pricing_note: string | null;
  currency: string;
  discount_percent: string;
  billing_frequency: string | null;
  status: string;
  effective_from: string;
  ends_on: string | null;
  fee_group_id: string | null;
  fee_group_rank: number | null;
  fee_group_title: string | null;
  fee_group_amount: string | null;
  fee_group_frequency: string | null;
  fee_group_line_count: number | null;
}
