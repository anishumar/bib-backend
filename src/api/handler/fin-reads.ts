// What FinCompliance read from the files it took in (docs/FIN_BUILD_PLAN.md
// F2.5, the staging list F2.8 builds on) — transport only.
//
// Registered with the rest of fin only when BIB_FIN_ENABLED is on; a firm with
// its own switch off gets 404 `FIN_NOT_ENABLED` from the service. `books:read`,
// like the intake list: these are a client's own books.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import { scopeOf } from "../scope";
import { CONTROL_CHECKS } from "../../domain/fin/control";
import { DOC_KINDS, READERS, READ_PROBLEMS } from "../../domain/fin/lines";
import type { DocKind, LineDraft } from "../../domain/fin/lines";
import { LINE_STATUSES, READ_STATUSES } from "../../domain/fin/read";
import type { ReadStatus, StoredControl } from "../../domain/fin/read";
import { SHEET_DOC_KINDS } from "../../domain/fin/sheet-kinds";
import type { FinReadQueries } from "../../usecase/fin/read-queries";
import type { ReadView, ReadSummary } from "../../usecase/fin/read-ports";

export interface FinReadsDeps {
  readonly reads: FinReadQueries;
}

const MAX_READ_LIMIT = 500;

function enumOf<T extends string>(values: readonly T[]) {
  return z.enum(values as unknown as [T, ...T[]]);
}

const StatusEnum = enumOf(READ_STATUSES);
const DocKindEnum = enumOf(DOC_KINDS);
const ReaderEnum = enumOf(READERS);
const ProblemEnum = enumOf(READ_PROBLEMS);

const money = (description: string) => z.string().nullable().openapi({ description: `${description}. A decimal string.` });

const ReadSchema = z
  .object({
    readId: z.string().uuid(),
    intakeItemId: z.string().uuid(),
    documentId: z.string().uuid(),
    documentVersionId: z.string().uuid(),
    title: z.string(),
    filename: z.string(),
    clientPartyId: z.string().uuid().nullable(),
    clientName: z.string().nullable(),
    reader: ReaderEnum.nullable().openapi({
      description: "Which reader read the file. Null only when no reader takes it (`no_reader`).",
    }),
    docKind: DocKindEnum.openapi({ description: "What kind of file the reader found it to be; `unknown` when none did." }),
    status: StatusEnum.openapi({
      description:
        "`staged`: its lines wait for a person to commit them, and nothing counts until somebody does. " +
        "`needs_person`: a person must read it, and `problem` says why. `failed`: a reader could not open it.",
    }),
    problem: ProblemEnum.nullable().openapi({
      description:
        "Why it went to a person; null exactly when staged. `control_mismatch` means the file's own figures " +
        "(opening and closing, running balance, a total row) disagree with the lines, which are kept to look at.",
    }),
    controlOk: z.boolean().nullable().openapi({
      description: "Whether the lines agree with the figures the file printed; null for a read with no lines to check.",
    }),
    lineCount: z.number().int(),
    confidence: z.number().nullable().openapi({ description: "0 to 1 from the AI reader; null from a deterministic one." }),
    readAt: z.string().openapi({ description: "When fin read the file (ISO 8601)." }),
  })
  .openapi("FinRead");

const byDocKindShape = Object.fromEntries(DOC_KINDS.map((k) => [k, z.number().int()])) as Record<
  DocKind,
  z.ZodNumber
>;
const byStatusShape = Object.fromEntries(READ_STATUSES.map((s) => [s, z.number().int()])) as Record<
  ReadStatus,
  z.ZodNumber
>;

const SummarySchema = z
  .object({
    total: z.number().int(),
    byStatus: z.object(byStatusShape),
    byDocKind: z.object(byDocKindShape),
  })
  .openapi("FinReadSummary", {
    description:
      "How many reads there are, by status and by kind, for the same CLIENT filter as the list: never for one " +
      "page, and not narrowed by the status or kind being listed, so a tile's number does not move when it is clicked.",
  });

const provenance = {
  page: z.number().int().nullable().openapi({ description: "The 1-based page of a PDF it was read from; null for a sheet." }),
  row: z.number().int().nullable().openapi({ description: "The 1-based row of a sheet it was read from; null for a PDF." }),
  uncertain: z.array(z.string()).openapi({
    description: "Fields the reader was not sure of; staging shows exactly these to a person.",
  }),
};

const DocumentLineSchema = z
  .object({
    kind: z.literal("document"),
    docType: z.enum(["purchase_invoice", "sales_invoice", "credit_note", "receipt", "customs_permit", "pos_summary"]),
    counterpartyName: z.string().nullable(),
    counterpartyUen: z.string().nullable(),
    counterpartyGstNo: z.string().nullable(),
    docNumber: z.string().nullable(),
    docDate: z.string().nullable(),
    currency: z.string().nullable(),
    fxRate: z.string().nullable(),
    net: money("Before GST"),
    gstRate: z.string().nullable(),
    gst: money("The GST"),
    total: money("The total"),
    servicePeriodFrom: z.string().nullable(),
    servicePeriodTo: z.string().nullable(),
    creditNoteRef: z.string().nullable(),
    ...provenance,
  })
  .openapi("FinDocumentLine");

