// The tenant wall, defended at boot. Two assertions that must hold before the
// process serves a single request; either failing crashes the pod with an
// actionable message. A pod that will not start is a five-minute incident. A
// pod that starts and silently leaks one tenant's data into another is the
// kind that ends a company.
//
// This is the third of three defenses (RLS policy · this boot check · the
// dependency-cruiser rule that the pool is reachable only via the resolver).
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
