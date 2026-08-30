// The compliance calendar over HTTP (T3.2) — transport only. Each handler
// parses the validated input, calls exactly one use-case method, and maps the
// result field by field. Never forwards a domain object: zod-openapi documents a
// response without validating it, so a field on the wire but not in the schema
// is a field the generated frontend client cannot see.
//
// ── THERE IS NO `POST /obligations`, AND THERE WILL NOT BE ─────────────────
//
// The calendar is GENERATED from rules, entities and engagements. A route that
// let a human add a row would let the calendar disagree with the statute, and a
// calendar that can drift is Excel with extra steps. What a person may do is
// change the RULES, which is what the four rule routes are for.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import type { ObligationService } from "../../usecase/obligation/service";
import { coverageOf } from "../../domain/obligation/model";
import type { TemplateRecord } from "../../usecase/obligation/ports";
import { scopeOf } from "../scope";

export interface ObligationDeps {
  readonly service: ObligationService;
}

// ── Shared vocabulary ───────────────────────────────────────────────────────

const Recurrence = z
  .enum(["monthly", "quarterly", "half_yearly", "annual", "event"])
  .openapi({
    description:
      "How often the filing comes round. 'event' means it is triggered by something happening " +
      "— a share allotment, a director change — so it has no period and produces no calendar " +
      "entries, because nothing in this system yet knows the event occurred. It is still a " +
      "row so the firm can see that the obligation is known about.",
  });

const DueRuleKind = z.enum(["day_of_month", "days_after"]).openapi({
  description:
    "'day_of_month' is N months after the period ends, then day D — 'the 20th of the month " +
    "following'. 'days_after' is N days after the period ends. Both are DATA rather than a " +
    "formula somebody has to parse, which is what lets the database check them.",
});

const RuleStatus = z.enum(["unconfirmed", "confirmed"]).openapi({
  description:
    "Whether a partner has checked this date against the statute. Everything ships " +
    "'unconfirmed', India included: the dates came from a document rather than from the firm, " +
    "and the firm's own practice may be earlier than the law.",
});

const Coverage = z
  .enum(["generating", "needs_formula", "event_driven", "retired"])
  .openapi({
    description:
      "What this rule is actually doing, derived rather than stored. 'needs_formula' is NOT an " +
      "error and is the ordinary state of most of the shipped pack — it means the obligation " +
      "is real and its timing depends on a fact this system does not hold (an AGM date, a " +
      "State, a turnover). The reason is on the rule.",
  });

const DueRuleSchema = z
  .object({
    kind: DueRuleKind,
    dueMonthOffset: z.number().int().min(0).nullable(),
    dueDayOfMonth: z.number().int().min(1).max(31).nullable(),
    dueDaysAfter: z.number().int().min(0).nullable(),
  })
  .openapi("ObligationDueRule");

const ExceptionSchema = z
  .object({
    periodEndMonth: z.number().int().min(1).max(12).openapi({
      description:
        "The calendar month the filed PERIOD ends in. March is 3 — the month of the deduction, " +
        "never the month it is due, because the due month is exactly what the exception changes.",
    }),
    kind: DueRuleKind,
    dueMonthOffset: z.number().int().nullable(),
    dueDayOfMonth: z.number().int().nullable(),
    dueDaysAfter: z.number().int().nullable(),
    note: z.string().openapi({
      description:
        "Why this period is different, in the firm's own words. Mandatory: a partner checking " +
        "the calendar against the statute cannot otherwise tell a real carve-out from a typo.",
    }),
  })
  .openapi("ObligationException");

