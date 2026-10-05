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
import type { DunningService } from "../../usecase/dunning/service";
import type { DunningActionRecord } from "../../usecase/invoice/ports";
import type {
  CreditNote,
  Invoice,
  InvoiceBalance,
  InvoiceTotals,
  Payment,
} from "../../domain/invoice/model";
import {
  CREDIT_REASONS,
  financialYearLabel,
  financialYearLabelOfNumber,
  INVOICE_STATUSES,
  PAYMENT_METHODS,
} from "../../domain/invoice/model";
import { DUNNING_ACTIONS } from "../../domain/config/model";
import type { BankAccountView, InvoiceSummary, InvoiceView } from "../../usecase/invoice/ports";
import type { CompanyInvoicingService } from "../../usecase/invoice/company";
import { INDIAN_STATES, TAX_TREATMENTS, stateByCode } from "../../domain/invoice/gst";
import type { AuthzService } from "../../usecase/authz/service";
import type { Principal } from "../../platform/callctx";

export interface InvoiceDeps {
  readonly service: InvoiceService;
  /**
   * For the FEE AXIS only. Gate 3 is middleware; nothing here re-checks a
   * permission.
   *
   * An invoice is money end to end, so this matters more here than anywhere
   * else in the product: a delivery colleague needs to see that a client was
   * billed for the work they did, and the firm's rule is that they do not see
   * what it was worth. Redacted rather than refused — "you may not see this"
   * and "there is no invoice" are different answers a person acts on
   * differently.
   */
  readonly authz: AuthzService;
  /** Chasing is its own use case: invoicing answers what a client owes, this
   *  answers what the firm will do about it. They meet at one query. */
  readonly dunning: DunningService;
  /** A company's bank accounts and LUTs (Q056, 0369). */
  readonly companies: CompanyInvoicingService;
}

const TREATMENT_VALUES = [...TAX_TREATMENTS] as [string, ...string[]];

const STATUS_VALUES = [...INVOICE_STATUSES] as [string, ...string[]];
const PAYMENT_METHOD_VALUES = [...PAYMENT_METHODS] as [string, ...string[]];
const CREDIT_REASON_VALUES = [...CREDIT_REASONS] as [string, ...string[]];
const DUNNING_ACTION_VALUES = [...DUNNING_ACTIONS] as [string, ...string[]];

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
    number: z.string().nullable().openapi({
      description:
        "`INV/2026-27/0001`. Drawn from a gapless per-entity series when the invoice is ISSUED " +
        "(0322) and frozen by a trigger from then: an invoice number is never edited. NULL on a " +
        "draft (show it as a draft), and on a draft cancelled before it was issued. Drafts made " +
        "before 0322 keep the number they drew. A wrong issued invoice is cancelled and a new " +
        "one issued, and both stay readable.",
    }),
    financialYear: z.number().int().openapi({
      description:
        "The financial year whose series the number was drawn from. On a draft it is provisional: " +
        "issuing takes the year of the issue date, in the firm's own financial year (B03).",
    }),
    financialYearLabel: z.string().nullable().openapi({
      description:
        "The year as the number spells it, read off the number: `2026-27`, or `2027` for a company " +
        "whose year starts in January (0337). Null on a draft. Show this, never a label worked " +
        "out from financialYear.",
    }),
    sequenceNumber: z.number().int().nullable(),
    status: z.enum(STATUS_VALUES),
    currency: z.string().length(3),
    /** NULL for somebody without commercial visibility — the fee axis. Not an
     *  error and not zero: the record is shown, the money is not. */
    fxRate: Decimal.nullable(),
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
    managerUserId: z.string().uuid().nullable().openapi({
      description: "Whose revenue this invoice is (0318); frozen once issued. Null when nobody was named.",
    }),
    tax: z
      .object({
        treatment: z.enum(TREATMENT_VALUES).nullable().openapi({
          description:
            "Which taxes it charges (Q056, 0370): `plain` (one tax figure: a company outside India, or an " +
            "Indian company with no GSTIN), `gst_intra` (CGST + SGST), `gst_intra_ut` (CGST + UTGST), " +
            "`gst_inter` (IGST), `gst_export_lut` (zero-rated under an LUT), `gst_export_igst` (IGST on an " +
            "export). Null: an invoice from before 0370, or a draft whose place of supply cannot be read " +
            "yet (see issueBlocked). On a draft it follows the client and the company; frozen at issue.",
        }),
        supplierGstin: z.string().nullable(),
        supplierStateCode: z.string().nullable(),
        recipientGstin: z.string().nullable(),
        placeOfSupply: z
          .object({
            stateCode: z.string().nullable(),
            stateName: z.string().nullable(),
            country: z.string().nullable().openapi({ description: "Outside India: the client's country." }),
          })
          .nullable()
          .openapi({ description: "Where the service is supplied (IGST Act s.12/13). Null on a plain invoice." }),
        chosenPlaceOfSupply: z.string().nullable().openapi({
          description: "A state a person chose on the draft (PUT /place-of-supply); null follows the client.",
        }),
        reverseCharge: z.boolean().openapi({
          description: "Whether tax is payable on reverse charge (Rule 46(o)). Always false for a firm's fees today.",
        }),
        tds: z
          .object({ section: z.string(), percent: Decimal })
          .nullable()
          .openapi({
            description:
              "Q057: the TDS the client deducts, as it stood when the draft was read or the invoice issued. A " +
              "RATE, not redacted.",
          }),
      })
      .openapi("InvoiceTax"),
  })
  .openapi("Invoice");

const TotalsSchema = z
  .object({
    /** Never redacted: a COUNT of lines is a fact about the work, not a
     *  price, and it is what tells an empty draft from a zero total. */
    lineCount: z.number().int(),
    gross: Decimal.nullable(),
    discount: Decimal.nullable(),
    net: Decimal.nullable(),
    tax: Decimal.nullable(),
    /** What the client owes: net of discount, plus tax. Computed by Postgres in
     *  `numeric` from a view — never a stored column, which would drift from
     *  the lines the first time one moved. */
    total: Decimal.nullable(),
    currency: z.string().length(3),
    cgst: Decimal.nullable(),
    sgst: Decimal.nullable(),
    utgst: Decimal.nullable(),
    igst: Decimal.nullable(),
    tds: Decimal.nullable().openapi({
      description:
        "Q057: what the client is expected to deduct, the TDS rate on `net` (the amount before tax, CBDT " +
        "Circular 23/2017). \"0\" when the client deducts none. The receivable stays `total`.",
    }),
    netPayable: Decimal.nullable().openapi({ description: "`total` less `tds`: what the client remits." }),
  })
  .openapi("InvoiceTotals");

