// Sentinel errors — the closed vocabulary of ways a grade operation fails. They
// live in the domain so the meaning is owned here; the api layer maps them to
// HTTP status codes (domainerr.ts). Match with `instanceof`, never string search.

export class StaffGradeError extends Error {
  constructor(
    readonly code: StaffGradeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type StaffGradeErrorCode =
  | "INVALID_GRADE_CODE"
  | "INVALID_RANK"
  | "GRADE_CODE_TAKEN"
  | "GRADE_NOT_FOUND"
  | "GRADE_NOT_ASSIGNABLE";

export class InvalidGradeCode extends StaffGradeError {
  constructor(code: string) {
    super(
      "INVALID_GRADE_CODE",
      `grade code ${JSON.stringify(code)} is not a lowercase handle (2-40 chars, letters, ` +
        `digits, "-" or "_") — like "senior_manager". It is the firm's stable name for the ` +
        `rung; the label people read is the name, which has no such restriction.`,
    );
  }
}

export class InvalidRank extends StaffGradeError {
  constructor(rank: number) {
    super(
      "INVALID_RANK",
      `rank ${JSON.stringify(rank)} must be a whole number above zero, where 1 is the most ` +
        `junior rung. Ranks need not be unique or consecutive — two rungs may share one, and ` +
        `gaps are how a firm leaves room to insert a rung later.`,
    );
  }
}

export class GradeCodeTaken extends StaffGradeError {
  constructor(code: string) {
    super("GRADE_CODE_TAKEN", `this firm already has a grade with code ${JSON.stringify(code)}`);
  }
}

export class GradeNotFound extends StaffGradeError {
  constructor(ref: string) {
    super("GRADE_NOT_FOUND", `no grade ${JSON.stringify(ref)} at this firm`);
  }
}

export class GradeNotAssignable extends StaffGradeError {
  constructor(name: string) {
    // Deliberately not silent. A firm that stopped promoting through a rung
    // still has people holding it — those records stay valid and readable — but
    // putting somebody NEW on it is almost always a stale picker or a stale
    // script, and quietly allowing it would spread a rung the firm has retired.
    super(
      "GRADE_NOT_ASSIGNABLE",
      `${JSON.stringify(name)} is a grade this firm no longer promotes through, so it cannot ` +
        `be assigned to anybody new. People who already hold it keep it. Reactivate the grade ` +
        `first if the firm is using it again.`,
    );
  }
}
