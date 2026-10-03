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
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { scopeOf } from "../scope";
import type {
  LegalEntity,
  Organization,
  Party,
  PartyIdentifier,
  PartyRelationship,
  Person,
} from "../../domain/party/model";
import type { PartyService } from "../../usecase/party/service";
import type { RelationshipRecord, RelationshipType } from "../../usecase/party/ports";

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
    // Null while the party is live. NOT a delete marker — there is no
    // `deleted_at` in `core` and never will be (migration 0035). An archived
    // party is out of the pickers and still resolves by id forever, which is
    // what lets a signed document keep rendering its counterparty. Documented
    // here because zod-openapi documents a response without validating it: a
    // field the spec omits is one the generated client cannot see.
    archivedAt: z.string().nullable(),
    isOwnCompany: z.boolean().openapi({
      description:
        "One of the firm's OWN companies: the firm itself, or a company on Our companies " +
        "(`crm.is_firm_entity`, 0313). Such a party is never a client: a proposal, an " +
        "engagement letter, a lead and an invoice all refuse it. Listed all the same, so a " +
        "screen that may name the firm (a task about it) still can; the client screens hide it.",
    }),
  })
  .openapi("Party");

/** A party on the wire, field by field: a field forwarded by a spread reaches
 *  the JSON without reaching the spec, so the generated client never sees it. */
function partyWire(p: Party) {
  return {
    id: p.id,
    tenantId: p.tenantId,
    kind: p.kind,
    displayName: p.displayName,
    archivedAt: p.archivedAt,
    isOwnCompany: p.isOwnCompany,
  };
}

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
    /** Entered by mistake and voided (V2.5): kept, shown as voided, and no
     *  longer blocking the value on another party. */
    voidedAt: z.string().nullable(),
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

/** A relationship with the party at the OTHER end of it, and which end this
 *  one is standing at. A bare relationship carries two uuids, which is right
 *  for the aggregate and renders as two uuids. */
const RelationshipRecordSchema = z
  .object({
    relationship: RelationshipSchema,
    counterparty: z.object({
      id: z.string().uuid(),
      kind: z.enum(["organization", "person"]),
      displayName: z.string(),
    }),
    direction: z.enum(["outgoing", "incoming"]),
  })
  .openapi("PartyRelationshipRecord");

/**
 * One code from the product's relationship vocabulary.
 *
 * BOTH sentences are on the wire, and that is the point of the read. A
 * relationship is one row read from two ends — "Priya is a director of Cobalt
 * Foods" and "Cobalt Foods has director Priya" — so a screen that recorded one
 * without the inverse would have to invent the other half, and a screen that
 * had neither renders `director_of` and an arrow, which is what the client page
 * showed until this existed.
 */
const RelationshipTypeSchema = z
  .object({
    code: z.string(),
    label: z.string().openapi({ description: 'Reads as "{from} is {label} {to}".' }),
    inverseLabel: z.string().openapi({ description: "The same row from the other end." }),
    category: z.string().openapi({
      description: "governance · ownership · employment · commercial.",
    }),
  })
  .openapi("RelationshipType");

const PartyProfileSchema = z
  .object({
    party: PartySchema,
    // Exactly one of these is set, by kind. They are here because a screen that
    // had to render this could otherwise show a display name and nothing else —
    // the legal name, trade name, industry and date of birth were all captured
    // at creation and then unreachable through any read.
    organization: OrganizationSchema.nullable(),
    person: PersonSchema.nullable(),
    // The counterpart registerLegalEntity never had. A jurisdiction and a
    // financial-year end that can be written and never read back is not a
    // stored fact.
    legalEntities: z.array(LegalEntitySchema),
    identifiers: z.array(IdentifierSchema),
    relationships: z.array(RelationshipRecordSchema),
  })
  .openapi("PartyProfile");

// ── Request schemas ──────────────────────────────────────────────────────────

const PartyParam = z.object({ partyId: z.string().uuid() });

