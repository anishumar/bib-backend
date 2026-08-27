// Party HTTP surface — transport only. Each route declares its wire shape (the
// zod schemas ARE the DTOs and the OpenAPI spec) and its handler parses the
// validated input, calls exactly one use-case method, and maps the result.
//
// These live on the /internal surface with tenantId as a path param, matching
// the tenancy precedent: resolving WHICH tenant a request is for from the
// authenticated principal is T1.6/T1.7 (RBAC + real session adapter). When that
// lands, an app-facing wrapper supplies tenantId from the membership instead of
// the path — the service already takes tenantId as a parameter, so nothing
// inward changes.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z, errorResponse } from "../openapi";
import type { PartyService } from "../../usecase/party/service";

export interface PartyDeps {
  readonly service: PartyService;
}

// ── Response schemas ────────────────────────────────────────────────────────

const PartySchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    kind: z.enum(["organization", "person"]),
    displayName: z.string(),
  })
  .openapi("Party");

const OrganizationSchema = z
  .object({
    partyId: z.string().uuid(),
    tenantId: z.string().uuid(),
    legalName: z.string(),
    tradeName: z.string().nullable(),
    industry: z.string().nullable(),
    website: z.string().nullable(),
    isFirmSelf: z.boolean(),
  })
  .openapi("Organization");

const PersonSchema = z
  .object({
    partyId: z.string().uuid(),
    tenantId: z.string().uuid(),
    fullName: z.string(),
    nationality: z.string().nullable(),
    dateOfBirth: z.string().nullable(),
  })
  .openapi("Person");

const LegalEntitySchema = z
  .object({
    partyId: z.string().uuid(),
    tenantId: z.string().uuid(),
    jurisdiction: z.string(),
    entityType: z.string(),
    incorporatedOn: z.string().nullable(),
    financialYearEnd: z.string().nullable(),
    registeredAddress: z.record(z.unknown()).nullable(),
    status: z.enum(["active", "dormant", "under_strike_off", "struck_off", "dissolved"]),
  })
  .openapi("LegalEntity");

const IdentifierSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    partyId: z.string().uuid(),
    type: z.string(),
    value: z.string(),
    jurisdiction: z.string().nullable(),
    isPrimary: z.boolean(),
    validFrom: z.string(),
    validTo: z.string().nullable(),
  })
  .openapi("PartyIdentifier");

const RelationshipSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    fromPartyId: z.string().uuid(),
    toPartyId: z.string().uuid(),
    type: z.string(),
    validFrom: z.string(),
    validTo: z.string().nullable(),
    attributes: z.record(z.unknown()),
  })
  .openapi("PartyRelationship");

const PartyProfileSchema = z
  .object({
    party: PartySchema,
    identifiers: z.array(IdentifierSchema),
    relationships: z.array(RelationshipSchema),
  })
  .openapi("PartyProfile");

// ── Request schemas ──────────────────────────────────────────────────────────

const TenantParam = z.object({ tenantId: z.string().uuid() });
const TenantPartyParam = z.object({ tenantId: z.string().uuid(), partyId: z.string().uuid() });

// The closed identifier set lives in the domain; the DTO checks shape, the
// service normalises and shape-validates, and the DB CHECK is the backstop.
const IdentifierTypeSchema = z.enum([
  "pan", "gstin", "cin", "llpin", "tan", "din",
  "uen", "trn", "ein", "crn",
  "vat", "passport", "email", "phone", "other",
]);

const CreateOrganizationBody = z
  .object({
    legalName: z.string().min(1),
    tradeName: z.string().min(1).optional(),
    industry: z.string().min(1).optional(),
    website: z.string().min(1).optional(),
  })
  .openapi("CreateOrganizationRequest");

const CreatePersonBody = z
  .object({
    fullName: z.string().min(1),
    nationality: z.string().min(1).optional(),
    dateOfBirth: z.string().date().optional(),
  })
  .openapi("CreatePersonRequest");

const RegisterLegalEntityBody = z
  .object({
    jurisdiction: z.string().min(1),
    entityType: z.string().min(1),
    incorporatedOn: z.string().date().optional(),
    financialYearEnd: z.string().optional(),
    registeredAddress: z.record(z.unknown()).optional(),
  })
  .openapi("RegisterLegalEntityRequest");

const AddIdentifierBody = z
  .object({
    type: IdentifierTypeSchema,
    value: z.string().min(1),
    jurisdiction: z.string().min(1).optional(),
    isPrimary: z.boolean().optional(),
    validFrom: z.string().date(),
    validTo: z.string().date().optional(),
  })
  .openapi("AddIdentifierRequest");

const AddRelationshipBody = z
  .object({
    fromPartyId: z.string().uuid(),
    toPartyId: z.string().uuid(),
    // Free string on the wire on purpose: the valid set is core.relationship_type,
    // checked by the service. The DTO does not duplicate that lookup.
    type: z.string().min(1),
    validFrom: z.string().date(),
    validTo: z.string().date().optional(),
    attributes: z.record(z.unknown()).optional(),
  })
  .openapi("AddRelationshipRequest");

// ── Routes ────────────────────────────────────────────────────────────────

