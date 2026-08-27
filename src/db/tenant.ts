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
import type { Db } from "./pool";

export async function withTenant<T>(
  app: Db,
  tenantId: string,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  return runScoped(app, "app.tenant_id", tenantId, fn);
}

export async function withIdentity<T>(
  app: Db,
  userId: string,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  return runScoped(app, "app.user_id", userId, fn);
}

async function runScoped<T>(
  app: Db,
  key: "app.tenant_id" | "app.user_id",
  value: string,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const result = await app.begin(async (tx) => {
    await tx`SELECT set_config(${key}, ${value}, true)`;
    // A TransactionSql is query-compatible with Sql (Db); it only lacks the
    // pool-lifecycle methods (END/CLOSE), which repositories never call.
    return fn(tx as unknown as Db);
  });
  return result as T;
}