const InvoiceLineSchema = z
  .object({
    id: z.string().uuid(),
    engagementId: z.string().uuid().nullable(),
    description: z.string(),
    position: z.number().int(),
    /** NOT redacted. What the firm did, and how much of it, is the work — and
     *  somebody delivering it needs the quantity even when they may not see
     *  what it was billed at. */
    quantity: Decimal,
    unitAmount: Decimal.nullable(),
    currency: z.string().length(3),
    discountPercent: Decimal.nullable(),
    /** The RATE is not redacted; the amount it produced is. A tax rate is a
     *  statutory fact about the service, not a price. */
    taxPercent: Decimal,
    net: Decimal.nullable(),
    tax: Decimal.nullable(),
    sac: z.string().nullable().openapi({ description: "The service's SAC (Q056); not a price, never redacted." }),
    cgst: Decimal.nullable(),
    sgst: Decimal.nullable(),
    utgst: Decimal.nullable(),
    igst: Decimal.nullable(),
  })
  .openapi("InvoiceLine");

/** A bank account's fields, unnamed: the record's nullable copy is inlined
 *  from this, because `.nullable()` on the NAMED schema makes the shared
 *  component itself nullable (and every array of it a list of maybe-nulls). */
const BankAccountFields = z.object({
  id: z.string().uuid(),
  accountName: z.string(),
  accountNumber: z.string(),
  bankName: z.string(),
  branch: z.string().nullable(),
  ifsc: z.string().nullable(),
  swift: z.string().nullable(),
  iban: z.string().nullable(),
  currency: z.string().nullable().openapi({ description: "The invoice currency it is for; null: the general account." }),
});

const BankAccountSchema = BankAccountFields.openapi("CompanyBankAccount");

const PartyRefSchema = z.object({ id: z.string().uuid(), displayName: z.string() });

const InvoiceRecordSchema = z
  .object({
    invoice: InvoiceSchema,
    party: PartyRefSchema,
    /** The issuing entity by NAME — an invoice prints a letterhead. */
    entity: PartyRefSchema,
    lines: z.array(InvoiceLineSchema),
    totals: TotalsSchema,
    manager: z
      .object({ userId: z.string().uuid(), displayName: z.string().nullable(), email: z.string() })
      .nullable(),
    letters: z.array(z.object({ id: z.string().uuid(), ref: z.string() })).openapi({
      description: "The engagement letters this invoice's lines bill, by reference (0318).",
    }),
    taxSuggestions: z
      .object({
        companyDefault: Decimal.nullable(),
        byEngagement: z.array(z.object({ engagementId: z.string().uuid(), taxPercent: Decimal })),
      })
      .openapi({
        description:
          "The tax rate a line added by hand starts at (CA#5), by the automatic advance's rule: the " +
          "rate last invoiced on that engagement, else the issuing company's default tax rate (Your " +
          "firm), else none. A tax rate is a statutory fact, not a price: never redacted.",
      }),
    lut: z
      .object({ id: z.string().uuid(), reference: z.string(), financialYear: z.number().int() })
      .nullable()
      .openapi({ description: "The LUT an export under one names (Q056)." }),
    /** Where the client pays: the issuing company's account for this
     *  currency, else its general one. */
    bankAccount: BankAccountFields.nullable(),
    issueBlocked: z
      .object({
        reason: z.enum(["INVOICE_NUMBER_OUT_OF_ORDER", "PLACE_OF_SUPPLY_UNKNOWN", "INVOICE_LINE_NEEDS_SAC"]),
        message: z.string(),
      })
      .nullable()
      .openapi({
        description:
          "Why Issue would be refused today, when the record alone shows it (B51): a draft numbered " +
          "before 0322 whose number is now out of order in its series (a later number of the series " +
          "has been issued, or today is in another financial year); or, on a GST invoice (Q056), a place " +
          "of supply that cannot be read or a line with no SAC. `message` is the refusal's own " +
          "sentence, for the screen to show where Issue is offered. Null when nothing on the record " +
          "stops it; the issue call still decides.",
      }),
    issuesOn: z.string().nullable().openapi({
      description:
        "The day Issue would date this draft today: today on its issuing company's calendar, else " +
        "the firm's (0337). What a confirmation says before Issue. Null once it is out of draft.",
    }),
  })
  .openapi("InvoiceRecord");

const BalanceOnListSchema = z
  .object({
    paid: Decimal,
    credited: Decimal,
    outstanding: Decimal,
    tds: Decimal.openapi({ description: "TDS the client deducted (Q057): settles like money, is not money." }),
  })
  .openapi("InvoiceListBalance");

const InvoiceSummarySchema = z
  .object({
    invoice: InvoiceSchema,
    party: PartyRefSchema,
    totals: TotalsSchema,
    balance: BalanceOnListSchema.nullable().openapi({
      description:
        "What is still owed, from the same view /receivables reads. On the LIST because " +
        "`status` is about the document and says nothing about money: walked, a fully-settled " +
        "invoice sat beside one 75 days overdue, both reading `issued` and both showing their " +
        "full value. NULL on a draft — nobody has been asked yet, and a zero outstanding there " +
        "would read as settled. Redacted with every other figure for a caller without the fee " +
        "axis.",
    }),
  })
  .openapi("InvoiceSummary");

/**
 * The CALLER's today, for the three writes that stamp one: raising (which
 * year's books, when not stated), issuing (the date on the tax invoice) and a
 * credit note (its date, when not stated). Absent means the FIRM's day — never
 * the server's UTC day, which dated a Delhi invoice issued at 02:00 the day
 * before. Held to the firm's day or one either side: it says what day it is
 * where the caller is, and is not a way to choose a date.
 */
const CallerDayQuery = z.object({
  asOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .openapi({
      description:
        "Today where the caller is (a browser sends its local date). Defaults to the firm's " +
        "day. Must be the firm's day or one either side; a document that belongs to another " +
        "day has its own date field.",
    }),
});

