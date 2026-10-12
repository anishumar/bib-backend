// Reading a sheet into lines (docs/FIN_BUILD_PLAN.md F2.6, the CSV half of
// F2.9, the sheet side of F2.11, F2.12's POS files). Pure.
//
// Three steps, and each can say "a person must look at this" instead of
// guessing:
//
//   1. FIND THE HEADER. Bank exports open with an account block ("Account
//      Name:, …", "Opening Balance:, …") and payroll sheets with a title, so the
//      header is the first row in the first thirty that one kind's vocabulary
//      (`sheet-kinds.ts`) accepts. A row two kinds accept, or one where two
//      columns name the same field, stops the search: that is ambiguity, and
//      the answer is a person's.
//   2. DECIDE THE LAYOUT: which kind of file, which column is which field, how
//      its days are written (`detectDateFormat`: a column that reads as both
//      03/04 and 04/03 is ambiguous, never a coin toss) and how its money is
//      signed. A layout a person confirmed, or one fin learnt from a file whose
//      figures agreed, is reused instead (`fin.source_format`, the use case's).
//   3. READ THE ROWS under the header until the first blank row. A row in that
//      block this reader cannot read sends the whole file to a person: half a
//      statement staged as if it were all of it is worse than none. Below the
//      block, only control figures ("Closing Balance") are read, and a row that
//      looks like another transaction is refused, since a statement with a
//      blank line in the middle would otherwise lose its second half quietly.
//
// What the file prints about itself (opening, closing, a total row, a line
// count) goes into `ReadControl` exactly as printed; `checkControl` compares.
import type {
  Day,
  DocumentFields,
  DocumentLineDraft,
  LineDraft,
  PayrollFields,
  PayrollLineDraft,
  PassType,
  ReadControl,
  SignedDecimal,
  StatementLineDraft,
} from "./lines";
import { isZeroDecimal, negateDecimal, absDecimal, sameDecimal, sumDecimals, subtractDecimals } from "./control";
import {
  EARNINGS,
  PAYROLL_MONEY,
  RECOGNISED_KINDS,
  SHEET_DOC_KINDS,
  accepts,
  fieldsOf,
  masterOf,
} from "./sheet-kinds";
import type { ColumnMap, MasterKind, PayrollField, SheetDocKind } from "./sheet-kinds";
import {
  DATE_FORMATS,
  ageOn,
  collapseText,
  detectDateFormat,
  isNric,
  maskNric,
  maskedNric,
  normaliseHeader,
  parseDay,
  parsePeriod,
  passTypeOf,
  periodInFilename,
  periodInText,
  periodStart,
  readAmount,
} from "./sheet-values";
import type { DateFormat } from "./sheet-values";

export type Grid = readonly (readonly string[])[];

/** Which file a grid came from. Part of a layout's fingerprint: a map learnt
 *  from a CSV is not assumed to fit a workbook with the same words. */
export type SheetContainer = "csv" | "xlsx";

/**
 * How a statement signs its money (a CHECK in 0386 lists the same codes):
 *
 *   signed        one amount column with its own sign ("-52511.84", "(120.00)")
 *   debit_credit  money out in one column, money in in another
 *   cr_dr_suffix  one unsigned column, each figure followed by CR or DR
 *   dr_cr_column  one unsigned column, and a column saying DR or CR
 *
 * Every other kind of sheet is `signed`: each money column is a number with its
 * own sign.
 */
export type AmountStyle = "signed" | "debit_credit" | "cr_dr_suffix" | "dr_cr_column";

export const AMOUNT_STYLES: readonly AmountStyle[] = ["signed", "debit_credit", "cr_dr_suffix", "dr_cr_column"];

export interface SheetLayout {
  readonly docKind: SheetDocKind;
  /** 0-based index of the header row in the grid. */
  readonly headerRow: number;
  /** The header's cells as printed. */
  readonly header: readonly string[];
  readonly columns: ColumnMap;
  /** Null for a layout with no day column, or none filled in yet. */
  readonly dateFormat: DateFormat | null;
  readonly amountStyle: AmountStyle;
}

/** How many rows down the header may be. A bank's preamble is a handful. */
export const HEADER_SEARCH_ROWS = 30;

function isBlank(row: readonly string[] | undefined): boolean {
  return row === undefined || row.every((c) => c.trim() === "");
}

function cell(row: readonly string[] | undefined, column: number | undefined): string {
  return column === undefined || row === undefined ? "" : (row[column] ?? "").trim();
}

/** A row's cells as printed, with the empty ones after the last filled one
 *  dropped (a workbook pads rows to its widest). */
