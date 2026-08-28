// The staff-grade domain — the firm's seniority ladder, and the one comparison
// it exists for. Pure nouns and pure rules; imports nothing internal and nothing
// beyond the standard library (enforced by the arch test).
//
// Seniority is a SEPARATE AXIS from role, and the product had only the first.
// A `member` may be an Article or a Senior Manager: the role decides what they
// may REACH, the grade decides how SENIOR they are. Nothing could tell those
// apart, so the firm's own review rule — "Manager or above is fine" — had
// nothing to compare against.
//
// That rule is the entire brief and it is deliberately small: ONE integer
// comparison. No skill matrix, no tier-and-load routing. The firm stated a
// single threshold; inventing more structure than that is the mistake T2.1
// avoided when it refused to guess a territory axis.

/** A rung of a firm's own hierarchy. */
export interface StaffGrade {
  readonly id: string;
  readonly tenantId: string;
  /** The firm's stable handle for the rung — scoped to the firm, so two firms
   *  may both have a `manager` meaning different things. */
  readonly code: string;
  readonly name: string;
  /** 1 = most junior. Not required to be unique or contiguous; see `outranks`. */
  readonly rank: number;
  /** Whether the firm still promotes through this rung. NEVER a delete — see
   *  the note on `isActive` below. */
  readonly isActive: boolean;
}

/**
 * The ten rungs a firm STARTS with — seed data, not the runtime answer.
 *
 * This is 10x Global's own hierarchy, as the firm gave it on 22 Aug 2026,
 * carried across from the pre-rebuild demo. It is not a product default
 * somebody invented: the firm's HR sheet designations map onto exactly these
 * ten, which is what makes it the confirmed list rather than a plausible one.
 *
 * Same contract as DEFAULT_ROLES: written into a new tenant's rows at creation,
 * and consulted by nothing afterwards. The firm owns its ladder from that
 * moment — it may rename a rung, insert one, or stop promoting through one, all
 * without a deploy.
 *
 * migrations/0040 backfills the same ten for the firms that existed before it,
 * and tests/staffgrade/seed-parity.test.ts fails if the two ever drift. Adding
 * a rung here therefore costs a migration to reach existing firms, exactly as
 * adding a permission to a default role does.
 *
 * **Six real designations are deliberately absent**: Article, Intern, Trainee,
 * Head, Public Relations Officer and CEO are all in use at the firm and none of
 * them is placed by the hierarchy the firm sent. They arrive when the firm
 * ranks them — as rows, through the admin screen. Guessing a rank for them
 * would be worse than the null they get instead, because this is the value that
 * decides who may sign off a statutory filing and a plausible wrong rank is
 * indistinguishable from a real one.
 */
export interface GradeDefinition {
  readonly code: string;
  readonly name: string;
  readonly rank: number;
}

export const DEFAULT_GRADES: readonly GradeDefinition[] = [
  { code: "analyst", name: "Analyst", rank: 1 },
  { code: "senior_analyst", name: "Senior Analyst", rank: 2 },
  { code: "associate", name: "Associate", rank: 3 },
  { code: "senior_associate", name: "Senior Associate", rank: 4 },
  { code: "assistant_manager", name: "Assistant Manager", rank: 5 },
  { code: "deputy_manager", name: "Deputy Manager", rank: 6 },
  { code: "manager", name: "Manager", rank: 7 },
  { code: "senior_manager", name: "Senior Manager", rank: 8 },
  { code: "director", name: "Director", rank: 9 },
  { code: "partner", name: "Partner", rank: 10 },
];

// ── Pure rules ────────────────────────────────────────────────────────────

/** A grade code is a lowercase handle, 2–40 chars — the same shape as a tenant
 *  slug, for the same reason: it goes in URLs, configs and comparisons. */
export function isValidGradeCode(code: string): boolean {
  return /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])$/.test(code);
}

/** Codes are compared case-insensitively; normalise before storage and lookup,
 *  so `Manager` and `manager` cannot become two rungs. */
export function normalizeGradeCode(code: string): string {
  return code.trim().toLowerCase();
}

/**
 * Ranks are positive integers. Not unique and not contiguous, on purpose:
 * nothing ever compares WITHIN a rung, only across a threshold, so requiring
 * uniqueness would turn "insert Article below Analyst" into a renumbering of
 * every row to buy an ordering guarantee nobody reads.
 */
export function isValidRank(rank: number): boolean {
  return Number.isInteger(rank) && rank > 0;
}

/**
 * THE comparison the whole table exists for — "Manager or above is fine".
 *
 * Takes ranks rather than grades so the caller cannot accidentally compare a
 * grade from one firm against a threshold from another; the rows they came from
 * are already tenant-scoped by RLS.
 *
 * `>=`, not `>`: "Manager or above" includes the Manager.
 */
export function outranks(rank: number, threshold: number): boolean {
  return rank >= threshold;
}

/**
 * The ladder in the order a person reads it — most senior first.
 *
 * Rank descending, then name, so a ladder where two rungs share a rank still
 * has ONE stable order rather than whatever the database returned. A picker
 * that reorders itself between two loads looks broken even when it is not.
 */
export function ladderOrder(grades: readonly StaffGrade[]): readonly StaffGrade[] {
  return [...grades].sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));
}

/** The rungs a firm still promotes through — what a picker offers. Deactivated
 *  rungs stay readable everywhere they are already held; they are just not
 *  offered for new assignments. */
export function assignableGrades(grades: readonly StaffGrade[]): readonly StaffGrade[] {
  return grades.filter((g) => g.isActive);
}