// The closed identifier set lives in the domain; the DTO checks shape, the
// service normalises and shape-validates, and the DB CHECK is the backstop.
// Exported because lead capture takes the same set — one wire vocabulary, so an
// identifier type valid on one route cannot be rejected on the other.
export const IdentifierTypeSchema = z.enum([
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

const EndRelationshipBody = z
  .object({
    /** Half-open: the first day the relationship is NOT in force. A director
     *  who resigned on the 12th is ended on the 12th and the 11th is her last
     *  day — the same convention as every other date range in this product. */
    validTo: z.string().date(),
  })
  .openapi("EndRelationshipRequest");

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

// ── Correcting a client's master data (V2.5) ───────────────────────────────

const UpdatePartyBody = z
  .object({
    displayName: z.string().max(400).optional(),
    tradeName: z.string().max(400).nullable().optional(),
    industry: z.string().max(400).nullable().optional(),
    website: z.string().max(400).nullable().optional(),
  })
  .openapi("UpdateParty");

const updatePartyRoute = createRoute({
  method: "patch",
  path: "/api/v1/parties/{partyId}",
  tags: ["party"],
  summary: "Correct a client's name, trade name, industry or website",
  description:
    "Absent means unchanged; null or blank clears an optional field. Every list and every NEW " +
    "PDF reads the new name; a signed letter and a filed PDF do not change. The audit trail " +
    "records which fields changed, never their values.",
  request: {
    params: PartyParam,
    body: { content: { "application/json": { schema: UpdatePartyBody } }, required: true },
  },
  responses: {
    200: { description: "Corrected", content: { "application/json": { schema: PartySchema } } },
    400: errorResponse("A blank name, a company field on a person, or nothing changed"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not do this"),
    404: errorResponse("Party not found"),
  },
});

const CorrectLegalEntityBody = z
  .object({
    jurisdiction: z.string().max(10).optional().openapi({ example: "IN" }),
    entityType: z.string().max(100).optional().openapi({ example: "private_limited" }),
  })
  .openapi("CorrectLegalEntity");

const correctLegalEntityRoute = createRoute({
  method: "patch",
  path: "/api/v1/parties/{partyId}/legal-entity",
  tags: ["party"],
  summary: "Correct a registered company's country or kind",
  request: {
    params: PartyParam,
    body: { content: { "application/json": { schema: CorrectLegalEntityBody } }, required: true },
  },
  responses: {
    200: { description: "Corrected", content: { "application/json": { schema: LegalEntitySchema } } },
    400: errorResponse("Not a two-letter country, a blank kind, or nothing changed"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not do this"),
    409: errorResponse("The client is not registered as a company"),
  },
});

const IdentifierParam = z.object({
  partyId: z.string().uuid(),
  identifierId: z.string().uuid(),
});

const endIdentifierRoute = createRoute({
  method: "post",
  path: "/api/v1/parties/{partyId}/identifiers/{identifierId}/end",
  tags: ["party"],
  summary: "An identifier stopped being in force (a GSTIN cancelled)",
  description: "Sets its end day. An ended identifier no longer blocks the value on another client.",
  request: {
    params: IdentifierParam,
    body: {
      content: { "application/json": { schema: z.object({ validTo: z.string().date() }).openapi("EndIdentifier") } },
      required: true,
    },
  },
  responses: {
    200: { description: "Ended", content: { "application/json": { schema: IdentifierSchema } } },
    400: errorResponse("The end is before it began"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not do this"),
    404: errorResponse("No such identifier on this client"),
    409: errorResponse("Already ended or voided"),
  },
});

const voidIdentifierRoute = createRoute({
  method: "post",
  path: "/api/v1/parties/{partyId}/identifiers/{identifierId}/void",
  tags: ["party"],
  summary: "Void an identifier entered by mistake",
  description:
    "Kept and shown as voided, final, and no longer blocking the value: the correct PAN or " +
    "GSTIN can then be added, here or on the right client.",
  request: { params: IdentifierParam },
  responses: {
    200: { description: "Voided", content: { "application/json": { schema: IdentifierSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not do this"),
    404: errorResponse("No such identifier on this client"),
    409: errorResponse("Already voided"),
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

/**
 * Close an open relationship.
 *
 * A POST to a sub-path rather than a PATCH on the relationship: it is one act
 * with one meaning and one event, not a field being edited, and this codebase
 * has said so about every other transition it exposes. `{relationshipId}` sits
 * under `/parties/relationships/`, which is itself a LITERAL — so it cannot
 * collide with `/parties/{partyId}` the way `/parties/relationship-types`
 * could.
 */
const endRelationshipRoute = createRoute({
  method: "post",
  path: "/api/v1/parties/relationships/{relationshipId}/end",
  tags: ["party"],
  summary: "Close an open relationship with the day it stopped being in force",
  request: {
    params: z.object({ relationshipId: z.string().uuid() }),
    body: { content: { "application/json": { schema: EndRelationshipBody } }, required: true },
  },
  responses: {
    200: { description: "Relationship closed", content: { "application/json": { schema: RelationshipSchema } } },
    400: errorResponse("The end date is not after the day it began"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org"),
    404: errorResponse("No such relationship"),
    409: errorResponse("The relationship has already ended"),
  },
});

/**
 * The relationship vocabulary. A LITERAL path, and it must stay one.
 *
 * `/api/v1/parties/relationship-types` sits under the same prefix as
 * `/api/v1/parties/{partyId}`, and the permission table compiles literals
 * ahead of templates for exactly this reason — a firm's party id would
 * otherwise be a plausible match for this route and vice versa.
 */
const relationshipTypesRoute = createRoute({
  method: "get",
  path: "/api/v1/parties/relationship-types",
  tags: ["party"],
  summary: "The relationship vocabulary — every code, and the sentence it reads as",
  description:
    "Product-owned and the same for every firm, like a currency list: no tenant, nothing " +
    "editable. It is a READ rather than a constant in each client because the alternative is " +
    "a copy of a migration's seed data living in a screen, which goes stale the first time " +
    "the product adds a code — and because a picker that offers `parent_of` is offering a " +
    "column value to a partner.",
  responses: {
    200: {
      description: "The vocabulary",
      content: {
        "application/json": {
          schema: z
            .object({ types: z.array(RelationshipTypeSchema) })
            .openapi("RelationshipTypeList"),
        },
      },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org"),
  },
});

const listPartiesRoute = createRoute({
  method: "get",
  path: "/api/v1/parties",
  tags: ["party"],
  summary: "List the tenant's parties",
  request: {
    query: z.object({
      // The list is a picker, so it hides archived parties by default and takes
      // an explicit flag to include them. Reading ONE party by id is the
      // opposite and always resolves — see GET /api/v1/parties/{partyId}.
      includeArchived: z
        .enum(["true", "false"])
        .optional()
        .openapi({ description: "Include archived parties in the list. Default false." }),
    }),
  },
  responses: {
    200: { description: "Parties", content: { "application/json": { schema: z.object({ parties: z.array(PartySchema) }).openapi("PartyList") } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org"),
  },
});

// ARCHIVE / UNARCHIVE, and there is deliberately no DELETE beside them.
//
// Parties are permanent: `core` has no `deleted_at`, `bib_app` holds no DELETE
// grant on any core table, and a real company's lifecycle is the ledger plus
// `core.legal_entity.status`. Archiving only means "keep this out of the
// pickers", which is why it is a POST of an intent rather than an HTTP DELETE
// that would read as a removal to anyone generating a client from this spec.
const archivePartyRoute = createRoute({
  method: "post",
  path: "/api/v1/parties/{partyId}/archive",
  tags: ["party"],
  summary: "Archive a party — hide it from pickers and lists. Not a delete.",
  request: { params: PartyParam },
  responses: {
    200: { description: "Party archived", content: { "application/json": { schema: PartySchema } } },
    400: errorResponse("Request failed validation"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org"),
    404: errorResponse("Party not found"),
    409: errorResponse(
      "Already archived, or something still refers to the party — a lead, a proposal, an engagement letter, a letter line's entity or an engagement. The message names them.",
    ),
  },
});

const unarchivePartyRoute = createRoute({
  method: "post",
  path: "/api/v1/parties/{partyId}/unarchive",
  tags: ["party"],
  summary: "Bring an archived party back into pickers and lists",
  request: { params: PartyParam },
  responses: {
    200: { description: "Party restored", content: { "application/json": { schema: PartySchema } } },
    400: errorResponse("Request failed validation"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org"),
    404: errorResponse("Party not found"),
    409: errorResponse("The party is not archived"),
  },
});

const partyProfileRoute = createRoute({
  method: "get",
  path: "/api/v1/parties/{partyId}",
  tags: ["party"],
  summary: "Party 360 — the party, its identifiers and relationships",
  description:
    "Always resolves, archived or not: a document pointing at this party has to render its counterparty.",
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

// ── Mapping ─────────────────────────────────────────────────────────────────
//
// FIELD BY FIELD (B48, audit 2026-10-03). These answers forwarded the domain
// object, or spread it, and zod-openapi documents a response without
// validating it: a field added to the aggregate would reach the browser
// undocumented, and the generated client would never learn it existed.

function organizationWire(o: Organization): z.infer<typeof OrganizationSchema> {
  return {
    partyId: o.partyId,
    tenantId: o.tenantId,
    legalName: o.legalName,
    tradeName: o.tradeName,
    industry: o.industry,
    website: o.website,
    isFirmSelf: o.isFirmSelf,
  };
}

function personWire(p: Person): z.infer<typeof PersonSchema> {
  return {
    partyId: p.partyId,
    tenantId: p.tenantId,
    fullName: p.fullName,
    nationality: p.nationality,
    dateOfBirth: p.dateOfBirth,
  };
}

function legalEntityWire(e: LegalEntity): z.infer<typeof LegalEntitySchema> {
  return {
    partyId: e.partyId,
    tenantId: e.tenantId,
    jurisdiction: e.jurisdiction,
    entityType: e.entityType,
    incorporatedOn: e.incorporatedOn,
    financialYearEnd: e.financialYearEnd,
    registeredAddress: e.registeredAddress === null ? null : { ...e.registeredAddress },
    status: e.status,
  };
}

function identifierWire(i: PartyIdentifier): z.infer<typeof IdentifierSchema> {
  return {
    id: i.id,
    tenantId: i.tenantId,
    partyId: i.partyId,
    type: i.type,
    value: i.value,
    jurisdiction: i.jurisdiction,
    isPrimary: i.isPrimary,
    validFrom: i.validFrom,
    validTo: i.validTo,
    voidedAt: i.voidedAt,
  };
}

function relationshipWire(r: PartyRelationship): z.infer<typeof RelationshipSchema> {
  return {
    id: r.id,
    tenantId: r.tenantId,
    fromPartyId: r.fromPartyId,
    toPartyId: r.toPartyId,
    type: r.type,
    validFrom: r.validFrom,
    validTo: r.validTo,
    attributes: { ...r.attributes },
  };
}

function relationshipRecordWire(r: RelationshipRecord): z.infer<typeof RelationshipRecordSchema> {
  return {
    relationship: relationshipWire(r.relationship),
    counterparty: { id: r.counterparty.id, kind: r.counterparty.kind, displayName: r.counterparty.displayName },
    direction: r.direction,
  };
}

function relationshipTypeWire(t: RelationshipType): z.infer<typeof RelationshipTypeSchema> {
  return { code: t.code, label: t.label, inverseLabel: t.inverseLabel, category: t.category };
}

// ── Registration ────────────────────────────────────────────────────────────

export function registerPartyRoutes(app: OpenAPIHono<AppEnv>, deps: PartyDeps): void {
  app.openapi(createOrganizationRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const org = await deps.service.createOrganization({ tenantId: s.tenantId, ...body }, s.actor);
    return c.json(organizationWire(org), 201);
  });

  app.openapi(createPersonRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const person = await deps.service.createPerson({ tenantId: s.tenantId, ...body }, s.actor);
    return c.json(personWire(person), 201);
  });

  app.openapi(registerLegalEntityRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { partyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const entity = await deps.service.registerLegalEntity(
      { tenantId: s.tenantId, organizationPartyId: partyId, ...body },
      s.actor,
    );
    return c.json(legalEntityWire(entity), 201);
  });

  app.openapi(updatePartyRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { partyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const party = await deps.service.updateParty({ tenantId: s.tenantId, partyId, ...body }, s.actor);
    return c.json(partyWire(party), 200);
  });

  app.openapi(correctLegalEntityRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { partyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const entity = await deps.service.correctLegalEntity({ tenantId: s.tenantId, partyId, ...body }, s.actor);
    return c.json(legalEntityWire(entity), 200);
  });

  app.openapi(endIdentifierRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { partyId, identifierId } = c.req.valid("param");
    const { validTo } = c.req.valid("json");
    const identifier = await deps.service.endIdentifier(
      { tenantId: s.tenantId, partyId, identifierId, validTo },
      s.actor,
    );
    return c.json(identifierWire(identifier), 200);
  });

  app.openapi(voidIdentifierRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { partyId, identifierId } = c.req.valid("param");
    const identifier = await deps.service.voidIdentifier(
      { tenantId: s.tenantId, partyId, identifierId },
      s.actor,
    );
    return c.json(identifierWire(identifier), 200);
  });

  app.openapi(addIdentifierRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { partyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identifier = await deps.service.addIdentifier(
      { tenantId: s.tenantId, partyId, ...body },
      s.actor,
    );
    return c.json(identifierWire(identifier), 201);
  });

  app.openapi(relationshipTypesRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const types = await deps.service.relationshipTypes();
    return c.json({ types: types.map(relationshipTypeWire) }, 200);
  });

  app.openapi(addRelationshipRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const relationship = await deps.service.addRelationship(
      { tenantId: s.tenantId, ...body },
      s.actor,
    );
    return c.json(relationshipWire(relationship), 201);
  });

  app.openapi(endRelationshipRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { relationshipId } = c.req.valid("param");
    const { validTo } = c.req.valid("json");
    const relationship = await deps.service.endRelationship(
      { tenantId: s.tenantId, relationshipId, validTo },
      s.actor,
    );
    return c.json(relationshipWire(relationship), 200);
  });

  app.openapi(archivePartyRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { partyId } = c.req.valid("param");
    const party = await deps.service.archiveParty({ tenantId: s.tenantId, partyId }, s.actor);
    return c.json(partyWire(party), 200);
  });

  app.openapi(unarchivePartyRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { partyId } = c.req.valid("param");
    const party = await deps.service.unarchiveParty({ tenantId: s.tenantId, partyId }, s.actor);
    return c.json(partyWire(party), 200);
  });

  app.openapi(listPartiesRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { includeArchived } = c.req.valid("query");
    const parties = await deps.service.listParties(s.tenantId, includeArchived === "true");
    return c.json({ parties: parties.map(partyWire) }, 200);
  });

  app.openapi(partyProfileRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { partyId } = c.req.valid("param");
    const { asOf } = c.req.valid("query");
    const profile = await deps.service.partyProfile(s.tenantId, partyId, asOf);
    // Mapped field by field, like every other handler here: forwarding the read
    // model is how a field reaches the wire without reaching the spec.
    return c.json(
      {
        party: partyWire(profile.party),
        organization: profile.organization === null ? null : organizationWire(profile.organization),
        person: profile.person === null ? null : personWire(profile.person),
        legalEntities: profile.legalEntities.map(legalEntityWire),
        identifiers: profile.identifiers.map(identifierWire),
        relationships: profile.relationships.map(relationshipRecordWire),
      },
      200,
    );
  });
}
