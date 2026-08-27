// The closed, cross-service error-code set and the map from a domain error to
// an HTTP tuple. The MEANING of a failure lives in the domain (sentinel
// errors); the STATUS CODE lives here, where HTTP knowledge belongs. A gRPC
// edge would write the same map with different right-hand sides, and neither
// the domain nor the use case would know either edge exists.
//
// No service adds to this set — finer distinctions go in `reason`.
import { TenancyError } from "../domain/tenancy/errors";
import { PartyError } from "../domain/party/errors";
import { LedgerError } from "../domain/ledger/errors";

/** The closed set, as a runtime value so the OpenAPI error schema and the
 *  ErrorCode type derive from ONE source and cannot drift apart. */
export const ERROR_CODES = [
  "VALIDATION",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "NOT_IMPLEMENTED",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** The HTTP statuses this system emits — a closed set, so it is assignable to
 *  the transport's status type without a cast. */
export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500 | 501;

export interface MappedError {
  readonly status: HttpStatus;
  readonly code: ErrorCode;
  readonly message: string;
  readonly reason?: string;
}

export function mapError(err: unknown): MappedError {
  if (err instanceof TenancyError) {
    switch (err.code) {
      case "INVALID_SLUG":
      case "INVALID_AUDIENCE":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
      case "SLUG_TAKEN":
      case "EMAIL_TAKEN":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      case "TENANT_NOT_FOUND":
      case "USER_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
    }
  }
  if (err instanceof PartyError) {
    switch (err.code) {
      case "PARTY_NOT_FOUND":
        return { status: 404, code: "NOT_FOUND", message: err.message, reason: err.code };
      case "DUPLICATE_IDENTIFIER":
        return { status: 409, code: "CONFLICT", message: err.message, reason: err.code };
      case "NOT_AN_ORGANIZATION":
      case "INVALID_IDENTIFIER":
      case "INVALID_IDENTIFIER_TYPE":
      case "INVALID_RELATIONSHIP_TYPE":
      case "INVALID_DATE_RANGE":
      case "SELF_RELATIONSHIP":
        return { status: 400, code: "VALIDATION", message: err.message, reason: err.code };
    }
  }
  // A refused event is OUR bug, never the caller's: services build events from
  // their own vocabulary, so an unknown verb or a personal-data payload means
  // this codebase got it wrong. Reporting it as a 400 would blame the client
  // for a defect they cannot fix. It maps to INTERNAL — which the router logs
  // with the full error — and `reason` carries which rule was broken.
  if (err instanceof LedgerError) {
    return { status: 500, code: "INTERNAL", message: "internal error", reason: err.code };
  }
  return { status: 500, code: "INTERNAL", message: "internal error" };
}
