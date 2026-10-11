// The PDF statement reader over the training pack (docs/FIN_BUILD_PLAN.md F2.9
// PDF half, F2.10): every operating-account statement and every card statement
// of companies A to E, read by the real `pdf_text` reader on the real pdf.js
// adapter, and compared with the answer key.
//
// `99_Ground_Truth` is the EXPECTED answer here and never an input: the reader
// is handed the statement's bytes and nothing else (ground rule 6). The suite
// skips when the pack is not on the machine, as every pack-driven test does.
//
// What is compared, per file:
//   - a scanned month is `not_mine` (the AI reader's), a digital one is read
//   - opening, closing and line count against `statement_files_manifest.csv`
//     (a card's balances are what the holder OWES, so the reader's are the
//     negatives; a card's count is its purchases, not its overseas fees and not
//     the payment the holder made)
//   - the read sweep's own control: opening + Σ lines = closing
//   - each line's date and signed amount against `bank_transactions_truth.csv`
//     and `card_transactions_truth.csv` (card: each purchase and each overseas
//     fee by transaction date, post date and amount, and the foreign amount)
//   - and, as a measure not a gate, the narration against the truth's.
// A table of match rates per company and layout is printed.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ReadDraft, StatementLineDraft } from "../../src/domain/fin/lines";
import { DEFAULT_ARCHIVE_LIMITS } from "../../src/domain/fin/archive";
import { PdfJsTextReader } from "../../src/infrastructure/fin/pdf-text";
import { SharpImageNormaliser } from "../../src/infrastructure/fin/image-normaliser";
import type { ReadInput, ReadOutcome } from "../../src/usecase/fin/reading";
import { pdfStatementReader } from "../../src/usecase/fin/statement-pdf-reader";

vi.setConfig({ testTimeout: 180_000 });

/** The pack, wherever the repo is checked out beside it. */
function findPack(): string | null {
  let dir = import.meta.dirname;
  for (;;) {
    const candidate = join(dir, "fincompliace", "SG_BiB_Training_Data_Pack");
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const PACK = findPack();

/** A CSV row, quotes and all: the truth's narrations carry commas. */
function csv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) rows.push([...row, cell]);
  const [head, ...body] = rows.filter((r) => r.some((c) => c !== ""));
  return body.map((r) => Object.fromEntries((head ?? []).map((h, i) => [h, r[i] ?? ""])));
}

/** "10682.0" → 1068200n: the truth's floats read as digits, never as numbers. */
function cents(decimal: string): bigint {
  const negative = decimal.trim().startsWith("-");
  const [whole = "0", frac = ""] = decimal.trim().replace(/^[-+]/u, "").split(".");
  const value = BigInt(whole + frac.padEnd(2, "0").slice(0, 2));
  return negative ? -value : value;
}