const RaiseInvoiceRequest = z
  .object({
    partyId: z.string().uuid(),
    entityPartyId: z.string().uuid(),
    currency: z.string().length(3),
    fxRate: Decimal.optional().openapi({
      description:
        "How many of the firm's reporting currency one unit of `currency` was worth. REQUIRED when " +
        "`currency` is not the firm's reporting currency (FX_RATE_REQUIRED, 400; it used to default " +
        "to 1, B07); in the reporting currency leave it out (it is 1; anything else is FX_RATE_NOT_ONE).",
    }),
    fxRateDate: z.string().optional().openapi({ description: "The day the rate is from. Defaults to today." }),
    dueOn: z.string().optional(),
    notes: z.string().max(2000).optional(),
    seriesDate: z.string().optional().openapi({
      description:
        "The draft's provisional financial year (defaults to today). It does not decide the " +
        "number: an invoice is numbered in the series of the year it is ISSUED in (B03).",
    }),
    managerUserId: z.string().uuid().nullable().optional().openapi({
      description:
        "Whose revenue this invoice is (auto-invoice T4); null or absent names nobody. Must be " +
        "active staff at this firm (MANAGER_NOT_STAFF, 409). The screen preselects the client's " +
        "Key Manager. Changeable while a draft (PUT /invoices/{id}/manager), fixed once issued.",
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
    taxPercent: Decimal.optional().openapi({
      description: "Absent: the catalogue service's rate for the issuing company's country, else 0.",
    }),
    sac: z.string().optional().openapi({
      description: "The service's SAC (six digits, 99...). Absent: the catalogue service's, else none.",
    }),
  })
  .openapi("AddInvoiceLineRequest");

const SeriesSchema = z
  .object({
    entityPartyId: z.string().uuid(),
    entityName: z.string(),
    financialYear: z.number().int(),
    /** The month its year starts in, fixed when the series started (0337). */
    startMonth: z.number().int().min(1).max(12),
    /** The year as its numbers spell it: `2026-27`, or `2027` for a January year. */
    label: z.string(),
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
  summary: "Raise a draft invoice — it is numbered when it is issued",
  description:
    "A DRAFT, with no number (0322). The number comes from a gapless per-entity, " +
    "per-financial-year series when the invoice is ISSUED, taken under a row lock inside the " +
    "same transaction as the issue, so a draft cancelled before issue spends nothing, and in the " +
    "series of the year the issue date falls in (the firm's financial year, else 1 April).",
  request: {
    query: CallerDayQuery,
    body: { content: { "application/json": { schema: RaiseInvoiceRequest } }, required: true },
  },
  responses: {
    201: { description: "Raised", content: { "application/json": { schema: InvoiceSchema } } },
    400: errorResponse("Bad currency, rate, or date"),
    401: errorResponse("Not signed in"),
    403: errorResponse(
      "No org selected, or the role does not permit it" +
        ", or this login does not see fees (FEES_NOT_VISIBLE)",
    ),
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
  description:
    "An `engagementId` must be the billed client's, and its letter must have been signed by " +
    "the company this invoice is charged by: the number is already in that company's series " +
    "(ENGAGEMENT_OF_ANOTHER_ISSUER, 409). The letter must also be priced in this invoice's " +
    "currency, because the line takes the invoice's (ENGAGEMENT_IN_ANOTHER_CURRENCY, 409).",
  request: {
    params: z.object({ invoiceId: z.string().uuid() }),
    body: { content: { "application/json": { schema: AddInvoiceLineRequest } }, required: true },
  },
  responses: {
    204: { description: "Added" },
    400: errorResponse("Bad quantity, amount, discount or tax rate"),
    401: errorResponse("Not signed in"),
    403: errorResponse(
      "No org selected, or the role does not permit it" +
        ", or this login does not see fees (FEES_NOT_VISIBLE)",
    ),
    404: errorResponse("No such invoice at this firm"),
    409: errorResponse(
      "The invoice has been issued (its lines are fixed), or the engagement's letter was signed " +
        "by another of the firm's companies or priced in another currency",
    ),
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
    403: errorResponse(
      "No org selected, or the role does not permit it" +
        ", or this login does not see fees (FEES_NOT_VISIBLE)",
    ),
    404: errorResponse("No such invoice or line at this firm"),
    409: errorResponse("The invoice has been issued — its lines are fixed"),
  },
});

const issueRoute = createRoute({
  method: "post",
  path: "/api/v1/invoices/{invoiceId}/issue",
  tags: ["invoices"],
  summary: "Issue it",
  description:
    "Refuses an invoice with no lines: it would ask the client for nothing. The date on it is " +
    "the caller's `asOf`, or the firm's day. This is when the number is drawn (0322): the next " +
    "in the draft's series, in the same transaction as the issue. A draft whose due date is before " +
    "the issue date is refused (DUE_BEFORE_ISSUE, 409: change it with PUT /due-date); one with no " +
    "due date takes the firm's payment terms when it has set them (0327), else stays without one. " +
    "A draft numbered before 0322 keeps its number and is refused when that number would go out of " +
    "order (INVOICE_NUMBER_OUT_OF_ORDER, 409, B51): cancel it and raise it again. Q056: its tax is decided " +
    "for the issue date and frozen (CGST + SGST, UTGST, IGST, or zero-rated under the company's LUT); an " +
    "Indian GST invoice is refused while its place of supply cannot be read (PLACE_OF_SUPPLY_UNKNOWN, 409: " +
    "PUT /place-of-supply) or a line has no SAC (INVOICE_LINE_NEEDS_SAC, 409: PUT /lines/{id}/sac, or the " +
    "catalogue service's SAC).",
  request: { params: z.object({ invoiceId: z.string().uuid() }), query: CallerDayQuery },
  responses: {
    200: { description: "Issued", content: { "application/json": { schema: InvoiceSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such invoice at this firm"),
    400: errorResponse("asOf is not today anywhere"),
    409: errorResponse(
      "Not a draft, it has no lines, its due date is before today's issue date, its number " +
        "(drawn before 0322) would go out of order, or (a GST invoice) no place of supply or a line without a SAC",
    ),
  },
});

const cancelRoute = createRoute({
  method: "post",
  path: "/api/v1/invoices/{invoiceId}/cancel",
  tags: ["invoices"],
  summary: "Withdraw it",
  description:
    "An issued invoice's number is NOT released and the row is not removed — that is what " +
    "makes the series consecutive. A cancelled invoice stays in the sequence saying it was " +
    "cancelled, which is exactly what an auditor needs to see where a number went. A draft has " +
    "no number yet (0322), so cancelling one spends nothing.",
  request: { params: z.object({ invoiceId: z.string().uuid() }) },
  responses: {
    200: { description: "Cancelled", content: { "application/json": { schema: InvoiceSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such invoice at this firm"),
    409: errorResponse("Already cancelled"),
  },
});

const setManagerRoute = createRoute({
  method: "put",
  path: "/api/v1/invoices/{invoiceId}/manager",
  tags: ["invoices"],
  summary: "Put a draft in another manager's revenue (or nobody's)",
  description:
    "Drafts only. Once issued, whose revenue it is is fixed " +
    "(INVOICE_MANAGER_FROZEN, 409, and 0318's trigger). The manager must be active staff at this " +
    "firm (MANAGER_NOT_STAFF, 409). Writes `invoice.manager_set` when it changes.",
  request: {
    params: z.object({ invoiceId: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({ managerUserId: z.string().uuid().nullable() })
            .openapi("SetInvoiceManagerRequest"),
        },
      },
      required: true,
    },
  },
  responses: {
    200: { description: "Saved", content: { "application/json": { schema: InvoiceSchema } } },
    400: errorResponse("Not a user id"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such invoice at this firm"),
    409: errorResponse("The invoice is no longer a draft, or the person is not active staff here"),
  },
});

const setDueDateRoute = createRoute({
  method: "put",
  path: "/api/v1/invoices/{invoiceId}/due-date",
  tags: ["invoices"],
  summary: "Set, change or clear a draft's due date",
  description:
    "Drafts only (INVOICE_NOT_EDITABLE, 409, once issued: the due date is what was sent). Today or " +
    "later (DUE_DATE_IN_THE_PAST, 400); null clears it. A draft whose due date has passed by the " +
    "time it is issued is refused at issue (DUE_BEFORE_ISSUE), so this is how it is fixed. Writes " +
    "`invoice.due_date_set` when it changes (audit 2026-10-03, B20/B21).",
  request: {
    params: z.object({ invoiceId: z.string().uuid() }),
    query: CallerDayQuery,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({ dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() })
            .openapi("SetInvoiceDueDateRequest"),
        },
      },
      required: true,
    },
  },
  responses: {
    200: { description: "Saved", content: { "application/json": { schema: InvoiceSchema } } },
    400: errorResponse("Not a day, or a day already past"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such invoice at this firm"),
    409: errorResponse("The invoice is no longer a draft"),
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
     *  something that never happened. Null under the fee axis. */
    amount: Decimal.nullable(),
    currency: z.string().length(3),
    receivedOn: z.string(),
    method: z.enum(PAYMENT_METHOD_VALUES),
    reference: z.string().nullable(),
    note: z.string().nullable(),
    tdsAmount: Decimal.nullable().openapi({
      description: "Q057: the TDS the client deducted from this remittance; \"0\" for none. Signed like amount.",
    }),
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
    amount: Decimal.nullable(),
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
    /** All four are NULL for somebody without commercial visibility — the fee
     *  axis. An invoice is money end to end, so this is where the axis matters
     *  most: a delivery colleague sees that the client was billed for the work
     *  they did, and not what it was worth. */
    invoiced: Decimal.nullable(),
    paid: Decimal.nullable(),
    credited: Decimal.nullable(),
    /** invoiced − paid − credited, computed by Postgres, for an ISSUED invoice;
     *  0 for a draft or a cancelled one (0326, B22). Never a stored column:
     *  a `paid` flag drifts the first time a payment is corrected. */
    outstanding: Decimal.nullable(),
    tds: Decimal.nullable().openapi({
      description:
        "Q057: TDS the client deducted. Outstanding is invoiced − paid − tds − credited: an invoice is " +
        "settled when the money and the TDS together cover it.",
    }),
  })
  .openapi("InvoiceBalance");

const RecordPaymentRequest = z
  .object({
    amount: Decimal,
    receivedOn: z.string(),
    method: z.enum(PAYMENT_METHOD_VALUES),
    reference: z.string().max(200).optional(),
    note: z.string().max(2000).optional(),
    tdsAmount: Decimal.optional().openapi({
      description:
        "Q057: the TDS the client deducted from this remittance, recorded beside the money. The amount may be " +
        "\"0\" when only TDS is recorded. Signed: a negative undoes TDS recorded by mistake.",
    }),
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
    403: errorResponse(
      "No org selected, or the role does not permit it" +
        ", or this login does not see fees (FEES_NOT_VISIBLE)",
    ),
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
    "does not. A firm cannot credit more than it billed. `issuedOn` (default today) must be on " +
    "or after the invoice's issue date and not after today (CREDIT_NOTE_DATE_OUT_OF_RANGE, 400); " +
    "it is numbered in the series of its own date's year.",
  request: {
    params: z.object({ invoiceId: z.string().uuid() }),
    query: CallerDayQuery,
    body: { content: { "application/json": { schema: IssueCreditNoteRequest } }, required: true },
  },
  responses: {
    201: { description: "Issued", content: { "application/json": { schema: CreditNoteSchema } } },
    400: errorResponse("Bad amount, or not one of the credit reasons"),
    401: errorResponse("Not signed in"),
    403: errorResponse(
      "No org selected, or the role does not permit it" +
        ", or this login does not see fees (FEES_NOT_VISIBLE)",
    ),
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

/** A debt with the two facts a person needs to act on it. The join is the
 *  API's, not the browser's — a collections screen must not fetch a party per
 *  row to render a list of who owes money. */
const ReceivableSchema = z
  .object({
    balance: BalanceSchema,
    number: z.string(),
    party: z.object({ id: z.string().uuid(), displayName: z.string() }),
  })
  .openapi("Receivable");

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
      content: { "application/json": { schema: z.object({ receivables: z.array(ReceivableSchema) }) } },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

// ── The GST tax invoice (Q056, Q057) ───────────────────────────────────────

const setPlaceOfSupplyRoute = createRoute({
  method: "put",
  path: "/api/v1/invoices/{invoiceId}/place-of-supply",
  tags: ["invoices"],
  summary: "Choose a draft's GST place of supply, or go back to the client's",
  description:
    "Drafts only. A GST state code over the one the client's GSTIN or address gives (a client registered " +
    "in several states, or an address whose state cannot be read); null follows the client again. The " +
    "tax is decided again at once (CGST + SGST within the issuing company's state, IGST otherwise). " +
    "Writes `invoice.place_of_supply_set`.",
  request: {
    params: z.object({ invoiceId: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ stateCode: z.string().regex(/^\d{2}$/).nullable() }).openapi("SetPlaceOfSupplyRequest"),
        },
      },
      required: true,
    },
  },
  responses: {
    200: { description: "Saved", content: { "application/json": { schema: InvoiceSchema } } },
    400: errorResponse("Not a GST state code (INVALID_PLACE_OF_SUPPLY)"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such invoice at this firm"),
    409: errorResponse("The invoice is no longer a draft"),
  },
});

const setLineSacRoute = createRoute({
  method: "put",
  path: "/api/v1/invoices/{invoiceId}/lines/{lineId}/sac",
  tags: ["invoices"],
  summary: "Set or clear a draft line's SAC",
  description:
    "Drafts only. Six digits starting 99 (INVALID_SAC, 400). A GST invoice is refused at issue while a line " +
    "has none (INVOICE_LINE_NEEDS_SAC); a line billing a catalogued service takes the service's SAC " +
    "without this. Writes `invoice.line_sac_set`.",
  request: {
    params: z.object({ invoiceId: z.string().uuid(), lineId: z.string().uuid() }),
    body: {
      content: {
        "application/json": { schema: z.object({ sac: z.string().nullable() }).openapi("SetLineSacRequest") },
      },
      required: true,
    },
  },
  responses: {
    204: { description: "Saved" },
    400: errorResponse("Not a SAC"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such invoice or line at this firm"),
    409: errorResponse("The invoice is no longer a draft"),
  },
});

const ClientTdsSchema = z
  .object({ section: z.string(), percent: Decimal })
  .nullable()
  .openapi("ClientTds");

const getClientTdsRoute = createRoute({
  method: "get",
  path: "/api/v1/clients/{partyId}/tds",
  tags: ["invoices"],
  summary: "The TDS a client deducts on the firm's fees",
  request: { params: z.object({ partyId: z.string().uuid() }) },
  responses: {
    200: {
      description: "Its setting; `tds` null when it deducts none",
      content: { "application/json": { schema: z.object({ tds: ClientTdsSchema }) } },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const setClientTdsRoute = createRoute({
  method: "put",
  path: "/api/v1/clients/{partyId}/tds",
  tags: ["invoices"],
  summary: "Set, change or stop the TDS a client deducts",
  description:
    "Q057. A section as the Act writes it (194J, 194JB, 194C, 195) and a rate above 0, up to 100 " +
    "(INVALID_TDS, 400); null stops it. Its invoices then print \"Less: TDS u/s 194J @10% (on the amount " +
    "before tax)\" and the net payable. Drafts take it when next read; issued invoices keep theirs. " +
    "Writes `client.tds_set`.",
  request: {
    params: z.object({ partyId: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({ tds: z.object({ section: z.string().max(12), percent: Decimal }).nullable() })
            .openapi("SetClientTdsRequest"),
        },
      },
      required: true,
    },
  },
  responses: {
    200: { description: "Saved", content: { "application/json": { schema: z.object({ tds: ClientTdsSchema }) } } },
    400: errorResponse("Not a TDS section or rate, or one of the firm's own companies"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such client at this firm"),
  },
});

const statesRoute = createRoute({
  method: "get",
  path: "/api/v1/invoicing/states",
  tags: ["invoices"],
  summary: "India's GST states and union territories, by state code",
  description: "For a place-of-supply or address picker. The code is a GSTIN's first two digits.",
  responses: {
    200: {
      description: "States",
      content: {
        "application/json": {
          schema: z.object({
            states: z.array(z.object({ code: z.string(), name: z.string(), utgst: z.boolean() })),
          }),
        },
      },
    },
    401: errorResponse("Not signed in"),
  },
});

const CompanyInvoicingSchema = z
  .object({
    entityPartyId: z.string().uuid(),
    name: z.string(),
    country: z.string().nullable(),
    gstin: z.string().nullable().openapi({
      description: "Its GSTIN in force today. An Indian company without one issues plain invoices, not GST ones.",
    }),
    bankAccounts: z.array(BankAccountSchema),
    luts: z.array(
      z.object({
        id: z.string().uuid(),
        financialYear: z.number().int(),
        financialYearLabel: z.string(),
        reference: z.string(),
        filedOn: z.string().nullable(),
      }),
    ),
  })
  .openapi("CompanyInvoicing");

const listCompaniesRoute = createRoute({
  method: "get",
  path: "/api/v1/invoicing/companies",
  tags: ["invoices"],
  summary: "The firm's companies, with the bank accounts and LUTs their invoices print",
  responses: {
    200: {
      description: "Companies",
      content: { "application/json": { schema: z.object({ companies: z.array(CompanyInvoicingSchema) }) } },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const addBankAccountRoute = createRoute({
  method: "post",
  path: "/api/v1/firm-entities/{entityPartyId}/bank-accounts",
  tags: ["invoices"],
  summary: "Add where a company is paid, or correct it",
  description:
    "Q056, 0369. Written once: the company's live account for the same `currency` (or its general one, " +
    "for null) is retired in the same write, and invoices issued with it still print it. An invoice prints " +
    "the account for its currency, else the general one. Writes `firm_entity.bank_account_added`.",
  request: {
    params: z.object({ entityPartyId: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              accountName: z.string().max(200),
              accountNumber: z.string().max(40),
              bankName: z.string().max(200),
              branch: z.string().max(200).nullable().optional(),
              ifsc: z.string().max(11).nullable().optional(),
              swift: z.string().max(11).nullable().optional(),
              iban: z.string().max(40).nullable().optional(),
              currency: z.string().length(3).nullable().optional(),
            })
            .openapi("AddBankAccountRequest"),
        },
      },
      required: true,
    },
  },
  responses: {
    201: { description: "Added", content: { "application/json": { schema: z.object({ id: z.string().uuid() }) } } },
    400: errorResponse("A field is not in the shape a bank writes it (INVALID_COMPANY_INVOICING), or not one of the firm's companies"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const retireBankAccountRoute = createRoute({
  method: "post",
  path: "/api/v1/firm-entities/{entityPartyId}/bank-accounts/{accountId}/retire",
  tags: ["invoices"],
  summary: "Take a bank account off a company's invoices",
  request: { params: z.object({ entityPartyId: z.string().uuid(), accountId: z.string().uuid() }) },
  responses: {
    204: { description: "Retired" },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No live account with that id on this company"),
  },
});

const addLutRoute = createRoute({
  method: "post",
  path: "/api/v1/firm-entities/{entityPartyId}/luts",
  tags: ["invoices"],
  summary: "Record a company's Letter of Undertaking for a financial year",
  description:
    "Q056, 0369. With one in force for the issue date's year, an Indian company's invoice to a client " +
    "outside India is zero-rated and prints \"Supply meant for export under LUT without payment of IGST\" " +
    "with this reference; without one, IGST is charged. Replaces the LUT for the same year. " +
    "`financialYear` is the year it starts in (2026 = 2026-27). Writes `firm_entity.lut_recorded`.",
  request: {
    params: z.object({ entityPartyId: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              financialYear: z.number().int(),
              reference: z.string().max(30),
              filedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
            })
            .openapi("AddLutRequest"),
        },
      },
      required: true,
    },
  },
  responses: {
    201: { description: "Recorded", content: { "application/json": { schema: z.object({ id: z.string().uuid() }) } } },
    400: errorResponse("Not a year or an ARN (INVALID_COMPANY_INVOICING), or not one of the firm's companies"),
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const retireLutRoute = createRoute({
  method: "post",
  path: "/api/v1/firm-entities/{entityPartyId}/luts/{lutId}/retire",
  tags: ["invoices"],
  summary: "Take an LUT off a company",
  request: { params: z.object({ entityPartyId: z.string().uuid(), lutId: z.string().uuid() }) },
  responses: {
    204: { description: "Retired" },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No live LUT with that id on this company"),
  },
});

// ── The dunning ladder (T3.5) ──────────────────────────────────────────────

const DunningActionSchema = z
  .object({
    id: z.string().uuid(),
    invoiceId: z.string().uuid(),
    /** The rung's own key as the ladder named it — never an index, which would
     *  shift when a firm inserts a rung and silently rename history. */
    step: z.string(),
    afterDays: z.number().int(),
    action: z.enum(DUNNING_ACTION_VALUES),
    state: z.enum(["taken", "pending_approval", "approved", "rejected"]),
    approvedBy: z.string().uuid().nullable(),
    decidedAt: z.string().nullable(),
    note: z.string().nullable(),
  })
  .openapi("DunningAction");

/** A terminal rung, and what a partner needs in order to decide it: the client,
 *  the invoice number, and what is ACTUALLY still owed — read now, because a
 *  debt settled since the rung fired is precisely the case somebody rejects. */
const PendingDunningSchema = z
  .object({
    action: DunningActionSchema,
    invoiceNumber: z.string(),
    party: z.object({ id: z.string().uuid(), displayName: z.string() }),
    outstanding: Decimal.nullable(),
    currency: z.string().length(3),
    dueOn: z.string().nullable(),
    invoiceStatus: z.enum(STATUS_VALUES).openapi({
      description:
        "The invoice as it stands now. A step on an invoice cancelled since (outstanding 0) can " +
        "only be rejected (DUNNING_NOTHING_OWED, 409, on approve).",
    }),
  })
  .openapi("PendingDunningAction");

const pendingDunningRoute = createRoute({
  method: "get",
  path: "/api/v1/dunning/pending",
  tags: ["invoices"],
  summary: "Terminal dunning steps waiting for a partner",
  description:
    "Credit hold and legal action are the two rungs a machine may REACH and may not APPLY — " +
    "they are the things a firm cannot take back with an apology. The worker climbs to them " +
    "and stops; this is the queue somebody works.",
  responses: {
    200: {
      description: "Waiting for a decision",
      content: {
        "application/json": { schema: z.object({ actions: z.array(PendingDunningSchema) }) },
      },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const invoiceDunningRoute = createRoute({
  method: "get",
  path: "/api/v1/invoices/{invoiceId}/dunning",
  tags: ["invoices"],
  summary: "How far this receivable has been chased",
  request: { params: z.object({ invoiceId: z.string().uuid() }) },
  responses: {
    200: {
      description: "The ladder as climbed",
      content: {
        "application/json": { schema: z.object({ actions: z.array(DunningActionSchema) }) },
      },
    },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
  },
});

const decideDunningRoute = createRoute({
  method: "post",
  path: "/api/v1/dunning/{actionId}/decide",
  tags: ["invoices"],
  summary: "Approve or reject a terminal dunning step",
  description:
    "BOTH outcomes are recorded. 'We considered legal action and decided against it' is a fact " +
    "somebody wants three months later, and a rejection that vanished would leave the ladder " +
    "looking as though it never got there. A decision is final.",
  request: {
    params: z.object({ actionId: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ approve: z.boolean(), note: z.string().max(2000).optional() }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: { description: "Decided", content: { "application/json": { schema: DunningActionSchema } } },
    401: errorResponse("Not signed in"),
    403: errorResponse("No org selected, or the role does not permit it"),
    404: errorResponse("No such dunning action at this firm"),
    409: errorResponse(
      "Not awaiting approval, already decided, or (approving) the invoice was cancelled or is paid " +
        "in full since the step fired (DUNNING_NOTHING_OWED): reject it instead",
    ),
  },
});

export function registerInvoiceRoutes(app: OpenAPIHono<AppEnv>, deps: InvoiceDeps): void {
  /** The fee axis, read once per request from the resolved principal. Gate 3
   *  has already run; this only decides what is REDACTED, never what is
   *  allowed. */
  const seesFees = (principal: Principal | null): boolean =>
    principal !== null && deps.authz.seesFees(principal);
  /**
   * B27 (audit 2026-10-03): a route that WRITES an amount refuses a login that
   * cannot see fees, before the use case is asked. Seeing a figure and setting
   * one are one question; the billing desk already refused a changed price to
   * the same login (PRICE_NOT_VISIBLE).
   */
  const requireFees = (principal: Principal | null, what: string): void => {
    if (principal !== null) deps.authz.requireFees(principal, what);
  };

  app.openapi(raiseRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    requireFees(c.get("principal"), "raise an invoice by hand");
    const { managerUserId, ...body } = c.req.valid("json");
    const raised = await deps.service.raise(
      {
        tenantId: s.tenantId,
        ...body,
        managerUserId: managerUserId ?? undefined,
        asOf: c.req.valid("query").asOf,
      },
      s.actor,
    );
    return c.json(toInvoiceBody(raised, seesFees(c.get("principal"))), 201);
  });

  app.openapi(listRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const q = c.req.valid("query");
    const invoices = await deps.service.list(s.tenantId, {
      status: q.status as InvoiceSummary["invoice"]["status"] | undefined,
      partyId: q.partyId,
    });
    const fees = seesFees(c.get("principal"));
    return c.json(
      {
        invoices: invoices.map((r) => ({
          invoice: toInvoiceBody(r.invoice, fees),
          party: { id: r.party.id, displayName: r.party.displayName },
          totals: toTotalsBody(r.totals, fees),
          // REDACTED WITH THE REST OF THE MONEY, not refused. Somebody without
          // the fee axis sees which invoices exist and no figures — the rule
          // every other amount on this screen already follows.
          balance:
            r.balance === null || !fees
              ? null
              : {
                  paid: r.balance.paid,
                  credited: r.balance.credited,
                  outstanding: r.balance.outstanding,
                  tds: r.balance.tds,
                },
        })),
      },
      200,
    );
  });

  app.openapi(describeRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    return c.json(
      toRecordBody(
        await deps.service.describe(s.tenantId, c.req.valid("param").invoiceId),
        seesFees(c.get("principal")),
      ),
      200,
    );
  });

  app.openapi(addLineRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    requireFees(c.get("principal"), "change the lines on an invoice");
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
    requireFees(c.get("principal"), "change the lines on an invoice");
    const p = c.req.valid("param");
    await deps.service.removeLine(s.tenantId, p.invoiceId, p.lineId);
    return c.body(null, 204);
  });

  app.openapi(issueRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const issued = await deps.service.issue(
      s.tenantId,
      c.req.valid("param").invoiceId,
      s.actor,
      c.req.valid("query").asOf,
    );
    return c.json(toInvoiceBody(issued, seesFees(c.get("principal"))), 200);
  });

  app.openapi(cancelRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const cancelled = await deps.service.cancel(s.tenantId, c.req.valid("param").invoiceId, s.actor);
    return c.json(toInvoiceBody(cancelled, seesFees(c.get("principal"))), 200);
  });

  app.openapi(setManagerRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const saved = await deps.service.setManager(
      s.tenantId,
      c.req.valid("param").invoiceId,
      c.req.valid("json").managerUserId,
      s.actor,
    );
    return c.json(toInvoiceBody(saved, seesFees(c.get("principal"))), 200);
  });

  app.openapi(setDueDateRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const saved = await deps.service.setDueDate(
      s.tenantId,
      c.req.valid("param").invoiceId,
      c.req.valid("json").dueOn,
      s.actor,
      c.req.valid("query").asOf,
    );
    return c.json(toInvoiceBody(saved, seesFees(c.get("principal"))), 200);
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
    return c.json(toInvoiceBody(saved, seesFees(c.get("principal"))), 200);
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
          startMonth: r.startMonth,
          label: financialYearLabel(r.financialYear, r.startMonth),
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
    requireFees(c.get("principal"), "record a payment");
    const payment = await deps.service.recordPayment(
      { tenantId: s.tenantId, invoiceId: c.req.valid("param").invoiceId, ...c.req.valid("json") },
      s.actor,
    );
    return c.json(toPaymentBody(payment, seesFees(c.get("principal"))), 201);
  });

  app.openapi(listPaymentsRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const payments = await deps.service.listPayments(s.tenantId, c.req.valid("param").invoiceId);
    const fees = seesFees(c.get("principal"));
    return c.json({ payments: payments.map((x) => toPaymentBody(x, fees)) }, 200);
  });

  app.openapi(creditNoteRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    requireFees(c.get("principal"), "issue a credit note");
    const credit = await deps.service.issueCreditNote(
      {
        tenantId: s.tenantId,
        invoiceId: c.req.valid("param").invoiceId,
        ...c.req.valid("json"),
        asOf: c.req.valid("query").asOf,
      },
      s.actor,
    );
    return c.json(toCreditNoteBody(credit, seesFees(c.get("principal"))), 201);
  });

  app.openapi(listCreditNotesRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const notes = await deps.service.listCreditNotes(s.tenantId, c.req.valid("param").invoiceId);
    const fees = seesFees(c.get("principal"));
    return c.json({ creditNotes: notes.map((x) => toCreditNoteBody(x, fees)) }, 200);
  });

  app.openapi(balanceRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const balance = await deps.service.balanceOf(s.tenantId, c.req.valid("param").invoiceId);
    return c.json(toBalanceBody(balance, seesFees(c.get("principal"))), 200);
  });

  app.openapi(outstandingRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const receivables = await deps.service.outstanding(s.tenantId);
    const fees = seesFees(c.get("principal"));
    return c.json(
      {
        receivables: receivables.map((r) => ({
          balance: toBalanceBody(r.balance, fees),
          number: r.number,
          party: { id: r.party.id, displayName: r.party.displayName },
        })),
      },
      200,
    );
  });

  app.openapi(pendingDunningRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const actions = await deps.dunning.pending(s.tenantId);
    const fees = seesFees(c.get("principal"));
    return c.json(
      {
        actions: actions.map((a) => ({
          action: toDunningBody(a.action),
          invoiceNumber: a.invoiceNumber,
          party: { id: a.party.id, displayName: a.party.displayName },
          outstanding: fees ? a.outstanding : null,
          currency: a.currency,
          dueOn: a.dueOn,
          invoiceStatus: a.invoiceStatus,
        })),
      },
      200,
    );
  });

  app.openapi(invoiceDunningRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const actions = await deps.dunning.listFor(s.tenantId, c.req.valid("param").invoiceId);
    return c.json({ actions: actions.map(toDunningBody) }, 200);
  });

  app.openapi(setPlaceOfSupplyRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const saved = await deps.service.setPlaceOfSupply(
      s.tenantId,
      c.req.valid("param").invoiceId,
      c.req.valid("json").stateCode,
      s.actor,
    );
    return c.json(toInvoiceBody(saved, seesFees(c.get("principal"))), 200);
  });

  app.openapi(setLineSacRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const p = c.req.valid("param");
    const sac = c.req.valid("json").sac;
    await deps.service.setLineSac(s.tenantId, p.invoiceId, p.lineId, sac === null || sac.trim() === "" ? null : sac.trim(), s.actor);
    return c.body(null, 204);
  });

  app.openapi(getClientTdsRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const tds = await deps.service.clientTds(s.tenantId, c.req.valid("param").partyId);
    return c.json({ tds: tds === null ? null : { section: tds.section, percent: tds.percent } }, 200);
  });

  app.openapi(setClientTdsRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const tds = await deps.service.setClientTds(
      s.tenantId,
      c.req.valid("param").partyId,
      c.req.valid("json").tds,
      s.actor,
    );
    return c.json({ tds: tds === null ? null : { section: tds.section, percent: tds.percent } }, 200);
  });

  app.openapi(statesRoute, (c) =>
    c.json({ states: INDIAN_STATES.map((st) => ({ code: st.code, name: st.name, utgst: st.utgst })) }, 200),
  );

  app.openapi(listCompaniesRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const companies = await deps.companies.list(s.tenantId);
    return c.json(
      {
        companies: companies.map((co) => ({
          entityPartyId: co.entityPartyId,
          name: co.name,
          country: co.country,
          gstin: co.gstin,
          bankAccounts: co.bankAccounts.map(toBankAccountBody),
          luts: co.luts.map((l) => ({
            id: l.id,
            financialYear: l.financialYear,
            financialYearLabel: financialYearLabel(l.financialYear),
            reference: l.reference,
            filedOn: l.filedOn,
          })),
        })),
      },
      200,
    );
  });

  app.openapi(addBankAccountRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const added = await deps.companies.addBankAccount(
      s.tenantId,
      c.req.valid("param").entityPartyId,
      c.req.valid("json"),
      s.actor,
    );
    return c.json({ id: added.id }, 201);
  });

  app.openapi(retireBankAccountRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const p = c.req.valid("param");
    await deps.companies.retireBankAccount(s.tenantId, p.entityPartyId, p.accountId, s.actor);
    return c.body(null, 204);
  });

  app.openapi(addLutRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const added = await deps.companies.addLut(s.tenantId, c.req.valid("param").entityPartyId, c.req.valid("json"), s.actor);
    return c.json({ id: added.id }, 201);
  });

  app.openapi(retireLutRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const p = c.req.valid("param");
    await deps.companies.retireLut(s.tenantId, p.entityPartyId, p.lutId, s.actor);
    return c.body(null, 204);
  });

  app.openapi(decideDunningRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const decided = await deps.dunning.decide(
      { tenantId: s.tenantId, actionId: c.req.valid("param").actionId, ...c.req.valid("json") },
      s.actor,
    );
    return c.json(toDunningBody(decided), 200);
  });
}

