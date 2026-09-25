// The CLIENT's side of an ask (T6.6) — the action centre, transport only.
//
// ── THE FIRST PORTAL ROUTES THAT WRITE, AND THE FIRST THAT NEED A PERMISSION ─
//
// Every portal route before these either managed a session or read the status
// home, and CLAUDE.md's rule for adding one was three things. It is FOUR now:
//
//   · an entry in `PORTAL_PATHS` — gate 2 is denied by default, and it learnt
//     `{param}` templates in its own commit so these routes could exist at all
//   · an entry in `ROUTE_PERMISSIONS` or `NO_PERMISSION_REQUIRED` — gate 3 is
//     denied by default too
//   · `portal:respond` on the three that ACT, so "this contact may upload, that
//     one may only look" is a role a firm can actually assign. The list is not
//     behind it: reading is authorised by the grant itself
//   · the query through `withPortal` — never `withTenant` — with a RESTRICTIVE
//     policy on every table it touches, and on these routes that covers the
//     WRITES as well (0063)
//
// ── AND IT REFUSES A STAFF SESSION ──────────────────────────────────────
//
// Gate 2 admits a portal session to `PORTAL_PATHS` and says nothing about a
// STAFF one reaching it, because the staff workspace is the default side. T6.5's
// home refuses one rather than answering it empty, and these do the same: a
// colleague holds no portal grants, so the action centre would read as "this
// client has nothing outstanding" rather than "you are looking at the wrong
// app". A wrong answer that looks right is worse than a refusal.
//
// Since T6.6 there is a second, independent answer — a staff role declares the
// STAFF audience and therefore carries no `portal:respond`, so gate 3 refuses
// the three verbs before this check is reached. The check stays because the LIST
// needs no permission and would otherwise be answered.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { toEnvelope } from "../httpresp";
import { scopeOf } from "../scope";
import type { ClientAskService } from "../../usecase/clientask/service";
import type { PortalAskRow } from "../../domain/clientask/model";
import { ASK_KINDS } from "../../domain/clientask/model";
import { isPortalUploadable, normaliseMediaType } from "../../domain/filestore/model";
import { UnsupportedMediaType } from "../../domain/filestore/errors";

export interface PortalAskDeps {
  readonly service: ClientAskService;
}

const AskParam = z.object({ askId: z.string().uuid() });

const ResponseSchema = z
  .object({
    responseId: z.string().uuid(),
    responseKind: z.enum(["document", "answer", "decision"]),
    answerText: z.string().nullable(),
    decision: z.enum(["approved", "declined"]).nullable(),
    respondedByName: z.string().nullable().openapi({
      description:
        "Which of YOUR people replied. A company with two directors needs to know which of " +
        "them sent it. Nobody at the firm is named anywhere on this surface.",
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
          "What you sent, so you can see it arrived. The bytes are not readable back through " +
          "this surface — that would be a download route with a path parameter and more " +
          "surface than showing you the filename needs.",
      }),
  })
  .openapi("PortalAskResponse");

const AskSchema = z
  .object({
    askId: z.string().uuid(),
    askKind: z.enum(ASK_KINDS as unknown as [string, ...string[]]).openapi({
      description: "What kind of answer this wants, and therefore what the screen draws.",
    }),
    prompt: z.string().openapi({
      description: "The firm's own words, verbatim. Show them as the firm's words.",
    }),
    status: z.enum(["open", "answered"]).openapi({
      description:
        "`open` is still waiting on you; `answered` is back with the firm. A closed or " +
        "withdrawn ask is not on this surface at all — it is finished, and this is a list of " +
        "what is not.",
    }),
    companyName: z.string().nullable().openapi({
      description:
        "Which of your companies this is about. NULL is a real answer — work about the " +
        "relationship rather than one company has no entity (migration 0051).",
    }),
    workItemTitle: z.string().openapi({ description: "What the firm is doing that this is part of." }),
    raisedAt: z.string().openapi({
      description:
        "When you were asked. THERE IS NO DUE DATE ON THIS SURFACE and there will not be " +
        "one: no deadline this product invented reaches a client, so how long it has been " +
        "outstanding is a fact and 'by Friday' would be a promise nobody made.",
    }),
    lastRemindedAt: z.string().nullable().openapi({
      description:
        "When the firm last reminded you about this, or null if it never has. A DATE AND " +
        "NOT A COUNT, deliberately: `you have been reminded 4 times` is a tally about you " +
        "rather than something you can act on, and on a daily cadence it reads `9 times` " +
        "within a fortnight. The firm keeps every rung on its own screen, where it is the " +
        "evidence behind `we asked four times` when a filing goes late.",
    }),
    responses: z.array(ResponseSchema),
  })
  .openapi("PortalAsk");

