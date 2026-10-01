// Billing dues, as a surface (auto-invoice, phase 1, 0318) — transport only.
// Each route declares its wire shape; its handler parses, calls one use-case
// method, and maps the result FIELD BY FIELD.
//
// THE TENANT COMES FROM THE SESSION. AMOUNTS ARE DECIMAL STRINGS, and are
// REDACTED (null) for a caller without the fee axis, the invoice screen's rule:
// a delivery colleague may see that a client owes a bill for October, not
// what it is worth. A tax RATE is not an amount and is never redacted.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { scopeOf } from "../scope";
import type { BillingDeskService, DueOnDesk, UnscheduledRecord } from "../../usecase/billing/desk";
import type { PersonRef, ScheduleRecord } from "../../usecase/billing/ports";
import type { AuthzService } from "../../usecase/authz/service";
import type { Principal } from "../../platform/callctx";

export interface BillingDeps {
  readonly service: BillingDeskService;
  /** For the FEE AXIS only; gate 3 is middleware. */
  readonly authz: AuthzService;
}

const Decimal = z.string().regex(/^\d+(\.\d+)?$/);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const STATUSES = ["open", "drafted", "billed", "skipped"] as const;

const PersonSchema = z
  .object({ userId: z.string().uuid(), displayName: z.string().nullable(), email: z.string() })
  .openapi("BillingPerson");

const DueSchema = z
  .object({
    id: z.string().uuid(),
    party: z.object({ id: z.string().uuid(), displayName: z.string() }),
    issuer: z.object({ id: z.string().uuid(), displayName: z.string() }),
    currency: z.string(),
    engagementId: z.string().uuid().nullable(),
    feeGroupId: z.string().uuid().nullable(),
    engagementIds: z.array(z.string().uuid()),
    serviceName: z.string().openapi({
      description:
        "What the client signed for: the letter line's own wording, or the fee group's title. " +
        "Never the catalogue's name. The invoice line reads it, with the period.",
    }),
    entityName: z.string().nullable(),
    letter: z.object({ id: z.string().uuid(), ref: z.string(), fxRate: z.string(), fxRateDate: z.string() }),
    periodStart: z.string(),
    periodEnd: z.string(),
    periodLabel: z.string(),
    billOn: z.string().openapi({ description: "The day this period's bill fell due." }),
    fullAmount: Decimal.nullable().openapi({
      description:
        "The letter's fee for one whole period. NULL when the letter fixed no price (it must be " +
        "typed when raising), or when the caller does not see fees.",
    }),
    amount: Decimal.nullable().openapi({
      description: "What is billed: the full amount pro-rated by days served. NULL as above.",
    }),
    servedDays: z.number().int(),
    periodDays: z.number().int(),
    manager: PersonSchema.nullable(),
    managerHow: z.string().openapi({
      description: "`spoc_manager` (whom the SPOC reports to), `key_manager` (fallback) or `none`.",
    }),
    managerNote: z.string().nullable().openapi({ description: "Why it is not with the SPOC's manager." }),
    managerReportsTo: PersonSchema.nullable(),
    status: z.enum(STATUSES).openapi({
      description:
        "Derived on read: `open` (to raise), `drafted` (on a draft invoice), `billed` (issued), " +
        "`skipped`. A cancelled invoice makes its dues open again.",
    }),
    invoice: z.object({ id: z.string().uuid(), number: z.string(), status: z.string() }).nullable(),
    skipped: z.object({ at: z.string(), by: PersonSchema.nullable(), reason: z.string() }).nullable(),
    lastTaxPercent: z.string().nullable().openapi({
      description: "The tax rate the last invoice line for this work carried: a default to offer.",
    }),
    daysSinceBillOn: z.number().int(),
    escalated: z.boolean().openapi({
      description: "Still to be issued a week after its bill date: it shows to the manager's own manager too.",
    }),
  })
  .openapi("BillingDue");

