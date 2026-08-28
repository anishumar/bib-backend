// Tenancy HTTP surface — transport only. Each route below declares its wire
// shape (the `z` schemas ARE the DTOs and the OpenAPI spec at once), and each
// handler parses the validated input, calls exactly one use-case method, and
// maps the result. No business rule lives here; anything you are tempted to
// branch on belongs in the service. Errors thrown by the service propagate to
// the router's onError — one place maps and logs them, so nothing is swallowed.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import type { TenancyService } from "../../usecase/tenancy/service";
import { toEnvelope } from "../httpresp";
import { scopeOf } from "../scope";

/** What the route registrar needs. The service is the one collaborator the
 *  handlers call; the principal arrives from the session guard through the
 *  request context, so this layer never learns whether identity came from a
 *  cookie, a bearer token, or an SSO round-trip. */
export interface TenancyDeps {
  readonly service: TenancyService;
}

// ── Response schemas (describe the shapes the service returns) ──────────────

const TenantSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    status: z.enum(["active", "suspended"]),
    reportingCurrency: z.string().length(3),
  })
  .openapi("Tenant");

/** Who binds the firm — the "Yours sincerely, …, Director" block on every
 *  letter it sends. Null when the firm has not named anybody. */
const FirmSignatorySchema = z
  .object({
    userId: z.string().uuid(),
    displayName: z.string().nullable().openapi({
      description: "Null when nobody has named the account — show the roster entry instead.",
    }),
    title: z.string(),
  })
  .openapi("FirmSignatory");

const FirmSignatoryResponse = z
  .object({ signatory: FirmSignatorySchema.nullable() })
  .openapi("FirmSignatoryResponse");

const SetFirmSignatoryRequest = z
  .object({
    userId: z.string().uuid(),
    title: z.string().min(1).max(120),
  })
  .openapi("SetFirmSignatoryRequest");

const UserAccountSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    displayName: z.string().nullable(),
    status: z.enum(["active", "disabled"]),
  })
  .openapi("UserAccount");

const MembershipSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    userId: z.string().uuid(),
    audience: z.enum(["STAFF", "CLIENT_PORTAL"]),
    role: z.string(),
    commercialVisibility: z.boolean(),
    isActive: z.boolean(),
  })
  .openapi("Membership");

const MembershipsResponse = z
  .object({ memberships: z.array(MembershipSchema) })
  .openapi("MembershipsResponse");

/** One row of the roster: the membership plus who it belongs to, so a screen
 *  can show people without a lookup per row. */
const MemberSchema = z
  .object({
    membership: MembershipSchema,
    email: z.string().email(),
    displayName: z.string().nullable().openapi({
      description: "Null when nobody has named the account — show the email instead.",
    }),
  })
  .openapi("Member");

const MembersResponse = z.object({ members: z.array(MemberSchema) }).openapi("MembersResponse");

// ── Request schemas (DTOs) ──────────────────────────────────────────────────

// `reportingCurrency` is required, with no default here or at any layer below.
// A firm provisioned without stating what its books are in would be given one
// silently, and the reason this is a column rather than a config row is that it
// can never be corrected afterwards — every FX rate stored later is struck
// against it. The shape is checked properly in the domain; this only turns away
// the obviously-wrong before it reaches a use case.
const CreateTenantRequest = z
  .object({
    name: z.string().min(1),
    slug: z.string().min(1),
    reportingCurrency: z.string().min(1),
  })
  .openapi("CreateTenantRequest");

const RegisterUserRequest = z
  .object({ email: z.string().email() })
  .openapi("RegisterUserRequest");

// The administration DTOs. `audience` and `role` stay free strings on the wire
// for the same reason AddMemberRequest does: the closed audience set is a domain
// rule, and the valid ROLES are this firm's own published config — neither is
// something a static schema can state, and a duplicate list here would be a
// second place to change.
const InviteMemberRequest = z
  .object({
    email: z.string().email(),
    audience: z.string().min(1),
    role: z.string().min(1),
    commercialVisibility: z.boolean().default(false),
    displayName: z.string().min(1).optional().openapi({
      description: "Applied only when this email has no account yet.",
    }),
  })
  .openapi("InviteMemberRequest");

