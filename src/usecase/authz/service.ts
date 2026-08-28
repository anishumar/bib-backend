// The authorization use case — gate 3 (role) and the fifth axis (fee
// visibility), asked and answered in one place.
//
// It takes a Principal rather than a user id because the answer depends on the
// membership the session is ACTING UNDER, not on the person. The same human is
// a partner at one firm and a client contact at another, and the session says
// which hat they are wearing right now.
import type { Principal } from "../../platform/callctx";
import type { Permission } from "../../domain/authz/model";
import { grants, redactCommercials, seesCommercials } from "../../domain/authz/model";
import { NotPermitted, UnknownRole } from "../../domain/authz/errors";
import type { PermissionSource } from "./ports";

export interface Deps {
  readonly permissions: PermissionSource;
}

export class AuthzService {
  constructor(private readonly deps: Deps) {}

  /**
   * Throw unless the principal may do this.
   *
   * Throwing rather than returning a boolean is the point: an authorization
   * check whose result can be ignored will eventually be ignored, and the bug
   * that follows is silent. `mapError` turns both failures into 403.
   */
  async require(principal: Principal, permission: Permission): Promise<void> {
    if (!(await this.can(principal, permission))) {
      // A principal with no tenant has no role either; the scope check upstream
      // has already answered that case with its own 403, so anything reaching
      // here has a role.
      const role = principal.role ?? "(none)";
      // The firm's OWN roles, not the product's defaults — since T2.5 those are
      // config rows a partner can rename, and telling someone their role is not
      // one of four names the firm has never used helps nobody.
      const known = await this.knownRoles(principal);
      if (!known.includes(role)) {
        throw new UnknownRole(role, known);
      }
      throw new NotPermitted(role, permission);
    }
  }

  /**
   * Everything this principal may do.
   *
   * For telling a CALLER what it can do, so a screen can offer only what will
   * work rather than discovering the answer from a 403. It reports what the
   * caller HOLDS and never the vocabulary it does not — the full permission set
   * is its own route, behind `config:read`.
   *
   * Empty for a session that has not chosen an org: without a tenant there is no
   * membership, so there is no role and nothing is carried.
   *
   * **Empty for a CLIENT_PORTAL session too, whatever role it holds.** Nothing
   * about that is a policy decision made here — it is the arithmetic of the two
   * gates. Gate 2 runs BEFORE gate 3 and admits a portal session only to
   * `PORTAL_PATHS`; every one of those routes requires no permission at all. So
   * the set of permissions a portal session can actually USE is empty, and
   * saying otherwise breaks this method's own contract: a screen is supposed to
   * be able to offer only what will work.
   *
   * It matters because nothing stops a firm assigning a staff role to a portal
   * membership — `manager` on a `CLIENT_PORTAL` login is accepted today. That
   * leaks nothing (gate 2 refuses every staff route), but it used to make
   * `/auth/me` report four permissions of which none was reachable, which is
   * exactly the 403-by-surprise this field exists to prevent.
   *
   * **U1 must revisit this.** When the client portal ships, `PORTAL_PATHS` grows
   * and some of those routes will want a permission — at which point this
   * blanket empty becomes wrong. It cannot be forgotten: the honest fix is a
   * role that declares which audience it is for, and
   * `tests/api/portal-permissions.test.ts` holds the build red the moment a
   * portal route starts requiring one.
   */
  async permissionsOf(principal: Principal): Promise<readonly Permission[]> {
    if (principal.tenantId === null || principal.role === null) return [];
    if (principal.audience === "CLIENT_PORTAL") return [];
    return this.deps.permissions.permissionsFor(principal.tenantId, principal.role);
  }

  /** The same question without the throw, for a handler deciding what to show
   *  rather than whether to serve. */
  async can(principal: Principal, permission: Permission): Promise<boolean> {
    if (principal.tenantId === null || principal.role === null) return false;
    const held = await this.deps.permissions.permissionsFor(principal.tenantId, principal.role);
    return grants(held, permission);
  }

  private async knownRoles(principal: Principal): Promise<readonly string[]> {
    if (principal.tenantId === null) return [];
    return this.deps.permissions.knownRoles(principal.tenantId);
  }

  /**
   * The fifth axis. Not a permission and not derived from the role — it reads a
   * flag on the membership, so a firm can hand fee visibility to one associate
   * without promoting them, and withhold it from a manager who does not need it.
   */
  seesFees(principal: Principal): boolean {
    return seesCommercials(principal.commercialVisibility ?? false);
  }

  /**
   * A record with its money removed for a caller who may not see it.
   *
   * Redaction rather than refusal: the delivery associate still needs the work
   * item — client, deadline, status — and simply must not learn the fee. The
   * fields are named by the caller because guessing them from key names would
   * eventually miss one, and a fee that has leaked cannot be un-leaked.
   */
  withFeeVisibility<T extends Record<string, unknown>>(
    principal: Principal,
    record: T,
    commercialFields: readonly (keyof T & string)[],
  ): Record<string, unknown> {
    return redactCommercials(record, commercialFields, this.seesFees(principal));
  }
}
