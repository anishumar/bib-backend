// Client ownership over HTTP (G3.2) — transport only. Each handler parses the
// validated input, calls exactly one use-case method, and maps the result field
// by field. Never forwards a domain object: zod-openapi documents a response
// without validating it, so a field on the wire but not in the schema is a
// field the generated frontend client cannot see.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import type { ClientAssignmentService } from "../../usecase/clientassignment/service";
import type {
  ClientAssignmentRecord,
  OwnedClient,
} from "../../domain/clientassignment/model";
import { scopeOf } from "../scope";

export interface ClientAssignmentDeps {
  readonly service: ClientAssignmentService;
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const AssignmentRole = z.enum(["key_manager", "spoc"]).openapi({
  description:
    "'key_manager' owns the client relationship — pricing, renewals, escalation — and there " +
    "is one at a time. 'spoc' is the day-to-day contact for ONE of the firm's Depts or " +
    "delivery teams; a client commonly has several, because the firm's own practice is a " +
    "SPOC per Dept.",
});

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const AssignmentAxisSchema = z
  .object({
    id: z.string().uuid(),
    axis: z.enum(["dept", "team"]),
    code: z.string(),
    name: z.string(),
    isActive: z.boolean().openapi({
      description:
        "Whether the firm still files new work under it. A retired Dept still appears here — " +
        "the assignment really was made under it, and history is not corrected by hiding it.",
    }),
  })
  .openapi("AssignmentAxis");

const ClientAssignmentSchema = z
  .object({
    id: z.string().uuid(),
    clientPartyId: z.string().uuid(),
    role: AssignmentRole,
    userId: z.string().uuid(),
    // NAMES, not just the id — a screen must not have to fetch a person per row
    // to render the account team.
    holderEmail: z.string(),
    holderName: z.string().nullable(),
    holderIsActiveStaff: z.boolean().openapi({
      description:
        "Whether the holder is STILL active staff at this firm. False on a row that is " +
        "still IN FORCE means the client has a Key Manager or a SPOC who has left — " +
        "escalation goes to a desk nobody sits at, and the client rings somebody who " +
        "cannot answer. An assignment is never closed on the firm's behalf when somebody " +
        "is deactivated, because that would destroy the record of who owned the client, " +
        "so this is how a stale one becomes visible. On a row already closed it means " +
        "only that the person has since left, which is the ordinary end of a working life.",
    }),
    axis: AssignmentAxisSchema.nullable().openapi({
      description: "The Dept or delivery team a SPOC covers. Always null for a Key Manager.",
    }),
    validFrom: IsoDate,
    validTo: IsoDate.nullable().openapi({
      description:
        "The FIRST DAY NOT IN FORCE, or null while it still is. Half-open, like every " +
        "effective-dated period in this product: an assignment ending 2026-04-01 was in " +
        "force up to and including 2026-03-31. A handover therefore closes one row and " +
        "opens the next on the SAME date, with no gap and no overlap.",
    }),
  })
  .openapi("ClientAssignment");

const AccountTeamResponse = z
  .object({
    onDate: IsoDate.openapi({
      description:
        "The day `inForce` was computed for. Echoed back so a screen showing March can say " +
        "it is showing March rather than implying it is showing today.",
    }),
    inForce: z.array(ClientAssignmentSchema),
    all: z.array(ClientAssignmentSchema).openapi({
      description:
        "Every assignment this client has ever had, live and historic, newest first. This is " +
        "what makes 'who was the SPOC in March' answerable — nothing is deleted and nobody " +
        "is edited over.",
    }),
  })
  .openapi("AccountTeamResponse");

const OwnedClientSchema = z
  .object({
    clientPartyId: z.string().uuid(),
    displayName: z.string(),
    archivedAt: z.string().nullable(),
    roles: z.array(AssignmentRole).openapi({
      description:
        "Every role this person holds over this client today. One row per CLIENT, not per " +
        "assignment — a partner is commonly the Key Manager and a Dept's SPOC on the same " +
        "client, and listing it twice would report a bigger book than they have.",
    }),
  })
  .openapi("OwnedClient");

const MyClientsResponse = z
  .object({ clients: z.array(OwnedClientSchema) })
  .openapi("MyClientsResponse");

const AssignRequest = z
  .object({
    role: AssignmentRole,
    userId: z.string().uuid(),
    axisId: z.string().uuid().nullable().optional().openapi({
      description:
        "Required for a SPOC, refused for a Key Manager. It is one of the firm's own " +
        "service-axis rows — a Dept OR a delivery team, whichever the firm assigns its " +
        "SPOCs per. A retired one is refused.",
    }),
    validFrom: IsoDate.optional().openapi({
      description:
        "The first day in force. Defaults to today. Backdating is allowed — a firm records " +
        "a handover that happened last week, and refusing it would only make the record say " +
        "the wrong day.",
    }),
  })
  .openapi("AssignClientRequest");

const EndAssignmentRequest = z
  .object({
    validTo: IsoDate.optional().openapi({
      description:
        "The FIRST DAY NOT IN FORCE. Defaults to today, which reads as 'they stop today' — " +
        "so they were in force up to and including yesterday. Must be after the start date.",
    }),
  })
  .openapi("EndClientAssignmentRequest");

const PartyParam = z.object({ partyId: z.string().uuid() });
const AssignmentParam = z.object({
  partyId: z.string().uuid(),
  assignmentId: z.string().uuid(),
});
const MyClientsQuery = z.object({
  asOf: IsoDate.optional().openapi({
    description:
      "The day to answer for, in the CALLER's calendar. Defaults to the server's own day — " +
      "which is not the firm's: a server in UTC is a day behind a firm in India every " +
      "morning, so a client assigned this morning would be missing from its holder's book " +
      "until the afternoon. A browser sends its local date.",
  }),
});

const AsOfQuery = z.object({
  asOf: IsoDate.optional().openapi({
    description:
      "The day to answer for. Defaults to today. This is the whole 'who was the SPOC in " +
      "March' feature: the same rows, filtered by a different date.",
  }),
});

function toWire(r: ClientAssignmentRecord): z.infer<typeof ClientAssignmentSchema> {
  return {
    id: r.assignment.id,
    clientPartyId: r.assignment.clientPartyId,
    role: r.assignment.role,
    userId: r.assignment.userId,
    holderEmail: r.holder.email,
    holderName: r.holder.displayName,
    holderIsActiveStaff: r.holder.isActiveStaff,
    axis: r.axis
      ? {
          id: r.axis.id,
          // The schema's CHECK guarantees the value; the cast states a fact the
          // database enforces rather than hoping for one.
          axis: r.axis.axis as "dept" | "team",
          code: r.axis.code,
          name: r.axis.name,
          isActive: r.axis.isActive,
        }
      : null,
    validFrom: r.assignment.validFrom,
    validTo: r.assignment.validTo,
  };
}

function toOwnedWire(c: OwnedClient): z.infer<typeof OwnedClientSchema> {
  return {
    clientPartyId: c.clientPartyId,
    displayName: c.displayName,
    archivedAt: c.archivedAt,
    roles: [...c.roles],
  };
}

// ── Routes ──────────────────────────────────────────────────────────────────
//
// The tenant comes from the SESSION on every one of these, never from the path.

const getAccountTeamRoute = createRoute({
  method: "get",
  path: "/api/v1/parties/{partyId}/assignments",
  tags: ["parties"],
  summary: "Who at the firm owns this client, and who they talk to",
  description:
    "The Key Manager and every SPOC, as they stood on `asOf` (default today), plus the whole " +
    "history below. Nothing here is deleted and nobody is edited over — a handover is two " +
    "rows — so an 'as of' date is the only thing a screen needs to answer what the account " +
    "team was on any past day.",
  request: { params: PartyParam, query: AsOfQuery },
  responses: {
    200: {
      description: "The account team",
      content: { "application/json": { schema: AccountTeamResponse } },
    },
    400: errorResponse("asOf is not an ISO date"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read parties"),
    404: errorResponse("No such party at this firm"),
  },
});

const assignRoute = createRoute({
  method: "post",
  path: "/api/v1/parties/{partyId}/assignments",
  tags: ["parties"],
  summary: "Put somebody in charge of a client",
  description:
    "A new **Key Manager** is a HANDOVER: the incumbent is closed on the day the new one " +
    "starts, both rows survive, and only one is ever in force. A new **SPOC** is an " +
    "ADDITION — a Dept may have more than one (leave cover, a joint SPOC, a fortnight run " +
    "in parallel), so nothing is closed on the firm's behalf and ending the outgoing one is " +
    "a separate, deliberate call.",
  request: {
    params: PartyParam,
    body: { content: { "application/json": { schema: AssignRequest } }, required: true },
  },
  responses: {
    201: {
      description: "Assigned",
      content: { "application/json": { schema: ClientAssignmentSchema } },
    },
    400: errorResponse(
      "Not a valid role or date, a SPOC with no Dept, or a Key Manager given one",
    ),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not write parties"),
    404: errorResponse("No such party, or no such Dept or delivery team at this firm"),
    409: errorResponse(
      "The client is archived, the Dept is retired, this person already holds it, or the " +
        "start date is on or before the current Key Manager's",
    ),
  },
});

const endAssignmentRoute = createRoute({
  method: "post",
  path: "/api/v1/parties/{partyId}/assignments/{assignmentId}/end",
  tags: ["parties"],
  summary: "End an assignment",
  description:
    "Somebody stops holding this client and nobody replaces them yet. The row is CLOSED, " +
    "never deleted and never edited — it is what says who it used to be. `validTo` is the " +
    "first day NOT in force.",
  request: {
    params: AssignmentParam,
    body: { content: { "application/json": { schema: EndAssignmentRequest } }, required: true },
  },
  responses: {
    200: {
      description: "Ended",
      content: { "application/json": { schema: ClientAssignmentSchema } },
    },
    400: errorResponse("The end date is not after the start date"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not write parties"),
    404: errorResponse("No such assignment at this firm"),
    409: errorResponse("It has already ended"),
  },
});

const myClientsRoute = createRoute({
  method: "get",
  path: "/api/v1/my-clients",
  tags: ["parties"],
  summary: "The clients on the signed-in person's book",
  request: { query: MyClientsQuery },
  description:
    "Every client this person is the Key Manager or a SPOC for TODAY, one row per client " +
    "with the roles collected onto it. Archived clients are included and marked rather than " +
    "dropped: somebody still holds them, and hiding that makes the book look smaller than " +
    "the record says.",
  responses: {
    200: {
      description: "The book",
      content: { "application/json": { schema: MyClientsResponse } },
    },
    400: errorResponse("asOf is not an ISO date"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read parties"),
  },
});

export function registerClientAssignmentRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: ClientAssignmentDeps,
): void {
  app.openapi(getAccountTeamRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { partyId } = c.req.valid("param");
    const { asOf } = c.req.valid("query");
    const view = await deps.service.accountTeam(s.tenantId, partyId, asOf);
    return c.json(
      {
        onDate: view.onDate,
        inForce: view.inForce.map(toWire),
        all: view.all.map(toWire),
      },
      200,
    );
  });

  app.openapi(assignRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { partyId } = c.req.valid("param");
    const body = c.req.valid("json");
    const created = await deps.service.assign(
      {
        tenantId: s.tenantId,
        clientPartyId: partyId,
        role: body.role,
        axisId: body.axisId ?? null,
        userId: body.userId,
        validFrom: body.validFrom,
      },
      s.actor,
    );
    // Read back through the account team so the response carries the holder's
    // name and the axis, like every other row this module returns. A create
    // that answered with ids while the list answered with names would leave the
    // screen re-fetching to render the row it just made.
    const view = await deps.service.accountTeam(s.tenantId, partyId);
    const record = view.all.find((r) => r.assignment.id === created.id);
    if (!record) throw new Error(`assignment ${created.id} was not readable after creation`);
    return c.json(toWire(record), 201);
  });

  app.openapi(endAssignmentRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { partyId, assignmentId } = c.req.valid("param");
    const { validTo } = c.req.valid("json");
    await deps.service.end({ tenantId: s.tenantId, assignmentId, validTo }, s.actor);
    const view = await deps.service.accountTeam(s.tenantId, partyId);
    const record = view.all.find((r) => r.assignment.id === assignmentId);
    if (!record) throw new Error(`assignment ${assignmentId} was not readable after ending`);
    return c.json(toWire(record), 200);
  });

  app.openapi(myClientsRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { asOf } = c.req.valid("query");
    const clients = await deps.service.clientsOf(s.tenantId, s.userId, asOf);
    return c.json({ clients: clients.map(toOwnedWire) }, 200);
  });
}

export const clientAssignmentRoutes = {
  getAccountTeam: getAccountTeamRoute,
  assign: assignRoute,
  endAssignment: endAssignmentRoute,
  myClients: myClientsRoute,
} as const;
