// The CLIENT's side of their own request (T6.8) — transport only.
//
// ── THE FIRST PORTAL ROUTE THAT CREATES SOMETHING ───────────────────────
//
// Every portal write before this one answered something the firm had already
// raised: an upload against an ask, a reply to a question, a decision on an
// approval. This one starts a sentence, and the checklist for adding it is the
// same four things T6.6 named, with the third changed:
//
//   · an entry in `PORTAL_PATHS` — gate 2 is denied by default
//   · an entry in `ROUTE_PERMISSIONS` — gate 3 is denied by default too
//   · `portal:request` on the acts, which is a SECOND portal permission rather
//     than a widening of `portal:respond`: "may send us what we asked for" and
//     "may ask us for things" are different authorities, and a firm that wants
//     its registers clerk sending files and not opening requests has to be able
//     to say so (0069). Reading is not behind it — the grant authorises that.
//   · the query through `withPortal` — never `withTenant` — with a RESTRICTIVE
//     policy on every table it touches, covering the WRITES (0068)
//
// ── AND THE COMPANY IS IN THE REQUEST BODY, WHICH IS NEW ────────────────
//
// `portalask.ts` says of itself that nothing on that surface accepts a
// `clientPartyId`. This one must: a contact granted three of the firm's
// companies has to say which one they are writing about, and there is no parent
// row to read it from. What refuses a wrong value is 0068's `WITH CHECK`, in
// the database. The service checks it against the session's scope first so the
// refusal is a sentence rather than a 500 — see `ClientRequestService.raise`,
// which says which of the two is the wall.
//
// ── IT REFUSES A STAFF SESSION ──────────────────────────────────────────
//
// A colleague holds no portal grants, so this would answer "you have asked us
// for nothing" rather than "you are looking at the wrong app". A wrong answer
// that looks right is worse than a refusal. Since 0064 there is a second,
// independent answer for the acts — a staff role declares the STAFF audience
// and carries no `portal:request` — and this check stays because the LIST needs
// no permission and would otherwise be answered.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { toEnvelope } from "../httpresp";
import { scopeOf } from "../scope";
import type { ClientRequestService } from "../../usecase/clientrequest/service";
import type { PortalRequestRow } from "../../domain/clientrequest/model";
import { REQUEST_STATUSES } from "../../domain/clientrequest/model";

export interface PortalRequestDeps {
  readonly service: ClientRequestService;
}

const RequestParam = z.object({ requestId: z.string().uuid() });

const ReplySchema = z
  .object({
    replyId: z.string().uuid(),
    authorSide: z.enum(["firm", "client"]),
    authorName: z.string().nullable().openapi({
      description:
        "Which of YOUR people wrote it — and NULL on everything the firm wrote. Nobody at " +
        "the firm is named anywhere on this surface: it is not the client's business whose " +
        "desk their work is on, and a name here invites chasing a junior directly.",
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
          "What the firm sent you. It is in your documents library too — sending it is what " +
          "made it visible there. The bytes come from the library's own download route.",
      }),
  })
  .openapi("PortalRequestReply");

const RequestSchema = z
  .object({
    requestId: z.string().uuid(),
    companyName: z.string().nullable(),
    subject: z.string(),
    body: z.string(),
    status: z.enum(REQUEST_STATUSES as unknown as [string, ...string[]]).openapi({
      description:
        "`open` — the firm has not replied yet. `answered` — it has. `closed` — the firm is " +
        "done with it. `withdrawn` — you took it back.",
    }),
    raisedAt: z.string(),
    lastRepliedAt: z.string().nullable().openapi({
      description: "When the firm last came back, or null if it has not.",
    }),
    replies: z.array(ReplySchema),
  })
  .openapi("PortalRequest");

const RaiseRequest = z
  .object({
    clientPartyId: z.string().uuid().openapi({
      description:
        "WHICH of your companies this is about. Required, and required to be one you have " +
        "been granted — the database refuses any other, which is a 404 here.",
    }),
    subject: z.string().min(1).openapi({
      description: "One line. It is what the firm's inbox shows.",
    }),
    body: z.string().min(1).openapi({
      description:
        "What you need. Required: a subject with nothing under it has somebody at the firm " +
        "ringing to ask what it meant, which is the call this is here to replace.",
    }),
    // NO DUE DATE, and its absence is the API's own statement — in both
    // directions now. The firm has never published its turnaround times, so
    // there is nothing for a client to be promised; and letting a client set
    // one would have them promising on the firm's behalf.
  })
  .openapi("RaisePortalRequestRequest");

const ReplyRequest = z
  .object({ body: z.string().min(1) })
  .openapi("ReplyToPortalRequestRequest");

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/portal/requests",
  tags: ["portal"],
  summary: "What you have asked the firm for",
  description:
    "Everything you have raised, including the finished ones — 'did I already ask for this' " +
    "is the question that stops the second phone call. Split into what the firm has not come " +
    "back on, what it has, and what is done.",
  responses: {
    200: {
      description: "Your requests",
      content: {
        "application/json": {
          schema: z.object({
            awaitingFirm: z.array(RequestSchema),
            replied: z.array(RequestSchema),
            settled: z.array(RequestSchema),
          }),
        },
      },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("Not a client-portal session"),
  },
});

