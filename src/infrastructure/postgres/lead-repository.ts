// Postgres adapter for the commercial pipeline. Every method runs under
// withTenant, so the RLS tenant wall applies to each statement. timestamptz
// arrives as a Date and leaves as an ISO 8601 string — the door where Postgres
// types become ours.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { Lead, LeadSource, LeadStage, LeadValue } from "../../domain/lead/model";
import type { PartyKind } from "../../domain/party/model";
import type { LeadDetail, LeadRecord, LeadRepository, NewLead } from "../../usecase/lead/ports";
import { LeadHasProposals } from "../../domain/lead/errors";
import { MAX_LIST_ROWS } from "../../db/limits";

/** The lead columns, as Postgres hands them over. Exported because the
 *  assignment adapter (lead-assignment.ts) returns a lead from its own UPDATE
 *  and must map it identically — two mappings of one table is how a column
 *  added in a migration reaches one read and not the other. */
export interface LeadRow {
  id: string;
  tenant_id: string;
  title: string;
  party_id: string;
  source: LeadSource;
  stage: LeadStage;
  owner_user_id: string | null;
  notes: string | null;
  lost_reason: string | null;
  jurisdiction: string | null;
  /** `numeric` arrives as a STRING from postgres.js and stays one — the
   *  money rule. */
  estimated_value: string | null;
  estimated_value_currency: string | null;
  captured_at: Date;
  closed_at: Date | null;
  deleted_at: Date | null;
  deleted_by_user_id: string | null;
}

/** A lead joined to the party it is about and the colleague who owns it. */
interface LeadRecordRow extends LeadRow {
  party_kind: PartyKind;
  party_display_name: string;
  owner_display_name: string | null;
  owner_email: string | null;
}

function toRecord(r: LeadRecordRow): LeadRecord {
  return {
    lead: toLead(r),
    party: { id: r.party_id, kind: r.party_kind, displayName: r.party_display_name },
    // The LEFT JOIN yields nulls for an unassigned lead. owner_email is the
    // discriminator rather than owner_user_id, because an account always has an
    // email and may have no name.
    owner:
      r.owner_user_id === null || r.owner_email === null
        ? null
        : {
            userId: r.owner_user_id,
            displayName: r.owner_display_name,
            email: r.owner_email,
          },
  };
}

export function toLead(r: LeadRow): Lead {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    title: r.title,
    partyId: r.party_id,
    source: r.source,
    stage: r.stage,
    ownerUserId: r.owner_user_id,
    jurisdiction: r.jurisdiction,
    // lead_estimated_value_pair_chk holds the two together, so either both are
    // here or neither is.
    estimatedValue:
      r.estimated_value === null || r.estimated_value_currency === null
        ? null
        : { amount: r.estimated_value, currency: r.estimated_value_currency },
    notes: r.notes,
    lostReason: r.lost_reason,
    capturedAt: r.captured_at.toISOString(),
    closedAt: r.closed_at?.toISOString() ?? null,
    deletedAt: r.deleted_at?.toISOString() ?? null,
    deletedByUserId: r.deleted_by_user_id,
  };
}

export class PostgresLeadRepository implements LeadRepository {
  constructor(private readonly app: Db) {}

  async create(l: NewLead): Promise<Lead> {
    return withTenant(this.app, l.tenantId, async (db) => {
      // stage and captured_at are the column defaults ('new', now()): a lead
      // starts at the beginning of the pipeline and is captured when it is
      // captured, and neither is the caller's to state. lost_reason is absent
      // for the same reason turned around — a lead is captured OPEN, and
      // lead_lost_reason_scope_chk refuses a reason on any open stage.
      const [row] = await db<LeadRow[]>`
        INSERT INTO crm.lead
          (id, tenant_id, title, party_id, source, owner_user_id, notes, jurisdiction,
           estimated_value, estimated_value_currency)
        VALUES (${l.id}, ${l.tenantId}, ${l.title}, ${l.partyId}, ${l.source},
                ${l.ownerUserId}, ${l.notes}, ${l.jurisdiction},
                ${l.estimatedValue?.amount ?? null}::numeric,
                ${l.estimatedValue?.currency ?? null})
        RETURNING id, tenant_id, title, party_id, source, stage, owner_user_id, notes,
                  lost_reason, jurisdiction, estimated_value, estimated_value_currency,
                  captured_at, closed_at, deleted_at, deleted_by_user_id
      `;
      if (!row) throw new Error("lead insert returned no row");
      return toLead(row);
    });
  }

