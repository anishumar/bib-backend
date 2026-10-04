// HTTP for the client import — the staged upload, its report, and the confirm.
//
// The upload is multipart because the sheets do not fit the JSON body limit
// and should not be re-sent: they go up once, are parsed and checked, and the
// report is what the screen shows. Confirm is a second request over the same
// staged row, so the person confirming confirms what they read.

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";

import {
  BILLING_FREQUENCIES,
} from "../../domain/document/model";
import {
  CLIENT_COLUMNS,
  CLIENT_SHEET_MARKER,
  ENGAGEMENT_COLUMNS,
  ENGAGEMENT_SHEET_MARKER,
  PEOPLE_COLUMNS,
  PEOPLE_SHEET_MARKER,
  RELATIONSHIP_WORDS,
} from "../../domain/clientimport/model";
import type { ImportReport } from "../../domain/clientimport/model";
import type { ImportOutcome, StagedImport, StagedImportSummary } from "../../usecase/clientimport/ports";
import type { ClientImportService, UploadedSheet } from "../../usecase/clientimport/service";
import { errorResponse, z } from "../openapi";
import type { AppEnv } from "../guards";
import { scopeOf } from "../scope";
import type { AuthzService } from "../../usecase/authz/service";
import type { Principal } from "../../platform/callctx";

export interface ClientImportDeps {
  readonly service: ClientImportService;
  /**
   * The FEE AXIS only (B50, audit 2026-10-03): the report shows each letter
   * line's fee, null for an administrator who does not see fees. Gate 3 is
   * middleware.
   */
  readonly authz: AuthzService;
}

// ── Wire schemas ─────────────────────────────────────────────────────────────

const SheetName = z.enum(["clients", "people", "engagements"]);

const PersonSchema = z
  .object({
    userId: z.string().uuid(),
    name: z.string().nullable(),
    email: z.string(),
  })
  .openapi("ClientImportPerson");

const FindingSchema = z
  .object({
    sheet: z.enum(["clients", "people", "engagements", "file"]),
    lineNo: z.number().int().nullable().openapi({
      description: "The row as Excel numbers it. Null for a finding about the file as a whole.",
    }),
    name: z.string(),
    severity: z.enum(["blocking", "warning"]),
    message: z.string(),
  })
  .openapi("ClientImportFinding");

const RowVerdictSchema = z
  .object({
    sheet: SheetName,
    lineNo: z.number().int(),
    name: z.string(),
    action: z.enum(["create", "skip", "blocked"]),
    detail: z.string().nullable(),
  })
  .openapi("ClientImportRowVerdict");

const LetterLinePlanSchema = z
  .object({
    engagementLineNo: z.number().int(),
    entityLineNo: z.number().int().nullable(),
    entityPartyId: z.string().uuid().nullable(),
    entityName: z.string(),
    serviceCode: z.string(),
    serviceName: z.string(),
    serviceVersionId: z.string().uuid(),
    startedOn: z.string(),
    billingFrequency: z.string(),
    unitAmount: z.string().nullable().openapi({
      description: "The line's fee from the sheet. Null when the sheet gave none, and null for a login that does not see fees.",
    }),
    jurisdiction: z.string().nullable(),
    basis: z.string().nullable(),
  })
  .openapi("ClientImportLetterLine");

const LetterPlanSchema = z
  .object({
    clientName: z.string(),
    clientLineNo: z.number().int().nullable(),
    clientPartyId: z.string().uuid().nullable(),
    jurisdiction: z.string(),
    currency: z.string(),
    effectiveFrom: z.string(),
    signatory: z.string(),
    lines: z.array(LetterLinePlanSchema),
  })
  .openapi("ClientImportLetterPlan");

const PortalInvitePlanSchema = z
  .object({
    clientLineNo: z.number().int(),
    clientName: z.string(),
    clientPartyId: z.string().uuid().nullable(),
    email: z.string(),
  })
  .openapi("ClientImportPortalInvitePlan");

const CountsSchema = z
  .object({
    clientsToCreate: z.number().int(),
    clientsOnFile: z.number().int(),
    clientsBlocked: z.number().int(),
    entitiesToRegister: z.number().int(),
    peopleToCreate: z.number().int().openapi({
      description:
        "PARTIES this sheet would create, not people ROWS. A people row is a ROLE, so one " +
        "director of three companies in a group is three rows and one person.",
    }),
    rolesToRecord: z.number().int().openapi({
      description:
        "Directorships, signatory roles and the like — one per people row that would load, " +
        "whether or not it also creates the person.",
    }),
    peopleOnFile: z.number().int(),
    peopleBlocked: z.number().int(),
    engagementsToCreate: z.number().int(),
    engagementsOnFile: z.number().int(),
    engagementsBlocked: z.number().int(),
    lettersToDraft: z.number().int(),
    assignmentsToRecord: z.number().int(),
    portalInvitesToSend: z.number().int(),
  })
  .openapi("ClientImportCounts");

