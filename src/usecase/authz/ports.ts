// The seam that made T2.5 a swap rather than a rewrite.
//
// It has now been swapped. The answer used to come from a table in the domain;
// it comes from the tenant's own `role` config rows, read by a Postgres adapter
// that implements this same interface. No route, no guard and no handler
// changed — none of them ever knew where the answer came from.
import type { Permission } from "../../domain/authz/model";

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
