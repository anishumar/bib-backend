// The leadership figures' HTTP surface (T3.7) — transport only.
//
// THE WHOLE SURFACE IS BEHIND THE FEE AXIS, and that is the one decision here
// worth arguing about.
//
// Everywhere else in this product, commercial visibility REDACTS money and
// leaves the record — `withFeeVisibility` nulls an amount so that "you may not
// see this" never looks like "there is no fee". That is right for an invoice: a
// delivery colleague still needs to know the invoice exists.
//
// It is wrong here, because these responses are money and nothing else. A
// redacted dashboard is a page of nulls, which does not communicate "you may not
// see this" — it communicates "the firm has no revenue", which is worse than a
// refusal. So the routes require the axis outright and answer 403 with a message
// that says what is missing. A screen asks `/auth/me` and does not offer the
// link at all.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import type { AuthzService } from "../../usecase/authz/service";
import type {
  DashboardService,
  Overview,
  RevenueByCompany,
  RevenueByManager,
} from "../../usecase/dashboard/service";
import type { Slice } from "../../domain/dashboard/model";
import {
  AGEING_BUCKETS,
  BILLING_MONTHS_DEFAULT,
  BILLING_MONTHS_MAX,
  MRR_EXCLUSIONS,
} from "../../domain/dashboard/model";
import { toEnvelope } from "../httpresp";
import { scopeOf } from "../scope";
import type { OriginatorService } from "../../usecase/originator/service";
import {
  REVENUE_REPORT_MAX_DAYS,
  type ClientSummary,
  type RevenueReport,
  type SummaryFigures,
} from "../../usecase/dashboard/service";
import { registerOriginatorRoutes } from "./originator";

export interface DashboardDeps {
  readonly service: DashboardService;
  readonly authz: AuthzService;
  /** Who won each letter's work (0355, Q049): the report's originators. */
  readonly originators: OriginatorService;
}

// ── Response schemas ────────────────────────────────────────────────────────

const AmountString = z.string().openapi({
  description:
    "A decimal STRING in the currency named on this response, never a number — a float cannot " +
    "hold 1499.50 exactly and the error is invisible in one line and material in a total.",
});

const OverviewResponse = z
  .object({
    currency: z.string().openapi({
      description:
        "The firm's reporting currency. Stated ONCE: every figure below is already converted " +
        "to it, at the rate stored on the document it came from — never a rate looked up today.",
    }),
    mrr: z.object({
      monthly: AmountString,
      countedEngagements: z.number().int(),
      gaps: z
        .array(
          z.object({
            reason: z.enum(MRR_EXCLUSIONS as unknown as [string, ...string[]]),
            engagementCount: z.number().int(),
          }),
        )
        .openapi({
          description:
            "What the headline number could NOT count, and why. Never empty by design and " +
            "never hidden: a total that silently drops what it does not understand is worse " +
            "than no total. An engagement with no billing frequency stated, or one whose fee " +
            "is not yet priced, contributes nothing to MRR and the firm is entitled to know.",
        }),
    }),
    receivables: z.object({
      outstanding: AmountString,
      bands: z.array(
        z.object({
          bucket: z.enum(AGEING_BUCKETS as unknown as [string, ...string[]]),
          amount: AmountString,
          invoiceCount: z.number().int(),
        }),
      ),
    }),
    dsoDays: z.number().nullable().openapi({
      description:
        "Days Sales Outstanding over the window below. NULL — never zero — when the firm " +
        "billed nothing in that window: '0 days' reads as excellent collections when the " +
        "truth is that there is not enough billing to say.",
    }),
    dsoWindowDays: z.number().int(),
  })
  .openapi("DashboardOverview");

const SliceSchema = z
  .object({
    key: z.string(),
    label: z.string().openapi({ description: "The name, never the uuid." }),
    amount: AmountString,
    count: z.number().int(),
  })
  .openapi("DashboardSlice");

