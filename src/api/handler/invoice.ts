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
import type {
  CreditNote,
  Invoice,
  InvoiceBalance,
  InvoiceTotals,
  Payment,
} from "../../domain/invoice/model";
import {
  CREDIT_REASONS,
  INVOICE_STATUSES,
  PAYMENT_METHODS,
} from "../../domain/invoice/model";
import type { InvoiceRecord, InvoiceSummary } from "../../usecase/invoice/ports";

export interface InvoiceDeps {
  readonly service: InvoiceService;
}

const STATUS_VALUES = [...INVOICE_STATUSES] as [string, ...string[]];
const PAYMENT_METHOD_VALUES = [...PAYMENT_METHODS] as [string, ...string[]];
const CREDIT_REASON_VALUES = [...CREDIT_REASONS] as [string, ...string[]];

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
    /** `invoice` or `credit_note` — two legal series that must not interleave. */
    documentType: z.string(),
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

// ── Money against an invoice (T3.5) ────────────────────────────────────────

const PaymentSchema = z
  .object({
    id: z.string().uuid(),
    invoiceId: z.string().uuid(),
    /** SIGNED. A bounced cheque is a NEGATIVE payment with its own date and
     *  note — two rows that tell the story, rather than one row edited into
     *  something that never happened. */
    amount: Decimal,
    currency: z.string().length(3),
    receivedOn: z.string(),
    method: z.enum(PAYMENT_METHOD_VALUES),
    reference: z.string().nullable(),
    note: z.string().nullable(),
  })
  .openapi("Payment");

const CreditNoteSchema = z
  .object({
    id: z.string().uuid(),
    invoiceId: z.string().uuid(),
    entityPartyId: z.string().uuid(),
    number: z.string().openapi({
      description:
        "`CN/2026-27/0001`. Its OWN consecutive series, keyed separately from the invoice one — " +
        "a credit note is a distinct legal document, and interleaving the two series is worse " +
        "than a gap.",
    }),
    financialYear: z.number().int(),
    sequenceNumber: z.number().int(),
    amount: Decimal,
    currency: z.string().length(3),
    issuedOn: z.string(),
    reason: z.enum(CREDIT_REASON_VALUES).openapi({
      description:
        "WHY money came off. Mandatory and closed, because without it the numbers always " +
        "reconcile and why forty thousand came off does not — and 'how much did we write off " +
        "to service failures' is a GROUP BY, which free text cannot answer.",
    }),
    note: z.string().nullable(),
  })
  .openapi("CreditNote");

const BalanceSchema = z
  .object({
    invoiceId: z.string().uuid(),
    partyId: z.string().uuid(),
    status: z.enum(STATUS_VALUES),
    currency: z.string().length(3),
    dueOn: z.string().nullable(),
    invoiced: Decimal,
    paid: Decimal,
    credited: Decimal,
    /** invoiced − paid − credited, computed by Postgres. Never a stored column:
     *  a `paid` flag drifts the first time a payment is corrected. */
    outstanding: Decimal,
  })
  .openapi("InvoiceBalance");

const RecordPaymentRequest = z
  .object({
    amount: Decimal,
    receivedOn: z.string(),
    method: z.enum(PAYMENT_METHOD_VALUES),
    reference: z.string().max(200).optional(),
    note: z.string().max(2000).optional(),
  })
  .openapi("RecordPaymentRequest");

const IssueCreditNoteRequest = z
  .object({
    amount: Decimal,
    reason: z.enum(CREDIT_REASON_VALUES),
    note: z.string().max(2000).optional(),
    issuedOn: z.string().optional(),
  })
  .openapi("IssueCreditNoteRequest");