export function headerCells(row: readonly string[]): string[] {
  const cells = row.map((c) => c.trim());
  let end = cells.length;
  while (end > 0 && cells[end - 1] === "") end -= 1;
  return cells.slice(0, end);
}

/**
 * The words a layout is known by: the container and the normalised header
 * cells. Its sha256 is `fin.source_format.fingerprint`. "Txn Date" and
 * "TXN_DATE" are one layout; a column added or moved is another.
 */
export function layoutKey(header: readonly string[], container: SheetContainer): string {
  return `${container}|${header.map(normaliseHeader).join("|")}`;
}

export interface HeaderCandidate {
  /** 0-based. */
  readonly row: number;
  readonly header: readonly string[];
  readonly key: string;
}

/** Every row that could be a header, top first: the rows a stored layout is
 *  looked up by before anything is worked out. */
export function headerCandidates(grid: Grid, container: SheetContainer): HeaderCandidate[] {
  const out: HeaderCandidate[] = [];
  for (let r = 0; r < Math.min(grid.length, HEADER_SEARCH_ROWS); r += 1) {
    const header = headerCells(grid[r] ?? []);
    if (header.filter((c) => c !== "").length < 2) continue;
    out.push({ row: r, header, key: layoutKey(header, container) });
  }
  return out;
}

// ── 1 and 2: recognising a layout ────────────────────────────────────────────

export type Recognition =
  | { readonly kind: "layout"; readonly layout: SheetLayout }
  | { readonly kind: "master"; readonly master: MasterKind; readonly headerRow: number }
  /** Why, in a sentence for the run's log and the tests. The read itself
   *  records only the code (`unrecognised_layout`). */
  | { readonly kind: "unrecognised"; readonly why: string };

function lookup(fields: Readonly<Record<string, readonly string[]>>): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const [field, words] of Object.entries(fields)) for (const w of words) out.set(w, field);
  return out;
}

const LOOKUPS = new Map(SHEET_DOC_KINDS.map((k) => [k, lookup(fieldsOf(k))]));

/** The field a header names in one kind's vocabulary. A trailing number is
 *  tried without it as well ("ServiceCharge10", "GST9"), only when the whole
 *  words name nothing. */
function fieldFor(words: string, kind: SheetDocKind): string | null {
  const table = LOOKUPS.get(kind);
  if (table === undefined || words === "") return null;
  return table.get(words) ?? table.get(words.replace(/\s+\d+$/, "")) ?? null;
}

interface RowMap {
  readonly columns: Record<string, number>;
  readonly duplicated: readonly string[];
}

function mapRow(words: readonly string[], kind: SheetDocKind): RowMap {
  const columns: Record<string, number> = {};
  const duplicated: string[] = [];
  words.forEach((w, i) => {
    const field = fieldFor(w, kind);
    if (field === null) return;
    if (field in columns) duplicated.push(field);
    else columns[field] = i;
  });
  return { columns, duplicated };
}

/** The rows under a header up to the first blank row after one with content:
 *  the block a reader reads. */
function blockRows(grid: Grid, headerRow: number): number[] {
  const rows: number[] = [];
  for (let r = headerRow + 1; r < grid.length; r += 1) {
    if (isBlank(grid[r])) {
      if (rows.length > 0) break;
      continue;
    }
    rows.push(r);
  }
  return rows;
}

const DATE_FIELDS: Readonly<Record<SheetDocKind, readonly string[]>> = {
  bank_statement: ["txnDate", "valueDate"],
  card_statement: ["txnDate", "valueDate"],
  payroll: ["birthDate"],
  cpf_submission: ["birthDate"],
  pos_summary: ["businessDate"],
};

/** Whether the words above a statement, or its header, say it is a card's. */
function mentionsCard(grid: Grid, headerRow: number): boolean {
  for (let r = 0; r <= headerRow; r += 1) {
    if ((grid[r] ?? []).some((c) => /\bcard\b/.test(normaliseHeader(c)))) return true;
  }
  return false;
}

function statementStyle(
  grid: Grid,
  block: readonly number[],
  columns: ColumnMap,
): { readonly style: AmountStyle } | { readonly problem: string } {
  const hasAmount = columns.amount !== undefined;
  if (hasAmount && (columns.debit !== undefined || columns.credit !== undefined)) {
    return { problem: "it has an Amount column AND Debit/Credit columns, so which one is the money is not clear" };
  }
  if (!hasAmount) return { style: "debit_credit" };
  const suffixed = block.some((r) => {
    const a = readAmount(cell(grid[r], columns.amount));
    return a.kind === "amount" && a.suffix !== null;
  });
  if (suffixed) return { style: "cr_dr_suffix" };
  return { style: columns.drCr !== undefined ? "dr_cr_column" : "signed" };
}

