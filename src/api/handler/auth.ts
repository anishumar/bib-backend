// Auth routes: sign in, prove, switch org, sign out. The session token is NEVER in a body: it
// leaves once, in an httpOnly Set-Cookie no XSS can read. A non-browser client sends the
// cookie back, or Authorization: Bearer with a token given out of band.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { setCookie } from "hono/cookie";
import { z, errorResponse } from "../openapi";
import { toEnvelope } from "../httpresp";
import type { AuthzService } from "../../usecase/authz/service";
import type { Principal } from "../../platform/callctx";
import { MAX_PASSWORD_LENGTH, SESSION_TTL_DAYS } from "../../domain/identity/model";
import { MAX_EMAIL_LENGTH, MAX_TOKEN_LENGTH } from "../bounds";
import type { IdentityService, SignInResult } from "../../usecase/identity/service";
import type { TenancyService } from "../../usecase/tenancy/service";
import type { PortalAccessService } from "../../usecase/portalaccess/service";
import { tokenFrom } from "../principal";

export interface AuthDeps {
  readonly service: IdentityService;
  /** Tells the caller what it may DO, so a screen offers only what will work. */
  readonly authz: AuthzService;
  /** Names the firm: every screen reads its identity from this response, not a tenant uuid. */
  readonly tenancy: TenancyService;
  /** Tells a CLIENT PORTAL session which companies it is looking at (gate 4's answer). Staff
   *  sessions never touch it. */
  readonly portalAccess: PortalAccessService;
  readonly cookieName: string;
  readonly cookieSecure: boolean;
  readonly cookieSameSite: "Lax" | "None";
}

// ── Schemas ──────────────────────────────────────────────────────────────────

/** What the caller is told about itself. Every field is named here AND in `principalBody`, so
 *  a new domain Principal field never reaches the wire undocumented. */
const PrincipalSchema = z
  .object({
    userId: z.string().uuid(),
    /** Name and email both: `display_name` is nullable and genuinely empty at real firms. */
    displayName: z.string().nullable(),
    email: z.string().nullable(),
    sessionId: z.string().uuid(),
    tenantId: z.string().uuid().nullable(),
    /** Null when no firm is selected, or the tenant row is gone; a screen then prints the id. */
    tenantName: z.string().nullable(),
    audience: z.enum(["STAFF", "CLIENT_PORTAL"]).nullable(),
    /** Null until an org is chosen — a session can belong to several firms. */
    role: z.string().nullable(),
    commercialVisibility: z.boolean().nullable(),
    portalScope: z
      .array(z.object({ clientPartyId: z.string().uuid(), clientName: z.string() }))
      .nullable()
      .openapi({
        description:
          "For a CLIENT_PORTAL session: the companies this login may read TODAY, by name — " +
          "gate 4's answer, resolved once here rather than looked up per screen. NULL for a " +
          "staff session, which is not scoped this way at all, and an EMPTY ARRAY for a " +
          "portal contact who has been invited and granted nothing. Those two are different " +
          "facts and the portal must not render them the same way: null is 'this question " +
          "does not apply', empty is 'nothing yet, ask the firm'.",
      }),
    /** What this caller HOLDS; the full vocabulary is GET /api/v1/config/permissions (config:read). */
    permissions: z.array(z.string()),
    hasPassword: z.boolean().openapi({
      description:
        "Whether this account has a password at all — NOT what it is, when it was set, or " +
        "how. False is the ordinary state for most colleagues at a firm: adding somebody " +
        "sends them a welcome link and never a password, and they have signed in with " +
        "emailed links ever since. The account screen reads this to decide which of two " +
        "things to offer, because the change form refuses an account with no password to " +
        "change (the first one is set through the emailed reset link, where reading the " +
        "mailbox stands in for the password that does not exist yet) and a screen that " +
        "guessed would be discovering its own state from a 409.",
    }),
  })
  .openapi("Principal");

const MembershipSummarySchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    /** The firm's name: this list is the org switcher's choice. */
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

/** `.max(MAX_PASSWORD_LENGTH)` is not cosmetic: sign-in is anonymous and scrypt is memory-hard,
 *  so an unbounded string is unbounded server work. No longer password can have been set. */
const LoginBody = z
  .object({
    email: z.string().email().max(MAX_EMAIL_LENGTH),
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  })
  .openapi("LoginRequest");

const MagicLinkBody = z
  .object({ email: z.string().email().max(MAX_EMAIL_LENGTH) })
  .openapi("MagicLinkRequest");

const RedeemBody = z
  .object({
    token: z.string().min(1).max(MAX_TOKEN_LENGTH),
    password: z
      .string()
      .min(1)
      .max(MAX_PASSWORD_LENGTH)
      .optional()
      .openapi({
        description:
          "A colleague's FIRST password, chosen on their welcome link (CA#38). Only a " +
          "welcome link takes one, and only for an account with no password: the same " +
          "call sets it and signs them in. Left out, the link only signs them in. An " +
          "account that already has a password is refused (409 PASSWORD_ALREADY_SET) and " +
          "the link is NOT spent, so it can still be used without one.",
      }),
  })
  .openapi("RedeemMagicLinkRequest");

