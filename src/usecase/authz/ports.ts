// The seam that made T2.5 a swap rather than a rewrite.
//
// It has now been swapped. The answer used to come from a table in the domain;
// it comes from the tenant's own `role` config rows, read by a Postgres adapter
// that implements this same interface. No route, no guard and no handler
// changed — none of them ever knew where the answer came from.
import type { Permission, RoleAudience } from "../../domain/authz/model";

/**
 * A role as the firm has published it — what it may do, and which surface it was
 * written for.
 *
 * `roleFor` and not a second `audienceFor` beside `permissionsFor`, because gate
 * 3 runs on EVERY request and the two answers come off the same row. Two methods
 * would be two round trips per request to read one config body, and a cache is
 * the thing this port's own comment refuses ("a revoked permission stays live
 * for its TTL, and a firm that takes an access away expects it gone this
 * afternoon").
 */
export interface StoredRole {
  readonly audience: RoleAudience;
  readonly permissions: readonly Permission[];
}

export interface PermissionSource {
  /**
   * The permissions a role carries in a tenant, or none if the tenant does not
   * define that role.
   *
   * Tenant-scoped from the first version of this interface, when the seeded
   * implementation ignored the parameter — which is why the swap touched
   * nothing above it.
   */
  permissionsFor(tenantId: string, role: string): Promise<readonly Permission[]>;

  /**
   * The same row, with the role's AUDIENCE as well (T6.6).
   *
   * Null when the firm does not define that role — the same "no row" answer
   * `permissionsFor` turns into an empty list, kept distinguishable here because
   * a role that does not exist and a role that grants nothing are different
   * facts, and `AuthzService` says different things about them.
   *
   * `permissionsFor` stays because two other use cases depend on it structurally
   * — `usecase/orchestrator` and `ReviewPermissionSource` in `usecase/workitem`,
   * neither of which has an audience to compare against: they ask "does this
   * ROLE carry work:write" about a colleague named on a job step, not about a
   * session.
   */
  roleFor(tenantId: string, role: string): Promise<StoredRole | null>;

  /**
   * Every role this firm defines.
   *
   * Not a boolean `isKnownRole`, because the caller that needs this is building
   * the error for a membership naming a role the firm does not have — and the
   * only useful thing to say to a firm locked out by a typo is which roles it
   * actually has. An empty result means the firm has no role configuration at
   * all, which is a provisioning fault rather than a policy answer, and the
   * error says so differently.
   */
  knownRoles(tenantId: string): Promise<readonly string[]>;
}
