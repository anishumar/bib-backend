// FinCompliance findings (docs/FIN_BUILD_PLAN.md F4.2): the staff routes,
// transport only.
//
// Mounted with the rest of fin (see `api/handler/fin.ts`): absent when
// BIB_FIN_ENABLED is off, and 404 `FIN_NOT_ENABLED` for a firm whose own switch
// is off. Reading is `books:read`; deciding is `books:write` (0388), the
// permission that says a person's answer about a client's books stands.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { scopeOf } from "../scope";
import {
  CHECK_KEY_PATTERN,
  DISMISS_REASONS,
  FINDING_DECISIONS,
  FINDING_LANES,
  FINDING_STATUSES,
  REASON_TEXT_MAX,
} from "../../domain/fin/finding";
import type { DismissReason, FindingDecision, FindingLane, FindingStatus } from "../../domain/fin/finding";
import type { FindingService } from "../../usecase/fin/findings";
import type { DecisionView, FindingDetail, FindingSummary, FindingView, StatusCounts } from "../../usecase/fin/finding-ports";

export interface FinFindingsDeps {
  readonly findings: FindingService;
}

const MAX_FINDINGS_LIMIT = 500;

const LaneEnum = z.enum(FINDING_LANES as unknown as [string, ...string[]]);
const StatusEnum = z.enum(FINDING_STATUSES as unknown as [string, ...string[]]);
const DecisionEnum = z.enum(FINDING_DECISIONS as unknown as [string, ...string[]]);
const ReasonEnum = z.enum(DISMISS_REASONS as unknown as [string, ...string[]]);

const StatusCountsSchema = z
  .object({
    open: z.number().int(),
    ask_client: z.number().int(),
    correct: z.number().int(),
    dismiss: z.number().int(),
  })
  .openapi("FinFindingStatusCounts");

const DecisionSchema = z
  .object({
    decisionId: z.string().uuid(),
    decision: DecisionEnum.openapi({
      description: "`ask_client`, `correct` or `dismiss`. The latest decision is the finding's status.",
    }),
    reasonCode: ReasonEnum.nullable().openapi({
      description: "Why it was dismissed: `price_change`, `one_off`, `seasonal`, `expected` or `other`. Null unless dismissed.",
    }),
    reasonText: z.string().nullable().openapi({
      description: "The person's own words. Required with `other`, allowed with any reason code, never otherwise.",
    }),
    decidedBy: z.object({
      userId: z.string().uuid(),
      displayName: z.string().nullable().openapi({ description: "As the account reads now; null when it has none." }),
    }),
    decidedAt: z.string().openapi({ description: "When (ISO 8601 instant)." }),
  })
  .openapi("FinFindingDecision");

const FactValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const FindingSchema = z
  .object({
    findingId: z.string().uuid(),
    lane: LaneEnum.openapi({
      description:
        "`rule`: a fixed rule broken (GST at the wrong rate, CPF over the ceiling); counted in the exception " +
        "score. `pattern`: a departure from the client's own history; shown apart and never counted.",
    }),
    checkKey: z.string().openapi({
      description: "Which check said it, e.g. `doc.duplicate_invoice`, `payroll.cpf_ow_ceiling`. The screen's words are keyed on it.",
    }),
    clientPartyId: z.string().uuid(),
    clientName: z.string(),
    periodStart: z.string().openapi({ description: "The first day of the period it belongs to (a day, YYYY-MM-DD)." }),
    periodEnd: z.string().openapi({ description: "The last day of that period (a day)." }),
    lineIds: z.array(z.string().uuid()).openapi({
      description: "The books lines it is about. May be empty (something that did NOT happen has no line).",
    }),
    facts: z.record(FactValue).openapi({
      description:
        "Machine facts, per check: amounts as decimal strings, counts, days and codes. Never a sentence; the " +
        "screen writes the words from `checkKey` and these.",
    }),
    status: StatusEnum.openapi({ description: "`open` until somebody decides; then the latest decision." }),
    latestDecision: DecisionSchema.nullable(),
    createdAt: z.string().openapi({ description: "When the check raised it (ISO 8601 instant)." }),
  })
  .openapi("FinFinding");

