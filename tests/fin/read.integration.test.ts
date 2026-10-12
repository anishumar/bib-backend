// FinCompliance's reads against real Postgres (0386): the properties no fake can
// prove. The sweep end to end (intake, bytes from the blob store, the sheet
// reader, a learnt layout), a second run writing nothing, the tenant wall, the
// composite keys, the CHECKs, the append-only grants and the frozen proposal.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withTenant } from "../../src/db/tenant";
import { systemIds } from "../../src/platform/ids";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { PostgresDocumentStoreRepository } from "../../src/infrastructure/postgres/document-store-repository";
import { FilesystemBlobStore, Sha256ByteDigest } from "../../src/infrastructure/storage/filesystem-blob-store";
import { PostgresFinFirms, PostgresIntakeCandidates, PostgresIntakeRepository } from "../../src/infrastructure/fin/postgres-intake";
import { PostgresFirmCurrency, PostgresReadStore, PostgresSourceFormats } from "../../src/infrastructure/fin/postgres-read";
import { FinSheetGrid } from "../../src/infrastructure/fin/sheet-grid";
import { StoredVersionBytes } from "../../src/infrastructure/fin/version-bytes";
import { LedgerService } from "../../src/usecase/ledger/service";
import { FinIntakeService } from "../../src/usecase/fin/intake";
import { FinReadSweep } from "../../src/usecase/fin/read";
import { FinReadQueries } from "../../src/usecase/fin/read-queries";
import { FinFormatService } from "../../src/usecase/fin/read-formats";
import { SheetDocumentReader } from "../../src/usecase/fin/read-sheet";
import { DOC_KINDS, READERS, READ_PROBLEMS } from "../../src/domain/fin/lines";
import { LINE_STATUSES, READ_STATUSES } from "../../src/domain/fin/read";
import { AMOUNT_STYLES } from "../../src/domain/fin/sheet";
import { SHEET_DOC_KINDS } from "../../src/domain/fin/sheet-kinds";
import { DATE_FORMATS } from "../../src/domain/fin/sheet-values";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 3 });
const stamp = Date.now().toString(36);
const blobs = new FilesystemBlobStore(mkdtempSync(join(tmpdir(), "fin-read-")));
const digest = new Sha256ByteDigest();
const events = new LedgerService({ events: new PostgresEventStore(app), ids: systemIds });
const firms = new PostgresFinFirms(app);
const store = new PostgresReadStore(app);
const formats = new PostgresSourceFormats(app);

const intake = new FinIntakeService({
  firms,
  candidates: new PostgresIntakeCandidates(app),
  items: new PostgresIntakeRepository(app),
  events,
  ids: systemIds,
});
const sweep = new FinReadSweep({
  firms,
  store,
  bytes: new StoredVersionBytes(new PostgresDocumentStoreRepository(app), blobs),
  readers: [
    {
      reader: new SheetDocumentReader({
        grids: new FinSheetGrid(),
        formats,
        currency: new PostgresFirmCurrency(app),
        digest,
        ids: systemIds,
      }),
      routes: ["sheet"],
    },
  ],
  events,
  ids: systemIds,
});
const queries = new FinReadQueries({ firms, reads: store });

const JAN = `Date,Description,Debit,Credit,Balance
10/01/2025,TRANSFER FROM OPERATING A/C 0967,,27800.00,112800.00
14/01/2025,CPF BOARD GIRO CPF + SDL DEC 2024,27739.38,,85060.62
31/01/2025,SALARY JAN RAHMAH BIN OSMAN,10520.00,,74540.62
`;
const FEB = `Date,Description,Debit,Credit,Balance
13/02/2025,TRANSFER FROM OPERATING A/C 0967,,1000.00,75540.62
14/02/2025,CPF BOARD GIRO,900.00,,74640.62
`;
const BROKEN = `Date,Description,Debit,Credit,Balance
13/03/2025,TRANSFER,,1000.00,75640.62
14/03/2025,CPF BOARD GIRO,900.00,,70000.00
`;
const PAYROLL = `Emp ID,Name,NRIC/FIN,Gross Pay,Employee CPF,Net Pay,Employer CPF,SDL
E001,Rahmah bin Osman,S4597193L,12000,1480,10520,1258,11.25
`;
const MASTER = "Account,Name,Type\n1000,Cash at bank,Asset\n";

