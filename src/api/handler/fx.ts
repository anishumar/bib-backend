// The day's exchange rate over HTTP (0345, Q009) — transport only. What a
// rate box on a proposal, a letter or an invoice offers before a person
// types one: the feed's rate for that currency in the firm's own currency,
// with its date and who published it.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { scopeOf } from "../scope";
import { toEnvelope } from "../httpresp";
import type { FxService } from "../../usecase/fx/service";

export interface FxDeps {
  readonly service: FxService;
}

const DaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const FxQuoteSchema = z
  .object({
    currency: z.string().length(3),
    reportingCurrency: z.string().length(3).openapi({ description: "The firm's own currency: what the rate is in." }),
    fxRate: z.string().openapi({ description: "One unit of `currency`, in `reportingCurrency`. A decimal string." }),
    fxRateDate: DaySchema.openapi({
      description:
        "The day of the rate actually used: the day asked for or the latest before it (a weekend, " +
        "a feed that was down), or the earliest after it when the feed's history starts later.",
    }),
    source: z.string().openapi({ description: '"ExchangeRate-API", "Currency API" or "Same currency".' }),
  })
  .openapi("FxQuote");

const quoteRoute = createRoute({
  method: "get",
  path: "/api/v1/fx/quote",
  tags: ["fx"],
  summary: "The feed's exchange rate for a currency, in the firm's own currency",
  description:
    "A SUGGESTION for a document's rate box, never a term: the rate a document carries is the " +
    "one saved on it (0344). From the product's daily table, fetched once a day; a day not held " +
    "yet is asked of the feed once. 404 FX_RATE_UNAVAILABLE when no rate is held for the pair and " +
    "the feed could not supply one: the person types it.",
  request: {
    query: z.object({
      currency: z.string().length(3),
      on: DaySchema.openapi({ description: "The caller's day, YYYY-MM-DD." }),
    }),
  },
  responses: {
    200: { description: "The rate", content: { "application/json": { schema: FxQuoteSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No rate for this currency (FX_RATE_UNAVAILABLE)"),
  },
});

export function registerFxRoutes(app: OpenAPIHono<AppEnv>, deps: FxDeps): void {
  app.openapi(quoteRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { currency, on } = c.req.valid("query");
    const quote = await deps.service.quote(s.tenantId, currency, on);
    if (quote === null) {
      return c.json(
        toEnvelope({
          status: 404,
          code: "NOT_FOUND",
          message: `No exchange rate for ${currency.toUpperCase()} is available. Type the rate instead.`,
          reason: "FX_RATE_UNAVAILABLE",
        }),
        404,
      );
    }
    return c.json(
      {
        currency: quote.currency,
        reportingCurrency: quote.reporting,
        fxRate: quote.fxRate,
        fxRateDate: quote.fxRateDate,
        source: quote.source,
      },
      200,
    );
  });
}