const RuleSchema = z
  .object({
    id: z.string().uuid(),
    jurisdiction: z.string(),
    entityType: z.string().nullable().openapi({
      description: "Null means every entity type — the common case: GST does not care what " +
        "shape the company is.",
    }),
    serviceEntryId: z.string().uuid().nullable(),
    serviceName: z.string().nullable(),
    module: z.string().nullable().openapi({
      description:
        "The STATUTE's grouping — 'GST', 'TDS', 'MCA'. Not the firm's revenue Dept, which is a " +
        "different axis: a client can buy FRC work that produces GST obligations.",
    }),
    name: z.string(),
    authority: z.string().nullable(),
    recurrence: Recurrence,
    fiscalYearStartMonth: z.number().int().min(1).max(12).openapi({
      description: "4 for India. An Indian quarter runs Apr-Jun, so leaving this at 1 would " +
        "put every quarterly filing in the wrong period.",
    }),
    dueRule: DueRuleSchema.nullable(),
    unresolvedReason: z.string().nullable().openapi({
      description:
        "Present exactly when there is no due formula: what this system still needs before it " +
        "can produce a date. This is what the screen shows in place of a deadline.",
    }),
    leadTimeDays: z.number().int().min(0).openapi({
      description:
        "T-X, the firm's own practice rather than the law: how many days before the statutory " +
        "date the task appears. Ships at 0 for every rule, because nobody has told us the " +
        "firm's lead times and a guessed one is a commitment it never made.",
    }),
    rulePack: z.string(),
    supersedesId: z.string().uuid().nullable(),
    status: RuleStatus,
    isActive: z.boolean(),
    coverage: Coverage,
    exceptions: z.array(ExceptionSchema),
    instanceCount: z.number().int().openapi({
      description: "How many calendar rows this rule has produced, ever.",
    }),
  })
  .openapi("ObligationRule");

const CalendarRowSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    authority: z.string().nullable(),
    module: z.string().nullable(),
    entityPartyId: z.string().uuid(),
    entityName: z.string().nullable(),
    clientName: z.string().nullable(),
    periodLabel: z.string().openapi({
      description: "'Aug 2026', 'Q2 FY2026-27'. Stored rather than derived, so a rule retired " +
        "later cannot change how a filing already made is described.",
    }),
    statutoryDueOn: z.string().openapi({
      description: "What the LAW says. Missing it is the client's money.",
    }),
    internalTargetOn: z.string().openapi({
      description:
        "What the FIRM gave itself, T-X earlier. This is the actionable date and the one the " +
        "list is ordered by — a list sorted by the legal deadline tells you when you are " +
        "already too late.",
    }),
    stateCode: z.string(),
    stateName: z.string(),
    isTerminal: z.boolean(),
    needsDecision: z.boolean(),
    workItemId: z.string().uuid().nullable().openapi({
      description: "The task raised for it, once T-X has arrived. Null is 'known, not yet " +
        "started' — a year of those is the calendar's normal state, not a backlog.",
    }),
    filedOn: z.string().nullable(),
    ruleUnconfirmed: z.boolean().openapi({
      description:
        "The rule behind this date has not been confirmed by the firm. Shown rather than " +
        "hidden: a plausible-looking wrong due date is the dangerous kind.",
    }),
    rulePack: z.string(),
  })
  .openapi("CalendarRow");

const CoverageGapSchema = z
  .object({
    engagementId: z.string().uuid(),
    entityPartyId: z.string().uuid(),
    entityName: z.string().nullable(),
    clientName: z.string().nullable(),
    serviceName: z.string().nullable(),
    jurisdiction: z.string().nullable(),
    reason: z
      .enum([
        "entity_not_registered",
        "no_rule_names_this_service",
        "no_rule_for_jurisdiction",
        "rules_need_a_formula",
        "rules_retired",
        "nothing_due_yet",
      ])
      .openapi({
        description:
          "Why the calendar produced nothing for this engagement. NONE of these is an error: " +
          "'no_rule_names_this_service' is the ordinary state of advisory work. Each names " +
          "something a partner can do next, which is the point — an empty calendar with no " +
          "explanation is indistinguishable from broken software.",
      }),
    blockedRuleIds: z.array(z.string().uuid()).openapi({
      description: "Rules that name this service but could not be used, so the screen can link " +
        "straight to them.",
    }),
  })
  .openapi("CoverageGap");

function ruleToWire(r: TemplateRecord): z.infer<typeof RuleSchema> {
  const t = r.template;
  return {
    id: t.id,
    jurisdiction: t.jurisdiction,
    entityType: t.entityType,
    serviceEntryId: t.serviceEntryId,
    serviceName: r.serviceName,
    module: t.module,
    name: t.name,
    authority: t.authority,
    recurrence: t.recurrence,
    fiscalYearStartMonth: t.fiscalYearStartMonth,
    dueRule: t.dueRule
      ? {
          kind: t.dueRule.kind,
          dueMonthOffset: t.dueRule.dueMonthOffset,
          dueDayOfMonth: t.dueRule.dueDayOfMonth,
          dueDaysAfter: t.dueRule.dueDaysAfter,
        }
      : null,
    unresolvedReason: t.unresolvedReason,
    leadTimeDays: t.leadTimeDays,
    rulePack: t.rulePack,
    supersedesId: t.supersedesId,
    status: t.status,
    isActive: t.isActive,
    // DERIVED here rather than stored, so the screen and the generator cannot
    // disagree about what a rule is doing.
    coverage: coverageOf(t),
    exceptions: r.exceptions.map((e) => ({
      periodEndMonth: e.periodEndMonth,
      kind: e.kind,
      dueMonthOffset: e.dueMonthOffset,
      dueDayOfMonth: e.dueDayOfMonth,
      dueDaysAfter: e.dueDaysAfter,
      note: e.note,
    })),
    instanceCount: r.instanceCount,
  };
}