  async findById(tenantId: string, leadId: string): Promise<Lead | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<LeadRow[]>`
        SELECT id, tenant_id, title, party_id, source, stage, owner_user_id, notes,
               lost_reason, jurisdiction, estimated_value, estimated_value_currency,
                  captured_at, closed_at, deleted_at, deleted_by_user_id
        FROM crm.lead WHERE id = ${leadId}
      `;
      return row ? toLead(row) : null;
    });
  }

  async findOpenForParty(tenantId: string, partyId: string): Promise<Lead | null> {
    return withTenant(this.app, tenantId, async (db) => {
      // At most one row can come back: the partial unique index in 0007 is what
      // makes that true. No ORDER BY, deliberately — a query that picks one of
      // several would hide the day the index stopped holding.
      //
      // The stage list here MUST match that index's WHERE clause exactly
      // (0030 widened both to include 'abandoned', and 0086 made both skip a
      // DELETED lead). If this query were narrower the merge would silently
      // stop firing; if it were wider the insert that follows would hit a
      // unique violation instead of merging — and a capture landing on a lead
      // somebody deleted as a mistake would be the mistake coming back.
      const [row] = await db<LeadRow[]>`
        SELECT id, tenant_id, title, party_id, source, stage, owner_user_id, notes,
               lost_reason, jurisdiction, estimated_value, estimated_value_currency,
                  captured_at, closed_at, deleted_at, deleted_by_user_id
        FROM crm.lead
        WHERE party_id = ${partyId} AND stage NOT IN ('converted', 'lost', 'abandoned')
          AND deleted_at IS NULL
      `;
      return row ? toLead(row) : null;
    });
  }

  // The next three reads share a shape: the lead, the party it is about, and the
  // colleague who owns it. core.party is under RLS and filtered along with the
  // lead; tenancy.user_account is global, and only the owner's name and address
  // are taken from it — never anything about their access. Written out rather
  // than assembled from a fragment, like every other query in this codebase.

  async list(tenantId: string, stage: LeadStage | null): Promise<readonly LeadRecord[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows =
        stage === null
          ? await db<LeadRecordRow[]>`
              SELECT l.id, l.tenant_id, l.title, l.party_id, l.source, l.stage, l.owner_user_id,
                     l.notes, l.lost_reason, l.jurisdiction, l.estimated_value,
                     l.estimated_value_currency, l.captured_at, l.closed_at,
                     l.deleted_at, l.deleted_by_user_id,
                     p.kind AS party_kind, p.display_name AS party_display_name,
                     u.display_name AS owner_display_name, u.email::text AS owner_email
              FROM crm.lead l
              JOIN core.party p ON p.id = l.party_id
              LEFT JOIN tenancy.user_account u ON u.id = l.owner_user_id
              -- A deleted lead was never a prospect (0086), so it is not in the
              -- pipeline at all — not a hidden stage, not a count.
              WHERE l.deleted_at IS NULL
              ORDER BY l.captured_at DESC
              -- A CEILING, not pagination — see MAX_LIST_ROWS. The pipeline
              -- grows for as long as the firm does.
              LIMIT ${MAX_LIST_ROWS}
            `
          : await db<LeadRecordRow[]>`
              SELECT l.id, l.tenant_id, l.title, l.party_id, l.source, l.stage, l.owner_user_id,
                     l.notes, l.lost_reason, l.jurisdiction, l.estimated_value,
                     l.estimated_value_currency, l.captured_at, l.closed_at,
                     l.deleted_at, l.deleted_by_user_id,
                     p.kind AS party_kind, p.display_name AS party_display_name,
                     u.display_name AS owner_display_name, u.email::text AS owner_email
              FROM crm.lead l
              JOIN core.party p ON p.id = l.party_id
              LEFT JOIN tenancy.user_account u ON u.id = l.owner_user_id
              WHERE l.stage = ${stage} AND l.deleted_at IS NULL
              ORDER BY l.captured_at DESC
              LIMIT ${MAX_LIST_ROWS}
            `;
      return rows.map(toRecord);
    });
  }

  async findRecord(tenantId: string, leadId: string): Promise<LeadDetail | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<
        (LeadRecordRow & { deleter_display_name: string | null; deleter_email: string | null })[]
      >`
        SELECT l.id, l.tenant_id, l.title, l.party_id, l.source, l.stage, l.owner_user_id,
               l.notes, l.lost_reason, l.jurisdiction, l.estimated_value,
               l.estimated_value_currency, l.captured_at, l.closed_at,
               l.deleted_at, l.deleted_by_user_id,
               p.kind AS party_kind, p.display_name AS party_display_name,
               u.display_name AS owner_display_name, u.email::text AS owner_email,
               -- Who deleted it (0086), by name for the page. A LEFT join, like
               -- the owner's: an erased account stops resolving, and the page
               -- then names nobody rather than failing.
               d.display_name AS deleter_display_name, d.email::text AS deleter_email
        FROM crm.lead l
        JOIN core.party p ON p.id = l.party_id
        LEFT JOIN tenancy.user_account u ON u.id = l.owner_user_id
        LEFT JOIN tenancy.user_account d ON d.id = l.deleted_by_user_id
        WHERE l.id = ${leadId}
      `;
      if (!row) return null;
      return {
        ...toRecord(row),
        deletedBy:
          row.deleted_by_user_id === null || row.deleter_email === null
            ? null
            : {
                userId: row.deleted_by_user_id,
                displayName: row.deleter_display_name,
                email: row.deleter_email,
              },
      };
    });
  }

  async liveProposalRefs(tenantId: string, leadId: string): Promise<readonly string[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // The same probe `trg_lead_guard_deletion` makes, so the page's answer
      // and the wall's cannot disagree about which proposals stand in the way.
      const rows = await db<{ ref: string }[]>`
        SELECT ref FROM crm.proposal
        WHERE lead_id = ${leadId} AND deleted_at IS NULL
        ORDER BY ref
      `;
      return rows.map((r) => r.ref);
    });
  }

  async markDeleted(
    tenantId: string,
    leadId: string,
    deletedByUserId: string | null,
  ): Promise<Lead | null> {
    return withTenant(this.app, tenantId, async (db) => {
      // `now()`, the party archive's reasoning: the stamp belongs to the
      // transaction that made the change. Only these two columns move — the
      // trigger refuses a deletion that changes anything else.
      const rows = await db<LeadRow[]>`
        UPDATE crm.lead
        SET deleted_at = now(), deleted_by_user_id = ${deletedByUserId}
        WHERE id = ${leadId} AND deleted_at IS NULL
        RETURNING id, tenant_id, title, party_id, source, stage, owner_user_id, notes,
                  lost_reason, jurisdiction, estimated_value, estimated_value_currency,
                  captured_at, closed_at, deleted_at, deleted_by_user_id
      `.catch((err: unknown) => {
        // A proposal drafted from it between the service's check and this
        // statement: the wall caught what the check could not, and names it.
        const refs = draftedFrom(err);
        throw refs === null ? err : new LeadHasProposals(refs);
      });
      const row = rows[0];
      return row ? toLead(row) : null;
    });
  }

  async moveStage(
    tenantId: string,
    leadId: string,
    stage: LeadStage,
    closedAt: string | null,
    lostReason: string | null,
  ): Promise<Lead> {
    return withTenant(this.app, tenantId, async (db) => {
      // Stage, closed_at and lost_reason move in ONE statement. Set separately,
      // there would be a moment where a closed lead has no closing date or a
      // lost one has no reason, and the CHECK constraints would reject whichever
      // half arrived first. lost_reason is written unconditionally rather than
      // only when it is non-null, so a move to a stage that takes no reason
      // CLEARS any that was there. No path reaches that today (a terminal stage
      // is never left), and it is written this way so that if one ever does, a
      // stale reason cannot survive onto a stage the CHECK forbids it on.
      const [row] = await db<LeadRow[]>`
        UPDATE crm.lead
        SET stage = ${stage}, closed_at = ${closedAt}::timestamptz,
            lost_reason = ${lostReason}
        WHERE id = ${leadId}
        RETURNING id, tenant_id, title, party_id, source, stage, owner_user_id, notes,
                  lost_reason, jurisdiction, estimated_value, estimated_value_currency,
                  captured_at, closed_at, deleted_at, deleted_by_user_id
      `;
      if (!row) throw new Error(`lead ${leadId} vanished between the read and the stage move`);
      return toLead(row);
    });
  }

  async setOwner(tenantId: string, leadId: string, ownerUserId: string | null): Promise<Lead> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<LeadRow[]>`
        UPDATE crm.lead SET owner_user_id = ${ownerUserId}
        WHERE id = ${leadId}
        RETURNING id, tenant_id, title, party_id, source, stage, owner_user_id, notes,
                  lost_reason, jurisdiction, estimated_value, estimated_value_currency,
                  captured_at, closed_at, deleted_at, deleted_by_user_id
      `;
      if (!row) throw new Error(`lead ${leadId} vanished between the read and the assignment`);
      return toLead(row);
    });
  }

  async setDetails(
    tenantId: string,
    leadId: string,
    jurisdiction: string | null,
    estimatedValue: LeadValue | null,
  ): Promise<Lead> {
    return withTenant(this.app, tenantId, async (db) => {
      // Amount and currency in ONE statement, as the pair CHECK demands — set
      // apart, the row would pass through "an amount with no currency".
      const [row] = await db<LeadRow[]>`
        UPDATE crm.lead
        SET jurisdiction = ${jurisdiction},
            estimated_value = ${estimatedValue?.amount ?? null}::numeric,
            estimated_value_currency = ${estimatedValue?.currency ?? null}
        WHERE id = ${leadId}
        RETURNING id, tenant_id, title, party_id, source, stage, owner_user_id, notes,
                  lost_reason, jurisdiction, estimated_value, estimated_value_currency,
                  captured_at, closed_at, deleted_at, deleted_by_user_id
      `;
      if (!row) throw new Error(`lead ${leadId} vanished between the read and the edit`);
      return toLead(row);
    });
  }
}

/**
 * The references in `trg_lead_guard_deletion`'s DETAIL, when that is what
 * refused — SQLSTATE 23001 with a DETAIL is only ever its "proposals drafted
 * from it" case. Null for anything else, which the caller re-throws untouched.
 */
function draftedFrom(err: unknown): readonly string[] | null {
  if (typeof err !== "object" || err === null) return null;
  const { code, detail } = err as { code?: unknown; detail?: unknown };
  if (code !== "23001" || typeof detail !== "string" || detail === "") return null;
  return detail.split(", ");
}