const StatementLineSchema = z
  .object({
    kind: z.literal("statement"),
    statementType: z.enum(["bank", "card"]),
    accountRef: z.string().nullable().openapi({ description: "The account or card's last four digits, as printed." }),
    txnDate: z.string(),
    valueDate: z.string().nullable(),
    narration: z.string(),
    reference: z.string().nullable(),
    amount: z.string().openapi({ description: "Money in positive, money out negative. A decimal string." }),
    currency: z.string(),
    balance: money("The running balance printed after this line"),
    originalCurrency: z.string().nullable(),
    originalAmount: money("A card line spent in another currency, as charged there"),
    ...provenance,
  })
  .openapi("FinStatementLine");

const PayrollLineSchema = z
  .object({
    kind: z.literal("payroll"),
    period: z.string().openapi({ description: "The month paid, `YYYY-MM`." }),
    employeeRef: z.string().openapi({
      description: "The employee's id as the sheet prints it, else the NRIC/FIN with all but its last four characters masked.",
    }),
    employeeName: z.string().nullable(),
    passType: z.enum(["citizen", "pr", "employment_pass", "s_pass", "work_permit"]).nullable(),
    age: z.number().int().nullable(),
    ordinaryWage: money("Ordinary wages"),
    additionalWage: money("Additional wages"),
    grossPay: money("Gross pay"),
    cpfEmployee: money("The employee's CPF"),
    cpfEmployer: money("The employer's CPF"),
    sdl: money("Skills Development Levy"),
    fwl: money("Foreign Worker Levy"),
    netPay: money("Net pay"),
    ...provenance,
  })
  .openapi("FinPayrollLine");

const LineValuesSchema = z.discriminatedUnion("kind", [DocumentLineSchema, StatementLineSchema, PayrollLineSchema]);

const LineSchema = z
  .object({
    lineId: z.string().uuid(),
    position: z.number().int().openapi({ description: "Its place in the read, from 1." }),
    status: enumOf(LINE_STATUSES),
    values: LineValuesSchema.openapi({ description: "The line as it stands." }),
    proposed: LineValuesSchema.openapi({
      description: "The line exactly as the reader proposed it. Kept for ever, whatever a person later corrects.",
    }),
  })
  .openapi("FinLine");

const ControlSchema = z
  .object({
    printed: z
      .object({
        opening: z.string().nullable(),
        closing: z.string().nullable(),
        lineCount: z.number().int().nullable(),
        declaredTotal: z.string().nullable(),
      })
      .nullable()
      .openapi({ description: "What the file printed about itself; null when it printed nothing to check against." }),
    checked: z.array(enumOf(CONTROL_CHECKS)).openapi({ description: "The checks the file gave something to run." }),
    problems: z.array(
      z.object({
        check: enumOf(CONTROL_CHECKS),
        position: z.number().int().nullable().openapi({ description: "The line where a running balance broke." }),
        expected: z.string().nullable().openapi({ description: "What the file printed." }),
        actual: z.string().nullable().openapi({ description: "What the lines make of it." }),
      }),
    ),
  })
  .openapi("FinReadControl");

const DetailSchema = ReadSchema.extend({
  control: ControlSchema.nullable(),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  format: z
    .object({
      formatId: z.string().uuid(),
      docKind: enumOf(SHEET_DOC_KINDS),
      confirmed: z.boolean().openapi({
        description: "Whether a person has confirmed this sheet layout. False: fin learnt it from a file whose figures agreed.",
      }),
    })
    .nullable()
    .openapi({ description: "The sheet layout the file was read with; null for anything else." }),
  lines: z.array(LineSchema),
}).openapi("FinReadDetail");

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/fin/reads",
  tags: ["fin"],
  summary: "What FinCompliance read from the files it took in, newest first",
  description:
    "One read per file taken in: staged for a person to commit, with a person and why, or failed. A page at a " +
    "time; `summary` counts the whole set for the same client, by status and by kind.",
  request: {
    query: z.object({
      clientPartyId: z.string().uuid().optional().openapi({ description: "Only this client's files." }),
      status: StatusEnum.optional().openapi({ description: "Only reads in this state. `needs_person` lists the desk." }),
      docKind: DocKindEnum.optional().openapi({ description: "Only reads of this kind of file." }),
      before: z.string().uuid().optional().openapi({
        description: "The `nextBefore` of the previous page. Absent for the newest page.",
      }),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(MAX_READ_LIMIT)
        .optional()
        .openapi({ description: `How many to return (default 50, max ${String(MAX_READ_LIMIT)})` }),
    }),
  },
  responses: {
    200: {
      description: "One page of reads, and the counts",
      content: {
        "application/json": {
          schema: z
            .object({
              items: z.array(ReadSchema),
              summary: SummarySchema,
              nextBefore: z.string().uuid().nullable().openapi({
                description: "Pass as `before` for the next page; null on the last page.",
              }),
            })
            .openapi("FinReadPage"),
        },
      },
    },
    400: errorResponse("Request failed validation"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or the role may not read the books"),
    404: errorResponse("FinCompliance is not switched on for this firm (FIN_NOT_ENABLED)"),
  },
});

