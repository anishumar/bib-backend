// The ports this use case needs from the world — the seams. Interfaces are owned
// by the use case that needs them (never a shared top-level ports package),
// stated in our vocabulary. Adapters in infrastructure/ implement them.
import type { StaffGrade } from "../../domain/staffgrade/model";

export interface NewStaffGrade {
  readonly id: string;
  readonly tenantId: string;
  /** Normalised and validated by the service; the adapter stores it as given. */
  readonly code: string;
  readonly name: string;
  readonly rank: number;
}

/** What an update may change. Both optional and both independently applied, so
 *  renaming a rung and re-ranking it are one call or two, as the caller likes. */
export interface StaffGradePatch {
  readonly name?: string | undefined;
  readonly rank?: number | undefined;
}

export interface StaffGradeRepository {
  /** The whole ladder, DEACTIVATED rungs included — an admin needs to see what
   *  the firm stopped promoting through, and be able to bring it back. Ordering
   *  is the domain's job (`ladderOrder`), not the query's. */
  list(tenantId: string): Promise<readonly StaffGrade[]>;
  findById(tenantId: string, gradeId: string): Promise<StaffGrade | null>;
  /** By the firm's own handle — how a seeder and an importer look one up. */
  findByCode(tenantId: string, code: string): Promise<StaffGrade | null>;
  create(grade: NewStaffGrade): Promise<StaffGrade>;
  update(tenantId: string, gradeId: string, patch: StaffGradePatch): Promise<StaffGrade>;
  /**
   * Stop promoting through a rung, or start again.
   *
   * Never a delete. A rung somebody held in 2026 is part of why they were
   * allowed to approve something in 2026, so it stays readable forever — the
   * same distinction `is_active` carries on `membership`.
   */
  setActive(tenantId: string, gradeId: string, isActive: boolean): Promise<StaffGrade>;
  /**
   * The whole starting ladder in ONE write.
   *
   * A new firm's ten rungs are one decision, not ten, and inserting them row by
   * row would leave a half-built ladder behind any failure. Returns what was
   * written, for the caller's audit trail.
   */
  createMany(grades: readonly NewStaffGrade[]): Promise<readonly StaffGrade[]>;
}
