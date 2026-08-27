// Party HTTP surface — transport only. Each route declares its wire shape (the
// zod schemas ARE the DTOs and the OpenAPI spec) and its handler parses the
// validated input, calls exactly one use-case method, and maps the result.
//
// THE TENANT COMES FROM THE SESSION, NOT THE PATH. These routes used to sit on
// /internal with tenantId as a path parameter, with a comment promising this
// change once T1.7 landed. It has, so the promise is kept: a caller can no
// longer name the tenant they would like to write to, and the class of bug
// where a valid session for firm A addresses firm B cannot be written.
//
// Nothing inward changed to make that true — the service still takes tenantId
// as a parameter. Only the source of the value moved.
//
// Every write also carries an actor now, which is why these routes require a
// principal at all: an event that cannot name who acted is worth less than no
// event, and the ledger refuses to record one.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z, errorResponse } from "../openapi";
import { toEnvelope } from "../httpresp";
import type { ErrorEnvelope } from "../httpresp";
import type { Actor } from "../../domain/ledger/model";
import type { Principal } from "../../platform/callctx";
import type { PartyService } from "../../usecase/party/service";
import type { PrincipalResolver } from "../principal";

export interface PartyDeps {
  readonly service: PartyService;
  readonly principalOf: PrincipalResolver;
}

/**
 * What every route below starts with: either the caller's tenant and the actor
 * to name in the audit trail, or the reason they get neither.
 *
 * 401 and 403 are different answers and both are needed: "you are not signed
 * in", versus "you are, but you have not said which firm you are acting for".
 * The second is a real state — a partner who belongs to two firms holds a valid
 * session with no tenant until they choose.
 */
type Scope =
  | { readonly ok: true; readonly tenantId: string; readonly actor: Actor }
  | { readonly ok: false; readonly deny: ErrorEnvelope; readonly status: 401 | 403 };

function scopeOf(principal: Principal | null): Scope {
  if (!principal) {
    return {
      ok: false,
      status: 401,
      deny: toEnvelope({ status: 401, code: "UNAUTHORIZED", message: "no authenticated session" }),
    };
  }
  if (principal.tenantId === null) {
    return {
      ok: false,
      status: 403,
      deny: toEnvelope({
        status: 403,
        code: "FORBIDDEN",
        message:
          "this session has not selected an org. Call POST /api/v1/auth/switch-tenant first.",
      }),
    };
  }
  return {
    ok: true,
    tenantId: principal.tenantId,
    actor: { type: "human", id: principal.userId },
  };
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

const PartyParam = z.object({ partyId: z.string().uuid() });

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
  path: "/api/v1/parties/organizations",
  tags: ["party"],
  summary: "Create an organization party",
  request: {
    body: { content: { "application/json": { schema: CreateOrganizationBody } }, required: true },
  },
  responses: {
    201: { description: "Organization created", content: { "application/json": { schema: OrganizationSchema } } },
    400: errorResponse("Request failed validation"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org"),
  },
});

