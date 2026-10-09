// Routes for the firm's own companies, the issuing-entity rule and document prose blocks.
// The preference routes are how a firm says "clients in SG are served by our SG entity",
// which is why `crm.firm_entity_preference` is keyed on a country.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { scopeOf } from "../scope";
import type { DocumentService } from "../../usecase/document/service";
import type { FirmEntityService, FirmEntityView } from "../../usecase/document/firm-entities";
import type { BlockKind, DocumentBlock, StandardBlock } from "../../domain/document/model";
import {
  REGISTERED_ADDRESS_LINE_MAX,
  REGISTERED_ADDRESS_MAX_LINES,
} from "../../domain/document/model";

export interface DocumentDeps {
  readonly service: DocumentService;
  /** The firm's own companies (T6.18). */
  readonly firmEntities: FirmEntityService;
}

/** ISO 3166-1 alpha-2, or the `*` fallback. Length alone lets "**" through; the service
 *  normalises and validates. */
const JurisdictionKeySchema = z.string().min(1).max(2);

const PreferenceSchema = z
  .object({
    id: z.string().uuid(),
    /** The CLIENT's country, or `*` for the fallback. */
    clientJurisdiction: z.string(),
    firmEntityPartyId: z.string().uuid(),
    /** The entity's name and where it is registered. `jurisdiction` is null with no
     *  registration recorded (every seeded default); G1.8 refuses a governing-law clause on a
     *  letter from an unregistered entity, so the firm sees it here first. */
    firmEntity: z.object({
      id: z.string().uuid(),
      displayName: z.string(),
      jurisdiction: z.string().length(2).nullable(),
    }),
    /** Why the firm made this choice. Null on a row nobody has explained. */
    note: z.string().nullable(),
  })
  .openapi("FirmEntityPreference");

const PreferencesResponse = z
  .object({ preferences: z.array(PreferenceSchema) })
  .openapi("FirmEntityPreferencesResponse");