function layoutAt(grid: Grid, headerRow: number, recognised: SheetDocKind, columns: ColumnMap): Recognition {
  const block = blockRows(grid, headerRow);
  let docKind = recognised;
  let amountStyle: AmountStyle = "signed";
  if (recognised === "bank_statement") {
    if (mentionsCard(grid, headerRow)) docKind = "card_statement";
    const style = statementStyle(grid, block, columns);
    if ("problem" in style) {
      return { kind: "unrecognised", why: `Row ${String(headerRow + 1)} is a statement header, but ${style.problem}.` };
    }
    amountStyle = style.style;
  }

  const dayCells: string[] = [];
  for (const field of DATE_FIELDS[docKind]) {
    const column = columns[field];
    if (column === undefined) continue;
    for (const r of block) dayCells.push(cell(grid[r], column));
  }
  const found = detectDateFormat(dayCells);
  if (found.kind === "ambiguous") {
    return {
      kind: "unrecognised",
      why: `The days under row ${String(headerRow + 1)} read in more than one way (${found.formats.join(", ")}); a person has to say which.`,
    };
  }
  return {
    kind: "layout",
    layout: {
      docKind,
      headerRow,
      header: headerCells(grid[headerRow] ?? []),
      columns,
      dateFormat: found.kind === "found" ? found.format : null,
      amountStyle,
    },
  };
}

/** What kind of sheet a grid is and how it is laid out, or why that is not
 *  clear. Reads only the grid: a layout stored for the firm is the caller's. */
export function recogniseSheet(grid: Grid): Recognition {
  for (let r = 0; r < Math.min(grid.length, HEADER_SEARCH_ROWS); r += 1) {
    const words = (grid[r] ?? []).map(normaliseHeader);
    if (words.filter((w) => w !== "").length < 2) continue;

    const accepted: { kind: SheetDocKind; columns: ColumnMap }[] = [];
    for (const kind of RECOGNISED_KINDS) {
      const { columns, duplicated } = mapRow(words, kind);
      if (!accepts(kind, new Set(Object.keys(columns)))) continue;
      if (duplicated.length > 0) {
        return {
          kind: "unrecognised",
          why: `Row ${String(r + 1)} has more than one column that could be ${[...new Set(duplicated)].join(", ")}.`,
        };
      }
      accepted.push({ kind, columns });
    }
    if (accepted.length > 1) {
      return {
        kind: "unrecognised",
        why: `Row ${String(r + 1)} reads as more than one kind of sheet (${accepted.map((a) => a.kind).join(", ")}).`,
      };
    }
    const only = accepted[0];
    if (only !== undefined) return layoutAt(grid, r, only.kind, only.columns);

    const master = masterOf(words);
    if (master !== null) return { kind: "master", master, headerRow: r };
  }
  return {
    kind: "unrecognised",
    why: `No row in the first ${String(HEADER_SEARCH_ROWS)} is a header this reader knows.`,
  };
}

/**
 * Whether a column map is one the sheet reader can read with, for a person
 * saving one: the words of a refusal, or null. The recogniser's own rules,
 * applied to a map nobody worked out.
 */
