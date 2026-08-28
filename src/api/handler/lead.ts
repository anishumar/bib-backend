// Lead HTTP surface — transport only. Each route declares its wire shape (the
// zod schemas ARE the DTOs and the OpenAPI spec) and its handler parses the
// validated input, calls exactly one use-case method, and maps the result.
//
// THE TENANT COMES FROM THE SESSION, like every app-facing route.
//
// Note the two success codes on capture. A duplicate submission returns 200,
// not 201, because nothing was created — it landed on the opportunity that was
// already there. Answering 201 to both would tell a form it had made something
// when it had not, which is how the same prospect ends up submitted twice on
// purpose.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { scopeOf } from "../scope";
import { IdentifierTypeSchema } from "./party";
import type { LeadSource, LeadStage } from "../../domain/lead/model";
import type { LeadService } from "../../usecase/lead/service";

export interface LeadDeps {
  readonly service: LeadService;
}

// The closed sets live in the domain; zod needs literal tuples, so `satisfies`
// makes a value that is not a source or a stage a compile error here, and a
// unit test asserts neither list has silently fallen behind the domain's.
export const SOURCE_VALUES = [
  "referral",
  "inbound",
  "outbound",
  "event",
  "partner",
  "other",
] as const satisfies readonly LeadSource[];

export const STAGE_VALUES = [
  "new",
  "contacted",
  "qualified",
  "converted",
  "lost",
] as const satisfies readonly LeadStage[];

// ── Response schemas ────────────────────────────────────────────────────────

const LeadSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    partyId: z.string().uuid(),
    source: z.enum(SOURCE_VALUES),
    stage: z.enum(STAGE_VALUES),
    ownerUserId: z.string().uuid().nullable(),
    notes: z.string().nullable(),
    capturedAt: z.string(),
    closedAt: z.string().nullable(),
  })
  .openapi("Lead");

const CaptureResultSchema = z
  .object({
    lead: LeadSchema,
    merged: z.boolean().openapi({
      description: "True when this capture landed on an opportunity that already existed.",
    }),
    matchedExistingParty: z.boolean().openapi({
      description: "True when the prospect was already in the firm's records.",
    }),
  })
  .openapi("LeadCaptureResult");

// ── Request schemas ──────────────────────────────────────────────────────────

const LeadParam = z.object({ leadId: z.string().uuid() });

const CaptureLeadBody = z
  .object({
    source: z.enum(SOURCE_VALUES),
    kind: z.enum(["organization", "person"]),
    name: z.string().min(1).openapi({
      description: "The organization's legal name, or the person's full name.",
    }),
    // At least one on the wire; the service additionally requires one of them
    // to be a dedup type, with a message explaining why.
    identifiers: z
      .array(z.object({ type: IdentifierTypeSchema, value: z.string().min(1) }))
      .min(1)
      .openapi({ description: "How to reach them. At least one email, phone or PAN." }),
    tradeName: z.string().min(1).optional(),
    industry: z.string().min(1).optional(),
    website: z.string().min(1).optional(),
    ownerUserId: z.string().uuid().optional(),
    notes: z.string().optional(),
  })
  .openapi("CaptureLeadRequest");

const MoveStageBody = z.object({ stage: z.enum(STAGE_VALUES) }).openapi("MoveLeadStageRequest");

const AssignOwnerBody = z
  .object({
    // Nullable rather than optional: null is an instruction (put it back in the
    // unassigned queue), and an absent field would be indistinguishable from it.
    ownerUserId: z.string().uuid().nullable(),
  })
  .openapi("AssignLeadOwnerRequest");

// ── Routes ────────────────────────────────────────────────────────────────

