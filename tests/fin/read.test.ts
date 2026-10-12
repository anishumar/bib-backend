// The read sweep and the sheet reader (docs/FIN_BUILD_PLAN.md F2.5, F2.6, the
// wave 3 contract's "Reading flow"), against the fakes: what is offered to
// which reader, what is written and what is not, and what a second run does.
//
// The database's own half (RLS, the CHECKs, the frozen proposal, the unique
// read per item) is tests/fin/read.integration.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FinReadSweep } from "../../src/usecase/fin/read";
import type { RegisteredReader } from "../../src/usecase/fin/read";
import { FinReadQueries } from "../../src/usecase/fin/read-queries";
import { FinFormatService } from "../../src/usecase/fin/read-formats";
import { SheetDocumentReader } from "../../src/usecase/fin/read-sheet";
import { FinSheetGrid } from "../../src/infrastructure/fin/sheet-grid";
import { FinFormatInvalid, FinFormatNotFound, FinNotEnabled, FinReadNotFound } from "../../src/domain/fin/errors";
import type { ReadDraft, StatementLineDraft } from "../../src/domain/fin/lines";
import type { IntakeRoute } from "../../src/domain/fin/intake";
import type { ReadOutcome } from "../../src/usecase/fin/reading";
import { FakeFinFirms, FakeFinIntakeStore } from "../../src/testfakes/fin";
import {
  FakeFirmCurrency,
  FakeReadStore,
  FakeSourceFormats,
  FakeVersionBytes,
  ScriptedReader,
} from "../../src/testfakes/fin-reads";
import { FakeContentDigest } from "../../src/testfakes/filestore";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";

const FIRM = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const USER = "00000000-0000-4000-8000-0000000000e1";

const A_STATEMENT = `Date,Description,Debit,Credit,Balance
10/01/2025,TRANSFER FROM OPERATING A/C 0967,,27800.00,112800.00
14/01/2025,CPF BOARD GIRO CPF + SDL DEC 2024,27739.38,,85060.62
31/01/2025,SALARY JAN RAHMAH BIN OSMAN,10520.00,,74540.62
`;
const A_STATEMENT_FEB = `Date,Description,Debit,Credit,Balance
13/02/2025,TRANSFER FROM OPERATING A/C 0967,,1000.00,75540.62
14/02/2025,CPF BOARD GIRO,900.00,,74640.62
`;
/** The same layout, its running balance broken on the second line. */
const BROKEN = `Date,Description,Debit,Credit,Balance
13/02/2025,TRANSFER,,1000.00,75540.62
14/02/2025,CPF BOARD GIRO,900.00,,70000.00
`;
/** Days that read either way: only a stored layout can say which. */
const AMBIGUOUS_DAYS = `Date,Description,Debit,Credit,Balance
03/04/2025,TRANSFER,,1000.00,2000.00
05/04/2025,FEE,10.00,,1990.00
`;
const MASTER = "Account,Name,Type\n1000,Cash at bank,Asset\n";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

let n = 0;
function nextId(prefix: string): string {
  n += 1;
  return `00000000-0000-4000-8000-${prefix}${n.toString(16).padStart(11, "0")}`;
}

function world(opts: { readers?: (w: World) => RegisteredReader[]; batchSize?: number } = {}) {
  const firms = new FakeFinFirms();
  firms.enabled.add(FIRM);
  const intake = new FakeFinIntakeStore();
  const store = new FakeReadStore(intake);
  const blobs = new FakeVersionBytes();
  const formats = new FakeSourceFormats();
  const events = new RecordingEventSink();
  const ids = new FakeIds();
  const sheet = new SheetDocumentReader({
    grids: new FinSheetGrid(),
    formats,
    currency: new FakeFirmCurrency("SGD"),
    digest: new FakeContentDigest(),
    ids,
  });
  const w = { firms, intake, store, blobs, formats, events, ids, sheet } as World;
  const sweep = new FinReadSweep({
    firms,
    store,
    bytes: blobs,
    readers: opts.readers?.(w) ?? [{ reader: sheet, routes: ["sheet"] }],
    events,
    ids,
    ...(opts.batchSize === undefined ? {} : { batchSize: opts.batchSize }),
  });
  return { ...w, sweep };
}

