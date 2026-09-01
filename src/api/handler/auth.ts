// The auth HTTP surface — sign in, prove, switch org, sign out.
//
// One rule shapes every response here: THE SESSION TOKEN IS NEVER IN A BODY.
// It leaves the server exactly once, in an httpOnly Set-Cookie, which no script
// can read and therefore no XSS can steal. A convenience copy in the JSON would
// undo that in one line, so there isn't one — a non-browser client sends the
// same cookie back, or uses Authorization: Bearer with a token it was given
// out of band.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { setCookie } from "hono/cookie";
import { z, errorResponse } from "../openapi";
import { toEnvelope } from "../httpresp";
import type { AuthzService } from "../../usecase/authz/service";
import type { Principal } from "../../platform/callctx";
import { SESSION_TTL_DAYS } from "../../domain/identity/model";
import type { IdentityService, SignInResult } from "../../usecase/identity/service";
import type { TenancyService } from "../../usecase/tenancy/service";
import { tokenFrom } from "../principal";

export interface AuthDeps {
  readonly service: IdentityService;
  /** So the caller can be told what it may DO, not only who it is. A screen
   *  that cannot ask has to offer everything and let the API refuse. */
  readonly authz: AuthzService;
  /**
   * So the caller can be told what its firm is CALLED.
   *
   * The principal carries a tenant uuid, which names the firm to the database
   * and to nobody else: every screen that showed whose session this is had to
   * print `b35c4196-b81c-…` at a person who has never seen a uuid. One lookup
   * here turns that into "Kaveri & Co" everywhere at once, because every screen
   * reads its identity from this one response.
   */
  readonly tenancy: TenancyService;
  readonly cookieName: string;
  readonly cookieSecure: boolean;
}

// ── Schemas ──────────────────────────────────────────────────────────────────

/**
 * What the caller is told about itself.
 *
 * `role` and `commercialVisibility` were on the wire long before they were in
 * this schema — the handler returned the domain Principal straight through, and
 * zod-openapi documents a response without validating it, so the spec quietly
 * described four fields while six were sent. In a codebase whose frontend
 * generates its entire client from this spec, that is the seam failing silently.
 * Every field is now named here AND named again by the mapper below, so the two
 * cannot drift: adding one to the domain Principal no longer puts it on the wire
 * by itself.
 */
const PrincipalSchema = z
  .object({
    userId: z.string().uuid(),
    /**
     * What a colleague calls the person signed in, and the address that
     * identifies them when nobody has said.
     *
     * BOTH, because `display_name` is nullable and genuinely empty at real
     * firms. Without them the shell had only `role` to put under the avatar, so
     * every sidebar in the product read "partner · Signed in" — the product
     * telling somebody what they ARE rather than who they are, and identical
     * for every partner at the firm.
     */
    displayName: z.string().nullable(),
    email: z.string().nullable(),
    sessionId: z.string().uuid(),
    tenantId: z.string().uuid().nullable(),
    /** What that firm is CALLED. Null when no firm is selected, and null again
     *  in the state that cannot normally happen — a session pointed at a tenant
     *  row that is gone. A screen prints the id in that case rather than an
     *  empty space, because a blank name is indistinguishable from a firm
     *  called nothing. */
    tenantName: z.string().nullable(),
    audience: z.enum(["STAFF", "CLIENT_PORTAL"]).nullable(),
    /** Null until an org is chosen — a session can belong to several firms. */
    role: z.string().nullable(),
    commercialVisibility: z.boolean().nullable(),
    /** What this caller may do, so a screen can offer only what will work.
     *  What it HOLDS, never the vocabulary it does not — the full set is
     *  GET /api/v1/config/permissions, behind config:read. */
    permissions: z.array(z.string()),
  })
  .openapi("Principal");

const MembershipSummarySchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    /** The firm's own name. This list is a CHOICE offered to somebody who
     *  belongs to more than one firm, and "partner · b35c4196" is not a choice
     *  anybody can make. */
    tenantName: z.string().nullable(),
    audience: z.enum(["STAFF", "CLIENT_PORTAL"]),
    role: z.string(),
  })
  .openapi("MembershipSummary");

const SignInSchema = z
  .object({
    principal: PrincipalSchema,
    /** More than one entry means no tenant is active yet — call switch-tenant. */
    memberships: z.array(MembershipSummarySchema),
  })
  .openapi("SignInResponse");

