// The firm's delivery structure over HTTP (G2.4) — transport only. Each handler
// parses the validated input, calls exactly one use-case method, and maps the
// result field by field. Never forwards a domain object: zod-openapi documents a
// response without validating it, so a field on the wire but not in the schema
// is a field the generated frontend client cannot see.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import type { ServiceAxisService } from "../../usecase/serviceaxis/service";
import type { ServiceAxis } from "../../domain/serviceaxis/model";
import { scopeOf } from "../scope";

export interface ServiceAxisDeps {
  readonly service: ServiceAxisService;
}

// ── Response schemas ────────────────────────────────────────────────────────

const AxisKind = z.enum(["dept", "team"]).openapi({
  description:
    "Which of the firm's two lists. 'dept' is the revenue axis — the firm's own dashboard " +
    "splits income by it and a client gets a SPOC per Dept. 'team' is who actually delivers " +
    "the work. They are INDEPENDENT, not a hierarchy: one delivery team commonly works under " +
    "several Depts, which is why nesting them would force a duplicate catalogue row per Dept.",
});

const ServiceAxisSchema = z
  .object({
    id: z.string().uuid(),
    axis: AxisKind,
    code: z.string().openapi({
      description:
        "The value a service's Dept/team field holds, and the one field that never changes. " +
        "Every published service body joins on it, and those bodies are frozen — so a firm " +
        "that wants a different code adds a row and retires the old one.",
    }),
    name: z.string().openapi({
      description: "What people read. Freely editable, unlike the code.",
    }),
    sortOrder: z.number().int().openapi({
      description: "The order the firm reads its own list in. Not unique, not consecutive.",
    }),
    isActive: z.boolean().openapi({
      description:
        "Whether the firm still files new work here. A retired row is never deleted: services " +
        "already naming it keep it and still read, so an old filing still explains itself.",
    }),
  })
  .openapi("ServiceAxis");

const WorkSplit = z.enum(["none", "dept", "team"]).openapi({
  description:
    "How this firm cuts ONE client's work into separate jobs. 'none' keeps it all in one job " +
    "— the default, and what most firms want. 'dept' or 'team' groups an engagement's service " +
    "lines by that axis and gives each group its own job and its own step graph.",
});

const FirmStructureResponse = z
  .object({
    axes: z.array(ServiceAxisSchema),
    workSplitAxis: WorkSplit,
    /** The IANA zone this firm's months and days are cut on. 'UTC' until
     *  somebody chooses, which is what every firm had before 0071. */
    timeZone: z.string(),
  })
  .openapi("FirmStructureResponse");

/** Field by field, so the wire shape is exactly what the schema documents.
 *  `tenantId` is deliberately absent: the caller's session already decided it. */
function toWire(a: ServiceAxis): z.infer<typeof ServiceAxisSchema> {
  return {
    id: a.id,
    axis: a.axis,
    code: a.code,
    name: a.name,
    sortOrder: a.sortOrder,
    isActive: a.isActive,
  };
}

// ── Request schemas ─────────────────────────────────────────────────────────

const CreateAxisRequest = z
  .object({
    axis: AxisKind,
    code: z.string().min(1).openapi({
      description:
        "Upper case, single separators — 'FRC', 'VCFO CONSOLE'. Normalised before it is " +
        "stored, so 'frc' becomes 'FRC' rather than a second Dept.",
    }),
    name: z.string().min(1),
    sortOrder: z.number().int().default(0),
  })
  .openapi("CreateServiceAxisRequest");

// Both optional and independently applied. An omitted field means UNCHANGED.
// `code` is absent on purpose — see the schema description above.
const UpdateAxisRequest = z
  .object({
    name: z.string().min(1).optional(),
    sortOrder: z.number().int().optional(),
  })
  .openapi("UpdateServiceAxisRequest");

const SetAxisActiveRequest = z
  .object({
    isActive: z.boolean().openapi({
      description:
        "False retires it: nothing new may be filed under it, and everything already filed " +
        "there stays. Refused if it would leave the axis the firm splits work by with nothing " +
        "active on it — that state looks identical to 'none' and would silently behave as it.",
    }),
  })
  .openapi("SetServiceAxisActiveRequest");

const SetWorkSplitRequest = z
  .object({ workSplitAxis: WorkSplit })
  .openapi("SetWorkSplitRequest");

const AxisParam = z.object({ axisId: z.string().uuid() });

// ── Routes ──────────────────────────────────────────────────────────────────
//
// All five are `tenant:admin`, the READ included, and for the same reason the
// roster and the grade ladder are: this is a firm describing itself, and the
// choice made here decides how every future engagement is cut up. Anything that
// needs the lists to render a picker is on the admin surface already.

