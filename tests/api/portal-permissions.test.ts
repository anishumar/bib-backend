// The assumption `AuthzService.permissionsOf` rests on, asserted rather than
// trusted.
//
// A CLIENT_PORTAL session is told it holds NO permissions, whatever role its
// membership carries. That is not a policy decision taken in the use case — it
// is the arithmetic of the two gates:
//
//   gate 2 (audience) runs FIRST and admits a portal session only to PORTAL_PATHS
//   every path in PORTAL_PATHS requires no permission
//   -> therefore no permission is reachable by a portal session
//
// The second line is the fragile one. It is true today and there is nothing
// stopping U1 from adding a portal route that needs `party:read` — at which
// point the blanket empty becomes a lie in the other direction: a portal screen
// would be told it may do nothing, and would offer nothing that works.
//
// So the moment somebody adds a permission-gated portal route, this test goes
// red and names the decision that has to be revisited. A comment could not do
// that. The honest fix at U1 is a role that declares its audience, so a portal
// membership can carry portal permissions and nothing else.
import { describe, expect, it } from "vitest";
import { PORTAL_PATHS } from "../../src/api/guards";
import { NO_PERMISSION_REQUIRED, decideRoute } from "../../src/api/permissions";
import { AuthzService } from "../../src/usecase/authz/service";
import { withDefaultRoles } from "../../src/testfakes/config";

const TENANT = "00000000-0000-4000-8000-000000000007";

describe("a portal session can reach nothing that needs a permission", () => {
  it("every PORTAL_PATH is open — declared as needing no permission", () => {
    // Read from the same table the middleware reads, not a copy of it.
    for (const path of PORTAL_PATHS) {
      expect(
        NO_PERMISSION_REQUIRED.has(`GET ${path}`) ||
          NO_PERMISSION_REQUIRED.has(`POST ${path}`),
        `${path} is reachable by a CLIENT_PORTAL session but is not in ` +
          `NO_PERMISSION_REQUIRED. If it now needs a permission, AuthzService.permissionsOf ` +
          `must stop returning [] for portal sessions — see its note, and U1's audience-aware ` +
          `roles.`,
      ).toBe(true);
    }
  });

  it("and none of them resolves to a permission requirement", () => {
    for (const path of PORTAL_PATHS) {
      for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        const decision = decideRoute(method, path);
        expect(
          decision.kind === "permission",
          `${method} ${path} requires ${decision.kind === "permission" ? decision.permission : ""} ` +
            `but is reachable by a portal session`,
        ).toBe(false);
      }
    }
  });
});

describe("what /auth/me tells a portal session", () => {
  const authz = new AuthzService({ permissions: withDefaultRoles(TENANT) });

  const principal = (audience: "STAFF" | "CLIENT_PORTAL", role: string) => ({
    userId: "00000000-0000-4000-8000-0000000000a1",
    sessionId: "00000000-0000-4000-8000-0000000000a2",
    tenantId: TENANT,
    audience,
    role,
    commercialVisibility: false,
  });

  it("reports nothing, even when the membership holds a staff role", async () => {
    // The case that prompted this: nothing refuses `manager` on a CLIENT_PORTAL
    // membership. It leaks nothing — gate 2 answers 403 to every staff route —
    // but reporting four unreachable permissions is the 403-by-surprise this
    // field exists to prevent.
    expect(await authz.permissionsOf(principal("CLIENT_PORTAL", "manager"))).toEqual([]);
    expect(await authz.permissionsOf(principal("CLIENT_PORTAL", "partner"))).toEqual([]);
  });

  it("still reports the real set for a staff session", async () => {
    // The other half: this must not have quietly disabled gate 3's own answer.
    const held = await authz.permissionsOf(principal("STAFF", "manager"));
    expect(held).toContain("party:read");
    expect(held).toContain("ledger:read");
  });

  it("leaves `can()` alone — it is asked about a route, which gate 2 already refused", async () => {
    // permissionsOf answers "what should a screen offer"; can() answers "may
    // this specific thing happen". The second is only ever reached for a route
    // gate 2 has already admitted, so it keeps reading the role.
    expect(await authz.can(principal("CLIENT_PORTAL", "manager"), "party:read")).toBe(true);
  });
});