export function layoutProblem(input: {
  readonly docKind: string;
  readonly header: readonly string[];
  readonly columns: Readonly<Record<string, number>>;
  readonly dateFormat: string | null;
  readonly amountStyle: string;
}): string | null {
  if (!(SHEET_DOC_KINDS as readonly string[]).includes(input.docKind)) {
    return `A sheet layout is one of ${SHEET_DOC_KINDS.join(", ")}, not "${input.docKind}".`;
  }
  const kind = input.docKind as SheetDocKind;
  if (input.header.filter((c) => c.trim() !== "").length < 2) {
    return "A header row has at least two filled cells.";
  }
  const fields = fieldsOf(kind);
  const used = new Set<number>();
  for (const [field, column] of Object.entries(input.columns)) {
    if (!(field in fields)) {
      return `"${field}" is not a field of a ${kind.replace("_", " ")}. The fields are: ${Object.keys(fields).join(", ")}.`;
    }
    if (!Number.isInteger(column) || column < 0 || column >= input.header.length) {
      return `"${field}" points at column ${String(column)}, and the header has columns 0 to ${String(input.header.length - 1)}.`;
    }
    if (used.has(column)) return `Column ${String(column)} is given to two fields.`;
    used.add(column);
  }
  if (!accepts(kind, new Set(Object.keys(input.columns)))) {
    return `That map does not name enough columns to read a ${kind.replace("_", " ")}.`;
  }
  if (input.dateFormat !== null && !(DATE_FORMATS as readonly string[]).includes(input.dateFormat)) {
    return `"${input.dateFormat}" is not a day format. The formats are: ${DATE_FORMATS.join(", ")}.`;
  }
  const hasDay = DATE_FIELDS[kind].some((f) => f in input.columns);
  if (hasDay && input.dateFormat === null) return "A layout with a day column says how its days are written.";
  if (!(AMOUNT_STYLES as readonly string[]).includes(input.amountStyle)) {
    return `"${input.amountStyle}" is not an amount style. The styles are: ${AMOUNT_STYLES.join(", ")}.`;
  }
  const statement = kind === "bank_statement" || kind === "card_statement";
  if (!statement && input.amountStyle !== "signed") return "Only a statement signs its money another way than \"signed\".";
  if (statement) {
    const has = (f: string): boolean => f in input.columns;
    const fits =
      (input.amountStyle === "debit_credit" && has("debit") && has("credit") && !has("amount")) ||
      ((input.amountStyle === "signed" || input.amountStyle === "cr_dr_suffix") && has("amount") && !has("debit") && !has("credit")) ||
      (input.amountStyle === "dr_cr_column" && has("amount") && has("drCr") && !has("debit") && !has("credit"));
    if (!fits) return `The amount style "${input.amountStyle}" does not fit the money columns named.`;
  }
  return null;
}

// ── 3: reading the rows ──────────────────────────────────────────────────────

export interface SheetContext {
  readonly documentVersionId: string;
  readonly filename: string;
  /** The currency a statement that prints none is in: the firm's reporting
   *  currency. A statement line's currency is required (`lines.ts`). */
  readonly defaultCurrency: string;
}

export type SheetRead =
  | { readonly ok: true; readonly lines: readonly LineDraft[]; readonly control: ReadControl | null }
  | { readonly ok: false; readonly why: string };

const TOTAL_WORDS = new Set(["total", "totals", "grand total", "sub total", "subtotal", "total amount", "net total"]);

function isTotalRow(row: readonly string[] | undefined): boolean {
  return (row ?? []).some((c) => TOTAL_WORDS.has(normaliseHeader(c)));
}

type ControlKey = "opening" | "closing" | "lineCount" | "account" | "currency" | "period";

const CONTROL_LABELS: Readonly<Record<string, ControlKey>> = {
  "opening balance": "opening",
  "opening bal": "opening",
  opening: "opening",
  "balance b f": "opening",
  "balance bf": "opening",
  "b f": "opening",
  "brought forward": "opening",
  "balance brought forward": "opening",
  "beginning balance": "opening",
  "previous balance": "opening",
  "closing balance": "closing",
  "closing bal": "closing",
  closing: "closing",
  "balance c f": "closing",
  "balance cf": "closing",
  "c f": "closing",
  "carried forward": "closing",
  "balance carried forward": "closing",
  "ending balance": "closing",
  "no of transactions": "lineCount",
  "number of transactions": "lineCount",
  "total transactions": "lineCount",
  "transaction count": "lineCount",
  "no of txns": "lineCount",
  "txn count": "lineCount",
  account: "account",
  "account no": "account",
  "account number": "account",
  "a c no": "account",
  "card no": "account",
  "card number": "account",
  currency: "currency",
  ccy: "currency",
  period: "period",
  month: "period",
  "pay period": "period",
  "payroll month": "period",
  "salary month": "period",
};

interface Labelled {
  readonly key: ControlKey;
  /** The column the label is in. */
  readonly at: number;
  readonly value: string;
}

/** "Label:, value" pairs on a row, as a statement's account block and footer
 *  print them. A row may hold several ("Account, 5154921819, Currency, SGD"). */
function labelled(row: readonly string[] | undefined): Labelled[] {
  const out: Labelled[] = [];
  const cells = row ?? [];
  for (let i = 0; i < cells.length; i += 1) {
    const key = CONTROL_LABELS[normaliseHeader(cells[i] ?? "")];
    if (key === undefined) continue;
    let j = i + 1;
    while (j < cells.length && (cells[j] ?? "").trim() === "") j += 1;
    out.push({ key, at: i, value: (cells[j] ?? "").trim() });
    i = j;
  }
  return out;
}

