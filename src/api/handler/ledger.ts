// Ledger HTTP surface — READ ONLY, and that is a design statement, not an
// omission. Events are written by the services that cause them, in our own
// vocabulary, naming their own actor; an HTTP endpoint that let a caller post
// an arbitrary event would make the audit trail unfalsifiable in exactly the
// way an audit trail must not be. So there is no POST here.
//
// Two reads, the two questions the log is asked: "what happened at this firm
// lately" and "everything that ever happened to this object".
//
// THE TENANT COMES FROM THE SESSION. These routes shipped on /internal with
// tenantId as a path parameter and no authentication at all, which meant any
// caller could read any firm's audit trail by naming it — RLS scoped the query
// perfectly, to the tenant the ATTACKER supplied. The wall was never the
// problem; handing the caller the key to it was.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { scopeOf } from "../scope";
import { MAX_TIMELINE_LIMIT } from "../../usecase/ledger/service";
import type { EventRecord } from "../../usecase/ledger/ports";
import type { LedgerService } from "../../usecase/ledger/service";
import type { AuthzService } from "../../usecase/authz/service";
import type { Principal } from "../../platform/callctx";
import { payloadWithoutFees } from "../../domain/ledger/fees";

export interface LedgerDeps {
  readonly service: LedgerService;
  /**
   * The FEE AXIS only (B08, audit 2026-10-03). A payment's amount, a credit
   * note's, what a bill was raised at: the timeline carries money, and for a
   * login that cannot see fees each verb's money fields are null on the way
   * out (`domain/ledger/fees.ts` names them). Gate 3 is middleware.
   */
  readonly authz: AuthzService;
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
    payload: z.record(z.unknown()).openapi({
      description:
        "The facts the event recorded. For a login that does not see fees, each money field " +
        "(an amount paid, credited, billed or owed, an exchange rate, a discount) is null.",
    }),
    occurredAt: z.string(),
    recordedAt: z.string(),
  })
  .openapi("Event");

/**
 * An event with the person who caused it.
 *
 * The stored row names its actor by id and always will — personal data stays
 * out of a log erasure cannot mutate. The name is joined at READ time from the
 * account as it stands now, so an erased account simply stops resolving while
 * the event survives, and a screen shows who did something instead of
 * `human/9895d76d…`.
 */
const EventRecordSchema = z
  .object({
    event: EventSchema,
    actor: z
      .object({
        userId: z.string().uuid(),
        displayName: z.string().nullable(),
        email: z.string().email(),
      })
      .nullable(),
  })
  .openapi("EventRecord");

const EventListSchema = z.object({ events: z.array(EventRecordSchema) }).openapi("EventList");

const ObjectParam = z.object({
  objectType: z.string().min(1),
  objectId: z.string().uuid(),
});

const tenantTimelineRoute = createRoute({
  method: "get",
  path: "/api/v1/events",
  tags: ["ledger"],
  summary: "The tenant's event timeline, newest first",
  request: {
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
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org"),
  },
});

const objectTimelineRoute = createRoute({
  method: "get",
  path: "/api/v1/objects/{objectType}/{objectId}/events",
  tags: ["ledger"],
  summary: "Everything that ever happened to one object, newest first",
  request: { params: ObjectParam },
  responses: {
    200: { description: "Events", content: { "application/json": { schema: EventListSchema } } },
    400: errorResponse("Request failed validation"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org"),
  },
});

/** Named field by field, so a field added to the read model cannot reach the
 *  wire without also reaching the spec (B48: this said so over two spreads).
 *  `fees` false nulls the verb's money (B08). */
function toRecordBody(record: EventRecord, fees: boolean): z.infer<typeof EventRecordSchema> {
  const e = record.event;
  return {
    event: {
      id: e.id,
      tenantId: e.tenantId,
      actorType: e.actorType,
      actorId: e.actorId,
      verb: e.verb,
      objectType: e.objectType,
      objectId: e.objectId,
      payload: fees ? { ...e.payload } : payloadWithoutFees(e.verb, e.payload),
      occurredAt: e.occurredAt,
      recordedAt: e.recordedAt,
    },
    actor:
      record.actor === null
        ? null
        : { userId: record.actor.userId, displayName: record.actor.displayName, email: record.actor.email },
  };
}

export function registerLedgerRoutes(app: OpenAPIHono<AppEnv>, deps: LedgerDeps): void {
  const seesFees = (principal: Principal | null): boolean =>
    principal !== null && deps.authz.seesFees(principal);

  app.openapi(tenantTimelineRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { limit } = c.req.valid("query");
    const events = await deps.service.recent(s.tenantId, limit);
    const fees = seesFees(c.get("principal"));
    return c.json({ events: events.map((e) => toRecordBody(e, fees)) }, 200);
  });

  app.openapi(objectTimelineRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { objectType, objectId } = c.req.valid("param");
    const events = await deps.service.forObject(s.tenantId, objectType, objectId);
    const fees = seesFees(c.get("principal"));
    return c.json({ events: events.map((e) => toRecordBody(e, fees)) }, 200);
  });
}