const SetPreferenceRequest = z
  .object({
    clientJurisdiction: JurisdictionKeySchema,
    firmEntityPartyId: z.string().uuid(),
    note: z.string().max(1000).optional(),
  })
  .openapi("SetFirmEntityPreferenceRequest");

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/firm-entities/preferences",
  tags: ["firm-entities"],
  summary: "Which of the firm's own entities issues to clients where",
  description:
    "The firm's rule as rows: one per country it has an opinion about, plus the `*` fallback " +
    "that answers for every country it has no entity in. A document resolves through this " +
    "when it is drafted and then stores the answer, so changing a row here never restates a " +
    "document already issued.",
  responses: {
    200: {
      description: "The rule",
      content: { "application/json": { schema: PreferencesResponse } },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const setRoute = createRoute({
  method: "post",
  path: "/api/v1/firm-entities/preferences",
  tags: ["firm-entities"],
  summary: "Say which entity serves clients in a country",
  description:
    "Upserts the row for that country — the schema allows exactly one answer per country. " +
    "Use `*` to move the fallback.",
  request: {
    body: { content: { "application/json": { schema: SetPreferenceRequest } }, required: true },
  },
  responses: {
    200: { description: "Set", content: { "application/json": { schema: PreferenceSchema } } },
    400: errorResponse("Not a country code or the wildcard"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such party at this firm"),
  },
});

// ── The firm's own companies (T6.18) ────────────────────────────────────────

/** Printed lines in order, plus the state and postal code a tax invoice names (audit 2026-10-03). */
const RegisteredAddressSchema = z
  .object({
    lines: z
      .array(z.string().max(REGISTERED_ADDRESS_LINE_MAX))
      .max(REGISTERED_ADDRESS_MAX_LINES),
    region: z.string().max(100).nullable().optional().openapi({
      description: "The state, province, emirate or region: Maharashtra. Printed on invoices and letters.",
    }),
    postalCode: z.string().max(20).nullable().optional().openapi({ description: "411001" }),
  })
  .openapi("RegisteredAddress");

/** One of a company's numbers: which kind, and the value. */
const FirmEntityNumberSchema = z
  .object({
    type: z.string().openapi({ description: "gstin (India), trn (UAE), ein (US), vat (anywhere else)" }),
    value: z.string(),
  })
  .openapi("FirmEntityNumber");

/** A company's numbers (audit 2026-10-03). Absent keeps; null or "" clears. */
const firmEntityNumbers = {
  taxRegistration: z.string().max(40).nullable().optional().openapi({
    description:
      "Its tax registration: a GSTIN for a company registered in India (held to the GSTIN's " +
      "shape), a TRN in the UAE, an EIN in the US, a VAT number anywhere else.",
  }),
  pan: z.string().max(20).nullable().optional().openapi({ description: "Its PAN; India only." }),
  phone: z.string().max(40).nullable().optional().openapi({
    description: "Stored in E.164; a number without a country code takes the company's.",
  }),
  email: z.string().max(254).nullable().optional(),
};

const FirmEntitySchema = z
  .object({
    partyId: z.string().uuid(),
    name: z.string(),
    /** Null with no registration recorded (every firm's seeded one). */
    jurisdiction: z.string().length(2).nullable(),
    entityType: z.string().nullable(),
    /** Stored, not printed yet (D15). */
    registeredAddress: RegisteredAddressSchema.nullable(),
    /** The organization the firm itself is. */
    isFirmSelf: z.boolean(),
    /** The client countries the firm's rule sends to this company. */
    routedCountries: z.array(z.string()),
    /** Whether it answers for every country the firm has no company in (`*`). */
    isFallback: z.boolean(),
    /** Printed under its name on documents (audit 2026-10-03): each in force today, or null. */
    taxRegistration: FirmEntityNumberSchema.nullable(),
    pan: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    /** Its documents' starting currency (D1): IN INR, AE AED, SG SGD, US USD, else the firm's
     *  reporting currency. Screens read it here rather than keep a copy. */
    defaultCurrency: z.string().length(3),
    /** Its own zone (0337): dates its documents and its bills' due day. Null = the firm's. */
    timeZone: z.string().nullable(),
    /** Its own FY start month, 1-12 (0337): invoice-number year, quarters. Null = the firm's. */
    fiscalYearStartMonth: z.number().int().min(1).max(12).nullable(),
  })
  .openapi("FirmEntity");

/** A company's own year and clock (0337): absent keeps, null reverts to the firm's. */
const firmEntityCalendar = {
  timeZone: z.string().max(64).nullable().optional().openapi({
    description:
      "An IANA zone (Asia/Dubai, America/New_York), never an offset. Dates this company's documents. " +
      "Null = the firm's. Needs the company registered in a country first (COMPANY_NOT_REGISTERED).",
  }),
  fiscalYearStartMonth: z.number().int().nullable().optional().openapi({
    description:
      "1-12, the month its financial year starts. Null = the firm's. A change applies to invoice numbers " +
      "drawn after it: a series already started keeps its year (0337).",
  }),
};

const FirmEntitiesResponse = z
  .object({
    /** A document in any other currency needs a rate back to this one. */
    reportingCurrency: z.string().length(3),
    entities: z.array(FirmEntitySchema),
  })
  .openapi("FirmEntitiesResponse");

const CreateFirmEntityRequest = z
  .object({
    name: z.string().min(1).max(300),
    /** Where it is registered; it becomes the issuer for clients in that country. */
    jurisdiction: z.string().length(2),
    /** "Private Limited", "FZE", "Pte. Ltd.", "Inc." — the firm's words. */
    entityType: z.string().min(1).max(100),
    registeredAddress: RegisteredAddressSchema.optional(),
    ...firmEntityNumbers,
    ...firmEntityCalendar,
  })
  .openapi("CreateFirmEntityRequest");

const EditFirmEntityRequest = z
  .object({
    name: z.string().min(1).max(300).optional(),
    entityType: z.string().min(1).max(100).optional(),
    /** Null clears it. */
    registeredAddress: RegisteredAddressSchema.nullable().optional(),
    /** Only with no country recorded yet (send entityType too); else JURISDICTION_FIXED. */
    jurisdiction: z.string().length(2).optional(),
    ...firmEntityNumbers,
    ...firmEntityCalendar,
  })
  .openapi("EditFirmEntityRequest");

const listEntitiesRoute = createRoute({
  method: "get",
  path: "/api/v1/firm-entities",
  tags: ["firm-entities"],
  summary: "The firm's own companies",
  description:
    "Every company that can issue the firm's documents: the firm itself and each company the " +
    "firm's rule names for a country. With where each is registered, which client countries " +
    "it issues for, and the currency its documents start in.",
  responses: {
    200: {
      description: "The firm's companies",
      content: { "application/json": { schema: FirmEntitiesResponse } },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const createEntityRoute = createRoute({
  method: "post",
  path: "/api/v1/firm-entities",
  tags: ["firm-entities"],
  summary: "Add one of the firm's own companies",
  description:
    "Creates the organization, registers it in its country and makes it the company that " +
    "issues to clients there — in one transaction, with the usual events (party.created, " +
    "legal_entity.registered, firm_entity_preference.set). Refused while another of the " +
    "firm's companies already issues for that country.",
  request: {
    body: { content: { "application/json": { schema: CreateFirmEntityRequest } }, required: true },
  },
  responses: {
    201: { description: "Added", content: { "application/json": { schema: FirmEntitySchema } } },
    400: errorResponse("A blank name or type, a country code that is not one, or an address too long"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    409: errorResponse("Another of the firm's companies already issues for that country"),
  },
});

const editEntityRoute = createRoute({
  method: "patch",
  path: "/api/v1/firm-entities/{entityPartyId}",
  tags: ["firm-entities"],
  summary: "Change one of the firm's own companies",
  description:
    "Its name, entity type, registered address (with its state and postal code) and the numbers " +
    "that print under its name: tax registration, PAN, phone, email (audit 2026-10-03). And, for a " +
    "company with no country " +
    "recorded yet, where it is registered.",
  request: {
    params: z.object({ entityPartyId: z.string().uuid() }),
    body: { content: { "application/json": { schema: EditFirmEntityRequest } }, required: true },
  },
  responses: {
    200: { description: "Saved", content: { "application/json": { schema: FirmEntitySchema } } },
    400: errorResponse("Nothing to change, or a value that cannot be stored"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("Not one of the firm's own companies"),
    409: errorResponse(
      "A company already registered in a country does not move, or its year and clock were sent before its country",
    ),
  },
});

function toFirmEntityBody(e: FirmEntityView): z.infer<typeof FirmEntitySchema> {
  return {
    partyId: e.partyId,
    name: e.name,
    jurisdiction: e.jurisdiction,
    entityType: e.entityType,
    registeredAddress:
      e.registeredAddress === null
        ? null
        : {
            lines: [...e.registeredAddress.lines],
            region: e.registeredAddress.region ?? null,
            postalCode: e.registeredAddress.postalCode ?? null,
          },
    isFirmSelf: e.isFirmSelf,
    routedCountries: [...e.routedCountries],
    isFallback: e.isFallback,
    taxRegistration:
      e.taxRegistration === null ? null : { type: e.taxRegistration.type, value: e.taxRegistration.value },
    pan: e.pan,
    phone: e.phone,
    email: e.email,
    defaultCurrency: e.defaultCurrency,
    timeZone: e.timeZone,
    fiscalYearStartMonth: e.fiscalYearStartMonth,
  };
}

// ── The prose blocks (G1.7) ─────────────────────────────────────────────────

/** The block kinds as a zod literal tuple; the one copy, shared with the letter and proposal
 *  handlers. `cover` and `acceptance` (0083) are letter-only: service and DB refuse them on a
 *  proposal. */
export const BLOCK_KIND_VALUES = [
  "exclusion",
  "commercial",
  "team",
  "cover",
  "acceptance",
] as const satisfies readonly BlockKind[];

const StandardBlockSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(BLOCK_KIND_VALUES),
    body: z.string(),
    /** A section title, not an item (the team block is a table with headings). */
    isHeading: z.boolean(),
    sortOrder: z.number().int(),
    /** NULL prints everywhere; a code only on documents for that country (no "Exclusive of
     *  GST" on a UAE proposal). */
    jurisdiction: z.string().length(2).nullable(),
    /** Owning company (T6.18), or null for the default set. A document takes its issuer's
     *  lines of a kind when it has any, else the defaults. */
    issuingEntityPartyId: z.string().uuid().nullable(),
    /** Retired, never deleted: issued documents copied it. */
    isActive: z.boolean(),
  })
  .openapi("StandardDocumentBlock");

const StandardBlocksResponse = z
  .object({ blocks: z.array(StandardBlockSchema) })
  .openapi("StandardDocumentBlocksResponse");

const AddStandardBlockRequest = z
  .object({
    kind: z.enum(BLOCK_KIND_VALUES),
    body: z.string().min(1).max(4000),
    isHeading: z.boolean().optional(),
    sortOrder: z.number().int().min(1),
    jurisdiction: z.string().length(2).nullable().optional(),
    /** One of the firm's own companies (T6.18); absent or null is the default set. */
    issuingEntityPartyId: z.string().uuid().nullable().optional(),
  })
  .openapi("AddStandardDocumentBlockRequest");

const EditStandardBlockRequest = z
  .object({
    body: z.string().min(1).max(4000).optional(),
    isHeading: z.boolean().optional(),
    sortOrder: z.number().int().min(1).optional(),
    /** `null` = print everywhere, unlike leaving it out. */
    jurisdiction: z.string().length(2).nullable().optional(),
    /** `null` moves the line to the default set (T6.18). */
    issuingEntityPartyId: z.string().uuid().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .openapi("EditStandardDocumentBlockRequest");

const listBlocksRoute = createRoute({
  method: "get",
  path: "/api/v1/document-blocks/standard",
  tags: ["firm-entities"],
  summary: "The firm's standard prose — exclusions, commercial notes, the team block",
  description:
    "The set COPIED onto each new proposal and engagement letter. Editing it changes the next " +
    "document and never one already issued. Retired lines are included: a document issued " +
    "while one was live copied it, and 'where did this line come from' has to resolve. With " +
    "`issuingEntityPartyId`, that company's own lines only (T6.18).",
  request: {
    query: z.object({ issuingEntityPartyId: z.string().uuid().optional() }),
  },
  responses: {
    200: {
      description: "The standard set",
      content: { "application/json": { schema: StandardBlocksResponse } },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const addBlockRoute = createRoute({
  method: "post",
  path: "/api/v1/document-blocks/standard",
  tags: ["firm-entities"],
  summary: "Add a line to the firm's standard prose",
  request: {
    body: { content: { "application/json": { schema: AddStandardBlockRequest } }, required: true },
  },
  responses: {
    201: { description: "Added", content: { "application/json": { schema: StandardBlockSchema } } },
    400: errorResponse("Not a block kind, a blank body, or a bad sort order"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("The company named is not one of the firm's own"),
  },
});

const editBlockRoute = createRoute({
  method: "patch",
  path: "/api/v1/document-blocks/standard/{blockId}",
  tags: ["firm-entities"],
  summary: "Edit or retire a line of the firm's standard prose",
  description:
    "Retiring is `isActive: false`, never a delete — the same distinction the grade ladder " +
    "draws. Editing changes what the NEXT document says and nothing already issued.",
  request: {
    params: z.object({ blockId: z.string().uuid() }),
    body: { content: { "application/json": { schema: EditStandardBlockRequest } }, required: true },
  },
  responses: {
    200: { description: "Saved", content: { "application/json": { schema: StandardBlockSchema } } },
    400: errorResponse("A blank body or a bad sort order"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such standard block at this firm, or the company named is not one of the firm's own"),
  },
});

// ── A DOCUMENT's own blocks ────────────────────────────────────────────────
// Keyed on the block id (unique in a firm), not nested under proposal and letter twice. A row
// per line is what lets a screen "delete the third exclusion".

const DocumentBlockSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(BLOCK_KIND_VALUES),
    body: z.string(),
    isHeading: z.boolean(),
    sortOrder: z.number().int(),
    sourceId: z.string().uuid().nullable(),
    isEdited: z.boolean().openapi({
      description:
        "Whether this line has been CHANGED since it landed on the document. `sourceId` " +
        "survives an edit, so a house line somebody reworded for this client goes on " +
        "pointing at the standard row — 0025's own comment asks for a screen that says " +
        "'standard' beside an untouched line and 'edited' beside a changed one, and " +
        "`sourceId` alone can only say the first half. Derived from `updated_at > " +
        "created_at`; the only UPDATE this table takes is an edit.",
    }),
  })
  .openapi("DocumentBlock");

const AddDocumentBlockRequest = z
  .object({
    /** Exactly one, mirroring the CHECK on `crm.document_block`. */
    proposalId: z.string().uuid().optional(),
    engagementLetterId: z.string().uuid().optional(),
    kind: z.enum(BLOCK_KIND_VALUES),
    body: z.string().min(1).max(4000),
    isHeading: z.boolean().optional(),
    sortOrder: z.number().int().min(1),
  })
  .refine((b) => (b.proposalId === undefined) !== (b.engagementLetterId === undefined), {
    message: "name exactly one of proposalId or engagementLetterId",
  })
  .openapi("AddDocumentBlockRequest");

const EditDocumentBlockRequest = z
  .object({
    body: z.string().min(1).max(4000).optional(),
    isHeading: z.boolean().optional(),
    sortOrder: z.number().int().min(1).optional(),
  })
  .openapi("EditDocumentBlockRequest");

const addDocBlockRoute = createRoute({
  method: "post",
  path: "/api/v1/document-blocks",
  tags: ["firm-entities"],
  summary: "Write a line of prose onto one document",
  description:
    "A line this client negotiated that is not in the firm's standard set. `sourceId` comes " +
    "back null, which is what lets a screen mark it as the document's own.",
  request: {
    body: { content: { "application/json": { schema: AddDocumentBlockRequest } }, required: true },
  },
  responses: {
    201: { description: "Added", content: { "application/json": { schema: DocumentBlockSchema } } },
    400: errorResponse("Not a block kind, a blank body, or a bad sort order"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    409: errorResponse("The letter is signed — its prose is frozen with its terms"),
  },
});

const editDocBlockRoute = createRoute({
  method: "patch",
  path: "/api/v1/document-blocks/{blockId}",
  tags: ["firm-entities"],
  summary: "Edit one line of a document's prose",
  request: {
    params: z.object({ blockId: z.string().uuid() }),
    body: { content: { "application/json": { schema: EditDocumentBlockRequest } }, required: true },
  },
  responses: {
    200: { description: "Saved", content: { "application/json": { schema: DocumentBlockSchema } } },
    400: errorResponse("A blank body or a bad sort order"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such block on any document at this firm"),
    409: errorResponse("The letter is signed — its prose is frozen with its terms"),
  },
});

const removeDocBlockRoute = createRoute({
  method: "delete",
  path: "/api/v1/document-blocks/{blockId}",
  tags: ["firm-entities"],
  summary: "Strike a line off a document",
  description:
    "`removed_at`, not a delete — `bib_app` holds no DELETE grant on any table in this database.",
  request: { params: z.object({ blockId: z.string().uuid() }) },
  responses: {
    204: { description: "Struck off" },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such block on any document at this firm"),
    409: errorResponse("The letter is signed — its prose is frozen with its terms"),
  },
});

export function registerDocumentRoutes(app: OpenAPIHono<AppEnv>, deps: DocumentDeps): void {
  app.openapi(listEntitiesRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { reportingCurrency, entities } = await deps.firmEntities.list(s.tenantId);
    return c.json({ reportingCurrency, entities: entities.map(toFirmEntityBody) }, 200);
  });

  app.openapi(createEntityRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const created = await deps.firmEntities.create(
      {
        tenantId: s.tenantId,
        name: body.name,
        jurisdiction: body.jurisdiction,
        entityType: body.entityType,
        registeredAddress: body.registeredAddress,
        taxRegistration: body.taxRegistration,
        pan: body.pan,
        phone: body.phone,
        email: body.email,
        timeZone: body.timeZone,
        fiscalYearStartMonth: body.fiscalYearStartMonth,
      },
      s.actor,
    );
    return c.json(toFirmEntityBody(created), 201);
  });

  app.openapi(editEntityRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const saved = await deps.firmEntities.edit(
      {
        tenantId: s.tenantId,
        partyId: c.req.valid("param").entityPartyId,
        name: body.name,
        entityType: body.entityType,
        registeredAddress: body.registeredAddress,
        jurisdiction: body.jurisdiction,
        taxRegistration: body.taxRegistration,
        pan: body.pan,
        phone: body.phone,
        email: body.email,
        timeZone: body.timeZone,
        fiscalYearStartMonth: body.fiscalYearStartMonth,
      },
      s.actor,
    );
    return c.json(toFirmEntityBody(saved), 200);
  });

  app.openapi(listRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const rows = await deps.service.listPreferences(s.tenantId);
    return c.json(
      {
        preferences: rows.map((r) => ({
          id: r.preference.id,
          clientJurisdiction: r.preference.clientJurisdiction,
          firmEntityPartyId: r.preference.firmEntityPartyId,
          firmEntity: {
            id: r.entity.id,
            displayName: r.entity.displayName,
            jurisdiction: r.entity.jurisdiction,
          },
          note: r.preference.note,
        })),
      },
      200,
    );
  });

  app.openapi(setRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const saved = await deps.service.setPreference({ tenantId: s.tenantId, ...body }, s.actor);
    return c.json(
      {
        id: saved.preference.id,
        clientJurisdiction: saved.preference.clientJurisdiction,
        firmEntityPartyId: saved.preference.firmEntityPartyId,
        // The name as stored, not as the request spelled it.
        firmEntity: {
          id: saved.entity.id,
          displayName: saved.entity.displayName,
          jurisdiction: saved.entity.jurisdiction,
        },
        note: saved.preference.note,
      },
      200,
    );
  });
  app.openapi(listBlocksRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { issuingEntityPartyId } = c.req.valid("query");
    const blocks = await deps.service.listStandardBlocks(s.tenantId, issuingEntityPartyId);
    return c.json({ blocks: blocks.map(toStandardBlockBody) }, 200);
  });

  app.openapi(addBlockRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const saved = await deps.service.addStandardBlock(
      { tenantId: s.tenantId, ...c.req.valid("json") },
      s.actor,
    );
    return c.json(toStandardBlockBody(saved), 201);
  });

  app.openapi(editBlockRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const saved = await deps.service.editStandardBlock(
      s.tenantId,
      c.req.valid("param").blockId,
      c.req.valid("json"),
      s.actor,
    );
    return c.json(toStandardBlockBody(saved), 200);
  });

  app.openapi(addDocBlockRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const saved = await deps.service.addBlock({
      tenantId: s.tenantId,
      owner:
        body.proposalId === undefined
          ? { kind: "engagement_letter", id: body.engagementLetterId ?? "" }
          : { kind: "proposal", id: body.proposalId },
      kind: body.kind,
      body: body.body,
      isHeading: body.isHeading,
      sortOrder: body.sortOrder,
    });
    return c.json(toDocumentBlockBody(saved), 201);
  });

  app.openapi(editDocBlockRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const saved = await deps.service.editBlock(
      s.tenantId,
      c.req.valid("param").blockId,
      c.req.valid("json"),
    );
    return c.json(toDocumentBlockBody(saved), 200);
  });

  app.openapi(removeDocBlockRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    await deps.service.removeBlock(s.tenantId, c.req.valid("param").blockId);
    return c.body(null, 204);
  });
}

/** Field by field: zod-openapi does not validate responses, so a spread ships undocumented fields. */
function toStandardBlockBody(b: StandardBlock): {
  id: string;
  kind: BlockKind;
  body: string;
  isHeading: boolean;
  sortOrder: number;
  jurisdiction: string | null;
  issuingEntityPartyId: string | null;
  isActive: boolean;
} {
  return {
    id: b.id,
    kind: b.kind,
    body: b.body,
    isHeading: b.isHeading,
    sortOrder: b.sortOrder,
    jurisdiction: b.jurisdiction,
    issuingEntityPartyId: b.issuingEntityPartyId,
    isActive: b.isActive,
  };
}

function toDocumentBlockBody(b: DocumentBlock): {
  id: string;
  kind: BlockKind;
  body: string;
  isHeading: boolean;
  sortOrder: number;
  sourceId: string | null;
  isEdited: boolean;
} {
  return {
    id: b.id,
    kind: b.kind,
    body: b.body,
    isHeading: b.isHeading,
    sortOrder: b.sortOrder,
    sourceId: b.sourceId,
    isEdited: b.isEdited,
  };
}