/** A printed balance or total: CR in, DR out. Null when blank or unreadable. */
function figure(raw: string): SignedDecimal | null {
  const a = readAmount(raw);
  return a.kind === "amount" ? a.value : null;
}

/** An account or card number cut to its last four digits: a card number is
 *  never stored whole, and an account number is cut the same way so the two
 *  are matched alike. */
function lastFour(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function currencyOf(raw: string): string | null {
  const v = raw.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(v)) return v;
  if (v === "S$") return "SGD";
  if (v === "US$") return "USD";
  return null;
}

interface ControlDraft {
  opening: SignedDecimal | null;
  closing: SignedDecimal | null;
  lineCount: number | null;
  declaredTotal: SignedDecimal | null;
}

function controlOf(c: ControlDraft): ReadControl | null {
  if (c.opening === null && c.closing === null && c.lineCount === null && c.declaredTotal === null) return null;
  return { opening: c.opening, closing: c.closing, lineCount: c.lineCount, declaredTotal: c.declaredTotal };
}

/** Sets one printed control figure, refusing two that disagree. */
function setFigure(control: ControlDraft, key: "opening" | "closing", value: SignedDecimal | null, where: string): string | null {
  if (value === null) return `${where}: the ${key} balance is not a figure this reader can read.`;
  const already = control[key];
  if (already !== null && !sameDecimal(already, value)) {
    return `${where}: the file prints two different ${key} balances (${already} and ${value}).`;
  }
  control[key] = value;
  return null;
}

function rowName(r: number): string {
  return `Row ${String(r + 1)}`;
}

function provenance(ctx: SheetContext, r: number): { documentVersionId: string; page: null; row: number } {
  return { documentVersionId: ctx.documentVersionId, page: null, row: r + 1 };
}

/** One statement row's money, in the layout's style. */
function statementAmount(row: readonly string[], layout: SheetLayout): SignedDecimal | "blank" | "bad" {
  const c = layout.columns;
  switch (layout.amountStyle) {
    case "debit_credit": {
      const debit = readAmount(cell(row, c.debit));
      const credit = readAmount(cell(row, c.credit));
      if (debit.kind === "bad" || credit.kind === "bad") return "bad";
      const out = debit.kind === "amount" ? absDecimal(debit.value) : null;
      const inn = credit.kind === "amount" ? absDecimal(credit.value) : null;
      if (out === null && inn === null) return "blank";
      // A bank that prints 0.00 in the column it has nothing for.
      if (out !== null && inn !== null && !isZeroDecimal(out) && !isZeroDecimal(inn)) return "bad";
      if (inn !== null && !isZeroDecimal(inn)) return inn;
      if (out !== null && !isZeroDecimal(out)) return negateDecimal(out);
      return inn ?? out ?? "blank";
    }
    case "signed":
    case "cr_dr_suffix": {
      const a = readAmount(cell(row, c.amount));
      return a.kind === "amount" ? a.value : a.kind;
    }
    case "dr_cr_column": {
      const a = readAmount(cell(row, c.amount));
      if (a.kind !== "amount") return a.kind;
      const side = normaliseHeader(cell(row, c.drCr));
      if (["dr", "d", "debit", "withdrawal", "w"].includes(side)) return negateDecimal(absDecimal(a.value));
      if (["cr", "c", "credit", "deposit"].includes(side)) return absDecimal(a.value);
      return "bad";
    }
  }
}

/** A statement's total row as the net movement it prints: credits less debits,
 *  or the one amount column's total. */
function statementTotal(row: readonly string[], layout: SheetLayout): SignedDecimal | null {
  const c = layout.columns;
  if (layout.amountStyle !== "debit_credit") return figure(cell(row, c.amount));
  const debit = figure(cell(row, c.debit));
  const credit = figure(cell(row, c.credit));
  return debit === null || credit === null ? null : subtractDecimals(absDecimal(credit), absDecimal(debit));
}