interface World {
  firms: FakeFinFirms;
  intake: FakeFinIntakeStore;
  store: FakeReadStore;
  blobs: FakeVersionBytes;
  formats: FakeSourceFormats;
  events: RecordingEventSink;
  ids: FakeIds;
  sheet: SheetDocumentReader;
}

/** A file taken in: an intake item, its version's bytes, its name. */
function take(
  w: World,
  over: { text?: string; route?: IntakeRoute; filename?: string; tenantId?: string; mediaType?: string } = {},
): string {
  const tenantId = over.tenantId ?? FIRM;
  const versionId = nextId("1");
  const intakeItemId = nextId("2");
  const filename = over.filename ?? "statement.csv";
  w.intake.files.push({
    tenantId,
    documentId: nextId("3"),
    documentVersionId: versionId,
    clientPartyId: CLIENT,
    mediaType: over.mediaType ?? "text/csv",
    byteSize: 100,
    filename,
    title: filename,
    kind: "books_input",
    origin: "uploaded",
  });
  w.intake.items.push({
    id: intakeItemId,
    tenantId,
    documentVersionId: versionId,
    clientPartyId: CLIENT,
    mediaType: over.mediaType ?? "text/csv",
    byteSize: 100,
    route: over.route ?? "sheet",
    routeBasis: over.route === "manual" ? "none" : "media_type",
  });
  if (over.text !== undefined) w.blobs.put(tenantId, versionId, bytes(over.text));
  return intakeItemId;
}

function readOf(w: World, intakeItemId: string) {
  return w.store.reads.find((r) => r.intakeItemId === intakeItemId);
}

