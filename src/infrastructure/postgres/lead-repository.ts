// Postgres adapter for the commercial pipeline. Every method runs under
// withTenant, so the RLS tenant wall applies to each statement. timestamptz
// arrives as a Date and leaves as an ISO 8601 string — the door where Postgres
// types become ours.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { Lead, LeadSource, LeadStage } from "../../domain/lead/model";
import type { PartyKind } from "../../domain/party/model";
import type { LeadRecord, LeadRepository, NewLead } from "../../usecase/lead/ports";

interface LeadRow {
  id: string;
  tenant_id: string;
  title: string;
  party_id: string;
  source: LeadSource;
  stage: LeadStage;
  owner_user_id: string | null;
  notes: string | null;
  lost_reason: string | null;
  captured_at: Date;
  closed_at: Date | null;
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

function toLead(r: LeadRow): Lead {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    title: r.title,
    partyId: r.party_id,
    source: r.source,
    stage: r.stage,
    ownerUserId: r.owner_user_id,
    notes: r.notes,
    lostReason: r.lost_reason,
    capturedAt: r.captured_at.toISOString(),
    closedAt: r.closed_at?.toISOString() ?? null,
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
        INSERT INTO crm.lead (id, tenant_id, title, party_id, source, owner_user_id, notes)
        VALUES (${l.id}, ${l.tenantId}, ${l.title}, ${l.partyId}, ${l.source},
                ${l.ownerUserId}, ${l.notes})
        RETURNING id, tenant_id, title, party_id, source, stage, owner_user_id, notes,
                  lost_reason, captured_at, closed_at
      `;
      if (!row) throw new Error("lead insert returned no row");
      return toLead(row);
    });
  }

  async findById(tenantId: string, leadId: string): Promise<Lead | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<LeadRow[]>`
        SELECT id, tenant_id, title, party_id, source, stage, owner_user_id, notes,
               lost_reason, captured_at, closed_at
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
      // (0030 widened both to include 'abandoned'). If this query were narrower
      // the merge would silently stop firing; if it were wider the insert that
      // follows would hit a unique violation instead of merging.
      const [row] = await db<LeadRow[]>`
        SELECT id, tenant_id, title, party_id, source, stage, owner_user_id, notes,
               lost_reason, captured_at, closed_at
        FROM crm.lead
        WHERE party_id = ${partyId} AND stage NOT IN ('converted', 'lost', 'abandoned')
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
                     l.notes, l.lost_reason, l.captured_at, l.closed_at,
                     p.kind AS party_kind, p.display_name AS party_display_name,
                     u.display_name AS owner_display_name, u.email::text AS owner_email
              FROM crm.lead l
              JOIN core.party p ON p.id = l.party_id
              LEFT JOIN tenancy.user_account u ON u.id = l.owner_user_id
              ORDER BY l.captured_at DESC
            `
          : await db<LeadRecordRow[]>`
              SELECT l.id, l.tenant_id, l.title, l.party_id, l.source, l.stage, l.owner_user_id,
                     l.notes, l.lost_reason, l.captured_at, l.closed_at,
                     p.kind AS party_kind, p.display_name AS party_display_name,
                     u.display_name AS owner_display_name, u.email::text AS owner_email
              FROM crm.lead l
              JOIN core.party p ON p.id = l.party_id
              LEFT JOIN tenancy.user_account u ON u.id = l.owner_user_id
              WHERE l.stage = ${stage}
              ORDER BY l.captured_at DESC
            `;
      return rows.map(toRecord);
    });
  }

  async findRecord(tenantId: string, leadId: string): Promise<LeadRecord | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<LeadRecordRow[]>`
        SELECT l.id, l.tenant_id, l.title, l.party_id, l.source, l.stage, l.owner_user_id,
               l.notes, l.lost_reason, l.captured_at, l.closed_at,
               p.kind AS party_kind, p.display_name AS party_display_name,
               u.display_name AS owner_display_name, u.email::text AS owner_email
        FROM crm.lead l
        JOIN core.party p ON p.id = l.party_id
        LEFT JOIN tenancy.user_account u ON u.id = l.owner_user_id
        WHERE l.id = ${leadId}
      `;
      return row ? toRecord(row) : null;
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
                  lost_reason, captured_at, closed_at
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
                  lost_reason, captured_at, closed_at
      `;
      if (!row) throw new Error(`lead ${leadId} vanished between the read and the assignment`);
      return toLead(row);
    });
  }
}