const SwitchTenantBody = z
  .object({ tenantId: z.string().uuid() })
  .openapi("SwitchTenantRequest");

const SetPasswordBody = z
  .object({ password: z.string().min(1).max(MAX_PASSWORD_LENGTH) })
  .openapi("SetPasswordRequest");

// `.max(MAX_PASSWORD_LENGTH)` on every password field below: see `LoginBody`.
const PasswordResetBody = z
  .object({ email: z.string().email().max(MAX_EMAIL_LENGTH) })
  .openapi("PasswordResetRequest");

const PasswordResetConfirmBody = z
  .object({
    token: z.string().min(1).max(MAX_TOKEN_LENGTH),
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  })
  .openapi("PasswordResetConfirmRequest");

const ChangePasswordBody = z
  .object({
    currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH).openapi({
      description:
        "The password on the account NOW, and it is required rather than inferred from the " +
        "session. A session is a bearer credential: one that could mint a new password " +
        "would outlive every revocation the firm has, which is the one property " +
        "server-side sessions exist to provide. An account with no password yet is " +
        "refused here and sets its first through the emailed reset link.",
    }),
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  })
  .openapi("ChangePasswordRequest");

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
    400: errorResponse("Request failed validation, or the password is too short or too long"),
    401: errorResponse("The link is unknown, expired, or already used"),
    403: errorResponse("No active membership"),
    409: errorResponse("A password was sent and the account already has one (the link is not spent)"),
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

const passwordResetRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/password-reset",
  tags: ["auth"],
  summary: "Email a link that replaces a forgotten password",
  description:
    "Always answers 202, whether or not the address has an account, whether or not that " +
    "account already has a password, and whether or not the letter actually went — the " +
    "endpoint must not reveal who banks with the firm, and a 500 on the send path would be " +
    "an enumeration oracle built out of an error. Issuing a link SPENDS every live one for " +
    "that account, so nobody is ever left with two password setters in one inbox. The link " +
    "is single-use, expires in thirty minutes, is stored only as a digest, and cannot be " +
    "spent at the sign-in route: redeeming it opens a session only as a consequence of the " +
    "password being replaced, never on its own.",
  request: {
    body: { content: { "application/json": { schema: PasswordResetBody } }, required: true },
  },
  responses: {
    202: {
      description: "Accepted; a link is sent if the address has an active account",
      content: { "application/json": { schema: z.object({ status: z.literal("accepted") }) } },
    },
    400: errorResponse("Request failed validation"),
  },
});

const passwordResetConfirmRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/password-reset/confirm",
  tags: ["auth"],
  summary: "Set a new password from a reset link, and sign in",
  description:
    "PUBLIC, because somebody who has forgotten their password has no session and this is " +
    "how they get one back. The token travels in the BODY, not the path — a path lands in " +
    "access logs and Referer headers, and this one is a credential until it is spent. " +
    "Replacing the password and opening the session are ONE call for the reason the " +
    "invitation route gives: a route that only set the password would leave somebody " +
    "holding a spent token and a login screen. Every session the account held is revoked " +
    "first, so a reset prompted by 'somebody else has my password' actually ends that " +
    "person's access. Malformed, unknown, expired, already-used and wrong-purpose all " +
    "answer identically.",
  request: {
    body: {
      content: { "application/json": { schema: PasswordResetConfirmBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "The password is replaced and a new session is open",
      content: { "application/json": { schema: SignInSchema } },
    },
    400: errorResponse("The password is too short or too long"),
    401: errorResponse("The link is unknown, expired, already used, or not a reset link"),
    403: errorResponse("No active membership"),
  },
});

const changePasswordRoute = createRoute({
  method: "post",
  path: "/api/v1/auth/password",
  tags: ["auth"],
  summary: "Change your own password",
  description:
    "The CURRENT password is required and the session does not stand in for it: a session " +
    "that could mint a new password would survive every revocation the firm has, which is " +
    "the one property server-side sessions exist to provide. An account that has no " +
    "password yet — the ordinary state for most colleagues, who were added with a welcome " +
    "link and have signed in with emailed links ever since — is answered 409 and sets its " +
    "first through POST /api/v1/auth/password-reset, where reading the mailbox is what " +
    "stands in. Setting the same password back is refused; the reset route does not refuse " +
    "it, because the person holding a reset link is by definition the one who does not " +
    "know what the old one was. On success every other session of this account is revoked " +
    "and a NEW cookie is issued, pointed back at the same firm, so the tab making the " +
    "request stays signed in and nothing else does.",
  request: {
    body: { content: { "application/json": { schema: ChangePasswordBody } }, required: true },
  },
  responses: {
    200: {
      description: "The password is changed; the cookie carries the replacement session",
      content: { "application/json": { schema: SignInSchema } },
    },
    400: errorResponse("The new password fails the length policy, or is the current one"),
    401: errorResponse("No authenticated session, or the current password is wrong"),
    409: errorResponse("This account has no password yet — use the emailed reset link"),
    429: errorResponse("Too many attempts at the current password — wait, and try again"),
  },
});

