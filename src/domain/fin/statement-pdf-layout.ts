// Where things are on a statement page: rows, phrases, the table header and the
// columns under it (docs/FIN_BUILD_PLAN.md F2.9). Pure, over the positioned
// text the PDF port returns (`PdfText`, PDF points from the page's top-left).
//
// ── ONE PARSER FOR EVERY BANK, DRIVEN BY THE HEADER ──────────────────────────
//
// Five banks print five tables, and none of them is special-cased here. A
// statement's transaction table has a header row whose words say what each
// column holds ("Withdrawals", "Amount (+/-)", "BAL"), and the header's
// position on the page says where that column is. Every row under it is then
// read by position: a date where the date column is, an amount where an amount
// column is. A sixth bank whose header uses the same words reads with no code
// change; one that uses other words needs a word added to `ROLE_WORDS`, never a
// branch.
//
// Two rules decide which column a run of text belongs to, and the difference is
// the whole trick:
//
//   - An AMOUNT belongs to the money column its box OVERLAPS. Amounts are
//     right-aligned under right-aligned headers, so "70,000.00" starts left of
//     "Deposits" and still sits under it, while a long narration that runs on
//     past the Debit header's left edge never overlaps a money column with an
//     amount-shaped run of its own.
//   - TEXT belongs to the column whose header starts at or left of where the
//     text starts. Narrations are left-aligned under their header.
//
// An amount-shaped run that overlaps no money column (the "8,334.00" of
// "USD 8,334.00 @1.3487" when a PDF splits it out) is text, which is what it is.
import type { PdfTextItem, PdfTextPage } from "./lines";
import { isSuffixMark, readAmount } from "./statement-pdf-values";

/** One line of a page: the runs whose baselines agree, left to right. */
export interface Row {
  readonly page: number;
  /** The shared baseline, PDF points from the top. */
  readonly baseline: number;
  /** The tallest run's height: the line's own size, for spacing tests. */
  readonly height: number;
  readonly items: readonly PdfTextItem[];
}

/**
 * Groups a page's runs into rows by BASELINE (`y + height`), not by top: a
 * 7pt reference beside a 7.6pt date sits on the same line and has a different
 * top. Two runs share a row when their baselines are within a third of the
 * smaller one's height (at least 1.5pt); a statement's lines are a whole line
 * height apart, so nothing between those reads as one.
 */
export function rowsOf(page: PdfTextPage): readonly Row[] {
  const items = page.items
    .filter((i) => i.text.trim() !== "")
    .map((i) => ({ item: i, baseline: i.y + i.height }))
    .sort((a, b) => a.baseline - b.baseline || a.item.x - b.item.x);
  const rows: { baseline: number; height: number; items: PdfTextItem[] }[] = [];
  for (const { item, baseline } of items) {
    const last = rows.at(-1);
    const tolerance = Math.max(1.5, Math.min(last?.height ?? item.height, item.height) / 3);
    if (last !== undefined && baseline - last.baseline <= tolerance) {
      last.items.push(item);
      last.height = Math.max(last.height, item.height);
      continue;
    }
    rows.push({ baseline, height: item.height, items: [item] });
  }
  return rows.map((r) => ({
    page: page.number,
    baseline: r.baseline,
    height: r.height,
    items: [...r.items].sort((a, b) => a.x - b.x),
  }));
}

/** Amount runs with a bare "CR"/"DR" just right of them merged in: some PDFs
 *  write "178,407.41" and "CR" as two runs. */
function withSuffixesMerged(items: readonly PdfTextItem[]): readonly PdfTextItem[] {
  const out: PdfTextItem[] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (
      last !== undefined &&
      isSuffixMark(item.text) &&
      readAmount(last.text) !== null &&
      item.x - (last.x + last.width) <= Math.max(6, item.height)
    ) {
      out[out.length - 1] = {
        ...last,
        text: `${last.text.trim()} ${item.text.trim()}`,
        width: item.x + item.width - last.x,
      };
      continue;
    }
    out.push(item);
  }
  return out;
}

/** Runs of a row merged into phrases, for reading labels ("Txn Date",
 *  "Previous Balance"). An amount is never merged into a phrase. */
export interface Phrase {
  readonly text: string;
  readonly left: number;
  readonly right: number;
}

/**
 * Merges neighbouring text runs separated by about a space into one phrase. A
 * monospaced statement often writes each word as its own run ("PACIFIC",
 * "UNION", "BANK"), and a header cell must read as the phrase it is. The gap
 * allowed is seven tenths of the text's height: a Courier space is six tenths,
 * and the narrowest gap between two table columns in the pack is twice that.
 */
