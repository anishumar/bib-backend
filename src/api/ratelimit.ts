// Per-client rate limiting at the edge.
//
// This is the first of two limits on the sign-in path and it defends a
// different thing from the second. Here the key is the CLIENT ADDRESS, which
// stops one machine grinding through passwords or piling up expensive hashes.
// In the identity use case the key is the ACCOUNT, which stops a botnet
// grinding through one person's password from a thousand addresses. Neither
// substitutes for the other, which is why both exist.
//
// Mounted by prefix like the auth guards, for the same reason: a limit each
// route remembers to apply is a limit new routes forget.
import type { MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { RateLimiter } from "../platform/ratelimit";
import type { AppEnv } from "./guards";
import { toEnvelope } from "./httpresp";

export interface RateLimitRule {
  /** Attempts permitted per window, per client. */
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitConfig {
  /** Applied to the unauthenticated sign-in routes — the expensive, guessable
   *  ones. Deliberately tight. */
  readonly auth: RateLimitRule;
  /** Applied to everything else, as a backstop against a single client
   *  saturating the process. Loose enough that real use never notices. */
  readonly general: RateLimitRule;
  /**
   * Whether to believe X-Forwarded-For.
   *
   * Load-bearing, and dangerous in both directions. Behind a load balancer the
   * connection address is the balancer's, so every client shares one key and
   * the limit throttles the whole world at once. WITHOUT a proxy in front,
   * trusting the header lets any client invent its own key per request and
   * opt out of rate limiting entirely. It must match the deployment, which is
   * why it is configuration and not a guess.
   */
  readonly trustProxy: boolean;
}

/**
 * Rate limiting for the sign-in routes and a looser backstop for the rest.
 *
 * A limited request gets 429 with Retry-After, and never reaches the handler —
 * which is the point on the login route, where reaching the handler means
 * spending 32 MB and ~50 ms on a scrypt hash for an unauthenticated caller.
 */
export function rateLimit(
  limiter: RateLimiter,
  cfg: RateLimitConfig,
  authPaths: ReadonlySet<string>,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const isAuth = authPaths.has(c.req.path);
    const rule = isAuth ? cfg.auth : cfg.general;
    const client = clientKey(c.req.raw, () => remoteAddressOf(c), cfg.trustProxy);

    const decision = await limiter.check(
      `${isAuth ? "auth" : "general"}:${client}`,
      rule.limit,
      rule.windowSeconds,
    );
    if (!decision.allowed) {
      c.header("Retry-After", String(decision.retryAfterSeconds));
      return c.json(
        toEnvelope({
          status: 429,
          code: "RATE_LIMITED",
          message: `too many requests; retry in ${String(decision.retryAfterSeconds)}s`,
        }),
        429,
      );
    }
    await next();
    return undefined;
  };
}

/**
 * The connection's remote address, when the runtime exposes one.
 *
 * getConnInfo reads node's underlying socket, which is absent whenever the app
 * is driven directly rather than over a real connection — every test that calls
 * app.request(), and any future non-node runtime. It throws in that case, and a
 * rate limiter that can crash the request it is protecting is worse than none:
 * the whole API would 500. So the failure is caught and treated as "address
 * unknown", which fails closed at clientKey below.
 */
function remoteAddressOf(c: { env: unknown }): string | undefined {
  try {
    return getConnInfo(c as Parameters<typeof getConnInfo>[0]).remote.address;
  } catch {
    return undefined;
  }
}

/**
 * The client's address.
 *
 * Falls back to a single shared key when the address cannot be determined,
 * which fails CLOSED — everyone shares one bucket and the limit still bites.
 * The alternative, a unique key per unknown client, would make the limiter
 * silently ineffective exactly when it cannot see who is calling.
 */
function clientKey(
  req: Request,
  remoteAddress: () => string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const forwarded = req.headers.get("x-forwarded-for");
    // The left-most entry is the originating client; the rest are proxies.
    const first = forwarded?.split(",")[0]?.trim();
    if (first !== undefined && first !== "") return first;
  }
  return remoteAddress() ?? "unknown-client";
}