const setPasswordRoute = createRoute({
  method: "put",
  path: "/internal/v1/users/{userId}/password",
  tags: ["auth"],
  summary: "Set a user's password (platform surface)",
  description:
    "Provisioning, not app-facing: it requires the platform key like everything under " +
    "/internal, and every existing session of that user is revoked. It is no longer the " +
    "only way a credential is written — since 0082 a person sets their own through " +
    "POST /api/v1/auth/password-reset (forgotten, proved by the mailbox) or " +
    "POST /api/v1/auth/password (known, proved by the old one). This one remains for " +
    "PROVISIONING, where the platform is standing up an account rather than a person " +
    "changing their own.",
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

  /** Sets the session cookie; maxAge mirrors the session's TTL. */
  const issue = (c: Parameters<Parameters<typeof app.openapi>[1]>[0], result: SignInResult): void => {
    setCookie(c, deps.cookieName, result.token, {
      httpOnly: true,
      secure: deps.cookieSecure,
      sameSite: deps.cookieSameSite,
      path: "/",
      maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
    });
  };

  /** The wire shape of a principal, field by field: a mapper fails to compile on drift, a
   *  pass-through drifts silently. */
  const principalBody = async (
    principal: Principal,
  ): Promise<z.infer<typeof PrincipalSchema>> => {
    // Names only when a firm is chosen; portal scope only for a portal session with a firm.
    // Every lookup runs on every screen load, so a known-null answer is not queried.
    const [names, account, portalScope, hasPassword] = await Promise.all([
      principal.tenantId === null
        ? Promise.resolve(null)
        : deps.tenancy.tenantNames([principal.tenantId]),
      deps.tenancy.account(principal.userId),
      principal.tenantId !== null && principal.audience === "CLIENT_PORTAL"
        ? deps.portalAccess.scopedClientsForUser(principal.tenantId, principal.userId)
        : Promise.resolve(null),
      deps.service.hasPassword(principal.userId),
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
      // Null and [] differ (see the schema); spread because the service list is readonly.
      portalScope: portalScope === null ? null : [...portalScope],
      hasPassword,
    };
  };

  const signInBody = async (result: SignInResult): Promise<z.infer<typeof SignInSchema>> => {
    // One lookup for the whole list, not one per membership.
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
    // The rate limiter's caller key: wrong guesses spend the guesser's budget, not lock out
    // the account owner.
    const result = await deps.service.login(email, password, c.get("clientKey"));
    issue(c, result);
    return c.json(await signInBody(result), 200);
  });

  app.openapi(magicLinkRoute, async (c) => {
    const { email } = c.req.valid("json");
    await deps.service.requestMagicLink(email);
    return c.json({ status: "accepted" as const }, 202);
  });

  app.openapi(redeemRoute, async (c) => {
    const { token, password } = c.req.valid("json");
    const result =
      password === undefined
        ? await deps.service.redeemMagicLink(token)
        : await deps.service.redeemWelcome(token, password);
    issue(c, result);
    return c.json(await signInBody(result), 200);
  });

  // The guard already refused an anonymous caller; the null branch beats a lying cast.
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
    // Rebuilt after the switch: role and permissions belong to the new firm's membership.
    return c.json(await principalBody(switched), 200);
  });

  app.openapi(logoutRoute, async (c) => {
    const token = tokenFrom((name) => c.req.header(name), deps.cookieName);
    if (token !== null) await deps.service.logout(token);
    // Clear the cookie whatever happened.
    setCookie(c, deps.cookieName, "", {
      httpOnly: true,
      secure: deps.cookieSecure,
      sameSite: deps.cookieSameSite,
      path: "/",
      maxAge: 0,
    });
    return c.body(null, 204);
  });

  app.openapi(passwordResetRoute, async (c) => {
    const { email } = c.req.valid("json");
    // No branching: the service swallows unknown address, deactivated account, spent budget
    // and failed send alike.
    await deps.service.requestPasswordReset(email);
    return c.json({ status: "accepted" as const }, 202);
  });

  app.openapi(passwordResetConfirmRoute, async (c) => {
    const { token, password } = c.req.valid("json");
    const result = await deps.service.resetPassword(token, password);
    // `setPassword` revoked every old session; this is the replacement.
    issue(c, result);
    return c.json(await signInBody(result), 200);
  });

  app.openapi(changePasswordRoute, async (c) => {
    const principal = c.get("principal");
    if (!principal) return c.json(unauthorized("no authenticated session"), 401);
    const { currentPassword, password } = c.req.valid("json");
    const result = await deps.service.changePassword(
      principal.userId,
      currentPassword,
      password,
      // Land the new session at the same firm; the service re-checks membership and standing.
      principal.tenantId,
    );
    issue(c, result);
    return c.json(await signInBody(result), 200);
  });

  app.openapi(setPasswordRoute, async (c) => {
    const { userId } = c.req.valid("param");
    const { password } = c.req.valid("json");
    await deps.service.setPassword(userId, password);
    return c.body(null, 204);
  });
}