export function phrasesOf(row: Row): readonly Phrase[] {
  const out: { text: string; left: number; right: number; height: number; money: boolean }[] = [];
  for (const item of withSuffixesMerged(row.items)) {
    const money = readAmount(item.text) !== null;
    const last = out.at(-1);
    const gap = last === undefined ? Infinity : item.x - last.right;
    if (last !== undefined && !money && !last.money && gap <= 0.7 * Math.max(last.height, item.height)) {
      last.text = `${last.text} ${item.text.trim()}`;
      last.right = Math.max(last.right, item.x + item.width);
      last.height = Math.max(last.height, item.height);
      continue;
    }
    out.push({ text: item.text.trim(), left: item.x, right: item.x + item.width, height: item.height, money });
  }
  return out.map(({ text, left, right }) => ({ text, left, right }));
}

/** The plain words of a label: lower-case, single-spaced, no trailing colon. */
export function normaliseLabel(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, " ").replace(/[:.]+$/u, "").trim();
}

// ── The header ───────────────────────────────────────────────────────────────

/** What a column of the transaction table holds. */
export type ColumnRole =
  | "date"
  | "post_date"
  | "value_date"
  | "reference"
  | "description"
  | "debit"
  | "credit"
  | "amount"
  | "balance";

const MONEY_ROLES: ReadonlySet<ColumnRole> = new Set(["debit", "credit", "amount", "balance"]);

export function isMoneyRole(role: ColumnRole): boolean {
  return MONEY_ROLES.has(role);
}

/** A header cell's words, and the role they name. Whole-label matches only: a
 *  header is short, and a partial match ("date" inside "Payment due date") is
 *  exactly how a summary line would be read as a table. */
const ROLE_WORDS: readonly (readonly [RegExp, ColumnRole])[] = [
  [/^(?:date|txn date|transaction date|trans date|tran date|trans\. date)$/u, "date"],
  [/^(?:post date|posting date|posted|book date|booking date)$/u, "post_date"],
  [/^(?:value date|value dt|val date)$/u, "value_date"],
  [/^(?:reference|ref|ref no|reference no|cheque|cheque no|chq|chq no|cheque number|instrument no)$/u, "reference"],
  [/^(?:description|transaction details|details|particulars|narration|narrative|transaction|remarks|transaction description)$/u, "description"],
  [/^(?:withdrawals?|debits?|dr|money out|paid out|withdrawal amount|debit amount)(?: \([a-z]{3}\))?$/u, "debit"],
  [/^(?:deposits?|credits?|cr|money in|paid in|deposit amount|credit amount)(?: \([a-z]{3}\))?$/u, "credit"],
  [/^(?:amount|amount \(\+\/-\)|transaction amount|amt)(?: \([a-z]{3}\))?$/u, "amount"],
  [/^(?:balance|bal|running balance|ledger balance|closing balance)(?: \([a-z]{3}\))?$/u, "balance"],
];

/** The role a header cell names, or null for a cell that names none. */
export function roleOf(label: string): ColumnRole | null {
  const words = normaliseLabel(label);
  for (const [pattern, role] of ROLE_WORDS) if (pattern.test(words)) return role;
  return null;
}

/** A column of the transaction table, placed by its header cell. */
export interface Column {
  readonly role: ColumnRole;
  readonly left: number;
  readonly right: number;
  readonly label: string;
}

/** The transaction table's header, and the currency it names when one of its
 *  money cells does ("Amount (SGD)"). */
export interface Header {
  readonly columns: readonly Column[];
  readonly baseline: number;
  readonly currency: string | null;
}

/**
 * Reads a row as the transaction table's header, or answers null.
 *
 * A header names a DATE column and at least one MONEY column, and three or
 * more of its cells are recognised; at most one is a word this does not know.
 * A posting date stands in for the transaction date when there is no other
 * (Orchid's "Posting Date" is its only date); beside a transaction date it is
 * the value date (a card's "Post Date | Trans Date").
 */
export function headerOf(row: Row): Header | null {
  const phrases = phrasesOf(row);
  const placed: Column[] = [];
  let unknown = 0;
  for (const p of phrases) {
    const role = roleOf(p.text);
    if (role === null) unknown += 1;
    else placed.push({ role, left: p.left, right: p.right, label: p.text });
  }
  if (placed.length < 3 || unknown > 1) return null;
  const roles = new Set(placed.map((c) => c.role));
  const hasDate = roles.has("date") || roles.has("post_date");
  const hasMoney = placed.some((c) => isMoneyRole(c.role));
  if (!hasDate || !hasMoney) return null;
  // One column per role: a header naming "Balance" twice is not a table this
  // reads.
  if (roles.size !== placed.length) return null;

  const columns = placed.map((c): Column => {
    if (c.role !== "post_date") return c;
    return roles.has("date") ? { ...c, role: "value_date" } : { ...c, role: "date" };
  });
  if (new Set(columns.map((c) => c.role)).size !== columns.length) return null;
  const currency =
    columns
      .filter((c) => isMoneyRole(c.role))
      .map((c) => /\(([A-Za-z]{3})\)\s*$/u.exec(c.label)?.[1])
      .find((code) => code !== undefined && code !== "") ?? null;
  return {
    columns: [...columns].sort((a, b) => a.left - b.left),
    baseline: row.baseline,
    currency: currency === null ? null : currency.toUpperCase(),
  };
}

