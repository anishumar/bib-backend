// Work vs Billing (Q041, 2026-10-04), as a surface: transport only. The handler
// parses, calls one use-case method and maps the result FIELD BY FIELD.
//
// THE API SHIPS CODES, THE SCREEN SHIPS WORDS (the readiness rule): a flag is a
// code with the facts its sentence needs. AMOUNTS ARE DECIMAL STRINGS and are
// REDACTED (null) for a login without the fee axis; whether something is paid,
// part paid or overdue is not an amount and is never redacted (the weekly
// advance summary's rule).
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { scopeOf } from "../scope";
import type { AuthzService } from "../../usecase/authz/service";
import type { Flag, WorkBillingRow, WorkBillingService } from "../../usecase/billing/work-vs-billing";
import type { WbFiling, WbPerson } from "../../usecase/billing/ports";
import { isCalendarDay } from "../../domain/day";

export interface WorkBillingDeps {
  readonly service: WorkBillingService;
  /** For the FEE AXIS only; gate 3 is middleware. */
  readonly authz: AuthzService;
}

const Decimal = z.string().regex(/^-?\d+(\.\d+)?$/);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A day a caller sends: a real calendar day (B43). */
const AskedDay = z.string().refine(isCalendarDay, { message: "must be a calendar day, YYYY-MM-DD" });
/** The widest window one request may ask for: three years of periods. */
const MAX_WINDOW_DAYS = 3 * 366;

const FLAG_CODES = ["no_bill", "no_final_bill", "skipped", "not_raised", "not_issued", "unpaid_overdue"] as const;
const FLAG_CAUSES = [
  "no_schedule",
  "auto_billing_off",
  "no_fiscal_year",
  "not_written",
  "before_auto_billing",
  "no_price",
] as const;
const NOTE_CODES = [
  "raised_before_work_done",
  "bill_due_on",
  "billing_run_next",
  "before_billing_start",
  "billed_by_hand",
  "not_served",
  "covered_by_advance",
  "work_in_progress",
] as const;
const BILL_STATUSES = ["open", "drafted", "billed", "skipped", "covered"] as const;
const WORK_STATES = ["none", "not_started", "in_progress", "done", "cancelled"] as const;
const PAYMENT_STATES = ["paid", "part_paid", "unpaid"] as const;
const BUCKETS = {
  d0_30: z.number().int(),
  d31_60: z.number().int(),
  d61_90: z.number().int(),
  d90_plus: z.number().int(),
};

const PersonSchema = z
  .object({ userId: z.string().uuid(), displayName: z.string().nullable() })
  .openapi("WorkBillingPerson");

const FlagSchema = z
  .object({
    code: z.enum(FLAG_CODES).openapi({
      description:
        "`no_bill` (a recurring period is over and its work done, and no bill was written), " +
        "`no_final_bill` (one-time work done, no final bill), `skipped` (the bill was skipped), " +
        "`not_raised` (the bill's date has passed and no invoice was raised), `not_issued` (its " +
        "invoice has been a draft more than 7 days past the bill date), `unpaid_overdue` (issued, " +
        "money still owed after the due date).",
    }),
    cause: z
      .enum(FLAG_CAUSES)
      .nullable()
      .openapi({
        description:
          "Why there is no bill: `no_schedule` (billing not set up for the service), `auto_billing_off` " +
          "(the firm's switch), `no_fiscal_year` (a quarter or year cannot be cut), `not_written` (set up " +
          "and due, yet nothing was written), `before_auto_billing` (one-time work finished before " +
          "automatic billing was switched on). On `not_raised`: `no_price` when the letter fixed none.",
      }),
    days: z.number().int().openapi({
      description: "How old the problem is, in days, counted from `since`.",
    }),
    since: Day,
    reason: z.string().nullable().openapi({ description: "A skip's reason." }),
    by: PersonSchema.nullable().openapi({ description: "Who skipped it." }),
    at: z.string().nullable().openapi({ description: "When it was skipped (an instant)." }),
  })
  .openapi("WorkBillingFlag");

const FilingSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    periodLabel: z.string(),
    dueOn: Day,
    filedOn: Day.nullable(),
    stateName: z.string(),
    filed: z.boolean(),
    closed: z.boolean(),
    jobStatus: z.string().nullable(),
  })
  .openapi("WorkBillingFiling");

