// The authorization use case — gate 3 (role) and the fifth axis (fee
// visibility), asked and answered in one place.
//
// It takes a Principal rather than a user id because the answer depends on the
// membership the session is ACTING UNDER, not on the person. The same human is
// a partner at one firm and a client contact at another, and the session says
// which hat they are wearing right now.
import type { Principal } from "../../platform/callctx";
import type { Permission } from "../../domain/authz/model";
import { grants, redactCommercials, roleServes, seesCommercials } from "../../domain/authz/model";
import { FeesNotVisible, NotPermitted, UnknownRole } from "../../domain/authz/errors";
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
   * **A ROLE WRITTEN FOR THE OTHER AUDIENCE CARRIES NOTHING (T6.6).** This used
   * to be a blanket `[]` for every CLIENT_PORTAL session, and that was exactly
   * right for the reason it stated: gate 2 admits a portal session only to
   * `PORTAL_PATHS`, and none of those routes needed a permission, so the set a
   * portal session could actually USE was empty. It was arithmetic, not policy.
   *
   * `portal:respond` ended that arithmetic — it is the first permission a portal
   * session can use — and the blanket became a lie in the other direction: a
   * portal screen told it may do nothing offers nothing that works, which is the
   * 403-by-surprise this method exists to prevent.
   *
   * So the rule is now the honest one CLAUDE.md always pointed at, and it runs
   * BOTH ways. Nothing refuses `manager` on a CLIENT_PORTAL membership, and
   * nothing stops a firm putting `portal:respond` on `associate`; in both cases
   * the role was written for the other surface and grants nothing here. What
   * makes that expressible is that a role declares its own audience — see
   * `roleServes`.
   */
  async permissionsOf(principal: Principal): Promise<readonly Permission[]> {
    if (principal.tenantId === null || principal.role === null) return [];
    const role = await this.deps.permissions.roleFor(principal.tenantId, principal.role);
    if (role === null) return [];
    if (!roleServes(role.audience, principal.audience)) return [];
    return role.permissions;
  }

  /**
   * The same question without the throw, for a handler deciding what to show
   * rather than whether to serve.
   *
   * It applies the audience rule too, and it must: `permissionsOf` promises a
   * screen that what it offers will work, and if the two disagreed the promise
   * would be broken in whichever direction they differed. This one is the half
   * that actually refuses a request.
   */
  async can(principal: Principal, permission: Permission): Promise<boolean> {
    if (principal.tenantId === null || principal.role === null) return false;
    const role = await this.deps.permissions.roleFor(principal.tenantId, principal.role);
    if (role === null) return false;
    if (!roleServes(role.audience, principal.audience)) return false;
    return grants(role.permissions, permission);
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
   * Throw unless the principal may see fees: for an act that WRITES money or
   * hands out a document that prints it (audit 2026-10-03). `what` is the act
   * in plain words, for the refusal.
   *
   * Throwing, like `require`, so the check cannot be asked and ignored.
   */
  requireFees(principal: Principal, what: string): void {
    if (!this.seesFees(principal)) throw new FeesNotVisible(what);
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
