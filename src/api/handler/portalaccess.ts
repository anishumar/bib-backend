// Gate 4's grants over HTTP (G3.4) — transport only. Each handler parses the
// validated input, calls exactly one use-case method, and maps the result field
// by field. Never forwards a domain object: zod-openapi documents a response
// without validating it, so a field on the wire but not in the schema is a
// field the generated frontend client cannot see.
//
// EVERY ROUTE HERE IS STAFF-ONLY, and that is worth saying out loud on a file
// about the client portal. These are the routes a FIRM uses to decide who at a
// client may sign in; the portal's own routes are T6.5's and live behind
// `PORTAL_PATHS`. A portal session cannot reach any of this — gate 2 refuses it
// before a permission is ever consulted.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import type { PortalAccessService } from "../../usecase/portalaccess/service";
import type { PortalAccessRecord } from "../../domain/portalaccess/model";
import { scopeOf } from "../scope";

export interface PortalAccessDeps {
  readonly service: PortalAccessService;
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const PortalAccessSchema = z
  .object({
    id: z.string().uuid(),
    membershipId: z.string().uuid(),
    clientPartyId: z.string().uuid(),
    clientName: z.string(),
    contactEmail: z.string().openapi({
      description:
        "The person this login belongs to. BOTH halves are sent — `display_name` is nullable " +
        "and genuinely empty at real firms, so a name alone cannot say whether we hold no " +
        "name or there is no person.",
    }),
    contactDisplayName: z.string().nullable(),
    contactAccepted: z.boolean().openapi({
      description:
        "Whether they have ever set a password — i.e. whether the invitation was ACCEPTED. " +
        "False is an ordinary state and not a fault: it means the letter went and nobody has " +
        "acted on it yet. It is on this response because it is what decides whether re-sending " +
        "the invitation is an action worth offering — once somebody has a password there is no " +
        "invitation left, and re-issuing one would be the firm resetting its own client's " +
        "password. Not a date: WHEN they accepted is not a fact this table holds, and a " +
        "plausible one derived from the grant would be indistinguishable from a real one.",
    }),
    validFrom: IsoDate,
    validTo: IsoDate.nullable().openapi({
      description:
        "HALF-OPEN: the FIRST DAY NOT IN FORCE, never the last day of access. Null while the " +
        "grant stands. Equal to `validFrom` when a grant was withdrawn on the day it was " +
        "made — in force on no day at all, which is a real record and not a broken row.",
    }),
    grantedByEmail: z.string().nullable().openapi({
      description:
        "Who let them in. Null when that account has since been erased — the grant stays " +
        "readable, because who could see a client in March is not corrected by an account " +
        "closing.",
    }),
    grantedByDisplayName: z.string().nullable(),
  })
  .openapi("PortalAccess");

const PortalAccessListResponse = z
  .object({ grants: z.array(PortalAccessSchema) })
  .openapi("PortalAccessListResponse");

const PortalScopeResponse = z
  .object({
    membershipId: z.string().uuid(),
    onDate: IsoDate,
    clientPartyIds: z.array(z.string().uuid()).openapi({
      description:
        "Exactly what this login may read on that day. An EMPTY list is a real answer and the " +
        "state every portal login is in between being invited and being granted anything — it " +
        "means 'nothing', never 'everything'.",
    }),
  })
  .openapi("PortalScope");

const GrantPortalAccessRequest = z
  .object({
    clientPartyId: z.string().uuid().openapi({
      description:
        "ONE client. A contact who should see four of a group's companies is granted four " +
        "times, deliberately: access is never derived from a group relationship, because the " +
        "screen that records relationships is not reviewed as an access-control screen.",
    }),
    validFrom: IsoDate.optional().openapi({
      description:
        "The day access starts. Send the BROWSER's calendar day — the server's is a day " +
        "behind a firm in India every morning, and a grant starting 'today' would not be in " +
        "force yet. Absent means the server's day, which is the honest fallback for a caller " +
        "that did not say.",
    }),
    validTo: IsoDate.nullable().optional().openapi({
      description:
        "Optional end, half-open — the FIRST DAY NOT IN FORCE. Lets a fixed-term grant (a " +
        "consultant engaged for a quarter) be written at the moment it is decided rather " +
        "than relying on somebody remembering to close it.",
    }),
  })
  .openapi("GrantPortalAccessRequest");

const EndPortalAccessRequest = z
  .object({
    validTo: IsoDate.optional().openapi({
      description:
        "The FIRST DAY NOT IN FORCE. Absent means TODAY: remove means remove, and the access " +
        "is gone on the next request rather than at midnight. Ending on the day the grant " +
        "began is allowed and records an empty range — granted and withdrawn before it was " +
        "ever in force. The row is then a day coarser than the truth; the " +
        "`portal_access.ended` event carries the instant.",
    }),
  })
  .openapi("EndPortalAccessRequest");

const MembershipParam = z.object({ membershipId: z.string().uuid() });
const ClientParam = z.object({ partyId: z.string().uuid() });
const GrantParam = z.object({ grantId: z.string().uuid() });

function toWire(r: PortalAccessRecord): z.infer<typeof PortalAccessSchema> {
  return {
    id: r.access.id,
    membershipId: r.access.membershipId,
    clientPartyId: r.access.clientPartyId,
    clientName: r.clientName,
    contactEmail: r.contactEmail,
    contactDisplayName: r.contactDisplayName,
    contactAccepted: r.contactAccepted,
    validFrom: r.access.validFrom,
    validTo: r.access.validTo,
    grantedByEmail: r.grantedByEmail,
    grantedByDisplayName: r.grantedByDisplayName,
  };
}

// ── A group (Q064) ──────────────────────────────────────────────────────────

const GroupCompanySchema = z
  .object({ partyId: z.string().uuid(), name: z.string() })
  .openapi("PortalGroupCompany");

const PortalGroupResponse = z
  .object({
    companies: z.array(GroupCompanySchema).openapi({
      description:
        "The OTHER companies in this client's group today: every company joined to it by " +
        "ownership (parent_of, shareholder_of), both ways and to any depth. Never a person, " +
        "the firm's own company, an archived company or another firm's. Empty when it is in " +
        "no group.",
    }),
    contactsMissing: z
      .array(
        z.object({
          membershipId: z.string().uuid(),
          contactEmail: z.string(),
          contactDisplayName: z.string().nullable(),
          sees: z.array(z.string()).openapi({ description: "The group's companies they see today." }),
        }),
      )
      .openapi({
        description:
          "Portal contacts who see another company of this group today and NOT this one: " +
          "offered, never granted silently, when a company joins a group after its contacts " +
          "were set up.",
      }),
  })
  .openapi("PortalGroup");

const GrantGroupRequest = z
  .object({
    clientPartyId: z.string().uuid().openapi({
      description: "The client whose group's OTHER companies are granted. The list is the server's.",
    }),
    validFrom: IsoDate.optional().openapi({ description: "The day access starts; the browser's day." }),
  })
  .openapi("GrantPortalGroupRequest");

const GrantGroupResponse = z
  .object({
    granted: z.array(PortalAccessSchema).openapi({
      description: "One grant per company, each its own row and its own ledger event.",
    }),
    alreadyHeld: z.array(GroupCompanySchema).openapi({
      description: "Companies the login could already see: left as they were.",
    }),
  })
  .openapi("GrantPortalGroupResponse");

// ── Routes ──────────────────────────────────────────────────────────────────

const groupRoute = createRoute({
  method: "get",
  path: "/api/v1/portal-access/clients/{partyId}/group",
  tags: ["portal"],
  summary: "A client's group, and its portal contacts who cannot see this client yet",
  request: { params: ClientParam },
  responses: {
    200: { description: "The group", content: { "application/json": { schema: PortalGroupResponse } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not grant access"),
  },
});

const grantGroupRoute = createRoute({
  method: "post",
  path: "/api/v1/portal-access/memberships/{membershipId}/group",
  tags: ["portal"],
  summary: "Let a client-portal login read the rest of a client's group too",
  description:
    "Q064: a group's contact sees its sister companies. Still ONE GRANT PER COMPANY: each " +
    "company of the server's group list is granted on its own, with its own ledger event and " +
    "the same refusals as a single grant. A company the login already sees is left alone.",
  request: {
    params: MembershipParam,
    body: { content: { "application/json": { schema: GrantGroupRequest } }, required: true },
  },
  responses: {
    200: { description: "Granted", content: { "application/json": { schema: GrantGroupResponse } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not grant access"),
    404: errorResponse("No such membership at this firm"),
    409: errorResponse("The login cannot hold a grant"),
  },
});

const listForMembershipRoute = createRoute({
  method: "get",
  path: "/api/v1/portal-access/memberships/{membershipId}",
  tags: ["portal"],
  summary: "Every client one portal login has ever been able to see",
  description:
    "Live and historic, newest first. The ended grants are the point: a grant is closed on a " +
    "day and never deleted, so 'could this person see this client on 14 March' stays " +
    "answerable a year later — which is the whole reason ending access is a date.",
  request: { params: MembershipParam },
  responses: {
    200: {
      description: "The grants",
      content: { "application/json": { schema: PortalAccessListResponse } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not grant access"),
  },
});

const listForClientRoute = createRoute({
  method: "get",
  path: "/api/v1/portal-access/clients/{partyId}",
  tags: ["portal"],
  summary: "Everybody at this client who can see its records",
  description:
    "The question a firm asks when a client rings up about somebody who has left. Historic " +
    "rows included, for the same reason as the membership read.",
  request: { params: ClientParam },
  responses: {
    200: {
      description: "The grants",
      content: { "application/json": { schema: PortalAccessListResponse } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not grant access"),
  },
});

const scopeRoute = createRoute({
  method: "get",
  path: "/api/v1/portal-access/memberships/{membershipId}/scope",
  tags: ["portal"],
  summary: "What one portal login may read on a given day",
  description:
    "The resolved answer rather than the rows — the value the portal's own requests are " +
    "scoped by. Useful to a firm checking what somebody can actually see today without " +
    "reading half-open date ranges by eye.",
  request: {
    params: MembershipParam,
    query: z.object({
      asOf: IsoDate.optional().openapi({
        description:
          "The CALLER's calendar day. Absent means the server's, which is a day behind a firm " +
          "in India every morning.",
      }),
    }),
  },
  responses: {
    200: { description: "The scope", content: { "application/json": { schema: PortalScopeResponse } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not grant access"),
  },
});

const grantRoute = createRoute({
  method: "post",
  path: "/api/v1/portal-access/memberships/{membershipId}",
  tags: ["portal"],
  summary: "Let a client-portal login read one client's records",
  description:
    "ONE CLIENT PER CALL. Refuses a login that is not a CLIENT_PORTAL one (a colleague " +
    "already reaches the whole book through the staff workspace, so the grant would govern " +
    "nothing and read as though it did), a revoked login, and a client the firm has archived.",
  request: {
    params: MembershipParam,
    body: { content: { "application/json": { schema: GrantPortalAccessRequest } }, required: true },
  },
  responses: {
    201: { description: "Granted", content: { "application/json": { schema: PortalAccessSchema } } },
    400: errorResponse("Dates that describe a grant in force on no day"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not grant access"),
    404: errorResponse("No such membership or client at this firm"),
    409: errorResponse("Already granted over those days, or the login cannot hold a grant"),
  },
});

const endGrantRoute = createRoute({
  method: "post",
  path: "/api/v1/portal-access/grants/{grantId}/end",
  tags: ["portal"],
  summary: "Stop a portal login seeing a client",
  description:
    "Never a delete — `bib_app` holds no DELETE grant on the table, and a grant removed " +
    "answers 'who could see this in March' with silence.",
  request: {
    params: GrantParam,
    body: { content: { "application/json": { schema: EndPortalAccessRequest } }, required: true },
  },
  responses: {
    200: { description: "Ended", content: { "application/json": { schema: PortalAccessSchema } } },
    400: errorResponse("An end date BEFORE the day it started"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not grant access"),
    404: errorResponse("No such grant at this firm"),
    409: errorResponse("It has already been ended"),
  },
});

export function registerPortalAccessRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: PortalAccessDeps,
): void {
  app.openapi(listForMembershipRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { membershipId } = c.req.valid("param");
    const grants = await deps.service.listForMembership(s.tenantId, membershipId);
    return c.json({ grants: grants.map(toWire) }, 200);
  });

  app.openapi(listForClientRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { partyId } = c.req.valid("param");
    const grants = await deps.service.listForClient(s.tenantId, partyId);
    return c.json({ grants: grants.map(toWire) }, 200);
  });

  app.openapi(scopeRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { membershipId } = c.req.valid("param");
    const { asOf } = c.req.valid("query");
    const scope = await deps.service.scopeFor(s.tenantId, membershipId, asOf);
    return c.json(
      {
        membershipId: scope.membershipId,
        // Echoed back, because a screen that asked for "today" needs to know
        // which day it actually got when it did not say.
        onDate: scope.onDate,
        clientPartyIds: [...scope.clientPartyIds],
      },
      200,
    );
  });

  app.openapi(grantRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { membershipId } = c.req.valid("param");
    const body = c.req.valid("json");
    const created = await deps.service.grant(
      {
        tenantId: s.tenantId,
        membershipId,
        clientPartyId: body.clientPartyId,
        validFrom: body.validFrom,
        validTo: body.validTo,
        grantedBy: s.userId,
      },
      s.actor,
    );
    // Read back through the list so the response carries the names, like every
    // other row this module returns. A create answering with ids while the list
    // answers with names leaves the screen re-fetching to render what it made.
    const grants = await deps.service.listForMembership(s.tenantId, membershipId);
    const record = grants.find((g) => g.access.id === created.id);
    if (!record) throw new Error(`portal grant ${created.id} was not readable after creation`);
    return c.json(toWire(record), 201);
  });

  app.openapi(groupRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { partyId } = c.req.valid("param");
    const [companies, missing] = await Promise.all([
      deps.service.groupOf(s.tenantId, partyId),
      deps.service.groupContactsMissing(s.tenantId, partyId),
    ]);
    return c.json(
      {
        companies: companies.map((g) => ({ partyId: g.id, name: g.displayName })),
        contactsMissing: missing.map((m) => ({
          membershipId: m.membershipId,
          contactEmail: m.contactEmail,
          contactDisplayName: m.contactDisplayName,
          sees: [...m.sees],
        })),
      },
      200,
    );
  });

  app.openapi(grantGroupRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { membershipId } = c.req.valid("param");
    const body = c.req.valid("json");
    const out = await deps.service.grantGroupOf(
      { tenantId: s.tenantId, membershipId, clientPartyId: body.clientPartyId, validFrom: body.validFrom, grantedBy: s.userId },
      s.actor,
    );
    const records = await deps.service.listForMembership(s.tenantId, membershipId);
    const made = new Set(out.granted.map((g) => g.id));
    return c.json(
      {
        granted: records.filter((r) => made.has(r.access.id)).map(toWire),
        alreadyHeld: out.alreadyHeld.map((g) => ({ partyId: g.id, name: g.displayName })),
      },
      200,
    );
  });

  app.openapi(endGrantRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { grantId } = c.req.valid("param");
    const { validTo } = c.req.valid("json");
    const ended = await deps.service.end({ tenantId: s.tenantId, grantId, validTo }, s.actor);
    const grants = await deps.service.listForMembership(s.tenantId, ended.membershipId);
    const record = grants.find((g) => g.access.id === ended.id);
    if (!record) throw new Error(`portal grant ${ended.id} was not readable after ending`);
    return c.json(toWire(record), 200);
  });
}

export const portalAccessRoutes = {
  listForMembership: listForMembershipRoute,
  listForClient: listForClientRoute,
  scope: scopeRoute,
  grant: grantRoute,
  group: groupRoute,
  grantGroup: grantGroupRoute,
  endGrant: endGrantRoute,
} as const;