const createPersonRoute = createRoute({
  method: "post",
  path: "/api/v1/parties/persons",
  tags: ["party"],
  summary: "Create a person party",
  request: {
    body: { content: { "application/json": { schema: CreatePersonBody } }, required: true },
  },
  responses: {
    201: { description: "Person created", content: { "application/json": { schema: PersonSchema } } },
    400: errorResponse("Request failed validation"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org"),
  },
});

const registerLegalEntityRoute = createRoute({
  method: "post",
  path: "/api/v1/parties/organizations/{partyId}/legal-entities",
  tags: ["party"],
  summary: "Register a legal entity against an organization",
  request: {
    params: PartyParam,
    body: { content: { "application/json": { schema: RegisterLegalEntityBody } }, required: true },
  },
  responses: {
    201: { description: "Legal entity registered", content: { "application/json": { schema: LegalEntitySchema } } },
    400: errorResponse("Request failed validation, or party is not an organization"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org"),
    404: errorResponse("Organization not found"),
  },
});

const addIdentifierRoute = createRoute({
  method: "post",
  path: "/api/v1/parties/{partyId}/identifiers",
  tags: ["party"],
  summary: "Attach an identifier (PAN, GSTIN, email…) to a party",
  request: {
    params: PartyParam,
    body: { content: { "application/json": { schema: AddIdentifierBody } }, required: true },
  },
  responses: {
    201: { description: "Identifier added", content: { "application/json": { schema: IdentifierSchema } } },
    400: errorResponse("Invalid identifier or date range"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org"),
    404: errorResponse("Party not found"),
    409: errorResponse("Identifier already exists for this tenant"),
  },
});

const addRelationshipRoute = createRoute({
  method: "post",
  path: "/api/v1/parties/relationships",
  tags: ["party"],
  summary: "Record an effective-dated relationship between two parties",
  request: {
    body: { content: { "application/json": { schema: AddRelationshipBody } }, required: true },
  },
  responses: {
    201: { description: "Relationship recorded", content: { "application/json": { schema: RelationshipSchema } } },
    400: errorResponse("Invalid type, date range, or self-relationship"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org"),
    404: errorResponse("A party was not found"),
  },
});

const listPartiesRoute = createRoute({
  method: "get",
  path: "/api/v1/parties",
  tags: ["party"],
  summary: "List the tenant's parties",
  responses: {
    200: { description: "Parties", content: { "application/json": { schema: z.object({ parties: z.array(PartySchema) }).openapi("PartyList") } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org"),
  },
});

const partyProfileRoute = createRoute({
  method: "get",
  path: "/api/v1/parties/{partyId}",
  tags: ["party"],
  summary: "Party 360 — the party, its identifiers and relationships",
  request: {
    params: PartyParam,
    query: z.object({
      asOf: z.string().date().optional().openapi({ description: "Filter relationships to those in force on this date (YYYY-MM-DD)" }),
    }),
  },
  responses: {
    200: { description: "Party profile", content: { "application/json": { schema: PartyProfileSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org"),
    404: errorResponse("Party not found"),
  },
});

// ── Registration ────────────────────────────────────────────────────────────

export function registerPartyRoutes(app: OpenAPIHono, deps: PartyDeps): void {
  const scope = async (getHeader: (name: string) => string | undefined): Promise<Scope> =>
    scopeOf(await deps.principalOf(getHeader));

  app.openapi(createOrganizationRoute, async (c) => {
    const s = await scope((name) => c.req.header(name));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const org = await deps.service.createOrganization({ tenantId: s.tenantId, ...body }, s.actor);
    return c.json(org, 201);
  });

  app.openapi(createPersonRoute, async (c) => {
    const s = await scope((name) => c.req.header(name));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const person = await deps.service.createPerson({ tenantId: s.tenantId, ...body }, s.actor);
    return c.json(person, 201);
  });

  app.openapi(registerLegalEntityRoute, async (c) => {
    const s = await scope((name) => c.req.header(name));
    if (!s.ok) return c.json(s.deny, s.status);
    const { partyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const entity = await deps.service.registerLegalEntity(
      { tenantId: s.tenantId, organizationPartyId: partyId, ...body },
      s.actor,
    );
    return c.json(entity, 201);
  });

  app.openapi(addIdentifierRoute, async (c) => {
    const s = await scope((name) => c.req.header(name));
    if (!s.ok) return c.json(s.deny, s.status);
    const { partyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identifier = await deps.service.addIdentifier(
      { tenantId: s.tenantId, partyId, ...body },
      s.actor,
    );
    return c.json(identifier, 201);
  });

  app.openapi(addRelationshipRoute, async (c) => {
    const s = await scope((name) => c.req.header(name));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const relationship = await deps.service.addRelationship(
      { tenantId: s.tenantId, ...body },
      s.actor,
    );
    return c.json(relationship, 201);
  });

  app.openapi(listPartiesRoute, async (c) => {
    const s = await scope((name) => c.req.header(name));
    if (!s.ok) return c.json(s.deny, s.status);
    const parties = await deps.service.listParties(s.tenantId);
    return c.json({ parties: [...parties] }, 200);
  });

  app.openapi(partyProfileRoute, async (c) => {
    const s = await scope((name) => c.req.header(name));
    if (!s.ok) return c.json(s.deny, s.status);
    const { partyId } = c.req.valid("param");
    const { asOf } = c.req.valid("query");
    const profile = await deps.service.partyProfile(s.tenantId, partyId, asOf);
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
