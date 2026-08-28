// The tenant wall, defended at boot. Two assertions that must hold before the
// process serves a single request; either failing crashes the pod with an
// actionable message. A pod that will not start is a five-minute incident. A
// pod that starts and silently leaks one tenant's data into another is the
// kind that ends a company.
//
// This is the third of three defenses (RLS policy · this boot check · the
// dependency-cruiser rule that the pool is reachable only via the resolver).
//
// The same reasoning applies to the audit ledger, so it gets the same treatment
// below: a process that could rewrite history is worse than one that will not
// start.
import type { Db } from "./pool";

export async function assertTenantWall(app: Db): Promise<void> {
  const [role] = await app<{ bypass: boolean; who: string }[]>`
    SELECT rolbypassrls AS bypass, current_user AS who
    FROM pg_roles WHERE rolname = current_user
  `;
  if (!role) {
    throw new Error("tenant wall check: could not read current role from pg_roles");
  }
  if (role.bypass) {
    throw new Error(
      `tenant wall check: the app role '${role.who}' has BYPASSRLS. It MUST be NOBYPASSRLS ` +
        `or RLS is decorative and every tenant can read every other. Run: ALTER ROLE ${role.who} NOBYPASSRLS;`,
    );
  }

  const [table] = await app<{ enabled: boolean }[]>`
    SELECT relrowsecurity AS enabled
    FROM pg_class WHERE oid = 'tenancy.membership'::regclass
  `;
  if (!table) {
    throw new Error("tenant wall check: tenancy.membership is missing — run migrations first");
  }
  if (!table.enabled) {
    throw new Error(
      "tenant wall check: row-level security is NOT enabled on tenancy.membership. " +
        "The isolation policy cannot fire. Re-apply migration 0001.",
    );
  }
}

/**
 * The audit ledger, defended at boot. `ledger.event` is append-only, and that
 * property is worthless if it holds only until someone runs a GRANT. So the
 * process asserts, every start, that the role it is about to serve with cannot
 * change or remove an event.
 *
 * A tampered-with audit trail is not a bug that shows up in a dashboard — it
 * shows up years later, in a regulator's question that can no longer be
 * answered. Refusing to boot is the cheap version of that conversation.
 */
export async function assertLedgerAppendOnly(app: Db): Promise<void> {
  const [table] = await app<{ enabled: boolean }[]>`
    SELECT relrowsecurity AS enabled
    FROM pg_class WHERE oid = 'ledger.event'::regclass
  `;
  if (!table) {
    throw new Error("ledger check: ledger.event is missing — run migrations first");
  }
  if (!table.enabled) {
    throw new Error(
      "ledger check: row-level security is NOT enabled on ledger.event. One tenant's audit " +
        "trail would be readable by another. Re-apply migration 0003.",
    );
  }

  const [grants] = await app<
    { can_select: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean; who: string }[]
  >`
    SELECT has_table_privilege('ledger.event', 'SELECT') AS can_select,
           has_table_privilege('ledger.event', 'INSERT') AS can_insert,
           has_table_privilege('ledger.event', 'UPDATE') AS can_update,
           has_table_privilege('ledger.event', 'DELETE') AS can_delete,
           current_user AS who
  `;
  if (!grants) {
    throw new Error("ledger check: could not read privileges on ledger.event");
  }
  if (grants.can_update || grants.can_delete) {
    const verbs = [grants.can_update ? "UPDATE" : null, grants.can_delete ? "DELETE" : null]
      .filter((v): v is string => v !== null)
      .join(" and ");
    throw new Error(
      `ledger check: the app role '${grants.who}' holds ${verbs} on ledger.event. The audit ` +
        `trail must be append-only — a correction is a new event, never an edit. Run: ` +
        `REVOKE UPDATE, DELETE ON ledger.event FROM ${grants.who};`,
    );
  }
  if (!grants.can_select || !grants.can_insert) {
    const missing = [grants.can_select ? null : "SELECT", grants.can_insert ? null : "INSERT"]
      .filter((v): v is string => v !== null)
      .join(" and ");
    throw new Error(
      `ledger check: the app role '${grants.who}' is missing ${missing} on ledger.event, so ` +
        `events cannot be recorded. Run: GRANT SELECT, INSERT ON ledger.event TO ${grants.who};`,
    );
  }
}
