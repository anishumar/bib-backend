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
import { KNOWN_ROLES } from "../../domain/authz/model";
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
      if (!(await this.knowsRole(principal))) {
        throw new UnknownRole(role, KNOWN_ROLES);
      }
      throw new NotPermitted(role, permission);
    }
  }

  /** The same question without the throw, for a handler deciding what to show
   *  rather than whether to serve. */
  async can(principal: Principal, permission: Permission): Promise<boolean> {
    if (principal.tenantId === null || principal.role === null) return false;
    const held = await this.deps.permissions.permissionsFor(principal.tenantId, principal.role);
    return grants(held, permission);
  }

  private async knowsRole(principal: Principal): Promise<boolean> {
    if (principal.tenantId === null || principal.role === null) return false;
    return this.deps.permissions.isKnownRole(principal.tenantId, principal.role);
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
