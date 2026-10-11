// A bank or card statement PDF, read into statement lines (docs/FIN_BUILD_PLAN.md
// F2.9 PDF half, F2.10). Pure, over the positioned text the PDF port returns;
// the reader that calls it is `usecase/fin/statement-pdf-reader.ts`.
//
// ── THREE ANSWERS, AND WHICH IS WHICH ────────────────────────────────────────
//
//   not_statement   no statement here: an invoice, a receipt, a scan. The next
//                   reader (the AI reader) is offered it.
//   unrecognised    it IS a statement (it says so, and names a bank or a card)
//                   and its table could not be read: no header this knows, a
//                   date with no year and no period, an amount whose sign
//                   cannot be told. A person reads it.
//   statement       the lines, and the figures the statement prints about
//                   itself (opening and closing balance) for the read sweep to
//                   check them against. The parser does not check its own sums:
//                   the control check is the sweep's, the same for every reader,
//                   and a read that does not add up goes to a person as
//                   `control_mismatch` WITH its lines, which is more use to
//                   them than a refusal.
//
// ── SIGNS: THE HOLDER'S, ALWAYS ──────────────────────────────────────────────
//
// A line is IN positive, OUT negative (`lines.ts`). The balance is signed the
// same way, from the same side: money the holder has is positive, money the
// holder owes is negative. On a bank statement that is the ordinary reading (a
// "DR" balance is an overdraft, negative). On a CARD statement it is the
// reverse of what is printed: the card prints what the holder OWES as a plain
// positive figure, so "Previous Balance 5,803.11" is −5803.11 here and a
// "PAYMENT - THANK YOU 5,803.11 CR" is +5803.11. That way one identity holds
// for both kinds, `opening + Σ lines = closing`, and the sweep's control check
// needs no case for cards. The training pack's manifest records card balances
// as the positive amount owed; its comparison negates them, and says so.
//
// ── WHAT IS NOT A LINE ───────────────────────────────────────────────────────
//
// The brought-forward row ("Balance Brought Forward", "OPENING BALANCE", "B/F",
// a card's "PREVIOUS BALANCE") is the opening figure, never a transaction, even
// when it carries a date. A carried-forward row is never a line either. Totals
// under the table are summary figures. A card's overseas transaction fee IS a
// line of its own, as the card prints it: a charge the card made, which the
// books record apart from the purchase it was charged on.
import type { DocKind, PdfText, ReadDraft, StatementLineDraft } from "./lines";
import type { Header, Row } from "./statement-pdf-layout";
import type { Extent } from "./statement-pdf-layout";
import { cellsOf, headerOf, isWrapped, normaliseLabel, phrasesOf, roomOf, rowsOf } from "./statement-pdf-layout";
import type { DayParts, DayToken, PrintedAmount, StatementWindow } from "./statement-pdf-values";
import { centsToDecimal, fullDayOf, readAmount, readDayToken, resolveDays } from "./statement-pdf-values";

export type StatementKind = "bank" | "card";

/** One transaction as the statement prints it, signed from the holder's side. */
export interface ParsedLine {
  readonly page: number;
  readonly txnDate: string;
  readonly valueDate: string | null;
  readonly narration: string;
  readonly reference: string | null;
  readonly amount: string;
  readonly balance: string | null;
  readonly originalCurrency: string | null;
  readonly originalAmount: string | null;
}

export interface ParsedStatement {
  readonly kind: StatementKind;
  /** The last four digits of the account or card number as printed. */
  readonly accountRef: string | null;
  readonly currency: string;
  /** The PRINTED opening and closing balances, holder-signed. */
  readonly opening: string | null;
  readonly closing: string | null;
  readonly lines: readonly ParsedLine[];
}

export type StatementParse =
  | { readonly kind: "not_statement" }
  | { readonly kind: "unrecognised"; readonly why: string }
  | { readonly kind: "statement"; readonly statement: ParsedStatement };

