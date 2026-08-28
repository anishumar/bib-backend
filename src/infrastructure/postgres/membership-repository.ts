// Postgres adapter for membership — the first tenant-scoped table, and the one
// that exercises both RLS modes. Writes go through withTenant (the RLS WITH
// CHECK requires app.tenant_id); the cross-tenant org-switch read goes through
// withIdentity (app.user_id). Neither ever bypasses RLS.
import type { Db } from "../../db/pool";
import { withIdentity, withTenant } from "../../db/tenant";
import type { Membership } from "../../domain/tenancy/model";
import type { NewMembership, MembershipRepository } from "../../usecase/tenancy/ports";
import type { StaffDirectory } from "../../usecase/lead/ports";

interface MembershipRow {
  id: string;
  tenant_id: string;
  user_id: string;
  audience: Membership["audience"];
  role: string;
  commercial_visibility: boolean;
  is_active: boolean;
}

function toMembership(r: MembershipRow): Membership {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    userId: r.user_id,
    audience: r.audience,
    role: r.role,
    commercialVisibility: r.commercial_visibility,
    isActive: r.is_active,
  };
}

// Two ports over one table, the same pattern as the users repository serving
// both tenancy and identity: tenancy owns memberships, and the lead use case
// asks the much narrower question "may this person hold a lead here".
export class PostgresMembershipRepository implements MembershipRepository, StaffDirectory {
  constructor(private readonly app: Db) {}

  async create(m: NewMembership): Promise<Membership> {
    return withTenant(this.app, m.tenantId, async (db) => {
      const [row] = await db<MembershipRow[]>`
        INSERT INTO tenancy.membership
          (id, tenant_id, user_id, audience, role, commercial_visibility)
        VALUES
          (${m.id}, ${m.tenantId}, ${m.userId}, ${m.audience}, ${m.role}, ${m.commercialVisibility})
        RETURNING id, tenant_id, user_id, audience, role, commercial_visibility, is_active
      `;
      if (!row) throw new Error("membership insert returned no row");
      return toMembership(row);
    });
  }

  /**
   * Whether this user is active STAFF at this firm.
   *
   * Read in TENANT mode, not identity mode: the question is about one firm's
   * roster, and answering it from the user's own cross-tenant view would let a
   * lead be assigned to somebody whose membership is at a different firm.
   *
   * CLIENT_PORTAL is excluded by the predicate, not by the caller remembering
   * to. A client contact of the firm is a real, active membership — and putting
   * a lead on their desk would hand a prospect's file to somebody outside the
   * firm entirely.
   */
  async isActiveStaff(tenantId: string, userId: string): Promise<boolean> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<{ one: number }[]>`
        SELECT 1 AS one FROM tenancy.membership
        WHERE user_id = ${userId} AND audience = 'STAFF' AND is_active
      `;
      return row !== undefined;
    });
  }

  async listByUser(userId: string): Promise<Membership[]> {
    return withIdentity(this.app, userId, async (db) => {
      const rows = await db<MembershipRow[]>`
        SELECT id, tenant_id, user_id, audience, role, commercial_visibility, is_active
        FROM tenancy.membership
        WHERE user_id = ${userId}
        ORDER BY created_at
      `;
      return rows.map(toMembership);
    });
  }
}
