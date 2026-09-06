// The FIRM's side of a client's own request (T6.8) — transport only.
//
// The client's side is `portalrequest.ts`, and the two are separate files for
// the same reason they are separate repositories: this one is the staff
// workspace under `withTenant`, that one is the client portal under
// `withPortal`, and a file holding both would eventually have a handler reach
// for the wrong one.
//
// ── THE PATH HAS NO PARENT IN IT, AND THAT IS THE WHOLE FEATURE ──────────
//
// An ask is raised at `POST /api/v1/work-items/{workItemId}/asks` because it
// cannot exist without a work item. A client's request hangs off NOTHING — no
// work item, no engagement, no obligation, and it may never get one — so the
// firm's routes are flat: `/api/v1/client-requests`. A path that invented a
// parent would be the API asserting something 0068 spent a header refusing.
//
// ── AND THE LIST IS ONE LIST ────────────────────────────────────────────
//
// No `?clientPartyId=`, no `?assignedTo=`. The inbox has no routing (0068,
// Shrestha 2026-09-02) because the firm has not said who an inbound request
// belongs to, and a filter parameter shipped ahead of that decision is the API
// implying an answer. When the rule arrives it is a query parameter and an
// index, not a rewrite.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { scopeOf } from "../scope";
import type { ClientRequestService } from "../../usecase/clientrequest/service";
import type { ClientRequestRecord } from "../../domain/clientrequest/model";
import {
  awaitsFirm,
  REQUEST_ROUTINGS,
  REQUEST_STATUSES,
} from "../../domain/clientrequest/model";

export interface ClientRequestDeps {
  readonly service: ClientRequestService;
}

const RequestParam = z.object({ requestId: z.string().uuid() });

const ReplySchema = z
  .object({
    replyId: z.string().uuid(),
    authorSide: z.enum(["firm", "client"]).openapi({
      description:
        "Which side wrote it. On the row rather than derived from the author's account — an " +
        "account whose membership changes would otherwise switch sides in an old " +
        "conversation — and a portal session cannot write 'firm' at all (0068).",
    }),
    authorName: z.string().nullable().openapi({
      description:
        "Who wrote it. Null when the account has been erased — a real answer, the same shape " +
        "the ledger's actor join has.",
    }),
    body: z.string(),
    writtenAt: z.string(),
    document: z
      .object({
        documentId: z.string().uuid(),
        title: z.string(),
        filename: z.string(),
        byteSize: z.number().int(),
        mediaType: z.string(),
      })
      .nullable()
      .openapi({
        description:
          "What the firm attached, if anything. Always a document already filed against this " +
          "client — attaching it also made it visible to them in the library (0066), because " +
          "sending a document to a client IS the decision to show it to them.",
      }),
  })
  .openapi("ClientRequestReply");

const RequestSchema = z
  .object({
    requestId: z.string().uuid(),
    clientPartyId: z.string().uuid().openapi({
      description:
        "WHICH client, as an id. On the FIRM's side only — the portal's copy of this shape " +
        "does not carry it, because a client reading their own page has no use for their own " +
        "party id. Here the screen genuinely needs it: replying may attach a document already " +
        "filed against this client, and `GET /documents?partyId=` is how that list is found.",
    }),
    clientName: z.string().openapi({
      description:
        "WHICH of the firm's clients this came from. The inbox has no routing, so this is " +
        "what tells one row from another at a glance.",
    }),
    subject: z.string(),
    body: z.string(),
    status: z.enum(REQUEST_STATUSES as unknown as [string, ...string[]]).openapi({
      description:
        "`open` — you have not replied. `answered` — you have, and it is not finished. " +
        "`closed` — YOU are done with it. `withdrawn` — THE CLIENT took it back. The last " +
        "two are the two endings and they belong to opposite sides.",
    }),
    awaitingFirm: z.boolean().openapi({
      description:
        "Whether the ball is in your court: nobody has replied, or the CLIENT spoke last. " +
        "Deliberately not folded into `status` — a client's follow-up does not walk " +
        "`answered` back to `open`, because that status means 'the firm has come back at " +
        "least once' and is the same fact as first_replied_at being set.",
    }),
    raisedByName: z.string().nullable().openapi({
      description:
        "WHO at the client wrote it. A company with two directors asking for different " +
        "things is two conversations.",
    }),
    raisedAt: z.string(),
    assignee: z
      .object({
        userId: z.string().uuid(),
        displayName: z.string().nullable(),
        email: z.string(),
      })
      .nullable()
      .openapi({
        description:
          "WHOSE DESK it is on. Null is ORDINARY: the firm may route nothing (the default), or " +
          "the rule may have run and found nobody — `assignmentNote` is what tells those two " +
          "apart, and is null in the first case because nothing failed. " +
          "ALL THREE FIELDS, which is the shape the escalation queue and the ledger's actor " +
          "both use: `display_name` is nullable on an account and genuinely empty at seeded " +
          "firms, so a screen given only the name renders a blank space and turns 'somebody we " +
          "hold no name for' into 'nobody'. The EMAIL is the discriminator, and the userId is " +
          "what a screen compares against the reader to answer 'is this mine'.",
      }),
    assignmentNote: z.string().nullable().openapi({
      description:
        "Why NOBODY, when the rule ran and could not name somebody — and it names the FIX, " +
        "not the failure. Never set beside an assignee: the database refuses the pair.",
    }),
    settledByName: z.string().nullable(),
    settledAt: z.string().nullable(),
    replies: z.array(ReplySchema),
  })
  .openapi("ClientRequest");

