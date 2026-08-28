// In-memory port fake for the seniority ladder (G3.3). `implements` both ports
// the Postgres adapter carries, so a compile error here is the same compile
// error production would get.
import type { StaffGrade } from "../domain/staffgrade/model";
import type {
  NewStaffGrade,
  StaffGradePatch,
  StaffGradeRepository,
} from "../usecase/staffgrade/ports";
import type { GradeDirectory, MemberGrade } from "../usecase/tenancy/ports";

/**
 * One store behind two ports, exactly as `PostgresStaffGradeRepository` is one
 * class behind two. That matters for the tenancy tests: they assign a grade
 * through tenancy's `GradeDirectory` seam, and it has to see the rungs the
 * staff-grade service actually wrote rather than a second, agreeing-by-luck
 * copy of them.
 */
export class FakeStaffGradeRepo implements StaffGradeRepository, GradeDirectory {
  readonly rows: StaffGrade[] = [];

  list(tenantId: string): Promise<readonly StaffGrade[]> {
    return Promise.resolve(this.rows.filter((r) => r.tenantId === tenantId));
  }

  findById(tenantId: string, gradeId: string): Promise<StaffGrade | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.id === gradeId) ?? null,
    );
  }

  findByCode(tenantId: string, code: string): Promise<StaffGrade | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.code === code) ?? null,
    );
  }

  create(grade: NewStaffGrade): Promise<StaffGrade> {
    const row: StaffGrade = { ...grade, isActive: true };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  createMany(grades: readonly NewStaffGrade[]): Promise<readonly StaffGrade[]> {
    const rows = grades.map((g): StaffGrade => ({ ...g, isActive: true }));
    this.rows.push(...rows);
    return Promise.resolve(rows);
  }

  update(tenantId: string, gradeId: string, patch: StaffGradePatch): Promise<StaffGrade> {
    return Promise.resolve(
      this.replace(tenantId, gradeId, (g) => ({
        ...g,
        name: patch.name ?? g.name,
        rank: patch.rank ?? g.rank,
      })),
    );
  }

  setActive(tenantId: string, gradeId: string, isActive: boolean): Promise<StaffGrade> {
    return Promise.resolve(this.replace(tenantId, gradeId, (g) => ({ ...g, isActive })));
  }

  // ── GradeDirectory ──────────────────────────────────────────────────────────

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

  private replace(
    tenantId: string,
    gradeId: string,
    change: (g: StaffGrade) => StaffGrade,
  ): StaffGrade {
    const index = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === gradeId);
    const current = this.rows[index];
    if (!current) throw new Error(`fake ladder: no grade ${gradeId}`);
    const next = change(current);
    this.rows[index] = next;
    return next;
  }
}