const captureRoute = createRoute({
  method: "post",
  path: "/api/v1/leads",
  tags: ["lead"],
  summary: "Capture a lead, deduplicating on phone, PAN and email first",
  request: {
    body: { content: { "application/json": { schema: CaptureLeadBody } }, required: true },
  },
  responses: {
    201: {
      description: "A new opportunity was created",
      content: { "application/json": { schema: CaptureResultSchema } },
    },
    200: {
      description:
        "The prospect already had a live opportunity; this capture was appended to it and nothing was created",
      content: { "application/json": { schema: CaptureResultSchema } },
    },
    400: errorResponse("Unknown source, no contact identifier, or an invalid identifier"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not write parties"),
    409: errorResponse("The contact details belong to more than one existing party"),
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/leads",
  tags: ["lead"],
  summary: "The pipeline, newest first",
  request: {
    query: z.object({
      stage: z.enum(STAGE_VALUES).optional().openapi({ description: "One stage of the pipeline" }),
    }),
  },
  responses: {
    200: {
      description: "Leads",
      content: {
        "application/json": {
          schema: z.object({ leads: z.array(LeadSchema) }).openapi("LeadList"),
        },
      },
    },
    400: errorResponse("Unknown stage"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read parties"),
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/api/v1/leads/{leadId}",
  tags: ["lead"],
  summary: "One lead. Its history is GET /api/v1/objects/lead/{leadId}/events",
  request: { params: LeadParam },
  responses: {
    200: { description: "The lead", content: { "application/json": { schema: LeadSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read parties"),
    404: errorResponse("No such lead in this firm"),
  },
});

const moveStageRoute = createRoute({
  method: "post",
  path: "/api/v1/leads/{leadId}/stage",
  tags: ["lead"],
  summary: "Move a lead through the pipeline",
  request: {
    params: LeadParam,
    body: { content: { "application/json": { schema: MoveStageBody } }, required: true },
  },
  responses: {
    200: { description: "Moved", content: { "application/json": { schema: LeadSchema } } },
    400: errorResponse("Unknown stage"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not write parties"),
    404: errorResponse("No such lead in this firm"),
    409: errorResponse("The lead is already at that stage, or is closed"),
  },
});

const assignOwnerRoute = createRoute({
  method: "put",
  path: "/api/v1/leads/{leadId}/owner",
  tags: ["lead"],
  summary: "Put a lead on somebody's desk, or take it off",
  request: {
    params: LeadParam,
    body: { content: { "application/json": { schema: AssignOwnerBody } }, required: true },
  },
  responses: {
    200: {
      description: "Assigned. Idempotent — re-assigning the current owner records nothing.",
      content: { "application/json": { schema: LeadSchema } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not write parties"),
    404: errorResponse("No such lead in this firm"),
    409: errorResponse("The proposed owner is not active staff at this firm"),
  },
});

// ── Registration ────────────────────────────────────────────────────────────

export function registerLeadRoutes(app: OpenAPIHono<AppEnv>, deps: LeadDeps): void {
  app.openapi(captureRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const result = await deps.service.capture({ tenantId: s.tenantId, ...body }, s.actor);
    // Two literal calls rather than a computed status: 200 and 201 mean
    // different things here and the route documents both.
    if (result.merged) return c.json(result, 200);
    return c.json(result, 201);
  });

  app.openapi(listRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { stage } = c.req.valid("query");
    const leads = await deps.service.list(s.tenantId, stage);
    return c.json({ leads: [...leads] }, 200);
  });

  app.openapi(getRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { leadId } = c.req.valid("param");
    return c.json(await deps.service.get(s.tenantId, leadId), 200);
  });

  app.openapi(moveStageRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { leadId } = c.req.valid("param");
    const { stage } = c.req.valid("json");
    return c.json(await deps.service.moveStage({ tenantId: s.tenantId, leadId, stage }, s.actor), 200);
  });

  app.openapi(assignOwnerRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { leadId } = c.req.valid("param");
    const { ownerUserId } = c.req.valid("json");
    return c.json(
      await deps.service.assignOwner({ tenantId: s.tenantId, leadId, ownerUserId }, s.actor),
      200,
    );
  });
}
