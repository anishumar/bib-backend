// FinCompliance's reads, lines and sheet layouts, in Postgres (0386). Every
// statement here runs inside `withTenant`, so RLS answers for the firm; the
// queries still name `tenant_id` where they join, the intake adapter's habit.
import type { Db } from "../../db/pool";
import { withTenant } from "../../db/tenant";
import { DOC_KINDS } from "../../domain/fin/lines";
import type {
  DocKind,
  DocumentLineDraft,
  LineDraft,
  PassType,
  PayrollLineDraft,
  ReadProblem,
  Reader,
  StatementLineDraft,
} from "../../domain/fin/lines";
import type { IntakeRoute } from "../../domain/fin/intake";
import { READ_STATUSES } from "../../domain/fin/read";
import type { LineStatus, ReadStatus, StoredControl } from "../../domain/fin/read";
import type { AmountStyle, SheetContainer } from "../../domain/fin/sheet";
import type { ColumnMap, SheetDocKind } from "../../domain/fin/sheet-kinds";
import type { DateFormat } from "../../domain/fin/sheet-values";
import type {
  FirmCurrency,
  LineView,
  NewLine,
  NewRead,
  NewSourceFormat,
  ReadDetail,
  ReadFilter,
  ReadQueries,
  ReadStore,
  ReadSummary,
  ReadView,
  SourceFormat,
  SourceFormatStore,
  UnreadItem,
} from "../../usecase/fin/read-ports";
import { isoInstant } from "../postgres/instant";

/** How long one fin read may take on the API's pool: the intake list's cap,
 *  well below the pool's own, so a slow fin query never holds a connection
 *  core needs. */
const FIN_READ_TIMEOUT_MS = 5_000;

export class PostgresFirmCurrency implements FirmCurrency {
  constructor(private readonly app: Db) {}

  async reportingCurrency(tenantId: string): Promise<string> {
    // `tenancy.tenant` is a global table, read the way `PostgresFinFirms`
    // reads the fin switch on it.
    const [row] = await this.app<{ reporting_currency: string }[]>`
      SELECT reporting_currency FROM tenancy.tenant WHERE id = ${tenantId}
    `;
    if (row === undefined) throw new Error(`fin: there is no firm ${tenantId} to read a reporting currency for`);
    return row.reporting_currency;
  }
}

// ── Layouts ──────────────────────────────────────────────────────────────────

interface FormatRow {
  id: string;
  fingerprint: string;
  container: SheetContainer;
  header: string[];
  header_row: number;
  doc_kind: SheetDocKind;
  column_map: ColumnMap;
  date_format: DateFormat | null;
  amount_style: AmountStyle;
  learnt_from_intake_item_id: string | null;
  based_on_format_id: string | null;
  confirmed_by_user_id: string | null;
  confirmed_at: string | null;
}

const FORMAT_COLUMNS = `
  id, fingerprint, container, header, header_row, doc_kind, column_map, date_format, amount_style,
  learnt_from_intake_item_id, based_on_format_id, confirmed_by_user_id,
  ${isoInstant("confirmed_at", "confirmed_at")}
`;

function toFormat(r: FormatRow): SourceFormat {
  return {
    id: r.id,
    fingerprint: r.fingerprint,
    container: r.container,
    header: r.header,
    headerRow: r.header_row,
    docKind: r.doc_kind,
    columns: r.column_map,
    dateFormat: r.date_format,
    amountStyle: r.amount_style,
    learntFromIntakeItemId: r.learnt_from_intake_item_id,
    basedOnFormatId: r.based_on_format_id,
    confirmedByUserId: r.confirmed_by_user_id,
    confirmedAt: r.confirmed_at,
  };
}

export class PostgresSourceFormats implements SourceFormatStore {
  constructor(private readonly app: Db) {}

  async current(tenantId: string, fingerprints: readonly string[]): Promise<readonly SourceFormat[]> {
    if (fingerprints.length === 0) return [];
    return withTenant(this.app, tenantId, async (db) => {
      // Per fingerprint: the newest a person confirmed, else the learnt one.
      const rows = await db<FormatRow[]>`
        SELECT DISTINCT ON (fingerprint) ${db.unsafe(FORMAT_COLUMNS)}
          FROM fin.source_format
         WHERE tenant_id = ${tenantId}
           AND fingerprint = ANY(${db.array(fingerprints as string[])}::text[])
         ORDER BY fingerprint, (confirmed_at IS NOT NULL) DESC, created_at DESC, id DESC
      `;
      return rows.map(toFormat);
    });
  }