function toDunningBody(a: DunningActionRecord): z.infer<typeof DunningActionSchema> {
  return {
    id: a.id,
    invoiceId: a.invoiceId,
    step: a.step,
    afterDays: a.afterDays,
    action: a.action,
    state: a.state,
    approvedBy: a.approvedBy,
    decidedAt: a.decidedAt,
    note: a.note,
  };
}

function toPaymentBody(p: Payment, fees: boolean): z.infer<typeof PaymentSchema> {
  return {
    id: p.id,
    invoiceId: p.invoiceId,
    amount: fees ? p.amount : null,
    currency: p.currency,
    receivedOn: p.receivedOn,
    method: p.method,
    reference: p.reference,
    note: p.note,
    tdsAmount: fees ? p.tdsAmount : null,
  };
}

function toBankAccountBody(b: BankAccountView): z.infer<typeof BankAccountSchema> {
  return {
    id: b.id,
    accountName: b.accountName,
    accountNumber: b.accountNumber,
    bankName: b.bankName,
    branch: b.branch,
    ifsc: b.ifsc,
    swift: b.swift,
    iban: b.iban,
    currency: b.currency,
  };
}

function toCreditNoteBody(c: CreditNote, fees: boolean): z.infer<typeof CreditNoteSchema> {
  return {
    id: c.id,
    invoiceId: c.invoiceId,
    entityPartyId: c.entityPartyId,
    number: c.number,
    financialYear: c.financialYear,
    sequenceNumber: c.sequenceNumber,
    amount: fees ? c.amount : null,
    currency: c.currency,
    issuedOn: c.issuedOn,
    reason: c.reason,
    note: c.note,
  };
}