const getStructureRoute = createRoute({
  method: "get",
  path: "/api/v1/tenancy/structure",
  tags: ["tenancy"],
  summary: "The firm's Depts and delivery teams, and how it splits work",
  description:
    "BOTH lists in one response, retired rows included — a screen renders two pickers and an " +
    "admin needs to see what was retired and be able to restore it. The chosen split axis " +
    "comes back with them because it is meaningless without the list it names.",
  responses: {
    200: {
      description: "The firm's structure",
      content: { "application/json": { schema: FirmStructureResponse } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
  },
});

const createAxisRoute = createRoute({
  method: "post",
  path: "/api/v1/tenancy/structure/axes",
  tags: ["tenancy"],
  summary: "Add a Dept or a delivery team",
  request: {
    body: { content: { "application/json": { schema: CreateAxisRequest } }, required: true },
  },
  responses: {
    201: {
      description: "Added",
      content: { "application/json": { schema: ServiceAxisSchema } },
    },
    400: errorResponse("The code is not in canonical form, or the name is empty"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    409: errorResponse("This firm already has a row with that code on that list"),
  },
});

const updateAxisRoute = createRoute({
  method: "put",
  path: "/api/v1/tenancy/structure/axes/{axisId}",
  tags: ["tenancy"],
  summary: "Rename a Dept or delivery team, or reorder it",
  description:
    "The CODE cannot be changed: every published service body joins on it and those bodies are " +
    "frozen. Retire the row and add a new one instead — which leaves the history readable.",
  request: {
    params: AxisParam,
    body: { content: { "application/json": { schema: UpdateAxisRequest } }, required: true },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: ServiceAxisSchema } } },
    400: errorResponse("The name is empty or too long"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("No such Dept or delivery team at this firm"),
  },
});

const setAxisActiveRoute = createRoute({
  method: "put",
  path: "/api/v1/tenancy/structure/axes/{axisId}/active",
  tags: ["tenancy"],
  summary: "Retire a Dept or delivery team, or bring it back",
  request: {
    params: AxisParam,
    body: { content: { "application/json": { schema: SetAxisActiveRequest } }, required: true },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: ServiceAxisSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("No such Dept or delivery team at this firm"),
    409: errorResponse("Retiring it would empty the axis this firm splits work by"),
  },
});

const SetTimeZoneRequest = z
  .object({ timeZone: z.string().min(1) })
  .openapi("SetTimeZoneRequest");

const setTimeZoneRoute = createRoute({
  method: "put",
  path: "/api/v1/tenancy/structure/time-zone",
  tags: ["tenancy"],
  summary: "Choose which calendar this firm's months and days are cut on",
  description:
    "An IANA zone. It decides which calendar MONTH a document falls into on a client's month " +
    "view, and which calendar DAY the chaser counts from — NOT how any date is displayed, " +
    "which is always the reader's own zone. Changing it restates nothing stored, and does " +
    "re-cut what a past month view SHOWS, because that page is computed on read.",
  request: {
    body: { content: { "application/json": { schema: SetTimeZoneRequest } }, required: true },
  },
  responses: {
    200: {
      description: "The zone now in force",
      content: { "application/json": { schema: z.object({ timeZone: z.string() }) } },
    },
    400: errorResponse("Not a time zone this system knows"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
  },
});

const setWorkSplitRoute = createRoute({
  method: "put",
  path: "/api/v1/tenancy/structure/work-split",
  tags: ["tenancy"],
  summary: "Choose how this firm cuts one client's work into separate jobs",
  description:
    "Changing this restates nothing: jobs already created keep the rows they have, and the " +
    "next engagement is split the new way. Refused when the chosen list has nothing active on " +
    "it, because that setting would take effect and do nothing.",
  request: {
    body: { content: { "application/json": { schema: SetWorkSplitRequest } }, required: true },
  },
  responses: {
    200: {
      description: "The axis now in force",
      content: { "application/json": { schema: z.object({ workSplitAxis: WorkSplit }) } },
    },
    400: errorResponse("Not one of none / dept / team"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    409: errorResponse("That list has nothing active on it"),
  },
});

export function registerServiceAxisRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: ServiceAxisDeps,
): void {
  // The tenant comes from the SESSION on every one of these, so an admin can
  // only ever describe the firm they are acting for.
  app.openapi(getStructureRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const [axes, workSplitAxis, timeZone] = await Promise.all([
      deps.service.listAll(s.tenantId),
      deps.service.getWorkSplit(s.tenantId),
      deps.service.getTimeZone(s.tenantId),
    ]);
    return c.json({ axes: axes.map(toWire), workSplitAxis, timeZone }, 200);
  });

  app.openapi(createAxisRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const row = await deps.service.createAxis({ tenantId: s.tenantId, ...body }, s.actor);
    return c.json(toWire(row), 201);
  });

  app.openapi(updateAxisRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { axisId } = c.req.valid("param");
    const { name, sortOrder } = c.req.valid("json");
    const row = await deps.service.updateAxis(
      { tenantId: s.tenantId, id: axisId, name, sortOrder },
      s.actor,
    );
    return c.json(toWire(row), 200);
  });

  app.openapi(setAxisActiveRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { axisId } = c.req.valid("param");
    const { isActive } = c.req.valid("json");
    const row = await deps.service.setAxisActive(
      { tenantId: s.tenantId, id: axisId, isActive },
      s.actor,
    );
    return c.json(toWire(row), 200);
  });

  app.openapi(setWorkSplitRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { workSplitAxis } = c.req.valid("json");
    const chosen = await deps.service.setWorkSplit(
      { tenantId: s.tenantId, axis: workSplitAxis },
      s.actor,
    );
    return c.json({ workSplitAxis: chosen }, 200);
  });

  app.openapi(setTimeZoneRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { timeZone } = c.req.valid("json");
    const chosen = await deps.service.setTimeZone({ tenantId: s.tenantId, timeZone }, s.actor);
    return c.json({ timeZone: chosen }, 200);
  });
}

export const serviceAxisRoutes = {
  getStructure: getStructureRoute,
  createAxis: createAxisRoute,
  updateAxis: updateAxisRoute,
  setAxisActive: setAxisActiveRoute,
  setWorkSplit: setWorkSplitRoute,
} as const;
