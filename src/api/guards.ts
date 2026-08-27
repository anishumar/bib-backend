// Authentication as MIDDLEWARE, mounted on path prefixes — not as a check each
// handler remembers to make.
//
// That distinction is the whole point of this file. The per-handler version of
// this shipped three holes: an unauthenticated set-any-user's-password route, a
// ledger surface that read any firm's audit trail from a path parameter, and a
// party surface that had the check only because it was written last. Every one
// of them was a file that forgot. A prefix guard cannot be forgotten by a file
// that does not exist yet, which is the property we actually need.
//
// Two surfaces, two guards:
//
//   /internal/*  — the platform's own provisioning API (create a tenant, grant a
//                  membership, set a password). No end user behind it, so it
//                  authenticates with a shared secret from config.
//   /api/v1/*    — the product. Requires a session, except the handful of routes
//                  that exist to GET one, which are listed below by exact path.
//
// And one more gate on that second surface: WHICH AUDIENCE the session belongs
// to. This is a B2B2C product — a firm's staff and a firm's clients both log in
// here — so an authenticated session says nothing about whether the caller is
// allowed to see a firm's book. Audience is denied by default and allowed by
// exact path, for the same reason authentication is: the alternative is a check
// each new route remembers to make.
import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { Principal } from "../platform/callctx";
import type { PrincipalResolver } from "./principal";
import { toEnvelope } from "./httpresp";

/** What the guards put into the request context for handlers to read. Typed
 *  nullable on purpose: a handler must still ask, and on a public route the
 *  honest answer is "nobody". */
export interface AppEnv {
  Variables: {
    principal: Principal | null;
  };
}

/**
 * The routes under /api/v1 that may be reached without a session.
 *
 * An exact-match allowlist, never a prefix: `/api/v1/auth/` as a prefix would
 * have silently exempted every future auth route, including ones that act on an
 * existing session. Three routes exist to OBTAIN a session; that is the entire
 * justification, and anything else added here needs its own.
 */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/api/v1/auth/login",
  "/api/v1/auth/magic-link",
  "/api/v1/auth/magic-link/redeem",
]);

/**
 * The routes a CLIENT_PORTAL session may reach. Everything else on /api/v1 is
 * the STAFF workspace.
 *
 * Today that is only the routes a client needs to manage their own session,
 * because no client-facing feature exists yet (U1 is Phase 6). The list is
 * short for the right reason: a portal user should reach exactly what has been
 * built FOR them, and nothing has been.
 *
 * Denied by default, and that default is load-bearing. With the reverse — allow
 * unless denied — a client contact could list the firm's entire book of
 * clients, create parties in it, and read its audit trail, simply by signing in
 * through the front door. That was true of this codebase until this list
 * existed; it was not an attack, it was the normal login path.
 *
 * When U1 lands (T6.5–T6.7), its routes are added here AND get record-scope
 * (gate 4): a portal user sees only the parties they represent, which needs the
 * user-to-party link that does not exist yet. Audience is the coarse gate;
 * record-scope is the fine one, and a portal route needs both.
 */
export const PORTAL_PATHS: ReadonlySet<string> = new Set([
  "/api/v1/auth/me",
  "/api/v1/auth/switch-tenant",
  "/api/v1/auth/logout",
]);

/**
 * The /internal guard: a bearer secret from config, compared in constant time.
 *
 * The comparison is timing-safe because the alternative leaks the key one byte
 * at a time to anyone willing to measure, and this key is the provisioning API.
 */
export function internalGuard(apiKey: string): MiddlewareHandler<AppEnv> {
  const expected = Buffer.from(apiKey);
  return async (c, next) => {
    const presented = bearer(c.req.header("authorization"));
    if (presented === null || !constantTimeEquals(presented, expected)) {
      return c.json(
        toEnvelope({
          status: 401,
          code: "UNAUTHORIZED",
          message:
            "the /internal surface requires the platform key: Authorization: Bearer <BIB_INTERNAL_API_KEY>",
        }),
        401,
      );
    }
    // No end user is behind a provisioning call, so there is no principal to
    // set. Services record these writes as the system actor.
    c.set("principal", null);
    await next();
    return undefined;
  };
}

/**
 * The /api/v1 guard: a valid session, or 401.
 *
 * It resolves the principal ONCE per request and hands it to the handler
 * through the context, so a handler cannot accidentally run without one — and
 * cannot resolve it twice either.
 */
export function sessionGuard(principalOf: PrincipalResolver): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) {
      c.set("principal", null);
      await next();
      return undefined;
    }
    const principal = await principalOf((name) => c.req.header(name));
    if (!principal) {
      return c.json(
        toEnvelope({ status: 401, code: "UNAUTHORIZED", message: "no authenticated session" }),
        401,
      );
    }

    // GATE 2 — audience. A client-portal session is authenticated and belongs
    // to the tenant; neither fact entitles it to the firm's staff workspace.
    if (principal.audience === "CLIENT_PORTAL" && !PORTAL_PATHS.has(c.req.path)) {
      return c.json(
        toEnvelope({
          status: 403,
          code: "FORBIDDEN",
          message:
            "this is a client-portal session; the staff workspace is not available to it",
        }),
        403,
      );
    }

    c.set("principal", principal);
    await next();
    return undefined;
  };
}

function bearer(header: string | undefined): Buffer | null {
  if (header === undefined) return null;
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || value === undefined || value === "") return null;
  return Buffer.from(value);
}

/** timingSafeEqual throws on a length mismatch, and the lengths themselves are
 *  compared here — a wrong-length key is rejected without leaking anything the
 *  attacker did not already supply. */
function constantTimeEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
