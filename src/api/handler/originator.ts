// Who won the work of a letter, its ORIGINATOR (0355, Q049) — transport only.
// Registered by the dashboard's routes: it is the person the revenue report
// credits by originator. Reading it needs `party:read`; setting it is a
// partner's or an administrator's (`tenant:admin`, which the default Partner
// role holds), checked at the route by `api/permissions.ts`.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { scopeOf } from "../scope";
import type { OriginatorService } from "../../usecase/originator/service";
import type { LetterOriginatorRecord } from "../../usecase/originator/ports";

export interface OriginatorDeps {
  readonly service: OriginatorService;
}

const OriginatorSchema = z
  .object({
    letterId: z.string().uuid(),
    letterRef: z.string(),
    userId: z.string().uuid().nullable().openapi({ description: "Null: nobody." }),
    name: z.string().nullable(),
    activeStaff: z.boolean().openapi({ description: "False for a person who has left: their revenue stays theirs." }),
    how: z.enum(["set", "lead_owner", "proposal_preparer", "none"]).openapi({
      description:
        "`set` (a partner or an administrator said so), `lead_owner` (the deal's lead's owner), " +
        "`proposal_preparer` (who prepared the proposal), or `none`.",
    }),
    setAt: z.string().nullable().openapi({ description: "ISO 8601 UTC instant a person last set it; null while read off the deal." }),
    setBy: z.object({ userId: z.string().uuid(), name: z.string().nullable() }).nullable(),
  })
  .openapi("LetterOriginator");

const params = z.object({ letterId: z.string().uuid() });

const getRoute = createRoute({
  method: "get",
  path: "/api/v1/engagement-letters/{letterId}/originator",
  tags: ["engagement-letters"],
  summary: "Who won the work of this letter (its originator)",
  description:
    "The salesperson credited in the revenue report by originator (Q049): the person a partner or an " +
    "administrator set, else the owner of the deal's lead, else the colleague who prepared the " +
    "proposal, else nobody.",
  request: { params },
  responses: {
    200: { description: "The originator", content: { "application/json": { schema: OriginatorSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such letter at this firm"),
  },
});

const putRoute = createRoute({
  method: "put",
  path: "/api/v1/engagement-letters/{letterId}/originator",
  tags: ["engagement-letters"],
  summary: "Say who won the work of this letter",
  description:
    "A partner's or an administrator's (`tenant:admin`). `userId` null says nobody did (a renewal). " +
    "Active staff of this firm only (ORIGINATOR_NOT_STAFF, 409). Writes " +
    "`engagement_letter.originator_set` when it changes. The originator's revenue is read through " +
    "the letter, so this re-credits its invoices. Allowed on a signed letter: it is not a term the " +
    "client agreed to.",
  request: {
    params,
    body: {
      content: {
        "application/json": {
          schema: z.object({ userId: z.string().uuid().nullable() }).openapi("SetLetterOriginator"),
        },
      },
      required: true,
    },
  },
  responses: {
    200: { description: "Set", content: { "application/json": { schema: OriginatorSchema } } },
    400: errorResponse("Malformed request"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or not a partner or an administrator"),
    404: errorResponse("No such letter at this firm"),
    409: errorResponse("Not active staff here, or the letter was deleted as a mistake"),
  },
});

function body(r: LetterOriginatorRecord) {
  return {
    letterId: r.letterId,
    letterRef: r.letterRef,
    userId: r.userId,
    name: r.name,
    activeStaff: r.activeStaff,
    how: r.how,
    setAt: r.setAt,
    setBy: r.setBy === null ? null : { userId: r.setBy.userId, name: r.setBy.name },
  };
}

export function registerOriginatorRoutes(app: OpenAPIHono<AppEnv>, deps: OriginatorDeps): void {
  app.openapi(getRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    return c.json(body(await deps.service.get(s.tenantId, c.req.valid("param").letterId)), 200);
  });

  app.openapi(putRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const out = await deps.service.set(
      { tenantId: s.tenantId, letterId: c.req.valid("param").letterId, userId: c.req.valid("json").userId },
      s.actor,
    );
    return c.json(body(out), 200);
  });
}