const ReportSchema = z
  .object({
    findings: z.array(FindingSchema),
    blocking: z.number().int(),
    warnings: z.number().int(),
    rows: z.array(RowVerdictSchema),
    letters: z.array(LetterPlanSchema),
    portalInvites: z.array(PortalInvitePlanSchema),
    counts: CountsSchema,
    compliance: z.object({
      floor: z.string().nullable().openapi({
        description: "The firm's compliance go-live floor, or null for no floor.",
      }),
      reachBackFrom: z.string(),
      engagementsBeforeReachBack: z.number().int(),
    }),
  })
  .openapi("ClientImportReport");

const OutcomeRowSchema = z
  .object({
    sheet: SheetName,
    lineNo: z.number().int(),
    name: z.string(),
    action: z.enum(["created", "skipped", "failed"]),
    detail: z.string().nullable(),
    partyId: z.string().uuid().nullable(),
  })
  .openapi("ClientImportOutcomeRow");

const LetterOutcomeSchema = z
  .object({
    clientName: z.string(),
    currency: z.string(),
    action: z.enum(["created", "skipped", "failed"]),
    detail: z.string().nullable(),
    letterId: z.string().uuid().nullable(),
    lineNos: z.array(z.number().int()),
    engagementIds: z.array(z.string().uuid()),
  })
  .openapi("ClientImportLetterOutcome");

const PortalInviteOutcomeSchema = z
  .object({
    clientName: z.string(),
    email: z.string(),
    action: z.enum(["invited", "granted", "already granted", "failed"]),
    detail: z.string().nullable(),
  })
  .openapi("ClientImportPortalInviteOutcome");

const OutcomeSchema = z
  .object({
    rows: z.array(OutcomeRowSchema),
    letters: z.array(LetterOutcomeSchema),
    portalInvites: z.array(PortalInviteOutcomeSchema),
    created: z.object({
      clients: z.number().int(),
      entities: z.number().int(),
      people: z.number().int().openapi({
        description:
          "PARTIES created, not people ROWS. A people row is a ROLE, so one director of " +
          "three companies in a group is three rows and one person — these two numbers " +
          "differ on purpose.",
      }),
      roles: z.number().int().openapi({
        description:
          "Directorships, signatory roles and the like — one per people row that loaded, " +
          "whether or not it also created the person.",
      }),
      assignments: z.number().int(),
      letters: z.number().int(),
      engagements: z.number().int(),
      portalInvites: z.number().int(),
    }),
    skipped: z.number().int(),
    failed: z.number().int(),
  })
  .openapi("ClientImportOutcome");

const FileNamesSchema = z.object({
  clients: z.string(),
  people: z.string().nullable(),
  engagements: z.string().nullable(),
});

const ClientImportSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(["staged", "confirmed"]),
    fileNames: FileNamesSchema,
    report: ReportSchema,
    outcome: OutcomeSchema.nullable(),
    stagedBy: PersonSchema,
    stagedAt: z.string(),
    confirmedBy: PersonSchema.nullable(),
    confirmedAt: z.string().nullable(),
  })
  .openapi("ClientImport");

const SummarySchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(["staged", "confirmed"]),
    fileNames: FileNamesSchema,
    blocking: z.number().int(),
    warnings: z.number().int(),
    counts: CountsSchema,
    stagedBy: PersonSchema,
    stagedAt: z.string(),
    confirmedAt: z.string().nullable(),
  })
  .openapi("ClientImportSummary");

const ListSchema = z.object({ imports: z.array(SummarySchema) }).openapi("ClientImportList");

const ColumnSchema = z.object({
  header: z.string(),
  required: z.boolean(),
  hint: z.string().openapi({
    description:
      "The few words a downloaded sheet prints IN the header cell, in brackets — " +
      "`Started On (YYYY-MM-DD)`. The reader ignores everything from the first \"(\" when " +
      "matching a header, so a sheet with the hints kept, shortened or deleted reads the same.",
  }),
  about: z.string(),
});

const TemplateSchema = z
  .object({
    sheets: z.array(
      z.object({
        key: SheetName,
        marker: z.string().openapi({
          description: "The column the header row must contain to be recognised.",
        }),
        columns: z.array(ColumnSchema),
      }),
    ),
    relationships: z.array(z.string()),
    billingFrequencies: z.array(z.string()),
    identifierColumns: z.array(z.string()),
  })
  .openapi("ClientImportTemplate");

// `z.any()` for a file with an explicit OpenAPI type — the documented way to
// describe a binary part; zod has no File schema that survives spec generation.
const binaryPart = z.any().openapi({ type: "string", format: "binary" });

