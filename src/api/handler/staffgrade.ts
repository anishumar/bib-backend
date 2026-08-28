// The seniority ladder's HTTP surface (G3.3) — transport only. Each handler
// parses the validated input, calls exactly one use-case method, and maps the
// result field by field. Never forwards a domain object: zod-openapi documents
// a response without validating it, so a field that is on the wire but not in
// the schema is a field the generated frontend client cannot see.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import type { StaffGradeService } from "../../usecase/staffgrade/service";
import type { StaffGrade } from "../../domain/staffgrade/model";
import { scopeOf } from "../scope";

export interface StaffGradeDeps {
  readonly service: StaffGradeService;
}

// ── Response schemas ────────────────────────────────────────────────────────

const StaffGradeSchema = z
  .object({
    id: z.string().uuid(),
    code: z.string().openapi({
      description: "The firm's stable handle for the rung. Unique within the firm, never reused.",
    }),
    name: z.string(),
    rank: z.number().int().openapi({
      description:
        "1 is the most junior. This is what a review threshold compares — 'Manager or above' " +
        "is one comparison against it. Ranks need not be unique or consecutive.",
    }),
    isActive: z.boolean().openapi({
      description:
        "Whether the firm still promotes through this rung. A retired rung is never deleted: " +
        "people who hold it keep it, and it stays readable so an old approval still explains " +
        "itself. It simply stops being offered to anybody new.",
    }),
  })
  .openapi("StaffGrade");

const StaffGradesResponse = z
  .object({ grades: z.array(StaffGradeSchema) })
  .openapi("StaffGradesResponse");

/** Field by field, so the wire shape is exactly what the schema documents.
 *  `tenantId` is deliberately absent: the caller's session already decided it,
 *  and echoing it back invites a client to think it could send a different one. */
function toWire(g: StaffGrade): z.infer<typeof StaffGradeSchema> {
  return { id: g.id, code: g.code, name: g.name, rank: g.rank, isActive: g.isActive };
}

// ── Request schemas ─────────────────────────────────────────────────────────

const CreateGradeRequest = z
  .object({
    code: z.string().min(1),
    name: z.string().min(1),
    rank: z.number().int(),
  })
  .openapi("CreateGradeRequest");

// Both fields optional and independently applied: renaming a rung and
// re-ranking it are one call or two, as the caller likes. An omitted field means
// UNCHANGED — there is nothing here that a caller could clear, which is why
// optional is right on this DTO and nullable was right on the grade assignment.
const UpdateGradeRequest = z
  .object({
    name: z.string().min(1).optional(),
    rank: z.number().int().optional(),
  })
  .openapi("UpdateGradeRequest");

const SetGradeActiveRequest = z
  .object({
    isActive: z.boolean().openapi({
      description:
        "False retires the rung: it stops being offered for new assignments, and everybody " +
        "already on it stays on it.",
    }),
  })
  .openapi("SetGradeActiveRequest");

const GradeParam = z.object({ gradeId: z.string().uuid() });

// ── Routes ──────────────────────────────────────────────────────────────────
//
// All four are `tenant:admin`, the READ included, and for the same reason the
// roster is: the ladder is a firm running itself, and between this screen and
// the roster they decide who may sign off whose work. A picker that needs the
// rungs is on the admin surface already.

const listGradesRoute = createRoute({
  method: "get",
  path: "/api/v1/tenancy/grades",
  tags: ["tenancy"],
  summary: "The firm's seniority ladder, most senior first",
  description: "Retired rungs are included — an admin needs to see them and be able to restore one.",
  responses: {
    200: {
      description: "The ladder",
      content: { "application/json": { schema: StaffGradesResponse } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
  },
});

const createGradeRoute = createRoute({
  method: "post",
  path: "/api/v1/tenancy/grades",
  tags: ["tenancy"],
  summary: "Add a rung the starting ladder did not have",
  description:
    "The firm has real designations its own hierarchy never ranked — Article, Intern, " +
    "Trainee, Head and others. They arrive here, ranked by the firm, rather than being " +
    "guessed by the product.",
  request: {
    body: { content: { "application/json": { schema: CreateGradeRequest } }, required: true },
  },
  responses: {
    201: { description: "Grade created", content: { "application/json": { schema: StaffGradeSchema } } },
    400: errorResponse("The code is not a lowercase handle, or the rank is not a positive whole number"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    409: errorResponse("This firm already has a grade with that code"),
  },
});

const updateGradeRoute = createRoute({
  method: "put",
  path: "/api/v1/tenancy/grades/{gradeId}",
  tags: ["tenancy"],
  summary: "Rename a rung, re-rank it, or both",
  description:
    "Re-ranking is the half that matters: inserting a rung below an existing one means " +
    "moving the ranks above it, and a firm that could not do that from this screen would " +
    "have to ask an engineer to run SQL against its own hierarchy.",
  request: {
    params: GradeParam,
    body: { content: { "application/json": { schema: UpdateGradeRequest } }, required: true },
  },
  responses: {
    200: {
      description: "Grade updated. Idempotent — a patch that changes nothing records nothing.",
      content: { "application/json": { schema: StaffGradeSchema } },
    },
    400: errorResponse("The rank is not a positive whole number"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("No such grade at this firm"),
  },
});

const setGradeActiveRoute = createRoute({
  method: "put",
  path: "/api/v1/tenancy/grades/{gradeId}/active",
  tags: ["tenancy"],
  summary: "Retire a rung, or bring it back",
  description:
    "Never a delete. A rung somebody held is part of why they were allowed to approve " +
    "something, so it stays readable forever.",
  request: {
    params: GradeParam,
    body: { content: { "application/json": { schema: SetGradeActiveRequest } }, required: true },
  },
  responses: {
    200: { description: "Grade retired or restored", content: { "application/json": { schema: StaffGradeSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("No such grade at this firm"),
  },
});

export function registerStaffGradeRoutes(app: OpenAPIHono<AppEnv>, deps: StaffGradeDeps): void {
  // The tenant comes from the SESSION on every one of these, so an admin can
  // only ever edit the ladder of the firm they are acting for.
  app.openapi(listGradesRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const grades = await deps.service.listGrades(s.tenantId);
    return c.json({ grades: grades.map(toWire) }, 200);
  });

  app.openapi(createGradeRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const grade = await deps.service.createGrade({ tenantId: s.tenantId, ...body }, s.actor);
    return c.json(toWire(grade), 201);
  });

  app.openapi(updateGradeRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { gradeId } = c.req.valid("param");
    const { name, rank } = c.req.valid("json");
    const grade = await deps.service.updateGrade(
      { tenantId: s.tenantId, gradeId, name, rank },
      s.actor,
    );
    return c.json(toWire(grade), 200);
  });

  app.openapi(setGradeActiveRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { gradeId } = c.req.valid("param");
    const { isActive } = c.req.valid("json");
    const grade = await deps.service.setGradeActive(
      { tenantId: s.tenantId, gradeId, isActive },
      s.actor,
    );
    return c.json(toWire(grade), 200);
  });
}

export const staffGradeRoutes = {
  listGrades: listGradesRoute,
  createGrade: createGradeRoute,
  updateGrade: updateGradeRoute,
  setGradeActive: setGradeActiveRoute,
} as const;
