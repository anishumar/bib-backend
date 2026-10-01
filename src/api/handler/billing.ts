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
import type { AdvanceGate, AdvanceOnDesk } from "../../usecase/billing/advance";
import type { BillNowCandidate, FinalBiller } from "../../usecase/billing/final";
import type { PersonRef, RefundCandidate, ScheduleRecord } from "../../usecase/billing/ports";
import type { AuthzService } from "../../usecase/authz/service";
import type { Principal } from "../../platform/callctx";

export interface BillingDeps {
  readonly service: BillingDeskService;
  /** The advance's gate: where each stands, and an admin's Approve start (0320). */
  readonly gate: AdvanceGate;
  /** One-time services' final bills: Bill it now (0320). */
  readonly finals: FinalBiller;
  /** For the FEE AXIS only; gate 3 is middleware. */
  readonly authz: AuthzService;
}

const Decimal = z.string().regex(/^\d+(\.\d+)?$/);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const STATUSES = ["open", "drafted", "billed", "skipped", "covered"] as const;
const KINDS = ["period", "advance", "final"] as const;

const PersonSchema = z
  .object({ userId: z.string().uuid(), displayName: z.string().nullable(), email: z.string() })
  .openapi("BillingPerson");

const ReleasedSchema = z
  .object({ at: z.string(), how: z.enum(["paid", "approved"]), by: PersonSchema.nullable() })
  .openapi("AdvanceReleased");

const DueSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(KINDS).openapi({
      description:
        "`period` (one period of recurring work), `advance` (the letter's advance, or one service's: " +
        "raised on an invoice of its own, and the work waits until it is paid) or `final` (a one-time " +
        "service whose work is done, billed for the balance after the advance) (0320).",
    }),
    engagementLetterId: z.string().uuid().nullable().openapi({
      description: "The letter a LETTER-WIDE advance is for; null otherwise.",
    }),
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
    priced: z.boolean().openapi({
      description:
        "Whether the letter fixed a price. False: the amount is typed when raising, and the bill is " +
        "on the client's SPOC's and every administrator's desk as well as the manager's until then. " +
        "Not an amount, so never redacted.",
    }),
    manager: PersonSchema.nullable(),
    managerHow: z.string().openapi({
      description: "`spoc_manager` (whom the SPOC reports to), `key_manager` (fallback) or `none`.",
    }),
    managerNote: z.string().nullable().openapi({ description: "Why it is not with the SPOC's manager." }),
    managerReportsTo: PersonSchema.nullable(),
    status: z.enum(STATUSES).openapi({
      description:
        "Derived on read: `open` (to raise), `drafted` (on a draft invoice), `billed` (issued), " +
        "`skipped`, or `covered` (the advance paid it in full, so no invoice was raised). A " +
        "cancelled invoice makes its dues open again.",
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
    advancePool: z
      .object({ invoiceId: z.string().uuid(), invoiceNumber: z.string(), remaining: Decimal.nullable() })
      .nullable()
      .openapi({
        description:
          "The advance this bill will be taken off when raised (the service's own, else the letter's) " +
          "and what is left of it, before tax. `remaining` is null without the fee axis.",
      }),
    advanceApplied: z
      .object({ invoiceId: z.string().uuid(), invoiceNumber: z.string(), amount: Decimal.nullable() })
      .nullable()
      .openapi({ description: "What this bill was reduced by, once raised or covered." }),
    released: ReleasedSchema.nullable().openapi({
      description: "An advance bill: when the work it held started, and how.",
    }),
  })
  .openapi("BillingDue");