function money(c: bigint): string {
  const negative = c < 0n;
  const digits = (negative ? -c : c).toString().padStart(3, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/** Removes and returns one matching element: multiset matching. */
function take<T>(pool: T[], match: (t: T) => boolean): T | null {
  const at = pool.findIndex(match);
  if (at < 0) return null;
  return pool.splice(at, 1)[0] ?? null;
}

const LAYOUT: Readonly<Record<string, string>> = {
  A: "Merlion (Withdrawals / Deposits, cheque column)",
  B: "Straits Commercial (Debit / Credit, CR balances)",
  C: "Lion City (signed Amount (+/-), multi-page)",
  D: "Orchid (reference column, dd-Mon-yy)",
  E: "Pacific Union (monospaced, DR / CR, ddMONyy)",
};

const CARD_LAYOUT: Readonly<Record<string, string>> = {
  A: "Merlion card (label / figure summary)",
  B: "Straits card (summary row, dd/mm)",
  C: "Lion City card (label / figure summary)",
  D: "Merlion card (label / figure summary)",
  E: "Straits card (summary row, dd/mm)",
};

interface Tally {
  files: number;
  scans: number;
  scansNotMine: number;
  read: number;
  opening: number;
  closing: number;
  count: number;
  control: number;
  linesExpected: number;
  linesMatched: number;
  linesRead: number;
  narrationMatched: number;
  foreignExpected: number;
  foreignMatched: number;
  /** Key entries on a statement the pack does not hold. */
  afterLast: number;
}

const tally = (): Tally => ({
  files: 0,
  scans: 0,
  scansNotMine: 0,
  read: 0,
  opening: 0,
  closing: 0,
  count: 0,
  control: 0,
  linesExpected: 0,
  linesMatched: 0,
  linesRead: 0,
  narrationMatched: 0,
  foreignExpected: 0,
  foreignMatched: 0,
  afterLast: 0,
});

const pdfText = new PdfJsTextReader();
const reader = pdfStatementReader(pdfText);

function inputFor(path: string, filename: string): ReadInput {
  return {
    tenantId: "00000000-0000-4000-8000-000000000001",
    intakeItemId: "00000000-0000-4000-8000-000000000002",
    documentVersionId: "00000000-0000-4000-8000-000000000003",
    clientPartyId: null,
    route: "pdf",
    mediaType: "application/pdf",
    filename,
    bytes: new Uint8Array(readFileSync(path)),
  };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The "Statement Date" a card statement prints, as `YYYY-MM-DD`: where the
 *  key's purchases stop belonging to the pack's last statement. */
async function statementDateOf(path: string): Promise<string | null> {
  const text = await pdfText.read(new Uint8Array(readFileSync(path)));
  const words = text.pages.flatMap((p) => p.items.map((i) => i.text)).join(" ");
  const named = /Statement Date:\s*(\d{1,2}) ([A-Za-z]{3}) (\d{4})/u.exec(words);
  if (named !== null) {
    const month = MONTHS.indexOf((named[2] ?? "").toLowerCase()) + 1;
    return `${named[3]}-${String(month).padStart(2, "0")}-${(named[1] ?? "").padStart(2, "0")}`;
  }
  const numeric = /Statement Date:\s*(\d{2})\/(\d{2})\/(\d{4})/u.exec(words);
  return numeric === null ? null : `${numeric[3]}-${numeric[2]}-${numeric[1]}`;
}

function statementLines(draft: ReadDraft): StatementLineDraft[] {
  return draft.lines.filter((l): l is StatementLineDraft => l.kind === "statement");
}

const pct = (n: number, d: number): string => (d === 0 ? "-" : `${((100 * n) / d).toFixed(1)}%`);

describe.skipIf(PACK === null)("the training pack's statements, read by pdf_text", () => {
  const pack = PACK ?? "";
  const companies = PACK === null ? [] : readdirSync(pack).filter((d) => d.startsWith("Company_")).sort();
  const bank = new Map<string, Tally>();
  const card = new Map<string, Tally>();
  const problems: string[] = [];

  it("reads every digital statement month to the answer key, and leaves every scanned one to the AI reader", async () => {
    for (const company of companies) {
      const letter = company.slice(8, 9);
      const truth = join(pack, company, "99_Ground_Truth");
      const manifest = csv(readFileSync(join(truth, "statement_files_manifest.csv"), "utf8"));
      const bankTruth = csv(readFileSync(join(truth, "bank_transactions_truth.csv"), "utf8")).filter(
        (t) => t.account === "operating",
      );
      const cardTruth = csv(readFileSync(join(truth, "card_transactions_truth.csv"), "utf8"));
      const b = tally();
      const c = tally();
      bank.set(letter, b);
      card.set(letter, c);
      // A card's purchases and fees are matched across all its statements: a
      // purchase posted on the statement date sits on whichever the bank chose.
      const cardExpected: { key: string; post: string; narration: string; foreign: string | null }[] = [];
      for (const t of cardTruth) {
        const foreign = t.currency !== "SGD" && t.foreign_amount !== "" ? `${t.currency} -${money(cents(t.foreign_amount ?? "0"))}` : null;
        const post = t.post_date ?? "";
        cardExpected.push({ key: `${t.txn_date} ${post} ${money(-cents(t.sgd_amount ?? "0"))}`, post, narration: t.merchant ?? "", foreign });
        if (cents(t.overseas_fee ?? "0") > 0n) {
          cardExpected.push({ key: `${t.txn_date} ${post} ${money(-cents(t.overseas_fee ?? "0"))}`, post, narration: "OVERSEAS TRANSACTION FEE", foreign: null });
        }
      }
      const cardRead: StatementLineDraft[] = [];
      let lastStatementDate = "";

      for (const m of manifest) {
        const folder = m.folder ?? "";
        const filename = m.filename ?? "";
        const isCard = folder.startsWith("04_");
        if (!filename.endsWith(".pdf") || !(isCard || folder.includes("Operating_Account"))) continue;
        const t = isCard ? c : b;
        t.files += 1;
        const where = `${letter} ${filename}`;
        const outcome: ReadOutcome = await reader.read(inputFor(join(pack, company, folder, filename), filename));

        if (m.scan_mode === "scan") {
          t.scans += 1;
          if (outcome.kind === "not_mine") t.scansNotMine += 1;
          else problems.push(`${where}: a scanned month answered ${outcome.kind}, not not_mine`);
          continue;
        }
        if (outcome.kind !== "read") {
          problems.push(`${where}: answered ${JSON.stringify(outcome)}`);
          continue;
        }
        t.read += 1;
        const draft = outcome.draft;
        const lines = statementLines(draft);
        t.linesRead += lines.length;
        const sign = isCard ? -1n : 1n;
        const opening = money(sign * cents(m.opening_balance ?? "0"));
        const closing = money(sign * cents(m.closing_balance ?? "0"));
        if (draft.control?.opening === opening) t.opening += 1;
        else problems.push(`${where}: opening ${String(draft.control?.opening)}, the key says ${opening}`);
        if (draft.control?.closing === closing) t.closing += 1;
        else problems.push(`${where}: closing ${String(draft.control?.closing)}, the key says ${closing}`);

        const counted = isCard
          ? lines.filter((l) => l.amount.startsWith("-") && !/OVERSEAS TRANSACTION FEE/u.test(l.narration)).length
          : lines.length;
        if (counted === Number(m.txn_count)) t.count += 1;
        else problems.push(`${where}: ${counted} lines, the key says ${m.txn_count ?? "?"}`);

        const sum = lines.reduce((acc, l) => acc + cents(l.amount), 0n);
        if (cents(draft.control?.opening ?? "0") + sum === cents(draft.control?.closing ?? "0")) t.control += 1;
        else problems.push(`${where}: opening + lines != closing`);

        if (isCard) {
          cardRead.push(...lines);
          const printed = await statementDateOf(join(pack, company, folder, filename));
          if (printed !== null && printed > lastStatementDate) lastStatementDate = printed;
          continue;
        }
        const expected = bankTruth
          .filter((x) => (x.date ?? "").startsWith(m.period ?? "?"))
          .map((x) => ({
            key: `${x.date} ${money(cents(x.credit ?? "0") - cents(x.debit ?? "0"))}`,
            narration: x.narration ?? "",
          }));
        t.linesExpected += expected.length;
        for (const l of lines) {
          const hit = take(expected, (e) => e.key === `${l.txnDate} ${l.amount}`);
          if (hit === null) {
            problems.push(`${where}: line ${l.txnDate} ${l.amount} "${l.narration}" is not in the key`);
            continue;
          }
          t.linesMatched += 1;
          // Spaces collapsed on both sides: the key carries a trailing space a
          // PDF cannot show ("OCEAN FRESH SEAFOOD PTE  | SI/25/0768").
          if (hit.narration.replace(/\s+/gu, " ") === l.narration) t.narrationMatched += 1;
        }
        for (const e of expected) problems.push(`${where}: the key's ${e.key} "${e.narration}" was not read`);
      }

      // Cards: every purchase and fee in the key, read once, with its foreign
      // amount. A purchase the key posts after the pack's LAST statement date
      // is on next year's first statement, which the pack does not hold.
      const pool = [...cardRead];
      const onStatements = cardExpected.filter((e) => e.post <= lastStatementDate);
      c.afterLast += cardExpected.length - onStatements.length;
      c.linesExpected += onStatements.length;
      for (const e of onStatements) {
        const hit = take(pool, (l) => `${l.txnDate} ${l.valueDate ?? "?"} ${l.amount}` === e.key);
        if (hit === null) {
          problems.push(`${letter} card: the key's ${e.key} (${e.narration}) was not read`);
          continue;
        }
        c.linesMatched += 1;
        if (hit.narration.startsWith(e.narration)) c.narrationMatched += 1;
        if (e.foreign !== null) {
          c.foreignExpected += 1;
          if (`${hit.originalCurrency ?? "?"} ${hit.originalAmount ?? "?"}` === e.foreign) c.foreignMatched += 1;
          else problems.push(`${letter} card: ${e.key} foreign ${String(hit.originalCurrency)} ${String(hit.originalAmount)}, the key says ${e.foreign}`);
        }
      }
      // What is left is the holder's payments to the card, and nothing else.
      for (const l of pool) {
        if (!(l.amount.startsWith("-") === false && /PAYMENT/u.test(l.narration))) {
          problems.push(`${letter} card: line ${l.txnDate} ${l.amount} "${l.narration}" is not in the key`);
        }
      }
    }

    const rows: string[] = [];
    const row = (kind: string, letter: string, layout: string, t: Tally): void => {
      const digital = t.files - t.scans;
      rows.push(
        [
          `${letter} ${kind}`.padEnd(7),
          layout.padEnd(50),
          `files ${t.files} (scans ${t.scansNotMine}/${t.scans} not_mine)`.padEnd(30),
          `read ${t.read}/${digital}`.padEnd(10),
          `open ${pct(t.opening, digital)}`.padEnd(12),
          `close ${pct(t.closing, digital)}`.padEnd(13),
          `count ${pct(t.count, digital)}`.padEnd(13),
          `control ${pct(t.control, digital)}`.padEnd(15),
          `lines ${t.linesMatched}/${t.linesExpected} ${pct(t.linesMatched, t.linesExpected)}`.padEnd(22),
          `narration ${pct(t.narrationMatched, t.linesMatched)}`.padEnd(17),
          kind === "card" ? `fx ${t.foreignMatched}/${t.foreignExpected}` : "",
          t.afterLast > 0 ? `(${t.afterLast} key entries posted after the pack's last statement)` : "",
        ].join(" "),
      );
    };
    for (const [letter, t] of bank) row("bank", letter, LAYOUT[letter] ?? "", t);
    for (const [letter, t] of card) row("card", letter, CARD_LAYOUT[letter] ?? "", t);
    console.log(`\nPDF statements against the answer key\n${rows.join("\n")}\n`);

    expect(problems).toEqual([]);
    const all = [...bank.values(), ...card.values()];
    // 60 operating-account months and 60 card months; two scanned months per
    // company, all on the operating account.
    expect(all.reduce((n, t) => n + t.files, 0)).toBe(120);
    expect(all.reduce((n, t) => n + t.scans, 0)).toBe(10);
  });

  it("reads no other PDF in the pack as a statement: invoices, credit notes, receipts and scans are someone else's", async () => {
    const others: string[] = [];
    for (const company of companies) {
      for (const folder of readdirSync(join(pack, company)).filter((f) => /^0[0-9]_/u.test(f) && !/^0[34]_/u.test(f))) {
        for (const filename of readdirSync(join(pack, company, folder)).filter((f) => f.toLowerCase().endsWith(".pdf"))) {
          const outcome = await reader.read(inputFor(join(pack, company, folder, filename), filename));
          if (outcome.kind !== "not_mine") others.push(`${company.slice(8, 9)} ${folder}/${filename}: ${outcome.kind}`);
        }
      }
    }
    expect(others).toEqual([]);
  });

  it("makes every phone photo and scan image in the pack ready for the AI reader", async () => {
    const normaliser = new SharpImageNormaliser();
    const refused: string[] = [];
    let n = 0;
    for (const company of companies) {
      for (const folder of readdirSync(join(pack, company)).filter((f) => /^0[0-9]_/u.test(f))) {
        for (const filename of readdirSync(join(pack, company, folder)).filter((f) => /\.(jpe?g|png)$/iu.test(f))) {
          n += 1;
          try {
            const out = await normaliser.normalise(new Uint8Array(readFileSync(join(pack, company, folder, filename))), 1568);
            if (Math.max(out.width, out.height) > 1568) refused.push(`${filename}: ${out.width}x${out.height}`);
          } catch (err) {
            refused.push(`${filename}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }
    expect(n).toBeGreaterThan(50);
    expect(refused).toEqual([]);
  });

  it("uses the product's archive limits, which the pack never comes near (no pack file is an archive)", () => {
    expect(DEFAULT_ARCHIVE_LIMITS.maxEntries).toBe(500);
  });
});