// ── Recognising a statement ──────────────────────────────────────────────────

const CARD_MARKERS: readonly RegExp[] = [
  /\bcard (?:no|number)\b/u,
  /\btotal amount due\b|\bnew balance\b/u,
  /\bminimum (?:payment|amount due|due)\b/u,
  /\bcredit limit\b/u,
  /\bcredit card\b|\bcard statement\b|\bvisa\b|\bmastercard\b|\bamerican express\b/u,
];

/** Page 1's words, a line per row, lower-cased: what a statement says it is. */
function pageWords(rows: readonly Row[]): string {
  return rows.map((r) => phrasesOf(r).map((p) => p.text).join(" ")).join("\n").toLowerCase();
}

interface Identity {
  readonly isStatement: boolean;
  readonly kind: StatementKind;
}

/**
 * A statement says so ("Statement of Account", "Statement period", "Statement
 * Date") and names a bank or a card. Not one of the training pack's 709
 * invoices and receipts says "statement"; a supplier's statement of account
 * would, and names no bank's table header, so it reads as unrecognised rather
 * than as a bank statement.
 */
function identify(words: string): Identity {
  const statementWord = /\bstatement\b/u.test(words);
  const cardMarks = CARD_MARKERS.filter((m) => m.test(words)).length;
  const bankWord = /\bbank(?:ing)?\b/u.test(words);
  const kind: StatementKind = cardMarks >= 2 ? "card" : "bank";
  return { isStatement: statementWord && (kind === "card" || bankWord), kind };
}

// ── What the statement says about itself ─────────────────────────────────────

const DATE_IN_TEXT =
  /\b(\d{1,2}[ -]?[A-Za-z]{3,9}[ -]?\d{4}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9} \d{1,2}, \d{4})\b/gu;

function datesIn(text: string): DayParts[] {
  const out: DayParts[] = [];
  for (const m of text.matchAll(DATE_IN_TEXT)) {
    const day = fullDayOf(m[1] ?? "") ?? fullDayOf(m[1] ?? "", "month_first");
    if (day !== null) out.push(day);
  }
  return out;
}

/** The period a statement covers, from page 1: "Statement period 01 Feb 2025
 *  to 28 Feb 2025", else a "Statement Date" (a card's), else none. */
function windowOf(rows: readonly Row[]): StatementWindow | null {
  const texts = rows.map((r) => phrasesOf(r).map((p) => p.text).join(" "));
  for (const t of texts) {
    if (!/period|from .* to /iu.test(t)) continue;
    const days = datesIn(t);
    const [start, end] = days;
    if (start !== undefined && end !== undefined) return { start, end };
  }
  for (const t of texts) {
    if (!/statement date|as at|as of/iu.test(t)) continue;
    const [end] = datesIn(t);
    if (end !== undefined) return { start: null, end };
  }
  return null;
}

/** The statement's currency: a "Currency SGD" line on page 1, else the one a
 *  money column's header names ("Amount (SGD)"). */
function currencyOf(rows: readonly Row[], headers: readonly Header[]): string | null {
  for (const r of rows) {
    // The label in any case, the code in capitals: "Currency: Singapore
    // Dollar" must not read as the code "SIN".
    const m = /\b(?:[Cc]urrency|CURRENCY)\b\s*:?\s*([A-Z]{3})\b/u.exec(phrasesOf(r).map((p) => p.text).join(" "));
    if (m?.[1] !== undefined) return m[1];
  }
  return headers.map((h) => h.currency).find((c) => c !== null) ?? null;
}

/** The last four digits of "Account No. 1742-180-967" or "Card No: XXXX XXXX
 *  XXXX 1492". */
