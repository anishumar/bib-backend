// The staff-grade use case — the firm's own seniority ladder, and the rules for
// changing it. No I/O, no SQL, no HTTP: everything outside arrives as an
// injected port, so this reads as a description of what the business does and is
// testable with in-memory fakes and zero infrastructure.
import type { IdGen } from "../../platform/ids";
import type { Actor } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import type { StaffGrade } from "../../domain/staffgrade/model";
import {
  DEFAULT_GRADES,
  isValidGradeCode,
  isValidRank,
  ladderOrder,
  normalizeGradeCode,
} from "../../domain/staffgrade/model";
import {
  GradeCodeTaken,
  GradeNotFound,
  InvalidGradeCode,
  InvalidRank,
} from "../../domain/staffgrade/errors";
import type { NewStaffGrade, StaffGradeRepository } from "./ports";

export interface Deps {
  readonly grades: StaffGradeRepository;
  readonly ids: IdGen;
  readonly events: EventSink;
}

export interface CreateGradeInput {
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly rank: number;
}

export interface UpdateGradeInput {
  readonly tenantId: string;
  readonly gradeId: string;
  /** Absent means unchanged, for each independently. */
  readonly name?: string | undefined;
  readonly rank?: number | undefined;
}

export interface SetGradeActiveInput {
  readonly tenantId: string;
  readonly gradeId: string;
  readonly isActive: boolean;
}

export class StaffGradeService {
  constructor(private readonly deps: Deps) {}

  /** The ladder, most senior first, deactivated rungs included. */
  async listGrades(tenantId: string): Promise<readonly StaffGrade[]> {
    return ladderOrder(await this.deps.grades.list(tenantId));
  }

  /** One rung, or a refusal that names it. Callers that need to VALIDATE an
   *  assignment use this; it is also what the roster join reads. */
  async getGrade(tenantId: string, gradeId: string): Promise<StaffGrade> {
    const grade = await this.deps.grades.findById(tenantId, gradeId);
    if (!grade) throw new GradeNotFound(gradeId);
    return grade;
  }

  /**
   * Add a rung the firm's starting ladder did not have.
   *
   * This is the method that closes the gap the seed deliberately leaves: the
   * firm has six real designations — Article, Intern, Trainee, Head, Public
   * Relations Officer, CEO — that its own hierarchy never ranked. They arrive
   * here, ranked by the firm, rather than being guessed by us.
   */
  async createGrade(input: CreateGradeInput, actor: Actor): Promise<StaffGrade> {
    const code = normalizeGradeCode(input.code);
    if (!isValidGradeCode(code)) throw new InvalidGradeCode(input.code);
    if (!isValidRank(input.rank)) throw new InvalidRank(input.rank);

    // Checked rather than left to the unique constraint, which would surface as
    // an unexplained 500 on a screen where the fix is obvious.
    const existing = await this.deps.grades.findByCode(input.tenantId, code);
    if (existing) throw new GradeCodeTaken(code);

    const grade = await this.deps.grades.create({
      id: this.deps.ids.newId(),
      tenantId: input.tenantId,
      code,
      name: input.name,
      rank: input.rank,
    });
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "staff_grade.created",
      objectId: grade.id,
      actor,
      payload: { code: grade.code, rank: grade.rank },
    });
    return grade;
  }

  /**
   * Rename a rung, re-rank it, or both.
   *
   * Re-ranking is the half that matters and is why this is not a rename-only
   * endpoint: inserting "Article" below "Analyst" means moving the ranks above
   * it, and a firm that cannot do that from the screen would have to ask an
   * engineer to run SQL against its own hierarchy.
   *
   * Idempotent: a patch that changes nothing records nothing, because nothing
   * happened to record.
   */
  async updateGrade(input: UpdateGradeInput, actor: Actor): Promise<StaffGrade> {
    const grade = await this.getGrade(input.tenantId, input.gradeId);
    if (input.rank !== undefined && !isValidRank(input.rank)) throw new InvalidRank(input.rank);

    const name = input.name ?? grade.name;
    const rank = input.rank ?? grade.rank;
    if (name === grade.name && rank === grade.rank) return grade;

    const updated = await this.deps.grades.update(input.tenantId, grade.id, { name, rank });
    // The payload carries BOTH sides of each change that happened. "The rank
    // moved" is not the useful fact a year later; "it moved from 7 to 8, which
    // is why this person could suddenly approve" is.
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "staff_grade.updated",
      objectId: grade.id,
      actor,
      payload: {
        code: grade.code,
        ...(name === grade.name ? {} : { nameFrom: grade.name, nameTo: name }),
        ...(rank === grade.rank ? {} : { rankFrom: grade.rank, rankTo: rank }),
      },
    });
    return updated;
  }

  /**
   * Stop promoting through a rung, or start again.
   *
   * Never a delete, and the distinction is load-bearing: `deleted_at` would say
   * the row was a MISTAKE, while this says the firm has MOVED ON. People who
   * hold the rung keep it and every record naming it still resolves — it simply
   * stops being offered for new assignments.
   */
  async setGradeActive(input: SetGradeActiveInput, actor: Actor): Promise<StaffGrade> {
    const grade = await this.getGrade(input.tenantId, input.gradeId);
    if (grade.isActive === input.isActive) return grade;

    const updated = await this.deps.grades.setActive(input.tenantId, grade.id, input.isActive);
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "staff_grade.updated",
      objectId: grade.id,
      actor,
      payload: { code: grade.code, isActive: input.isActive },
    });
    return updated;
  }

  /**
   * Give a brand-new firm its own ladder — the `GradeLadderSeeder` port that
   * tenancy calls from createTenant.
   *
   * Idempotent, and that is not defensive coding: `createTenant` and this share
   * no unit of work, so a retry after a partial failure must not produce a
   * second Manager. Grades that already exist are left exactly as they are,
   * because by then they may be the firm's own edits.
   *
   * Returns the codes actually written, for the caller's audit trail. Writes ONE
   * event, not ten — a firm receiving its starting ladder is one fact.
   */
  async seedDefaultGrades(tenantId: string, actor: Actor): Promise<readonly string[]> {
    const existing = await this.deps.grades.list(tenantId);
    const held = new Set(existing.map((g) => g.code));
    const missing: NewStaffGrade[] = DEFAULT_GRADES.filter((g) => !held.has(g.code)).map((g) => ({
      id: this.deps.ids.newId(),
      tenantId,
      code: g.code,
      name: g.name,
      rank: g.rank,
    }));
    if (missing.length === 0) return [];

    const written = await this.deps.grades.createMany(missing);
    await this.deps.events.recordEvent({
      tenantId,
      verb: "grade_ladder.seeded",
      objectId: tenantId,
      actor,
      payload: { grades: written.length },
    });
    return written.map((g) => g.code);
  }
}