let firm = "";
let other = "";
let client = "";
const versions: Record<string, string> = {};
const items: Record<string, string> = {};

async function tenant(slug: string): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, status)
    VALUES (${slug}, ${slug}, 'SGD', 'active') RETURNING id
  `;
  return row?.id ?? "";
}

/** A file a client supplied: its bytes in the blob store, its rows in the
 *  document store. */
async function store_(tenantId: string, filename: string, text: string, mediaType = "text/csv"): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = digest.ofBytes(bytes);
  const { storageKey } = await blobs.put({ tenantId, contentHash: hash, bytes });
  const [doc] = await owner<{ id: string }[]>`
    INSERT INTO files.document (tenant_id, title, origin, kind, party_id)
    VALUES (${tenantId}, ${filename}, 'uploaded', 'books_input', ${tenantId === firm ? client : null})
    RETURNING id
  `;
  const [version] = await owner<{ id: string }[]>`
    INSERT INTO files.document_version
      (tenant_id, document_id, version_no, content_hash, byte_size, media_type, filename, storage_key)
    VALUES (${tenantId}, ${doc?.id ?? ""}, 1, ${hash}, ${bytes.length}, ${mediaType}, ${filename}, ${storageKey})
    RETURNING id
  `;
  return version?.id ?? "";
}

async function itemOf(versionId: string): Promise<string> {
  const [row] = await owner<{ id: string }[]>`SELECT id FROM fin.intake_item WHERE document_version_id = ${versionId}`;
  return row?.id ?? "";
}

async function readOf(intakeItemId: string) {
  const [row] = await owner<
    { id: string; status: string; problem: string | null; reader: string | null; doc_kind: string; line_count: number; control_ok: boolean | null; format_id: string | null }[]
  >`SELECT id, status, problem, reader, doc_kind, line_count, control_ok, format_id FROM fin.read WHERE intake_item_id = ${intakeItemId}`;
  return row;
}

beforeAll(async () => {
  firm = await tenant(`fin-read-${stamp}`);
  other = await tenant(`fin-read-other-${stamp}`);
  const [party] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${firm}, 'organization', 'Lumen Cloudworks Pte Ltd') RETURNING id
  `;
  client = party?.id ?? "";
  await owner`UPDATE tenancy.tenant SET fin_enabled_since = now() - interval '1 minute' WHERE id IN (${firm}, ${other})`;

  versions.jan = await store_(firm, "payroll_acct_202501.csv", JAN);
  versions.feb = await store_(firm, "payroll_acct_202502.csv", FEB);
  versions.broken = await store_(firm, "payroll_acct_202503.csv", BROKEN);
  versions.payroll = await store_(firm, "Payroll_Jan2025.csv", PAYROLL);
  versions.master = await store_(firm, "chart_of_accounts.csv", MASTER);
  versions.json = await store_(firm, "company_profile.json", '{"name":"x"}', "application/json");
  versions.pdf = await store_(firm, "INV-1.pdf", "%PDF-1.4", "application/pdf");
  versions.theirs = await store_(other, "statement.csv", JAN);

  await intake.sweepFirm(firm);
  await intake.sweepFirm(other);
  for (const [k, v] of Object.entries(versions)) items[k] = await itemOf(v);
  // Generous: each tenant insert is checked against `pg_timezone_names`, a
  // read of the server's time zone files, which takes seconds on a loaded
  // machine.
}, 240_000);

afterAll(async () => {
  await Promise.all([owner.end({ timeout: 5 }), app.end({ timeout: 5 })]);
});