describe("the read sweep", () => {
  it("reads a sheet into lines, stages them, and says so in the ledger with ids and codes only", async () => {
    const w = world();
    const item = take(w, { text: A_STATEMENT });
    const [report] = await w.sweep.sweep();
    expect(report).toMatchObject({ tenantId: FIRM, read: 1, staged: 1, needsPerson: 0, failed: 0, lines: 3, more: false });
    const read = readOf(w, item);
    expect(read).toMatchObject({ reader: "sheet", docKind: "bank_statement", status: "staged", problem: null, controlOk: true });
    expect(read?.control).toMatchObject({ checked: ["running_balance"], problems: [] });
    const lines = w.store.lines.get(read?.id ?? "") ?? [];
    expect(lines.map((l) => l.position)).toEqual([1, 2, 3]);
    expect(lines[2]?.draft).toMatchObject({ kind: "statement", amount: "-10520.00", provenance: { row: 4 } });

    expect(w.events.verbs()).toEqual(["fin.document_read"]);
    const event = w.events.recorded[0];
    expect(event?.payload).toEqual({
      readId: read?.id,
      intakeItemId: item,
      documentVersionId: read?.documentVersionId,
      reader: "sheet",
      docKind: "bank_statement",
      status: "staged",
      problem: null,
      lineCount: 3,
      controlOk: true,
    });
    // A narration names a person; the ledger cannot be erased.
    expect(JSON.stringify(event?.payload)).not.toContain("RAHMAH");
  });

  it("reads nothing the second time and writes no second event", async () => {
    const w = world();
    take(w, { text: A_STATEMENT });
    await w.sweep.sweep();
    const [again] = await w.sweep.sweep();
    expect(again).toMatchObject({ read: 0, alreadyRead: 0 });
    expect(w.store.reads).toHaveLength(1);
    expect(w.events.verbs()).toHaveLength(1);
  });

  it("counts an item another run read first, and writes no event for it", async () => {
    const w = world();
    const raced = take(w, { text: A_STATEMENT });
    take(w, { text: A_STATEMENT_FEB });
    w.store.raced.add(raced);
    const [report] = await w.sweep.sweep();
    expect(report).toMatchObject({ read: 1, alreadyRead: 1 });
    expect(w.events.verbs()).toHaveLength(1);
  });

  it("puts a file no reader takes on a person's desk without opening it", async () => {
    const w = world();
    const item = take(w, { route: "manual", filename: "company_profile.json", mediaType: "application/json" });
    const [report] = await w.sweep.sweep();
    expect(report).toMatchObject({ read: 1, needsPerson: 1, byProblem: { no_reader: 1 } });
    expect(readOf(w, item)).toMatchObject({ reader: null, docKind: "unknown", status: "needs_person", problem: "no_reader", control: null });
    expect(w.blobs.fetched).toBe(0);
  });

  it("leaves a file of a route with no reader unread, rather than parking it for want of code", async () => {
    const w = world();
    take(w, { route: "pdf", filename: "INV-1.pdf", mediaType: "application/pdf", text: "%PDF-" });
    take(w, { route: "image", filename: "IMG_1.jpg", mediaType: "image/jpeg", text: "x" });
    const [report] = await w.sweep.sweep();
    expect(report).toMatchObject({ read: 0, later: 0 });
    expect(w.store.reads).toHaveLength(0);
  });

  it("offers a file to the readers in order, and the first that is not `not_mine` decides", async () => {
    const pdfText = new ScriptedReader("pdf_text", () => ({ kind: "not_mine" }));
    const vision = new ScriptedReader("vision", () => ({ kind: "needs_person", reader: "vision", problem: "ai_invalid_output" }));
    const w = world({
      readers: (x) => [
        { reader: x.sheet, routes: ["sheet"] },
        { reader: pdfText, routes: ["pdf"] },
        { reader: vision, routes: ["pdf", "image"] },
      ],
    });
    const item = take(w, { route: "pdf", filename: "scan.pdf", text: "%PDF-" });
    await w.sweep.sweep();
    expect(pdfText.offered).toEqual([item]);
    expect(vision.offered).toEqual([item]);
    expect(readOf(w, item)).toMatchObject({ reader: "vision", status: "needs_person", problem: "ai_invalid_output" });
  });

  it("calls a file every reader passes on `no_reader`", async () => {
    const pass = new ScriptedReader("pdf_text", () => ({ kind: "not_mine" }));
    const w = world({ readers: () => [{ reader: pass, routes: ["pdf"] }] });
    const item = take(w, { route: "pdf", text: "%PDF-" });
    await w.sweep.sweep();
    expect(readOf(w, item)).toMatchObject({ reader: null, problem: "no_reader" });
  });

  it("writes nothing for `later`, rests that reader for the run, and offers the file again next run", async () => {
    let configured = false;
    const vision = new ScriptedReader("vision", (): ReadOutcome =>
      configured
        ? { kind: "needs_person", reader: "vision", problem: "unreadable" }
        : { kind: "later", reader: "vision", reason: "ai_unavailable" },
    );
    const w = world({ readers: (x) => [{ reader: x.sheet, routes: ["sheet"] }, { reader: vision, routes: ["image"] }] });
    const photos = [take(w, { route: "image", text: "a" }), take(w, { route: "image", text: "b" })];
    const sheetFile = take(w, { text: A_STATEMENT });

    const [first] = await w.sweep.sweep();
    expect(first).toMatchObject({ read: 1, later: 2 });
    // Asked once; the second photo waited on a resting reader, unfetched.
    expect(vision.offered).toEqual([photos[0]]);
    expect(w.blobs.fetched).toBe(2);
    expect(readOf(w, sheetFile)?.status).toBe("staged");
    expect(w.store.reads).toHaveLength(1);

    configured = true;
    const [second] = await w.sweep.sweep();
    expect(second).toMatchObject({ read: 2, later: 0 });
  });

  it("is not starved by items it leaves for later: the cursor walks past them", async () => {
    const vision = new ScriptedReader("vision", () => ({ kind: "later", reader: "vision", reason: "ai_budget_reached" }));
    const w = world({
      batchSize: 2,
      readers: (x) => [{ reader: x.sheet, routes: ["sheet"] }, { reader: vision, routes: ["image"] }],
    });
    for (let i = 0; i < 5; i += 1) take(w, { route: "image", text: "x" });
    const statement = take(w, { text: A_STATEMENT });
    const [report] = await w.sweep.sweep();
    expect(report).toMatchObject({ read: 1, later: 5 });
    expect(readOf(w, statement)?.status).toBe("staged");
    expect(w.store.pages.map((p) => p.after)).toEqual([null, w.intake.items[1]?.id, w.intake.items[3]?.id, statement]);
  });

  it("finishes a large batch over several runs, and says more is waiting", async () => {
    const w = world({ batchSize: 2 });
    take(w, { text: A_STATEMENT });
    take(w, { text: A_STATEMENT_FEB });
    take(w, { text: MASTER, filename: "chart_of_accounts.csv" });
    expect((await w.sweep.sweep())[0]).toMatchObject({ read: 2, more: true });
    expect((await w.sweep.sweep())[0]).toMatchObject({ read: 1, more: false });
  });

  it("parks a file a reader throws on as failed, so it is not offered for ever", async () => {
    const thrower = new ScriptedReader("pdf_text", () => {
      throw new Error("a font table the parser does not know");
    });
    const w = world({ readers: () => [{ reader: thrower, routes: ["pdf"] }] });
    const item = take(w, { route: "pdf", text: "%PDF-" });
    const [report] = await w.sweep.sweep();
    expect(report).toMatchObject({ read: 1, failed: 1, byProblem: { unreadable: 1 } });
    expect(report?.failures).toEqual([{ intakeItemId: item, reader: "pdf_text", error: "a font table the parser does not know" }]);
    expect(readOf(w, item)).toMatchObject({ reader: "pdf_text", status: "failed", problem: "unreadable" });
    expect((await w.sweep.sweep())[0]).toMatchObject({ read: 0, failures: [] });
    expect(thrower.offered).toEqual([item]);
  });

  it("leaves a file whose bytes are missing unread, reports it, and goes on with the next", async () => {
    const w = world();
    const missing = take(w, {});
    const fine = take(w, { text: A_STATEMENT });
    const [report] = await w.sweep.sweep();
    expect(report?.failures).toEqual([
      { intakeItemId: missing, reader: null, error: expect.stringContaining("missing from the store") },
    ]);
    expect(readOf(w, missing)).toBeUndefined();
    expect(readOf(w, fine)?.status).toBe("staged");
  });

  it("leaves a file the database refuses unread, for the next run", async () => {
    const w = world();
    const refused = take(w, { text: A_STATEMENT });
    w.store.refused.add(refused);
    const [report] = await w.sweep.sweep();
    expect(report).toMatchObject({ read: 0, failures: [{ intakeItemId: refused, reader: null }] });
    w.store.refused.clear();
    expect((await w.sweep.sweep())[0]).toMatchObject({ read: 1 });
  });

  it("keeps a read whose figures disagree, lines and all, and sends it to a person", async () => {
    const w = world();
    const item = take(w, { text: BROKEN });
    const [report] = await w.sweep.sweep();
    expect(report).toMatchObject({ read: 1, needsPerson: 1, lines: 2, byProblem: { control_mismatch: 1 } });
    const read = readOf(w, item);
    expect(read).toMatchObject({ status: "needs_person", problem: "control_mismatch", controlOk: false });
    expect(read?.control?.problems).toEqual([{ check: "running_balance", position: 2, expected: "70000.00", actual: "74640.62" }]);
    expect(w.store.lines.get(read?.id ?? "")).toHaveLength(2);
  });

  it("checks the control figures of every reader's draft, not only its own", async () => {
    const draft: ReadDraft = {
      docKind: "bank_statement",
      reader: "pdf_text",
      lines: [
        {
          kind: "statement",
          statementType: "bank",
          accountRef: "0967",
          txnDate: "2025-01-10",
          valueDate: null,
          narration: "X",
          reference: null,
          amount: "10.00",
          currency: "SGD",
          balance: null,
          originalCurrency: null,
          originalAmount: null,
          provenance: { documentVersionId: "v", page: 1, row: null },
          uncertain: [],
        } satisfies StatementLineDraft,
      ],
      control: { opening: "100.00", closing: "120.00", lineCount: 1, declaredTotal: null },
      confidence: null,
      model: null,
      promptVersion: null,
      formatId: null,
    };
    const pdf = new ScriptedReader("pdf_text", () => ({ kind: "read", draft }));
    const w = world({ readers: () => [{ reader: pdf, routes: ["pdf"] }] });
    const item = take(w, { route: "pdf", text: "%PDF-" });
    await w.sweep.sweep();
    expect(readOf(w, item)).toMatchObject({ reader: "pdf_text", status: "needs_person", problem: "control_mismatch" });
  });

  it("does not take a reader's word for control_mismatch or no_reader", async () => {
    const liar = new ScriptedReader("vision", () => ({ kind: "needs_person", reader: "vision", problem: "control_mismatch" }));
    const passer = new ScriptedReader("pdf_text", () => ({ kind: "needs_person", reader: "pdf_text", problem: "no_reader" }));
    const w = world({ readers: () => [{ reader: passer, routes: ["pdf"] }, { reader: liar, routes: ["pdf"] }] });
    const item = take(w, { route: "pdf", text: "%PDF-" });
    const [report] = await w.sweep.sweep();
    expect(liar.offered).toEqual([item]);
    expect(readOf(w, item)).toMatchObject({ reader: "vision", status: "failed", problem: "unreadable" });
    expect(report?.failures[0]?.error).toContain("only the sweep decides");
  });

  it("recognises a master and stages it with no lines, for F3.1's import", async () => {
    const w = world();
    const item = take(w, { text: MASTER, filename: "chart_of_accounts.csv" });
    await w.sweep.sweep();
    expect(readOf(w, item)).toMatchObject({ reader: "sheet", docKind: "master", status: "staged", problem: null, controlOk: true, formatId: null });
    expect(w.store.lines.get(readOf(w, item)?.id ?? "")).toEqual([]);
  });

  it("sends a sheet it cannot map, and one it cannot open, to a person", async () => {
    const w = world();
    const odd = take(w, { text: "Foo,Bar\n1,2\n" });
    const xls = take(w, { text: "", filename: "old.xls" });
    w.blobs.put(FIRM, w.intake.items.find((i) => i.id === xls)?.documentVersionId ?? "", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1]));
    await w.sweep.sweep();
    expect(readOf(w, odd)).toMatchObject({ status: "needs_person", problem: "unrecognised_layout", reader: "sheet" });
    expect(readOf(w, xls)).toMatchObject({ status: "needs_person", problem: "unreadable", reader: "sheet" });
  });

  it("keeps each firm's files to that firm, and one firm's failure from stopping another", async () => {
    const w = world();
    w.firms.enabled.add(OTHER);
    take(w, { text: A_STATEMENT });
    const theirs = take(w, { text: A_STATEMENT, tenantId: OTHER });
    w.store.broken.add(FIRM);
    const reports = await w.sweep.sweep();
    expect(reports.find((r) => r.tenantId === FIRM)?.failure).toContain("unreadable");
    expect(reports.find((r) => r.tenantId === OTHER)).toMatchObject({ read: 1 });
    expect(w.store.reads.map((r) => r.intakeItemId)).toEqual([theirs]);
  });

  it("does nothing for a firm that has not switched fin on", async () => {
    const w = world();
    w.firms.enabled.clear();
    take(w, { text: A_STATEMENT });
    expect(await w.sweep.sweep()).toEqual([]);
  });
});