const FindingDetailSchema = FindingSchema.extend({
  decisions: z.array(DecisionSchema).openapi({ description: "Every decision taken on it, newest first." }),
}).openapi("FinFindingDetail");

const SummarySchema = z
  .object({
    total: z.number().int(),
    byStatus: StatusCountsSchema,
    byCheck: z.array(
      z.object({
        checkKey: z.string(),
        lane: LaneEnum,
        total: z.number().int(),
        byStatus: StatusCountsSchema,
      }),
    ),
  })
  .openapi("FinFindingSummary", {
    description:
      "The counts for the client and lane filter, by status and by check: never for one page, and not narrowed " +
      "by the `checkKey` or `status` filter, so the tabs a screen draws from them do not move as somebody clicks them.",
  });

const FindingIdParam = z.object({ findingId: z.string().uuid() });

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/fin/findings",
  tags: ["fin"],
  summary: "What FinCompliance's checks flagged, newest first",
  description:
    "Each finding is a machine saying \"check this\" about a client's books; only a person decides what it means. " +
    "A page at a time, filtered, with the counts by status and by check.",
  request: {
    query: z.object({
      clientPartyId: z.string().uuid().optional().openapi({ description: "Only this client's findings." }),
      lane: LaneEnum.optional().openapi({ description: "`rule` or `pattern`." }),
      checkKey: z.string().regex(CHECK_KEY_PATTERN).optional().openapi({ description: "Only this check's findings." }),
      status: StatusEnum.optional().openapi({ description: "`open` lists what nobody has decided yet." }),
      before: z.string().uuid().optional().openapi({ description: "The `nextBefore` of the previous page." }),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(MAX_FINDINGS_LIMIT)
        .optional()
        .openapi({ description: `How many to return (default 50, max ${String(MAX_FINDINGS_LIMIT)})` }),
    }),
  },
  responses: {
    200: {
      description: "One page of findings, and the counts",
      content: {
        "application/json": {
          schema: z
            .object({
              items: z.array(FindingSchema),
              summary: SummarySchema,
              nextBefore: z.string().uuid().nullable().openapi({
                description: "Pass as `before` for the next page; null on the last page.",
              }),
            })
            .openapi("FinFindingPage"),
        },
      },
    },
    400: errorResponse("Request failed validation"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or the role may not read the books"),
    404: errorResponse("FinCompliance is not switched on for this firm (FIN_NOT_ENABLED)"),
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/api/v1/fin/findings/{findingId}",
  tags: ["fin"],
  summary: "One finding, with every decision taken on it and who took it",
  request: { params: FindingIdParam },
  responses: {
    200: { description: "The finding", content: { "application/json": { schema: FindingDetailSchema } } },
    400: errorResponse("Request failed validation"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or the role may not read the books"),
    404: errorResponse("No such finding at this firm (FIN_FINDING_NOT_FOUND), or fin is off (FIN_NOT_ENABLED)"),
  },
});

const DecisionBody = z
  .object({
    decision: DecisionEnum.openapi({
      description:
        "`correct`: the finding stands and the line must change. `dismiss`: it does not, for `reasonCode`. " +
        "`ask_client` is refused for now (FIN_ASK_NOT_WIRED, 409): raising the client's portal ask from a " +
        "finding is not built.",
    }),
    reasonCode: ReasonEnum.nullable().optional().openapi({ description: "Required to dismiss; refused otherwise." }),
    reasonText: z
      .string()
      .max(REASON_TEXT_MAX * 2)
      .nullable()
      .optional()
      .openapi({ description: `Required with \`other\`; trimmed; at most ${String(REASON_TEXT_MAX)} characters.` }),
  })
  .openapi("FinFindingDecisionRequest");

const decideRoute = createRoute({
  method: "post",
  path: "/api/v1/fin/findings/{findingId}/decision",
  tags: ["fin"],
  summary: "Decide what a finding means",
  description:
    "Appends a decision; nothing is overwritten, and changing one's mind is a second decision. The person is " +
    "the session's, never a body field. The ledger records the decision and the reason CODE, never the words.",
  request: {
    params: FindingIdParam,
    body: { content: { "application/json": { schema: DecisionBody } }, required: true },
  },
  responses: {
    200: { description: "The finding, with the new decision", content: { "application/json": { schema: FindingDetailSchema } } },
    400: errorResponse(
      "A dismissal with no reason (FIN_DISMISSAL_NEEDS_REASON), `other` with no words (FIN_OTHER_NEEDS_WORDS), a " +
        "reason sent with another decision (FIN_REASON_ONLY_ON_DISMISSAL), or a reason too long (FIN_REASON_TOO_LONG)",
    ),
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, the role may not decide findings, or the person is not active staff"),
    404: errorResponse("No such finding at this firm (FIN_FINDING_NOT_FOUND), or fin is off (FIN_NOT_ENABLED)"),
    409: errorResponse("Asking the client from a finding is not built yet (FIN_ASK_NOT_WIRED)"),
  },
});

function counts(c: StatusCounts) {
  return { open: c.open, ask_client: c.ask_client, correct: c.correct, dismiss: c.dismiss };
}

function decisionWire(d: DecisionView) {
  return {
    decisionId: d.id,
    decision: d.decision,
    reasonCode: d.reasonCode,
    reasonText: d.reasonText,
    decidedBy: { userId: d.decidedByUserId, displayName: d.decidedByName },
    decidedAt: d.decidedAt,
  };
}

function findingWire(f: FindingView) {
  return {
    findingId: f.id,
    lane: f.lane,
    checkKey: f.checkKey,
    clientPartyId: f.clientPartyId,
    clientName: f.clientName,
    periodStart: f.periodStart,
    periodEnd: f.periodEnd,
    lineIds: [...f.lineIds],
    facts: { ...f.facts },
    status: f.status,
    latestDecision: f.latestDecision === null ? null : decisionWire(f.latestDecision),
    createdAt: f.createdAt,
  };
}

function detailWire(f: FindingDetail) {
  return { ...findingWire(f), decisions: f.decisions.map(decisionWire) };
}

function summaryWire(s: FindingSummary) {
  return {
    total: s.total,
    byStatus: counts(s.byStatus),
    byCheck: s.byCheck.map((c) => ({ checkKey: c.checkKey, lane: c.lane, total: c.total, byStatus: counts(c.byStatus) })),
  };
}

export function registerFinFindingsRoutes(app: OpenAPIHono<AppEnv>, deps: FinFindingsDeps): void {
  app.openapi(listRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const q = c.req.valid("query");
    const page = await deps.findings.list(s.tenantId, {
      clientPartyId: q.clientPartyId ?? null,
      lane: (q.lane as FindingLane | undefined) ?? null,
      checkKey: q.checkKey ?? null,
      status: (q.status as FindingStatus | undefined) ?? null,
      before: q.before ?? null,
      limit: q.limit ?? 50,
    });
    return c.json(
      { items: page.items.map(findingWire), summary: summaryWire(page.summary), nextBefore: page.nextBefore },
      200,
    );
  });

  app.openapi(getRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { findingId } = c.req.valid("param");
    return c.json(detailWire(await deps.findings.get(s.tenantId, findingId)), 200);
  });

  app.openapi(decideRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { findingId } = c.req.valid("param");
    const body = c.req.valid("json");
    const detail = await deps.findings.decide(
      s.tenantId,
      findingId,
      {
        decision: body.decision as FindingDecision,
        reasonCode: (body.reasonCode as DismissReason | null | undefined) ?? null,
        reasonText: body.reasonText ?? null,
      },
      { userId: s.userId, actor: s.actor },
    );
    return c.json(detailWire(detail), 200);
  });
}
