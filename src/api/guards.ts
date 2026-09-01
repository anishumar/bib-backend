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
//                  membership, set a password). No end user behind it, so each
//                  CALLER has its own key, carrying only the capabilities it
//                  needs. A single key opening every route was an escalation
//                  path, not a convenience.
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
import type { InternalClient } from "./capabilities";
import { capabilityFor } from "./capabilities";
import type { AuthzService } from "../usecase/authz/service";
import type { PrincipalResolver } from "./principal";
import { decideRoute } from "./permissions";
import { toEnvelope } from "./httpresp";

/** What the guards put into the request context for handlers to read. Typed
 *  nullable on purpose: a handler must still ask, and on a public route the
 *  honest answer is "nobody". */
export interface AppEnv {
  Variables: {
    principal: Principal | null;
    /** Which provisioning caller made this request, on /internal only. Named in
     *  the audit trail so "system did it" can be traced to a system. */
    internalClient: InternalClient | null;
  };
}

/**
 * The routes under /api/v1 that may be reached without a session.
 *
 * An exact-match allowlist, never a prefix: `/api/v1/auth/` as a prefix would
 * have silently exempted every future auth route, including ones that act on an
 * existing session. Three routes exist to OBTAIN a session; that is their
 * entire justification, and anything else added here needs its own.
 *
 * THE FOURTH ONE, and why it earns its place (T2.2b). A proposal goes to
 * somebody who has no login and will not get one — that is what a proposal IS,
 * the document that comes before the relationship. Requiring a session would
 * mean provisioning an account for every prospect a firm quotes, which is both
 * absurd and a worse security posture than a bearer link: it would leave real
 * accounts lying around for people who never became clients.
 *
 * What makes it safe to be here, rather than merely necessary:
 *
 *   · the token is 256 bits from the OS CSPRNG, stored only as a SHA-256 digest
 *   · it carries its own tenant, so resolving it is an ordinary `withTenant`
 *     read and needs no RLS exception (migration 0014)
 *   · it arrives in the BODY, not the path, so it does not land in access logs,
 *     browser history or a Referer header
 *   · it is READ-ONLY: the recipient cannot accept, reject or change anything
 *   · it answers one way for malformed, unknown and withdrawn, so it cannot be
 *     used to enumerate anything
 *   · being in this set puts it in the tight rate-limit bucket automatically —
 *     see the note in router.ts, which derives that bucket from this list
 */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/api/v1/auth/login",
  "/api/v1/auth/magic-link",
  "/api/v1/auth/magic-link/redeem",
  "/api/v1/proposals/shared",
  // ── THE FIFTH, and it earns its place the way the fourth did ─────────────
  //
  // Everything else on this list exists to OBTAIN a session, and so does this:
  // a client's contact holding an emailed invitation has no login yet, and this
  // is the route on which they get their first. It cannot require a session
  // because the session is what it produces.
  //
  // What makes it safe is the same set of properties the share link has. The
  // token is single-use and expiring, only its SHA-256 digest is stored, and it
  // arrives in the BODY — a path lands in access logs and Referer headers, and
  // this one is a credential until it is spent. It is bound to a PURPOSE, so a
  // sign-in link cannot be spent here and an invitation cannot be spent at the
  // sign-in route. And unknown, expired, already-used and wrong-purpose all
  // answer identically, so it cannot be used to discover whether an address has
  // an account.
  //
  // What it does that the others do not is WRITE — it sets a password. That is
  // the act being authorised by holding the link, and it is why the link is
  // worth this paragraph: whoever holds it becomes that person. Adding a sixth
  // entry needs an argument at least this good, and
  // `tests/api/auth-coverage.test.ts` holds the build red until somebody writes
  // one.
  "/api/v1/portal-invites/accept",
]);

/**
 * The routes a CLIENT_PORTAL session may reach. Everything else on /api/v1 is
 * the STAFF workspace.
 *
 * Denied by default, and that default is load-bearing. With the reverse — allow
 * unless denied — a client contact could list the firm's entire book of
 * clients, create parties in it, and read its audit trail, simply by signing in
 * through the front door. That was true of this codebase until this list
 * existed; it was not an attack, it was the normal login path.
 *
 * Audience is the coarse gate; record-scope (gate 4) is the fine one, and a
 * portal route needs BOTH — being listed here says only that a client may ask
 * the question, never which rows come back.
 *
 * ── TEMPLATES, MATCHED THE WAY GATE 3 MATCHES THEM (T6.6) ────────────────
 *
 * This list is written in the same vocabulary as `ROUTE_PERMISSIONS` — the
 * OpenAPI path, `{param}` included — and `isPortalPath` below compiles it once
 * and matches the concrete path against it.
 *
 * It was a plain `Set.has` over the path as it arrived until T6.6, and that was
 * a real constraint rather than an oversight: a portal route carrying a path
 * parameter was unreachable whatever was written here, so T6.5's status home is
 * one parameter-less aggregate read. Every verb T6.6 wants — upload against a
 * document, answer one question, approve one thing — names the record it acts
 * on in its path, so none of them was reachable at all.
 *
 * WIDENING THIS GATE IS ITS OWN CHANGE, and it was made as one, before any
 * route needed it. What it widens is the gate that stops a client contact
 * reading the firm's whole book of clients, and a template that matched more
 * than it named would do exactly that silently. So the containment is a test
 * rather than care: `tests/api/auth-coverage.test.ts` asserts, over EVERY route
 * the router has registered, that `isPortalPath(concrete(path))` agrees exactly
 * with `PORTAL_PATHS.has(template)`. A template that swallows a staff route
 * turns that red, naming the route it swallowed.
 */