const AdvanceSchema = z
  .object({
    id: z.string().uuid(),
    party: z.object({ id: z.string().uuid(), displayName: z.string() }),
    issuer: z.object({ id: z.string().uuid(), displayName: z.string() }),
    currency: z.string(),
    engagementLetterId: z.string().uuid().nullable(),
    engagementId: z.string().uuid().nullable(),
    serviceName: z.string().openapi({ description: "`All services` for the letter's own advance." }),
    letter: z.object({ id: z.string().uuid(), ref: z.string() }),
    billOn: z.string(),
    amount: Decimal.nullable(),
    manager: PersonSchema.nullable(),
    invoice: z.object({ id: z.string().uuid(), number: z.string(), status: z.string() }).nullable(),
    balance: z
      .object({ invoiced: z.string().nullable(), paid: z.string().nullable(), outstanding: z.string().nullable() })
      .nullable()
      .openapi({ description: "The advance invoice's money, as the invoice reads it. Amounts null without fees." }),
    state: z.enum(["not_raised", "on_draft", "unpaid", "part_paid", "paid", "started"]).openapi({
      description:
        "Where the advance stands. `part_paid` waits for an admin's Approve start; `paid` starts by " +
        "itself (an admin may push one that did not); `started` released the work.",
    }),
    released: ReleasedSchema.nullable(),
  })
  .openapi("BillingAdvance");

const RefundSchema = z
  .object({
    dueId: z.string().uuid(),
    party: z.object({ id: z.string().uuid(), displayName: z.string() }),
    issuer: z.object({ id: z.string().uuid(), displayName: z.string() }),
    currency: z.string(),
    letter: z.object({ id: z.string().uuid(), ref: z.string() }),
    serviceName: z.string(),
    invoice: z.object({ id: z.string().uuid(), number: z.string() }),
    advanceNet: Decimal.nullable(),
    applied: Decimal.nullable(),
    remaining: Decimal.nullable().openapi({ description: "Left of the advance, before tax." }),
    refundAmount: Decimal.nullable().openapi({
      description: "The credit note that gives it back, with its share of the tax. Null without fees.",
    }),
  })
  .openapi("BillingRefund");

const BillNowSchema = z
  .object({
    engagementId: z.string().uuid(),
    feeGroupId: z.string().uuid().nullable(),
    party: z.object({ id: z.string().uuid(), displayName: z.string() }),
    serviceName: z.string(),
    letterRef: z.string(),
    currency: z.string(),
    fullAmount: Decimal.nullable(),
  })
  .openapi("BillingBillNow");

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
          "Only what the caller should act on: their own open or drafted dues, their reports' once " +
          "a week has passed, and any open bill with no price where they are the client's SPOC for " +
          "that Dept or a firm administrator.",
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
              invoiceId: z.string().uuid().nullable().openapi({
                description: "Null when the advance paid every bill in full: no invoice, so no number drawn.",
              }),
              number: z.string().nullable(),
              covered: z.array(z.string().uuid()).openapi({
                description: "Bills the advance paid in full: no line, and status `covered`.",
              }),
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