const UploadForm = z
  .object({
    clients: binaryPart.openapi({ description: "The client sheet. Required." }),
    people: binaryPart.optional().openapi({ description: "Directors, signatories and contacts." }),
    engagements: binaryPart.optional().openapi({ description: "The work the firm already delivers." }),
  })
  .openapi("ClientImportUploadForm");

const ImportParam = z.object({ importId: z.string().uuid() });

// ── Mapping ──────────────────────────────────────────────────────────────────

function reportToWire(r: ImportReport, fees: boolean): z.infer<typeof ReportSchema> {
  return {
    findings: r.findings.map((f) => ({ ...f })),
    blocking: r.blocking,
    warnings: r.warnings,
    rows: r.rows.map((v) => ({ ...v })),
    letters: r.letters.map((l) => ({
      clientName: l.clientName,
      clientLineNo: l.clientLineNo,
      clientPartyId: l.clientPartyId,
      jurisdiction: l.jurisdiction,
      currency: l.currency,
      effectiveFrom: l.effectiveFrom,
      signatory: l.signatory,
      // Field by field (B48), and the fee is money (B50).
      lines: l.lines.map((x) => ({
        engagementLineNo: x.engagementLineNo,
        entityLineNo: x.entityLineNo,
        entityPartyId: x.entityPartyId,
        entityName: x.entityName,
        serviceCode: x.serviceCode,
        serviceName: x.serviceName,
        serviceVersionId: x.serviceVersionId,
        startedOn: x.startedOn,
        billingFrequency: x.billingFrequency,
        unitAmount: fees ? x.unitAmount : null,
        jurisdiction: x.jurisdiction,
        basis: x.basis,
      })),
    })),
    portalInvites: r.portalInvites.map((p) => ({ ...p })),
    counts: { ...r.counts },
    compliance: { ...r.compliance },
  };
}

function outcomeToWire(o: ImportOutcome): z.infer<typeof OutcomeSchema> {
  return {
    rows: o.rows.map((x) => ({ ...x })),
    letters: o.letters.map((l) => ({
      clientName: l.clientName,
      currency: l.currency,
      action: l.action,
      detail: l.detail,
      letterId: l.letterId,
      lineNos: [...l.lineNos],
      engagementIds: [...l.engagementIds],
    })),
    portalInvites: o.portalInvites.map((p) => ({ ...p })),
    created: { ...o.created },
    skipped: o.skipped,
    failed: o.failed,
  };
}

function toWire(s: StagedImport, fees: boolean): z.infer<typeof ClientImportSchema> {
  return {
    id: s.id,
    status: s.status,
    fileNames: { ...s.fileNames },
    report: reportToWire(s.report, fees),
    outcome: s.outcome === null ? null : outcomeToWire(s.outcome),
    stagedBy: { ...s.stagedBy },
    stagedAt: s.stagedAt,
    confirmedBy: s.confirmedBy === null ? null : { ...s.confirmedBy },
    confirmedAt: s.confirmedAt,
  };
}

function summaryToWire(s: StagedImportSummary): z.infer<typeof SummarySchema> {
  return {
    id: s.id,
    status: s.status,
    fileNames: { ...s.fileNames },
    blocking: s.blocking,
    warnings: s.warnings,
    counts: { ...s.counts },
    stagedBy: { ...s.stagedBy },
    stagedAt: s.stagedAt,
    confirmedAt: s.confirmedAt,
  };
}

/**
 * One named part of the multipart body, as bytes — or null when the browser
 * sent the field empty, which it does for a file input nobody touched (a
 * `File` with no name and no size).
 */
async function sheetPart(body: Record<string, unknown>, name: string): Promise<UploadedSheet | null> {
  const part = body[name];
  if (!(part instanceof File)) return null;
  if (part.size === 0 && part.name === "") return null;
  return { bytes: new Uint8Array(await part.arrayBuffer()), filename: part.name };
}

// ── Routes ───────────────────────────────────────────────────────────────────

