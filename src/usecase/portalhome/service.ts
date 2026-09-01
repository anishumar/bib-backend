// The client portal's status home (T6.5) — the FIRST read in this product
// written for somebody outside the firm.
//
// ── WHY THIS EXISTS AT ALL ─────────────────────────────────────────────────
//
// Gate 4 shipped in 0059 and its writer in 0060, and until this file there was
// still nothing for a client to look at: `PORTAL_PATHS` held four routes and not
// one of them returned a business record. A client contact could be invited,
// could set a password, could sign in — and landed on a blank page, which is
// indistinguishable from broken software.
//
// ── THE THREE THINGS THAT MAKE IT GATE-4 SAFE, ALL ELSEWHERE ───────────────
//
// Deliberately none of them is in this file, and that is the design:
//
//   1. `PORTAL_PATHS` (api/guards.ts) admits the route. Gate 2 refuses
//      everything else, so a portal read that is never listed is unreachable
//      rather than open.
//   2. `withPortal` (db/tenant.ts) sets `app.portal` and the granted parties,
//      once, in the adapter — never `withTenant`.
//   3. The RESTRICTIVE policies (0059, 0062) do the filtering, so the SQL below
//      the port reads like a query that forgot to filter and still cannot leak.
//      That is checked by negative control: drop a policy and the integration
//      tests go red.
//
// What this file does is resolve WHOSE session it is, once, and split the rows
// into the questions a client actually asks.
//
// ── AN EMPTY SCOPE IS NOT A SHORTCUT ───────────────────────────────────────
//
// A contact who has been invited and granted nothing gets `companies: []` and
// four empty lists, and the read still goes all the way to the database with an
// empty scope. There is no `if (companies.length === 0) return empty` here, and
// there must never be: it would be indistinguishable from the version that
// works right up until somebody moves the check one layer down, where skipping
// the call leaves the session looking like STAFF.
import type { Clock } from "../../platform/clock";
import type { PortalStatusHome } from "../../domain/portalhome/model";
import { splitByFiled, splitByHeldUp } from "../../domain/portalhome/model";
import type { PortalHomeRepository, PortalScopeSource } from "./ports";

interface Deps {
  readonly scope: PortalScopeSource;
  readonly rows: PortalHomeRepository;
  readonly clock: Clock;
}

export class PortalHomeService {
  constructor(private readonly deps: Deps) {}

  /**
   * Everything the status home shows, for the session identified by `userId`.
   *
   * `asOf` is the CALLER'S calendar day and the server's is only the fallback —
   * G3.2's rule, and this module is the one where getting it wrong is most
   * visible: a grant that starts today is not in force yet on a UTC server at
   * 04:11 in Delhi, so the client would sign in and be told the firm has given
   * them nothing. The browser sends its own day.
   */
  async home(tenantId: string, userId: string, asOf?: string): Promise<PortalStatusHome> {
    const day = asOf ?? this.today();
    // Resolved ONCE per request, here, rather than per query. Two resolutions
    // could disagree across a day boundary and the second one is the wall.
    const companies = await this.deps.scope.scopedCompanies(tenantId, userId, day);
    const rows = await this.deps.rows.read(
      tenantId,
      companies.map((c) => c.clientPartyId),
      day,
    );
    const work = splitByHeldUp(rows.work);
    const filings = splitByFiled(rows.filings);
    return {
      companies,
      inProgress: work.inProgress,
      heldUp: work.heldUp,
      upcomingFilings: filings.upcoming,
      recentlyFiled: filings.filed,
      asOf: day,
    };
  }

  /** The server's calendar day — the honest fallback for a caller that did not
   *  say which day it is on, and never the answer when one did. */
  private today(): string {
    return this.deps.clock.now().toISOString().slice(0, 10);
  }
}
