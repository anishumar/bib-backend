// The FIRM's side of a client-directed ask (T6.6) — transport only.
//
// The client's side is `portalask.ts`, and the two are separate files for the
// same reason they are separate repositories: this one is the staff workspace
// under `withTenant`, that one is the client portal under `withPortal`, and a
// file holding both would eventually have a handler reach for the wrong one.
//
// ── THE ASK HANGS OFF A WORK ITEM, SO THAT IS WHERE IT IS RAISED ─────────
//
// `POST /api/v1/work-items/{workItemId}/asks` rather than `POST /api/v1/asks`
// with the work item in the body: the work item is not optional, and a path that
// made it look optional would invite a body that omitted it. Closing and
// withdrawing are `/api/v1/asks/{askId}/…` because by then the ask is the
// subject.
//
// ── AND THE CLIENT IS NEVER IN THE REQUEST ──────────────────────────────
//
// Nothing on this surface accepts a `clientPartyId`. It is read from the work
// item, inside the INSERT (see `PostgresClientAskRepository`), because it is the
// column gate 4 filters the row on — and a value no caller can supply is one
// fewer thing that has to be right.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { scopeOf } from "../scope";
import type { ClientAskService } from "../../usecase/clientask/service";
import type { AskRecord } from "../../domain/clientask/model";
import { ASK_KINDS } from "../../domain/clientask/model";
import { DOCUMENT_KINDS } from "../../domain/filestore/model";

export interface ClientAskDeps {
  readonly service: ClientAskService;
}

const WorkItemParam = z.object({ workItemId: z.string().uuid() });
const AskParam = z.object({ askId: z.string().uuid() });

const ResponseSchema = z
  .object({
    responseId: z.string().uuid(),
    responseKind: z.enum(["document", "answer", "decision"]),
    answerText: z.string().nullable(),
    decision: z.enum(["approved", "declined"]).nullable(),
    respondedByName: z.string().nullable().openapi({
      description:
        "The CLIENT's own person who replied. Null when their account has been erased — a " +
        "real answer, the same shape the ledger's actor join has.",
    }),
    respondedAt: z.string(),
    document: z
      .object({
        documentId: z.string().uuid(),
        filename: z.string(),
        byteSize: z.number().int(),
        mediaType: z.string(),
      })
      .nullable()
      .openapi({
        description:
          "The file, when one was sent. IT HAS NOT BEEN SCANNED: there is no virus scanner " +
          "in this product and no agent runtime to run one, so a client-supplied file is " +
          "stored exactly as it arrived. It is served with `content-disposition: attachment` " +
          "and never `inline`, which is the one protection that does exist, and the screen " +
          "says so beside the link rather than leaving somebody to assume otherwise.",
      }),
  })
  .openapi("ClientAskResponse");

const AskSchema = z
  .object({
    askId: z.string().uuid(),
    workItemId: z.string().uuid(),
    clientPartyId: z.string().uuid(),
    clientName: z.string(),
    askKind: z.enum(ASK_KINDS as unknown as [string, ...string[]]),
    prompt: z.string(),
    documentKind: z.string().nullable(),
    status: z.enum(["open", "answered", "closed", "withdrawn"]).openapi({
      description:
        "`answered` IS NOT `closed`. The client responding turns an ask answered; the FIRM " +
        "decides whether what arrived was what it needed. A client who sent last quarter's " +
        "register would otherwise see the ask marked done.",
    }),
    raisedByName: z.string().nullable(),
    raisedAt: z.string(),
    firstAnsweredAt: z.string().nullable().openapi({
      description:
        "When they FIRST replied, never restated by a later one. It is the number a firm " +
        "reaches for when a filing goes late.",
    }),
    closedByName: z.string().nullable(),
    closedAt: z.string().nullable(),
    responses: z.array(ResponseSchema),
  })
  .openapi("ClientAsk");

const RaiseRequest = z
  .object({
    askKind: z.enum(ASK_KINDS as unknown as [string, ...string[]]),
    prompt: z.string().openapi({
      description:
        "What you want, in your own words. The client reads it verbatim, under a line saying " +
        "whose words they are — it is the only field that says what is actually wanted.",
    }),
    documentKind: z
      .enum(DOCUMENT_KINDS as unknown as [string, ...string[]])
      .nullable()
      .optional()
      .openapi({
        description:
          "What the uploaded file gets FILED as. Required for a `document` ask and refused " +
          "on the other two — the client does not choose where in your document store their " +
          "file lands, you did when you asked.",
      }),
    // NO DUE DATE, and its absence is the API's own statement. No deadline this
    // product invented reaches a client: the firm has never given its turnaround
    // times, so "by Friday" would be a promise nobody made, quoted back at it.
  })
  .openapi("RaiseClientAskRequest");

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/work-items/{workItemId}/asks",
  tags: ["client-asks"],
  summary: "What has been asked of the client on this task",
  request: { params: WorkItemParam },
  responses: {
    200: {
      description: "The asks, newest first, each with everything the client sent back",
      content: { "application/json": { schema: z.array(AskSchema) } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or the role may not read clients"),
  },
});

