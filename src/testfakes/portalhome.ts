// In-memory fakes for the client portal's status home (T6.5).
//
// ── WHAT A FAKE HERE CAN AND CANNOT PROVE ─────────────────────────────────
//
// It can prove that the service resolves the scope once, passes it down, and
// splits the rows into the questions the screen asks. It CANNOT prove anything
// about gate 4, because gate 4 is RLS: the filtering happens under the query, in
// Postgres, and a fake that filtered by party id here would be a second
// implementation of the wall — green, and telling you nothing about the one that
// actually runs.
//
// So `FakePortalHomeRepo` deliberately does NOT filter. It RECORDS the scope it
// was handed, so a test can assert that an empty scope still reached the
// repository — the one mistake in this module that is silent, because skipping
// the call leaves `app.portal` unset and the session looking like STAFF. The
// wall itself is proven in `tests/portal/portal-reads.integration.test.ts` by
// dropping a policy and watching the reads start leaking.
import type { PortalCompany, PortalFilingRow, PortalWorkRow } from "../domain/portalhome/model";
import type {
  PortalHomeRepository,
  PortalHomeRows,
  PortalScopeSource,
} from "../usecase/portalhome/ports";

export class FakePortalScope implements PortalScopeSource {
  /** `${tenantId}:${userId}` → the companies granted. There is no day here on
   *  purpose: the grant module resolves the scope on the firm's own day, and no
   *  caller's day may reach it (F-07-1). */
  readonly granted = new Map<string, readonly PortalCompany[]>();

  scopedCompanies(tenantId: string, userId: string): Promise<readonly PortalCompany[]> {
    return Promise.resolve(this.granted.get(`${tenantId}:${userId}`) ?? []);
  }
}

export class FakePortalHomeRepo implements PortalHomeRepository {
  work: PortalWorkRow[] = [];
  filings: PortalFilingRow[] = [];
  /** Every call, in order — including the one made with an empty scope. */
  readonly calls: { tenantId: string; scope: readonly string[]; asOf: string }[] = [];

  read(
    tenantId: string,
    clientPartyIds: readonly string[],
    asOf: string,
  ): Promise<PortalHomeRows> {
    this.calls.push({ tenantId, scope: [...clientPartyIds], asOf });
    return Promise.resolve({ work: this.work, filings: this.filings });
  }
}
