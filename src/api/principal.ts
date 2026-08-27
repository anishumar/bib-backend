// How a request becomes a principal — the driving port of authentication, and
// the two adapters registered against it.
//
// It lives in api/ rather than in a handler because more than one module needs
// it now, and it is transport knowledge: cookies and Authorization headers are
// HTTP's business, not the use case's. The use case is handed a token string
// and hands back a principal.
import type { Principal } from "../platform/callctx";
import type { IdentityService } from "../usecase/identity/service";

/** Resolves the authenticated principal from a request's headers. Async because
 *  a real session is a database lookup — that is the price of being able to
 *  revoke one. */
export type PrincipalResolver = (
  getHeader: (name: string) => string | undefined,
) => Promise<Principal | null>;

/**
 * The real adapter: a session cookie, or `Authorization: Bearer <token>` for
 * non-browser callers. The cookie is httpOnly, so the browser sends it and no
 * script can read it — which is why the token is never returned in a response
 * body either. Both paths end in the same lookup.
 */
export function sessionResolver(identity: IdentityService, cookieName: string): PrincipalResolver {
  return async (getHeader) => {
    const token = tokenFrom(getHeader, cookieName);
    if (token === null) return null;
    return identity.resolveSession(token);
  };
}

/**
 * The dev adapter: trusts an `x-user-id` header. This is NOT authentication —
 * it is a stand-in that lets local work proceed without a login, and
 * `validateServer` refuses to boot a production-like environment that has it
 * registered (BIB_DEV_AUTH_ENABLED).
 *
 * It answers with a session-less principal and no tenant, so anything that
 * needs an org still has to go through the real flow.
 */
export function devHeaderResolver(): PrincipalResolver {
  return (getHeader) => {
    const userId = getHeader("x-user-id");
    if (userId === undefined || userId === "") return Promise.resolve(null);
    return Promise.resolve({
      userId,
      sessionId: DEV_SESSION_ID,
      tenantId: null,
      audience: null,
      role: null,
      commercialVisibility: null,
    });
  };
}

/** A recognisable, invalid session id: it is not a session, and anything that
 *  tries to revoke or switch it will fail loudly rather than half-work. */
export const DEV_SESSION_ID = "00000000-0000-0000-0000-0000000000de";

/** Tries the real resolver, then the dev one. Registered only when dev auth is
 *  enabled; in every other environment `wire` passes the session resolver
 *  alone, so there is no fallback to fall back TO. */
export function firstOf(...resolvers: readonly PrincipalResolver[]): PrincipalResolver {
  return async (getHeader) => {
    for (const resolve of resolvers) {
      const principal = await resolve(getHeader);
      if (principal) return principal;
    }
    return null;
  };
}

/** The bearer token, from the session cookie or an Authorization header. */
export function tokenFrom(
  getHeader: (name: string) => string | undefined,
  cookieName: string,
): string | null {
  const auth = getHeader("authorization");
  if (auth !== undefined) {
    const [scheme, value] = auth.split(" ");
    if (scheme?.toLowerCase() === "bearer" && value !== undefined && value !== "") return value;
  }
  return cookieValue(getHeader("cookie"), cookieName);
}

/** Minimal Cookie-header parse. Hono's helper reads the request object; this
 *  layer only ever sees a header accessor, which keeps the resolver testable
 *  with a plain function. */
function cookieValue(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}
