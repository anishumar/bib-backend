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
import type { Lead, LeadSource, LeadStage } from "../../domain/lead/model";
import type { LeadService } from "../../usecase/lead/service";
import type { LeadRecord } from "../../usecase/lead/ports";

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
  "abandoned",
] as const satisfies readonly LeadStage[];

// ── Response schemas ────────────────────────────────────────────────────────

const LeadSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    title: z.string().openapi({
      description:
        "What this opportunity is called — the OPPORTUNITY's name, not the client's. " +
        "A list already shows the party beside it, so this is what tells two live " +
        "opportunities for the same client apart.",
    }),
    partyId: z.string().uuid(),
    source: z.enum(SOURCE_VALUES),
    stage: z.enum(STAGE_VALUES),
    ownerUserId: z.string().uuid().nullable(),
    notes: z.string().nullable(),
    lostReason: z.string().nullable().openapi({
      description:
        "Why the opportunity did not close won, in the closer's own words. Set only on " +
        "`lost` and `abandoned`; null on an open or converted lead, and null on one closed " +
        "before the field existed, which means nobody was asked.",
    }),
    jurisdiction: z.string().length(2).nullable().openapi({
      description:
        "Where the PROSPECT is, ISO 3166-1 alpha-2. Null is ordinary — often nobody knows " +
        "at capture — and an unknown country matches no territory rule, so the assignment " +
        "rotation covers it. It is also the answer a proposal drafted from this lead needs " +
        "for `clientJurisdiction`, which decides which of the firm's entities contracts.",
    }),
    capturedAt: z.string(),
    closedAt: z.string().nullable(),
  })
  .openapi("Lead");

/**
 * A lead with the people it refers to.
 *
 * The list and the single read both return this rather than the bare lead: a
 * board rendering `partyId` and `ownerUserId` shows two uuids per card, or
 * fetches a party and an account per row. The roster answers the same problem
 * the same way.
 *
 * `owner` is null for a lead in the unassigned queue, and carries an email
 * because an account may have no name — "owned by 3f9c…" helps nobody. This
 * surface is staff-only (gate 2 keeps client-portal sessions off it), so that
 * discloses a colleague's address to colleagues.
 */
const LeadRecordSchema = z
  .object({
    lead: LeadSchema,
    party: z.object({
      id: z.string().uuid(),
      kind: z.enum(["organization", "person"]),
      displayName: z.string(),
    }),
    owner: z
      .object({
        userId: z.string().uuid(),
        displayName: z.string().nullable(),
        email: z.string().email(),
      })
      .nullable(),
  })
  .openapi("LeadRecord");

