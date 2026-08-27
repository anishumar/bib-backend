// Tenancy HTTP surface — transport only. Each route below declares its wire
// shape (the `z` schemas ARE the DTOs and the OpenAPI spec at once), and each
// handler parses the validated input, calls exactly one use-case method, and
// maps the result. No business rule lives here; anything you are tempted to
// branch on belongs in the service. Errors thrown by the service propagate to
// the router's onError — one place maps and logs them, so nothing is swallowed.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z, errorResponse } from "../openapi";
import type { TenancyService } from "../../usecase/tenancy/service";
import type { Principal } from "../../platform/callctx";
import { toEnvelope } from "../httpresp";

/** Resolves the authenticated principal from request headers. A driving port:
 *  the dev adapter reads a header; a real session/SSO adapter (ADR-03) drops in
 *  here later without touching this layer. */
export type PrincipalResolver = (getHeader: (name: string) => string | undefined) => Principal | null;

/** What the route registrar needs. The service is the one collaborator the
 *  handlers call; the principal resolver is injected so this layer never knows
 *  whether identity came from a header, a cookie, or an SSO round-trip. */
export interface TenancyDeps {
  readonly service: TenancyService;
  readonly principalOf: PrincipalResolver;
}

// ── Response schemas (describe the shapes the service returns) ──────────────

const TenantSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    status: z.enum(["active", "suspended"]),
  })
  .openapi("Tenant");

const UserAccountSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
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

// ── Request schemas (DTOs) ──────────────────────────────────────────────────

const CreateTenantRequest = z
  .object({ name: z.string().min(1), slug: z.string().min(1) })
  .openapi("CreateTenantRequest");

const RegisterUserRequest = z
  .object({ email: z.string().email() })
  .openapi("RegisterUserRequest");

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
    409: errorResponse("Slug already taken"),
  },
});

const registerUserRoute = createRoute({
  method: "post",
  path: "/api/v1/tenancy/users",
  tags: ["tenancy"],
  summary: "Register a user (global identity)",
  description: "Idempotent by email (ADR-02): an existing email links, never duplicates.",
  request: {
    body: { content: { "application/json": { schema: RegisterUserRequest } }, required: true },
  },
  responses: {
    201: { description: "User ensured", content: { "application/json": { schema: UserAccountSchema } } },
    400: errorResponse("Request failed validation"),
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
    404: errorResponse("Tenant or user not found"),
  },
});

const myMembershipsRoute = createRoute({
  method: "get",
  path: "/api/v1/tenancy/me/memberships",
  tags: ["tenancy"],
  summary: "List the caller's active memberships (org switcher)",
  request: {
    headers: z.object({
      "x-user-id": z
        .string()
        .uuid()
        .optional()
        .openapi({ description: "Dev principal (until the SSO adapter, ADR-03, lands)" }),
    }),
  },
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
export function registerTenancyRoutes(app: OpenAPIHono, deps: TenancyDeps): void {
  app.openapi(createTenantRoute, async (c) => {
    const input = c.req.valid("json");
    const tenant = await deps.service.createTenant(input);
    return c.json(tenant, 201);
  });

  app.openapi(registerUserRoute, async (c) => {
    const input = c.req.valid("json");
    const user = await deps.service.ensureUser(input.email);
    return c.json(user, 201);
  });

  app.openapi(addMemberRoute, async (c) => {
    const input = c.req.valid("json");
    const membership = await deps.service.addMember(input);
    return c.json(membership, 201);
  });

  app.openapi(myMembershipsRoute, async (c) => {
    const principal = deps.principalOf((name) => c.req.header(name));
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
} as const;
