// Postgres adapter for membership — the first tenant-scoped table, and the one
// that exercises both RLS modes. Writes go through withTenant (the RLS WITH
// CHECK requires app.tenant_id); the cross-tenant org-switch read goes through
// withIdentity (app.user_id). Neither ever bypasses RLS.
import type { Db } from "../../db/pool";
import { withIdentity, withTenant } from "../../db/tenant";
import type { Membership } from "../../domain/tenancy/model";
import type {
  MemberRecord,
  MembershipRepository,
  NewMembership,
} from "../../usecase/tenancy/ports";
import type { StaffDirectory } from "../../usecase/lead/ports";
import type { RoleHolders } from "../../usecase/config/ports";

interface MembershipRow {
  id: string;
  tenant_id: string;
  user_id: string;
  audience: Membership["audience"];
  role: string;
  commercial_visibility: boolean;
  is_active: boolean;
}

/** A membership row joined to the account behind it — the roster read. */
interface MemberRow extends MembershipRow {
  email: string;
  display_name: string | null;
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

// Three ports over one table, the same pattern as the users repository serving
// both tenancy and identity. Tenancy owns memberships; the lead use case asks
// "may this person hold a lead here"; the config registry asks "which roles does
// anybody actually have", which it needs to know before it lets a firm move the
// administrator permission onto a role nobody holds.
export class PostgresMembershipRepository
  implements MembershipRepository, StaffDirectory, RoleHolders
{
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

  /** RoleHolders: the role names live at this firm right now. DISTINCT because
   *  the caller asks a question about roles, not about people. */
  async rolesInUse(tenantId: string): Promise<readonly string[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{ role: string }[]>`
        SELECT DISTINCT role FROM tenancy.membership WHERE is_active ORDER BY role
      `;
      return rows.map((r) => r.role);
    });
  }

  // ── The roster, and administering it ────────────────────────────────────────

  async listMembers(tenantId: string): Promise<readonly MemberRecord[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // Joined to the account, so a roster is one query rather than one per row.
      // user_account is GLOBAL and carries no RLS of its own; the join is safe
      // because the membership side IS filtered — a firm can only reach the
      // accounts of people who are its members.
      const rows = await db<MemberRow[]>`
        SELECT m.id, m.tenant_id, m.user_id, m.audience, m.role,
               m.commercial_visibility, m.is_active,
               u.email::text AS email, u.display_name
        FROM tenancy.membership m
        JOIN tenancy.user_account u ON u.id = m.user_id
        ORDER BY m.is_active DESC, u.display_name NULLS LAST, u.email
      `;
      return rows.map((r) => ({
        membership: toMembership(r),
        email: r.email,
        displayName: r.display_name,
      }));
    });
  }

  async findById(tenantId: string, membershipId: string): Promise<Membership | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<MembershipRow[]>`
        SELECT id, tenant_id, user_id, audience, role, commercial_visibility, is_active
        FROM tenancy.membership WHERE id = ${membershipId}
      `;
      return row ? toMembership(row) : null;
    });
  }

  async updateRole(tenantId: string, membershipId: string, role: string): Promise<Membership> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<MembershipRow[]>`
        UPDATE tenancy.membership SET role = ${role}
        WHERE id = ${membershipId}
        RETURNING id, tenant_id, user_id, audience, role, commercial_visibility, is_active
      `;
      if (!row) throw new Error(`membership ${membershipId} vanished between the read and the write`);
      return toMembership(row);
    });
  }

  async setActive(
    tenantId: string,
    membershipId: string,
    isActive: boolean,
  ): Promise<Membership> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<MembershipRow[]>`
        UPDATE tenancy.membership SET is_active = ${isActive}
        WHERE id = ${membershipId}
        RETURNING id, tenant_id, user_id, audience, role, commercial_visibility, is_active
      `;
      if (!row) throw new Error(`membership ${membershipId} vanished between the read and the write`);
      return toMembership(row);
    });
  }
}