const CaptureResultSchema = z
  .object({
    lead: LeadSchema,
    merged: z.boolean().openapi({
      description: "True when this capture landed on an opportunity that already existed.",
    }),
    matchedExistingParty: z.boolean().openapi({
      description: "True when the prospect was already in the firm's records.",
    }),
    // The one field this endpoint REQUIRES on every capture and then, on the
    // merge path, ignores. Answering 200/merged while silently dropping the
    // caller's words is the discard that had nothing anywhere saying it
    // happened; this is that, said out loud, to the only party who can act on
    // it. Null when the titles match, so it means "words were lost" and never
    // just "you merged".
    discardedTitle: z.string().nullable().openapi({
      description:
        "The title THIS request sent, when the capture merged onto an existing opportunity " +
        "and that opportunity keeps its own name. Null when nothing was discarded — a new " +
        "opportunity was created, or the merge target already carries these exact words. " +
        "A merge never renames a live opportunity: its title was somebody's decision and a " +
        "duplicate submission is not grounds to undo it. If this is genuinely a second piece " +
        "of work, the firm holds one live opportunity per client " +
        "(`lead_one_open_per_party`), so close or convert the existing one first — or " +
        "re-title it, if these words are the better name.",
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
    // Required, not optional-with-a-fallback. A title derived from the party
    // name would be identical for every opportunity a client ever has — the
    // state this field was added to end, wearing a NOT NULL badge.
    title: z.string().min(1).max(200).openapi({
      description:
        "What this opportunity is called — \"FY27 statutory audit\", \"GST registration for " +
        "the Pune plant\". Name the work, not the client: the list shows the client already.",
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
    // THREE meanings on one field, and every one of them is an instruction
    // somebody actually gives. Absent: nobody was named, so the firm's
    // assignment strategy chooses — the everyday web-form capture. Null: leave
    // it in the unassigned queue on purpose, for a firm that triages first. A
    // uuid: that person, and no rotation second-guesses a human decision.
    //
    // Nullable AND optional, which is rare here and earns it: collapsing the
    // first two would mean either abolishing the unassigned queue or never
    // rotating at all.
    ownerUserId: z.string().uuid().nullable().optional().openapi({
      description:
        "Whose desk to put it on. Omit the field to let the firm's assignment strategy " +
        "choose (round robin over active staff today); send null to leave it in the " +
        "unassigned queue deliberately; send a user id to assign it to that colleague, " +
        "who must be active staff at this firm.",
    }),
    notes: z.string().optional(),
    jurisdiction: z.string().length(2).optional().openapi({
      description:
        "Where the PROSPECT is, ISO 3166-1 alpha-2 in UPPER CASE. Optional — often nobody " +
        "knows at capture, and a capture is never refused for it. Demanded in canonical case " +
        "rather than normalised, because it is compared against the firm's territory rules.",
    }),
  })
  .openapi("CaptureLeadRequest");

const MoveStageBody = z
  .object({
    stage: z.enum(STAGE_VALUES),
    // Not `.nullable()`: null and absent would mean the same thing here, and one
    // spelling for one meaning keeps the generated client honest. Whether it is
    // required is a rule about the STAGE, so it lives in the service where the
    // refusal can say why rather than "invalid_type".
    lostReason: z.string().min(1).max(2000).optional().openapi({
      description:
        "Why it did not close won. REQUIRED moving to `lost` or `abandoned`, refused on any " +
        "other stage. Free text on purpose: a dropdown of five reasons produces five reasons, " +
        "and the useful one is always the sixth.",
    }),
  })
  .openapi("MoveLeadStageRequest");

const AssignOwnerBody = z
  .object({
    // Nullable rather than optional: null is an instruction (put it back in the
    // unassigned queue), and an absent field would be indistinguishable from it.
    ownerUserId: z.string().uuid().nullable(),
  })
  .openapi("AssignLeadOwnerRequest");

// ── Routes ────────────────────────────────────────────────────────────────

/** The caller's today: what the contact details a capture attaches are dated
 *  from. Absent means the firm's day, never the server's. */
const CaptureQuery = z.object({
  asOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .openapi({
      description:
        "Today where the caller is (a browser sends its local date). Defaults to the firm's " +
        "day. Must be the firm's day or one either side.",
    }),
});

const captureRoute = createRoute({
  method: "post",
  path: "/api/v1/leads",
  tags: ["lead"],
  summary: "Capture a lead, deduplicating on phone, PAN and email first",
  description:
    "A capture that names no owner is assigned by the firm's assignment strategy — round " +
    "robin over active staff. Send `ownerUserId: null` to keep it in the unassigned queue " +
    "instead. A capture that MERGES onto an existing opportunity never reassigns or renames " +
    "it: the owner and the title on a live lead were somebody's decision and a duplicate " +
    "form submission is not grounds to undo either. The title the merged capture sent comes " +
    "back on `discardedTitle` rather than being dropped in silence.",
  request: {
    query: CaptureQuery,
    body: { content: { "application/json": { schema: CaptureLeadBody } }, required: true },
  },
  responses: {
    201: {
      description: "A new opportunity was created",
      content: { "application/json": { schema: CaptureResultSchema } },
    },
    200: {
      description:
        "The prospect already had a live opportunity; this capture was appended to it and " +
        "nothing was created. The opportunity keeps its own title — read `discardedTitle` " +
        "to see whether the one you sent was dropped.",
      content: { "application/json": { schema: CaptureResultSchema } },
    },
    400: errorResponse(
      "Unknown source, a blank title, no contact identifier, or an invalid identifier",
    ),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not write parties"),
    409: errorResponse(
      "The contact details belong to more than one existing party, or to a client the firm archived",
    ),
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
          schema: z.object({ leads: z.array(LeadRecordSchema) }).openapi("LeadList"),
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
    200: {
      description: "The lead, with the prospect and the owner",
      content: { "application/json": { schema: LeadRecordSchema } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read parties"),
    404: errorResponse("No such lead in this firm"),
  },
});

const moveStageRoute = createRoute({
  method: "post",
  path: "/api/v1/leads/{leadId}/stage",
  tags: ["lead"],
  summary: "Move a lead through the pipeline; an unwon close says why",
  request: {
    params: LeadParam,
    body: { content: { "application/json": { schema: MoveStageBody } }, required: true },
  },
  responses: {
    200: { description: "Moved", content: { "application/json": { schema: LeadSchema } } },
    400: errorResponse(
      "Unknown stage, a close with no reason, or a reason on a stage that takes none",
    ),
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

/**
 * Named field by field rather than forwarded, so a field added to the read
 * model cannot reach the wire without also reaching the spec.
 *
 * The comment above this function said exactly that while the body underneath
 * it spread `record.lead`, which is the SAME shape of bug `/auth/me` shipped:
 * zod-openapi documents a response without validating it, so a spread ships
 * whatever the domain object happens to hold. T2.1b's `jurisdiction` reached
 * the wire undocumented that way and `tests/api/openapi.test.ts` — the general
 * assertion — caught it before it merged. The fields are now listed.
 */
function toRecordBody(record: LeadRecord): z.infer<typeof LeadRecordSchema> {
  return {
    lead: toLeadBody(record.lead),
    party: { ...record.party },
    owner: record.owner === null ? null : { ...record.owner },
  };
}

function toLeadBody(lead: Lead): z.infer<typeof LeadSchema> {
  return {
    id: lead.id,
    tenantId: lead.tenantId,
    title: lead.title,
    partyId: lead.partyId,
    source: lead.source,
    stage: lead.stage,
    ownerUserId: lead.ownerUserId,
    notes: lead.notes,
    lostReason: lead.lostReason,
    jurisdiction: lead.jurisdiction,
    capturedAt: lead.capturedAt,
    closedAt: lead.closedAt,
  };
}

// ── Territory rules (T2.1b) ────────────────────────────────────────────────
//
// Whose desk covers leads from a country. The twin of the firm-entity
// preferences screen, and the same shape of rule: one row per country, no
// wildcard — because assignment already has a better fallback than a catch-all
// row, which is the rotation.

const TerritoryRuleSchema = z
  .object({
    id: z.string().uuid(),
    jurisdiction: z.string().length(2),
    ownerUserId: z.string().uuid(),
    note: z.string().nullable(),
  })
  .openapi("TerritoryRule");

const TerritoryRulesResponse = z
  .object({ rules: z.array(TerritoryRuleSchema) })
  .openapi("TerritoryRulesResponse");

const SetTerritoryRuleRequest = z
  .object({
    jurisdiction: z.string().length(2),
    ownerUserId: z.string().uuid(),
    note: z.string().max(1000).optional(),
  })
  .openapi("SetTerritoryRuleRequest");

const listTerritoryRoute = createRoute({
  method: "get",
  path: "/api/v1/territory-rules",
  tags: ["leads"],
  summary: "Whose desk covers leads from where",
  description:
    "A country with no rule is not a gap: the assignment rotation covers it, which is why " +
    "there is no wildcard row.",
  responses: {
    200: {
      description: "The firm's territory rules",
      content: { "application/json": { schema: TerritoryRulesResponse } },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const setTerritoryRoute = createRoute({
  method: "post",
  path: "/api/v1/territory-rules",
  tags: ["leads"],
  summary: "Say whose desk covers a country",
  description:
    "Upserts the row for that country — the schema allows exactly one desk per country, " +
    "because two rules for one country is an ambiguity a strategy would have to break " +
    "arbitrarily. The owner must be active staff.",
  request: {
    body: {
      content: { "application/json": { schema: SetTerritoryRuleRequest } },
      required: true,
    },
  },
  responses: {
    200: { description: "Set", content: { "application/json": { schema: TerritoryRuleSchema } } },
    400: errorResponse("Not an ISO 3166-1 alpha-2 code in upper case"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    409: errorResponse("That user is not active staff at this firm"),
  },
});

export function registerLeadRoutes(app: OpenAPIHono<AppEnv>, deps: LeadDeps): void {
  app.openapi(captureRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const result = await deps.service.capture(
      { tenantId: s.tenantId, ...body, asOf: c.req.valid("query").asOf },
      s.actor,
    );
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
    return c.json({ leads: leads.map(toRecordBody) }, 200);
  });

  app.openapi(getRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { leadId } = c.req.valid("param");
    return c.json(toRecordBody(await deps.service.get(s.tenantId, leadId)), 200);
  });

  app.openapi(moveStageRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { leadId } = c.req.valid("param");
    const { stage, lostReason } = c.req.valid("json");
    return c.json(
      await deps.service.moveStage({ tenantId: s.tenantId, leadId, stage, lostReason }, s.actor),
      200,
    );
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
  app.openapi(listTerritoryRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const rules = await deps.service.listTerritoryRules(s.tenantId);
    return c.json(
      {
        rules: rules.map((r) => ({
          id: r.id,
          jurisdiction: r.jurisdiction,
          ownerUserId: r.ownerUserId,
          note: r.note,
        })),
      },
      200,
    );
  });

  app.openapi(setTerritoryRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const saved = await deps.service.setTerritoryRule(
      { tenantId: s.tenantId, ...c.req.valid("json") },
      s.actor,
    );
    return c.json(
      {
        id: saved.id,
        jurisdiction: saved.jurisdiction,
        ownerUserId: saved.ownerUserId,
        note: saved.note,
      },
      200,
    );
  });
}
