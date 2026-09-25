// The seams the client portal's status home needs. Interfaces owned by this use
// case, stated in its vocabulary; the Postgres adapter implements them.
import type { PortalCompany, PortalFilingRow, PortalWorkRow } from "../../domain/portalhome/model";

/**
 * Which companies this SESSION may read, today.
 *
 * A port and not a direct call on `PortalAccessService`, even though that is what
 * satisfies it in `setup/`: the grant table is the firm's write surface and this
 * is the portal's read surface, and a use case that imported the other would put
 * "who may be granted access" and "what does a client see" in one blast radius.
 * The composition root joins them, which is what it is for.
 *
 * NAMES, not ids alone. The home has to be able to say "you are looking at
 * Cobalt Foods", and a session that resolved four ids would then look each one
 * up — the per-row join this codebase has been caught by six times.
 */
export interface PortalScopeSource {
  /** Resolved on the FIRM's day by the grant module itself — no caller's day
   *  reaches it (F-07-1). */
  scopedCompanies(tenantId: string, userId: string): Promise<readonly PortalCompany[]>;
}

/** What one read of the status home returns from the database. */
export interface PortalHomeRows {
  readonly work: readonly PortalWorkRow[];
  readonly filings: readonly PortalFilingRow[];
}

/**
 * The status home's own read.
 *
 * ONE METHOD, because it is ONE transaction. Gate 4 is set with `SET LOCAL`
 * semantics inside `withPortal`, so two calls would be two transactions and two
 * scope resolutions — and the failure that invites is a second read added later
 * that forgets one of them.
 *
 * IT TAKES THE PARTY IDS AND HAS NO VARIANT THAT DOES NOT. `withPortal` has the
 * same shape for the same reason: an EMPTY list is a real answer that must reach
 * the database as one, and "I did not ask the grant table" is not a scope. An
 * implementation that skipped the call because the list was empty would leave
 * `app.portal` unset, which means STAFF, and every read would succeed.
 */
export interface PortalHomeRepository {
  read(
    tenantId: string,
    clientPartyIds: readonly string[],
    asOf: string,
  ): Promise<PortalHomeRows>;
}