const SlicesResponse = z
  .object({ currency: z.string(), slices: z.array(SliceSchema) })
  .openapi("DashboardSlicesResponse");

function sliceToWire(s: Slice): z.infer<typeof SliceSchema> {
  return { key: s.key, label: s.label, amount: s.amount, count: s.count };
}

/**
 * Field by field, never the domain object forwarded.
 *
 * The rule from CLAUDE.md, and this handler proved why it is worth enforcing in
 * types rather than trusting: the first version returned the service's own
 * `Overview` straight through and the compiler refused it, because the domain
 * carries `reason` and `bucket` as plain strings while the wire declares them as
 * closed enums. A codebase where that assignment compiled would have shipped a
 * response whose documented shape and actual shape differed — which is exactly
 * how `role` and `commercialVisibility` sat undocumented on `/auth/me` for six
 * tasks.
 */
function overviewToWire(o: Overview): z.infer<typeof OverviewResponse> {
  return {
    currency: o.currency,
    mrr: {
      monthly: o.mrr.monthly,
      countedEngagements: o.mrr.countedEngagements,
      gaps: o.mrr.gaps.map((g) => ({
        reason: g.reason,
        engagementCount: g.engagementCount,
      })),
    },
    receivables: {
      outstanding: o.receivables.outstanding,
      bands: o.receivables.bands.map((b) => ({
        bucket: b.bucket,
        amount: b.amount,
        invoiceCount: b.invoiceCount,
      })),
    },
    dsoDays: o.dsoDays,
    dsoWindowDays: o.dsoWindowDays,
  };
}

const BILLED_DEFINITION =
  "BILLED is ISSUED invoices only (a draft was never sent, a cancelled one was withdrawn), by " +
  "the month of their issue date, BEFORE TAX (net of discount), less the credit notes issued " +
  "that month, each at its pre-tax share of the invoice it credits. A credit note on an " +
  "invoice cancelled since is left out with it.";

const MonthBillingSchema = z.object({
  month: z.string().openapi({ description: "YYYY-MM." }),
  billed: z.string().openapi({
    description:
      "A decimal STRING in the company's own `currency`, never a number. " + BILLED_DEFINITION,
  }),
  billedReporting: z.string().openapi({
    description:
      "The same month in the firm's reporting currency, every document at the rate stored on " +
      "it, never a rate looked up today. Includes invoices in other currencies.",
  }),
  invoiceCount: z.number().int().openapi({ description: "Invoices counted in `billed`." }),
});

const RevenueByCompanyResponse = z
  .object({
    reportingCurrency: z.string().length(3),
    months: z.array(z.string()).openapi({
      description:
        "The last N calendar months, oldest first, as YYYY-MM. The last one is the month the " +
        "FIRM is in now, on its own timezone, not the server's.",
    }),
    total: z
      .array(
        z.object({
          month: z.string(),
          billedReporting: z.string(),
          invoiceCount: z.number().int(),
        }),
      )
      .openapi({
        description: "The whole firm, every company, month by month, in the reporting currency.",
      }),
    companies: z.array(
      z.object({
        partyId: z.string().uuid(),
        name: z.string(),
        jurisdiction: z.string().nullable(),
        currency: z.string().length(3).openapi({
          description:
            "The currency the company bills in, from where it is registered (IN INR, AE AED, " +
            "SG SGD, US USD, else the reporting currency): the one table `defaultCurrency` on " +
            "/firm-entities serves.",
        }),
        months: z.array(MonthBillingSchema),
        otherCurrencyInvoices: z.number().int().openapi({
          description:
            "Invoices it issued in the window in ANOTHER currency: in `billedReporting`, not in " +
            "`billed`, because nothing stores a rate between two currencies that are not the " +
            "reporting one. Zero for a company billing in the reporting currency.",
        }),
      }),
    ),
  })
  .openapi("DashboardRevenueByCompany");

