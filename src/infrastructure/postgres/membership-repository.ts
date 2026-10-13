// Postgres adapter for membership — the first tenant-scoped table, and the one
// that exercises both RLS modes. Writes go through withTenant (the RLS WITH
// CHECK requires app.tenant_id); the cross-tenant org-switch read goes through
// withIdentity (app.user_id). Neither ever bypasses RLS.
import type { Db } from "../../db/pool";
import { withIdentity, withTenant } from "../../db/tenant";
import type { Membership } from "../../domain/tenancy/model";
import type {
  MemberGrade,
  MemberRecord,
  MembershipRepository,
  NewMembership,
} from "../../usecase/tenancy/ports";
import type { StaffDirectory } from "../../usecase/lead/ports";
import type { RoleHolders } from "../../usecase/config/ports";
import type { CheckerDirectory, StaffMember } from "../../usecase/verification/ports";

interface MembershipRow {
  id: string;
  tenant_id: string;
  user_id: string;
  audience: Membership["audience"];
  role: string;
  commercial_visibility: boolean;
  grade_id: string | null;
  reports_to_user_id: string | null;
  is_active: boolean;
}

/** A membership row joined to the account behind it AND to the rung it sits on
 *  — the roster read. Both joins exist so a screen never fetches per row. */
interface MemberRow extends MembershipRow {
  email: string;
  display_name: string | null;
  grade_code: string | null;
  grade_name: string | null;
  grade_rank: number | null;
  grade_is_active: boolean | null;
}

function toMembership(r: MembershipRow): Membership {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    userId: r.user_id,
    audience: r.audience,
    role: r.role,
    commercialVisibility: r.commercial_visibility,
    gradeId: r.grade_id,
    reportsToUserId: r.reports_to_user_id,
    isActive: r.is_active,
  };
}

/**
 * The rung on a roster row, or null when the person is not on one.
 *
 * Every grade column arrives together or not at all — they come from one LEFT
 * JOIN — so testing the id is enough to know the rest are present. Written as
 * one guard rather than four so a future column cannot be forgotten here.
 */
function toMemberGrade(r: MemberRow): MemberGrade | null {
  if (r.grade_id === null || r.grade_code === null) return null;
  return {
    id: r.grade_id,
    code: r.grade_code,
    name: r.grade_name ?? r.grade_code,
    rank: r.grade_rank ?? 0,
    isActive: r.grade_is_active ?? false,
  };
}