  async learn(format: NewSourceFormat): Promise<string> {
    return withTenant(this.app, format.tenantId, async (db) => {
      const inserted = await db<{ id: string }[]>`
        INSERT INTO fin.source_format
          (id, tenant_id, fingerprint, container, header, header_row, doc_kind, column_map,
           date_format, amount_style, learnt_from_intake_item_id)
        VALUES
          (${format.id}, ${format.tenantId}, ${format.fingerprint}, ${format.container},
           ${db.array(format.header as string[])}::text[], ${format.headerRow}, ${format.docKind},
           ${db.json(format.columns as Parameters<typeof db.json>[0])}, ${format.dateFormat},
           ${format.amountStyle}, ${format.learntFromIntakeItemId})
        ON CONFLICT (tenant_id, fingerprint) WHERE confirmed_at IS NULL DO NOTHING
        RETURNING id
      `;
      if (inserted[0] !== undefined) return inserted[0].id;
      // Another run learnt this layout first: read with its row.
      const [existing] = await db<{ id: string }[]>`
        SELECT id FROM fin.source_format
         WHERE tenant_id = ${format.tenantId} AND fingerprint = ${format.fingerprint} AND confirmed_at IS NULL
      `;
      if (existing === undefined) throw new Error(`fin: layout ${format.fingerprint} was neither learnt nor found`);
      return existing.id;
    });
  }

  async confirm(format: NewSourceFormat): Promise<string> {
    return withTenant(this.app, format.tenantId, async (db) => {
      const [row] = await db<{ id: string }[]>`
        INSERT INTO fin.source_format
          (id, tenant_id, fingerprint, container, header, header_row, doc_kind, column_map,
           date_format, amount_style, learnt_from_intake_item_id, based_on_format_id,
           confirmed_by_user_id, confirmed_at)
        VALUES
          (${format.id}, ${format.tenantId}, ${format.fingerprint}, ${format.container},
           ${db.array(format.header as string[])}::text[], ${format.headerRow}, ${format.docKind},
           ${db.json(format.columns as Parameters<typeof db.json>[0])}, ${format.dateFormat},
           ${format.amountStyle}, ${format.learntFromIntakeItemId}, ${format.basedOnFormatId},
           ${format.confirmedByUserId}, now())
        RETURNING id
      `;
      return row?.id ?? format.id;
    });
  }

  async get(tenantId: string, formatId: string): Promise<SourceFormat | null> {
    return withTenant(this.app, tenantId, async (db) => {
      const [row] = await db<FormatRow[]>`
        SELECT ${db.unsafe(FORMAT_COLUMNS)} FROM fin.source_format WHERE id = ${formatId}
      `;
      return row === undefined ? null : toFormat(row);
    });
  }
}

// ── Reads and lines ──────────────────────────────────────────────────────────

/** One line as the columns of `fin.transaction_line`, keyed as the
 *  recordset in `insert` names them. Money and days stay strings: Postgres
 *  reads them into `numeric` and `date`. */
function lineRow(line: NewLine): Record<string, unknown> {
  const d = line.draft;
  const row: Record<string, unknown> = {
    id: line.id,
    position: line.position,
    line_kind: d.kind,
    page: d.provenance.page,
    row_no: d.provenance.row,
    uncertain: [...d.uncertain],
    proposed: d,
  };
  switch (d.kind) {
    case "document":
      return {
        ...row,
        doc_type: d.docType,
        counterparty_name: d.counterpartyName,
        counterparty_uen: d.counterpartyUen,
        counterparty_gst_no: d.counterpartyGstNo,
        doc_number: d.docNumber,
        doc_date: d.docDate,
        currency: d.currency,
        fx_rate: d.fxRate,
        net: d.net,
        gst_rate: d.gstRate,
        gst: d.gst,
        total: d.total,
        service_period_from: d.servicePeriodFrom,
        service_period_to: d.servicePeriodTo,
        credit_note_ref: d.creditNoteRef,
      };
    case "statement":
      return {
        ...row,
        statement_type: d.statementType,
        account_ref: d.accountRef,
        txn_date: d.txnDate,
        value_date: d.valueDate,
        narration: d.narration,
        reference: d.reference,
        amount: d.amount,
        currency: d.currency,
        balance: d.balance,
        original_currency: d.originalCurrency,
        original_amount: d.originalAmount,
      };
    case "payroll":
      return {
        ...row,
        period: d.period,
        employee_ref: d.employeeRef,
        employee_name: d.employeeName,
        pass_type: d.passType,
        age: d.age,
        ordinary_wage: d.ordinaryWage,
        additional_wage: d.additionalWage,
        gross_pay: d.grossPay,
        cpf_employee: d.cpfEmployee,
        cpf_employer: d.cpfEmployer,
        sdl: d.sdl,
        fwl: d.fwl,
        net_pay: d.netPay,
      };
  }
}

