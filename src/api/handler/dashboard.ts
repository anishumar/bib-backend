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

export interface DashboardDeps {
  readonly service: DashboardService;
  readonly authz: AuthzService;
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

export function registerDashboardRoutes(app: OpenAPIHono<AppEnv>, deps: DashboardDeps): void {
  /** The fee axis, as a gate rather than a redaction — see the file header. */
  const denyWithoutFees = (principal: Parameters<AuthzService["seesFees"]>[0] | null) => {
    if (principal === null || !deps.authz.seesFees(principal)) {
      return toEnvelope({
        status: 403,
        code: "FORBIDDEN",
        message:
          "These figures are the firm's revenue and receivables, and this login does not have " +
          "commercial visibility. That is a setting on the membership, separate from the role — " +
          "a partner administering the firm can grant it.",
        reason: "NO_COMMERCIAL_VISIBILITY",
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
}

export const dashboardRoutes = {
  overview: overviewRoute,
  mrrBy: mrrByRoute,
  receivablesByClient: receivablesByClientRoute,
  revenueByCompany: revenueByCompanyRoute,
} as const;
