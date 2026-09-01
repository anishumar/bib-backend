// The freeze — the firm's own decision to stop chasing one client (T4.4).
// Transport only.
//
// ── THERE IS NO ROUTE THAT RUNS THE SWEEP, DELIBERATELY ──────────────────
//
// The chaser is a cron in the worker, like the escalation ladder and the
// obligation sweep. A "chase now" button would be a person telling the product
// to remind a client, which is a different act with a different actor and would
// make `client_ask.chased`'s SYSTEM actor a lie on some rows and not others.
// What a person does instead is raise an ask, which they already can.
//
// ── AND THE FREEZE IS ON THE CLIENT, WHICH IS WHERE THE ROUTES SIT ───────
//
// `/api/v1/clients/{partyId}/freeze` rather than `/api/v1/freezes`: a freeze is
// a fact about a client, it is read on that client's page, and a top-level
// collection would invite a list of every freeze the firm has — which is a
// screen nobody asked for and a query nobody needs.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { scopeOf } from "../scope";
import type { ChaserService } from "../../usecase/chaser/service";
import type { ClientFreezeRecord } from "../../usecase/chaser/ports";

export interface ChaserDeps {
  readonly service: ChaserService;
}

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PartyParam = z.object({ partyId: z.string().uuid() });
const FreezeParam = z.object({ freezeId: z.string().uuid() });

const FreezeSchema = z
  .object({
    freezeId: z.string().uuid(),
    clientPartyId: z.string().uuid(),
    clientName: z.string(),
    validFrom: IsoDate,
    validTo: IsoDate.nullable().openapi({
      description:
        "The FIRST DAY NOT IN FORCE, never the last day frozen. Null while it is still on. " +
        "Half-open like every other effective-dated row in this schema — two conventions in " +
        "one product is an off-by-one waiting for a handover.",
    }),
    reason: z.string().openapi({
      description:
        "Why. Required, because 'why is this client not being chased' is asked months later " +
        "by somebody who did not set it, and a freeze with no reason cannot be told apart " +
        "from one nobody remembered to lift. It is NOT in the ledger — it is a partner's " +
        "words about a client and that log cannot be erased.",
    }),
    setByName: z.string().nullable(),
    liftedByName: z.string().nullable(),
  })
  .openapi("ClientFreeze");

const SetFreezeRequest = z
  .object({
    validFrom: IsoDate.openapi({
      description: "The first day frozen, in the CALLER's calendar.",
    }),
    validTo: IsoDate.nullable().optional().openapi({
      description:
        "The first day NOT frozen, if the firm already knows when this ends. Null — the " +
        "ordinary case — means until somebody lifts it.",
    }),
    reason: z.string(),
  })
  .openapi("SetClientFreezeRequest");

const LiftFreezeRequest = z
  .object({
    on: IsoDate.optional().openapi({
      description:
        "The day chasing resumes, in the CALLER's calendar. Defaults to TODAY, so pressing " +
        "resume means the next sweep chases — not midnight. The row then understates the " +
        "freeze by part of a day and nothing is lost, because the ledger carries the instant.",
    }),
  })
  .openapi("LiftClientFreezeRequest");

const historyRoute = createRoute({
  method: "get",
  path: "/api/v1/clients/{partyId}/freezes",
  tags: ["chaser"],
  summary: "Every time this client's chasing has been stopped",
  description:
    "The whole history, newest first — not just the one in force. 'Was this client being " +
    "chased in March' is the question, and a list of only the current freeze answers it with " +
    "silence.",
  request: { params: PartyParam },
  responses: {
    200: {
      description: "The freezes",
      content: { "application/json": { schema: z.array(FreezeSchema) } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or the role may not read clients"),
  },
});

const setRoute = createRoute({
  method: "post",
  path: "/api/v1/clients/{partyId}/freezes",
  tags: ["chaser"],
  summary: "Stop chasing this client",
  description:
    "Stops the OUTWARD ladder only. The firm goes on hearing about its own late work through " +
    "the escalation ladder (T4.5), because a dispute is the worst possible moment to go blind " +
    "to that.",
  request: {
    params: PartyParam,
    body: { content: { "application/json": { schema: SetFreezeRequest } }, required: true },
  },
  responses: {
    201: { description: "Frozen", content: { "application/json": { schema: FreezeSchema } } },
    400: errorResponse("No reason, or dates that describe a freeze in force on no day"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or the role may not administer the firm"),
    404: errorResponse("No such client at this firm"),
    409: errorResponse("This client is already frozen over those days"),
  },
});

const liftRoute = createRoute({
  method: "post",
  path: "/api/v1/freezes/{freezeId}/lift",
  tags: ["chaser"],
  summary: "Start chasing this client again",
  request: {
    params: FreezeParam,
    body: { content: { "application/json": { schema: LiftFreezeRequest } }, required: false },
  },
  responses: {
    200: { description: "Lifted", content: { "application/json": { schema: FreezeSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or the role may not administer the firm"),
    404: errorResponse("No such freeze at this firm"),
    409: errorResponse("Already lifted"),
  },
});

export function registerChaserRoutes(app: OpenAPIHono<AppEnv>, deps: ChaserDeps): void {
  app.openapi(historyRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { partyId } = c.req.valid("param");
    const freezes = await deps.service.history(s.tenantId, partyId);
    return c.json(freezes.map(toWire), 200);
  });

  app.openapi(setRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { partyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const record = await deps.service.freeze({
      tenantId: s.tenantId,
      clientPartyId: partyId,
      validFrom: body.validFrom,
      validTo: body.validTo ?? null,
      reason: body.reason,
      actor: s.actor,
    });
    return c.json(toWire(record), 201);
  });

  app.openapi(liftRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { freezeId } = c.req.valid("param");
    const body = c.req.valid("json");
    const record = await deps.service.lift({
      tenantId: s.tenantId,
      freezeId,
      on: body?.on,
      actor: s.actor,
    });
    return c.json(toWire(record), 200);
  });
}

/** Field by field, never the domain object: zod-openapi documents a response
 *  without validating it, so a forwarded object ships fields the generated
 *  client cannot see. */
function toWire(r: ClientFreezeRecord): z.infer<typeof FreezeSchema> {
  return {
    freezeId: r.id,
    clientPartyId: r.clientPartyId,
    clientName: r.clientName,
    validFrom: r.validFrom,
    validTo: r.validTo,
    reason: r.reason,
    setByName: r.setByName,
    liftedByName: r.liftedByName,
  };
}