const ReplyRequest = z
  .object({
    body: z.string().min(1).openapi({
      description:
        "What you are telling them. Required even when a document is attached: a file " +
        "arriving with no sentence beside it makes the client guess which of the things they " +
        "asked for it is.",
    }),
    documentId: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .openapi({
        description:
          "A document ALREADY FILED against this client, which this reply sends them. Not an " +
          "upload — file it first, against the client, which is the ordinary act and leaves " +
          "it where the rest of their papers are. Another client's document, or one of your " +
          "own working papers (whose party is null), is refused: 404.",
      }),
  })
  .openapi("ReplyToClientRequestRequest");

const Routing = z.enum(REQUEST_ROUTINGS as unknown as [string, ...string[]]);

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/client-requests",
  tags: ["client-requests"],
  summary: "What clients have asked YOU for",
  description:
    "The firm-wide inbox of requests clients raised themselves, newest first. `awaitingFirm` " +
    "is the flag to work from, and `routing` says whether this firm places them on anybody's " +
    "desk automatically. `state=finished` reads the ARCHIVE instead — what was closed or " +
    "withdrawn, which the inbox drops and which nothing else could read.",
  request: {
    query: z.object({
      state: z
        .enum(["live", "finished"])
        .optional()
        .openapi({
          description:
            "`live` (the default) is the work queue: open and answered. `finished` is its " +
            "complement — closed by the firm, withdrawn by the client. Two lists rather than " +
            "one flag on every row because they are two jobs: one is worked, the other is " +
            "looked up.",
        }),
    }),
  },
  responses: {
    200: {
      description: "The live requests with their threads, and the firm's routing setting",
      content: {
        "application/json": {
          schema: z.object({
            requests: z.array(RequestSchema),
            routing: Routing.openapi({
              description:
                "WHAT THIS FIRM DOES WITH AN ARRIVING REQUEST. It travels with the list for " +
                "T4.5's `ladderPublished` reason: an inbox where nothing is assigned because " +
                "the firm routes nothing, and one where the rule ran and placed nothing, are " +
                "the same picture — and only one of them is somebody's to fix.",
            }),
          }),
        },
      },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or the role may not read clients"),
  },
});

