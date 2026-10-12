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
import { ASK_KINDS, MAX_FILES_PER_UPLOAD } from "../../domain/clientask/model";
import { DOCUMENT_KINDS, isPortalUploadable, normaliseMediaType } from "../../domain/filestore/model";
import { UnsupportedMediaType } from "../../domain/filestore/errors";

export interface ClientAskDeps {
  readonly service: ClientAskService;
}

const WorkItemParam = z.object({ workItemId: z.string().uuid() });
const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const AskParam = z.object({ askId: z.string().uuid() });

const ResponseSchema = z
  .object({
    responseId: z.string().uuid(),
    responseKind: z.enum(["document", "answer", "decision"]),
    answerText: z.string().nullable(),
    decision: z.enum(["approved", "declined"]).nullable(),
    respondedByName: z.string().nullable().openapi({
      description:
        "The CLIENT's own person who replied, or, when `onBehalf` is true, the colleague who " +
        "added it for them. Null when the account has been erased — a real answer, the same " +
        "shape the ledger's actor join has.",
    }),
    onBehalf: z.boolean().openapi({
      description:
        "True when somebody at the firm added this for the client: files the client sent " +
        "another way (by email), uploaded on the ask (0390). The client sees that the firm " +
        "added it and is never told who.",
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

const ChaseSchema = z
  .object({
    rungKey: z.string().openapi({
      description:
        "Your own name for the rung — `first`, `second`, `final`. The KEY and never an " +
        "index: an index shifts when you insert a rung and every chase already sent is " +
        "silently renamed.",
    }),
    afterDays: z.number().int().openapi({
      description:
        "The threshold that fired, copied from your ladder at the moment it did. A cadence " +
        "changed in April does not restate what was sent in March.",
    }),
    daysOpen: z.number().int().openapi({
      description: "How long the ask had actually been open when the rung fired.",
    }),
    chasedAt: z.string(),
  })
  .openapi("ClientAskChase");

const AskSchema = z
  .object({
    askId: z.string().uuid(),
    workItemId: z.string().uuid(),
    clientPartyId: z.string().uuid(),
    clientName: z.string(),
    askKind: z.enum(ASK_KINDS as unknown as [string, ...string[]]),
    prompt: z.string(),
    documentKind: z
      .enum(DOCUMENT_KINDS as unknown as [string, ...string[]])
      .nullable()
      .openapi({
        description:
          "What an uploaded answer gets FILED as, chosen when the ask was raised. Present " +
          "exactly when askKind is `document`. The CLIENT never sees or chooses it.",
      }),
    status: z.enum(["open", "answered", "closed", "withdrawn"]).openapi({
      description:
        "`answered` IS NOT `closed`. The client responding turns an ask answered; the FIRM " +
        "decides whether what arrived was what it needed. A client who sent last quarter's " +
        "register would otherwise see the ask marked done.",
    }),
    raisedByName: z.string().nullable().openapi({
      description:
        "Who asked. Null when a request template raised it (`fromTemplate` is set): the " +
        "requests sweep asks on the firm's behalf and names no person. Also null when the " +
        "account has been erased — a real answer, the shape the ledger's actor join has.",
    }),
    raisedAt: z.string(),
    dueOn: IsoDay.nullable().openapi({
      description:
        "The day you want it by, as YYYY-MM-DD, or null when none was stated. A DAY, never " +
        "an instant: show it as written, never through a Date in the reader's zone. Set by a " +
        "request template's due offset, or typed when raising by hand. The chaser still counts " +
        "from when you asked (`raisedAt`), not from this day.",
    }),
    fromTemplate: z
      .object({
        templateKey: z.string().openapi({ description: "The request template's config key." }),
        itemKey: z.string().openapi({ description: "The item's key inside that template." }),
      })
      .nullable()
      .openapi({
        description:
          "The request template and item this ask was raised from, or null when a person " +
          "raised it. One template item is asked at most once per task, so this pair is also " +
          "why a second sweep raised nothing. Not on the client's surface: it is your own " +
          "bookkeeping.",
      }),
    firstAnsweredAt: z.string().nullable().openapi({
      description:
        "When they FIRST replied, never restated by a later one. It is the number a firm " +
        "reaches for when a filing goes late.",
    }),
    closedByName: z.string().nullable(),
    closedAt: z.string().nullable(),
    responses: z.array(ResponseSchema),
    chases: z.array(ChaseSchema).openapi({
      description:
        "Every reminder the chaser has sent about this, oldest first. THE COUNT IS THE " +
        "POINT: `we asked you four times` is what a firm says when a filing goes late, and " +
        "`delivery.client_ask_chase` is append-only by GRANT so it is evidence rather than a " +
        "note. The CLIENT's own surface shows only the last date and no tally — see " +
        "`PortalAsk.lastRemindedAt` for why.",
    }),
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
    // A DUE DAY ONLY WHEN YOU STATE ONE (0385, reversing T6.6's "no due date").
    // No deadline this product invents reaches a client; one the firm types is
    // the firm's own, and absent stays the ordinary answer.
    dueOn: IsoDay.nullable()
      .optional()
      .openapi({
        description:
          "The day you want it by, as YYYY-MM-DD. Optional: leave it out and the ask has no due " +
          "day, as every ask did before. A day that does not exist, or one before today on your " +
          "firm's calendar (your firm's time zone, not the browser's), is 400 INVALID_DUE_DATE. " +
          "The client sees it. Reminders still count from when you asked.",
      }),
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
    400: errorResponse(
      "Empty prompt, unknown kind, a documentKind that does not fit, or a dueOn that is not a " +
        "day or is before the firm's today (INVALID_DUE_DATE)",
    ),
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

// The same multipart shape as the client's own upload (F1.6). `z.any()` for the
// file part for the reason `portalask.ts` gives; repeated parts arrive as an
// array.
const OnBehalfForm = z
  .object({
    file: z.any().openapi({
      description:
        `One file, or several: repeat the \`file\` part, at most ${String(MAX_FILES_PER_UPLOAD)} ` +
        "in one request.",
    }),
    note: z.string().optional().openapi({
      description:
        "Anything to say about what arrived, e.g. how it was sent. Once per upload. The client " +
        "sees it beside the files.",
    }),
  })
  .openapi("ClientAskOnBehalfForm");

const onBehalfRoute = createRoute({
  method: "post",
  path: "/api/v1/asks/{askId}/documents",
  tags: ["client-asks"],
  summary: "Upload files the client sent another way, on their behalf",
  description:
    "For files the client emailed (or handed over) instead of using the portal. Each file is " +
    "stored exactly as the client's own upload would be: filed under the document kind chosen " +
    "when the ask was raised, as the CLIENT's document, against the task, one reply per file, " +
    "and the ask turns answered, so reminders stop. FinCompliance takes a client's books files " +
    "(`books_input`) in whichever way they arrived. What differs is who: the replies are " +
    "recorded as yours, marked `onBehalf`, and the client sees that the firm added them. The " +
    "files are client-visible, as their own upload is; the document's own switch can change " +
    `that. Repeat the \`file\` part for several, at most ${String(MAX_FILES_PER_UPLOAD)}; they ` +
    "land together or not at all. The same kinds of file the portal accepts, and only those: " +
    "the file came from outside the firm and is not scanned for viruses.",
  request: {
    params: AskParam,
    body: { content: { "multipart/form-data": { schema: OnBehalfForm } }, required: true },
  },
  responses: {
    200: {
      description: "Added, and the ask is answered",
      content: { "application/json": { schema: AskSchema } },
    },
    400: errorResponse(
      "Empty file, an unusable filename, a kind of file the portal does not accept, or more " +
        `than ${String(MAX_FILES_PER_UPLOAD)} files at once (ASK_FILE_COUNT)`,
    ),
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or the role may not write work"),
    404: errorResponse("No such ask at this firm"),
    409: errorResponse("The ask is already closed or withdrawn"),
    413: errorResponse("A file, or the whole request, is larger than this firm's upload limit"),
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
      dueOn: body.dueOn ?? null,
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

  app.openapi(onBehalfRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { askId } = c.req.valid("param");
    const form = c.req.valid("form");
    const files = await onBehalfFiles(c);
    const record = await deps.service.uploadOnBehalf({
      tenantId: s.tenantId,
      askId,
      files,
      note: typeof form.note === "string" && form.note.length > 0 ? form.note : null,
      actor: s.actor,
    });
    return c.json(toWire(record), 200);
  });
}

/**
 * The files a colleague uploads for the client, as bytes (F1.6).
 *
 * A second copy of the portal's reader and deliberately not a shared helper
 * (`portalask.ts` says why: a change made for one surface must not silently
 * change the other). It holds the same ALLOWLIST as the portal, though the
 * staff document route has none: these files came from outside the firm, and
 * carrying an email attachment in by hand does not make it a file the firm made.
 */
async function onBehalfFiles(
  c: { req: { parseBody: (options: { all: true }) => Promise<Record<string, unknown>> } },
): Promise<{ bytes: Uint8Array; filename: string; mediaType: string }[]> {
  const body = await c.req.parseBody({ all: true });
  const raw = body["file"];
  const parts: unknown[] = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  if (parts.length === 0) throw new UnsupportedMediaType("none");
  const files: { bytes: Uint8Array; filename: string; mediaType: string }[] = [];
  for (const part of parts) {
    if (!(part instanceof File)) {
      throw new UnsupportedMediaType(typeof part === "string" ? "text/plain" : "none");
    }
    const normalised = normaliseMediaType(part.type);
    if (normalised === null || !isPortalUploadable(normalised)) {
      throw new UnsupportedMediaType(part.type === "" ? "none" : part.type);
    }
    files.push({ bytes: new Uint8Array(await part.arrayBuffer()), filename: part.name, mediaType: part.type });
  }
  return files;
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
    dueOn: r.ask.dueOn,
    // The keys only: the pinned version id is the firm's internal pin and no
    // screen needs it to say where an ask came from.
    fromTemplate:
      r.ask.fromTemplate === null
        ? null
        : { templateKey: r.ask.fromTemplate.templateKey, itemKey: r.ask.fromTemplate.itemKey },
    firstAnsweredAt: r.ask.firstAnsweredAt,
    closedByName: r.closedByName,
    closedAt: r.ask.closedAt,
    responses: r.responses.map((x) => ({
      responseId: x.response.id,
      responseKind: x.response.responseKind,
      answerText: x.response.answerText,
      decision: x.response.decision,
      respondedByName: x.respondedByName,
      onBehalf: x.response.onBehalf,
      respondedAt: x.response.respondedAt,
      document: x.document,
    })),
    chases: r.chases.map((c) => ({
      rungKey: c.rungKey,
      afterDays: c.afterDays,
      daysOpen: c.daysOpen,
      chasedAt: c.chasedAt,
    })),
  };
}
