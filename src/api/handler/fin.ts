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
import type { IntakeRoute } from "../../domain/fin/intake";
import type { FinReadsDeps } from "./fin-reads";

/** Everything fin's routes need. Each fin handler file names its own part, so
 *  a new one is a type added here and a register call in the router. */
export interface FinDeps extends FinReadsDeps {
  readonly intake: FinIntakeService;
}

const MAX_INTAKE_LIMIT = 500;

const RouteEnum = z.enum(INTAKE_ROUTES as unknown as [string, ...string[]]);

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
    route: RouteEnum.openapi({
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

const SummarySchema = z
  .object({
    total: z.number().int(),
    byRoute: z.object({
      sheet: z.number().int(),
      pdf: z.number().int(),
      image: z.number().int(),
      archive: z.number().int(),
      manual: z.number().int(),
    }),
  })
  .openapi("FinIntakeSummary", {
    description:
      "How many files were taken in, by reader, for the same client filter as the list (never " +
      "for one page). `manual` is the number waiting for a person.",
  });

const statusRoute = createRoute({
  method: "get",
  path: "/api/v1/fin/status",
  tags: ["fin"],
  summary: "Whether FinCompliance is on for this firm",
  description:
    "200 with the day it was switched on, or 404 `FIN_NOT_ENABLED`. The staff app asks this " +
    "once to decide whether to show FinCompliance at all; a role without `books:read` gets " +
    "403 and does not see it either.",
  responses: {
    200: {
      description: "Fin is on",
      content: {
        "application/json": {
          schema: z.object({ enabledSince: z.string() }).openapi("FinStatus"),
        },
      },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or the role may not read the books"),
    404: errorResponse("FinCompliance is not switched on for this firm (FIN_NOT_ENABLED)"),
  },
});

const intakeRoute = createRoute({
  method: "get",
  path: "/api/v1/fin/intake",
  tags: ["fin"],
  summary: "Files FinCompliance has taken in, newest first",
  description:
    "Every file a client supplied for their books since fin was switched on for this firm, " +
    "with the reader it was sent to, a page at a time. Reading the files themselves is the " +
    "next stage; this list is what was taken in and where it went. `summary` counts the whole " +
    "filtered set, not the page.",
  request: {
    query: z.object({
      clientPartyId: z.string().uuid().optional().openapi({ description: "Only this client's files." }),
      route: RouteEnum.optional().openapi({
        description: "Only files sent to this reader. `manual` lists what waits for a person.",
      }),
      before: z.string().uuid().optional().openapi({
        description: "The `nextBefore` of the previous page. Absent for the newest page.",
      }),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(MAX_INTAKE_LIMIT)
        .optional()
        .openapi({ description: `How many to return (default 50, max ${String(MAX_INTAKE_LIMIT)})` }),
    }),
  },
  responses: {
    200: {
      description: "One page of the intake list, and the counts",
      content: {
        "application/json": {
          schema: z
            .object({
              items: z.array(IntakeItemSchema),
              summary: SummarySchema,
              nextBefore: z.string().uuid().nullable().openapi({
                description: "Pass as `before` for the next page; null on the last page.",
              }),
            })
            .openapi("FinIntakePage"),
        },
      },
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
  app.openapi(statusRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    return c.json(await deps.intake.status(s.tenantId), 200);
  });

  app.openapi(intakeRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const q = c.req.valid("query");
    const page = await deps.intake.intake(s.tenantId, {
      clientPartyId: q.clientPartyId ?? null,
      route: (q.route as IntakeRoute | undefined) ?? null,
      before: q.before ?? null,
      limit: q.limit ?? 50,
    });
    return c.json({ items: page.items.map(toWire), summary: page.summary, nextBefore: page.nextBefore }, 200);
  });
}
