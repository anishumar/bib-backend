// Postgres adapter for the commercial pipeline. Every method runs under
// withTenant, so the RLS tenant wall applies to each statement. timestamptz
// arrives as a Date and leaves as an ISO 8601 string — the door where Postgres
// types become ours.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { Lead, LeadSource, LeadStage } from "../../domain/lead/model";
import type { LeadRepository, NewLead } from "../../usecase/lead/ports";

interface LeadRow {
  id: string;
  tenant_id: string;
  party_id: string;
  source: LeadSource;
  stage: LeadStage;
  owner_user_id: string | null;
  notes: string | null;
  captured_at: Date;
  closed_at: Date | null;
}

function toLead(r: LeadRow): Lead {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    partyId: r.party_id,
    source: r.source,
    stage: r.stage,
    ownerUserId: r.owner_user_id,
    notes: r.notes,
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
      // captured, and neither is the caller's to state.
      const [row] = await db<LeadRow[]>`
        INSERT INTO crm.lead (id, tenant_id, party_id, source, owner_user_id, notes)
        VALUES (${l.id}, ${l.tenantId}, ${l.partyId}, ${l.source}, ${l.ownerUserId}, ${l.notes})
        RETURNING id, tenant_id, party_id, source, stage, owner_user_id, notes,
                  captured_at, closed_at
      `;
      if (!row) throw new Error("lead insert returned no row");
      return toLead(row);
    });
  }

  async findById(tenantId: string, leadId: string): Promise<Lead | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<LeadRow[]>`
        SELECT id, tenant_id, party_id, source, stage, owner_user_id, notes,
               captured_at, closed_at
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
      const [row] = await db<LeadRow[]>`
        SELECT id, tenant_id, party_id, source, stage, owner_user_id, notes,
               captured_at, closed_at
        FROM crm.lead
        WHERE party_id = ${partyId} AND stage NOT IN ('converted', 'lost')
      `;
      return row ? toLead(row) : null;
    });
  }

  async list(tenantId: string, stage: LeadStage | null): Promise<readonly Lead[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows =
        stage === null
          ? await db<LeadRow[]>`
              SELECT id, tenant_id, party_id, source, stage, owner_user_id, notes,
                     captured_at, closed_at
              FROM crm.lead ORDER BY captured_at DESC
            `
          : await db<LeadRow[]>`
              SELECT id, tenant_id, party_id, source, stage, owner_user_id, notes,
                     captured_at, closed_at
              FROM crm.lead WHERE stage = ${stage} ORDER BY captured_at DESC
            `;
      return rows.map(toLead);
    });
  }

  async moveStage(
    tenantId: string,
    leadId: string,
    stage: LeadStage,
    closedAt: string | null,
  ): Promise<Lead> {
    return withTenant(this.app, tenantId, async (db) => {
      // Stage and closed_at move in ONE statement. Set separately, there would
      // be a moment where a closed lead has no closing date, and the CHECK
      // constraint would reject whichever half arrived first.
      const [row] = await db<LeadRow[]>`
        UPDATE crm.lead
        SET stage = ${stage}, closed_at = ${closedAt}::timestamptz
        WHERE id = ${leadId}
        RETURNING id, tenant_id, party_id, source, stage, owner_user_id, notes,
                  captured_at, closed_at
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
        RETURNING id, tenant_id, party_id, source, stage, owner_user_id, notes,
                  captured_at, closed_at
      `;
      if (!row) throw new Error(`lead ${leadId} vanished between the read and the assignment`);
      return toLead(row);
    });
  }
}