const recordPaymentRoute = createRoute({
  method: "post",
  path: "/api/v1/invoices/{invoiceId}/payments",
  tags: ["invoices"],
  summary: "Record that money arrived",
  description:
    "Only against an ISSUED invoice. The amount is SIGNED: a bounced cheque is a negative " +
    "payment with its own date, not the original row edited away. Overpayment is allowed — a " +
    "client settling two invoices with one transfer is a real thing, and the balance simply " +
    "goes negative.",
  request: {
    params: z.object({ invoiceId: z.string().uuid() }),
    body: { content: { "application/json": { schema: RecordPaymentRequest } }, required: true },
  },
  responses: {
    201: { description: "Recorded", content: { "application/json": { schema: PaymentSchema } } },
    400: errorResponse("Bad amount, method or date"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such invoice at this firm"),
    409: errorResponse("The invoice is not issued — a draft owes nothing, a cancelled one is a refund"),
  },
});

const listPaymentsRoute = createRoute({
  method: "get",
  path: "/api/v1/invoices/{invoiceId}/payments",
  tags: ["invoices"],
  summary: "What has been received against this invoice",
  request: { params: z.object({ invoiceId: z.string().uuid() }) },
  responses: {
    200: {
      description: "Payments",
      content: { "application/json": { schema: z.object({ payments: z.array(PaymentSchema) }) } },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const creditNoteRoute = createRoute({
  method: "post",
  path: "/api/v1/invoices/{invoiceId}/credit-notes",
  tags: ["invoices"],
  summary: "Take money off an invoice, with a reason",
  description:
    "Its own document with its own gapless series. The reason is mandatory and closed — " +
    "without it revenue leakage is invisible, because the numbers always reconcile and why " +
    "does not. A firm cannot credit more than it billed.",
  request: {
    params: z.object({ invoiceId: z.string().uuid() }),
    body: { content: { "application/json": { schema: IssueCreditNoteRequest } }, required: true },
  },
  responses: {
    201: { description: "Issued", content: { "application/json": { schema: CreditNoteSchema } } },
    400: errorResponse("Bad amount, or not one of the credit reasons"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such invoice at this firm"),
    409: errorResponse("The invoice is not issued, or this would credit more than was billed"),
  },
});

const listCreditNotesRoute = createRoute({
  method: "get",
  path: "/api/v1/invoices/{invoiceId}/credit-notes",
  tags: ["invoices"],
  summary: "What has been credited against this invoice",
  request: { params: z.object({ invoiceId: z.string().uuid() }) },
  responses: {
    200: {
      description: "Credit notes",
      content: {
        "application/json": { schema: z.object({ creditNotes: z.array(CreditNoteSchema) }) },
      },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const balanceRoute = createRoute({
  method: "get",
  path: "/api/v1/invoices/{invoiceId}/balance",
  tags: ["invoices"],
  summary: "What this invoice still owes",
  request: { params: z.object({ invoiceId: z.string().uuid() }) },
  responses: {
    200: { description: "The balance", content: { "application/json": { schema: BalanceSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such invoice at this firm"),
  },
});

const outstandingRoute = createRoute({
  method: "get",
  path: "/api/v1/receivables",
  tags: ["invoices"],
  summary: "Who owes the firm money",
  description:
    "Issued invoices with something still outstanding. Drafts owe nothing because nobody has " +
    "been asked; cancelled ones were withdrawn.",
  responses: {
    200: {
      description: "Receivables",
      content: { "application/json": { schema: z.object({ receivables: z.array(BalanceSchema) }) } },
    },
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
          documentType: r.documentType,
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
  app.openapi(recordPaymentRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const payment = await deps.service.recordPayment(
      { tenantId: s.tenantId, invoiceId: c.req.valid("param").invoiceId, ...c.req.valid("json") },
      s.actor,
    );
    return c.json(toPaymentBody(payment), 201);
  });

  app.openapi(listPaymentsRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const payments = await deps.service.listPayments(s.tenantId, c.req.valid("param").invoiceId);
    return c.json({ payments: payments.map(toPaymentBody) }, 200);
  });

  app.openapi(creditNoteRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const credit = await deps.service.issueCreditNote(
      { tenantId: s.tenantId, invoiceId: c.req.valid("param").invoiceId, ...c.req.valid("json") },
      s.actor,
    );
    return c.json(toCreditNoteBody(credit), 201);
  });

  app.openapi(listCreditNotesRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const notes = await deps.service.listCreditNotes(s.tenantId, c.req.valid("param").invoiceId);
    return c.json({ creditNotes: notes.map(toCreditNoteBody) }, 200);
  });

  app.openapi(balanceRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const balance = await deps.service.balanceOf(s.tenantId, c.req.valid("param").invoiceId);
    return c.json(toBalanceBody(balance), 200);
  });

  app.openapi(outstandingRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const receivables = await deps.service.outstanding(s.tenantId);
    return c.json({ receivables: receivables.map(toBalanceBody) }, 200);
  });
}

function toPaymentBody(p: Payment): z.infer<typeof PaymentSchema> {
  return {
    id: p.id,
    invoiceId: p.invoiceId,
    amount: p.amount,
    currency: p.currency,
    receivedOn: p.receivedOn,
    method: p.method,
    reference: p.reference,
    note: p.note,
  };
}

function toCreditNoteBody(c: CreditNote): z.infer<typeof CreditNoteSchema> {
  return {
    id: c.id,
    invoiceId: c.invoiceId,
    entityPartyId: c.entityPartyId,
    number: c.number,
    financialYear: c.financialYear,
    sequenceNumber: c.sequenceNumber,
    amount: c.amount,
    currency: c.currency,
    issuedOn: c.issuedOn,
    reason: c.reason,
    note: c.note,
  };
}

function toBalanceBody(b: InvoiceBalance): z.infer<typeof BalanceSchema> {
  return {
    invoiceId: b.invoiceId,
    partyId: b.partyId,
    status: b.status,
    currency: b.currency,
    dueOn: b.dueOn,
    invoiced: b.invoiced,
    paid: b.paid,
    credited: b.credited,
    outstanding: b.outstanding,
  };
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
