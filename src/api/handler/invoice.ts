// Invoicing, as a surface — transport only. Each route declares its wire shape;
// its handler parses, calls one use-case method, and maps the result FIELD BY
// FIELD (never a spread of a domain object — see CLAUDE.md, and the two bugs
// that rule was written from).
//
// THE TENANT COMES FROM THE SESSION, like every app-facing route.
//
// AMOUNTS CROSS THE WIRE AS DECIMAL STRINGS. A float cannot hold 1499.50
// exactly and the error is invisible in one line and material in a total, so
// every money field here is a string and only the database adds them up.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { scopeOf } from "../scope";
import type { InvoiceService } from "../../usecase/invoice/service";
import type { Invoice, InvoiceTotals } from "../../domain/invoice/model";
import { INVOICE_STATUSES } from "../../domain/invoice/model";
import type { InvoiceRecord, InvoiceSummary } from "../../usecase/invoice/ports";

export interface InvoiceDeps {
  readonly service: InvoiceService;
}

const STATUS_VALUES = [...INVOICE_STATUSES] as [string, ...string[]];

/** A decimal STRING. The pattern is the contract: a client that sends a JSON
 *  number gets a 400 here rather than a rounded amount in the database. */
const Decimal = z.string().regex(/^-?\d+(\.\d+)?$/);

const InvoiceSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    /** WHO IS BILLED — the client. */
    partyId: z.string().uuid(),
    /** WHO IS CHARGING — one of the firm's own entities, and the owner of the
     *  series this number came from. */
    entityPartyId: z.string().uuid(),
    number: z.string().openapi({
      description:
        "`INV/2026-27/0001`. Allocated by the write itself from a gapless per-entity series " +
        "and frozen by a trigger — an invoice number is never edited. A wrong invoice is " +
        "cancelled and a new one issued, and both stay readable.",
    }),
    financialYear: z.number().int(),
    sequenceNumber: z.number().int(),
    status: z.enum(STATUS_VALUES),
    currency: z.string().length(3),
    fxRate: Decimal,
    fxRateDate: z.string(),
    issuedOn: z.string().nullable(),
    dueOn: z.string().nullable(),
    irn: z.string().nullable().openapi({
      description:
        "India's e-invoice reference, as returned by the registry. Null until registered, and " +
        "unchangeable afterwards — it is the registry's identifier for this document, not ours.",
    }),
    irnRegisteredAt: z.string().nullable(),
    notes: z.string().nullable(),
  })
  .openapi("Invoice");

const TotalsSchema = z
  .object({
    lineCount: z.number().int(),
    gross: Decimal,
    discount: Decimal,
    net: Decimal,
    tax: Decimal,
    /** What the client owes: net of discount, plus tax. Computed by Postgres in
     *  `numeric` from a view — never a stored column, which would drift from
     *  the lines the first time one moved. */
    total: Decimal,
    currency: z.string().length(3),
  })
  .openapi("InvoiceTotals");

const InvoiceLineSchema = z
  .object({
    id: z.string().uuid(),
    engagementId: z.string().uuid().nullable(),
    description: z.string(),
    position: z.number().int(),
    quantity: Decimal,
    unitAmount: Decimal,
    currency: z.string().length(3),
    discountPercent: Decimal,
    taxPercent: Decimal,
    net: Decimal,
    tax: Decimal,
  })
  .openapi("InvoiceLine");

const PartyRefSchema = z.object({ id: z.string().uuid(), displayName: z.string() });

const InvoiceRecordSchema = z
  .object({
    invoice: InvoiceSchema,
    party: PartyRefSchema,
    /** The issuing entity by NAME — an invoice prints a letterhead. */
    entity: PartyRefSchema,
    lines: z.array(InvoiceLineSchema),
    totals: TotalsSchema,
  })
  .openapi("InvoiceRecord");

const InvoiceSummarySchema = z
  .object({ invoice: InvoiceSchema, party: PartyRefSchema, totals: TotalsSchema })
  .openapi("InvoiceSummary");

const RaiseInvoiceRequest = z
  .object({
    partyId: z.string().uuid(),
    entityPartyId: z.string().uuid(),
    currency: z.string().length(3),
    fxRate: Decimal,
    fxRateDate: z.string(),
    dueOn: z.string().optional(),
    notes: z.string().max(2000).optional(),
    seriesDate: z.string().optional().openapi({
      description:
        "Which financial year's series this belongs to. Defaults to today; a firm raising an " +
        "invoice on 2 April for March's work sets it deliberately.",
    }),
  })
  .openapi("RaiseInvoiceRequest");

const AddInvoiceLineRequest = z
  .object({
    engagementId: z.string().uuid().optional(),
    description: z.string().min(1).max(1000),
    quantity: Decimal,
    unitAmount: Decimal,
    discountPercent: Decimal.optional(),
    taxPercent: Decimal.optional(),
  })
  .openapi("AddInvoiceLineRequest");