const stageRoute = createRoute({
  method: "post",
  path: "/api/v1/client-imports",
  tags: ["client-imports"],
  summary: "Upload a firm's book of clients and have it checked",
  description:
    "Multipart: a `clients` sheet (required), a `people` sheet and an `engagements` sheet, each " +
    ".csv or .xlsx. Every row is checked against what the firm already has and the result is " +
    "STAGED with its report — nothing else is written. A row already on file is skipped, never " +
    "updated. Confirm the staged import to load it.",
  request: {
    body: { content: { "multipart/form-data": { schema: UploadForm } }, required: true },
  },
  responses: {
    201: { description: "Staged, with its report", content: { "application/json": { schema: ClientImportSchema } } },
    400: errorResponse("No client sheet, an unreadable file, or a sheet with no header row"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer it"),
    413: errorResponse("A sheet is larger than BIB_MAX_UPLOAD_BYTES"),
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/api/v1/client-imports",
  tags: ["client-imports"],
  summary: "Every upload at this firm, newest first",
  responses: {
    200: { description: "The imports", content: { "application/json": { schema: ListSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer it"),
  },
});

const templateRoute = createRoute({
  method: "get",
  path: "/api/v1/client-imports/template",
  tags: ["client-imports"],
  summary: "The columns each sheet takes",
  description:
    "The contract a sheet is read against: three sheets, their header marker, every column with " +
    "whether it is required. Headers are matched by name, case- and space-insensitively, " +
    "wherever the header row is.",
  responses: {
    200: { description: "The template", content: { "application/json": { schema: TemplateSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer it"),
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/api/v1/client-imports/{importId}",
  tags: ["client-imports"],
  summary: "One upload — its report, and its outcome once confirmed",
  request: { params: ImportParam },
  responses: {
    200: { description: "The import", content: { "application/json": { schema: ClientImportSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer it"),
    404: errorResponse("No such import at this firm"),
  },
});

const confirmRoute = createRoute({
  method: "post",
  path: "/api/v1/client-imports/{importId}/confirm",
  tags: ["client-imports"],
  summary: "Load a staged import",
  description:
    "Re-checks the sheet against the firm's records as they stand now, then creates every row " +
    "through the same services the screens use: the company, its registration and identifiers, " +
    "its people, its Key Manager and SPOCs, one signed engagement letter per client and " +
    "currency carrying its engagements, and a portal invite for every client whose Portal " +
    "Invite column is TRUE. An address that already holds a login here is GRANTED this company " +
    "rather than mailed a second invite. Each row commits on its own and the outcome says what " +
    "each became; a row that failed can be uploaded again and only what is missing is attempted.",
  request: { params: ImportParam },
  responses: {
    200: { description: "Loaded, with the outcome", content: { "application/json": { schema: ClientImportSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer it"),
    404: errorResponse("No such import at this firm"),
    409: errorResponse("Already confirmed, or blocking findings remain"),
  },
});

export function registerClientImportRoutes(app: OpenAPIHono<AppEnv>, deps: ClientImportDeps): void {
  const seesFees = (principal: Principal | null): boolean =>
    principal !== null && deps.authz.seesFees(principal);

  app.openapi(stageRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    // `parseBody` rather than the validated form value: zod cannot describe a
    // File and `z.any()` passes whatever arrived through untouched, so the
    // check that each part IS a file happens here.
    const body = await c.req.parseBody();
    const [clients, people, engagements] = await Promise.all([
      sheetPart(body, "clients"),
      sheetPart(body, "people"),
      sheetPart(body, "engagements"),
    ]);
    const staged = await deps.service.stage(
      { tenantId: s.tenantId, stagedBy: s.userId, clients, people, engagements },
      s.actor,
    );
    return c.json(toWire(staged, seesFees(c.get("principal"))), 201);
  });

  app.openapi(listRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const imports = await deps.service.list(s.tenantId);
    return c.json({ imports: imports.map(summaryToWire) }, 200);
  });

  // Before the `{importId}` route, so "template" is never read as an id.
  app.openapi(templateRoute, (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    return c.json(
      {
        sheets: [
          { key: "clients" as const, marker: CLIENT_SHEET_MARKER, columns: CLIENT_COLUMNS.map((x) => ({ ...x })) },
          { key: "people" as const, marker: PEOPLE_SHEET_MARKER, columns: PEOPLE_COLUMNS.map((x) => ({ ...x })) },
          { key: "engagements" as const, marker: ENGAGEMENT_SHEET_MARKER, columns: ENGAGEMENT_COLUMNS.map((x) => ({ ...x })) },
        ],
        relationships: [...new Set(Object.values(RELATIONSHIP_WORDS))],
        billingFrequencies: [...BILLING_FREQUENCIES],
        identifierColumns: CLIENT_COLUMNS.filter((c) => /^[A-Z]{3,5}$/.test(c.header)).map((c) => c.header),
      },
      200,
    );
  });

  app.openapi(getRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const found = await deps.service.get(s.tenantId, c.req.valid("param").importId);
    return c.json(toWire(found, seesFees(c.get("principal"))), 200);
  });

  app.openapi(confirmRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const confirmed = await deps.service.confirm(
      { tenantId: s.tenantId, importId: c.req.valid("param").importId, confirmedBy: s.userId },
      s.actor,
    );
    return c.json(toWire(confirmed, seesFees(c.get("principal"))), 200);
  });
}

export const clientImportRoutes = {
  stage: stageRoute,
  list: listRoute,
  template: templateRoute,
  get: getRoute,
  confirm: confirmRoute,
} as const;