const ChangeMemberRoleRequest = z
  .object({ role: z.string().min(1) })
  .openapi("ChangeMemberRoleRequest");

const SetMemberActiveRequest = z
  .object({
    isActive: z.boolean().openapi({
      description:
        "False revokes access — the person's next request is refused, not their next login.",
    }),
  })
  .openapi("SetMemberActiveRequest");

const MemberParam = z.object({ membershipId: z.string().uuid() });

// `audience` is left a free string on the wire ON PURPOSE: the closed set of
// audiences is a domain rule (AUDIENCES), validated by the service, which
// answers 400 on a bad value. Duplicating that list here would create a second
// place to change it. The DTO checks shape; the domain owns the rule.
const AddMemberRequest = z
  .object({
    tenantId: z.string().uuid(),
    userId: z.string().uuid(),
    audience: z.string().min(1),
    role: z.string().min(1),
    commercialVisibility: z.boolean().default(false),
  })
  .openapi("AddMemberRequest");

// ── Routes ──────────────────────────────────────────────────────────────────

const createTenantRoute = createRoute({
  method: "post",
  path: "/internal/v1/tenants",
  tags: ["tenancy"],
  summary: "Create a tenant (firm)",
  description: "Platform / service-to-service surface — above tenant scope.",
  request: {
    body: { content: { "application/json": { schema: CreateTenantRequest } }, required: true },
  },
  responses: {
    201: { description: "Tenant created", content: { "application/json": { schema: TenantSchema } } },
    400: errorResponse("Request failed validation"),
    401: errorResponse("Missing or wrong platform key"),
    409: errorResponse("Slug already taken"),
  },
});

const registerUserRoute = createRoute({
  method: "post",
  path: "/internal/v1/users",
  tags: ["tenancy"],
  summary: "Register a user (global identity)",
  description:
    "Provisioning: creating a login is not something an anonymous caller may do, so it " +
    "requires the platform key. Idempotent by email (ADR-02): an existing email links, " +
    "never duplicates.",
  request: {
    body: { content: { "application/json": { schema: RegisterUserRequest } }, required: true },
  },
  responses: {
    201: { description: "User ensured", content: { "application/json": { schema: UserAccountSchema } } },
    400: errorResponse("Request failed validation"),
    401: errorResponse("Missing or wrong platform key"),
  },
});

const addMemberRoute = createRoute({
  method: "post",
  path: "/internal/v1/memberships",
  tags: ["tenancy"],
  summary: "Grant a user access to a tenant",
  description: "Platform / service-to-service surface. Audience + role + fee visibility.",
  request: {
    body: { content: { "application/json": { schema: AddMemberRequest } }, required: true },
  },
  responses: {
    201: { description: "Membership granted", content: { "application/json": { schema: MembershipSchema } } },
    400: errorResponse("Request failed validation, or unknown audience"),
    401: errorResponse("Missing or wrong platform key"),
    404: errorResponse("Tenant or user not found"),
  },
});

// ── Firm administration ─────────────────────────────────────────────────────
//
// The product surface for a firm running itself: who works here, what they may
// do, and whether they still have access. Everything above this line on
// /internal is the PLATFORM creating firms; everything here is a partner with a
// session doing it themselves.
//
// All four require `tenant:admin`. Reading the roster is admin-only for now
// because it lists colleagues' email addresses — a general "who works here"
// directory is a wider decision for whichever screen first needs one.