const RowSchema = z
  .object({
    key: z.string(),
    kind: z.enum(["period", "one_time", "advance"]),
    party: z.object({ id: z.string().uuid(), displayName: z.string() }),
    serviceName: z.string().openapi({
      description: "The letter line's wording, or the fee group's title.",
    }),
    entityName: z.string().nullable(),
    letter: z.object({ id: z.string(), ref: z.string() }),
    engagementIds: z.array(z.string().uuid()),
    feeGroupId: z.string().uuid().nullable(),
    frequency: z.string().nullable(),
    period: z.object({ start: Day, end: Day, label: z.string() }).nullable(),
    work: z.enum(WORK_STATES).openapi({
      description: "The row's jobs taken together; cancelled jobs count only when every job was cancelled.",
    }),
    workDoneOn: Day.nullable(),
    jobs: z.array(
      z.object({
        id: z.string().uuid(),
        status: z.string(),
        periodLabel: z.string().nullable(),
        doneOn: Day.nullable(),
      }),
    ),
    filings: z.array(FilingSchema).openapi({
      description: "Statutory filings of this service and period. Their service's bill covers them.",
    }),
    bill: z
      .object({
        id: z.string().uuid(),
        kind: z.string(),
        status: z.enum(BILL_STATUSES),
        billOn: Day,
        currency: z.string(),
        amount: Decimal.nullable(),
        priced: z.boolean(),
      })
      .nullable(),
    expectedBillOn: Day.nullable().openapi({
      description: "No bill yet: the day the billing run will write it, by the sweep's own schedule.",
    }),
    invoice: z
      .object({
        id: z.string().uuid(),
        number: z.string().nullable(),
        status: z.string(),
        issuedOn: Day.nullable(),
        dueOn: Day.nullable(),
        invoiced: Decimal.nullable(),
        paid: Decimal.nullable(),
        outstanding: Decimal.nullable(),
      })
      .nullable(),
    payment: z
      .object({
        state: z.enum(PAYMENT_STATES),
        dueOn: Day.nullable().openapi({
          description: "The invoice's due date, else its date (due on receipt).",
        }),
        daysOverdue: z.number().int().nullable().openapi({
          description: "Positive: overdue by that many days; zero or less: due in. Null when paid.",
        }),
      })
      .nullable(),
    manager: PersonSchema.nullable(),
    managerFrom: z.enum(["bill", "invoice", "key_manager", "none"]),
    handInvoices: z
      .object({
        count: z.number().int(),
        last: z
          .object({
            invoiceId: z.string().uuid(),
            number: z.string().nullable(),
            issuedOn: Day.nullable(),
          })
          .nullable(),
      })
      .nullable()
      .openapi({
        description: "On a `no_schedule` row: invoices raised by hand for this service.",
      }),
    flags: z.array(FlagSchema),
    notes: z.array(
      z.object({
        code: z.enum(NOTE_CODES),
        date: Day.nullable(),
        invoiceNumber: z.string().nullable(),
      }),
    ),
  })
  .openapi("WorkBillingRow");

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/billing/work-vs-billing",
  tags: ["billing"],
  summary: "Work against billing: each client, service and period with its jobs, bill, invoice and money",
  request: {
    query: z
      .object({
        from: AskedDay.optional().openapi({
          description: "First day of the window; default the first of the month 11 months back.",
        }),
        to: AskedDay.optional().openapi({
          description: "Last day of the window; default the firm's today.",
        }),
        partyId: z.string().uuid().optional(),
        managerUserId: z.string().uuid().optional().openapi({
          description: "The row's manager: the bill's, else the invoice's, else the client's Key Manager.",
        }),
        problemsOnly: z.enum(["true", "false"]).optional(),
      })
      .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
        message: "from must not be after to",
      })
      .refine(
        (q) =>
          q.from === undefined ||
          q.to === undefined ||
          (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86_400_000 <= MAX_WINDOW_DAYS,
        { message: "the window may be at most three years" },
      ),
  },
  responses: {
    200: {
      description: "The rows",
      content: {
        "application/json": {
          schema: z.object({
            today: Day,
            from: Day,
            to: Day,
            autoBilling: z.boolean(),
            feesVisible: z.boolean(),
            truncated: z.boolean(),
            summary: z.object({
              rows: z.number().int(),
              withProblems: z.number().int(),
              byFlag: z.object({
                no_bill: z.number().int(),
                no_final_bill: z.number().int(),
                skipped: z.number().int(),
                not_raised: z.number().int(),
                not_issued: z.number().int(),
                unpaid_overdue: z.number().int(),
              }),
              unbilledAge: z.object(BUCKETS).openapi({
                description: "Done work not yet billed (no bill, no final bill, not raised, not issued), by age.",
              }),
              overdueAge: z.object(BUCKETS),
            }),
            rows: z.array(RowSchema),
          }),
        },
      },
    },
    400: errorResponse("A malformed query"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

function personBody(p: WbPerson | null): { userId: string; displayName: string | null } | null {
  return p === null ? null : { userId: p.userId, displayName: p.displayName };
}

function flagBody(f: Flag) {
  return {
    code: f.code,
    cause: f.cause,
    days: f.days,
    since: f.since,
    reason: f.reason,
    by: personBody(f.by),
    at: f.at,
  };
}

function filingBody(f: WbFiling) {
  return {
    id: f.id,
    name: f.name,
    periodLabel: f.periodLabel,
    dueOn: f.dueOn,
    filedOn: f.filedOn,
    stateName: f.stateName,
    filed: f.filed,
    closed: f.closed,
    jobStatus: f.jobStatus,
  };
}

function rowBody(r: WorkBillingRow, fees: boolean) {
  const money = (v: string | null): string | null => (fees ? v : null);
  return {
    key: r.key,
    kind: r.kind,
    party: { id: r.party.id, displayName: r.party.displayName },
    serviceName: r.serviceName,
    entityName: r.entityName,
    letter: { id: r.letter.id, ref: r.letter.ref },
    engagementIds: [...r.engagementIds],
    feeGroupId: r.feeGroupId,
    frequency: r.frequency,
    period: r.period === null ? null : { start: r.period.start, end: r.period.end, label: r.period.label },
    work: r.work,
    workDoneOn: r.workDoneOn,
    jobs: r.jobs.map((j) => ({
      id: j.id,
      status: j.status,
      periodLabel: j.periodLabel,
      doneOn: j.doneOn,
    })),
    filings: r.filings.map(filingBody),
    bill:
      r.bill === null
        ? null
        : {
            id: r.bill.id,
            kind: r.bill.kind,
            status: r.bill.status,
            billOn: r.bill.billOn,
            currency: r.bill.currency,
            amount: money(r.bill.amount),
            priced: r.bill.priced,
          },
    expectedBillOn: r.expectedBillOn,
    invoice:
      r.invoice === null
        ? null
        : {
            id: r.invoice.id,
            number: r.invoice.number,
            status: r.invoice.status,
            issuedOn: r.invoice.issuedOn,
            dueOn: r.invoice.dueOn,
            invoiced: money(r.invoice.invoiced),
            paid: money(r.invoice.paid),
            outstanding: money(r.invoice.outstanding),
          },
    payment:
      r.payment === null
        ? null
        : {
            state: r.payment.state,
            dueOn: r.payment.dueOn,
            daysOverdue: r.payment.daysOverdue,
          },
    manager: personBody(r.manager),
    managerFrom: r.managerFrom,
    handInvoices:
      r.handInvoices === null
        ? null
        : {
            count: r.handInvoices.count,
            last:
              r.handInvoices.last === null
                ? null
                : {
                    invoiceId: r.handInvoices.last.invoiceId,
                    number: r.handInvoices.last.number,
                    issuedOn: r.handInvoices.last.issuedOn,
                  },
          },
    flags: r.flags.map(flagBody),
    notes: r.notes.map((n) => ({
      code: n.code,
      date: n.date,
      invoiceNumber: n.invoiceNumber,
    })),
  };
}

export function registerWorkBillingRoutes(app: OpenAPIHono<AppEnv>, deps: WorkBillingDeps): void {
  app.openapi(listRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const q = c.req.valid("query");
    const principal = c.get("principal");
    const fees = principal !== null && deps.authz.seesFees(principal);
    const out = await deps.service.list(s.tenantId, {
      from: q.from,
      to: q.to,
      partyId: q.partyId,
      managerUserId: q.managerUserId,
      problemsOnly: q.problemsOnly === "true",
    });
    return c.json(
      {
        today: out.today,
        from: out.from,
        to: out.to,
        autoBilling: out.autoBilling,
        feesVisible: fees,
        truncated: out.truncated,
        summary: {
          rows: out.summary.rows,
          withProblems: out.summary.withProblems,
          byFlag: { ...out.summary.byFlag },
          unbilledAge: { ...out.summary.unbilledAge },
          overdueAge: { ...out.summary.overdueAge },
        },
        rows: out.rows.map((r) => rowBody(r, fees)),
      },
      200,
    );
  });
}