describe("the read sweep, in Postgres", () => {
  it("reads what a reader takes, stages what agrees, keeps what does not, and leaves the PDF unread", async () => {
    const report = await sweep.sweepFirm(firm);
    expect(report).toMatchObject({ read: 6, staged: 4, needsPerson: 2, failed: 0, failures: [] });
    expect(await readOf(items.jan ?? "")).toMatchObject({ status: "staged", reader: "sheet", doc_kind: "bank_statement", line_count: 3, control_ok: true });
    expect(await readOf(items.broken ?? "")).toMatchObject({ status: "needs_person", problem: "control_mismatch", line_count: 2, control_ok: false });
    expect(await readOf(items.payroll ?? "")).toMatchObject({ status: "staged", doc_kind: "payroll", line_count: 1 });
    expect(await readOf(items.master ?? "")).toMatchObject({ status: "staged", doc_kind: "master", line_count: 0 });
    expect(await readOf(items.json ?? "")).toMatchObject({ status: "needs_person", problem: "no_reader", reader: null, control_ok: null });
    expect(await readOf(items.pdf ?? "")).toBeUndefined();
  });

  it("reads nothing the second time and writes no second event", async () => {
    expect(await sweep.sweepFirm(firm)).toMatchObject({ read: 0, alreadyRead: 0 });
    const [counts] = await owner<{ reads: number; events: number }[]>`
      SELECT (SELECT count(*)::int FROM fin.read WHERE tenant_id = ${firm}) AS reads,
             (SELECT count(*)::int FROM ledger.event WHERE tenant_id = ${firm} AND verb = 'fin.document_read') AS events
    `;
    expect(counts).toEqual({ reads: 6, events: 6 });
  });

  it("learns a layout once, from a file whose figures agree, and reads the next file of it with that map", async () => {
    const learnt = await owner<{ id: string; learnt_from_intake_item_id: string; header: string[]; doc_kind: string }[]>`
      SELECT id, learnt_from_intake_item_id, header, doc_kind FROM fin.source_format
       WHERE tenant_id = ${firm} AND doc_kind = 'bank_statement'
    `;
    expect(learnt).toHaveLength(1);
    expect(learnt[0]).toMatchObject({ learnt_from_intake_item_id: items.jan, header: ["Date", "Description", "Debit", "Credit", "Balance"] });
    expect((await readOf(items.feb ?? ""))?.format_id).toBe(learnt[0]?.id);
    expect((await readOf(items.broken ?? ""))?.format_id).toBe(learnt[0]?.id);
  });

  it("stores money as numeric and every line's proposal as the reader made it", async () => {
    const read = await readOf(items.jan ?? "");
    const lines = await owner<{ amount: string; balance: string; narration: string; proposed: { amount: string; kind: string }; row_no: number; client_party_id: string }[]>`
      SELECT amount::text, balance::text, narration, proposed, row_no, client_party_id
        FROM fin.transaction_line WHERE read_id = ${read?.id ?? ""} ORDER BY position
    `;
    expect(lines.map((l) => [l.amount, l.balance, l.row_no])).toEqual([
      ["27800.00", "112800.00", 2],
      ["-27739.38", "85060.62", 3],
      ["-10520.00", "74540.62", 4],
    ]);
    expect(lines[0]?.proposed).toMatchObject({ kind: "statement", amount: "27800.00" });
    expect(lines[0]?.client_party_id).toBe(client);
    const [payroll] = await owner<{ employee_ref: string; proposed: unknown }[]>`
      SELECT employee_ref, proposed FROM fin.transaction_line l JOIN fin.read r ON r.id = l.read_id
       WHERE r.intake_item_id = ${items.payroll ?? ""}
    `;
    expect(payroll?.employee_ref).toBe("E001");
    expect(JSON.stringify(payroll?.proposed)).not.toContain("S4597193L");
  });

  it("reads back for the screens with names, a page at a time, and one read with its lines", async () => {
    const all = { clientPartyId: null, status: null, docKind: null, before: null } as const;
    const first = await queries.list(firm, { ...all, limit: 4 });
    expect(first.items).toHaveLength(4);
    expect(first.summary).toMatchObject({
      total: 6,
      byStatus: { staged: 4, needs_person: 2, failed: 0 },
      byDocKind: { bank_statement: 3, payroll: 1, master: 1, unknown: 1 },
    });
    const second = await queries.list(firm, { ...all, before: first.nextBefore, limit: 4 });
    expect(second.items).toHaveLength(2);
    expect(second.nextBefore).toBeNull();
    const desk = await queries.list(firm, { ...all, status: "needs_person", limit: 10 });
    expect(desk.items.map((r) => r.problem).sort()).toEqual(["control_mismatch", "no_reader"]);

    const jan = first.items.concat(second.items).find((r) => r.intakeItemId === items.jan);
    expect(jan).toMatchObject({ clientName: "Lumen Cloudworks Pte Ltd", filename: "payroll_acct_202501.csv", lineCount: 3 });
    expect(jan?.readAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const detail = await queries.get(firm, jan?.id ?? "");
    expect(detail.format).toMatchObject({ docKind: "bank_statement", confirmed: false });
    expect(detail.control).toMatchObject({ checked: ["running_balance"], problems: [] });
    expect(detail.lines.map((l) => l.values)).toEqual(detail.lines.map((l) => l.proposed));
    expect(detail.lines[1]?.values).toMatchObject({ kind: "statement", txnDate: "2025-01-14", amount: "-27739.38", currency: "SGD" });
  });

  it("keeps each firm's reads to that firm", async () => {
    await sweep.sweepFirm(other);
    const theirs = await readOf(items.theirs ?? "");
    expect(theirs?.status).toBe("staged");
    // The layout fin learnt at one firm is that firm's: the other learnt its own.
    const [formatsSeen] = await owner<{ n: number }[]>`
      SELECT count(DISTINCT tenant_id)::int AS n FROM fin.source_format WHERE id IN (
        SELECT format_id FROM fin.read WHERE intake_item_id IN (${items.jan ?? ""}, ${items.theirs ?? ""}))
    `;
    expect(formatsSeen?.n).toBe(2);
    const seen = await withTenant(app, other, (db) => db<{ reads: number; lines: number; formats: number }[]>`
      SELECT (SELECT count(*)::int FROM fin.read WHERE tenant_id = ${firm}) AS reads,
             (SELECT count(*)::int FROM fin.transaction_line WHERE tenant_id = ${firm}) AS lines,
             (SELECT count(*)::int FROM fin.source_format WHERE tenant_id = ${firm}) AS formats
    `);
    expect(seen[0]).toEqual({ reads: 0, lines: 0, formats: 0 });
    expect(await store.get(other, (await readOf(items.jan ?? ""))?.id ?? "")).toBeNull();
    const all = { clientPartyId: null, status: null, docKind: null } as const;
    expect((await store.list(firm, { ...all, before: theirs?.id ?? null, limit: 10 }))).toEqual([]);
  });

  it("confirms a layout as a new row, which the next read uses and the detail calls confirmed", async () => {
    const [learnt] = await owner<{ id: string }[]>`
      SELECT id FROM fin.source_format WHERE tenant_id = ${firm} AND doc_kind = 'bank_statement' AND confirmed_at IS NULL
    `;
    const [user] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.user_account (email, display_name) VALUES (${`fin-${stamp}@example.com`}, 'Anish') RETURNING id
    `;
    const service = new FinFormatService({ firms, formats, digest, ids: systemIds, events });
    const confirmed = await service.confirmFormat(firm, learnt?.id ?? "", user?.id ?? "");
    expect(confirmed.created).toBe(true);
    const [fingerprint] = await owner<{ fingerprint: string }[]>`SELECT fingerprint FROM fin.source_format WHERE id = ${learnt?.id ?? ""}`;
    const [current] = await formats.current(firm, [fingerprint?.fingerprint ?? ""]);
    expect(current).toMatchObject({ id: confirmed.formatId, basedOnFormatId: learnt?.id, confirmedByUserId: user?.id });
    expect(current?.confirmedAt).toMatch(/Z$/);
    const jan = await readOf(items.jan ?? "");
    expect((await queries.get(firm, jan?.id ?? "")).format?.confirmed).toBe(true);
  });
});

describe("what the database itself refuses", () => {
  const code = async (p: Promise<unknown>): Promise<string | undefined> =>
    p.then(() => undefined).catch((e: unknown) => (e as { code?: string }).code);

  it("one read per intake item: a second insert conflicts and writes nothing", async () => {
    const created = await store.insert(
      {
        id: systemIds.newId(),
        tenantId: firm,
        intakeItemId: items.jan ?? "",
        documentVersionId: versions.jan ?? "",
        clientPartyId: client,
        reader: null,
        docKind: "unknown",
        status: "needs_person",
        problem: "no_reader",
        formatId: null,
        control: null,
        controlOk: null,
        confidence: null,
        model: null,
        promptVersion: null,
      },
      [],
    );
    expect(created).toBe(false);
  });

  it("refuses a read of another version than its intake item's, and a line off another firm's read", async () => {
    expect(
      await code(withTenant(app, firm, (db) => db`
        INSERT INTO fin.read (tenant_id, intake_item_id, document_version_id, doc_kind, status, problem)
        VALUES (${firm}, ${items.pdf ?? ""}, ${versions.jan ?? ""}, 'unknown', 'needs_person', 'no_reader')
      `)),
    ).toBe("23503");
    const theirs = await readOf(items.theirs ?? "");
    expect(
      await code(withTenant(app, firm, (db) => db`
        INSERT INTO fin.transaction_line (tenant_id, read_id, document_version_id, position, line_kind, doc_type, proposed)
        VALUES (${firm}, ${theirs?.id ?? ""}, ${versions.theirs ?? ""}, 1, 'document', 'receipt', '{"kind":"document"}')
      `)),
    ).toBe("23503");
  });

  it("holds a read's status, problem, reader and control to each other", async () => {
    const insert = (cols: { status: string; problem: string | null; reader: string | null; control_ok?: boolean | null }) =>
      code(owner`
        INSERT INTO fin.read (tenant_id, intake_item_id, document_version_id, reader, doc_kind, status, problem, control, control_ok)
        VALUES (${firm}, ${items.pdf ?? ""}, ${versions.pdf ?? ""}, ${cols.reader}, 'unknown', ${cols.status}, ${cols.problem},
                ${cols.control_ok === undefined || cols.control_ok === null ? null : owner.json({ printed: null })}, ${cols.control_ok ?? null})
      `);
    expect(await insert({ status: "staged", problem: "no_reader", reader: null })).toBe("23514");
    expect(await insert({ status: "needs_person", problem: "unreadable", reader: null })).toBe("23514");
    expect(await insert({ status: "needs_person", problem: "no_reader", reader: "sheet" })).toBe("23514");
    expect(await insert({ status: "needs_person", problem: "control_mismatch", reader: "sheet", control_ok: true })).toBe("23514");
    expect(await insert({ status: "staged", problem: null, reader: "sheet", control_ok: false })).toBe("23514");
    expect(await insert({ status: "staged", problem: null, reader: "sheet" })).toBe("23514");
    expect(await insert({ status: "parked", problem: "unreadable", reader: "sheet" })).toBe("23514");
  });

  it("holds a line to its kind: the fields it requires, and no other kind's", async () => {
    const read = await readOf(items.jan ?? "");
    const insert = (sql: string) =>
      code(owner.unsafe(
        `INSERT INTO fin.transaction_line (tenant_id, read_id, document_version_id, position, ${sql}`,
      ));
    const head = `'${firm}', '${read?.id ?? ""}', '${versions.jan ?? ""}', 99`;
    expect(await insert(`line_kind, statement_type, txn_date, narration, currency, proposed) VALUES (${head}, 'statement', 'bank', '2025-01-01', 'x', 'SGD', '{"kind":"statement"}')`)).toBe("23514");
    expect(await insert(`line_kind, doc_type, employee_ref, proposed) VALUES (${head}, 'document', 'receipt', 'E1', '{"kind":"document"}')`)).toBe("23514");
    expect(await insert(`line_kind, period, employee_ref, currency, proposed) VALUES (${head}, 'payroll', '2025-01', 'E1', 'SGD', '{"kind":"payroll"}')`)).toBe("23514");
    expect(await insert(`line_kind, doc_type, proposed) VALUES (${head}, 'document', 'receipt', '{"kind":"payroll"}')`)).toBe("23514");
    expect(await insert(`line_kind, period, employee_ref, proposed) VALUES (${head}, 'payroll', '2025-13', 'E1', '{"kind":"payroll"}')`)).toBe("23514");
    // And one position per read.
    expect(await insert(`line_kind, doc_type, proposed) VALUES ('${firm}', '${read?.id ?? ""}', '${versions.jan ?? ""}', 1, 'document', 'receipt', '{"kind":"document"}')`)).toBe("23505");
  });

  it("holds a layout's confirmation whole, and learns a fingerprint once per firm", async () => {
    const [row] = await owner<{ fingerprint: string }[]>`SELECT fingerprint FROM fin.source_format WHERE tenant_id = ${firm} LIMIT 1`;
    const insert = (extra: { confirmed_by?: string | null; confirmed_at?: string | null; learnt_from?: string | null; fingerprint?: string }) =>
      code(owner`
        INSERT INTO fin.source_format (tenant_id, fingerprint, container, header, header_row, doc_kind, column_map,
                                       amount_style, learnt_from_intake_item_id, confirmed_by_user_id, confirmed_at)
        VALUES (${firm}, ${extra.fingerprint ?? row?.fingerprint ?? ""}, 'csv', '{Date,Amount}', 1, 'bank_statement', '{}',
                'signed', ${extra.learnt_from ?? null}, ${extra.confirmed_by ?? null}, ${extra.confirmed_at ?? null})
      `);
    expect(await insert({ learnt_from: null })).toBe("23514");
    expect(await insert({ learnt_from: items.jan ?? "", confirmed_at: "2026-10-11T00:00:00Z" })).toBe("23514");
    expect(await insert({ learnt_from: items.jan ?? "" })).toBe("23505");
    expect(await insert({ learnt_from: items.jan ?? "", fingerprint: "not-a-hash" })).toBe("23514");
  });

  it("is append-only for the app role: no UPDATE, no DELETE", async () => {
    for (const table of ["fin.read", "fin.transaction_line", "fin.source_format"]) {
      expect(await code(withTenant(app, firm, (db) => db.unsafe(`UPDATE ${table} SET created_at = now()`))), table).toBe("42501");
      expect(await code(withTenant(app, firm, (db) => db.unsafe(`DELETE FROM ${table}`))), table).toBe("42501");
    }
  });

  it("keeps what the reader proposed for ever, except a name or a narration erased to null", async () => {
    const read = await readOf(items.jan ?? "");
    const [line] = await owner<{ id: string }[]>`
      SELECT id FROM fin.transaction_line WHERE read_id = ${read?.id ?? ""} AND position = 3
    `;
    const id = line?.id ?? "";
    // Rewriting a figure in the proposal is refused, even to the owner role.
    expect(await code(owner`UPDATE fin.transaction_line SET proposed = jsonb_set(proposed, '{amount}', '"1.00"') WHERE id = ${id}`)).toBe("23001");
    // So is rewriting a narration rather than erasing it, and moving the line.
    expect(await code(owner`UPDATE fin.transaction_line SET proposed = jsonb_set(proposed, '{narration}', '"SOMEONE ELSE"') WHERE id = ${id}`)).toBe("23001");
    expect(await code(owner`UPDATE fin.transaction_line SET row_no = 9 WHERE id = ${id}`)).toBe("23001");
    // A person's correction to the line itself is allowed (F2.8 grants it).
    expect(await code(owner`UPDATE fin.transaction_line SET amount = -10500.00 WHERE id = ${id}`)).toBeUndefined();
    // Erasure: the narration names a person, and may be set to null.
    expect(
      await code(owner`UPDATE fin.transaction_line SET narration = '', proposed = jsonb_set(proposed, '{narration}', 'null') WHERE id = ${id}`),
    ).toBeUndefined();
    const [after] = await owner<{ proposed: { narration: string | null; amount: string } }[]>`
      SELECT proposed FROM fin.transaction_line WHERE id = ${id}
    `;
    expect(after?.proposed).toMatchObject({ narration: null, amount: "-10520.00" });
  });
});

describe("the CHECKs and the code name the same things", () => {
  async function checkValues(table: string, constraint: string): Promise<string[]> {
    const [row] = await owner<{ def: string }[]>`
      SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
       WHERE c.conrelid = ${table}::regclass AND c.conname = ${constraint}
    `;
    return [...(row?.def ?? "").matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1] ?? "").sort();
  }

  it.each([
    ["fin.read", "read_reader_check", READERS],
    ["fin.read", "read_doc_kind_check", DOC_KINDS],
    ["fin.read", "read_status_check", READ_STATUSES],
    ["fin.read", "read_problem_check", READ_PROBLEMS],
    ["fin.transaction_line", "transaction_line_status_check", LINE_STATUSES],
    ["fin.transaction_line", "transaction_line_kind_check", ["document", "statement", "payroll"]],
    ["fin.transaction_line", "transaction_line_pass_type_check", ["citizen", "pr", "employment_pass", "s_pass", "work_permit"]],
    ["fin.source_format", "source_format_doc_kind_check", SHEET_DOC_KINDS],
    ["fin.source_format", "source_format_date_format_check", DATE_FORMATS],
    ["fin.source_format", "source_format_amount_style_check", AMOUNT_STYLES],
  ] as const)("%s %s", async (table, constraint, values) => {
    expect(await checkValues(table, constraint)).toEqual([...values].sort());
  });
});
