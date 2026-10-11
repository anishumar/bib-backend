// When fin's database does not answer: the ONE translation every fin adapter
// shares (docs/FIN_BUILD_PLAN.md F0.6, ground rule 4).
//
// ── WHY HERE, AND WHY ONE FILE ────────────────────────────────────────────
//
// A read that hits fin's statement timeout, or a database that cannot be
// reached, must reach the staff app as 503 `FIN_UNAVAILABLE` and never as the
// 500 an unmapped driver error becomes: the fin screen then shows its
// "unreachable" state and the rest of BiB carries on. Only an adapter knows a
// SQLSTATE (no vendor value crosses into the use case), so the translation
// lives in `infrastructure/fin/`, and it lives in ONE helper because several
// fin adapters are being written at once and each copying its own list of
// codes is how two of them come to disagree about what "unavailable" means.
//
// Use `withFinRead` for a tenant-scoped read a fin ROUTE serves: it opens the
// tenant scope, sets fin's statement timeout for that transaction only, and
// translates. Use `finUnavailableOnFailure` around anything else a route
// reaches (a read above RLS, say). Sweeps in the fin job may use either; their
// per-firm `failure` then names fin's own sentence, with the driver's error
// kept as `cause`.
//
// ── WHAT COUNTS, AND WHAT DELIBERATELY DOES NOT ───────────────────────────
//
// Unavailable: the statement timeout (57014), the server shutting down or not
// yet accepting connections (57P01-57P03), no connection slot left (53300),
// the connection-exception class (08xxx), and the socket-level failures
// postgres.js and Node report by `code` (a refused or reset connection, a
// connect timeout, a connection closed under a query).
//
// NOT unavailable: a constraint violation, a permission error, a malformed
// query, a serialization failure. Those are a bug or a conflict and must keep
// reaching the error mapper as themselves; calling them "try again in a
// minute" would hide a defect behind a status that promises it will pass.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import { FinUnavailable } from "../../domain/fin/errors";

/**
 * How long one fin read may take on the API's pool. Fin's screens read through
 * the same pool as every core request, so a slow fin query is capped here, well
 * below the pool's own limit, rather than allowed to hold a connection core
 * needs.
 */
export const FIN_READ_TIMEOUT_MS = 5_000;

/** SQLSTATEs that mean the database did not answer, rather than refused. */
const UNAVAILABLE_SQLSTATES: ReadonlySet<string> = new Set([
  "57014", // query_canceled: the statement timeout fired
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now (starting up, or in recovery)
  "53300", // too_many_connections
]);

/** Socket and driver codes for a database that could not be reached. Node's
 *  own errno names, and postgres.js's connection errors (which it reports
 *  under `code` too). */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
]);

function codeOf(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * Whether this error means fin's database did not answer. Duck-typed on
 * `.code`, as `api/domainerr.ts` reads a unique violation: which driver is
 * underneath is this file's business, and the SQLSTATE is the standard's.
 *
 * Node reports a refused connection to a host with several addresses as an
 * AggregateError; it counts when any of its errors does.
 */
export function isFinUnavailable(err: unknown): boolean {
  if (err instanceof FinUnavailable) return true;
  const code = codeOf(err);
  if (code !== null) {
    if (UNAVAILABLE_SQLSTATES.has(code)) return true;
    // The whole connection-exception class: 08000, 08001, 08003, 08004, 08006...
    if (/^08[0-9A-Z]{3}$/.test(code)) return true;
    if (UNREACHABLE_CODES.has(code)) return true;
  }
  if (err instanceof AggregateError) return err.errors.some((e) => isFinUnavailable(e));
  return false;
}

/** `err` as fin's own refusal when the database did not answer, and unchanged
 *  otherwise. `what` names the read, for the log. */
export function asFinUnavailable(err: unknown, what: string): unknown {
  if (err instanceof FinUnavailable) return err;
  return isFinUnavailable(err) ? new FinUnavailable(what, err) : err;
}

/** Run `work`; a database that did not answer becomes `FinUnavailable`. */
export async function finUnavailableOnFailure<T>(what: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw asFinUnavailable(err, what);
  }
}

/**
 * A fin read a route serves: the tenant's scope, fin's statement timeout for
 * this transaction only (`set_config(..., true)` is `SET LOCAL`), and the
 * translation above. `timeoutMs` exists for the integration test, which proves
 * the real SQLSTATE without waiting five seconds; callers leave it out.
 */
export function withFinRead<T>(
  app: Db,
  tenantId: string,
  what: string,
  read: (db: Db) => Promise<T>,
  timeoutMs: number = FIN_READ_TIMEOUT_MS,
): Promise<T> {
  return finUnavailableOnFailure(what, () =>
    withTenant(app, tenantId, async (db) => {
      await db`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true)`;
      return read(db);
    }),
  );
}