const LoginBody = z
  .object({ email: z.string().email(), password: z.string().min(1) })
  .openapi("LoginRequest");

const MagicLinkBody = z.object({ email: z.string().email() }).openapi("MagicLinkRequest");

const RedeemBody = z.object({ token: z.string().min(1) }).openapi("RedeemMagicLinkRequest");

const SwitchTenantBody = z
  .object({ tenantId: z.string().uuid() })
  .openapi("SwitchTenantRequest");

const SetPasswordBody = z
  .object({ password: z.string().min(1) })
  .openapi("SetPasswordRequest");

// ── Routes ───────────────────────────────────────────────────────────────────

const loginRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/login",
  tags: ["auth"],
  summary: "Sign in with email and password",
  description:
    "On success sets an httpOnly session cookie. The token is never returned in the body.",
  request: { body: { content: { "application/json": { schema: LoginBody } }, required: true } },
  responses: {
    200: { description: "Signed in", content: { "application/json": { schema: SignInSchema } } },
    400: errorResponse("Request failed validation"),
    401: errorResponse("Email or password is incorrect"),
    403: errorResponse("Account disabled, or no active membership"),
  },
});

const magicLinkRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/magic-link",
  tags: ["auth"],
  summary: "Email a single-use sign-in link",
  description:
    "Always answers 202, whether or not the address has an account — the endpoint must not " +
    "reveal who banks with the firm.",
  request: { body: { content: { "application/json": { schema: MagicLinkBody } }, required: true } },
  responses: {
    202: {
      description: "Accepted; a link is sent if the address has an active account",
      content: { "application/json": { schema: z.object({ status: z.literal("accepted") }) } },
    },
    400: errorResponse("Request failed validation"),
  },
});

const redeemRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/magic-link/redeem",
  tags: ["auth"],
  summary: "Exchange a magic-link token for a session",
  request: { body: { content: { "application/json": { schema: RedeemBody } }, required: true } },
  responses: {
    200: { description: "Signed in", content: { "application/json": { schema: SignInSchema } } },
    400: errorResponse("Request failed validation"),
    401: errorResponse("The link is unknown, expired, or already used"),
    403: errorResponse("No active membership"),
  },
});

const meRoute = createRoute({
  method: "get",
  path: "/api/v1/auth/me",
  tags: ["auth"],
  summary: "The caller's principal",
  responses: {
    200: { description: "Principal", content: { "application/json": { schema: PrincipalSchema } } },
    401: errorResponse("No authenticated session"),
  },
});

const switchTenantRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/switch-tenant",
  tags: ["auth"],
  summary: "Point the session at one of the caller's tenants (the org switcher)",
  request: {
    body: { content: { "application/json": { schema: SwitchTenantBody } }, required: true },
  },
  responses: {
    200: { description: "Switched", content: { "application/json": { schema: PrincipalSchema } } },
    400: errorResponse("Request failed validation"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The caller holds no active membership in that tenant"),
  },
});

const logoutRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/logout",
  tags: ["auth"],
  summary: "Revoke the current session",
  description: "Idempotent — an unknown or already-revoked token is still a 204.",
  responses: { 204: { description: "Signed out" } },
});

const setPasswordRoute = createRoute({
  method: "put",
  path: "/internal/v1/users/{userId}/password",
  tags: ["auth"],
  summary: "Set a user's password (platform surface)",
  description:
    "Provisioning, not app-facing: it is how a login is seeded today, and it requires the " +
    "platform key like everything under /internal. Every existing session of that user is " +
    "revoked. Self-service password change arrives with the portal.",
  request: {
    params: z.object({ userId: z.string().uuid() }),
    body: { content: { "application/json": { schema: SetPasswordBody } }, required: true },
  },
  responses: {
    204: { description: "Password set" },
    400: errorResponse("Password does not meet the length policy"),
    401: errorResponse("Missing or wrong platform key"),
  },
});

// ── Registration ─────────────────────────────────────────────────────────────