const SeriesSchema = z
  .object({
    entityPartyId: z.string().uuid(),
    entityName: z.string(),
    financialYear: z.number().int(),
    prefix: z.string(),
    lastNumber: z.number().int(),
  })
  .openapi("InvoiceSeries");

const raiseRoute = createRoute({
  method: "post",
  path: "/api/v1/invoices",
  tags: ["invoices"],
  summary: "Raise an invoice — the number is allocated by the write itself",
  description:
    "The number comes from a gapless per-entity, per-financial-year series, taken under a row " +
    "lock inside the same transaction as the insert. A failure releases it, because the " +
    "counter never moved — which is the difference between this and a document reference.",
  request: {
    body: { content: { "application/json": { schema: RaiseInvoiceRequest } }, required: true },
  },
  responses: {
    201: { description: "Raised", content: { "application/json": { schema: InvoiceSchema } } },
    400: errorResponse("Bad currency, rate, or date"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/invoices",
  tags: ["invoices"],
  summary: "The firm's invoices",
  request: {
    query: z.object({
      status: z.enum(STATUS_VALUES).optional(),
      partyId: z.string().uuid().optional(),
    }),
  },
  responses: {
    200: {
      description: "Invoices",
      content: { "application/json": { schema: z.object({ invoices: z.array(InvoiceSummarySchema) }) } },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const describeRoute = createRoute({
  method: "get",
  path: "/api/v1/invoices/{invoiceId}",
  tags: ["invoices"],
  summary: "One invoice, with its lines and its totals",
  request: { params: z.object({ invoiceId: z.string().uuid() }) },
  responses: {
    200: { description: "The invoice", content: { "application/json": { schema: InvoiceRecordSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such invoice at this firm"),
  },
});

const addLineRoute = createRoute({
  method: "post",
  path: "/api/v1/invoices/{invoiceId}/lines",
  tags: ["invoices"],
  summary: "Add a line to a draft invoice",
  request: {
    params: z.object({ invoiceId: z.string().uuid() }),
    body: { content: { "application/json": { schema: AddInvoiceLineRequest } }, required: true },
  },
  responses: {
    204: { description: "Added" },
    400: errorResponse("Bad quantity, amount, discount or tax rate"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such invoice at this firm"),
    409: errorResponse("The invoice has been issued — its lines are fixed"),
  },
});

const removeLineRoute = createRoute({
  method: "delete",
  path: "/api/v1/invoices/{invoiceId}/lines/{lineId}",
  tags: ["invoices"],
  summary: "Strike a line off a draft invoice",
  request: { params: z.object({ invoiceId: z.string().uuid(), lineId: z.string().uuid() }) },
  responses: {
    204: { description: "Struck off" },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such invoice or line at this firm"),
    409: errorResponse("The invoice has been issued — its lines are fixed"),
  },
});

const issueRoute = createRoute({
  method: "post",
  path: "/api/v1/invoices/{invoiceId}/issue",
  tags: ["invoices"],
  summary: "Issue it",
  description: "Refuses an invoice with no lines: it would ask the client for nothing.",
  request: { params: z.object({ invoiceId: z.string().uuid() }) },
  responses: {
    200: { description: "Issued", content: { "application/json": { schema: InvoiceSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such invoice at this firm"),
    409: errorResponse("Not a draft, or it has no lines"),
  },
});

const cancelRoute = createRoute({
  method: "post",
  path: "/api/v1/invoices/{invoiceId}/cancel",
  tags: ["invoices"],
  summary: "Withdraw it",
  description:
    "The number is NOT released and the row is not removed — that is what makes the series " +
    "consecutive. A cancelled invoice stays in the sequence saying it was cancelled, which is " +
    "exactly what an auditor needs to see where a number went.",
  request: { params: z.object({ invoiceId: z.string().uuid() }) },
  responses: {
    200: { description: "Cancelled", content: { "application/json": { schema: InvoiceSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such invoice at this firm"),
    409: errorResponse("Already cancelled"),
  },
});

const registerIrnRoute = createRoute({
  method: "post",
  path: "/api/v1/invoices/{invoiceId}/irn",
  tags: ["invoices"],
  summary: "Record the e-invoice registry's identifier",
  description:
    "Nothing here talks to the IRP. This records an answer obtained elsewhere — the same shape " +
    "as the advance-fee attestation. The real connector is T7.1.",
  request: {
    params: z.object({ invoiceId: z.string().uuid() }),
    body: {
      content: { "application/json": { schema: z.object({ irn: z.string().min(1).max(100) }) } },
      required: true,
    },
  },
  responses: {
    200: { description: "Recorded", content: { "application/json": { schema: InvoiceSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such invoice at this firm"),
    409: errorResponse("Already registered — the registry's identifier cannot be replaced"),
  },
});

const listSeriesRoute = createRoute({
  method: "get",
  path: "/api/v1/invoice-series",
  tags: ["invoices"],
  summary: "The firm's invoice series, and where each has reached",
  responses: {
    200: {
      description: "Series",
      content: { "application/json": { schema: z.object({ series: z.array(SeriesSchema) }) } },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const setPrefixRoute = createRoute({
  method: "post",
  path: "/api/v1/invoice-series/{entityPartyId}/prefix",
  tags: ["invoices"],
  summary: "Name what one entity's invoice numbers read as",
  description:
    "Changes FUTURE numbers only. Every issued invoice keeps the number it was issued with, " +
    "because the freeze trigger refuses to move one.",
  request: {
    params: z.object({ entityPartyId: z.string().uuid() }),
    body: {
      content: { "application/json": { schema: z.object({ prefix: z.string().min(1).max(12) }) } },
      required: true,
    },
  },
  responses: {
    204: { description: "Set" },
    400: errorResponse("Not a valid series prefix"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

export function registerInvoiceRoutes(app: OpenAPIHono<AppEnv>, deps: InvoiceDeps): void {
  app.openapi(raiseRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const raised = await deps.service.raise({ tenantId: s.tenantId, ...c.req.valid("json") }, s.actor);
    return c.json(toInvoiceBody(raised), 201);
  });

  app.openapi(listRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const q = c.req.valid("query");
    const invoices = await deps.service.list(s.tenantId, {
      status: q.status as InvoiceSummary["invoice"]["status"] | undefined,
      partyId: q.partyId,
    });
    return c.json(
      {
        invoices: invoices.map((r) => ({
          invoice: toInvoiceBody(r.invoice),
          party: { id: r.party.id, displayName: r.party.displayName },
          totals: toTotalsBody(r.totals),
        })),
      },
      200,
    );
  });

  app.openapi(describeRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    return c.json(toRecordBody(await deps.service.describe(s.tenantId, c.req.valid("param").invoiceId)), 200);
  });

  app.openapi(addLineRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    await deps.service.addLine({
      tenantId: s.tenantId,
      invoiceId: c.req.valid("param").invoiceId,
      ...c.req.valid("json"),
    });
    return c.body(null, 204);
  });

  app.openapi(removeLineRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const p = c.req.valid("param");
    await deps.service.removeLine(s.tenantId, p.invoiceId, p.lineId);
    return c.body(null, 204);
  });

  app.openapi(issueRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const issued = await deps.service.issue(s.tenantId, c.req.valid("param").invoiceId, s.actor);
    return c.json(toInvoiceBody(issued), 200);
  });

  app.openapi(cancelRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const cancelled = await deps.service.cancel(s.tenantId, c.req.valid("param").invoiceId, s.actor);
    return c.json(toInvoiceBody(cancelled), 200);
  });

  app.openapi(registerIrnRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const saved = await deps.service.registerIrn(
      s.tenantId,
      c.req.valid("param").invoiceId,
      c.req.valid("json").irn,
      s.actor,
    );
    return c.json(toInvoiceBody(saved), 200);
  });

  app.openapi(listSeriesRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const series = await deps.service.listSeries(s.tenantId);
    return c.json(
      {
        series: series.map((r) => ({
          entityPartyId: r.entityPartyId,
          entityName: r.entityName,
          financialYear: r.financialYear,
          prefix: r.prefix,
          lastNumber: r.lastNumber,
        })),
      },
      200,
    );
  });

  app.openapi(setPrefixRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    await deps.service.setSeriesPrefix(
      s.tenantId,
      c.req.valid("param").entityPartyId,
      c.req.valid("json").prefix,
      s.actor,
    );
    return c.body(null, 204);
  });
}

function toInvoiceBody(i: Invoice): z.infer<typeof InvoiceSchema> {
  return {
    id: i.id,
    tenantId: i.tenantId,
    partyId: i.partyId,
    entityPartyId: i.entityPartyId,
    number: i.number,
    financialYear: i.financialYear,
    sequenceNumber: i.sequenceNumber,
    status: i.status,
    currency: i.currency,
    fxRate: i.fxRate,
    fxRateDate: i.fxRateDate,
    issuedOn: i.issuedOn,
    dueOn: i.dueOn,
    irn: i.irn,
    irnRegisteredAt: i.irnRegisteredAt,
    notes: i.notes,
  };
}

function toTotalsBody(t: InvoiceTotals): z.infer<typeof TotalsSchema> {
  return {
    lineCount: t.lineCount,
    gross: t.gross,
    discount: t.discount,
    net: t.net,
    tax: t.tax,
    total: t.total,
    currency: t.currency,
  };
}

function toRecordBody(record: InvoiceRecord): z.infer<typeof InvoiceRecordSchema> {
  return {
    invoice: toInvoiceBody(record.invoice),
    party: { id: record.party.id, displayName: record.party.displayName },
    entity: { id: record.entity.id, displayName: record.entity.displayName },
    lines: record.lines.map((l) => ({
      id: l.line.id,
      engagementId: l.line.engagementId,
      description: l.line.description,
      position: l.line.position,
      quantity: l.line.quantity,
      unitAmount: l.line.unitAmount,
      currency: l.line.currency,
      discountPercent: l.line.discountPercent,
      taxPercent: l.line.taxPercent,
      net: l.net,
      tax: l.tax,
    })),
    totals: toTotalsBody(record.totals),
  };
}
