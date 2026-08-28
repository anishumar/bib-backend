// The firm's issuing-entity rule, as a surface — transport only. Each route
// declares its wire shape and its handler parses, calls one use-case method,
// and maps the result field by field.
//
// THE TENANT COMES FROM THE SESSION, like every app-facing route.
//
// WHY THIS EXISTS AS ROUTES AT ALL. `crm.firm_entity_preference` is seeded with
// a fallback when a firm is created, and drafting reads it on every document —
// so it already has a writer and a reader. What it would not have without these
// two routes is any way for a firm to say "clients in Singapore are served by
// our Singapore entity", which is the entire reason the table is keyed on a
// country rather than being a single column. A rule nobody can change is a
// constant with extra steps.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { scopeOf } from "../scope";
import type { DocumentService } from "../../usecase/document/service";

export interface DocumentDeps {
  readonly service: DocumentService;
}

/** ISO 3166-1 alpha-2, or the wildcard that answers for every country the firm
 *  has named no entity for. Two characters either way, which is why the length
 *  check alone would let "**" through — the service normalises and validates. */
const JurisdictionKeySchema = z.string().min(1).max(2);

const PreferenceSchema = z
  .object({
    id: z.string().uuid(),
    /** The CLIENT's country, or `*` for the fallback. */
    clientJurisdiction: z.string(),
    firmEntityPartyId: z.string().uuid(),
    /** The entity by NAME — this screen is a table of country to company. */
    firmEntity: z.object({ id: z.string().uuid(), displayName: z.string() }),
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

export function registerDocumentRoutes(app: OpenAPIHono<AppEnv>, deps: DocumentDeps): void {
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
          firmEntity: { id: r.entity.id, displayName: r.entity.displayName },
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
        // The name as STORED, not as the request spelled it: the write's answer
        // is what the firm will read back.
        firmEntity: { id: saved.entity.id, displayName: saved.entity.displayName },
        note: saved.preference.note,
      },
      200,
    );
  });
}