const advancesRoute = createRoute({
  method: "get",
  path: "/api/v1/billing/advances",
  tags: ["billing"],
  summary: "Every advance bill, and where it stands",
  responses: {
    200: {
      description: "The advances",
      content: { "application/json": { schema: z.object({ advances: z.array(AdvanceSchema) }) } },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const approveStartRoute = createRoute({
  method: "post",
  path: "/api/v1/billing/advances/{dueId}/approve-start",
  tags: ["billing"],
  summary: "Start the work on a part-paid advance",
  description:
    "An admin's decision (Ashish, 2026-10-01): the work an advance holds starts by itself when its " +
    "invoice is paid in full, and on a part payment only when an admin approves it here.",
  request: { params: z.object({ dueId: z.string().uuid() }) },
  responses: {
    200: { description: "Started", content: { "application/json": { schema: AdvanceSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or not a firm administrator"),
    404: errorResponse("No such advance bill at this firm"),
    409: errorResponse("Not raised, not issued, nothing paid, or already started"),
  },
});

const refundsRoute = createRoute({
  method: "get",
  path: "/api/v1/billing/refunds",
  tags: ["billing"],
  summary: "Advances with some left once the work they covered is finished",
  responses: {
    200: {
      description: "To refund",
      content: { "application/json": { schema: z.object({ refunds: z.array(RefundSchema) }) } },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const refundRoute = createRoute({
  method: "post",
  path: "/api/v1/billing/refunds/{dueId}/credit-note",
  tags: ["billing"],
  summary: "Give an unused advance back as a credit note",
  description:
    "A credit note on the advance invoice for what is left, with its share of the tax, reason " +
    "`advance_refund`. The money itself goes back as a negative payment, as any refund does.",
  request: { params: z.object({ dueId: z.string().uuid() }), query: z.object({ asOf: Day.optional() }) },
  responses: {
    201: {
      description: "Credited",
      content: {
        "application/json": {
          schema: z.object({ creditNoteId: z.string(), number: z.string() }).openapi("AdvanceRefunded"),
        },
      },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or not a firm administrator"),
    404: errorResponse("No such advance at this firm"),
    409: errorResponse("Nothing left, the work goes on, or the firm kept it"),
  },
});

const keepRoute = createRoute({
  method: "post",
  path: "/api/v1/billing/refunds/{dueId}/keep",
  tags: ["billing"],
  summary: "Keep an unused advance, and say why",
  request: {
    params: z.object({ dueId: z.string().uuid() }),
    body: {
      content: { "application/json": { schema: z.object({ reason: z.string().max(500) }).openapi("KeepAdvance") } },
      required: true,
    },
  },
  responses: {
    204: { description: "Kept" },
    400: errorResponse("No reason"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or not a firm administrator"),
    404: errorResponse("No such advance at this firm"),
    409: errorResponse("Nothing left, the work goes on, or already kept"),
  },
});

const billNowListRoute = createRoute({
  method: "get",
  path: "/api/v1/billing/bill-now",
  tags: ["billing"],
  summary: "One-time services with no process, to bill by hand",
  request: { query: z.object({ partyId: z.string().uuid().optional() }) },
  responses: {
    200: {
      description: "Billable now",
      content: { "application/json": { schema: z.object({ engagements: z.array(BillNowSchema) }) } },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const billNowRoute = createRoute({
  method: "post",
  path: "/api/v1/billing/engagements/{engagementId}/bill-now",
  tags: ["billing"],
  summary: "Bill a one-time service with no process now",
  description:
    "Writes its final bill, dated today, onto To raise. Only where the firm wrote no process for " +
    "the service: with one, the bill comes when the job's last step is done.",
  request: { params: z.object({ engagementId: z.string().uuid() }) },
  responses: {
    201: {
      description: "On To raise",
      content: { "application/json": { schema: z.object({ dueId: z.string().uuid() }).openapi("BilledNow") } },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such one-time engagement at this firm"),
    409: errorResponse("It has a process, is waiting for its advance, is billed already, or billing is off"),
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
    priced: d.priced,
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
    kind: d.kind,
    engagementLetterId: d.engagementLetterId,
    advancePool:
      d.advancePool === null
        ? null
        : {
            invoiceId: d.advancePool.invoiceId,
            invoiceNumber: d.advancePool.invoiceNumber,
            remaining: fees ? d.advancePool.remaining : null,
          },
    advanceApplied:
      d.advanceApplied === null
        ? null
        : {
            invoiceId: d.advanceApplied.invoiceId,
            invoiceNumber: d.advanceApplied.invoiceNumber,
            amount: fees ? d.advanceApplied.amount : null,
          },
    released: releasedBody(d.released),
  };
}

function releasedBody(r: DueOnDesk["released"]) {
  return r === null ? null : { at: r.at, how: r.how, by: personBody(r.by) };
}

function advanceBody(a: AdvanceOnDesk, fees: boolean) {
  return {
    id: a.id,
    party: { id: a.party.id, displayName: a.party.displayName },
    issuer: { id: a.issuer.id, displayName: a.issuer.displayName },
    currency: a.currency,
    engagementLetterId: a.engagementLetterId,
    engagementId: a.engagementId,
    serviceName: a.serviceName,
    letter: { id: a.letter.id, ref: a.letter.ref },
    billOn: a.billOn,
    amount: fees ? a.amount : null,
    manager: personBody(a.manager),
    invoice: a.invoice === null ? null : { id: a.invoice.id, number: a.invoice.number, status: a.invoice.status },
    balance:
      a.balance === null
        ? null
        : {
            invoiced: fees ? a.balance.invoiced : null,
            paid: fees ? a.balance.paid : null,
            outstanding: fees ? a.balance.outstanding : null,
          },
    state: a.state,
    released: releasedBody(a.released),
  };
}

function refundBody(r: RefundCandidate, fees: boolean) {
  return {
    dueId: r.advance.id,
    party: { id: r.advance.party.id, displayName: r.advance.party.displayName },
    issuer: { id: r.advance.issuer.id, displayName: r.advance.issuer.displayName },
    currency: r.advance.currency,
    letter: { id: r.advance.letter.id, ref: r.advance.letter.ref },
    serviceName: r.advance.serviceName,
    invoice: { id: r.invoice.id, number: r.invoice.number },
    advanceNet: fees ? r.advanceNet : null,
    applied: fees ? r.applied : null,
    remaining: fees ? r.remaining : null,
    refundAmount: fees ? r.refundAmount : null,
  };
}

function billNowBody(b: BillNowCandidate, fees: boolean) {
  return {
    engagementId: b.engagementId,
    feeGroupId: b.feeGroupId,
    party: { id: b.partyId, displayName: b.clientName },
    serviceName: b.serviceName,
    letterRef: b.letterRef,
    currency: b.currency,
    fullAmount: fees ? b.fullAmount : null,
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
    const mine = q.mine === "true";
    const principal = c.get("principal");
    const out = await deps.service.list({
      tenantId: s.tenantId,
      filters: { status: q.status, partyId: q.partyId },
      mineFor: mine ? s.userId : undefined,
      mineIsAdmin: mine && principal !== null && (await deps.authz.can(principal, "tenant:admin")),
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
    return c.json(
      { invoiceId: out.invoiceId, number: out.number, covered: [...out.covered], conflicts: [...out.conflicts] },
      201,
    );
  });

  app.openapi(advancesRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const fees = seesFees(c.get("principal"));
    return c.json({ advances: (await deps.gate.list(s.tenantId)).map((a) => advanceBody(a, fees)) }, 200);
  });

  app.openapi(approveStartRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const after = await deps.gate.approveStart({ tenantId: s.tenantId, dueId: c.req.valid("param").dueId }, s.actor);
    return c.json(advanceBody(after, seesFees(c.get("principal"))), 200);
  });

  app.openapi(refundsRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const fees = seesFees(c.get("principal"));
    return c.json({ refunds: (await deps.service.refunds(s.tenantId)).map((r) => refundBody(r, fees)) }, 200);
  });

  app.openapi(refundRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const note = await deps.service.refund(
      { tenantId: s.tenantId, dueId: c.req.valid("param").dueId, asOf: c.req.valid("query").asOf },
      s.actor,
    );
    return c.json({ creditNoteId: note.id, number: note.number }, 201);
  });

  app.openapi(keepRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    await deps.service.keepAdvance(
      { tenantId: s.tenantId, dueId: c.req.valid("param").dueId, reason: c.req.valid("json").reason },
      s.actor,
    );
    return c.body(null, 204);
  });

  app.openapi(billNowListRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const fees = seesFees(c.get("principal"));
    const rows = await deps.finals.candidates(s.tenantId, c.req.valid("query").partyId);
    return c.json({ engagements: rows.map((b) => billNowBody(b, fees)) }, 200);
  });

  app.openapi(billNowRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const out = await deps.finals.billNow(
      { tenantId: s.tenantId, engagementId: c.req.valid("param").engagementId },
      s.actor,
    );
    return c.json({ dueId: out.dueId }, 201);
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
