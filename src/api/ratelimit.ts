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
  /**
   * How many proxies stand in front of this process.
   *
   * The number that makes `trustProxy` safe. X-Forwarded-For is a list a client
   * can start and every proxy appends to, so the LEFT of it is attacker-typed
   * and the RIGHT is what each hop actually saw. Counting in from the right by
   * the number of hops you actually run lands on the address the outermost
   * trusted proxy observed — the real client — and no value the client wrote
   * can move it.
   *
   * One is the ordinary answer: one load balancer. Two is a CDN in front of a
   * load balancer. Setting it higher than the truth hands the key back to the
   * caller, which is the bug this replaces.
   */
  readonly trustedProxyHops: number;
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
    const client = clientKey(c.req.raw, () => remoteAddressOf(c), cfg);
    // Published for the login handler: the per-account attempt budget is spent
    // per caller, so that ten wrong guesses cost the guesser their own budget
    // rather than locking the account's owner out. This is the only place that
    // knows how to derive an address it is safe to believe.
    c.set("clientKey", client);

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
 * ── WHY THE RIGHT-HAND END, NOT THE LEFT ─────────────────────────────────────
 *
 * This read the LEFTMOST X-Forwarded-For entry, on the reasoning printed in
 * every explanation of the header: the left is the originating client. That is
 * true of a header nobody tampers with, and X-Forwarded-For is not one. A
 * client writes whatever it likes and each proxy APPENDS the peer it actually
 * saw, so `X-Forwarded-For: 203.0.113.9` from the caller arrives at this
 * process as `203.0.113.9, <the caller's real address>`. Reading the left of it
 * meant every request could carry a fresh invented key — a brand new bucket per
 * request, and both the auth limit and the general limit switched off, in
 * exactly the topology `trustProxy` exists to support.
 *
 * So it counts in from the RIGHT by the number of hops actually deployed. Entry
 * `length - hops` is what the outermost trusted proxy observed; everything left
 * of it is a claim, and the claims are ignored. A caller can lengthen the list
 * but not shorten it, so padding it only pushes their own address further right
 * — which the arithmetic follows.
 *
 * Falls back to a single shared key when the address cannot be determined,
 * which fails CLOSED — everyone shares one bucket and the limit still bites.
 * The alternative, a unique key per unknown client, would make the limiter
 * silently ineffective exactly when it cannot see who is calling.
 */
function clientKey(
  req: Request,
  remoteAddress: () => string | undefined,
  cfg: Pick<RateLimitConfig, "trustProxy" | "trustedProxyHops">,
): string {
  if (cfg.trustProxy) {
    const entries = (req.headers.get("x-forwarded-for") ?? "")
      .split(",")
      .map((e) => e.trim())
      .filter((e) => e !== "");
    // At least one, so a misconfigured zero cannot read past the end of the
    // list and land back on the attacker-controlled left.
    const hops = Math.max(1, cfg.trustedProxyHops);
    const observed = entries[entries.length - hops];
    if (observed !== undefined) return observed;
    // Fewer entries than hops: the request did not come through the proxies
    // this deployment claims. Fall through to the socket address rather than
    // believing the shortest list on offer.
  }
  return remoteAddress() ?? "unknown-client";
}
