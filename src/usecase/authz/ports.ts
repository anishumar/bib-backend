// The seam that makes T2.5 a swap rather than a rewrite.
//
// Today the answer comes from a table in the domain. When the master
// configuration registry lands, a Postgres adapter implements this same
// interface and reads rule rows a partner edited on a screen — and not one call
// site changes, because no call site ever knew where the answer came from.
import type { Permission } from "../../domain/authz/model";

export interface PermissionSource {
  /**
   * The permissions a role carries in a tenant.
   *
   * Tenant-scoped even though the seeded implementation ignores it: the whole
   * point of T2.5 is that each firm defines its own roles, so the parameter has
   * to be in the interface from the start or every call site changes later.
   */
  permissionsFor(tenantId: string, role: string): Promise<readonly Permission[]>;
  /** Whether the product recognises the role at all — the difference between
   *  "not allowed" and "misconfigured". */
  isKnownRole(tenantId: string, role: string): Promise<boolean>;
}
