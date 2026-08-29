// Turning an authenticated principal into a tenant-scoped one.
//
// The session guard has already established WHO is calling. This answers the
// second question every business route asks: which firm are they acting for?
// Those are genuinely different failures and both need saying:
//
//   401  you are not signed in                       (the guard's answer)
//   403  you are, but you have not chosen a firm     (this file's answer)
//
// The 403 is a real, ordinary state — a partner who belongs to two firms holds
// a valid session with no active tenant until they pick one. It is not an
// error condition, which is why it gets its own message pointing at the fix.
import type { Actor } from "../domain/ledger/model";
import type { Principal } from "../platform/callctx";
import { toEnvelope } from "./httpresp";
import type { ErrorEnvelope } from "./httpresp";

export type Scope =
  | {
      readonly ok: true;
      readonly tenantId: string;
      readonly actor: Actor;
      /**
       * The signed-in person, as a plain id.
       *
       * Redundant with `actor.id` and stated separately on purpose: `Actor.id`
       * is nullable because system and agent actors have no account, while a
       * scope resolved from a SESSION is always a human with one. A route that
       * has to store who did something — T2.7's step completion is the first —
       * would otherwise carry a null check for a case this function cannot
       * produce.
       */
      readonly userId: string;
    }
  | { readonly ok: false; readonly deny: ErrorEnvelope; readonly status: 401 | 403 };

/**
 * Both halves a business route needs: the tenant to scope the data, and the
 * actor to name in the audit trail.
 *
 * The tenant comes from the SESSION and never from the request. A route that
 * accepted both could be handed two different firms — which was exactly the bug
 * shape in the old /internal/v1/tenants/{tenantId}/… paths.
 */
export function scopeOf(principal: Principal | null): Scope {
  if (!principal) {
    return {
      ok: false,
      status: 401,
      deny: toEnvelope({ status: 401, code: "UNAUTHORIZED", message: "no authenticated session" }),
    };
  }
  if (principal.tenantId === null) {
    return {
      ok: false,
      status: 403,
      deny: toEnvelope({
        status: 403,
        code: "FORBIDDEN",
        message:
          "this session has not selected an org. Call POST /api/v1/auth/switch-tenant first.",
      }),
    };
  }
  return {
    ok: true,
    tenantId: principal.tenantId,
    actor: { type: "human", id: principal.userId },
    userId: principal.userId,
  };
}
