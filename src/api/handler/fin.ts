// FinCompliance's staff routes (docs/FIN_BUILD_PLAN.md F0.6) — transport only.
//
// Registered only when BIB_FIN_ENABLED is on (see `setup/fin.ts`); off, every
// /api/v1/fin path is a 404 because nothing is there. A firm without its own
// switch gets 404 too (`FIN_NOT_ENABLED`), from the service.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { scopeOf } from "../scope";
import type { FinIntakeService } from "../../usecase/fin/intake";
import type { IntakeItemView } from "../../usecase/fin/ports";
import { INTAKE_ROUTES } from "../../domain/fin/intake";

export interface FinDeps {
  readonly intake: FinIntakeService;
}

const MAX_INTAKE_LIMIT = 500;

const IntakeItemSchema = z
  .object({
    intakeItemId: z.string().uuid(),
    documentId: z.string().uuid(),
    documentVersionId: z.string().uuid(),
    title: z.string(),
    filename: z.string(),
    clientPartyId: z.string().uuid().nullable().openapi({
      description: "Whose file. Null when it was stored against no client.",
    }),
    clientName: z.string().nullable(),
    mediaType: z.string(),
    byteSize: z.number().int(),
    route: z.enum(INTAKE_ROUTES as unknown as [string, ...string[]]).openapi({
      description:
        "Which reader the file goes to. `manual` means no reader fits and a person reads it; " +
        "the file is never discarded.",
    }),
    routeBasis: z.enum(["media_type", "extension", "none"]).openapi({
      description:
        "What decided the route: the media type the upload declared, the filename's " +
        "extension when that type said nothing useful, or neither (`manual`).",
    }),
    takenAt: z.string().openapi({ description: "When fin took the file in (ISO 8601)." }),
  })
  .openapi("FinIntakeItem");

const intakeRoute = createRoute({
  method: "get",
  path: "/api/v1/fin/intake",
  tags: ["fin"],
  summary: "Files FinCompliance has taken in, newest first",
  description:
    "Every file a client supplied since fin was switched on for this firm, with the reader " +
    "it was sent to. Reading the files themselves is the next stage; this list is what was " +
    "taken in and where it went.",
  request: {
    query: z.object({
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(MAX_INTAKE_LIMIT)
        .optional()
        .openapi({ description: `How many to return (default 100, max ${String(MAX_INTAKE_LIMIT)})` }),
    }),
  },
  responses: {
    200: {
      description: "The intake list",
      content: { "application/json": { schema: z.object({ items: z.array(IntakeItemSchema) }) } },
    },
    400: errorResponse("Request failed validation"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or the role may not read the books"),
    404: errorResponse("FinCompliance is not switched on for this firm (FIN_NOT_ENABLED)"),
  },
});

function toWire(item: IntakeItemView) {
  return {
    intakeItemId: item.id,
    documentId: item.documentId,
    documentVersionId: item.documentVersionId,
    title: item.title,
    filename: item.filename,
    clientPartyId: item.clientPartyId,
    clientName: item.clientName,
    mediaType: item.mediaType,
    byteSize: item.byteSize,
    route: item.route,
    routeBasis: item.routeBasis,
    takenAt: item.takenAt,
  };
}

export function registerFinRoutes(app: OpenAPIHono<AppEnv>, deps: FinDeps): void {
  app.openapi(intakeRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { limit } = c.req.valid("query");
    const items = await deps.intake.recent(s.tenantId, limit ?? 100);
    return c.json({ items: items.map(toWire) }, 200);
  });
}
