// Sentinel errors for FinCompliance. They live in the domain so the meaning is
// owned here; `api/domainerr.ts` maps them to HTTP status codes. Match with
// `instanceof`, never a string search.
//
// Every code added here is a COMPILE error until `api/domainerr.ts` maps it.

export class FinError extends Error {
  constructor(
    readonly code: FinErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type FinErrorCode = "FIN_NOT_ENABLED" | "FIN_READ_NOT_FOUND" | "FIN_FORMAT_NOT_FOUND" | "FIN_FORMAT_INVALID";

/** Fin is switched off for this firm. A 404, as the plan says: to a firm
 *  without it, fin's routes are not there — and a 403 would read as "you lack
 *  a permission", which no role change can fix. */
export class FinNotEnabled extends FinError {
  constructor() {
    super(
      "FIN_NOT_ENABLED",
      "FinCompliance is not switched on for this firm. It is enabled per firm by the platform " +
        "(tenancy.tenant.fin_enabled_since); nothing under /api/v1/fin answers until it is.",
    );
  }
}

/** No read with this id at this firm. One answer for "not there" and "not
 *  yours": the tenant wall already decided which, and a 404 says neither. */
export class FinReadNotFound extends FinError {
  constructor(readId: string) {
    super("FIN_READ_NOT_FOUND", `There is no read ${readId} at this firm.`);
  }
}

/** No sheet layout with this id at this firm. */
export class FinFormatNotFound extends FinError {
  constructor(formatId: string) {
    super("FIN_FORMAT_NOT_FOUND", `There is no sheet layout ${formatId} at this firm.`);
  }
}

/** A column map the sheet reader could not read a file with. The message is
 *  the reason, in words (`layoutProblem`). */
export class FinFormatInvalid extends FinError {
  constructor(problem: string) {
    super("FIN_FORMAT_INVALID", problem);
  }
}