const detailRoute = createRoute({
  method: "get",
  path: "/api/v1/fin/reads/{readId}",
  tags: ["fin"],
  summary: "One read: its file, what its figures said, and its lines",
  description:
    "The read with its file's name, its client's name, the control figures and what the check made of them, and " +
    "every line with the values it has now and what the reader proposed.",
  request: { params: z.object({ readId: z.string().uuid() }) },
  responses: {
    200: { description: "The read", content: { "application/json": { schema: DetailSchema } } },
    400: errorResponse("Request failed validation"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("No org chosen, or the role may not read the books"),
    404: errorResponse("No such read at this firm (FIN_READ_NOT_FOUND), or fin is off (FIN_NOT_ENABLED)"),
  },
});

function readToWire(r: ReadView) {
  return {
    readId: r.id,
    intakeItemId: r.intakeItemId,
    documentId: r.documentId,
    documentVersionId: r.documentVersionId,
    title: r.title,
    filename: r.filename,
    clientPartyId: r.clientPartyId,
    clientName: r.clientName,
    reader: r.reader,
    docKind: r.docKind,
    status: r.status,
    problem: r.problem,
    controlOk: r.controlOk,
    lineCount: r.lineCount,
    confidence: r.confidence,
    readAt: r.readAt,
  };
}

function summaryToWire(s: ReadSummary) {
  return { total: s.total, byStatus: { ...s.byStatus }, byDocKind: { ...s.byDocKind } };
}

function lineToWire(d: LineDraft) {
  const where = { page: d.provenance.page, row: d.provenance.row, uncertain: [...d.uncertain] as string[] };
  switch (d.kind) {
    case "document":
      return {
        kind: "document" as const,
        docType: d.docType,
        counterpartyName: d.counterpartyName,
        counterpartyUen: d.counterpartyUen,
        counterpartyGstNo: d.counterpartyGstNo,
        docNumber: d.docNumber,
        docDate: d.docDate,
        currency: d.currency,
        fxRate: d.fxRate,
        net: d.net,
        gstRate: d.gstRate,
        gst: d.gst,
        total: d.total,
        servicePeriodFrom: d.servicePeriodFrom,
        servicePeriodTo: d.servicePeriodTo,
        creditNoteRef: d.creditNoteRef,
        ...where,
      };
    case "statement":
      return {
        kind: "statement" as const,
        statementType: d.statementType,
        accountRef: d.accountRef,
        txnDate: d.txnDate,
        valueDate: d.valueDate,
        narration: d.narration,
        reference: d.reference,
        amount: d.amount,
        currency: d.currency,
        balance: d.balance,
        originalCurrency: d.originalCurrency,
        originalAmount: d.originalAmount,
        ...where,
      };
    case "payroll":
      return {
        kind: "payroll" as const,
        period: d.period,
        employeeRef: d.employeeRef,
        employeeName: d.employeeName,
        passType: d.passType,
        age: d.age,
        ordinaryWage: d.ordinaryWage,
        additionalWage: d.additionalWage,
        grossPay: d.grossPay,
        cpfEmployee: d.cpfEmployee,
        cpfEmployer: d.cpfEmployer,
        sdl: d.sdl,
        fwl: d.fwl,
        netPay: d.netPay,
        ...where,
      };
  }
}

function controlToWire(c: StoredControl) {
  return {
    printed:
      c.printed === null
        ? null
        : {
            opening: c.printed.opening,
            closing: c.printed.closing,
            lineCount: c.printed.lineCount,
            declaredTotal: c.printed.declaredTotal,
          },
    checked: [...c.checked],
    problems: c.problems.map((p) => ({ check: p.check, position: p.position, expected: p.expected, actual: p.actual })),
  };
}

export function registerFinReadRoutes(app: OpenAPIHono<AppEnv>, deps: FinReadsDeps): void {
  app.openapi(listRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const q = c.req.valid("query");
    const page = await deps.reads.list(s.tenantId, {
      clientPartyId: q.clientPartyId ?? null,
      status: q.status ?? null,
      docKind: q.docKind ?? null,
      before: q.before ?? null,
      limit: q.limit ?? 50,
    });
    return c.json(
      { items: page.items.map(readToWire), summary: summaryToWire(page.summary), nextBefore: page.nextBefore },
      200,
    );
  });

  app.openapi(detailRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const read = await deps.reads.get(s.tenantId, c.req.valid("param").readId);
    return c.json(
      {
        ...readToWire(read),
        control: read.control === null ? null : controlToWire(read.control),
        model: read.model,
        promptVersion: read.promptVersion,
        format:
          read.format === null
            ? null
            : { formatId: read.format.id, docKind: read.format.docKind, confirmed: read.format.confirmed },
        lines: read.lines.map((l) => ({
          lineId: l.id,
          position: l.position,
          status: l.status,
          values: lineToWire(l.values),
          proposed: lineToWire(l.proposed),
        })),
      },
      200,
    );
  });
}