function revenueToWire(r: RevenueByCompany): z.infer<typeof RevenueByCompanyResponse> {
  return {
    reportingCurrency: r.reportingCurrency,
    months: [...r.months],
    total: r.total.map((t) => ({
      month: t.month,
      billedReporting: t.billedReporting,
      invoiceCount: t.invoiceCount,
    })),
    companies: r.companies.map((c) => ({
      partyId: c.partyId,
      name: c.name,
      jurisdiction: c.jurisdiction,
      currency: c.currency,
      months: c.months.map((m) => ({
        month: m.month,
        billed: m.billed,
        billedReporting: m.billedReporting,
        invoiceCount: m.invoiceCount,
      })),
      otherCurrencyInvoices: c.otherCurrencyInvoices,
    })),
  };
}

const COLLECTED_DEFINITION =
  "COLLECTED is the cash received that month on the manager's ISSUED invoices, by the payment's " +
  "received date, WITH tax (what reached the bank); a bounced cheque or a refund is a negative " +
  "payment and comes off the month it is dated. Payments on an invoice cancelled since are left out.";

const ManagerMonthSchema = z.object({
  month: z.string().openapi({ description: "YYYY-MM." }),
  billed: AmountString.openapi({ description: "Before tax. " + BILLED_DEFINITION }),
  collected: AmountString.openapi({ description: "With tax. " + COLLECTED_DEFINITION }),
  invoiceCount: z.number().int().openapi({ description: "Invoices issued that month." }),
});

const OwedSchema = {
  outstanding: AmountString.openapi({
    description:
      "What these issued invoices are owed NOW, with tax, overpayments left out: the rows " +
      "/dashboard/overview's `receivables.outstanding` sums, so the managers add up to it. Not cut " +
      "by month.",
  }),
  outstandingInvoices: z.number().int(),
};

const RevenueByManagerResponse = z
  .object({
    reportingCurrency: z.string().length(3).openapi({
      description: "Every amount below, each document at the rate stored on it, never today's.",
    }),
    months: z.array(z.string()).openapi({
      description:
        "The last N calendar months, oldest first, as YYYY-MM, the last one the month the FIRM " +
        "is in now on its own timezone.",
    }),
    financialYearStartMonth: z.number().int().min(1).max(12).nullable().openapi({
      description:
        "The month (1-12) the firm's financial year starts, from its compliance policy, so a screen " +
        "can offer 'this financial year'. Null when the firm has not said.",
    }),
    total: z
      .object({ months: z.array(ManagerMonthSchema), ...OwedSchema })
      .openapi({ description: "The whole firm: what the rows below add up to." }),
    managers: z.array(
      z.object({
        userId: z.string().uuid().nullable().openapi({
          description:
            "The invoice's `managerUserId`. Null is ONE row: the invoices that name nobody, listed " +
            "so the table adds up to the firm.",
        }),
        name: z.string().nullable().openapi({
          description: "Their name on this firm's roster. Null on the no-manager row.",
        }),
        activeStaff: z.boolean().openapi({
          description: "On the staff today. False for somebody who has left: the revenue stays theirs.",
        }),
        months: z.array(ManagerMonthSchema),
        ...OwedSchema,
      }),
    ),
  })
  .openapi("DashboardRevenueByManager");

function managersToWire(r: RevenueByManager): z.infer<typeof RevenueByManagerResponse> {
  const month = (m: RevenueByManager["total"]["months"][number]) => ({
    month: m.month,
    billed: m.billed,
    collected: m.collected,
    invoiceCount: m.invoiceCount,
  });
  return {
    reportingCurrency: r.reportingCurrency,
    months: [...r.months],
    financialYearStartMonth: r.financialYearStartMonth,
    total: {
      months: r.total.months.map(month),
      outstanding: r.total.outstanding,
      outstandingInvoices: r.total.outstandingInvoices,
    },
    managers: r.managers.map((m) => ({
      userId: m.userId,
      name: m.name,
      activeStaff: m.activeStaff,
      months: m.months.map(month),
      outstanding: m.outstanding,
      outstandingInvoices: m.outstandingInvoices,
    })),
  };
}