function accountRefOf(rows: readonly Row[]): string | null {
  for (const r of rows) {
    const t = phrasesOf(r).map((p) => p.text).join(" ");
    const m = /\b(?:account|a\/c|acct|card)\s*(?:no|number|#)\.?\s*:?\s*([0-9Xx*•][0-9Xx*•\s-]{3,})/iu.exec(t);
    const digits = (m?.[1] ?? "").replace(/\D/gu, "");
    if (digits.length >= 4) return digits.slice(-4);
  }
  return null;
}

// ── Summary figures ──────────────────────────────────────────────────────────

const OPENING_LABEL =
  /^(?:opening balance|opening ledger balance|balance brought forward|balance b\/f|brought forward|b\/f|previous balance|previous statement balance|balance from previous statement)$/u;
const CLOSING_LABEL =
  /^(?:closing balance|closing ledger balance|ending balance|balance carried forward|balance c\/f|new balance|total amount due|statement balance)$/u;
const CARRIED_FORWARD = /^(?:balance carried forward|carried forward|balance c\/f|c\/f)$/u;

/** A label's figure: the first amount right of it on its own row, or, in a
 *  summary laid out as a row of labels over a row of figures, the amount under
 *  it in the next row. */
function figureFor(rows: readonly Row[], at: number, label: { left: number; right: number }): PrintedAmount | null {
  const row = rows[at];
  if (row === undefined) return null;
  for (const p of phrasesOf(row)) {
    if (p.left <= label.left) continue;
    const amount = readAmount(p.text);
    if (amount !== null) return amount;
    if (/[A-Za-z]{3,}/u.test(p.text)) break;
  }
  const next = rows[at + 1];
  if (next === undefined || next.baseline - row.baseline > 3 * row.height) return null;
  for (const p of phrasesOf(next)) {
    const amount = readAmount(p.text);
    const overlap = Math.min(p.right, label.right) - Math.max(p.left, label.left);
    if (amount !== null && overlap > 0) return amount;
  }
  return null;
}

interface Summary {
  readonly opening: PrintedAmount | null;
  readonly closing: PrintedAmount | null;
}

function summaryOf(pages: readonly (readonly Row[])[], skip: ReadonlySet<Row>): Summary {
  let opening: PrintedAmount | null = null;
  let closing: PrintedAmount | null = null;
  for (const rows of pages) {
    for (const [at, row] of rows.entries()) {
      if (skip.has(row)) continue;
      for (const p of phrasesOf(row)) {
        const label = normaliseLabel(p.text);
        if (opening === null && OPENING_LABEL.test(label)) opening = figureFor(rows, at, p);
        else if (closing === null && CLOSING_LABEL.test(label)) closing = figureFor(rows, at, p);
      }
    }
  }
  return { opening, closing };
}

// ── Signs ────────────────────────────────────────────────────────────────────

/** A printed balance, holder-signed. A bank's "DR" balance is an overdraft; a
 *  card's plain balance is what the holder owes. */
function signedBalance(a: PrintedAmount, kind: StatementKind): bigint {
  const credit = a.suffix === "CR" || (kind === "bank" ? a.suffix !== "DR" && a.sign !== "-" : a.sign === "-");
  return credit ? a.cents : -a.cents;
}

/** An amount in a single amount column: the sign it carries, or null when it
 *  carries none (a bank's unsigned amount, settled from the balance). On a card
 *  a plain amount is a charge and "CR" or a minus is a credit. */
function signedAmount(a: PrintedAmount, kind: StatementKind): bigint | null {
  if (kind === "card") return a.suffix === "CR" || a.sign === "-" ? a.cents : -a.cents;
  if (a.sign === "+" || a.suffix === "CR") return a.cents;
  if (a.sign === "-" || a.suffix === "DR") return -a.cents;
  return null;
}

// ── Reading the table ────────────────────────────────────────────────────────

interface Pending {
  readonly page: number;
  readonly date: DayToken;
  readonly valueDate: DayToken | null;
  readonly narration: string[];
  readonly reference: string[];
  /** Signed cents, or the absolute amount still to be signed from the balance. */
  readonly amount: { readonly cents: bigint; readonly signed: boolean };
  readonly balance: bigint | null;
  lastBaseline: number;
  lastPage: number;
  /** Where the narration's last line ends, to tell a wrap from a new line. */
  narrationRight: number | null;
}

const FOREIGN_AMOUNT = /^\(?([A-Z]{3})\s+(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\b/u;

/** A card's "(USD 7,760.00 converted at card rate)" line, when one of the
 *  narration's continuation lines is one. */
function foreignAmountIn(continuations: readonly string[]): RegExpExecArray | null {
  for (const line of continuations) {
    const m = FOREIGN_AMOUNT.exec(line);
    if (m !== null) return m;
  }
  return null;
}

/** What one row under the header is. */
type RowRead =
  | { readonly kind: "opening"; readonly figure: PrintedAmount | null }
  | { readonly kind: "carried" }
  | { readonly kind: "line"; readonly line: Pending; readonly twoSided: boolean }
  | { readonly kind: "dated_without_amount" }
  | {
      readonly kind: "narration";
      readonly description: string;
      readonly extent: Extent | null;
      readonly reference: string | null;
    }
  | { readonly kind: "other" };

function readRow(row: Row, header: Header, kind: StatementKind, page: number): RowRead {
  const cells = cellsOf(row, header);
  const description = cells.text.get("description") ?? "";
  const dateText = cells.text.get("date");
  // Every text cell, because a bank may print "BALANCE B/F" under its
  // reference column (Orchid does) rather than its description.
  const words = normaliseLabel(
    [dateText ?? "", cells.text.get("reference") ?? "", description].filter((t) => t !== "").join(" "),
  );
  const amountRun = cells.money.get("amount");
  const debit = cells.money.get("debit");
  const credit = cells.money.get("credit");
  const balanceRun = cells.money.get("balance");

  if (OPENING_LABEL.test(normaliseLabel(description)) || OPENING_LABEL.test(words)) {
    const figure = balanceRun ?? amountRun;
    return { kind: "opening", figure: figure === undefined ? null : readAmount(figure.text) };
  }
  if (CARRIED_FORWARD.test(normaliseLabel(description)) || CARRIED_FORWARD.test(words)) {
    return { kind: "carried" };
  }

  const date = dateText === undefined ? null : readDayToken(dateText);
  const run = debit ?? credit ?? amountRun;
  const printed = run === undefined ? null : readAmount(run.text);
  if (date !== null && printed !== null) {
    let amount: { cents: bigint; signed: boolean };
    if (debit !== undefined) amount = { cents: -printed.cents, signed: true };
    else if (credit !== undefined) amount = { cents: printed.cents, signed: true };
    else {
      const signed = signedAmount(printed, kind);
      amount = signed === null ? { cents: printed.cents, signed: false } : { cents: signed, signed: true };
    }
    const balancePrinted = balanceRun === undefined ? null : readAmount(balanceRun.text);
    const valueText = cells.text.get("value_date");
    const reference = cells.text.get("reference");
    return {
      kind: "line",
      twoSided: debit !== undefined && credit !== undefined,
      line: {
        page,
        date,
        valueDate: valueText === undefined ? null : readDayToken(valueText),
        narration: description === "" ? [] : [description],
        reference: reference === undefined ? [] : [reference],
        amount,
        balance: balancePrinted === null ? null : signedBalance(balancePrinted, kind),
        lastBaseline: row.baseline,
        lastPage: page,
        narrationRight: cells.extent.get("description")?.right ?? null,
      },
    };
  }
  // A dated row with no amount the header places: the columns were not read
  // right, or the layout puts amounts where this does not look.
  if (date !== null) return { kind: "dated_without_amount" };

  const onlyNarration =
    cells.money.size === 0 &&
    cells.stray.length === 0 &&
    [...cells.text.keys()].every((role) => role === "description" || role === "reference");
  if (onlyNarration) {
    return {
      kind: "narration",
      description,
      extent: cells.extent.get("description") ?? null,
      reference: cells.text.get("reference") ?? null,
    };
  }
  return { kind: "other" };
}

/** Reads a statement's text. */
export function parseStatementPdf(text: PdfText): StatementParse {
  if (!text.hasTextLayer || text.pages.length === 0) return { kind: "not_statement" };
  const pages = text.pages.map(rowsOf);
  const first = pages[0] ?? [];
  const identity = identify(pageWords(first));

  const headers: Header[] = [];
  const consumed = new Set<Row>();
  const pending: Pending[] = [];
  let openingRow: PrintedAmount | null = null;
  let datedWithoutAmount = 0;
  let twoSided = false;
  let header: Header | null = null;
  let open: Pending | null = null;

  for (const [pageAt, rows] of pages.entries()) {
    const pageNumber = text.pages[pageAt]?.number ?? pageAt + 1;
    // A page's own header starts its table; rows above it (the bank's name,
    // "(page 2)") are not read. A page with none continues the last table.
    const headerAt = rows.findIndex((r) => headerOf(r) !== null);
    let firstOnPage = true;
    for (const [rowAt, row] of rows.entries()) {
      if (headerAt >= 0 && rowAt < headerAt) continue;
      const asHeader = headerOf(row);
      if (asHeader !== null) {
        header = asHeader;
        headers.push(asHeader);
        consumed.add(row);
        open = null;
        continue;
      }
      if (header === null) continue;
      const read = readRow(row, header, identity.kind, pageNumber);
      const wasFirst = firstOnPage;
      firstOnPage = false;
      switch (read.kind) {
        case "opening":
          if (openingRow === null) openingRow = read.figure;
          consumed.add(row);
          open = null;
          break;
        case "carried":
          consumed.add(row);
          open = null;
          break;
        case "line":
          if (read.twoSided) twoSided = true;
          pending.push(read.line);
          consumed.add(row);
          open = read.line;
          break;
        case "dated_without_amount":
          datedWithoutAmount += 1;
          open = null;
          break;
        case "narration": {
          const near =
            open !== null &&
            ((open.lastPage === pageNumber && row.baseline - open.lastBaseline <= 2.2 * row.height) ||
              (open.lastPage === pageNumber - 1 && wasFirst));
          if (open !== null && near) {
            const wrapped =
              read.extent !== null &&
              open.narrationRight !== null &&
              open.narration.length > 0 &&
              isWrapped(open.narrationRight, read.extent, roomOf(header, "description"));
            if (read.description !== "" && wrapped) {
              open.narration[open.narration.length - 1] = `${open.narration.at(-1) ?? ""} ${read.description}`;
            } else if (read.description !== "") open.narration.push(read.description);
            if (read.extent !== null) open.narrationRight = read.extent.right;
            if (read.reference !== null) open.reference.push(read.reference);
            open.lastBaseline = row.baseline;
            open.lastPage = pageNumber;
            consumed.add(row);
          } else {
            open = null;
          }
          break;
        }
        case "other":
          open = null;
          break;
      }
    }
  }

  if (headers.length === 0) {
    return identity.isStatement
      ? { kind: "unrecognised", why: "no transaction table header this reader knows" }
      : { kind: "not_statement" };
  }
  if (!identity.isStatement) return { kind: "not_statement" };
  if (twoSided) return { kind: "unrecognised", why: "a row carries both a debit and a credit" };
  if (datedWithoutAmount > 0) {
    return {
      kind: "unrecognised",
      why: `${datedWithoutAmount} dated row(s) carry no amount under a money column`,
    };
  }

  const currency = currencyOf(first, headers);
  if (currency === null) return { kind: "unrecognised", why: "the statement prints no currency" };

  const window = windowOf(first);
  const tokens = pending.flatMap((p) => (p.valueDate === null ? [p.date] : [p.date, p.valueDate]));
  const resolved = resolveDays(tokens, window);
  if (!resolved.ok) return { kind: "unrecognised", why: resolved.why };

  const summary = summaryOf(pages, consumed);
  const openingPrinted = openingRow ?? summary.opening;
  const opening = openingPrinted === null ? null : signedBalance(openingPrinted, identity.kind);

  let at = 0;
  let previous = opening;
  const lines: ParsedLine[] = [];
  for (const p of pending) {
    const txnDate = resolved.days[at] ?? "";
    at += 1;
    let valueDate: string | null = null;
    if (p.valueDate !== null) {
      valueDate = resolved.days[at] ?? null;
      at += 1;
    }
    let cents = p.amount.cents;
    if (!p.amount.signed) {
      if (previous === null || p.balance === null) {
        return { kind: "unrecognised", why: "an unsigned amount with no running balance to sign it from" };
      }
      if (previous + cents === p.balance) cents = p.amount.cents;
      else if (previous - cents === p.balance) cents = -p.amount.cents;
      else return { kind: "unrecognised", why: "an unsigned amount the running balance does not explain" };
    }
    previous = p.balance ?? (previous === null ? null : previous + cents);
    const foreign = identity.kind === "card" ? foreignAmountIn(p.narration.slice(1)) : null;
    const foreignCode = foreign?.[1];
    const foreignDigits = foreign?.[2]?.replace(/,/gu, "");
    const isForeign = foreignCode !== undefined && foreignDigits !== undefined && foreignCode !== currency;
    lines.push({
      page: p.page,
      txnDate,
      valueDate,
      narration: p.narration.join(" | "),
      reference: p.reference.length === 0 ? null : p.reference.join(" ").trim() || null,
      amount: centsToDecimal(cents),
      balance: p.balance === null ? null : centsToDecimal(p.balance),
      originalCurrency: isForeign ? foreignCode : null,
      originalAmount: isForeign ? `${cents < 0n ? "-" : ""}${foreignDigits}` : null,
    });
  }

  // The closing figure: the one the statement labels, else the last running
  // balance it printed. Both are printed; neither is computed here.
  const lastBalance = [...pending].reverse().find((p) => p.balance !== null)?.balance ?? null;
  const closing =
    summary.closing !== null ? signedBalance(summary.closing, identity.kind) : lastBalance;

  if (pending.length === 0 && opening === null && closing === null) {
    return { kind: "unrecognised", why: "a table header and nothing under it" };
  }

  return {
    kind: "statement",
    statement: {
      kind: identity.kind,
      accountRef: accountRefOf(first),
      currency,
      opening: opening === null ? null : centsToDecimal(opening),
      closing: closing === null ? null : centsToDecimal(closing),
      lines,
    },
  };
}

/** The read draft a statement becomes: one statement line per transaction,
 *  each pointing at its page, and the printed opening and closing as the
 *  control. A deterministic read: no confidence, no model, nothing uncertain. */
export function statementReadDraft(statement: ParsedStatement, documentVersionId: string): ReadDraft {
  const docKind: DocKind = statement.kind === "card" ? "card_statement" : "bank_statement";
  const lines = statement.lines.map(
    (l): StatementLineDraft => ({
      kind: "statement",
      statementType: statement.kind,
      accountRef: statement.accountRef,
      txnDate: l.txnDate,
      valueDate: l.valueDate,
      narration: l.narration,
      reference: l.reference,
      amount: l.amount,
      currency: statement.currency,
      balance: l.balance,
      originalCurrency: l.originalCurrency,
      originalAmount: l.originalAmount,
      provenance: { documentVersionId, page: l.page, row: null },
      uncertain: [],
    }),
  );
  return {
    docKind,
    reader: "pdf_text",
    lines,
    control: { opening: statement.opening, closing: statement.closing, lineCount: null, declaredTotal: null },
    confidence: null,
    model: null,
    promptVersion: null,
    formatId: null,
  };
}
