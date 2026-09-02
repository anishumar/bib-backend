// Sentinel errors — the closed vocabulary of ways a Dept/team operation fails.
// They live in the domain so the meaning is owned here; the api layer maps them
// to HTTP status codes (domainerr.ts). Match with `instanceof`, never a string
// search.
//
// G3.3 shipped `StaffGradeError` with no entry in domainerr.ts and every refusal
// answered 500 instead of 400/404/409. Unit tests were perfectly happy — they
// assert on the thrown sentinel. Only a real HTTP request sees a status code, so
// the mapping goes in with the family, and `tests/api/domain-error-coverage`
// holds the build red if a code here has no case there.

export class ServiceAxisError extends Error {
  constructor(
    readonly code: ServiceAxisErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type ServiceAxisErrorCode =
  | "INVALID_AXIS_KIND"
  | "INVALID_TIME_ZONE"
  | "INVALID_AXIS_CODE"
  | "INVALID_AXIS_NAME"
  | "AXIS_CODE_TAKEN"
  | "AXIS_NOT_FOUND"
  | "AXIS_NOT_ASSIGNABLE"
  | "INVALID_WORK_SPLIT_AXIS"
  | "WORK_SPLIT_AXIS_EMPTY";

export class InvalidAxisKind extends ServiceAxisError {
  constructor(kind: string, valid: readonly string[]) {
    super(
      "INVALID_AXIS_KIND",
      `${JSON.stringify(kind)} is not one of the firm's two lists. Valid: ` +
        `${valid.map((k) => JSON.stringify(k)).join(", ")} — "dept" is the revenue axis ` +
        `(FRC, TRC, RAA) and "team" is who delivers the work (FINCOMPLIANCE, PAYROLL).`,
    );
  }
}

export class InvalidAxisCode extends ServiceAxisError {
  constructor(code: string) {
    super(
      "INVALID_AXIS_CODE",
      `code ${JSON.stringify(code)} is not in canonical form. Upper case letters and digits, ` +
        `separated by single spaces, hyphens or underscores, at most 48 characters — "FRC", ` +
        `"VCFO CONSOLE". The form is demanded at the write because this value is what a ` +
        `service body names and what work is grouped by, and "frc" beside "FRC" is one ` +
        `department to a person and two groups to the database.`,
    );
  }
}

export class InvalidAxisName extends ServiceAxisError {
  constructor(name: string) {
    super(
      "INVALID_AXIS_NAME",
      `name ${JSON.stringify(name)} must be a non-empty label of at most 120 characters. ` +
        `Unlike the code it has no form requirement and may be changed freely — it is what ` +
        `people read, while the code is what every service body joins on.`,
    );
  }
}

export class AxisCodeTaken extends ServiceAxisError {
  constructor(axis: string, code: string) {
    super(
      "AXIS_CODE_TAKEN",
      `this firm already has a ${axis === "dept" ? "Dept" : "delivery team"} with code ` +
        `${JSON.stringify(code)}. Codes are unique within a list — the same code on the ` +
        `OTHER list is fine, because the two are independent dimensions and nothing ` +
        `cross-validates them.`,
    );
  }
}

export class AxisNotFound extends ServiceAxisError {
  constructor(ref: string) {
    super("AXIS_NOT_FOUND", `no Dept or delivery team ${JSON.stringify(ref)} at this firm`);
  }
}

export class AxisNotAssignable extends ServiceAxisError {
  constructor(axis: string, code: string) {
    // Deliberately not silent, for the reason `GradeNotAssignable` is not: a
    // firm that retired a Dept still has services filed under it — those records
    // stay valid and readable — but filing something NEW there is almost always
    // a stale picker or a stale import, and quietly allowing it would spread a
    // Dept the firm has stopped using.
    super(
      "AXIS_NOT_ASSIGNABLE",
      `${JSON.stringify(code)} is a ${axis === "dept" ? "Dept" : "delivery team"} this firm ` +
        `no longer uses, so nothing new may be filed under it. Services already naming it ` +
        `keep it and still read. Reactivate it first if the firm is using it again.`,
    );
  }
}

export class UnknownAxisCode extends ServiceAxisError {
  constructor(axis: string, code: string, known: readonly string[]) {
    super(
      "AXIS_NOT_FOUND",
      `${JSON.stringify(code)} is not one of this firm's ` +
        `${axis === "dept" ? "Depts" : "delivery teams"}. ` +
        (known.length === 0
          ? `This firm has not defined any yet — add them on the firm-structure screen first.`
          : `Defined: ${known.map((k) => JSON.stringify(k)).join(", ")}.`) +
        ` The list is checked at the write because work is grouped by this value: a code ` +
        `nobody defined would silently become its own group.`,
    );
  }
}

export class InvalidWorkSplitAxis extends ServiceAxisError {
  constructor(value: string, valid: readonly string[]) {
    super(
      "INVALID_WORK_SPLIT_AXIS",
      `${JSON.stringify(value)} is not a way of splitting work. Valid: ` +
        `${valid.map((v) => JSON.stringify(v)).join(", ")} — "none" keeps one client's work ` +
        `in one job, which is what most firms want and what this product did before the ` +
        `setting existed.`,
    );
  }
}

export class WorkSplitAxisEmpty extends ServiceAxisError {
  constructor(axis: string) {
    // The one refusal here that is about coherence rather than validity.
    // Choosing to split work by a list with nothing on it would put every job in
    // the unfiled bucket and look exactly like `none` — a setting that appears
    // to take effect and does not.
    super(
      "WORK_SPLIT_AXIS_EMPTY",
      `this firm cannot split work by ${axis === "dept" ? "Dept" : "delivery team"} while ` +
        `it has no active ${axis === "dept" ? "Depts" : "delivery teams"} defined. Every job ` +
        `would land in the same unfiled group, which is what "none" already does. Define the ` +
        `list first, then choose it here.`,
    );
  }
}

export class InvalidTimeZone extends ServiceAxisError {
  constructor(value: string) {
    // The FRIENDLY refusal. `tenancy.assert_known_time_zone` (0071) is the real
    // one and asks Postgres's own `pg_timezone_names`, so an import or a psql
    // session meets it too. This one exists so a person setting the value on a
    // screen gets a sentence rather than a database exception, and so the two
    // lists differing by a tzdata release fails in the safe direction: anything
    // this accepts and Postgres does not is still refused at the write.
    super(
      "INVALID_TIME_ZONE",
      `${JSON.stringify(value)} is not a time zone this system knows. Use an IANA name — ` +
        `"Asia/Kolkata", "Europe/London", "America/New_York", or "UTC". This decides which ` +
        `calendar MONTH a document falls into on a client's month view, and which calendar ` +
        `DAY the chaser counts from; it does not change how any date is displayed.`,
    );
  }
}