const CentreSchema = z
  .object({
    awaitingYou: z.array(AskSchema),
    withTheFirm: z.array(AskSchema).openapi({
      description:
        "What you have answered and the firm has not finished with. It stays visible because " +
        "your reply does not close an ask — the firm looks at what arrived and decides, so a " +
        "wrong file is answered with 'that was not it' rather than a second request that " +
        "reads as a fresh one.",
    }),
  })
  .openapi("PortalActionCentre");

const AnswerRequest = z
  .object({ answerText: z.string() })
  .openapi("PortalAnswerRequest");

const DecisionRequest = z
  .object({
    decision: z.enum(["approved", "declined"]),
    note: z.string().nullable().optional().openapi({
      description: "Why, if you want to say. A declined approval nearly always has a reason.",
    }),
  })
  .openapi("PortalDecisionRequest");

// `z.any()` for the file part: the body is not JSON and there is nothing for a
// schema to describe beyond its media type. The check that it IS a file happens
// in the handler, which is the one place that knows.
const UploadForm = z
  .object({ file: z.any(), note: z.string().optional() })
  .openapi("PortalUploadForm");

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/portal/asks",
  tags: ["portal"],
  summary: "What the firm is waiting on you for",
  description:
    "CLIENT_PORTAL sessions only. Needs no permission — being invited and granted a company " +
    "IS the authorisation to read that company's records, which is why a read-only contact " +
    "sees all of this and can answer none of it.",
  responses: {
    200: { description: "The action centre", content: { "application/json": { schema: CentreSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or this is not a client-portal session"),
  },
});

const answerRoute = createRoute({
  method: "post",
  path: "/api/v1/portal/asks/{askId}/answer",
  tags: ["portal"],
  summary: "Answer in words",
  description:
    "Works on any kind of ask, deliberately — 'we hold no such register, the shop closed in " +
    "2019' is a real and useful answer to a request for a document, and forcing a file would " +
    "make the honest answer unsayable.",
  request: {
    params: AskParam,
    body: { content: { "application/json": { schema: AnswerRequest } }, required: true },
  },
  responses: {
    200: { description: "Sent", content: { "application/json": { schema: AskSchema } } },
    400: errorResponse("An answer with no words in it"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("Not a client-portal session, or this contact may only look"),
    404: errorResponse("No such ask you can reach"),
    409: errorResponse("The firm has already finished with this ask"),
  },
});

const decisionRoute = createRoute({
  method: "post",
  path: "/api/v1/portal/asks/{askId}/decision",
  tags: ["portal"],
  summary: "Approve or decline",
  description:
    "Only answers an `approval` ask. This is recorded as YOUR instruction and is never the " +
    "firm's own review of its work — those are separate records, and counting them together " +
    "would make a client's yes look like a second qualified person having checked it.",
  request: {
    params: AskParam,
    body: { content: { "application/json": { schema: DecisionRequest } }, required: true },
  },
  responses: {
    200: { description: "Recorded", content: { "application/json": { schema: AskSchema } } },
    400: errorResponse("This ask does not want a yes or no"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("Not a client-portal session, or this contact may only look"),
    404: errorResponse("No such ask you can reach"),
    409: errorResponse("The firm has already finished with this ask"),
  },
});

const uploadRoute = createRoute({
  method: "post",
  path: "/api/v1/portal/asks/{askId}/documents",
  tags: ["portal"],
  summary: "Send the file the firm asked for",
  description:
    "Multipart, because base64 in a JSON body inflates a scanned PDF by a third. The file is " +
    "filed against the task the ask was raised from, under the document kind the FIRM chose " +
    "when it asked — you do not choose where in their store it lands. It is stored exactly as " +
    "it arrives: there is no virus scanner in this product today, so the KINDS of file this " +
    "route accepts are an allowlist — PDFs, photographs and scans, spreadsheets, Word and " +
    "OpenDocument files, plain text and CSV. Anything else is refused rather than filed for " +
    "a colleague to open.",
  request: {
    params: AskParam,
    body: { content: { "multipart/form-data": { schema: UploadForm } }, required: true },
  },
  responses: {
    200: { description: "Sent", content: { "application/json": { schema: AskSchema } } },
    400: errorResponse("Empty file, an unusable filename, or a kind of file this route does not accept"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("Not a client-portal session, or this contact may only look"),
    404: errorResponse("No such ask you can reach"),
    409: errorResponse("The firm has already finished with this ask"),
    413: errorResponse("The file is larger than this firm's upload limit"),
  },
});

export function registerPortalAskRoutes(app: OpenAPIHono<AppEnv>, deps: PortalAskDeps): void {
  app.openapi(listRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const staff = refuseStaff(c.get("principal")?.audience);
    if (staff) return c.json(staff, 403);
    // No `asOf` (F-07-1): which companies this login may see is resolved on
    // the firm's own day by the grant module, never on a day the caller sends.
    const centre = await deps.service.actionCentre(s.tenantId, s.userId);
    return c.json(
      {
        awaitingYou: centre.awaitingYou.map(toWire),
        withTheFirm: centre.withTheFirm.map(toWire),
      },
      200,
    );
  });

  app.openapi(answerRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const staff = refuseStaff(c.get("principal")?.audience);
    if (staff) return c.json(staff, 403);
    const { askId } = c.req.valid("param");
    const { answerText } = c.req.valid("json");
    const row = await deps.service.answer({
      tenantId: s.tenantId,
      userId: s.userId,
      askId,
      answerText,
      actor: s.actor,
    });
    return c.json(toWire(row), 200);
  });

  app.openapi(decisionRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const staff = refuseStaff(c.get("principal")?.audience);
    if (staff) return c.json(staff, 403);
    const { askId } = c.req.valid("param");
    const body = c.req.valid("json");
    const row = await deps.service.decide({
      tenantId: s.tenantId,
      userId: s.userId,
      askId,
      decision: body.decision,
      note: body.note ?? null,
      actor: s.actor,
    });
    return c.json(toWire(row), 200);
  });

  app.openapi(uploadRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const staff = refuseStaff(c.get("principal")?.audience);
    if (staff) return c.json(staff, 403);
    const { askId } = c.req.valid("param");
    const form = c.req.valid("form");
    const file = await filePart(c);
    const row = await deps.service.upload({
      tenantId: s.tenantId,
      userId: s.userId,
      askId,
      filename: file.filename,
      mediaType: file.mediaType,
      bytes: file.bytes,
      note: typeof form.note === "string" && form.note.length > 0 ? form.note : null,
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
      "view of the same asks is on the work item: /api/v1/work-items/{workItemId}/asks.",
  });
}

/**
 * The uploaded part, as bytes.
 *
 * `parseBody` rather than the validated form value, because zod cannot describe
 * a File and `z.any()` therefore passes whatever arrived through untouched — so
 * the check that it IS a file has to happen here. The same shape the staff
 * upload uses, and deliberately a second copy rather than a shared helper: this
 * one is on the surface a client reaches, and a change made for the staff route
 * should not silently change what a client may send.
 */
async function filePart(
  c: { req: { parseBody: () => Promise<Record<string, unknown>> } },
): Promise<{ bytes: Uint8Array; filename: string; mediaType: string }> {
  const body = await c.req.parseBody();
  const part = body["file"];
  if (typeof part === "string" || part === undefined || !(part instanceof File)) {
    throw new UnsupportedMediaType(typeof part === "string" ? "text/plain" : "none");
  }
  // WHAT A CLIENT MAY SEND, checked here and not on the staff route.
  //
  // This is the one upload path in the product whose uploader is outside the
  // firm, and there is no scanner behind it. The bytes are later downloaded by
  // a colleague, with the media type the client chose echoed back — so an
  // executable, an HTML page or an SVG stored here is a file a member of staff
  // is invited to open. `attachment` and `nosniff` stop a browser rendering
  // one; the allowlist stops it being stored at all.
  //
  // The staff route deliberately has no equivalent — see
  // PORTAL_UPLOAD_MEDIA_TYPES for why the two surfaces differ.
  const normalised = normaliseMediaType(part.type);
  if (normalised === null || !isPortalUploadable(normalised)) {
    throw new UnsupportedMediaType(part.type === "" ? "none" : part.type);
  }
  return {
    bytes: new Uint8Array(await part.arrayBuffer()),
    filename: part.name,
    // A browser that cannot guess sends an empty type. The service refuses it
    // rather than defaulting to octet-stream, because a stored media type is
    // what a download's Content-Type header says.
    mediaType: part.type,
  };
}

/** Field by field. On THIS surface an accidental field is one that reached
 *  somebody outside the firm — which is why `documentKind` is on the row and not
 *  here: it is the firm's filing decision and tells a client nothing. */
function toWire(r: PortalAskRow): z.infer<typeof AskSchema> {
  return {
    askId: r.askId,
    askKind: r.askKind,
    prompt: r.prompt,
    // Narrowed by the query, which only returns open and answered rows.
    status: r.status === "answered" ? "answered" : "open",
    companyName: r.companyName,
    workItemTitle: r.workItemTitle,
    raisedAt: r.raisedAt,
    lastRemindedAt: r.lastRemindedAt,
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