const listMembersRoute = createRoute({
  method: "get",
  path: "/api/v1/tenancy/members",
  tags: ["tenancy"],
  summary: "The firm's roster, deactivated people included",
  responses: {
    200: { description: "Members", content: { "application/json": { schema: MembersResponse } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
  },
});

const inviteMemberRoute = createRoute({
  method: "post",
  path: "/api/v1/tenancy/members",
  tags: ["tenancy"],
  summary: "Give somebody access to this firm, by email",
  description:
    "Idempotent on identity (ADR-02): an email that already has an account links to that " +
    "person rather than creating a second one. No email is sent — they sign in with a magic link.",
  request: {
    body: { content: { "application/json": { schema: InviteMemberRequest } }, required: true },
  },
  responses: {
    201: { description: "Access granted", content: { "application/json": { schema: MembershipSchema } } },
    400: errorResponse("Request failed validation, or unknown audience"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    409: errorResponse("They already have access, or the role is not one this firm publishes"),
  },
});

const changeMemberRoleRoute = createRoute({
  method: "put",
  path: "/api/v1/tenancy/members/{membershipId}/role",
  tags: ["tenancy"],
  summary: "Change what a member may do",
  request: {
    params: MemberParam,
    body: { content: { "application/json": { schema: ChangeMemberRoleRequest } }, required: true },
  },
  responses: {
    200: {
      description: "Role changed. Idempotent — setting the role they hold records nothing.",
      content: { "application/json": { schema: MembershipSchema } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("No such membership at this firm"),
    409: errorResponse("The role is not one this firm publishes, or this would leave no administrator"),
  },
});

const setMemberActiveRoute = createRoute({
  method: "put",
  path: "/api/v1/tenancy/members/{membershipId}/active",
  tags: ["tenancy"],
  summary: "Revoke a member's access, or give it back",
  description:
    "Takes effect on their NEXT REQUEST, not at token expiry: the session resolver re-reads " +
    "the membership every time. A firm that dismisses somebody can stop their access now.",
  request: {
    params: MemberParam,
    body: { content: { "application/json": { schema: SetMemberActiveRequest } }, required: true },
  },
  responses: {
    200: { description: "Access changed", content: { "application/json": { schema: MembershipSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("No such membership at this firm"),
    409: errorResponse("This would leave the firm with no administrator"),
  },
});

// ── Who binds the firm ──────────────────────────────────────────────────────
//
// One signatory for the whole firm, whichever of its entities issues the
// document — "unki ek hi signature rahegi". These two routes are the only
// reason it is a row rather than a constant: a rule nobody can change is a
// hardcode with extra steps, and a successor should be an UPDATE.
//
// The split matches the firm-entity rule (G1.2), for the same reason. READING
// is `config:read` — an associate drafting a letter should be able to see whose
// signature will be on it. WRITING is `tenant:admin`, because naming who binds
// the firm is a decision at the same level as deciding what a role means.

const firmSignatoryRoute = createRoute({
  method: "get",
  path: "/api/v1/tenancy/firm-signatory",
  tags: ["tenancy"],
  summary: "Who signs this firm's engagement letters",
  description:
    "Snapshotted onto each letter when it is SENT, so changing it here never restates a " +
    "letter already issued. Null means the firm has not named anybody and its letters go " +
    "out with no signature block.",
  responses: {
    200: {
      description: "The standing signatory, or null",
      content: { "application/json": { schema: FirmSignatoryResponse } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role does not permit it"),
  },
});

const setFirmSignatoryRoute = createRoute({
  method: "put",
  path: "/api/v1/tenancy/firm-signatory",
  tags: ["tenancy"],
  summary: "Name who binds the firm",
  description:
    "The person must have an active STAFF membership here: authority to bind the firm is the " +
    "strongest thing anyone holds in this product, and `tenancy.user_account` is global, so " +
    "no foreign key can say it. Letters already sent keep the block they went out with.",
  request: {
    body: { content: { "application/json": { schema: SetFirmSignatoryRequest } }, required: true },
  },
  responses: {
    200: { description: "Named", content: { "application/json": { schema: FirmSignatorySchema } } },
    400: errorResponse("Request failed validation"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("That person has no active staff membership at this firm"),
  },
});

const myMembershipsRoute = createRoute({
  method: "get",
  path: "/api/v1/tenancy/me/memberships",
  tags: ["tenancy"],
  summary: "List the caller's active memberships (org switcher)",
  responses: {
    200: { description: "Active memberships", content: { "application/json": { schema: MembershipsResponse } } },
    401: errorResponse("No authenticated principal"),
  },
});

// ── Registration ──────────────────────────────────────────────────────────

/** Mount every tenancy route on the app. Inline handlers give the framework
 *  the tightest possible type link between a route's schema and its handler:
 *  `c.req.valid("json")` is typed from the route, and the returned status +
 *  body are checked against the declared responses. */
export function registerTenancyRoutes(app: OpenAPIHono<AppEnv>, deps: TenancyDeps): void {
  app.openapi(createTenantRoute, async (c) => {
    const input = c.req.valid("json");
    const tenant = await deps.service.createTenant({
      ...input,
      provisionedBy: c.get("internalClient")?.name,
    });
    // Mapped field by field rather than returned whole. Forwarding the domain
    // object is how /auth/me shipped two fields the spec never described for six
    // tasks, and a frontend generated from that spec cannot see them.
    return c.json(
      {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        status: tenant.status,
        reportingCurrency: tenant.reportingCurrency,
      },
      201,
    );
  });

  app.openapi(registerUserRoute, async (c) => {
    const input = c.req.valid("json");
    const user = await deps.service.ensureUser(input.email);
    return c.json(user, 201);
  });

  app.openapi(addMemberRoute, async (c) => {
    const input = c.req.valid("json");
    const membership = await deps.service.addMember({
      ...input,
      provisionedBy: c.get("internalClient")?.name,
    });
    return c.json(membership, 201);
  });

  // ── Firm administration. The tenant comes from the SESSION, so an admin can
  // only ever administer the firm they are acting for.
  app.openapi(listMembersRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const members = await deps.service.listMembers(s.tenantId);
    return c.json({ members: [...members] }, 200);
  });

  app.openapi(inviteMemberRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const membership = await deps.service.inviteMember({ tenantId: s.tenantId, ...body }, s.actor);
    return c.json(membership, 201);
  });

  app.openapi(changeMemberRoleRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { membershipId } = c.req.valid("param");
    const { role } = c.req.valid("json");
    const membership = await deps.service.changeMemberRole(
      { tenantId: s.tenantId, membershipId, role },
      s.actor,
    );
    return c.json(membership, 200);
  });

  app.openapi(setMemberActiveRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { membershipId } = c.req.valid("param");
    const { isActive } = c.req.valid("json");
    const membership = await deps.service.setMemberActive(
      { tenantId: s.tenantId, membershipId, isActive },
      s.actor,
    );
    return c.json(membership, 200);
  });

  app.openapi(firmSignatoryRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const signatory = await deps.service.firmSignatory(s.tenantId);
    return c.json({ signatory: signatory === null ? null : { ...signatory } }, 200);
  });

  app.openapi(setFirmSignatoryRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { userId, title } = c.req.valid("json");
    const signatory = await deps.service.setFirmSignatory(
      { tenantId: s.tenantId, userId, title },
      s.actor,
    );
    return c.json(
      { userId: signatory.userId, displayName: signatory.displayName, title: signatory.title },
      200,
    );
  });

  app.openapi(myMembershipsRoute, async (c) => {
    const principal = c.get("principal");
    if (!principal) {
      return c.json(
        toEnvelope({ status: 401, code: "UNAUTHORIZED", message: "no authenticated user" }),
        401,
      );
    }
    const memberships = await deps.service.resolveAccess(principal.userId);
    return c.json({ memberships: [...memberships] }, 200);
  });
}

// Exported so a test can assert the spec (paths, methods) without booting a
// server — the routes are the contract.
export const tenancyRoutes = {
  createTenant: createTenantRoute,
  registerUser: registerUserRoute,
  addMember: addMemberRoute,
  myMemberships: myMembershipsRoute,
  listMembers: listMembersRoute,
  inviteMember: inviteMemberRoute,
  changeMemberRole: changeMemberRoleRoute,
  setMemberActive: setMemberActiveRoute,
  firmSignatory: firmSignatoryRoute,
  setFirmSignatory: setFirmSignatoryRoute,
} as const;