const raiseRoute = createRoute({
  method: "post",
  path: "/api/v1/portal/requests",
  tags: ["portal"],
  summary: "Ask the firm for something",
  description:
    "The first thing on this portal you can START rather than answer. A document you cannot " +
    "find, a copy of something, a correction, a call. It is not attached to any of the firm's " +
    "tasks and it may never become one — that is the firm's decision after it reads this.",
  request: {
    body: { content: { "application/json": { schema: RaiseRequest } }, required: true },
  },
  responses: {
    201: { description: "Raised", content: { "application/json": { schema: RequestSchema } } },
    400: errorResponse("Empty subject or body"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("Not a client-portal session, or this contact may only look"),
    404: errorResponse("Not one of the companies you were granted"),
  },
});

const replyRoute = createRoute({
  method: "post",
  path: "/api/v1/portal/requests/{requestId}/replies",
  tags: ["portal"],
  summary: "Add to the conversation",
  description:
    "Most often because what came back was not what you meant. It does not change the " +
    "request's status — the firm's screen shows who spoke last.",
  request: {
    params: RequestParam,
    body: { content: { "application/json": { schema: ReplyRequest } }, required: true },
  },
  responses: {
    201: { description: "Sent", content: { "application/json": { schema: RequestSchema } } },
    400: errorResponse("Empty reply"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("Not a client-portal session, or this contact may only look"),
    404: errorResponse("No such request of yours"),
    409: errorResponse("Already closed or withdrawn"),
  },
});

const withdrawRoute = createRoute({
  method: "post",
  path: "/api/v1/portal/requests/{requestId}/withdraw",
  tags: ["portal"],
  summary: "Never mind — take it back",
  description:
    "Yours to do, and the firm cannot do it for you: 'we decided you did not need this' is a " +
    "refusal, and the firm has to close it with a reply saying so instead.",
  request: { params: RequestParam },
  responses: {
    200: { description: "Withdrawn", content: { "application/json": { schema: RequestSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("Not a client-portal session, or this contact may only look"),
    404: errorResponse("No such request of yours"),
    409: errorResponse("Already closed or withdrawn"),
  },
});

export function registerPortalRequestRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: PortalRequestDeps,
): void {
  app.openapi(listRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const staff = refuseStaff(c.get("principal")?.audience);
    if (staff) return c.json(staff, 403);
    // No `asOf` on any portal request route (F-07-1): the grants are resolved
    // on the firm's own day by the grant module.
    const list = await deps.service.mine(s.tenantId, s.userId);
    return c.json(
      {
        awaitingFirm: list.awaitingFirm.map(toWire),
        replied: list.replied.map(toWire),
        settled: list.settled.map(toWire),
      },
      200,
    );
  });

  app.openapi(raiseRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const staff = refuseStaff(c.get("principal")?.audience);
    if (staff) return c.json(staff, 403);
    const { clientPartyId, subject, body } = c.req.valid("json");
    const row = await deps.service.raise({
      tenantId: s.tenantId,
      userId: s.userId,
      clientPartyId,
      subject,
      body,
      actor: s.actor,
    });
    return c.json(toWire(row), 201);
  });

  app.openapi(replyRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const staff = refuseStaff(c.get("principal")?.audience);
    if (staff) return c.json(staff, 403);
    const { requestId } = c.req.valid("param");
    const { body } = c.req.valid("json");
    const row = await deps.service.replyAsClient({
      tenantId: s.tenantId,
      userId: s.userId,
      requestId,
      body,
      actor: s.actor,
    });
    return c.json(toWire(row), 201);
  });

  app.openapi(withdrawRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const staff = refuseStaff(c.get("principal")?.audience);
    if (staff) return c.json(staff, 403);
    const { requestId } = c.req.valid("param");
    const row = await deps.service.withdraw({
      tenantId: s.tenantId,
      userId: s.userId,
      requestId,
      actor: s.actor,
    });
    return c.json(toWire(row), 200);
  });
}

/** See the header: a staff session is refused rather than answered empty. */
function refuseStaff(audience: string | null | undefined) {
  if (audience === "CLIENT_PORTAL") return null;
  return toEnvelope({
    status: 403,
    code: "FORBIDDEN",
    message:
      "this is the client portal's own surface and needs a client-portal session. The firm's " +
      "view of what clients have asked for is /api/v1/client-requests.",
  });
}

/**
 * Field by field, and never the domain object — and on this surface the mapping
 * also DROPS something.
 *
 * `authorName` survives on the client's own replies and is nulled on the firm's.
 * The adapter resolves both (the firm's screen reads the same table and needs
 * them), so doing it in SQL would take the names off that screen too. It is a
 * decision about an AUDIENCE, which is what a handler is for.
 */
function toWire(row: PortalRequestRow) {
  return {
    requestId: row.requestId,
    companyName: row.companyName,
    subject: row.subject,
    body: row.body,
    status: row.status,
    raisedAt: row.raisedAt,
    lastRepliedAt: row.lastRepliedAt,
    replies: row.replies.map((r) => ({
      replyId: r.reply.id,
      authorSide: r.reply.authorSide,
      authorName: r.reply.authorSide === "firm" ? null : r.authorName,
      body: r.reply.body,
      writtenAt: r.reply.writtenAt,
      document: r.document,
    })),
  };
}
