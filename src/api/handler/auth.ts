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
import { SESSION_TTL_DAYS } from "../../domain/identity/model";
import type { IdentityService, SignInResult } from "../../usecase/identity/service";
import { tokenFrom } from "../principal";

export interface AuthDeps {
  readonly service: IdentityService;
  readonly cookieName: string;
  readonly cookieSecure: boolean;
}

// ── Schemas ──────────────────────────────────────────────────────────────────

const PrincipalSchema = z
  .object({
    userId: z.string().uuid(),
    sessionId: z.string().uuid(),
    tenantId: z.string().uuid().nullable(),
    audience: z.enum(["STAFF", "CLIENT_PORTAL"]).nullable(),
  })
  .openapi("Principal");

const MembershipSummarySchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
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

  const signInBody = (result: SignInResult): z.infer<typeof SignInSchema> => ({
    principal: result.principal,
    memberships: result.memberships.map((m) => ({
      id: m.id,
      tenantId: m.tenantId,
      audience: m.audience,
      role: m.role,
    })),
  });

  app.openapi(loginRoute, async (c) => {
    const { email, password } = c.req.valid("json");
    const result = await deps.service.login(email, password);
    issue(c, result);
    return c.json(signInBody(result), 200);
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
    return c.json(signInBody(result), 200);
  });

  // The guard has already refused an unauthenticated caller on these two, so
  // the null branch is unreachable in practice — but the type says nullable and
  // an unreachable branch that returns 401 is cheaper than a cast that lies.
  app.openapi(meRoute, (c) => {
    const principal = c.get("principal");
    if (!principal) return c.json(unauthorized("no authenticated session"), 401);
    return c.json(principal, 200);
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
    return c.json(switched, 200);
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
