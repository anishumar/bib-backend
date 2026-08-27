// The seeded permission source: the product's four default roles, from the
// table in the domain.
//
// HONEST REGISTRY, the same pattern as the dev principal resolver and the
// logging mailer: this is the only implementation registered, it says plainly
// what it is, and it is not pretending to be the configurable role system.
// T2.5 replaces it with an adapter that reads rule rows a partner edited, and
// the tenantId parameter is already threaded through for that day.
import { isKnownRole, permissionsForRole } from "../../domain/authz/model";
import type { Permission } from "../../domain/authz/model";
import type { PermissionSource } from "../../usecase/authz/ports";

export class StaticPermissionSource implements PermissionSource {
  /** Ignores the tenant: the seeded matrix is the product's, not a firm's.
   *  Every firm gets the same four roles until T2.5 makes them configurable. */
  permissionsFor(_tenantId: string, role: string): Promise<readonly Permission[]> {
    return Promise.resolve(permissionsForRole(role));
  }

  isKnownRole(_tenantId: string, role: string): Promise<boolean> {
    return Promise.resolve(isKnownRole(role));
  }
}