/** Every typed column of a line, money and days as text, never parsed into a
 *  number or a `Date`. */
const LINE_COLUMNS = `
  id, position, line_kind, status, page, row_no, document_version_id, uncertain, proposed,
  doc_type, counterparty_name, counterparty_uen, counterparty_gst_no, doc_number,
  doc_date::text AS doc_date, currency, fx_rate::text AS fx_rate, net::text AS net,
  gst_rate::text AS gst_rate, gst::text AS gst, total::text AS total,
  service_period_from::text AS service_period_from, service_period_to::text AS service_period_to,
  credit_note_ref,
  statement_type, account_ref, txn_date::text AS txn_date, value_date::text AS value_date,
  narration, reference, amount::text AS amount, balance::text AS balance,
  original_currency, original_amount::text AS original_amount,
  period, employee_ref, employee_name, pass_type, age,
  ordinary_wage::text AS ordinary_wage, additional_wage::text AS additional_wage,
  gross_pay::text AS gross_pay, cpf_employee::text AS cpf_employee, cpf_employer::text AS cpf_employer,
  sdl::text AS sdl, fwl::text AS fwl, net_pay::text AS net_pay
`;

interface LineDbRow {
  id: string;
  position: number;
  line_kind: LineDraft["kind"];
  status: LineStatus;
  page: number | null;
  row_no: number | null;
  document_version_id: string;
  uncertain: string[];
  proposed: LineDraft;
  doc_type: DocumentLineDraft["docType"] | null;
  counterparty_name: string | null;
  counterparty_uen: string | null;
  counterparty_gst_no: string | null;
  doc_number: string | null;
  doc_date: string | null;
  currency: string | null;
  fx_rate: string | null;
  net: string | null;
  gst_rate: string | null;
  gst: string | null;
  total: string | null;
  service_period_from: string | null;
  service_period_to: string | null;
  credit_note_ref: string | null;
  statement_type: StatementLineDraft["statementType"] | null;
  account_ref: string | null;
  txn_date: string | null;
  value_date: string | null;
  narration: string | null;
  reference: string | null;
  amount: string | null;
  balance: string | null;
  original_currency: string | null;
  original_amount: string | null;
  period: string | null;
  employee_ref: string | null;
  employee_name: string | null;
  pass_type: PassType | null;
  age: number | null;
  ordinary_wage: string | null;
  additional_wage: string | null;
  gross_pay: string | null;
  cpf_employee: string | null;
  cpf_employer: string | null;
  sdl: string | null;
  fwl: string | null;
  net_pay: string | null;
}

/** A column its kind's CHECK in 0386 makes NOT NULL. Null here means the
 *  constraint is gone, which is said, never papered over with a value. */
function must<T>(value: T | null, column: string, id: string): T {
  if (value === null) throw new Error(`fin.transaction_line ${id} has no ${column}, which its kind requires`);
  return value;
}