export function registerAuthRoutes(app: OpenAPIHono<AppEnv>, deps: AuthDeps): void {
  const unauthorized = (message: string): ReturnType<typeof toEnvelope> =>
    toEnvelope({ status: 401, code: "UNAUTHORIZED", message });

  /** Sets the session cookie. maxAge mirrors the session's own TTL, so the
   *  browser forgets it at roughly the moment the server stops honouring it. */
  const issue = (c: Parameters<Parameters<typeof app.openapi>[1]>[0], result: SignInResult): void => {
    setCookie(c, deps.cookieName, result.token, {
      httpOnly: true,
      secure: deps.cookieSecure,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
    });
  };

  /**
   * The wire shape of a principal, field by field.
   *
   * Named explicitly rather than forwarding the domain object: that is what let
   * `role` and `commercialVisibility` reach the wire undocumented. A mapper is
   * a compile error when the schema and the domain disagree; a pass-through is
   * a silent one.
   */
  const principalBody = async (
    principal: Principal,
  ): Promise<z.infer<typeof PrincipalSchema>> => {
    // Only when there IS a firm. A session that has not chosen one has nothing
    // to look up, and asking anyway would be a query per call on every screen
    // of the one flow where the answer is known to be null.
    const [names, account] = await Promise.all([
      principal.tenantId === null
        ? Promise.resolve(null)
        : deps.tenancy.tenantNames([principal.tenantId]),
      deps.tenancy.account(principal.userId),
    ]);
    return {
      userId: principal.userId,
      displayName: account?.displayName ?? null,
      email: account?.email ?? null,
      sessionId: principal.sessionId,
      tenantId: principal.tenantId,
      tenantName:
        principal.tenantId === null ? null : (names?.get(principal.tenantId) ?? null),
      audience: principal.audience,
      role: principal.role,
      commercialVisibility: principal.commercialVisibility,
      permissions: [...(await deps.authz.permissionsOf(principal))],
    };
  };

  const signInBody = async (result: SignInResult): Promise<z.infer<typeof SignInSchema>> => {
    // ONE lookup for the whole list, not one per row: this is the response that
    // fans out to three firms for somebody who works at three.
    const names = await deps.tenancy.tenantNames(result.memberships.map((m) => m.tenantId));
    return {
      principal: await principalBody(result.principal),
      memberships: result.memberships.map((m) => ({
        id: m.id,
        tenantId: m.tenantId,
        tenantName: names.get(m.tenantId) ?? null,
        audience: m.audience,
        role: m.role,
      })),
    };
  };

  app.openapi(loginRoute, async (c) => {
    const { email, password } = c.req.valid("json");
    const result = await deps.service.login(email, password);
    issue(c, result);
    return c.json(await signInBody(result), 200);
  });

  app.openapi(magicLinkRoute, async (c) => {
    const { email } = c.req.valid("json");
    await deps.service.requestMagicLink(email);
    return c.json({ status: "accepted" as const }, 202);
  });

  app.openapi(redeemRoute, async (c) => {
    const { token } = c.req.valid("json");
    const result = await deps.service.redeemMagicLink(token);
    issue(c, result);
    return c.json(await signInBody(result), 200);
  });

  // The guard has already refused an unauthenticated caller on these two, so
  // the null branch is unreachable in practice — but the type says nullable and
  // an unreachable branch that returns 401 is cheaper than a cast that lies.
  app.openapi(meRoute, async (c) => {
    const principal = c.get("principal");
    if (!principal) return c.json(unauthorized("no authenticated session"), 401);
    return c.json(await principalBody(principal), 200);
  });

  app.openapi(switchTenantRoute, async (c) => {
    const principal = c.get("principal");
    if (!principal) return c.json(unauthorized("no authenticated session"), 401);
    const { tenantId } = c.req.valid("json");
    const switched = await deps.service.switchTenant(
      principal.sessionId,
      principal.userId,
      tenantId,
    );
    // Rebuilt after the switch, not before: the caller's role — and therefore
    // everything it may do — belongs to the membership at the firm it just
    // moved to, and is usually different from the one it left.
    return c.json(await principalBody(switched), 200);
  });

  app.openapi(logoutRoute, async (c) => {
    const token = tokenFrom((name) => c.req.header(name), deps.cookieName);
    if (token !== null) await deps.service.logout(token);
    // Clear the cookie whatever happened: the browser must not keep presenting
    // a token the server has stopped honouring.
    setCookie(c, deps.cookieName, "", {
      httpOnly: true,
      secure: deps.cookieSecure,
      sameSite: "Lax",
      path: "/",
      maxAge: 0,
    });
    return c.body(null, 204);
  });

  app.openapi(setPasswordRoute, async (c) => {
    const { userId } = c.req.valid("param");
    const { password } = c.req.valid("json");
    await deps.service.setPassword(userId, password);
    return c.body(null, 204);
  });
}