// ── Routes ──────────────────────────────────────────────────────────────────

const overviewRoute = createRoute({
  method: "get",
  path: "/api/v1/dashboard/overview",
  tags: ["dashboard"],
  summary: "MRR, receivables ageing and DSO — the firm's own numbers",
  description:
    "Every figure is derived from rows at read time, never from a cached column, so it " +
    "reconciles to the invoices and engagements underneath it. Requires commercial visibility.",
  responses: {
    200: { description: "The figures", content: { "application/json": { schema: OverviewResponse } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org selected, or the caller does not have commercial visibility"),
  },
});

const mrrByRoute = createRoute({
  method: "get",
  path: "/api/v1/dashboard/mrr/{axis}",
  tags: ["dashboard"],
  summary: "MRR split by client or by service, biggest first",
  request: { params: z.object({ axis: z.enum(["client", "service"]) }) },
  responses: {
    200: { description: "Slices", content: { "application/json": { schema: SlicesResponse } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org selected, or the caller does not have commercial visibility"),
  },
});

const receivablesByClientRoute = createRoute({
  method: "get",
  path: "/api/v1/dashboard/receivables/by-client",
  tags: ["dashboard"],
  summary: "Who owes the firm money, biggest first",
  responses: {
    200: { description: "Slices", content: { "application/json": { schema: SlicesResponse } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org selected, or the caller does not have commercial visibility"),
  },
});

const revenueByCompanyRoute = createRoute({
  method: "get",
  path: "/api/v1/dashboard/revenue/by-company",
  tags: ["dashboard"],
  summary: "What each of the firm's companies billed, month by month",
  description:
    "One series per company in its own currency (they cannot share an axis), and the whole " +
    "firm in the reporting currency. " +
    BILLED_DEFINITION +
    " Summed in SQL on numeric; every amount is a decimal string. Requires commercial visibility.",
  request: {
    query: z.object({
      months: z.coerce
        .number()
        .int()
        .min(1)
        .max(BILLING_MONTHS_MAX)
        .default(BILLING_MONTHS_DEFAULT)
        .openapi({
          description: `How many months, ending with this one. Default ${String(BILLING_MONTHS_DEFAULT)}.`,
        }),
    }),
  },
  responses: {
    200: {
      description: "Billing by company",
      content: { "application/json": { schema: RevenueByCompanyResponse } },
    },
    400: errorResponse("`months` is not a whole number from 1 to 24"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org selected, or the caller does not have commercial visibility"),
  },
});

const revenueByManagerRoute = createRoute({
  method: "get",
  path: "/api/v1/dashboard/revenue/by-manager",
  tags: ["dashboard"],
  summary: "What each manager's invoices billed and collected, month by month, and are owed now",
  description:
    "Grouped on the invoice's manager (`managerUserId`, fixed when it is issued): Ashish's " +
    "'revenue is tracked by manager'. Everything in the firm's reporting currency at each " +
    "document's stored rate. " +
    BILLED_DEFINITION +
    " " +
    COLLECTED_DEFINITION +
    " Summed in SQL on numeric; every amount is a decimal string. Requires commercial visibility.",
  request: {
    query: z.object({
      months: z.coerce
        .number()
        .int()
        .min(1)
        .max(BILLING_MONTHS_MAX)
        .default(BILLING_MONTHS_DEFAULT)
        .openapi({
          description: `How many months, ending with this one. Default ${String(BILLING_MONTHS_DEFAULT)}.`,
        }),
    }),
  },
  responses: {
    200: {
      description: "Revenue by manager",
      content: { "application/json": { schema: RevenueByManagerResponse } },
    },
    400: errorResponse("`months` is not a whole number from 1 to 24"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org selected, or the caller does not have commercial visibility"),
  },
});

const ReportDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const RevenueFigures = {
  currency: z.string().openapi({ description: "Every amount on this row is in this currency, never converted." }),
  invoiced: AmountString.openapi({
    description: "Issued in the period, before tax, less credit notes issued in the period at their pre-tax share.",
  }),
  collected: AmountString.openapi({ description: "Money received in the period, with tax." }),
  outstanding: AmountString.openapi({ description: "Owed at the close of `asOf`." }),
  invoices: z.number().int().openapi({ description: "Invoices issued in the period that count here." }),
};

const RevenueReportResponse = z
  .object({
    by: z.enum(["manager", "originator"]),
    from: ReportDay,
    to: ReportDay,
    asOf: ReportDay.openapi({ description: "The day outstanding is owed at: `to`, or today if sooner." }),
    financialYearStartMonth: z.number().int().nullable(),
    currencies: z.array(z.object(RevenueFigures)).openapi({
      description: "The firm's whole, one per currency: each person's rows of that currency add up to it.",
    }),
    rows: z.array(
      z.object({
        userId: z.string().uuid().nullable().openapi({ description: "Null: naming nobody." }),
        name: z.string().nullable(),
        activeStaff: z.boolean(),
        ...RevenueFigures,
      }),
    ),
  })
  .openapi("RevenueReport");

const revenueReportRoute = createRoute({
  method: "get",
  path: "/api/v1/dashboard/revenue/report",
  tags: ["dashboard"],
  summary: "Revenue by manager or by originator, per currency (Q049)",
  description:
    "Invoiced, collected and outstanding per person and per CURRENCY: amounts in two currencies are " +
    "never added or converted. `by=manager` is the invoice's manager (fixed when it is issued); " +
    "`by=originator` is who won the letter each invoice line bills (0355), each line taking its share " +
    "of the invoice's credit notes, money and balance. Drafts and cancelled invoices count nowhere. " +
    "The period defaults to this financial year to date. Requires commercial visibility.",
  request: {
    query: z
      .object({
        by: z.enum(["manager", "originator"]).default("manager"),
        from: ReportDay.optional(),
        to: ReportDay.optional(),
        issuerPartyId: z.string().uuid().optional().openapi({ description: "One of the firm's companies." }),
        currency: z
          .string()
          .regex(/^[A-Z]{3}$/)
          .optional(),
      })
      .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
        message: "The period starts after it ends.",
        path: ["from"],
      })
      .refine(
        (q) =>
          q.from === undefined ||
          q.to === undefined ||
          (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= REVENUE_REPORT_MAX_DAYS,
        { message: "A report covers at most three years.", path: ["from"] },
      ),
  },
  responses: {
    200: { description: "The report", content: { "application/json": { schema: RevenueReportResponse } } },
    400: errorResponse("A malformed day, a period that ends before it starts, or more than three years"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org selected, or the caller does not have commercial visibility"),
  },
});

function reportToWire(r: RevenueReport) {
  return {
    by: r.by,
    from: r.from,
    to: r.to,
    asOf: r.asOf,
    financialYearStartMonth: r.financialYearStartMonth,
    currencies: r.currencies.map((c) => ({
      currency: c.currency,
      invoiced: c.invoiced,
      collected: c.collected,
      outstanding: c.outstanding,
      invoices: c.invoices,
    })),
    rows: r.rows.map((row) => ({
      userId: row.userId,
      name: row.name,
      activeStaff: row.activeStaff,
      currency: row.currency,
      invoiced: row.invoiced,
      collected: row.collected,
      outstanding: row.outstanding,
      invoices: row.invoices,
    })),
  };
}

const SummaryFiguresSchema = {
  currency: z.string().openapi({ description: "Every amount on this row is in this currency, never converted." }),
  billed: AmountString.openapi({
    description: "Issued in the period, with tax, less credit notes issued in the period.",
  }),
  received: AmountString.openapi({ description: "Money received in the period (the revenue report's collected)." }),
  tds: AmountString.openapi({ description: "Tax the client deducted on those payments: settled, not received." }),
  pending: AmountString.openapi({ description: "Still owed at the close of `asOf`, whenever it was billed." }),
  overdue: AmountString.openapi({ description: "The part of pending past its due date." }),
  invoices: z.number().int().openapi({ description: "Invoices issued in the period that count here." }),
};

const SummaryPersonSchema = z.object({ userId: z.string().uuid(), name: z.string() });

const ClientSummaryResponse = z
  .object({
    from: ReportDay,
    to: ReportDay,
    asOf: ReportDay.openapi({ description: "The day pending is owed at: `to`, or today if sooner." }),
    financialYearStartMonth: z.number().int().nullable(),
    currencies: z.array(z.object(SummaryFiguresSchema)).openapi({
      description: "The firm's whole, one per currency: every client's totals of that currency add up to it.",
    }),
    clients: z.array(
      z.object({
        partyId: z.string().uuid(),
        name: z.string(),
        keyManager: SummaryPersonSchema.nullable().openapi({ description: "In force today." }),
        totals: z.array(z.object(SummaryFiguresSchema)),
        lines: z.array(
          z.object({
            kind: z.enum(["service", "section", "advance", "other"]).openapi({
              description:
                "`service`: one catalogue service; `section`: one fee for several services; " +
                "`advance`: money taken ahead of the work and not yet mapped to a service; " +
                "`other`: invoice lines raised by hand with no service.",
            }),
            key: z.string(),
            name: z.string().nullable(),
            services: z.array(z.string()).openapi({ description: "A section's services." }),
            depts: z.array(z.object({ code: z.string(), name: z.string() })),
            spocs: z.array(SummaryPersonSchema.extend({ deptCode: z.string() })).openapi({
              description: "The client's SPOCs (in force today) for the Depts of this work.",
            }),
            ...SummaryFiguresSchema,
          }),
        ),
      }),
    ),
  })
  .openapi("ClientSummary");

const clientSummaryRoute = createRoute({
  method: "get",
  path: "/api/v1/dashboard/client-summary",
  tags: ["dashboard"],
  summary: "Billed, received and pending per client and service, with its Key Manager and SPOCs",
  description:
    "Per client and per what each invoice line was for (a service, a section, an advance, or nothing), per " +
    "CURRENCY: amounts in two currencies are never added or converted. A line takes its share of its invoice's " +
    "credit notes, money and balance by its share of the invoice total. Drafts and cancelled invoices count " +
    "nowhere. `keyManagerUserId` keeps the clients that person is the Key Manager of; `spocUserId` the rows " +
    "that person is a SPOC for. The period defaults to this financial year to date. Requires commercial visibility.",
  request: {
    query: z
      .object({
        from: ReportDay.optional(),
        to: ReportDay.optional(),
        partyId: z.string().uuid().optional().openapi({ description: "One client." }),
        issuerPartyId: z.string().uuid().optional().openapi({ description: "One of the firm's companies." }),
        currency: z
          .string()
          .regex(/^[A-Z]{3}$/)
          .optional(),
        keyManagerUserId: z.string().uuid().optional(),
        spocUserId: z.string().uuid().optional(),
      })
      .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
        message: "The period starts after it ends.",
        path: ["from"],
      })
      .refine(
        (q) =>
          q.from === undefined ||
          q.to === undefined ||
          (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= REVENUE_REPORT_MAX_DAYS,
        { message: "A report covers at most three years.", path: ["from"] },
      ),
  },
  responses: {
    200: { description: "The summary", content: { "application/json": { schema: ClientSummaryResponse } } },
    400: errorResponse("A malformed day, a period that ends before it starts, or more than three years"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org selected, or the caller does not have commercial visibility"),
  },
});

function figuresToWire(f: SummaryFigures) {
  return {
    currency: f.currency,
    billed: f.billed,
    received: f.received,
    tds: f.tds,
    pending: f.pending,
    overdue: f.overdue,
    invoices: f.invoices,
  };
}

function summaryToWire(r: ClientSummary) {
  return {
    from: r.from,
    to: r.to,
    asOf: r.asOf,
    financialYearStartMonth: r.financialYearStartMonth,
    currencies: r.currencies.map(figuresToWire),
    clients: r.clients.map((c) => ({
      partyId: c.partyId,
      name: c.name,
      keyManager: c.keyManager === null ? null : { userId: c.keyManager.userId, name: c.keyManager.name },
      totals: c.totals.map(figuresToWire),
      lines: c.lines.map((l) => ({
        kind: l.kind,
        key: l.key,
        name: l.name,
        services: [...l.services],
        depts: l.depts.map((d) => ({ code: d.code, name: d.name })),
        spocs: l.spocs.map((p) => ({ userId: p.userId, name: p.name, deptCode: p.deptCode })),
        ...figuresToWire(l),
      })),
    })),
  };
}

const TodaysRateSchema = z
  .object({
    fxRate: z.string().openapi({ description: "One unit of the currency, in the reporting currency." }),
    fxRateDate: z.string().openapi({ description: "The day of the rate: the firm's day or the latest before it." }),
    source: z.string().openapi({ description: '"ExchangeRate-API", "Currency API" or "Same currency".' }),
  })
  .openapi("TodaysRate");

const MrrByCurrencySchema = z
  .object({
    reportingCurrency: z.string(),
    asOf: z.string().openapi({ description: "The firm's day the rates are today's for." }),
    currencies: z.array(
      z.object({
        currency: z.string(),
        monthly: z.string().openapi({ description: "A month of the recurring fees, in this currency." }),
        atSignedRates: z.string().openapi({ description: "In the reporting currency at each letter's own rate: what MRR counts." }),
        atTodaysRate: z.string().nullable().openapi({ description: "In the reporting currency at today's rate; null with no rate held." }),
        todaysRate: TodaysRateSchema.nullable(),
        engagements: z.number().int(),
      }),
    ),
    clients: z.array(
      z.object({
        partyId: z.string().uuid(),
        name: z.string(),
        currency: z.string(),
        monthly: z.string(),
        atSignedRates: z.string(),
        atTodaysRate: z.string().nullable(),
      }),
    ),
    totalAtSignedRates: z.string().openapi({ description: "Equals MRR on the overview." }),
    totalAtTodaysRate: z.string().nullable(),
  })
  .openapi("MrrByCurrency");

const mrrByCurrencyRoute = createRoute({
  method: "get",
  path: "/api/v1/dashboard/mrr-by-currency",
  tags: ["dashboard"],
  summary: "Recurring fees by currency, at the signed rates and at today's rate",
  description:
    "0345, Q009. Each currency's recurring fees a month in that currency, in the reporting " +
    "currency at the rates the letters were signed at (MRR, unchanged), and at today's rate from " +
    "the exchange-rate feed with its date and source; per client too. Never one figure that adds " +
    "two currencies.",
  responses: {
    200: { description: "The report", content: { "application/json": { schema: MrrByCurrencySchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org selected, or the caller does not have commercial visibility"),
  },
});

export function registerDashboardRoutes(app: OpenAPIHono<AppEnv>, deps: DashboardDeps): void {
  /** The fee axis, as a gate rather than a redaction — see the file header. */
  const denyWithoutFees = (principal: Parameters<AuthzService["seesFees"]>[0] | null) => {
    if (principal === null || !deps.authz.seesFees(principal)) {
      // In words a CA firm uses (CA#54, audit 2026-10-03), and the fee axis's
      // one reason code, as every other money refusal has.
      return toEnvelope({
        status: 403,
        code: "FORBIDDEN",
        message:
          "These are the firm's revenue figures, and your login is not set to see fees. " +
          "Ask somebody who can see fees.",
        reason: "FEES_NOT_VISIBLE",
      });
    }
    return null;
  };

  app.openapi(overviewRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const denied = denyWithoutFees(c.get("principal"));
    if (denied !== null) return c.json(denied, 403);
    return c.json(overviewToWire(await deps.service.overview(s.tenantId)), 200);
  });

  app.openapi(mrrByCurrencyRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const denied = denyWithoutFees(c.get("principal"));
    if (denied !== null) return c.json(denied, 403);
    const r = await deps.service.mrrByCurrency(s.tenantId);
    return c.json(
      {
        reportingCurrency: r.reportingCurrency,
        asOf: r.asOf,
        currencies: r.currencies.map((x) => ({
          currency: x.currency,
          monthly: x.monthly,
          atSignedRates: x.atSignedRates,
          atTodaysRate: x.atTodaysRate,
          todaysRate: x.todaysRate === null ? null : { ...x.todaysRate },
          engagements: x.engagements,
        })),
        clients: r.clients.map((x) => ({
          partyId: x.partyId,
          name: x.name,
          currency: x.currency,
          monthly: x.monthly,
          atSignedRates: x.atSignedRates,
          atTodaysRate: x.atTodaysRate,
        })),
        totalAtSignedRates: r.totalAtSignedRates,
        totalAtTodaysRate: r.totalAtTodaysRate,
      },
      200,
    );
  });

  app.openapi(mrrByRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const denied = denyWithoutFees(c.get("principal"));
    if (denied !== null) return c.json(denied, 403);
    const { axis } = c.req.valid("param");
    const [currency, slices] = await Promise.all([
      deps.service.reportingCurrency(s.tenantId),
      deps.service.mrrBy(s.tenantId, axis),
    ]);
    return c.json({ currency, slices: slices.map(sliceToWire) }, 200);
  });

  app.openapi(receivablesByClientRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const denied = denyWithoutFees(c.get("principal"));
    if (denied !== null) return c.json(denied, 403);
    const [currency, slices] = await Promise.all([
      deps.service.reportingCurrency(s.tenantId),
      deps.service.receivablesByClient(s.tenantId),
    ]);
    return c.json({ currency, slices: slices.map(sliceToWire) }, 200);
  });

  app.openapi(revenueByCompanyRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const denied = denyWithoutFees(c.get("principal"));
    if (denied !== null) return c.json(denied, 403);
    const { months } = c.req.valid("query");
    return c.json(revenueToWire(await deps.service.revenueByCompany(s.tenantId, months)), 200);
  });

  app.openapi(revenueReportRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const denied = denyWithoutFees(c.get("principal"));
    if (denied !== null) return c.json(denied, 403);
    const q = c.req.valid("query");
    return c.json(
      reportToWire(
        await deps.service.revenueReport(s.tenantId, {
          by: q.by,
          from: q.from,
          to: q.to,
          issuerPartyId: q.issuerPartyId,
          currency: q.currency,
        }),
      ),
      200,
    );
  });

  app.openapi(clientSummaryRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const denied = denyWithoutFees(c.get("principal"));
    if (denied !== null) return c.json(denied, 403);
    const q = c.req.valid("query");
    return c.json(
      summaryToWire(
        await deps.service.clientSummary(s.tenantId, {
          from: q.from,
          to: q.to,
          partyId: q.partyId,
          issuerPartyId: q.issuerPartyId,
          currency: q.currency,
          keyManagerUserId: q.keyManagerUserId,
          spocUserId: q.spocUserId,
        }),
      ),
      200,
    );
  });

  registerOriginatorRoutes(app, { service: deps.originators });

  app.openapi(revenueByManagerRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const denied = denyWithoutFees(c.get("principal"));
    if (denied !== null) return c.json(denied, 403);
    const { months } = c.req.valid("query");
    return c.json(managersToWire(await deps.service.revenueByManager(s.tenantId, months)), 200);
  });
}

export const dashboardRoutes = {
  overview: overviewRoute,
  mrrBy: mrrByRoute,
  receivablesByClient: receivablesByClientRoute,
  revenueByCompany: revenueByCompanyRoute,
  revenueByManager: revenueByManagerRoute,
  revenueReport: revenueReportRoute,
  clientSummary: clientSummaryRoute,
} as const;
