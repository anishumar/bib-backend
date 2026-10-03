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
//
// ── THE SIGNED-IN SURFACE IS COUNTED PER SESSION (audit 2026-10-03) ─────────
//
// The backstop bucket used to be the address too, for every request. A firm of
// forty behind one office NAT gateway then shared ONE 300-a-minute bucket, and
// the frontend read a 429 on `/auth/me` as "signed out" (F15, B28, CA#14). So:
//
//   · the sign-in routes (PUBLIC_PATHS)      → the tight bucket, per ADDRESS
//   · a signed-in request on /api/v1         → the general bucket, per SESSION
//   · everything else on the address: /internal, /health, the docs, and any
//     /api/v1 request whose credential is missing or does not resolve
//
// The last line is what keeps the session key from being a way out of the
// limit. A credential is only known to be real AFTER the session lookup, so a
// caller who invented a fresh cookie per request would otherwise get a fresh
// bucket per request and a free lookup each time. Instead the ADDRESS is
// charged for every credential that failed, and an address that has spent its
// budget is refused before the next lookup is paid for. A colleague whose
// session is real is never charged to the office's address at all.
//
// The numbers are unchanged (BIB_RATELIMIT_*). Only the key moved.
import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Principal } from "../platform/callctx";
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
 *
 * Runs BEFORE the session guard. A non-public /api/v1 request is not counted
 * here when its credential resolves: `sessionRateLimit`, mounted after the
 * guard, counts it against the session. See the header of this file.
 */
export function rateLimit(
  limiter: RateLimiter,
  cfg: RateLimitConfig,
  authPaths: ReadonlySet<string>,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const isAuth = authPaths.has(c.req.path);
    const client = clientKey(c.req.raw, () => remoteAddressOf(c), cfg);
    // Published for the login handler: the per-account attempt budget is spent
    // per caller, so that ten wrong guesses cost the guesser their own budget
    // rather than locking the account's owner out. This is the only place that
    // knows how to derive an address it is safe to believe.
    c.set("clientKey", client);

    if (!isAuth && c.req.path.startsWith(SESSION_SURFACE)) {
      // Signed-in surface: refuse an address that has spent its budget on
      // credentials that did not resolve, before paying for another lookup...
      const addressKey = `general:${client}`;
      const standing = await limiter.peek(addressKey, cfg.general.limit, cfg.general.windowSeconds);
      if (!standing.allowed) return tooMany(c, standing.retryAfterSeconds);
      await next();
      // ...and charge it for this one if the guard found nobody behind it.
      // `principal` is set (to a principal, or to null on a public route) by
      // the session guard whenever it lets a request through.
      if (!resolved(c)) {
        await limiter.check(addressKey, cfg.general.limit, cfg.general.windowSeconds);
      }
      return undefined;
    }

    const rule = isAuth ? cfg.auth : cfg.general;
    const decision = await limiter.check(
      `${isAuth ? "auth" : "general"}:${client}`,
      rule.limit,
      rule.windowSeconds,
    );
    if (!decision.allowed) return tooMany(c, decision.retryAfterSeconds);
    await next();
    return undefined;
  };
}

/** What the session guard left on the context. The declared type says
 *  `Principal | null`, but a request the guard REFUSED never had it set, and
 *  that absence is exactly what the address is charged for. */
function seenPrincipal(c: Parameters<MiddlewareHandler<AppEnv>>[0]): Principal | null | undefined {
  const seen: Principal | null | undefined = c.get("principal");
  return seen;
}

/** Did the session guard let this request through (as somebody, or as a
 *  public route)? */
function resolved(c: Parameters<MiddlewareHandler<AppEnv>>[0]): boolean {
  return seenPrincipal(c) !== undefined;
}

/** The prefix whose requests carry a session, and so are counted per session. */
const SESSION_SURFACE = "/api/v1/";

/**
 * The general budget, per SESSION, for a request the session guard has let
 * through with a principal. Mounted directly after the guard.
 *
 * The key is a digest of the session id, so the limiter's map never holds a
 * session identifier — a dump of it names nobody. Every tab and window of one
 * sign-in shares the bucket, because they share the cookie; a phone moving
 * from the office Wi-Fi to mobile data keeps its count, because the count
 * follows the session and not the address.
 */
export function sessionRateLimit(
  limiter: RateLimiter,
  cfg: Pick<RateLimitConfig, "general">,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = seenPrincipal(c);
    // A public route (the guard sets null) was counted on the address already.
    if (principal === null || principal === undefined) {
      await next();
      return undefined;
    }
    const decision = await limiter.check(
      `session:${createHash("sha256").update(principal.sessionId).digest("hex")}`,
      cfg.general.limit,
      cfg.general.windowSeconds,
    );
    if (!decision.allowed) return tooMany(c, decision.retryAfterSeconds);
    await next();
    return undefined;
  };
}

/** The refusal. Read by people (the frontend shows `message` verbatim), so it
 *  says what to do rather than what happened inside. */
function tooMany(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  retryAfterSeconds: number,
): Response {
  c.header("Retry-After", String(retryAfterSeconds));
  return c.json(
    toEnvelope({
      status: 429,
      code: "RATE_LIMITED",
      message: `Too many requests at once. Wait ${String(retryAfterSeconds)} ${
        retryAfterSeconds === 1 ? "second" : "seconds"
      } and try again.`,
    }),
    429,
  );
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
