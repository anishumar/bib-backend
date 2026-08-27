// Postgres adapter for membership — the first tenant-scoped table, and the one
// that exercises both RLS modes. Writes go through withTenant (the RLS WITH
// CHECK requires app.tenant_id); the cross-tenant org-switch read goes through
// withIdentity (app.user_id). Neither ever bypasses RLS.
import type { Db } from "../../db/pool";
import { withIdentity, withTenant } from "../../db/tenant";
import type { Membership } from "../../domain/tenancy/model";
import type { NewMembership, MembershipRepository } from "../../usecase/tenancy/ports";

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

export class PostgresMembershipRepository implements MembershipRepository {
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
