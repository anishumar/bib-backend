// Sentinel errors for the client portal's library (T6.7). They live in the
// domain so the meaning is owned here; `api/domainerr.ts` maps them to HTTP
// status codes. Match with `instanceof`, never a string search.
//
// Every code added here is a COMPILE error until `api/domainerr.ts` maps it —
// that switch ends `default: return unmapped(err.code)` and `unmapped` takes
// `never`. G3.3 shipped answering 500 to every refusal, which is why.
//
// ── ONE CODE, AND THE ABSENCE OF THE OBVIOUS SECOND ONE IS THE POINT ──────
//
// There is no `NOT_YOURS` and there must not be. A document belonging to another
// of the firm's clients, one that does not exist, and one the firm has not
// marked client-visible are all answered by `DocumentNotFound` — because all
// three are the RESTRICTIVE policy filtering the row, so nothing in this
// codebase is in a position to tell them apart. A distinct refusal would confirm
// the document exists, which is the fact being withheld.

export class PortalLibraryError extends Error {
  constructor(
    readonly code: PortalLibraryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type PortalLibraryErrorCode = "INVALID_MONTH";

/** Refused rather than coerced. `2026-13` read as January 2027 answers a
 *  question nobody asked with data that looks entirely right. */
export class InvalidMonth extends PortalLibraryError {
  constructor(value: string) {
    super(
      "INVALID_MONTH",
      `${JSON.stringify(value)} is not a month: it must be YYYY-MM, with a month between 01 and 12`,
    );
  }
}
