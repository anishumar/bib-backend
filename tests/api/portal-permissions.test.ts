// What a CLIENT_PORTAL session is told it may do — and the day the old answer
// stopped being true.
//
// ── THE RULE THIS FILE USED TO ASSERT, AND WHY IT WENT RED ────────────────
//
// `AuthzService.permissionsOf` returned `[]` for every portal session, whatever
// role the membership carried, and that was exactly right for a reason that was
// arithmetic rather than policy:
//
//   gate 2 (audience) runs FIRST and admits a portal session only to PORTAL_PATHS
//   every path in PORTAL_PATHS requires no permission
//   -> therefore no permission is reachable by a portal session
//
// The second line was the fragile one, and this file existed to make its failure
// LOUD rather than silent: the moment somebody added a permission-gated portal
// route, the build would go red and name the decision that had to be revisited.
// T6.6's action centre is that moment — `portal:respond` gates three routes — and
// this file duly went red.
//
// ── THE NEW RULE, WHICH IS THE ONE CLAUDE.md ALWAYS POINTED AT ────────────
//
// A ROLE DECLARES ITS AUDIENCE, and a role written for the other one grants
// nothing. That is stronger than the blanket it replaces, because it runs in
// BOTH directions and the second is the one nobody expects:
//
//   · nothing refuses `manager` on a CLIENT_PORTAL membership, and it must go on
//     granting nothing there;
//   · nothing refuses `portal:respond` on `associate` either, and a colleague
//     holding it would see it on /auth/me and find it works nowhere.
//
// So the tests below check the pair, not the special case. What stays unchanged
// is the promise the whole thing exists for: a screen offers only what will
// actually work.
import { describe, expect, it } from "vitest";
import { PORTAL_PATHS } from "../../src/api/guards";
import { NO_PERMISSION_REQUIRED, ROUTE_PERMISSIONS, decideRoute } from "../../src/api/permissions";
import { AuthzService } from "../../src/usecase/authz/service";
import { DEFAULT_ROLES } from "../../src/domain/authz/model";
import type { Permission } from "../../src/domain/authz/model";
import { withDefaultRoles } from "../../src/testfakes/config";

const TENANT = "00000000-0000-4000-8000-000000000007";

/** Every permission any CLIENT_PORTAL role in the product's defaults holds. A
 *  route on the portal surface may require one of these and nothing else. */
const PORTAL_PERMISSIONS = new Set<Permission>(
  Object.values(DEFAULT_ROLES)
    .filter((r) => r.audience === "CLIENT_PORTAL")
    .flatMap((r) => [...r.permissions]),
);