function readStatement(grid: Grid, layout: SheetLayout, ctx: SheetContext): SheetRead {
  const c = layout.columns;
  const fmt = layout.dateFormat;
  const control: ControlDraft = { opening: null, closing: null, lineCount: null, declaredTotal: null };
  let accountRef: string | null = null;
  let currency: string | null = null;

  for (let r = 0; r < layout.headerRow; r += 1) {
    for (const l of labelled(grid[r])) {
      if (l.key === "opening" || l.key === "closing") {
        const problem = setFigure(control, l.key, figure(l.value), rowName(r));
        if (problem !== null) return { ok: false, why: problem };
      } else if (l.key === "lineCount" && /^\d+$/.test(l.value)) {
        control.lineCount = Number(l.value);
      } else if (l.key === "account") {
        accountRef = lastFour(l.value) ?? accountRef;
      } else if (l.key === "currency") {
        currency = currencyOf(l.value);
        if (currency === null) return { ok: false, why: `${rowName(r)}: "${l.value}" is not a currency code.` };
      }
    }
  }

  const statementType = layout.docKind === "card_statement" ? "card" : "bank";
  const lines: StatementLineDraft[] = [];
  let inBlock = true;
  for (let r = layout.headerRow + 1; r < grid.length; r += 1) {
    const row = grid[r] ?? [];
    if (isBlank(row)) {
      if (lines.length > 0) inBlock = false;
      continue;
    }

    const labels = labelled(row);
    const label = labels.find((l) => l.key === "opening" || l.key === "closing" || l.key === "lineCount");
    if (label !== undefined && (label.at === c.narration || label.at === c.txnDate || !inBlock || c.narration === undefined)) {
      if (label.key === "lineCount") {
        if (/^\d+$/.test(label.value)) control.lineCount = Number(label.value);
        continue;
      }
      const printed = cell(row, c.balance) !== "" ? cell(row, c.balance) : label.value;
      const problem = setFigure(control, label.key as "opening" | "closing", figure(printed), rowName(r));
      if (problem !== null) return { ok: false, why: problem };
      continue;
    }

    if (isTotalRow(row)) {
      if (control.declaredTotal === null) control.declaredTotal = statementTotal(row, layout);
      inBlock = false;
      continue;
    }

    const txnDate = fmt === null ? null : parseDay(cell(row, c.txnDate), fmt);
    const amount = statementAmount(row, layout);
    if (!inBlock) {
      if (txnDate !== null && amount !== "blank" && amount !== "bad") {
        return { ok: false, why: `${rowName(r)} is a transaction below a blank line; the statement may be in two parts.` };
      }
      continue;
    }
    if (txnDate === null) {
      const narration = collapseText(cell(row, c.narration));
      const last = lines[lines.length - 1];
      if (amount === "blank" && narration !== "" && last !== undefined && cell(row, c.txnDate) === "") {
        // A narration carried onto a second line, as some banks print them.
        lines[lines.length - 1] = { ...last, narration: maskNric(`${last.narration} ${narration}`) };
        continue;
      }
      return { ok: false, why: `${rowName(r)}: "${cell(row, c.txnDate)}" is not a day in this layout's format.` };
    }
    if (amount === "blank" || amount === "bad") {
      return { ok: false, why: `${rowName(r)}: the amount is ${amount === "blank" ? "missing" : "not a figure this reader can read"}.` };
    }
    const balanceCell = cell(row, c.balance);
    const balance = balanceCell === "" ? null : figure(balanceCell);
    if (balanceCell !== "" && balance === null) return { ok: false, why: `${rowName(r)}: the balance is not a figure.` };
    const valueCell = cell(row, c.valueDate);
    const valueDate = valueCell === "" || fmt === null ? null : parseDay(valueCell, fmt);
    if (valueCell !== "" && valueDate === null) return { ok: false, why: `${rowName(r)}: the value date is not a day.` };
    const rowCurrencyCell = cell(row, c.currency);
    const rowCurrency = rowCurrencyCell === "" ? null : currencyOf(rowCurrencyCell);
    if (rowCurrencyCell !== "" && rowCurrency === null) {
      return { ok: false, why: `${rowName(r)}: "${rowCurrencyCell}" is not a currency code.` };
    }
    const reference = collapseText(cell(row, c.reference));

    lines.push({
      kind: "statement",
      statementType,
      accountRef,
      txnDate,
      valueDate,
      narration: maskNric(collapseText(cell(row, c.narration))),
      reference: reference === "" ? null : maskNric(reference),
      amount,
      currency: rowCurrency ?? currency ?? ctx.defaultCurrency,
      balance,
      originalCurrency: null,
      originalAmount: null,
      provenance: provenance(ctx, r),
      uncertain: [],
    });
  }
  return { ok: true, lines, control: controlOf(control) };
}

// ── Payroll ──────────────────────────────────────────────────────────────────

function preamblePeriod(grid: Grid, headerRow: number): string | null {
  for (let r = 0; r < headerRow; r += 1) {
    for (const l of labelled(grid[r])) {
      if (l.key !== "period") continue;
      const p = parsePeriod(l.value) ?? periodInText(l.value);
      if (p !== null) return p;
    }
  }
  for (let r = 0; r < headerRow; r += 1) {
    const p = periodInText((grid[r] ?? []).join(" "));
    if (p !== null) return p;
  }
  return null;
}

