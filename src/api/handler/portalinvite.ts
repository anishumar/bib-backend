// The portal invitation over HTTP (T6.5) — transport only.
//
// TWO ROUTES ON OPPOSITE SIDES OF THE WALL, and that is the whole shape of this
// file. One is the FIRM inviting somebody, behind `portal:grant`. The other is
// the person who was invited, who has no session at all and is about to get
// their first — the fifth PUBLIC_PATH in this product, argued below.
import { createRoute } from "@hono/zod-openapi";
import { setCookie } from "hono/cookie";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import type { PortalInviteService } from "../../usecase/portalinvite/service";
import type { IdentityService, SignInResult } from "../../usecase/identity/service";
import { scopeOf } from "../scope";
import { MAX_PASSWORD_LENGTH, SESSION_TTL_DAYS } from "../../domain/identity/model";
import { MAX_TOKEN_LENGTH } from "../bounds";

export interface PortalInviteDeps {
  readonly service: PortalInviteService;
  /** Accepting is an IDENTITY act — set a password, open a session — and goes
   *  straight to that service. Routing it through the invite use case would put
   *  a use case between a handler and the thing it actually does. */
  readonly identity: IdentityService;
  readonly cookieName: string;
  readonly cookieSecure: boolean;
}

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const InvitePortalContactRequest = z
  .object({
    email: z.string().email(),
    displayName: z.string().min(1).optional().openapi({
      description:
        "What their firm calls them. Applied only when the ACCOUNT IS NEW — one firm " +
        "inviting somebody is not grounds for renaming them at another, and the same human " +
        "may hold a portal login at two.",
    }),
    clientPartyId: z.string().uuid().openapi({
      description:
        "The ONE company this contact may read. Required, because an invite with no grant is " +
        "a login that opens onto nothing — and the contact cannot tell that from a broken " +
        "product. Somebody who should see four of a group's companies is granted the other " +
        "three afterwards, one visible decision each.",
    }),
    validFrom: IsoDate.optional().openapi({
      description: "The day the grant starts — send the BROWSER's calendar day.",
    }),
  })
  .openapi("InvitePortalContactRequest");

const PortalInvitationSchema = z
  .object({
    membershipId: z.string().uuid(),
    userId: z.string().uuid(),
    grantId: z.string().uuid(),
    expiresAt: z.string().datetime().openapi({
      description:
        "When the emailed link stops working. THE TOKEN IS NOT HERE and never will be: a " +
        "firm that could read its client's invite link could sign in as that client. It " +
        "exists in the mail and nowhere else.",
    }),
  })
  .openapi("PortalInvitation");

const AcceptPortalInviteRequest = z
  .object({
    token: z.string().min(1).max(MAX_TOKEN_LENGTH).openapi({
      description:
        "The single-use token from the emailed link, sent in the BODY. Never in the path: a " +
        "path lands in access logs and Referer headers, and this one is a credential until " +
        "it is spent — the same rule the proposal share link follows.",
    }),
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH).openapi({
      description:
        "The password being SET, not one being checked. Refused before the token is spent if " +
        "it is too short, so somebody who typed something weak can try again with the same " +
        "link rather than going back to the firm.",
    }),
  })
  .openapi("AcceptPortalInviteRequest");