const raiseRoute = createRoute({
  method: "post",
  path: "/api/v1/work-items/{workItemId}/asks",
  tags: ["client-asks"],
  summary: "Ask this task's client for something",
  description:
    "The row that says WE ARE WAITING ON YOU. Distinct from a blocked work item, whose reason " +
    "reads 'the client has not sent the register' as readily as 'the GST portal is down' — " +
    "this one is addressed to the client and has somewhere for them to answer it. Raising it " +
    "does NOT block the task: a task can be waiting on the client for one thing and moving on " +
    "three others, and coupling them would make that the product's opinion rather than yours.",
  request: {
    params: WorkItemParam,
    body: { content: { "application/json": { schema: RaiseRequest } }, required: true },
  },
  responses: {
    201: { description: "Raised", content: { "application/json": { schema: AskSchema } } },
    400: errorResponse("Empty prompt, unknown kind, or a documentKind that does not fit"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or the role may not write work"),
    404: errorResponse("No such work item at this firm"),
  },
});

const closeRoute = createRoute({
  method: "post",
  path: "/api/v1/asks/{askId}/close",
  tags: ["client-asks"],
  summary: "You got what you needed",
  request: { params: AskParam },
  responses: {
    200: { description: "Closed", content: { "application/json": { schema: AskSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or the role may not write work"),
    404: errorResponse("No such ask at this firm"),
    409: errorResponse("Already closed or withdrawn"),
  },
});

const withdrawRoute = createRoute({
  method: "post",
  path: "/api/v1/asks/{askId}/withdraw",
  tags: ["client-asks"],
  summary: "You no longer need it",
  description:
    "A different fact from closing, and kept apart on purpose: 'you sent it' and 'never mind' " +
    "are different answers to a client wondering whether they actually had to do that.",
  request: { params: AskParam },
  responses: {
    200: { description: "Withdrawn", content: { "application/json": { schema: AskSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or the role may not write work"),
    404: errorResponse("No such ask at this firm"),
    409: errorResponse("Already closed or withdrawn"),
  },
});

export function registerClientAskRoutes(app: OpenAPIHono<AppEnv>, deps: ClientAskDeps): void {
  app.openapi(listRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { workItemId } = c.req.valid("param");
    const asks = await deps.service.listForWorkItem(s.tenantId, workItemId);
    return c.json(asks.map(toWire), 200);
  });

  app.openapi(raiseRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { workItemId } = c.req.valid("param");
    const body = c.req.valid("json");
    const record = await deps.service.raise({
      tenantId: s.tenantId,
      workItemId,
      askKind: body.askKind,
      prompt: body.prompt,
      documentKind: body.documentKind ?? null,
      actor: s.actor,
    });
    return c.json(toWire(record), 201);
  });

  app.openapi(closeRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { askId } = c.req.valid("param");
    const record = await deps.service.close({ tenantId: s.tenantId, askId, actor: s.actor });
    return c.json(toWire(record), 200);
  });

  app.openapi(withdrawRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { askId } = c.req.valid("param");
    const record = await deps.service.withdraw({ tenantId: s.tenantId, askId, actor: s.actor });
    return c.json(toWire(record), 200);
  });
}

/** Field by field, never the domain object: zod-openapi documents a response
 *  without validating it, so a forwarded object ships fields the generated
 *  client cannot see. */
export function toWire(r: AskRecord): z.infer<typeof AskSchema> {
  return {
    askId: r.ask.id,
    workItemId: r.ask.workItemId,
    clientPartyId: r.ask.clientPartyId,
    clientName: r.clientName,
    askKind: r.ask.askKind,
    prompt: r.ask.prompt,
    documentKind: r.ask.documentKind,
    status: r.ask.status,
    raisedByName: r.raisedByName,
    raisedAt: r.ask.raisedAt,
    firstAnsweredAt: r.ask.firstAnsweredAt,
    closedByName: r.closedByName,
    closedAt: r.ask.closedAt,
    responses: r.responses.map((x) => ({
      responseId: x.response.id,
      responseKind: x.response.responseKind,
      answerText: x.response.answerText,
      decision: x.response.decision,
      respondedByName: x.respondedByName,
      respondedAt: x.response.respondedAt,
      document: x.document,
    })),
  };
}