function readPayroll(grid: Grid, layout: SheetLayout, ctx: SheetContext): SheetRead {
  const c = layout.columns;
  const fromFile = preamblePeriod(grid, layout.headerRow);
  const fromName = fromFile === null ? periodInFilename(ctx.filename) : null;
  const control: ControlDraft = { opening: null, closing: null, lineCount: null, declaredTotal: null };
  const lines: PayrollLineDraft[] = [];
  const moneyColumns = PAYROLL_MONEY.filter((f) => c[f] !== undefined);

  let inBlock = true;
  for (let r = layout.headerRow + 1; r < grid.length; r += 1) {
    const row = grid[r] ?? [];
    if (isBlank(row)) {
      if (lines.length > 0) inBlock = false;
      continue;
    }
    if (isTotalRow(row)) {
      if (control.declaredTotal === null && c.grossPay !== undefined) control.declaredTotal = figure(cell(row, c.grossPay));
      inBlock = false;
      continue;
    }

    const money = new Map<PayrollField, SignedDecimal | null>();
    let badField: PayrollField | null = null;
    for (const f of moneyColumns) {
      const a = readAmount(cell(row, c[f]));
      if (a.kind === "bad") badField ??= f;
      money.set(f, a.kind === "amount" ? a.value : null);
    }
    const anyMoney = [...money.values()].some((v) => v !== null);
    const id = cell(row, c.employeeRef);
    const name = collapseText(cell(row, c.employeeName));
    const nric = cell(row, c.nric);

    if (!inBlock) {
      if ((id !== "" || name !== "" || nric !== "") && anyMoney && badField === null) {
        return { ok: false, why: `${rowName(r)} is an employee below a blank line; the sheet may be in two parts.` };
      }
      continue;
    }
    if (id === "" && name === "" && nric === "") {
      if (anyMoney) return { ok: false, why: `${rowName(r)} has pay on it and nobody's name or number.` };
      continue;
    }
    if (badField !== null) {
      return { ok: false, why: `${rowName(r)}: "${cell(row, c[badField])}" under ${badField} is not a figure.` };
    }

    const uncertain: (keyof PayrollFields)[] = [];
    let period: string | null = null;
    const periodCell = cell(row, c.period);
    if (periodCell !== "") {
      period = parsePeriod(periodCell);
      if (period === null) return { ok: false, why: `${rowName(r)}: "${periodCell}" is not a month.` };
    } else if (fromFile !== null) {
      period = fromFile;
    } else if (fromName !== null) {
      period = fromName;
      uncertain.push("period");
    }
    if (period === null) {
      return { ok: false, why: "The sheet does not say which month it pays, in a column, a title or its file name." };
    }

    let employeeRef: string;
    if (id !== "") employeeRef = maskNric(id);
    else if (isNric(nric)) employeeRef = maskedNric(nric);
    else if (cell(row, c.serial) !== "") {
      employeeRef = `#${cell(row, c.serial)}`;
      uncertain.push("employeeRef");
    } else {
      employeeRef = `row ${String(r + 1)}`;
      uncertain.push("employeeRef");
    }

    let passType: PassType | null = null;
    const passCell = cell(row, c.passType);
    if (passCell !== "") {
      passType = passTypeOf(passCell);
      if (passType === null) uncertain.push("passType");
    }

    let age: number | null = null;
    const ageCell = cell(row, c.age);
    const birthCell = cell(row, c.birthDate);
    if (ageCell !== "") {
      age = /^\d{1,3}$/.test(ageCell) ? Number(ageCell) : null;
      if (age === null) uncertain.push("age");
    } else if (birthCell !== "") {
      const birth: Day | null = layout.dateFormat === null ? null : parseDay(birthCell, layout.dateFormat);
      age = birth === null ? null : ageOn(birth, periodStart(period));
      if (age === null) uncertain.push("age");
    }

    // A sheet that prints the parts of the pay and no gross: the parts are the
    // gross only when the sheet's own net agrees (gross less the employee's
    // CPF). Otherwise there is a deduction this reader cannot see.
    let grossPay = money.get("grossPay") ?? null;
    if (c.grossPay === undefined && EARNINGS.some((f) => c[f] !== undefined)) {
      const parts = EARNINGS.map((f) => money.get(f) ?? null).filter((v): v is SignedDecimal => v !== null);
      const net = money.get("netPay") ?? null;
      const cpf = money.get("cpfEmployee") ?? null;
      const derived = parts.length === 0 ? null : sumDecimals(parts);
      if (derived !== null && net !== null && cpf !== null && sameDecimal(subtractDecimals(derived, cpf), net)) {
        grossPay = derived;
      } else {
        uncertain.push("grossPay");
      }
    }

    const value = (f: PayrollField): SignedDecimal | null => money.get(f) ?? null;
    lines.push({
      kind: "payroll",
      period,
      employeeRef,
      employeeName: name === "" ? null : maskNric(name),
      passType,
      age,
      ordinaryWage: value("ordinaryWage"),
      additionalWage: value("additionalWage"),
      grossPay,
      cpfEmployee: value("cpfEmployee"),
      cpfEmployer: value("cpfEmployer"),
      sdl: value("sdl"),
      fwl: value("fwl"),
      netPay: value("netPay"),
      provenance: provenance(ctx, r),
      uncertain,
    });
  }
  return { ok: true, lines, control: controlOf(control) };
}

