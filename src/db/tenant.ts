// The tenant resolver — the ONLY sanctioned way to reach tenant-scoped data.
//
// Both helpers open a transaction and set the scoping key with SET LOCAL
// semantics (set_config(..., is_local => true)), so it is bound to the
// transaction and cannot leak to the next request on a pooled connection —
// the single most important rule for RLS under a pool.
//
//   withTenant  — business queries for one firm (app.tenant_id)
//   withIdentity — the login / org-switch read of a user's memberships ACROSS
//                  tenants (app.user_id). Still under RLS; never a bypass.
//   withPortal  — a CLIENT PORTAL request: the firm, AND the companies that one
//                 login was granted. Gate 4 (migration 0059). Narrower than
//                 withTenant, never wider.
import type { Db } from "./pool";

export async function withTenant<T>(
  app: Db,
  tenantId: string,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  return runScoped(app, [["app.tenant_id", tenantId]], fn);
}

export async function withIdentity<T>(
  app: Db,
  userId: string,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  return runScoped(app, [["app.user_id", userId]], fn);
}

/**
 * A client-portal request — the firm, and the ONE thing narrower than the firm.
 *
 * Gate 4. `app.portal = 'on'` is what arms the restrictive policies written in
 * 0059; `app.portal_parties` is the comma-separated list of client parties this
 * login was granted, resolved once per request from `crm.portal_access`.
 *
 * THE EMPTY LIST IS A REAL ANSWER AND MUST REACH THE DATABASE AS ONE. A portal
 * login with no grants sets `app.portal = 'on'` and an empty list, and then
 * `crm.portal_sees()` denies every row. Skipping the call because the list is
 * empty would leave `app.portal` unset, which means STAFF — the one mistake in
 * this file that would be silent, because the reads would all succeed.
 *
 * There is deliberately no `withPortal` variant that takes no parties: the
 * caller must have asked the grant table, and "I did not ask" is not a scope.
 */
export async function withPortal<T>(
  app: Db,
  tenantId: string,
  clientPartyIds: readonly string[],
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  return runScoped(
    app,
    [
      ["app.tenant_id", tenantId],
      ["app.portal", "on"],
      ["app.portal_parties", clientPartyIds.join(",")],
    ],
    fn,
  );
}

async function runScoped<T>(
  app: Db,
  settings: readonly (readonly [key: string, value: string])[],
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const result = await app.begin(async (tx) => {
    // All of them inside the ONE transaction, so a portal request cannot end up
    // holding the firm without the scope that narrows it.
    for (const [key, value] of settings) {
      await tx`SELECT set_config(${key}, ${value}, true)`;
    }
    // A TransactionSql is query-compatible with Sql (Db); it only lacks the
    // pool-lifecycle methods (END/CLOSE), which repositories never call.
    return fn(tx as unknown as Db);
  });
  return result as T;
}