describe("the sheet reader's layouts", () => {
  it("learns a layout from a file whose figures agree, and reads the next file of it with that map", async () => {
    const w = world();
    const jan = take(w, { text: A_STATEMENT });
    const feb = take(w, { text: A_STATEMENT_FEB });
    await w.sweep.sweep();
    expect(w.formats.rows).toHaveLength(1);
    const learnt = w.formats.rows[0];
    expect(learnt).toMatchObject({
      docKind: "bank_statement",
      container: "csv",
      headerRow: 1,
      columns: { txnDate: 0, narration: 1, debit: 2, credit: 3, balance: 4 },
      dateFormat: "dmy",
      amountStyle: "debit_credit",
      learntFromIntakeItemId: jan,
      confirmedByUserId: null,
    });
    expect(learnt?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(readOf(w, jan)?.formatId).toBe(learnt?.id);
    expect(readOf(w, feb)?.formatId).toBe(learnt?.id);
  });

  it("does not learn a layout from a file whose figures disagree", async () => {
    const w = world();
    const item = take(w, { text: BROKEN });
    await w.sweep.sweep();
    expect(w.formats.rows).toHaveLength(0);
    expect(readOf(w, item)?.formatId).toBeNull();
  });

  it("reads days that are ambiguous on their own the way a person's confirmed layout says", async () => {
    const w = world();
    const first = take(w, { text: AMBIGUOUS_DAYS });
    await w.sweep.sweep();
    expect(readOf(w, first)).toMatchObject({ problem: "unrecognised_layout" });

    const formats = new FinFormatService({
      firms: w.firms,
      formats: w.formats,
      digest: new FakeContentDigest(),
      ids: w.ids,
      events: w.events,
    });
    await formats.saveFormat(
      FIRM,
      {
        container: "csv",
        header: ["Date", "Description", "Debit", "Credit", "Balance"],
        headerRow: 1,
        docKind: "bank_statement",
        columns: { txnDate: 0, narration: 1, debit: 2, credit: 3, balance: 4 },
        dateFormat: "dmy",
        amountStyle: "debit_credit",
      },
      USER,
    );
    const second = take(w, { text: AMBIGUOUS_DAYS });
    await w.sweep.sweep();
    const read = readOf(w, second);
    expect(read).toMatchObject({ status: "staged", formatId: w.formats.rows[0]?.id });
    expect(w.store.lines.get(read?.id ?? "")?.[0]?.draft).toMatchObject({ txnDate: "2025-04-03" });
  });
});

describe("a payroll workbook", () => {
  // Company D's October register from the training pack (synthetic people):
  // gross and net are live formulas, saved with their values, and one
  // employee's SDL is the pack's seeded error (0.00).
  const workbook = new Uint8Array(readFileSync(join(__dirname, "fixtures", "PR_register_2025-10.xlsx")));

  it("reads formulas as their saved values, the period from the title, and the total row as the declared gross", async () => {
    const w = world();
    const item = take(w, { filename: "PR_register_2025-10.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    w.blobs.put(FIRM, w.intake.items.find((i) => i.id === item)?.documentVersionId ?? "", workbook);
    await w.sweep.sweep();
    const read = readOf(w, item);
    expect(read).toMatchObject({ reader: "sheet", docKind: "payroll", status: "staged", controlOk: true });
    expect(read?.control?.printed).toMatchObject({ declaredTotal: "58018.36" });
    const lines = (w.store.lines.get(read?.id ?? "") ?? []).map((l) => l.draft);
    expect(lines).toHaveLength(10);
    expect(lines[0]).toMatchObject({
      kind: "payroll",
      period: "2025-10",
      employeeRef: "*****012M",
      employeeName: "Wong Jia Hui",
      grossPay: "11000",
      cpfEmployee: "1480",
      cpfEmployer: "1258",
      netPay: "9520",
      uncertain: [],
    });
    expect(lines[3]).toMatchObject({ employeeName: "Yeo Mei Ling", sdl: "0" });
    expect(JSON.stringify(lines)).not.toMatch(/[STFG]\d{7}[A-Z]/);
    expect(w.formats.rows[0]).toMatchObject({ container: "xlsx", docKind: "payroll", headerRow: 3 });
  });
});

describe("a person confirming a layout", () => {
  function formatsOf(w: World) {
    return new FinFormatService({ firms: w.firms, formats: w.formats, digest: new FakeContentDigest(), ids: w.ids, events: w.events });
  }

  it("confirms what fin learnt as a new row, keeping the learnt one, once", async () => {
    const w = world();
    take(w, { text: A_STATEMENT });
    await w.sweep.sweep();
    const learnt = w.formats.rows[0];
    const service = formatsOf(w);
    const confirmed = await service.confirmFormat(FIRM, learnt?.id ?? "", USER);
    expect(confirmed.created).toBe(true);
    expect(w.formats.rows).toHaveLength(2);
    expect(w.formats.rows[1]).toMatchObject({ basedOnFormatId: learnt?.id, confirmedByUserId: USER, columns: learnt?.columns });
    expect(w.events.recorded.at(-1)).toMatchObject({
      verb: "fin.format_confirmed",
      actorType: "human",
      actorId: USER,
      payload: { formatId: confirmed.formatId, basedOnFormatId: learnt?.id, docKind: "bank_statement" },
    });
    // The confirmed row is what the next file is read with.
    const next = take(w, { text: A_STATEMENT_FEB });
    await w.sweep.sweep();
    expect(readOf(w, next)?.formatId).toBe(confirmed.formatId);
    // Confirming again, or saving the same map, writes nothing.
    expect(await service.confirmFormat(FIRM, learnt?.id ?? "", USER)).toEqual({ formatId: confirmed.formatId, created: false });
    expect(await service.confirmFormat(FIRM, confirmed.formatId, USER)).toEqual({ formatId: confirmed.formatId, created: false });
    expect(w.formats.rows).toHaveLength(2);
  });

  it("refuses a map the reader could not read with, in words", async () => {
    const service = formatsOf(world());
    const base = {
      container: "csv",
      header: ["Date", "Description", "Amount"],
      headerRow: 1,
      docKind: "bank_statement",
      columns: { txnDate: 0, narration: 1, amount: 2 },
      dateFormat: "iso",
      amountStyle: "signed",
    };
    await expect(service.saveFormat(FIRM, { ...base, container: "ods" }, USER)).rejects.toBeInstanceOf(FinFormatInvalid);
    await expect(service.saveFormat(FIRM, { ...base, headerRow: 0 }, USER)).rejects.toBeInstanceOf(FinFormatInvalid);
    await expect(service.saveFormat(FIRM, { ...base, columns: { txnDate: 0 } }, USER)).rejects.toThrow("enough columns");
    expect((await service.saveFormat(FIRM, base, USER)).created).toBe(true);
  });

  it("answers not found for a layout that is not this firm's, and not there for a firm with fin off", async () => {
    const w = world();
    const service = formatsOf(w);
    await expect(service.confirmFormat(FIRM, "00000000-0000-4000-8000-00000000dead", USER)).rejects.toBeInstanceOf(FinFormatNotFound);
    await expect(service.confirmFormat(OTHER, "00000000-0000-4000-8000-00000000dead", USER)).rejects.toBeInstanceOf(FinNotEnabled);
  });
});

describe("reading the reads", () => {
  function queriesOf(w: World) {
    return new FinReadQueries({ firms: w.firms, reads: w.store });
  }
  const ALL = { clientPartyId: null, status: null, docKind: null, before: null } as const;

  it("lists newest first, pages without skipping, and counts the whole set by status and kind", async () => {
    const w = world();
    take(w, { text: A_STATEMENT });
    take(w, { text: BROKEN });
    take(w, { text: MASTER });
    await w.sweep.sweep();
    const q = queriesOf(w);
    const first = await q.list(FIRM, { ...ALL, limit: 2 });
    expect(first.items.map((r) => r.docKind)).toEqual(["master", "bank_statement"]);
    expect(first.summary).toMatchObject({
      total: 3,
      byStatus: { staged: 2, needs_person: 1, failed: 0 },
      byDocKind: { bank_statement: 2, master: 1, payroll: 0 },
    });
    const second = await q.list(FIRM, { ...ALL, before: first.nextBefore, limit: 2 });
    expect(second.items).toHaveLength(1);
    expect(second.nextBefore).toBeNull();
    const desk = await q.list(FIRM, { ...ALL, status: "needs_person", limit: 10 });
    expect(desk.items.map((r) => r.problem)).toEqual(["control_mismatch"]);
    // The counts follow the client, never the status being looked at.
    expect(desk.summary.total).toBe(3);
  });

  it("reads one read with its lines, and refuses one that is not there", async () => {
    const w = world();
    take(w, { text: A_STATEMENT });
    await w.sweep.sweep();
    const q = queriesOf(w);
    const id = w.store.reads[0]?.id ?? "";
    const detail = await q.get(FIRM, id);
    expect(detail.lines).toHaveLength(3);
    expect(detail.lines[0]?.proposed).toEqual(detail.lines[0]?.values);
    await expect(q.get(FIRM, "00000000-0000-4000-8000-00000000dead")).rejects.toBeInstanceOf(FinReadNotFound);
    await expect(q.get(OTHER, id)).rejects.toBeInstanceOf(FinNotEnabled);
  });
});