export const PORTAL_PATHS: ReadonlySet<string> = new Set([
  "/api/v1/auth/me",
  "/api/v1/auth/switch-tenant",
  "/api/v1/auth/logout",
  // The org switcher's data. Without it a portal user could CALL switch-tenant
  // and have no way to learn what to switch to — reachable and useless. It
  // returns only the caller's own memberships, so a portal session sees exactly
  // what it already knows about itself.
  "/api/v1/tenancy/me/memberships",
  // ── THE FIRST ROUTE HERE THAT RETURNS A BUSINESS RECORD (T6.5) ───────────
  //
  // Everything above manages a session. This is the client portal's status home
  // — what the firm is doing for the companies this login was granted, what is
  // held up, and what has been filed — and until it existed a client contact
  // could sign in and land on a blank page, which is indistinguishable from
  // broken software.
  //
  // What makes it safe is not this line: it is that every table it reads carries
  // its own RESTRICTIVE policy written in terms of `crm.portal_sees()`
  // (`delivery.work_item` in 0059, `delivery.obligation_instance` and the
  // client-visible flag in 0062), and that the one adapter behind it uses
  // `withPortal` rather than `withTenant`. This line only says a client may ASK.
  "/api/v1/portal/home",
  // ── THE ACTION CENTRE (T6.6), AND THE FIRST TEMPLATES ON THIS LIST ──────
  //
  // The routes this gate was taught templates for. What makes them safe is not
  // these lines:
  //
  //   · every table behind them carries a RESTRICTIVE policy in terms of
  //     `crm.portal_sees()` — `delivery.client_ask` and
  //     `delivery.client_ask_response` in 0063, the work item they hang off in
  //     0059/0062, and the document store in 0063
  //   · the adapter uses `withPortal`, never `withTenant`, on the WRITES as well
  //   · the three that ACT need `portal:respond` (gate 3), which only a role
  //     declaring the CLIENT_PORTAL audience can carry
  //
  // The list needs no permission, because being granted a company IS the
  // authorisation to read it — which is what makes a read-only contact possible
  // at all.
  "/api/v1/portal/asks",
  "/api/v1/portal/asks/{askId}/answer",
  "/api/v1/portal/asks/{askId}/decision",
  "/api/v1/portal/asks/{askId}/documents",
  // ── THE SELF-SERVE LIBRARY (T6.7), AND THE FIRST BYTES A CLIENT READS ───
  //
  // Four READS, so none of them is behind a permission — reading is authorised
  // by the GRANT, which is what lets a `client_viewer` find last year's challan
  // without asking anybody. What makes them safe is not these lines:
  //
  //   · `files.document`'s policy was NARROWED in 0066 rather than merely
  //     relied on. This is the first route in the product that LISTS documents,
  //     and `crm.portal_sees(party_id)` alone would have handed the client
  //     every working paper the firm ever filed against them
  //   · `crm.invoice` gained its first portal policy in 0066, on `party_id`
  //     (who is BILLED) and never on a join, with a DRAFT excluded inside the
  //     policy rather than in a query
  //   · the adapter uses `withPortal`, never `withTenant`
  //
  // `/content` is the second route in this product that returns BYTES and the
  // first on the client's side. T3.6's rule extends unchanged: one route, no
  // pre-signed URL, `content-disposition: attachment`.
  "/api/v1/portal/documents",
  "/api/v1/portal/documents/{documentId}/content",
  "/api/v1/portal/invoices",
  "/api/v1/portal/digest",
]);

/**
 * Compile a set of route templates into the gate's matcher.
 *
 * The same compilation `decideRoute` does, and deliberately not shared with it:
 * that one keys on `METHOD /path` and answers with a permission, this one keys
 * on the path alone and answers yes or no. A helper serving both would have to
 * take a method that this gate does not have an opinion about.
 *
 * PATH ONLY, AND THAT IS UNCHANGED. Gate 2 has never asked which METHOD a
 * portal session used, because it is the coarse gate: it says a client may ASK
 * at this address, and gate 3 — which is keyed on the method — says what may be
 * done there. A method this route does not register is `unmapped` at gate 3 and
 * refused, so nothing is opened by leaving the method out here.
 *
 * Exported so a test can compile a list of its own and prove the template
 * behaviour without a route having to exist for it — which is what let this
 * change ship before the routes that need it.
 */