// ── A row read against the header ────────────────────────────────────────────

/** A money run, with its box. */
export interface MoneyRun {
  readonly text: string;
  readonly left: number;
  readonly right: number;
}

/** Where a text column's text sits on its row. */
export interface Extent {
  readonly left: number;
  readonly right: number;
  /** The width of its first word, estimated from its run's characters: what a
   *  line above needed room for, had the bank not broken the line. */
  readonly firstWord: number;
  readonly height: number;
}

/** One row of the table, split by column. */
export interface Cells {
  /** Text per text column, runs joined by a space, in reading order. */
  readonly text: ReadonlyMap<ColumnRole, string>;
  readonly extent: ReadonlyMap<ColumnRole, Extent>;
  /** The amount in each money column. */
  readonly money: ReadonlyMap<ColumnRole, MoneyRun>;
  /** Text that fell in no text column: left of the table, or under a money
   *  header. A row with any is not a continuation of a narration. */
  readonly stray: readonly string[];
}

/** How far a money run may sit from its header and still be under it, when it
 *  overlaps none: a header much narrower than its widest amount. */
const MONEY_SLACK = 24;

function moneyColumnFor(run: MoneyRun, columns: readonly Column[]): Column | null {
  let best: Column | null = null;
  let bestOverlap = 0;
  for (const c of columns) {
    if (!isMoneyRole(c.role)) continue;
    const overlap = Math.min(run.right, c.right) - Math.max(run.left, c.left);
    if (overlap > bestOverlap) {
      best = c;
      bestOverlap = overlap;
    }
  }
  if (best !== null) return best;
  let nearest: Column | null = null;
  let distance = MONEY_SLACK;
  for (const c of columns) {
    if (!isMoneyRole(c.role)) continue;
    const d = Math.abs(run.right - c.right);
    if (d <= distance) {
      nearest = c;
      distance = d;
    }
  }
  return nearest;
}

/** The column whose header starts at or left of `x` (a little slack for a run
 *  that starts a hair left of its header), or null left of the table. */
function columnAt(x: number, columns: readonly Column[]): Column | null {
  let found: Column | null = null;
  for (const c of columns) if (c.left <= x + 2) found = c;
  return found;
}

/** Splits a row into the header's columns. */
export function cellsOf(row: Row, header: Header): Cells {
  const text = new Map<ColumnRole, string[]>();
  const extent = new Map<ColumnRole, Extent>();
  const money = new Map<ColumnRole, MoneyRun>();
  const stray: string[] = [];
  for (const item of withSuffixesMerged(row.items)) {
    const run = { text: item.text.trim(), left: item.x, right: item.x + item.width };
    if (readAmount(run.text) !== null) {
      const column = moneyColumnFor(run, header.columns);
      if (column !== null && !money.has(column.role)) {
        money.set(column.role, run);
        continue;
      }
      if (column !== null) {
        stray.push(run.text);
        continue;
      }
    }
    const column = columnAt(item.x, header.columns);
    if (column === null || isMoneyRole(column.role)) {
      stray.push(run.text);
      continue;
    }
    const list = text.get(column.role) ?? [];
    list.push(run.text);
    text.set(column.role, list);
    const seen = extent.get(column.role);
    const space = run.text.indexOf(" ");
    const firstWord = run.text.length === 0 ? 0 : (item.width * (space < 0 ? run.text.length : space)) / run.text.length;
    extent.set(
      column.role,
      seen === undefined
        ? { left: run.left, right: run.right, firstWord, height: item.height }
        : { ...seen, right: Math.max(seen.right, run.right) },
    );
  }
  return {
    text: new Map([...text].map(([role, parts]) => [role, parts.join(" ")])),
    extent,
    money,
    stray,
  };
}

/** Where a column's room ends: the left edge of the next column to its right,
 *  or null for the last column. */
export function roomOf(header: Header, role: ColumnRole): number | null {
  const own = header.columns.find((c) => c.role === role);
  if (own === undefined) return null;
  const next = header.columns.find((c) => c.left > own.left);
  return next === undefined ? null : next.left;
}

/**
 * Whether a continuation line is the SAME line wrapped, rather than a new one.
 * A bank breaks a long narration where the next word would not fit before the
 * next column ("OUTW TT DONGGUAN METALWARE INDUSTRIES INV-2025-2445" /
 * "USD 61,706.79 @1.3437" is one line of the Straits statement), and puts a
 * deliberate break between parts ("GIRO DEBIT" / "Singa Mobile and Fibre Pte
 * Ltd" on Merlion's) with room to spare. The typographic test tells them apart:
 * would the next line's first word, after a space, have fitted?
 */
export function isWrapped(previousRight: number, next: Extent, room: number | null): boolean {
  if (room === null) return false;
  return previousRight + 0.28 * next.height + next.firstWord > room;
}