// ── Request schemas ─────────────────────────────────────────────────────────

const CreateRuleRequest = z
  .object({
    jurisdiction: z.string().length(2),
    entityType: z.string().nullable().optional(),
    serviceEntryId: z.string().uuid().nullable().optional(),
    module: z.string().nullable().optional(),
    name: z.string().min(1),
    authority: z.string().nullable().optional(),
    recurrence: Recurrence,
    fiscalYearStartMonth: z.number().int().min(1).max(12).default(4),
    dueRule: DueRuleSchema.nullable(),
    unresolvedReason: z.string().nullable().optional(),
    leadTimeDays: z.number().int().min(0).default(0),
    rulePack: z.string().min(1),
    supersedesId: z.string().uuid().nullable().optional(),
  })
  .openapi("CreateObligationRuleRequest");

const UpdateRuleRequest = z
  .object({
    entityType: z.string().nullable().optional(),
    serviceEntryId: z.string().uuid().nullable().optional(),
    module: z.string().nullable().optional(),
    authority: z.string().nullable().optional(),
    recurrence: Recurrence.optional(),
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
    dueRule: DueRuleSchema.nullable().optional(),
    unresolvedReason: z.string().nullable().optional(),
    leadTimeDays: z.number().int().min(0).optional(),
    status: RuleStatus.optional(),
    isActive: z.boolean().optional(),
  })
  .openapi("UpdateObligationRuleRequest");

const AddExceptionRequest = z
  .object({
    periodEndMonth: z.number().int().min(1).max(12),
    kind: DueRuleKind,
    dueMonthOffset: z.number().int().min(0).nullable().optional(),
    dueDayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
    dueDaysAfter: z.number().int().min(0).nullable().optional(),
    note: z.string().min(1),
  })
  .openapi("AddObligationExceptionRequest");

const RuleParam = z.object({ ruleId: z.string().uuid() });
const ExceptionParam = z.object({
  ruleId: z.string().uuid(),
  periodEndMonth: z.coerce.number().int().min(1).max(12),
});

const CalendarParams = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  entityPartyId: z.string().uuid().optional(),
  module: z.string().optional(),
  includeSettled: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

// ── Routes ──────────────────────────────────────────────────────────────────
//
// READS are `party:read`, the same permission the work board takes: what a
// client owes and when is delivery state, it carries no money, and everybody on
// the team needs to see it.
//
// WRITING A RULE is `tenant:admin`, and that is a deliberate step up from
// `work:write`. A due date is a RULE — a wrong one costs the CLIENT a penalty,
// not the firm an afternoon — and confirming one is a partner taking
// responsibility for it. This is the firm describing what the law asks of its
// clients, which is the same class of act as describing its own Depts.

