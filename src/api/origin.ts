// The ORIGIN check on state-changing requests — the second half of this API's
// CSRF defence, and the half that survives a deployment change.
//
// The first half is the session cookie's SameSite=Lax, which stops a browser
// attaching the cookie to a cross-site POST at all. That works only while the
// app and the API share a registrable domain; the moment they do not (a front
// end on one provider, the API on another) the cookie has to become
// SameSite=None to work at all, and Lax stops defending anything. This check
// does not depend on that arrangement.
//
// ── WHY AN ABSENT Origin IS ALLOWED ───────────────────────────────────────
//
// Because a browser cannot omit it. Every cross-origin request a page can
// make — fetch, XHR, a plain <form> POST — carries Origin, so a forged request
// from evil.com always has one and always fails the allowlist. A request with
// NO Origin came from something that is not a page: curl, the smoke script, a
// server-to-server caller. Refusing those would break every non-browser client
// to defend against an attack none of them can mount.
//
// Safe methods are skipped: GET/HEAD/OPTIONS do not change state, and the
// preflight OPTIONS in particular must be answered by cors() rather than
// refused here.
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./guards";
import { toEnvelope } from "./httpresp";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Refuse a state-changing request whose Origin is not one this API serves.
 *
 * The allowlist is the SAME list CORS uses — there is exactly one set of
 * origins this API answers browsers from, and two lists that could drift would
 * mean a browser being allowed to read a reply to a request it may not send.
 */
export function originGuard(allowed: readonly string[]): MiddlewareHandler<AppEnv> {
  const permitted = new Set(allowed);
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) {
      await next();
      return undefined;
    }
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== "" && !permitted.has(origin)) {
      return c.json(
        toEnvelope({
          status: 403,
          code: "FORBIDDEN",
          message:
            "this request came from an origin this API does not serve, so it will not be " +
            "acted on",
          reason: "ORIGIN_NOT_ALLOWED",
        }),
        403,
      );
    }
    await next();
    return undefined;
  };
}