export function compilePortalPaths(paths: Iterable<string>): (path: string) => boolean {
  const patterns = [...paths].map((template) => {
    const source = template
      .split("/")
      .map((segment) =>
        segment.startsWith("{") && segment.endsWith("}")
          ? // A single segment, never a slash: `[^/]+` is what stops
            // `/api/v1/portal/asks/{askId}` from also matching
            // `/api/v1/portal/asks/<id>/anything-else`.
            "[^/]+"
          : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("/");
    return new RegExp(`^${source}$`);
  });
  return (path: string) => patterns.some((pattern) => pattern.test(path));
}

/** Whether a CLIENT_PORTAL session may ask at this concrete path. */
export const isPortalPath = compilePortalPaths(PORTAL_PATHS);

/**
 * The /internal guard: a bearer secret from config, compared in constant time.
 *
 * The comparison is timing-safe because the alternative leaks the key one byte
 * at a time to anyone willing to measure, and this key is the provisioning API.
 */
export function internalGuard(clients: readonly InternalClient[]): MiddlewareHandler<AppEnv> {
  // Compared in constant time, because the alternative leaks a key one byte at
  // a time to anyone willing to measure. Every candidate is checked even after
  // a match, so the work does not depend on WHICH key was presented.
  const registry = clients.map((client) => ({ client, expected: Buffer.from(client.key) }));

  return async (c, next) => {
    const presented = bearer(c.req.header("authorization"));
    let matched: InternalClient | null = null;
    for (const { client, expected } of registry) {
      if (presented !== null && constantTimeEquals(presented, expected)) matched = client;
    }

    if (matched === null) {
      return c.json(
        toEnvelope({
          status: 401,
          code: "UNAUTHORIZED",
          message:
            "the /internal surface requires a platform key: Authorization: Bearer <key from BIB_INTERNAL_KEYS>",
        }),
        401,
      );
    }

    // AUTHORIZATION, not just authentication. A route with no declared
    // capability is refused to every caller — the same deny-by-default the
    // product surface uses, so a new provisioning route cannot ship open.
    //
    // This runs before routing, so it cannot tell a route that forgot its
    // entry from a path that does not exist, and answers 403 to both. Losing
    // an accurate 404 is the price of the default being "no": a typo here says
    // 403 rather than 404, and in exchange no route can be open by omission.
    const needed = capabilityFor(c.req.method, c.req.path);
    if (needed === null) {
      return c.json(
        toEnvelope({
          status: 403,
          code: "FORBIDDEN",
          message:
            "no provisioning route here declares a capability, so no key may call it. Either the " +
            "path is wrong, or the route needs an entry in ROUTE_CAPABILITIES (api/capabilities.ts).",
        }),
        403,
      );
    }
    if (!matched.capabilities.includes(needed)) {
      return c.json(
        toEnvelope({
          status: 403,
          code: "FORBIDDEN",
          message: `the platform key "${matched.name}" does not carry ${needed}`,
        }),
        403,
      );
    }

    // No end user is behind a provisioning call, so there is no principal —
    // but there IS a named caller, and the audit trail records which one.
    c.set("principal", null);
    c.set("internalClient", matched);
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
      c.set("internalClient", null);
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
    if (principal.audience === "CLIENT_PORTAL" && !isPortalPath(c.req.path)) {
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
    c.set("internalClient", null);
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

/**
 * GATE 3 — role. Runs after the session guard, so a principal is present and
 * its audience has already been checked.
 *
 * The permission comes from one central table (api/permissions.ts) and an
 * unmapped route is REFUSED. Adding a route without deciding who may reach it
 * therefore fails immediately and visibly, instead of being open until someone
 * notices — which is exactly how the holes in 5314ef6 survived review.
 *
 * `require` throws, and the router's onError maps AuthzError to 403. That is
 * deliberate: a check whose result can be ignored eventually is.
 */
export function permissionGuard(authz: AuthzService): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) {
      await next();
      return undefined;
    }
    const principal = c.get("principal");
    if (!principal) {
      // Unreachable behind sessionGuard; refusing is the safe reading anyway.
      return c.json(
        toEnvelope({ status: 401, code: "UNAUTHORIZED", message: "no authenticated session" }),
        401,
      );
    }

    const decision = decideRoute(c.req.method, c.req.path);
    if (decision.kind === "unmapped") {
      return c.json(
        toEnvelope({
          status: 403,
          code: "FORBIDDEN",
          message:
            "this route declares no permission, so nobody may reach it. Add it to " +
            "ROUTE_PERMISSIONS (or NO_PERMISSION_REQUIRED) in api/permissions.ts.",
        }),
        403,
      );
    }
    if (decision.kind === "permission") {
      await authz.require(principal, decision.permission);
    }
    await next();
    return undefined;
  };
}