const inviteRoute = createRoute({
  method: "post",
  path: "/api/v1/portal-invites",
  tags: ["portal"],
  summary: "Invite one of a client's own people into the portal",
  description:
    "ONE act, three writes: the account, a CLIENT_PORTAL membership, and gate 4's grant for " +
    "ONE company — then the letter. Left as three calls every halfway state is silent and " +
    "bad, the worst being a membership with no grant: the contact signs in to a portal that " +
    "shows nothing and cannot tell that from a broken product. The firm never sees the " +
    "token; it never holds its client's password.",
  request: {
    body: { content: { "application/json": { schema: InvitePortalContactRequest } }, required: true },
  },
  responses: {
    201: {
      description: "Invited, and the letter is on its way",
      content: { "application/json": { schema: PortalInvitationSchema } },
    },
    400: errorResponse("Not a valid email, or a role the firm has not published"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not grant access"),
    404: errorResponse("No such client at this firm"),
    409: errorResponse("This person already holds a portal login here, or the client is archived"),
  },
});

const ResendParam = z.object({
  membershipId: z.string().uuid().openapi({
    param: { name: "membershipId", in: "path" },
    description:
      "WHO is re-invited, and the only thing this route accepts. There is no address in the " +
      "body and there will not be one: the letter goes to the account's own email. Moving a " +
      "contact's portal access to a different mailbox is a different act.",
  }),
});

const ResentInvitationSchema = z
  .object({
    membershipId: z.string().uuid(),
    userId: z.string().uuid(),
    expiresAt: z.string().datetime().openapi({
      description:
        "When the NEW link stops working. The token is not here, for the same reason it is " +
        "not on the first invitation: a firm that could read its client's link could sign in " +
        "as that client.",
    }),
  })
  .openapi("ResentPortalInvitation");

const resendRoute = createRoute({
  method: "post",
  path: "/api/v1/portal-invites/{membershipId}/resend",
  tags: ["portal"],
  summary: "Send a client contact their portal invitation again",
  description:
    "SAME PERSON, SAME ADDRESS — the letter goes to the email already on the account and no " +
    "parameter can change it. This exists because the first send can fail once a real relay " +
    "carries it (a bounce, a typo, a full mailbox), and the contact is then created, granted " +
    "and — before this route — permanently uninvitable: staff can ask the sign-in page for a " +
    "fresh link, a client contact who has never set a password has no other door. Issuing a " +
    "new link SPENDS every live one, so nobody ever holds two password setters at once. " +
    "Refused once they have set a password: at that point re-issuing would be the firm " +
    "resetting its own client's password, which is what the invite flow exists to prevent. " +
    "Throttled per contact, because the cost of getting it wrong lands on their inbox.",
  request: { params: ResendParam },
  responses: {
    200: {
      description: "The letter has gone again",
      content: { "application/json": { schema: ResentInvitationSchema } },
    },
    401: errorResponse("No authenticated session, or the account cannot be written to"),
    403: errorResponse("The session has not selected an org, or the role may not grant access"),
    404: errorResponse("No such membership at this firm"),
    409: errorResponse(
      "A staff login, a revoked one, or a contact who has already set their password",
    ),
    429: errorResponse("Too many invitations to this contact — wait, and try again"),
  },
});

const acceptRoute = createRoute({
  method: "post",
  path: "/api/v1/portal-invites/accept",
  tags: ["portal"],
  summary: "Set a password and sign in, from an invitation",
  description:
    "PUBLIC, because the person holding this link has no session and this is how they get " +
    "their first. Single-use and expiring; the token travels in the BODY. Setting the " +
    "password and opening the session are ONE call deliberately — a route that only set the " +
    "password would leave somebody holding a spent token and a login screen, and one that " +
    "only signed them in is a magic link that leaves them with no password at all. " +
    "Malformed, unknown, expired, already-used and wrong-purpose all answer the same way, so " +
    "nothing here can be used to discover whether an address has an account.",
  request: {
    body: { content: { "application/json": { schema: AcceptPortalInviteRequest } }, required: true },
  },
  responses: {
    200: {
      description: "The password is set and the session is open",
      content: {
        "application/json": {
          schema: z.object({ ok: z.literal(true) }).openapi("AcceptPortalInviteResponse"),
        },
      },
    },
    400: errorResponse("The password is too short or too long"),
    401: errorResponse("The link is unknown, expired, already used, or not an invitation"),
  },
});

export function registerPortalInviteRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: PortalInviteDeps,
): void {
  app.openapi(inviteRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const invitation = await deps.service.invite(
      {
        tenantId: s.tenantId,
        email: body.email,
        displayName: body.displayName,
        clientPartyId: body.clientPartyId,
        validFrom: body.validFrom,
        invitedBy: s.userId,
      },
      s.actor,
    );
    return c.json(invitation, 201);
  });

  app.openapi(resendRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const resent = await deps.service.resend(
      { tenantId: s.tenantId, membershipId: c.req.valid("param").membershipId },
      s.actor,
    );
    return c.json(resent, 200);
  });

  app.openapi(acceptRoute, async (c) => {
    const { token, password } = c.req.valid("json");
    const result: SignInResult = await deps.identity.acceptPortalInvite(token, password);
    // The session leaves in an httpOnly cookie and never in the body — the rule
    // every other session-opening route here follows, and the reason no script
    // on the portal can read it. Same options as sign-in, including `maxAge`
    // mirroring the session's own TTL, so the browser forgets it at roughly the
    // moment the server stops honouring it.
    setCookie(c, deps.cookieName, result.token, {
      httpOnly: true,
      secure: deps.cookieSecure,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
    });
    return c.json({ ok: true as const }, 200);
  });
}

export const portalInviteRoutes = {
  invite: inviteRoute,
  resend: resendRoute,
  accept: acceptRoute,
} as const;
