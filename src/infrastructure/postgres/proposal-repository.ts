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
import { withTenant } from "../../db/tenant";
import type { Proposal, ProposalLine, ProposalStatus } from "../../domain/proposal/model";
import { readServiceBody } from "../../domain/config/model";
import type {
  NewProposal,
  NewProposalLine,
  PinnedService,
  ProposalFilters,
  ProposalLineRecord,
  ProposalRecord,
  ProposalRepository,
  ProposalSummary,
  SharedProposal,
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
  view_count: number;
  declined_reason: string | null;
}

interface LineRow {
  id: string;
  tenant_id: string;
  proposal_id: string;
  entity_party_id: string | null;
  service_version_id: string;
  description: string;
  position: number;
  quantity: string;
  unit_amount: string;
  currency: string;
  discount_percent: string;
}

interface TotalsRow {
  gross: string | null;
  discount: string | null;
  net: string | null;
  line_count: string;
}

/** A date column, as a day. `toISOString().slice(0,10)` would be wrong for a
 *  date east of UTC: node builds the Date at local midnight, and converting to
 *  UTC can move it back a day. */
function toDay(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${String(year)}-${month}-${day}`;
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
    viewCount: r.view_count,
    declinedReason: r.declined_reason,
  };
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
  };
}

/** An empty proposal sums to nulls, not to zeroes — SUM over no rows is null.
 *  Zero in the quote's own currency is the honest reading of "nothing yet". */
function toTotals(r: TotalsRow | undefined, currency: string): ProposalRecord["totals"] {
  return {
    gross: r?.gross ?? "0",
    discount: r?.discount ?? "0",
    net: r?.net ?? "0",
    currency,
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
           currency, fx_rate, fx_rate_date, valid_until)
        VALUES
          (${p.id}, ${p.tenantId}, ${p.ref}, ${p.partyId}, ${p.issuingEntityPartyId},
           ${p.leadId}, ${p.title},
           ${p.currency}, ${p.fxRate}, ${p.fxRateDate}, ${p.validUntil})
        RETURNING id, tenant_id, ref, party_id, issuing_entity_party_id, lead_id, title, status,
                  currency, fx_rate, fx_rate_date, valid_until, sent_at, decided_at,
                  discount_approved_by, discount_approved_at, first_viewed_at, view_count,
                  declined_reason
      `;
      if (!row) throw new Error("proposal insert returned no row");
      return toProposal(row);
    });
  }

  async findById(tenantId: string, proposalId: string): Promise<Proposal | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<ProposalRow[]>`
        SELECT id, tenant_id, ref, party_id, issuing_entity_party_id, lead_id, title, status,
               currency, fx_rate, fx_rate_date, valid_until, sent_at, decided_at,
               discount_approved_by, discount_approved_at, first_viewed_at, view_count,
                  declined_reason
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
        })[]
      >`
        SELECT p.id, p.tenant_id, p.ref, p.party_id, p.issuing_entity_party_id, p.lead_id,
               p.title, p.status, p.currency,
               p.fx_rate, p.fx_rate_date, p.valid_until, p.sent_at, p.decided_at,
               p.discount_approved_by, p.discount_approved_at,
               p.first_viewed_at, p.view_count, p.declined_reason,
               party.display_name AS party_display_name,
               issuer.display_name AS issuer_display_name,
               approver.display_name AS approver_display_name,
               approver.email AS approver_email
        FROM crm.proposal p
        JOIN core.party party ON party.id = p.party_id
        -- WHICH OF OUR COMPANIES is offering, by name. An inner join: the
        -- column is NOT NULL and carries the tenant, so a proposal with no
        -- resolvable issuer is corruption rather than a state to render.
        JOIN core.party issuer ON issuer.id = p.issuing_entity_party_id
        LEFT JOIN tenancy.user_account approver ON approver.id = p.discount_approved_by
        WHERE p.id = ${proposalId}
      `;
      if (!head) return null;

      // The lines, each with the catalogue version it was PINNED to — its code,
      // its Dept, its SLA, its scope blocks and its list price AS THEY WERE,
      // which is the question the pin exists to answer and the reason this join
      // reads config.version by id rather than looking the service up live.
      // ONE join for the whole document: a screen wanting to print `A1` used to
      // call the registry once per line.
      const lines = await db<
        (LineRow & {
          net: string;
          service_key: string;
          service_version: number;
          service_body: Record<string, unknown>;
          entity_display_name: string | null;
        })[]
      >`
        SELECT l.id, l.tenant_id, l.proposal_id, l.entity_party_id, l.service_version_id,
               l.description,
               l.position, l.quantity, l.unit_amount, l.currency, l.discount_percent,
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
        SELECT line_count, gross, discount, net
        FROM crm.proposal_totals WHERE proposal_id = ${proposalId}
      `;

      return {
        proposal: toProposal(head),
        party: { id: head.party_id, displayName: head.party_display_name },
        issuingEntity: {
          id: head.issuing_entity_party_id,
          displayName: head.issuer_display_name,
        },
        lines: lines.map(
          (r): ProposalLineRecord => ({
            line: toLine(r),
            entity:
              r.entity_party_id === null || r.entity_display_name === null
                ? null
                : { id: r.entity_party_id, displayName: r.entity_display_name },
            service: toPinnedService(r.service_key, r.service_version, r.service_body),
            net: r.net,
          }),
        ),
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
        })[]
      >`
        SELECT p.id, p.tenant_id, p.ref, p.party_id, p.issuing_entity_party_id, p.lead_id,
               p.title, p.status, p.currency,
               p.fx_rate, p.fx_rate_date, p.valid_until, p.sent_at, p.decided_at,
               p.discount_approved_by, p.discount_approved_at,
               p.first_viewed_at, p.view_count, p.declined_reason,
               party.display_name AS party_display_name,
               issuer.display_name AS issuer_display_name,
               t.gross, t.discount, t.net, coalesce(t.line_count, 0) AS line_count
        FROM crm.proposal p
        JOIN core.party party ON party.id = p.party_id
        JOIN core.party issuer ON issuer.id = p.issuing_entity_party_id
        -- LEFT, because a proposal with no lines has no row in the view at all:
        -- SUM over nothing is null, and the mapper reads that as zero.
        LEFT JOIN crm.proposal_totals t ON t.proposal_id = p.id
        WHERE (${filters.status ?? null}::text IS NULL OR p.status = ${filters.status ?? null})
          AND (${filters.partyId ?? null}::uuid IS NULL OR p.party_id = ${filters.partyId ?? null})
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

  async addLine(l: NewProposalLine): Promise<ProposalLine> {
    return withTenant(this.app, l.tenantId, async (db) => {
      // The position is assigned HERE, under the same statement that inserts,
      // rather than computed by the caller and passed down: two people adding a
      // line to one draft would otherwise race for the same number and one of
      // them would lose to the unique index for no reason they could act on.
      const [row] = await db<LineRow[]>`
        INSERT INTO crm.proposal_line
          (id, tenant_id, proposal_id, entity_party_id, service_version_id, description,
           position, quantity, unit_amount, currency, discount_percent)
        SELECT ${l.id}, ${l.tenantId}, ${l.proposalId}, ${l.entityPartyId},
               ${l.serviceVersionId},
               ${l.description},
               coalesce(max(position), 0) + 1,
               ${l.quantity}, ${l.unitAmount}, ${l.currency}, ${l.discountPercent}
        FROM crm.proposal_line
        WHERE proposal_id = ${l.proposalId} AND removed_at IS NULL
        RETURNING id, tenant_id, proposal_id, entity_party_id, service_version_id, description,
                  position, quantity, unit_amount, currency, discount_percent
      `;
      if (!row) throw new Error("proposal line insert returned no row");
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
      const rows = await db<LineRow[]>`
        SELECT id, tenant_id, proposal_id, entity_party_id, service_version_id, description,
               position, quantity, unit_amount, currency, discount_percent
        FROM crm.proposal_line
        WHERE proposal_id = ${proposalId} AND removed_at IS NULL
        ORDER BY position
      `;
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
        RETURNING id, tenant_id, ref, party_id, issuing_entity_party_id, lead_id, title, status,
                  currency, fx_rate, fx_rate_date, valid_until, sent_at, decided_at,
                  discount_approved_by, discount_approved_at, first_viewed_at, view_count,
                  declined_reason
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
  async findShared(tenantId: string, digest: string): Promise<SharedProposal | null> {
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
        }[]
      >`
        SELECT p.id, p.ref, p.title, p.status, p.currency, p.valid_until, p.sent_at,
               firm.name AS firm_name,
               issuer.display_name AS issuer_display_name,
               party.display_name AS party_display_name,
               t.gross, t.discount, t.net
        FROM crm.proposal p
        JOIN core.party party ON party.id = p.party_id
        -- The recipient is told which of our companies is offering. It is not
        -- always the group name above it, and a client is entitled to know
        -- which company they would be contracting with.
        JOIN core.party issuer ON issuer.id = p.issuing_entity_party_id
        JOIN tenancy.tenant firm ON firm.id = p.tenant_id
        LEFT JOIN crm.proposal_totals t ON t.proposal_id = p.id
        WHERE p.share_token_digest = ${digest}
      `;
      if (!head) return null;

      const lines = await db<
        {
          description: string;
          quantity: string;
          unit_amount: string;
          discount_percent: string;
          net: string;
        }[]
      >`
        SELECT l.description, l.quantity, l.unit_amount, l.discount_percent, a.net
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
        })),
        totals: {
          gross: head.gross ?? "0",
          discount: head.discount ?? "0",
          net: head.net ?? "0",
          currency: head.currency,
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
           SET view_count = view_count + 1,
               first_viewed_at = coalesce(first_viewed_at, ${at}::timestamptz)
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
        RETURNING id, tenant_id, ref, party_id, issuing_entity_party_id, lead_id, title, status,
                  currency, fx_rate, fx_rate_date, valid_until, sent_at, decided_at,
                  discount_approved_by, discount_approved_at, first_viewed_at, view_count,
                  declined_reason
      `;
      if (!row) throw new Error(`proposal ${proposalId} vanished mid-approval`);
      return toProposal(row);
    });
  }
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