// Three ports over one table, the same pattern as the users repository serving
// both tenancy and identity. Tenancy owns memberships; the lead use case asks
// "may this person hold a lead here"; the config registry asks "which roles does
// anybody actually have", which it needs to know before it lets a firm move the
// administrator permission onto a role nobody holds.
export class PostgresMembershipRepository
  implements MembershipRepository, StaffDirectory, RoleHolders, CheckerDirectory
{
  constructor(private readonly app: Db) {}

  async create(m: NewMembership): Promise<Membership> {
    return withTenant(this.app, m.tenantId, async (db) => {
      const [row] = await db<MembershipRow[]>`
        INSERT INTO tenancy.membership
          (id, tenant_id, user_id, audience, role, commercial_visibility)
        VALUES
          (${m.id}, ${m.tenantId}, ${m.userId}, ${m.audience}, ${m.role}, ${m.commercialVisibility})
        RETURNING id, tenant_id, user_id, audience, role, commercial_visibility, grade_id,
                  reports_to_user_id, is_active
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
        SELECT id, tenant_id, user_id, audience, role, commercial_visibility, grade_id,
                  reports_to_user_id, is_active
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
      //
      // The grade is a LEFT join and stays one: an ungraded membership is an
      // ordinary state (a portal contact, or a designation the firm's hierarchy
      // has never ranked), so an inner join would silently drop those people
      // from the roster — the exact screen an admin opens to give them a rung.
      // staff_grade IS tenant-scoped, and both sides are filtered by the same
      // RLS context, so the join cannot reach another firm's ladder.
      const rows = await db<MemberRow[]>`
        SELECT m.id, m.tenant_id, m.user_id, m.audience, m.role,
               m.commercial_visibility, m.grade_id, m.reports_to_user_id, m.is_active,
               u.email::text AS email, u.display_name,
               g.code AS grade_code, g.name AS grade_name,
               g.rank AS grade_rank, g.is_active AS grade_is_active
        FROM tenancy.membership m
        JOIN tenancy.user_account u ON u.id = m.user_id
        LEFT JOIN tenancy.staff_grade g ON g.id = m.grade_id
        ORDER BY m.is_active DESC, u.display_name NULLS LAST, u.email
      `;
      return rows.map((r) => ({
        membership: toMembership(r),
        email: r.email,
        displayName: r.display_name,
        grade: toMemberGrade(r),
      }));
    });
  }

  async findById(tenantId: string, membershipId: string): Promise<Membership | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<MembershipRow[]>`
        SELECT id, tenant_id, user_id, audience, role, commercial_visibility, grade_id,
                  reports_to_user_id, is_active
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
        RETURNING id, tenant_id, user_id, audience, role, commercial_visibility, grade_id,
                  reports_to_user_id, is_active
      `;
      if (!row) throw new Error(`membership ${membershipId} vanished between the read and the write`);
      return toMembership(row);
    });
  }

  async setCommercialVisibility(
    tenantId: string,
    membershipId: string,
    commercialVisibility: boolean,
  ): Promise<Membership> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<MembershipRow[]>`
        UPDATE tenancy.membership SET commercial_visibility = ${commercialVisibility}
        WHERE id = ${membershipId}
        RETURNING id, tenant_id, user_id, audience, role, commercial_visibility, grade_id,
                  reports_to_user_id, is_active
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
        RETURNING id, tenant_id, user_id, audience, role, commercial_visibility, grade_id,
                  reports_to_user_id, is_active
      `;
      if (!row) throw new Error(`membership ${membershipId} vanished between the read and the write`);
      return toMembership(row);
    });
  }

  /**
   * Put somebody on a rung, or take them off it.
   *
   * The composite foreign key (migration 0040) is what makes this safe against
   * the failure RLS does not catch: a foreign-key check runs as a system
   * operation the row policies do not filter, so an id-only reference would let
   * this firm's membership point at another firm's grade. `(grade_id,
   * tenant_id)` refuses it at the database, underneath the service's own check.
   */
  async updateGrade(
    tenantId: string,
    membershipId: string,
    gradeId: string | null,
  ): Promise<Membership> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<MembershipRow[]>`
        UPDATE tenancy.membership SET grade_id = ${gradeId}
        WHERE id = ${membershipId}
        RETURNING id, tenant_id, user_id, audience, role, commercial_visibility, grade_id,
                  reports_to_user_id, is_active
      `;
      if (!row) throw new Error(`membership ${membershipId} vanished between the read and the write`);
      return toMembership(row);
    });
  }

  /**
   * Set who somebody reports to, or clear it.
   *
   * NO composite key here, and that is the one place in this repository where
   * an id-only reference is right: the target is `tenancy.user_account`, a
   * GLOBAL table (ADR-02) with no `tenant_id` to carry. The composite rule
   * guards references between two TENANT-SCOPED tables. That the manager is a
   * colleague rather than a stranger is checked by the service, against this
   * firm's own roster, because a foreign key cannot express it.
   */
  async updateReportsTo(
    tenantId: string,
    membershipId: string,
    reportsToUserId: string | null,
  ): Promise<Membership> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<MembershipRow[]>`
        UPDATE tenancy.membership SET reports_to_user_id = ${reportsToUserId}
        WHERE id = ${membershipId}
        RETURNING id, tenant_id, user_id, audience, role, commercial_visibility, grade_id,
                  reports_to_user_id, is_active
      `;
      if (!row) {
        throw new Error(`membership ${membershipId} vanished between the read and the write`);
      }
      return toMembership(row);
    });
  }

  /**
   * The firm's own staff, with the two facts a verification rule compares
   * (T2.9).
   *
   * ACTIVE STAFF ONLY, and both halves matter: a deactivated membership cannot
   * check anything (their session would not resolve either), and a
   * CLIENT_PORTAL membership is a client — offering one as a possible reviewer
   * of the firm's work would be a category error the screen would then have to
   * explain.
   *
   * The grade is a LEFT join and stays one, for `listMembers`' reason: an
   * ungraded person is an ordinary state, and dropping them here would hide the
   * exact answer somebody needs — "Priya cannot approve this because nobody has
   * put her on the ladder" is fixable; her silent absence from a list is not.
   */
  async activeStaff(tenantId: string): Promise<readonly StaffMember[]> {
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<
        {
          user_id: string;
          membership_id: string;
          display_name: string | null;
          email: string;
          role: string;
          grade_rank: number | null;
          grade_name: string | null;
          reports_to_user_id: string | null;
          is_active: boolean;
        }[]
      >`
        SELECT m.user_id, m.id AS membership_id, u.display_name, u.email::text AS email,
               m.role, g.rank AS grade_rank, g.name AS grade_name,
               m.reports_to_user_id, m.is_active
        FROM tenancy.membership m
        JOIN tenancy.user_account u ON u.id = m.user_id
        LEFT JOIN tenancy.staff_grade g ON g.id = m.grade_id
        WHERE m.audience = 'STAFF' AND m.is_active
        ORDER BY u.display_name NULLS LAST, u.email
      `;
      return rows.map((r) => ({
        userId: r.user_id,
        membershipId: r.membership_id,
        // The name, falling back to the address. A reviewer picker showing a
        // uuid is the mistake this codebase has now made and fixed five times.
        displayName: r.display_name ?? r.email,
        role: r.role,
        gradeRank: r.grade_rank,
        gradeName: r.grade_name,
        reportsToUserId: r.reports_to_user_id,
        isActive: r.is_active,
      }));
    });
  }

  async reportingLines(tenantId: string): Promise<ReadonlyMap<string, string>> {
    return withTenant(this.app, tenantId, async (db) => {
      // STAFF only. A portal contact has no manager and never will, and letting
      // one into this map would put a client inside the firm's reporting line.
      const rows = await db<{ user_id: string; reports_to_user_id: string }[]>`
        SELECT user_id, reports_to_user_id
        FROM tenancy.membership
        WHERE reports_to_user_id IS NOT NULL
          AND audience = 'STAFF'
          AND is_active
      `;
      return new Map(rows.map((r) => [r.user_id, r.reports_to_user_id]));
    });
  }
}