/** A line's values as its columns stand. */
function valuesOf(r: LineDbRow): LineDraft {
  const provenance = { documentVersionId: r.document_version_id, page: r.page, row: r.row_no };
  switch (r.line_kind) {
    case "document":
      return {
        kind: "document",
        docType: must(r.doc_type, "doc_type", r.id),
        counterpartyName: r.counterparty_name,
        counterpartyUen: r.counterparty_uen,
        counterpartyGstNo: r.counterparty_gst_no,
        docNumber: r.doc_number,
        docDate: r.doc_date,
        currency: r.currency,
        fxRate: r.fx_rate,
        net: r.net,
        gstRate: r.gst_rate,
        gst: r.gst,
        total: r.total,
        servicePeriodFrom: r.service_period_from,
        servicePeriodTo: r.service_period_to,
        creditNoteRef: r.credit_note_ref,
        provenance,
        uncertain: r.uncertain as DocumentLineDraft["uncertain"],
      };
    case "statement":
      return {
        kind: "statement",
        statementType: must(r.statement_type, "statement_type", r.id),
        accountRef: r.account_ref,
        txnDate: must(r.txn_date, "txn_date", r.id),
        valueDate: r.value_date,
        narration: must(r.narration, "narration", r.id),
        reference: r.reference,
        amount: must(r.amount, "amount", r.id),
        currency: must(r.currency, "currency", r.id),
        balance: r.balance,
        originalCurrency: r.original_currency,
        originalAmount: r.original_amount,
        provenance,
        uncertain: r.uncertain as StatementLineDraft["uncertain"],
      };
    case "payroll":
      return {
        kind: "payroll",
        period: must(r.period, "period", r.id),
        employeeRef: must(r.employee_ref, "employee_ref", r.id),
        employeeName: r.employee_name,
        passType: r.pass_type,
        age: r.age,
        ordinaryWage: r.ordinary_wage,
        additionalWage: r.additional_wage,
        grossPay: r.gross_pay,
        cpfEmployee: r.cpf_employee,
        cpfEmployer: r.cpf_employer,
        sdl: r.sdl,
        fwl: r.fwl,
        netPay: r.net_pay,
        provenance,
        uncertain: r.uncertain as PayrollLineDraft["uncertain"],
      };
  }
}

interface ReadRow {
  id: string;
  intake_item_id: string;
  document_id: string;
  document_version_id: string;
  title: string;
  filename: string;
  client_party_id: string | null;
  client_name: string | null;
  reader: Reader | null;
  doc_kind: DocKind;
  status: ReadStatus;
  problem: ReadProblem | null;
  control_ok: boolean | null;
  line_count: number;
  confidence: string | null;
  read_at: string;
}

const READ_COLUMNS = `
  r.id, r.intake_item_id, v.document_id, r.document_version_id, d.title, v.filename,
  r.client_party_id, p.display_name AS client_name, r.reader, r.doc_kind, r.status, r.problem,
  r.control_ok, r.line_count, r.confidence::text AS confidence,
  ${isoInstant("r.created_at", "read_at")}
`;

const READ_FROM = `
  fin.read r
  JOIN files.document_version v ON v.id = r.document_version_id AND v.tenant_id = r.tenant_id
  JOIN files.document d ON d.id = v.document_id AND d.tenant_id = v.tenant_id
  LEFT JOIN core.party p ON p.id = r.client_party_id AND p.tenant_id = r.tenant_id
`;

function toView(r: ReadRow): ReadView {
  return {
    id: r.id,
    intakeItemId: r.intake_item_id,
    documentId: r.document_id,
    documentVersionId: r.document_version_id,
    title: r.title,
    filename: r.filename,
    clientPartyId: r.client_party_id,
    clientName: r.client_name,
    reader: r.reader,
    docKind: r.doc_kind,
    status: r.status,
    problem: r.problem,
    controlOk: r.control_ok,
    lineCount: r.line_count,
    confidence: r.confidence === null ? null : Number(r.confidence),
    readAt: r.read_at,
  };
}

interface DetailRow extends ReadRow {
  control: StoredControl | null;
  model: string | null;
  prompt_version: string | null;
  format_id: string | null;
  format_doc_kind: SheetDocKind | null;
  format_confirmed: boolean | null;
}

export class PostgresReadStore implements ReadStore, ReadQueries {
  constructor(private readonly app: Db) {}

  async unread(
    tenantId: string,
    routes: readonly IntakeRoute[],
    after: string | null,
    limit: number,
  ): Promise<readonly UnreadItem[]> {
    if (routes.length === 0) return [];
    return withTenant(this.app, tenantId, async (db) => {
      const rows = await db<{
        intake_item_id: string;
        document_version_id: string;
        client_party_id: string | null;
        route: IntakeRoute;
        media_type: string;
        filename: string;
      }[]>`
        SELECT i.id AS intake_item_id, i.document_version_id, i.client_party_id, i.route,
               i.media_type, v.filename
          FROM fin.intake_item i
          JOIN files.document_version v ON v.id = i.document_version_id AND v.tenant_id = i.tenant_id
         WHERE i.tenant_id = ${tenantId}
           AND i.route IN ${db(routes as string[])}
           AND NOT EXISTS (
                 SELECT 1 FROM fin.read r WHERE r.tenant_id = i.tenant_id AND r.intake_item_id = i.id
               )
           -- The cursor is the last item this run looked at, compared at that
           -- row's own precision, as the intake list pages.
           AND (${after}::uuid IS NULL OR (i.created_at, i.id) > (
                 SELECT c.created_at, c.id FROM fin.intake_item c WHERE c.id = ${after}::uuid))
         ORDER BY i.created_at, i.id
         LIMIT ${limit}
      `;
      return rows.map((r) => ({
        intakeItemId: r.intake_item_id,
        documentVersionId: r.document_version_id,
        clientPartyId: r.client_party_id,
        route: r.route,
        mediaType: r.media_type,
        filename: r.filename,
      }));
    });
  }