function toBalanceBody(b: InvoiceBalance, fees: boolean): z.infer<typeof BalanceSchema> {
  return {
    invoiceId: b.invoiceId,
    partyId: b.partyId,
    status: b.status,
    currency: b.currency,
    dueOn: b.dueOn,
    invoiced: fees ? b.invoiced : null,
    paid: fees ? b.paid : null,
    credited: fees ? b.credited : null,
    outstanding: fees ? b.outstanding : null,
    tds: fees ? b.tds : null,
  };
}

function toInvoiceBody(i: Invoice, fees: boolean): z.infer<typeof InvoiceSchema> {
  return {
    id: i.id,
    tenantId: i.tenantId,
    partyId: i.partyId,
    entityPartyId: i.entityPartyId,
    number: i.number,
    financialYear: i.financialYear,
    financialYearLabel: financialYearLabelOfNumber(i.number),
    sequenceNumber: i.sequenceNumber,
    status: i.status,
    currency: i.currency,
    fxRate: fees ? i.fxRate : null,
    fxRateDate: i.fxRateDate,
    issuedOn: i.issuedOn,
    dueOn: i.dueOn,
    irn: i.irn,
    irnRegisteredAt: i.irnRegisteredAt,
    notes: i.notes,
    managerUserId: i.managerUserId,
    tax: {
      treatment: i.tax.treatment,
      supplierGstin: i.tax.supplierGstin,
      supplierStateCode: i.tax.supplierStateCode,
      recipientGstin: i.tax.recipientGstin,
      placeOfSupply:
        i.tax.placeOfSupplyStateCode === null && i.tax.placeOfSupplyCountry === null
          ? null
          : {
              stateCode: i.tax.placeOfSupplyStateCode,
              stateName:
                i.tax.placeOfSupplyStateCode === null ? null : (stateByCode(i.tax.placeOfSupplyStateCode)?.name ?? null),
              country: i.tax.placeOfSupplyCountry,
            },
      chosenPlaceOfSupply: i.tax.chosenPlaceOfSupply,
      reverseCharge: false,
      tds:
        i.tax.tdsSection === null || i.tax.tdsPercent === null
          ? null
          : { section: i.tax.tdsSection, percent: i.tax.tdsPercent },
    },
  };
}