const readRoute = createRoute({
  method: "get",
  path: "/api/v1/client-requests/{requestId}",
  tags: ["client-requests"],
  summary: "One request and its thread",
  request: { params: RequestParam },
  responses: {
    200: { description: "The request", content: { "application/json": { schema: RequestSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or the role may not read clients"),
    404: errorResponse("No such request at this firm"),
  },
});

const replyRoute = createRoute({
  method: "post",
  path: "/api/v1/client-requests/{requestId}/replies",
  tags: ["client-requests"],
  summary: "Answer the client",
  description:
    "Adds your message to the thread and, the first time, moves the request to `answered`. " +
    "Replying does NOT close it — a client sent the wrong year's balance sheet has to be able " +
    "to say so without opening a second request.",
  request: {
    params: RequestParam,
    body: { content: { "application/json": { schema: ReplyRequest } }, required: true },
  },
  responses: {
    201: { description: "Replied", content: { "application/json": { schema: RequestSchema } } },
    400: errorResponse("Empty reply"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or the role may not write work"),
    404: errorResponse("No such request, or no such document filed against this client"),
    409: errorResponse("Already closed or withdrawn"),
  },
});

const closeRoute = createRoute({
  method: "post",
  path: "/api/v1/client-requests/{requestId}/close",
  tags: ["client-requests"],
  summary: "You are done with it",
  description:
    "The FIRM's ending. There is no withdraw route here: taking a request back is the " +
    "client's own act, and 'we decided you did not need this' is a refusal, which is a close " +
    "with a reply saying so.",
  request: { params: RequestParam },
  responses: {
    200: { description: "Closed", content: { "application/json": { schema: RequestSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or the role may not write work"),
    404: errorResponse("No such request at this firm"),
    409: errorResponse("Already closed or withdrawn"),
  },
});

const AssignRequest = z
  .object({
    assigneeUserId: z
      .string()
      .uuid()
      .nullable()
      .openapi({
        description:
          "Whose desk it goes on. NULL takes it off one — there is no separate unassign route, " +
          "because assigning and unassigning are one act with two ends and the name and the " +
          "note have to move together.",
      }),
  })
  .openapi("AssignClientRequestRequest");

const assignRoute = createRoute({
  method: "put",
  path: "/api/v1/client-requests/{requestId}/assignee",
  tags: ["client-requests"],
  summary: "Put it on somebody's desk, or take it off one",
  description:
    "ALWAYS AVAILABLE, whatever the firm's routing setting says. A firm that routes nothing " +
    "still needs to say whose a request is, and a firm that routes to the Key Manager still " +
    "needs somebody to take one that landed on the wrong desk — the rule is a default, not a " +
    "wall. Taking a request off a desk clears the routing note with it: a person unassigning " +
    "has explained it by doing it, and the rule's old sentence would then be saying the " +
    "request is unplaced for a reason that is no longer why.",
  request: {
    params: RequestParam,
    body: { content: { "application/json": { schema: AssignRequest } }, required: true },
  },
  responses: {
    200: { description: "Assigned", content: { "application/json": { schema: RequestSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or the role may not write work"),
    404: errorResponse("No such request at this firm"),
    409: errorResponse("Already closed or withdrawn, or that person does not work here"),
  },
});

const setRoutingRoute = createRoute({
  method: "put",
  path: "/api/v1/tenancy/client-request-routing",
  tags: ["client-requests"],
  summary: "How an arriving client request is routed",
  description:
    "`none` routes nothing and is the DEFAULT — a real answer, not 'unconfigured', and " +
    "exactly the behaviour this product had before the setting existed. `key_manager` places " +
    "a new request on the desk of that client's Key Manager, and leaves it UNASSIGNED with a " +
    "sentence when the client has none.\n\n" +
    "A SPOC is not an option and cannot become one: a SPOC covers a Dept or a delivery team, " +
    "a request names no service, and picking an axis for it would be this product deciding " +
    "something the firm never said.\n\n" +
    "CHANGING IT RESTATES NOTHING. Requests already on a desk keep their assignee; the next " +
    "one is routed the new way.",
  request: {
    body: {
      content: { "application/json": { schema: z.object({ routing: Routing }) } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "The setting now in force",
      content: { "application/json": { schema: z.object({ routing: Routing }) } },
    },
    400: errorResponse("Not one of none / key_manager"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or the role may not administer the firm"),
  },
});

export function registerClientRequestRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: ClientRequestDeps,
): void {
  app.openapi(listRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { state } = c.req.valid("query");
    const inbox = await deps.service.inbox(s.tenantId, state ?? "live");
    return c.json({ requests: inbox.requests.map(toWire), routing: inbox.routing }, 200);
  });

  app.openapi(readRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { requestId } = c.req.valid("param");
    return c.json(toWire(await deps.service.find(s.tenantId, requestId)), 200);
  });

  app.openapi(replyRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { requestId } = c.req.valid("param");
    const { body, documentId } = c.req.valid("json");
    const record = await deps.service.replyAsFirm({
      tenantId: s.tenantId,
      requestId,
      body,
      documentId: documentId ?? null,
      actor: s.actor,
    });
    return c.json(toWire(record), 201);
  });

  app.openapi(assignRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { requestId } = c.req.valid("param");
    const { assigneeUserId } = c.req.valid("json");
    const record = await deps.service.assign({
      tenantId: s.tenantId,
      requestId,
      assigneeUserId,
      actor: s.actor,
    });
    return c.json(toWire(record), 200);
  });

  app.openapi(setRoutingRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { routing } = c.req.valid("json");
    return c.json({ routing: await deps.service.setRouting(s.tenantId, routing, s.actor) }, 200);
  });

  app.openapi(closeRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { requestId } = c.req.valid("param");
    const record = await deps.service.close({
      tenantId: s.tenantId,
      requestId,
      actor: s.actor,
    });
    return c.json(toWire(record), 200);
  });
}

/**
 * Field by field, and never the domain object.
 *
 * zod-openapi documents a response without validating it, so a forwarded object
 * ships fields the generated client cannot see — and would ship `tenantId` and
 * both user-account ids to a screen that has no use for any of them.
 *
 * `clientPartyId` DOES go out on this side, and only on this side. The firm's
 * screen needs it to list the documents filed against that client when a reply
 * attaches one; the portal's copy of the same row drops it, because a client
 * reading their own page has no use for their own party id.
 */
function toWire(record: ClientRequestRecord) {
  return {
    requestId: record.request.id,
    clientPartyId: record.request.clientPartyId,
    clientName: record.clientName,
    subject: record.request.subject,
    body: record.request.body,
    status: record.request.status,
    awaitingFirm: awaitsFirm(record),
    raisedByName: record.raisedByName,
    raisedAt: record.request.raisedAt,
    assignee:
      record.request.assigneeUserId === null
        ? null
        : {
            userId: record.request.assigneeUserId,
            displayName: record.assigneeName,
            email: record.assigneeEmail ?? "",
          },
    assignmentNote: record.request.assignmentNote,
    settledByName: record.settledByName,
    settledAt: record.request.settledAt,
    replies: record.replies.map((r) => ({
      replyId: r.reply.id,
      authorSide: r.reply.authorSide,
      authorName: r.authorName,
      body: r.reply.body,
      writtenAt: r.reply.writtenAt,
      document: r.document,
    })),
  };
}