const listRulesRoute = createRoute({
  method: "get",
  path: "/api/v1/obligation-rules",
  tags: ["obligations"],
  summary: "Every compliance rule at this firm, retired ones included",
  description:
    "Retired rules are returned on purpose: a retired rule still explains why an old filing " +
    "was due when it was. `coverage` says what each rule is actually doing — and a " +
    "'needs_formula' rule is a QUESTION for the firm, not a fault.",
  responses: {
    200: {
      description: "The rules",
      content: {
        "application/json": {
          schema: z.object({
            rules: z.array(RuleSchema),
            /** So the screen can offer to load the shipped pack rather than
             *  showing an empty table with no explanation. */
            ruleCount: z.number().int(),
          }),
        },
      },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read clients"),
  },
});

const seedRulesRoute = createRoute({
  method: "post",
  path: "/api/v1/obligation-rules/seed-india",
  tags: ["obligations"],
  summary: "Load the shipped India rule pack",
  description:
    "Fifty-seven rules from the firm's own applicability sheet. Ten produce dates; the rest " +
    "record what they are still waiting on. Idempotent on the rule's identity, so running it " +
    "twice adds nothing and never overwrites a rule a partner has confirmed or given a lead " +
    "time to. New firms get this automatically at creation.",
  responses: {
    200: {
      description: "How many rules were added",
      content: { "application/json": { schema: z.object({ created: z.number().int() }) } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
  },
});

const createRuleRoute = createRoute({
  method: "post",
  path: "/api/v1/obligation-rules",
  tags: ["obligations"],
  summary: "Write a compliance rule",
  request: {
    body: { content: { "application/json": { schema: CreateRuleRequest } }, required: true },
  },
  responses: {
    201: { description: "Written", content: { "application/json": { schema: RuleSchema } } },
    400: errorResponse(
      "A half-stated due formula, or a rule with neither a formula nor a reason for not having one",
    ),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("The named catalogue service does not exist at this firm"),
    409: errorResponse("This firm already has a rule with that jurisdiction, name and pack"),
  },
});

const updateRuleRoute = createRoute({
  method: "patch",
  path: "/api/v1/obligation-rules/{ruleId}",
  tags: ["obligations"],
  summary: "Edit, confirm or retire a rule",
  description:
    "Jurisdiction, name and rule pack are a rule's IDENTITY and cannot be changed here: every " +
    "obligation already generated pins this row, so moving the identity would silently restate " +
    "why those filings were due when they were. A revision is a new rule under a new pack.",
  request: {
    params: RuleParam,
    body: { content: { "application/json": { schema: UpdateRuleRequest } }, required: true },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: RuleSchema } } },
    400: errorResponse("A half-stated formula, or a formula and an unresolved reason together"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("No such rule at this firm"),
  },
});

const addExceptionRoute = createRoute({
  method: "post",
  path: "/api/v1/obligation-rules/{ruleId}/exceptions",
  tags: ["obligations"],
  summary: "The one period a rule does not apply to itself",
  description:
    "March's TDS deposit is due 30 April while the other eleven months are due on the 7th. A " +
    "template holds ONE formula, and reading only the normal half gives a rule that is right " +
    "eleven months a year and quietly wrong every April.",
  request: {
    params: RuleParam,
    body: { content: { "application/json": { schema: AddExceptionRequest } }, required: true },
  },
  responses: {
    201: { description: "Added", content: { "application/json": { schema: ExceptionSchema } } },
    400: errorResponse("A half-stated formula, a missing note, or an event-driven rule"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("No such rule at this firm"),
    409: errorResponse("This rule already has an exception for that period month"),
  },
});

const withdrawExceptionRoute = createRoute({
  method: "delete",
  path: "/api/v1/obligation-rules/{ruleId}/exceptions/{periodEndMonth}",
  tags: ["obligations"],
  summary: "Withdraw an exception, so the rule's own formula governs that period again",
  request: { params: ExceptionParam },
  responses: {
    204: { description: "Withdrawn" },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("No such rule, or no exception for that month"),
  },
});

const calendarRoute = createRoute({
  method: "get",
  path: "/api/v1/calendar",
  tags: ["obligations"],
  summary: "What the firm's clients owe, and by when",
  description:
    "Ordered by the INTERNAL target rather than the statutory date, because that is the " +
    "actionable one. Settled rows are excluded unless asked for: within a year they are almost " +
    "the whole table and never the answer.",
  request: { query: CalendarParams },
  responses: {
    200: {
      description: "The calendar",
      content: { "application/json": { schema: z.object({ rows: z.array(CalendarRowSchema) }) } },
    },
    400: errorResponse("A date that is not YYYY-MM-DD"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read clients"),
  },
});

const coverageRoute = createRoute({
  method: "get",
  path: "/api/v1/calendar/coverage",
  tags: ["obligations"],
  summary: "Live engagements the calendar has produced nothing for, and why",
  description:
    "THE ANSWER TO AN EMPTY CALENDAR. Every row names a reason, and none of them is an error " +
    "— most advisory work legitimately has no compliance rule. What this screen prevents is a " +
    "firm looking at an empty calendar and having to guess whether the software is broken.",
  responses: {
    200: {
      description: "The gaps",
      content: { "application/json": { schema: z.object({ gaps: z.array(CoverageGapSchema) }) } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read clients"),
  },
});

export function registerObligationRoutes(app: OpenAPIHono<AppEnv>, deps: ObligationDeps): void {
  app.openapi(listRulesRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const rules = await deps.service.listRules(s.tenantId);
    return c.json({ rules: rules.map(ruleToWire), ruleCount: rules.length }, 200);
  });

  app.openapi(seedRulesRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const created = await deps.service.seedIndiaRulePack(s.tenantId, s.actor);
    return c.json({ created }, 200);
  });

  app.openapi(createRuleRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const created = await deps.service.createRule({ tenantId: s.tenantId, ...body }, s.actor);
    const [record] = (await deps.service.listRules(s.tenantId)).filter(
      (r) => r.template.id === created.id,
    );
    return c.json(
      ruleToWire(
        record ?? { template: created, exceptions: [], serviceName: null, instanceCount: 0 },
      ),
      201,
    );
  });

  app.openapi(updateRuleRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { ruleId } = c.req.valid("param");
    const updated = await deps.service.updateRule(s.tenantId, ruleId, c.req.valid("json"), s.actor);
    const [record] = (await deps.service.listRules(s.tenantId)).filter(
      (r) => r.template.id === ruleId,
    );
    return c.json(
      ruleToWire(
        record ?? { template: updated, exceptions: [], serviceName: null, instanceCount: 0 },
      ),
      200,
    );
  });

  app.openapi(addExceptionRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { ruleId } = c.req.valid("param");
    const body = c.req.valid("json");
    const created = await deps.service.addException(
      s.tenantId,
      ruleId,
      {
        periodEndMonth: body.periodEndMonth,
        kind: body.kind,
        dueMonthOffset: body.dueMonthOffset ?? null,
        dueDayOfMonth: body.dueDayOfMonth ?? null,
        dueDaysAfter: body.dueDaysAfter ?? null,
        note: body.note,
      },
      s.actor,
    );
    return c.json(
      {
        periodEndMonth: created.periodEndMonth,
        kind: created.kind,
        dueMonthOffset: created.dueMonthOffset,
        dueDayOfMonth: created.dueDayOfMonth,
        dueDaysAfter: created.dueDaysAfter,
        note: created.note,
      },
      201,
    );
  });

  app.openapi(withdrawExceptionRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { ruleId, periodEndMonth } = c.req.valid("param");
    await deps.service.removeException(s.tenantId, ruleId, periodEndMonth, s.actor);
    return c.body(null, 204);
  });

  app.openapi(calendarRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const q = c.req.valid("query");
    const rows = await deps.service.calendar(s.tenantId, q);
    // Field by field. A spread would put whatever the read model grows next on
    // the wire without the schema documenting it — and an undocumented field is
    // one the generated frontend client cannot see.
    return c.json(
      {
        rows: rows.map((r) => ({
          id: r.id,
          name: r.name,
          authority: r.authority,
          module: r.module,
          entityPartyId: r.entityPartyId,
          entityName: r.entityName,
          clientName: r.clientName,
          periodLabel: r.periodLabel,
          statutoryDueOn: r.statutoryDueOn,
          internalTargetOn: r.internalTargetOn,
          stateCode: r.stateCode,
          stateName: r.stateName,
          isTerminal: r.isTerminal,
          needsDecision: r.needsDecision,
          workItemId: r.workItemId,
          filedOn: r.filedOn,
          ruleUnconfirmed: r.ruleUnconfirmed,
          rulePack: r.rulePack,
        })),
      },
      200,
    );
  });

  app.openapi(coverageRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const gaps = await deps.service.coverage(s.tenantId);
    return c.json(
      {
        gaps: gaps.map((g) => ({
          engagementId: g.engagementId,
          entityPartyId: g.entityPartyId,
          entityName: g.entityName,
          clientName: g.clientName,
          serviceName: g.serviceName,
          jurisdiction: g.jurisdiction,
          reason: g.reason,
          blockedRuleIds: [...g.blockedRuleIds],
        })),
      },
      200,
    );
  });
}

export const obligationRoutes = {
  listRules: listRulesRoute,
  seedRules: seedRulesRoute,
  createRule: createRuleRoute,
  updateRule: updateRuleRoute,
  addException: addExceptionRoute,
  withdrawException: withdrawExceptionRoute,
  calendar: calendarRoute,
  coverage: coverageRoute,
} as const;
