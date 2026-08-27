// Ledger HTTP surface — READ ONLY, and that is a design statement, not an
// omission. Events are written by the services that cause them, in our own
// vocabulary, naming their own actor; an HTTP endpoint that let a caller post
// an arbitrary event would make the audit trail unfalsifiable in exactly the
// way an audit trail must not be. So there is no POST here.
//
// Two reads, the two questions the log is asked: "what happened at this firm
// lately" and "everything that ever happened to this object". Both live on the
// /internal surface with tenantId in the path, matching the tenancy and party
// precedent — the app-facing wrapper that derives tenantId from the caller's
// membership arrives with T1.6/T1.7.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z, errorResponse } from "../openapi";
import { MAX_TIMELINE_LIMIT } from "../../usecase/ledger/service";
import type { LedgerService } from "../../usecase/ledger/service";

export interface LedgerDeps {
  readonly service: LedgerService;
}

const EventSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    actorType: z.enum(["human", "agent", "system"]),
    actorId: z.string().uuid().nullable(),
    verb: z.string(),
    objectType: z.string(),
    objectId: z.string().uuid(),
    payload: z.record(z.unknown()),
    occurredAt: z.string(),
    recordedAt: z.string(),
  })
  .openapi("Event");

const EventListSchema = z.object({ events: z.array(EventSchema) }).openapi("EventList");

const TenantParam = z.object({ tenantId: z.string().uuid() });
const ObjectParam = z.object({
  tenantId: z.string().uuid(),
  objectType: z.string().min(1),
  objectId: z.string().uuid(),
});

const tenantTimelineRoute = createRoute({
  method: "get",
  path: "/internal/v1/tenants/{tenantId}/events",
  tags: ["ledger"],
  summary: "The tenant's event timeline, newest first",
  request: {
    params: TenantParam,
    query: z.object({
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(MAX_TIMELINE_LIMIT)
        .optional()
        .openapi({ description: `How many events to return (max ${String(MAX_TIMELINE_LIMIT)})` }),
    }),
  },
  responses: {
    200: { description: "Events", content: { "application/json": { schema: EventListSchema } } },
    400: errorResponse("Request failed validation"),
  },
});

const objectTimelineRoute = createRoute({
  method: "get",
  path: "/internal/v1/tenants/{tenantId}/objects/{objectType}/{objectId}/events",
  tags: ["ledger"],
  summary: "Everything that ever happened to one object, newest first",
  request: { params: ObjectParam },
  responses: {
    200: { description: "Events", content: { "application/json": { schema: EventListSchema } } },
    400: errorResponse("Request failed validation"),
  },
});

export function registerLedgerRoutes(app: OpenAPIHono, deps: LedgerDeps): void {
  app.openapi(tenantTimelineRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const { limit } = c.req.valid("query");
    const events = await deps.service.recent(tenantId, limit);
    return c.json({ events: [...events] }, 200);
  });

  app.openapi(objectTimelineRoute, async (c) => {
    const { tenantId, objectType, objectId } = c.req.valid("param");
    const events = await deps.service.forObject(tenantId, objectType, objectId);
    return c.json({ events: [...events] }, 200);
  });
}