  async insert(read: NewRead, lines: readonly NewLine[]): Promise<boolean> {
    return withTenant(this.app, read.tenantId, async (db) => {
      const created = await db<{ id: string }[]>`
        INSERT INTO fin.read
          (id, tenant_id, intake_item_id, document_version_id, client_party_id, reader, doc_kind,
           status, problem, format_id, control, control_ok, confidence, model, prompt_version,
           line_count)
        VALUES
          (${read.id}, ${read.tenantId}, ${read.intakeItemId}, ${read.documentVersionId},
           ${read.clientPartyId}, ${read.reader}, ${read.docKind}, ${read.status}, ${read.problem},
           ${read.formatId},
           ${read.control === null ? null : db.json(read.control as unknown as Parameters<typeof db.json>[0])},
           ${read.controlOk},
           ${read.confidence === null ? null : String(read.confidence)}::numeric,
           ${read.model}, ${read.promptVersion}, ${lines.length})
        ON CONFLICT ON CONSTRAINT read_once DO NOTHING
        RETURNING id
      `;
      if (created.length === 0) return false;
      if (lines.length === 0) return true;
      // ONE statement for every line, the obligation calendar's
      // `jsonb_to_recordset` shape, with its DOUBLE CAST for its reason: a
      // plain ::jsonb on a string parameter is encoded twice by postgres.js and
      // arrives as a jsonb STRING, not an array.
      await db`
        INSERT INTO fin.transaction_line
          (id, tenant_id, read_id, client_party_id, document_version_id, position, line_kind, page, row_no,
           doc_type, counterparty_name, counterparty_uen, counterparty_gst_no, doc_number, doc_date,
           currency, fx_rate, net, gst_rate, gst, total, service_period_from, service_period_to,
           credit_note_ref,
           statement_type, account_ref, txn_date, value_date, narration, reference, amount, balance,
           original_currency, original_amount,
           period, employee_ref, employee_name, pass_type, age, ordinary_wage, additional_wage,
           gross_pay, cpf_employee, cpf_employer, sdl, fwl, net_pay,
           uncertain, proposed)
        SELECT x.id, ${read.tenantId}, ${read.id}, ${read.clientPartyId}, ${read.documentVersionId},
               x.position, x.line_kind, x.page, x.row_no,
               x.doc_type, x.counterparty_name, x.counterparty_uen, x.counterparty_gst_no, x.doc_number,
               x.doc_date, x.currency, x.fx_rate, x.net, x.gst_rate, x.gst, x.total,
               x.service_period_from, x.service_period_to, x.credit_note_ref,
               x.statement_type, x.account_ref, x.txn_date, x.value_date, x.narration, x.reference,
               x.amount, x.balance, x.original_currency, x.original_amount,
               x.period, x.employee_ref, x.employee_name, x.pass_type, x.age, x.ordinary_wage,
               x.additional_wage, x.gross_pay, x.cpf_employee, x.cpf_employer, x.sdl, x.fwl, x.net_pay,
               coalesce(x.uncertain, '{}'), x.proposed
          FROM jsonb_to_recordset(${JSON.stringify(lines.map(lineRow))}::text::jsonb) AS x(
               id uuid, position int, line_kind text, page int, row_no int,
               doc_type text, counterparty_name text, counterparty_uen text, counterparty_gst_no text,
               doc_number text, doc_date date, currency text, fx_rate numeric, net numeric,
               gst_rate numeric, gst numeric, total numeric, service_period_from date,
               service_period_to date, credit_note_ref text,
               statement_type text, account_ref text, txn_date date, value_date date, narration text,
               reference text, amount numeric, balance numeric, original_currency text,
               original_amount numeric,
               period text, employee_ref text, employee_name text, pass_type text, age int,
               ordinary_wage numeric, additional_wage numeric, gross_pay numeric, cpf_employee numeric,
               cpf_employer numeric, sdl numeric, fwl numeric, net_pay numeric,
               uncertain text[], proposed jsonb)
      `;
      return true;
    });
  }