function toTotalsBody(t: InvoiceTotals, fees: boolean): z.infer<typeof TotalsSchema> {
  return {
    lineCount: t.lineCount,
    gross: fees ? t.gross : null,
    discount: fees ? t.discount : null,
    net: fees ? t.net : null,
    tax: fees ? t.tax : null,
    total: fees ? t.total : null,
    currency: t.currency,
    cgst: fees ? t.cgst : null,
    sgst: fees ? t.sgst : null,
    utgst: fees ? t.utgst : null,
    igst: fees ? t.igst : null,
    tds: fees ? t.tds : null,
    netPayable: fees ? t.netPayable : null,
  };
}

function toRecordBody(record: InvoiceView, fees: boolean): z.infer<typeof InvoiceRecordSchema> {
  return {
    invoice: toInvoiceBody(record.invoice, fees),
    party: { id: record.party.id, displayName: record.party.displayName },
    entity: { id: record.entity.id, displayName: record.entity.displayName },
    lines: record.lines.map((l) => ({
      id: l.line.id,
      engagementId: l.line.engagementId,
      description: l.line.description,
      position: l.line.position,
      quantity: l.line.quantity,
      unitAmount: fees ? l.line.unitAmount : null,
      currency: l.line.currency,
      discountPercent: fees ? l.line.discountPercent : null,
      taxPercent: l.line.taxPercent,
      net: fees ? l.net : null,
      tax: fees ? l.tax : null,
      sac: l.line.sac,
      cgst: fees ? l.cgst : null,
      sgst: fees ? l.sgst : null,
      utgst: fees ? l.utgst : null,
      igst: fees ? l.igst : null,
    })),
    totals: toTotalsBody(record.totals, fees),
    manager:
      record.manager === null
        ? null
        : { userId: record.manager.userId, displayName: record.manager.displayName, email: record.manager.email },
    letters: record.letters.map((l) => ({ id: l.id, ref: l.ref })),
    taxSuggestions: {
      companyDefault: record.taxSuggestions.companyDefault,
      byEngagement: record.taxSuggestions.byEngagement.map((t) => ({
        engagementId: t.engagementId,
        taxPercent: t.taxPercent,
      })),
    },
    lut:
      record.lut === null
        ? null
        : { id: record.lut.id, reference: record.lut.reference, financialYear: record.lut.financialYear },
    bankAccount: record.bankAccount === null ? null : toBankAccountBody(record.bankAccount),
    issueBlocked:
      record.issueBlocked === null
        ? null
        : { reason: record.issueBlocked.reason, message: record.issueBlocked.message },
    issuesOn: record.issuesOn,
  };
}
