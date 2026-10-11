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

export type FinErrorCode = "FIN_NOT_ENABLED" | "FIN_UNAVAILABLE";

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

/**
 * Fin's database did not answer: a read hit fin's statement timeout, or the
 * database could not be reached at all (F0.6). A 503 and never a 500, because
 * nothing is wrong with the request or with this code, and the staff app shows
 * its "unreachable" state for fin while the rest of BiB carries on (ground rule
 * 4: fin can fail without BiB failing).
 *
 * Raised only by fin's adapters (`infrastructure/fin/unavailable.ts`), the one
 * layer that knows a SQLSTATE. `what` names the read that failed, for the log;
 * the cause is kept on the error and never shown.
 */
export class FinUnavailable extends FinError {
  readonly what: string;

  constructor(what: string, cause?: unknown) {
    super(
      "FIN_UNAVAILABLE",
      "FinCompliance did not answer in time. The rest of BiB is working. Try again in a minute.",
    );
    this.what = what;
    if (cause !== undefined) this.cause = cause;
  }
}