  async list(tenantId: string, filter: ReadFilter): Promise<readonly ReadView[]> {
    return withTenant(this.app, tenantId, async (db) => {
      await db`SELECT set_config('statement_timeout', ${String(FIN_READ_TIMEOUT_MS)}, true)`;
      const rows = await db<ReadRow[]>`
        SELECT ${db.unsafe(READ_COLUMNS)}
          FROM ${db.unsafe(READ_FROM)}
         WHERE (${filter.clientPartyId}::uuid IS NULL OR r.client_party_id = ${filter.clientPartyId}::uuid)
           AND (${filter.status}::text IS NULL OR r.status = ${filter.status}::text)
           AND (${filter.docKind}::text IS NULL OR r.doc_kind = ${filter.docKind}::text)
           -- An id this firm does not hold matches no row, so the page is
           -- empty rather than another firm's.
           AND (${filter.before}::uuid IS NULL OR (r.created_at, r.id) < (
                 SELECT c.created_at, c.id FROM fin.read c WHERE c.id = ${filter.before}::uuid))
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT ${filter.limit}
      `;
      return rows.map(toView);
    });
  }

  async summary(tenantId: string, clientPartyId: string | null): Promise<ReadSummary> {
    return withTenant(this.app, tenantId, async (db) => {
      await db`SELECT set_config('statement_timeout', ${String(FIN_READ_TIMEOUT_MS)}, true)`;
      const rows = await db<{ status: ReadStatus; doc_kind: DocKind; n: number }[]>`
        SELECT status, doc_kind, count(*)::int AS n
          FROM fin.read
         WHERE (${clientPartyId}::uuid IS NULL OR client_party_id = ${clientPartyId}::uuid)
         GROUP BY status, doc_kind
      `;
      const byStatus = Object.fromEntries(READ_STATUSES.map((s) => [s, 0])) as Record<ReadStatus, number>;
      const byDocKind = Object.fromEntries(DOC_KINDS.map((k) => [k, 0])) as Record<DocKind, number>;
      for (const r of rows) {
        byStatus[r.status] += r.n;
        byDocKind[r.doc_kind] += r.n;
      }
      return { total: rows.reduce((n, r) => n + r.n, 0), byStatus, byDocKind };
    });
  }

  async get(tenantId: string, readId: string): Promise<ReadDetail | null> {
    return withTenant(this.app, tenantId, async (db) => {
      await db`SELECT set_config('statement_timeout', ${String(FIN_READ_TIMEOUT_MS)}, true)`;
      const [read] = await db<DetailRow[]>`
        SELECT ${db.unsafe(READ_COLUMNS)},
               r.control, r.model, r.prompt_version, r.format_id,
               f.doc_kind AS format_doc_kind,
               -- Confirmed when a person has confirmed this LAYOUT, whichever
               -- of its rows the file was read with.
               EXISTS (SELECT 1 FROM fin.source_format c
                        WHERE c.tenant_id = f.tenant_id AND c.fingerprint = f.fingerprint
                          AND c.confirmed_at IS NOT NULL) AS format_confirmed
          FROM ${db.unsafe(READ_FROM)}
          LEFT JOIN fin.source_format f ON f.id = r.format_id AND f.tenant_id = r.tenant_id
         WHERE r.id = ${readId}
      `;
      if (read === undefined) return null;
      const lines = await db<LineDbRow[]>`
        SELECT ${db.unsafe(LINE_COLUMNS)}
          FROM fin.transaction_line
         WHERE read_id = ${readId}
         ORDER BY position
      `;
      return {
        ...toView(read),
        control: read.control,
        model: read.model,
        promptVersion: read.prompt_version,
        format:
          read.format_id === null || read.format_doc_kind === null
            ? null
            : { id: read.format_id, docKind: read.format_doc_kind, confirmed: read.format_confirmed === true },
        lines: lines.map(
          (l): LineView => ({ id: l.id, position: l.position, status: l.status, values: valuesOf(l), proposed: l.proposed }),
        ),
      };
    });
  }
}