const ScheduleSchema = z
  .object({
    engagementId: z.string().uuid(),
    party: z.object({ id: z.string().uuid(), displayName: z.string() }),
    entityName: z.string(),
    serviceName: z.string().openapi({ description: "The letter line's own wording, as the client signed it." }),
    letterRef: z.string(),
    status: z.string(),
    effectiveFrom: z.string(),
    endsOn: z.string().nullable(),
    billingFrequency: z.string().nullable(),
    feeGroup: z.object({ id: z.string().uuid(), title: z.string() }).nullable(),
    billingFrom: z.string().nullable(),
    firstInvoiceOn: z.string().nullable(),
  })
  .openapi("BillingSchedule");

const UnscheduledSchema = ScheduleSchema.extend({
  suggestion: z
    .object({ billingFrom: z.string(), firstInvoiceOn: z.string(), periodLabel: z.string() })
    .nullable()
    .openapi({ description: "The current period, billed the day after it ends (the firm's default)." }),
}).openapi("BillingUnscheduled");

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/billing/dues",
  tags: ["billing"],
  summary: "Bills that have fallen due, and what became of them",
  request: {
    query: z.object({
      status: z.enum(STATUSES).optional(),
      partyId: z.string().uuid().optional(),
      mine: z.enum(["true", "false"]).optional().openapi({
        description:
          "Only what the caller should act on: their own open or drafted dues, and their reports' " +
          "once a week has passed.",
      }),
    }),
  },
  responses: {
    200: {
      description: "The dues",
      content: { "application/json": { schema: z.object({ today: z.string(), dues: z.array(DueSchema) }) } },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const unscheduledRoute = createRoute({
  method: "get",
  path: "/api/v1/billing/unscheduled",
  tags: ["billing"],
  summary: "Recurring engagements whose billing is not set up",
  responses: {
    200: {
      description: "Engagements with no schedule",
      content: { "application/json": { schema: z.object({ engagements: z.array(UnscheduledSchema) }) } },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const scheduleRoute = createRoute({
  method: "put",
  path: "/api/v1/engagements/{engagementId}/billing",
  tags: ["billing"],
  summary: "Set an engagement's billing schedule",
  description:
    "The first period billed (snapped to its first day) and the date its invoice falls due; " +
    "each later period one billing span after. Both null clears it. A fee group's engagements " +
    "are set together, because a group is billed once.",
  request: {
    params: z.object({ engagementId: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ billingFrom: Day.nullable(), firstInvoiceOn: Day.nullable() }).openapi("SetBillingSchedule"),
        },
      },
      required: true,
    },
  },
  responses: {
    200: { description: "Set", content: { "application/json": { schema: ScheduleSchema } } },
    400: errorResponse("Not a real date, or only one of the two given"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such engagement at this firm"),
    409: errorResponse("Billed once or on a custom schedule, or the firm's financial year is not set"),
  },
});

const raiseRoute = createRoute({
  method: "post",
  path: "/api/v1/billing/raise",
  tags: ["billing"],
  summary: "Raise a draft invoice from bill dues",
  description:
    "One client, one of the firm's companies, one currency and one manager. Every invoice rule " +
    "applies as for a hand-raised one, and the number is drawn from the gapless series. The " +
    "rate defaults to the one the letters were struck at, when they agree.",
  request: {
    query: z.object({ asOf: Day.optional() }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              dueIds: z.array(z.string().uuid()).min(1).max(50),
              lines: z.array(
                z.object({ dueId: z.string().uuid(), amount: Decimal.optional(), taxPercent: Decimal }),
              ),
              fxRate: Decimal.optional(),
              fxRateDate: Day.optional(),
              dueOn: Day.optional(),
            })
            .openapi("RaiseFromDues"),
        },
      },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Drafted",
      content: {
        "application/json": {
          schema: z
            .object({
              invoiceId: z.string().uuid(),
              number: z.string(),
              conflicts: z.array(z.string().uuid()).openapi({
                description: "Dues somebody else settled while this ran: on the invoice, but not linked to it.",
              }),
            })
            .openapi("RaisedFromDues"),
        },
      },
    },
    400: errorResponse("Mixed clients, companies, currencies or managers; an amount or a tax rate missing"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such due at this firm"),
    409: errorResponse("A due is already on an invoice or skipped"),
  },
});

const skipRoute = createRoute({
  method: "post",
  path: "/api/v1/billing/dues/{dueId}/skip",
  tags: ["billing"],
  summary: "Decide a bill will not be raised, and say why",
  request: {
    params: z.object({ dueId: z.string().uuid() }),
    body: {
      content: { "application/json": { schema: z.object({ reason: z.string().max(500) }).openapi("SkipDue") } },
      required: true,
    },
  },
  responses: {
    204: { description: "Skipped" },
    400: errorResponse("No reason"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such due at this firm"),
    409: errorResponse("Already on an invoice or skipped"),
  },
});

const linkRoute = createRoute({
  method: "post",
  path: "/api/v1/billing/dues/{dueId}/link",
  tags: ["billing"],
  summary: "Say which invoice, raised by hand, already bills this",
  request: {
    params: z.object({ dueId: z.string().uuid() }),
    body: {
      content: {
        "application/json": { schema: z.object({ invoiceId: z.string().uuid() }).openapi("LinkDue") },
      },
      required: true,
    },
  },
  responses: {
    204: { description: "Linked" },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such due or invoice at this firm"),
    409: errorResponse("Already settled, or the invoice cannot be this bill"),
  },
});

const SettingsSchema = z
  .object({
    autoBilling: z.boolean().openapi({
      description: "Whether the daily sweep writes bill dues for this firm. Off until the firm turns it on.",
    }),
  })
  .openapi("BillingSettings");

const getSettingsRoute = createRoute({
  method: "get",
  path: "/api/v1/billing/settings",
  tags: ["billing"],
  summary: "The firm's billing switch",
  responses: {
    200: { description: "Settings", content: { "application/json": { schema: SettingsSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const putSettingsRoute = createRoute({
  method: "put",
  path: "/api/v1/billing/settings",
  tags: ["billing"],
  summary: "Turn automatic billing on or off",
  request: {
    body: { content: { "application/json": { schema: SettingsSchema } }, required: true },
  },
  responses: {
    200: { description: "Set", content: { "application/json": { schema: SettingsSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

function personBody(p: PersonRef | null): { userId: string; displayName: string | null; email: string } | null {
  return p === null ? null : { userId: p.userId, displayName: p.displayName, email: p.email };
}

function dueBody(d: DueOnDesk, fees: boolean) {
  return {
    id: d.id,
    party: { id: d.party.id, displayName: d.party.displayName },
    issuer: { id: d.issuer.id, displayName: d.issuer.displayName },
    currency: d.currency,
    engagementId: d.engagementId,
    feeGroupId: d.feeGroupId,
    engagementIds: [...d.engagementIds],
    serviceName: d.serviceName,
    entityName: d.entityName,
    letter: { id: d.letter.id, ref: d.letter.ref, fxRate: d.letter.fxRate, fxRateDate: d.letter.fxRateDate },
    periodStart: d.periodStart,
    periodEnd: d.periodEnd,
    periodLabel: d.periodLabel,
    billOn: d.billOn,
    fullAmount: fees ? d.fullAmount : null,
    amount: fees ? d.amount : null,
    servedDays: d.servedDays,
    periodDays: d.periodDays,
    manager: personBody(d.manager),
    managerHow: d.managerHow,
    managerNote: d.managerNote,
    managerReportsTo: personBody(d.managerReportsTo),
    status: d.status,
    invoice: d.invoice === null ? null : { id: d.invoice.id, number: d.invoice.number, status: d.invoice.status },
    skipped:
      d.skipped === null ? null : { at: d.skipped.at, by: personBody(d.skipped.by), reason: d.skipped.reason },
    lastTaxPercent: d.lastTaxPercent,
    daysSinceBillOn: d.daysSinceBillOn,
    escalated: d.escalated,
  };
}

function scheduleBody(s: ScheduleRecord) {
  return {
    engagementId: s.engagementId,
    party: { id: s.party.id, displayName: s.party.displayName },
    entityName: s.entityName,
    serviceName: s.serviceName,
    letterRef: s.letterRef,
    status: s.status,
    effectiveFrom: s.effectiveFrom,
    endsOn: s.endsOn,
    billingFrequency: s.billingFrequency,
    feeGroup: s.feeGroup === null ? null : { id: s.feeGroup.id, title: s.feeGroup.title },
    billingFrom: s.billingFrom,
    firstInvoiceOn: s.firstInvoiceOn,
  };
}

function unscheduledBody(u: UnscheduledRecord) {
  return {
    ...scheduleBody(u),
    suggestion:
      u.suggestion === null
        ? null
        : {
            billingFrom: u.suggestion.billingFrom,
            firstInvoiceOn: u.suggestion.firstInvoiceOn,
            periodLabel: u.suggestion.periodLabel,
          },
  };
}

export function registerBillingRoutes(app: OpenAPIHono<AppEnv>, deps: BillingDeps): void {
  const seesFees = (principal: Principal | null): boolean => principal !== null && deps.authz.seesFees(principal);

  app.openapi(listRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const q = c.req.valid("query");
    const out = await deps.service.list({
      tenantId: s.tenantId,
      filters: { status: q.status, partyId: q.partyId },
      mineFor: q.mine === "true" ? s.userId : undefined,
    });
    const fees = seesFees(c.get("principal"));
    return c.json({ today: out.today, dues: out.dues.map((d) => dueBody(d, fees)) }, 200);
  });

  app.openapi(unscheduledRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const rows = await deps.service.unscheduled(s.tenantId);
    return c.json({ engagements: rows.map(unscheduledBody) }, 200);
  });

  app.openapi(scheduleRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const set = await deps.service.setSchedule(
      {
        tenantId: s.tenantId,
        engagementId: c.req.valid("param").engagementId,
        billingFrom: body.billingFrom,
        firstInvoiceOn: body.firstInvoiceOn,
      },
      s.actor,
    );
    return c.json(scheduleBody(set), 200);
  });

  app.openapi(raiseRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    const out = await deps.service.raise(
      {
        tenantId: s.tenantId,
        dueIds: body.dueIds,
        lines: body.lines.map((l) => ({ dueId: l.dueId, amount: l.amount, taxPercent: l.taxPercent })),
        fxRate: body.fxRate,
        fxRateDate: body.fxRateDate,
        dueOn: body.dueOn,
        asOf: c.req.valid("query").asOf,
      },
      s.actor,
    );
    return c.json({ invoiceId: out.invoiceId, number: out.number, conflicts: [...out.conflicts] }, 201);
  });

  app.openapi(skipRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    await deps.service.skip(
      { tenantId: s.tenantId, dueId: c.req.valid("param").dueId, reason: c.req.valid("json").reason },
      s.actor,
    );
    return c.body(null, 204);
  });

  app.openapi(linkRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    await deps.service.link(
      { tenantId: s.tenantId, dueId: c.req.valid("param").dueId, invoiceId: c.req.valid("json").invoiceId },
      s.actor,
    );
    return c.body(null, 204);
  });

  app.openapi(getSettingsRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    return c.json({ autoBilling: await deps.service.autoBilling(s.tenantId) }, 200);
  });

  app.openapi(putSettingsRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const on = await deps.service.setAutoBilling(s.tenantId, c.req.valid("json").autoBilling, s.actor);
    return c.json({ autoBilling: on }, 200);
  });
}
