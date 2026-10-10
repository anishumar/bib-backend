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

export type FinErrorCode = "FIN_NOT_ENABLED";

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
