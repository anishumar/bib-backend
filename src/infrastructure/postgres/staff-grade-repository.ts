// Postgres adapter for the seniority ladder (G3.3). Every read and write goes
// through withTenant — a grade is meaningless outside the firm that defined it,
// so there is no identity-mode path here at all, unlike membership.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import type { StaffGrade } from "../../domain/staffgrade/model";
import type {
  NewStaffGrade,
  StaffGradePatch,
  StaffGradeRepository,
} from "../../usecase/staffgrade/ports";
import type { GradeDirectory, MemberGrade } from "../../usecase/tenancy/ports";

interface GradeRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  rank: number;
  is_active: boolean;
}

function toGrade(r: GradeRow): StaffGrade {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    code: r.code,
    name: r.name,
    // `integer` comes back as a JS number from postgres.js, but a rank that
    // arrived as a string would compare as one — and this value decides who may
    // sign off a filing. Coerced once, here at the door.
    rank: Number(r.rank),
    isActive: r.is_active,
  };
}

/**
 * Two ports over one table, the same pattern the membership repository already
 * uses for three.
 *
 * `StaffGradeRepository` is the staff-grade use case's own seam.
 * `GradeDirectory` is TENANCY's — declared in tenancy's vocabulary so that the
 * two use cases never import each other, exactly as `RoleDirectory` lets
 * tenancy ask the config registry what a role is without knowing what a config
 * row looks like.
 */
export class PostgresStaffGradeRepository implements StaffGradeRepository, GradeDirectory {
  constructor(private readonly app: Db) {}

  async list(tenantId: string): Promise<readonly StaffGrade[]> {
    return withTenant(this.app, tenantId, async (db) => {
      // Deactivated rungs included: an admin needs to see what the firm stopped
      // promoting through and be able to bring it back. Presentation order is
      // the domain's job (`ladderOrder`); this is a stable order for the sake of
      // deterministic reads, nothing more.
      const rows = await db<GradeRow[]>`
        SELECT id, tenant_id, code, name, rank, is_active
        FROM tenancy.staff_grade
        ORDER BY rank DESC, name
      `;
      return rows.map(toGrade);
    });
  }

  async findById(tenantId: string, gradeId: string): Promise<StaffGrade | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<GradeRow[]>`
        SELECT id, tenant_id, code, name, rank, is_active
        FROM tenancy.staff_grade WHERE id = ${gradeId}
      `;
      return row ? toGrade(row) : null;
    });
  }

  async findByCode(tenantId: string, code: string): Promise<StaffGrade | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<GradeRow[]>`
        SELECT id, tenant_id, code, name, rank, is_active
        FROM tenancy.staff_grade WHERE code = ${code}
      `;
      return row ? toGrade(row) : null;
    });
  }

  async create(grade: NewStaffGrade): Promise<StaffGrade> {
    return withTenant(this.app, grade.tenantId, async (db) => {
      const [row] = await db<GradeRow[]>`
        INSERT INTO tenancy.staff_grade (id, tenant_id, code, name, rank)
        VALUES (${grade.id}, ${grade.tenantId}, ${grade.code}, ${grade.name}, ${grade.rank})
        RETURNING id, tenant_id, code, name, rank, is_active
      `;
      if (!row) throw new Error("staff_grade insert returned no row");
      return toGrade(row);
    });
  }

  async createMany(grades: readonly NewStaffGrade[]): Promise<readonly StaffGrade[]> {
    if (grades.length === 0) return [];
    // Every row carries the same tenant — the caller is seeding one firm's
    // ladder — so one RLS context covers the whole insert. Asserted rather than
    // assumed: a mixed batch would insert under the wrong tenant's context and
    // the WITH CHECK would reject it, which is a confusing way to learn this.
    const [first] = grades;
    if (!first) throw new Error("createMany called with no grades after a length check");
    const tenantId = first.tenantId;
    if (grades.some((g) => g.tenantId !== tenantId)) {
      throw new Error("createMany received grades for more than one tenant; a batch is one firm's ladder");
    }
    return withTenant(this.app, tenantId, async (db) => {
      // One statement, so a failure leaves no half-built ladder behind.
      const rows = await db<GradeRow[]>`
        INSERT INTO tenancy.staff_grade ${db(
          grades.map((g) => ({
            id: g.id,
            tenant_id: g.tenantId,
            code: g.code,
            name: g.name,
            rank: g.rank,
          })),
        )}
        RETURNING id, tenant_id, code, name, rank, is_active
      `;
      return rows.map(toGrade);
    });
  }

  async update(
    tenantId: string,
    gradeId: string,
    patch: StaffGradePatch,
  ): Promise<StaffGrade> {
    return withTenant(this.app, tenantId, async (db) => {
      // The service has already resolved absent fields to their current values,
      // so both are always present here and the SQL needs no dynamic assembly.
      const [row] = await db<GradeRow[]>`
        UPDATE tenancy.staff_grade
        SET name = ${patch.name ?? null}, rank = ${patch.rank ?? null}
        WHERE id = ${gradeId}
        RETURNING id, tenant_id, code, name, rank, is_active
      `;
      if (!row) throw new Error(`staff_grade ${gradeId} vanished between the read and the write`);
      return toGrade(row);
    });
  }

  async setActive(tenantId: string, gradeId: string, isActive: boolean): Promise<StaffGrade> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<GradeRow[]>`
        UPDATE tenancy.staff_grade SET is_active = ${isActive}
        WHERE id = ${gradeId}
        RETURNING id, tenant_id, code, name, rank, is_active
      `;
      if (!row) throw new Error(`staff_grade ${gradeId} vanished between the read and the write`);
      return toGrade(row);
    });
  }

  // ── GradeDirectory (tenancy's seam) ─────────────────────────────────────────

  /** What tenancy needs to refuse a bad assignment: does this firm have this
   *  rung, and does it still promote through it. Reuses the same RLS-scoped
   *  read, so a grade belonging to another firm resolves to null here. */
  async find(tenantId: string, gradeId: string): Promise<MemberGrade | null> {
    const grade = await this.findById(tenantId, gradeId);
    if (!grade) return null;
    return {
      id: grade.id,
      code: grade.code,
      name: grade.name,
      rank: grade.rank,
      isActive: grade.isActive,
    };
  }
}