const createOrganizationRoute = createRoute({
  method: "post",
  path: "/internal/v1/tenants/{tenantId}/organizations",
  tags: ["party"],
  summary: "Create an organization party",
  request: {
    params: TenantParam,
    body: { content: { "application/json": { schema: CreateOrganizationBody } }, required: true },
  },
  responses: {
    201: { description: "Organization created", content: { "application/json": { schema: OrganizationSchema } } },
    400: errorResponse("Request failed validation"),
  },
});

const createPersonRoute = createRoute({
  method: "post",
  path: "/internal/v1/tenants/{tenantId}/persons",
  tags: ["party"],
  summary: "Create a person party",
  request: {
    params: TenantParam,
    body: { content: { "application/json": { schema: CreatePersonBody } }, required: true },
  },
  responses: {
    201: { description: "Person created", content: { "application/json": { schema: PersonSchema } } },
    400: errorResponse("Request failed validation"),
  },
});

const registerLegalEntityRoute = createRoute({
  method: "post",
  path: "/internal/v1/tenants/{tenantId}/organizations/{partyId}/legal-entities",
  tags: ["party"],
  summary: "Register a legal entity against an organization",
  request: {
    params: TenantPartyParam,
    body: { content: { "application/json": { schema: RegisterLegalEntityBody } }, required: true },
  },
  responses: {
    201: { description: "Legal entity registered", content: { "application/json": { schema: LegalEntitySchema } } },
    400: errorResponse("Request failed validation, or party is not an organization"),
    404: errorResponse("Organization not found"),
  },
});

const addIdentifierRoute = createRoute({
  method: "post",
  path: "/internal/v1/tenants/{tenantId}/parties/{partyId}/identifiers",
  tags: ["party"],
  summary: "Attach an identifier (PAN, GSTIN, email…) to a party",
  request: {
    params: TenantPartyParam,
    body: { content: { "application/json": { schema: AddIdentifierBody } }, required: true },
  },
  responses: {
    201: { description: "Identifier added", content: { "application/json": { schema: IdentifierSchema } } },
    400: errorResponse("Invalid identifier or date range"),
    404: errorResponse("Party not found"),
    409: errorResponse("Identifier already exists for this tenant"),
  },
});

const addRelationshipRoute = createRoute({
  method: "post",
  path: "/internal/v1/tenants/{tenantId}/relationships",
  tags: ["party"],
  summary: "Record an effective-dated relationship between two parties",
  request: {
    params: TenantParam,
    body: { content: { "application/json": { schema: AddRelationshipBody } }, required: true },
  },
  responses: {
    201: { description: "Relationship recorded", content: { "application/json": { schema: RelationshipSchema } } },
    400: errorResponse("Invalid type, date range, or self-relationship"),
    404: errorResponse("A party was not found"),
  },
});

const listPartiesRoute = createRoute({
  method: "get",
  path: "/internal/v1/tenants/{tenantId}/parties",
  tags: ["party"],
  summary: "List the tenant's parties",
  request: { params: TenantParam },
  responses: {
    200: { description: "Parties", content: { "application/json": { schema: z.object({ parties: z.array(PartySchema) }).openapi("PartyList") } } },
  },
});

const partyProfileRoute = createRoute({
  method: "get",
  path: "/internal/v1/tenants/{tenantId}/parties/{partyId}",
  tags: ["party"],
  summary: "Party 360 — the party, its identifiers and relationships",
  request: {
    params: TenantPartyParam,
    query: z.object({
      asOf: z.string().date().optional().openapi({ description: "Filter relationships to those in force on this date (YYYY-MM-DD)" }),
    }),
  },
  responses: {
    200: { description: "Party profile", content: { "application/json": { schema: PartyProfileSchema } } },
    404: errorResponse("Party not found"),
  },
});

// ── Registration ────────────────────────────────────────────────────────────

export function registerPartyRoutes(app: OpenAPIHono, deps: PartyDeps): void {
  app.openapi(createOrganizationRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const body = c.req.valid("json");
    const org = await deps.service.createOrganization({ tenantId, ...body });
    return c.json(org, 201);
  });

  app.openapi(createPersonRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const body = c.req.valid("json");
    const person = await deps.service.createPerson({ tenantId, ...body });
    return c.json(person, 201);
  });

  app.openapi(registerLegalEntityRoute, async (c) => {
    const { tenantId, partyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const entity = await deps.service.registerLegalEntity({
      tenantId,
      organizationPartyId: partyId,
      ...body,
    });
    return c.json(entity, 201);
  });

  app.openapi(addIdentifierRoute, async (c) => {
    const { tenantId, partyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identifier = await deps.service.addIdentifier({ tenantId, partyId, ...body });
    return c.json(identifier, 201);
  });

  app.openapi(addRelationshipRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const body = c.req.valid("json");
    const relationship = await deps.service.addRelationship({ tenantId, ...body });
    return c.json(relationship, 201);
  });

  app.openapi(listPartiesRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const parties = await deps.service.listParties(tenantId);
    return c.json({ parties: [...parties] }, 200);
  });

  app.openapi(partyProfileRoute, async (c) => {
    const { tenantId, partyId } = c.req.valid("param");
    const { asOf } = c.req.valid("query");
    const profile = await deps.service.partyProfile(tenantId, partyId, asOf);
    return c.json(
      {
        party: profile.party,
        identifiers: [...profile.identifiers],
        relationships: [...profile.relationships],
      },
      200,
    );
  });
}