describe("a portal route requires a permission a portal role can actually hold", () => {
  it("every PORTAL_PATH is either open or gated on a portal permission", () => {
    // Read from the same tables the middleware reads, not a copy of them.
    //
    // THIS IS THE REPLACEMENT FOR "every PORTAL_PATH is open". A portal route
    // gated on `party:read` would be reachable by gate 2 and refused by gate 3
    // for every client contact alive — a route nobody can call, which is the
    // failure this file has always been about, in a new costume.
    const wrong: string[] = [];
    for (const path of PORTAL_PATHS) {
      for (const [key, permission] of ROUTE_PERMISSIONS) {
        if (!key.endsWith(` ${path}`)) continue;
        if (!PORTAL_PERMISSIONS.has(permission)) {
          wrong.push(`${key} requires ${permission}, which no CLIENT_PORTAL role holds`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("declares every portal route one way or the other", () => {
    // Gate 3 is denied by default, so a portal route missing from BOTH tables is
    // refused to every client — reachable by audience and dead in practice.
    for (const path of PORTAL_PATHS) {
      const decided = ["GET", "POST", "PUT", "DELETE"].some(
        (method) => decideRoute(method, path).kind !== "unmapped",
      );
      expect(
        decided || NO_PERMISSION_REQUIRED.has(`GET ${path}`),
        `${path} is reachable by a CLIENT_PORTAL session but neither table says who may use it`,
      ).toBe(true);
    }
  });

  it("keeps reading out of the permission system entirely", () => {
    // Not a style point. Being invited and being GRANTED a company is the
    // authorisation to read that company's status — a row somebody wrote, with a
    // granter, a date and a ledger event (`crm.portal_access`), enforced by gate
    // 4 in the database. A permission on top would be a second answer to a
    // settled question, and every portal login would hold it.
    //
    // It is also what makes `client_viewer` coherent: a contact with NO
    // permissions still sees their company's whole portal and simply cannot
    // answer anything on it.
    expect(NO_PERMISSION_REQUIRED.has("GET /api/v1/portal/home")).toBe(true);
    expect(NO_PERMISSION_REQUIRED.has("GET /api/v1/portal/asks")).toBe(true);
  });
});

describe("a role grants nothing to a session in the other audience", () => {
  const authz = new AuthzService({ permissions: withDefaultRoles(TENANT) });

  const principal = (audience: "STAFF" | "CLIENT_PORTAL", role: string) => ({
    userId: "00000000-0000-4000-8000-0000000000a1",
    sessionId: "00000000-0000-4000-8000-0000000000a2",
    tenantId: TENANT,
    audience,
    role,
    commercialVisibility: false,
  });

  it("reports nothing for a STAFF role held on a portal membership", async () => {
    // The case that prompted the original blanket: nothing refuses `manager` on
    // a CLIENT_PORTAL membership. It leaks nothing — gate 2 answers 403 to every
    // staff route — but reporting five unreachable permissions is the
    // 403-by-surprise this field exists to prevent.
    expect(await authz.permissionsOf(principal("CLIENT_PORTAL", "manager"))).toEqual([]);
    expect(await authz.permissionsOf(principal("CLIENT_PORTAL", "partner"))).toEqual([]);
  });

  it("reports nothing for a PORTAL role held on a staff membership", async () => {
    // The direction the blanket could not express, and the one that made an
    // audience on the role necessary rather than tidy. A colleague put on
    // `client_contact` would otherwise be told they hold `portal:respond`, and
    // every portal handler refuses a staff session outright.
    expect(await authz.permissionsOf(principal("STAFF", "client_contact"))).toEqual([]);
    expect(await authz.can(principal("STAFF", "client_contact"), "portal:respond")).toBe(false);
  });

  it("reports what a portal contact really holds", async () => {
    // And this is the half that used to be a lie in the other direction: before
    // T6.6 this answered `[]`, so the action centre would have offered nothing.
    //
    // TWO permissions since T6.8, and the ORDER is the order `DEFAULT_ROLES`
    // and the 0069 seed both write — a role body is compared byte-for-byte by
    // the upgrade migrations, so the array is not a set.
    expect(await authz.permissionsOf(principal("CLIENT_PORTAL", "client_contact"))).toEqual([
      "portal:respond",
      "portal:request",
    ]);
    expect(await authz.can(principal("CLIENT_PORTAL", "client_contact"), "portal:respond")).toBe(
      true,
    );
    expect(await authz.can(principal("CLIENT_PORTAL", "client_contact"), "portal:request")).toBe(
      true,
    );
  });

  it("gives the read-only contact nothing, and that is not the same as refusing them", async () => {
    // `client_viewer` holds no permission at all and still reaches every portal
    // READ, because reads are authorised by the grant rather than by a
    // permission. "May look, may not act" is the whole role.
    expect(await authz.permissionsOf(principal("CLIENT_PORTAL", "client_viewer"))).toEqual([]);
    expect(await authz.can(principal("CLIENT_PORTAL", "client_viewer"), "portal:respond")).toBe(
      false,
    );
  });

  it("still reports the real set for a staff session", async () => {
    // The other half: this must not have quietly disabled gate 3's own answer.
    const held = await authz.permissionsOf(principal("STAFF", "manager"));
    expect(held).toContain("party:read");
    expect(held).toContain("ledger:read");
  });

  it("makes `can()` agree with `permissionsOf`, which it did NOT used to", async () => {
    // Before T6.6 these two disagreed on purpose and it was documented as
    // deliberate: `permissionsOf` answered "what should a screen offer" and
    // returned nothing for a portal session, while `can()` read the role and
    // said `manager` on a portal login may `party:read`. That was safe only
    // because gate 2 refused the route first — a second gate covering for the
    // first.
    //
    // It is not safe now. `portal:respond` is a permission a portal session can
    // reach, so the two answering differently would mean either a screen
    // offering what 403s or a screen hiding what works. One rule, both methods.
    for (const [audience, role] of [
      ["CLIENT_PORTAL", "manager"],
      ["STAFF", "client_contact"],
      ["CLIENT_PORTAL", "client_contact"],
      ["STAFF", "manager"],
    ] as const) {
      const p = principal(audience, role);
      const held = await authz.permissionsOf(p);
      for (const permission of ["party:read", "portal:respond"] as const) {
        expect(
          await authz.can(p, permission),
          `${audience}/${role} disagrees about ${permission}`,
        ).toBe(held.includes(permission));
      }
    }
  });
});