// ── A POS day ────────────────────────────────────────────────────────────────

function readPos(grid: Grid, layout: SheetLayout, ctx: SheetContext): SheetRead {
  const c = layout.columns;
  const fmt = layout.dateFormat;
  const control: ControlDraft = { opening: null, closing: null, lineCount: null, declaredTotal: null };
  let currency: string | null = null;
  for (let r = 0; r < layout.headerRow; r += 1) {
    for (const l of labelled(grid[r])) if (l.key === "currency") currency = currencyOf(l.value) ?? currency;
  }

  const lines: DocumentLineDraft[] = [];
  let inBlock = true;
  for (let r = layout.headerRow + 1; r < grid.length; r += 1) {
    const row = grid[r] ?? [];
    if (isBlank(row)) {
      if (lines.length > 0) inBlock = false;
      continue;
    }
    if (isTotalRow(row)) {
      if (control.declaredTotal === null) control.declaredTotal = figure(cell(row, c.grossTotal));
      inBlock = false;
      continue;
    }
    const docDate = fmt === null ? null : parseDay(cell(row, c.businessDate), fmt);
    if (!inBlock) {
      if (docDate !== null) return { ok: false, why: `${rowName(r)} is a day's takings below a blank line.` };
      continue;
    }
    if (docDate === null) return { ok: false, why: `${rowName(r)}: "${cell(row, c.businessDate)}" is not a day.` };

    const read = (field: string): SignedDecimal | null | "bad" => {
      const a = readAmount(cell(row, c[field]));
      return a.kind === "bad" ? "bad" : a.kind === "amount" ? a.value : null;
    };
    const sales = read("netSales");
    const service = read("serviceCharge");
    const gst = read("gst");
    const total = read("grossTotal");
    if (sales === "bad" || service === "bad" || gst === "bad" || total === "bad") {
      return { ok: false, why: `${rowName(r)}: a figure on it is not one this reader can read.` };
    }

    // GST is charged on the sales AND the service charge, so the amount before
    // GST is both, and it is taken only when the file's own total agrees.
    const uncertain: (keyof DocumentFields)[] = [];
    let net: SignedDecimal | null = null;
    if (sales !== null) {
      const withService = service === null ? sales : sumDecimals([sales, service]);
      if (gst !== null && total !== null && sameDecimal(sumDecimals([withService, gst]), total)) net = withService;
      else if (gst !== null && total !== null && sameDecimal(sumDecimals([sales, gst]), total)) net = sales;
      else uncertain.push("net");
    }

    lines.push({
      kind: "document",
      docType: "pos_summary",
      counterpartyName: null,
      counterpartyUen: null,
      counterpartyGstNo: null,
      docNumber: null,
      docDate,
      currency,
      fxRate: null,
      net,
      gstRate: null,
      gst,
      total,
      servicePeriodFrom: null,
      servicePeriodTo: null,
      creditNoteRef: null,
      provenance: provenance(ctx, r),
      uncertain,
    });
  }
  return { ok: true, lines, control: controlOf(control) };
}

/** A grid read with a layout: its lines and what it printed about itself, or
 *  why a person must read it instead. */
export function readSheet(grid: Grid, layout: SheetLayout, ctx: SheetContext): SheetRead {
  switch (layout.docKind) {
    case "bank_statement":
    case "card_statement":
      return readStatement(grid, layout, ctx);
    case "payroll":
    case "cpf_submission":
      return readPayroll(grid, layout, ctx);
    case "pos_summary":
      return readPos(grid, layout, ctx);
  }
}
