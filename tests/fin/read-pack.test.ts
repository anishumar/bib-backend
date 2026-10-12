// The sheet reader on the training pack (docs/FIN_BUILD_PLAN.md F2.9's CSV half,
// F2.11's sheet side, F2.12's POS files): every payroll-account statement CSV,
// every payroll workbook, every CPF submission CSV and company C's POS files,
// read through the real reader and compared with the answer key.
//
// `99_Ground_Truth` is read here as the EXPECTED answer only, never handed to
// the reader (ground rule 6). The pack is not in the repository, so the test
// skips where it is absent, as CI is.
//
// What is compared, per file:
//   statements  opening, closing and line count against
//               `statement_files_manifest.csv`. The opening is the one the file
//               prints, else the first line's balance less its amount; the
//               closing is the one it prints, else the last balance.
//   payroll     each line against `payroll_truth.csv` (the INPUT side: what the
//               sheet shows, seeded errors included): gross, both CPF shares,
//               SDL, FWL, net, age and pass type, wherever the sheet prints one.
//   CPF         each line against the same truth: both CPF shares, and ordinary
//               plus additional wages against gross.
//   POS         each day's lines, summed, against the day's takings entry in
//               `ledger_truth.csv`: gross, GST, and sales plus service charge.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCsv } from "../../src/infrastructure/sheet/grid-reader";
import { FinSheetGrid } from "../../src/infrastructure/fin/sheet-grid";
import { SheetDocumentReader } from "../../src/usecase/fin/read-sheet";
import { checkControl, sameDecimal, subtractDecimals, sumDecimals } from "../../src/domain/fin/control";
import { maskedNric } from "../../src/domain/fin/sheet-values";
import type {
  DocumentLineDraft,
  LineDraft,
  PayrollLineDraft,
  ReadDraft,
  StatementLineDraft,
} from "../../src/domain/fin/lines";
import { FakeFirmCurrency, FakeSourceFormats } from "../../src/testfakes/fin-reads";
import { FakeContentDigest } from "../../src/testfakes/filestore";
import { FakeIds } from "../../src/testfakes/ids";

/** Beside the repository's checkout, or beside the folder its worktrees are in. */
const PACK =
  [join(process.cwd(), "..", "fincompliace"), join(process.cwd(), "..", "..", "fincompliace")]
    .map((d) => join(d, "SG_BiB_Training_Data_Pack"))
    .find((d) => existsSync(d)) ?? "";
const COMPANIES = ["A", "B", "C", "D", "E"] as const;

function companyDir(letter: string): string {
  const dir = readdirSync(PACK).find((d) => d.startsWith(`Company_${letter}_`));
  if (dir === undefined) throw new Error(`no company ${letter} in the pack`);
  return join(PACK, dir);
}

function table(path: string): Record<string, string>[] {
  const [head, ...rows] = parseCsv(readFileSync(path, "utf8"));
  return rows.map((r) => Object.fromEntries((head ?? []).map((h, i) => [h, r[i] ?? ""])));
}

function filesIn(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => pattern.test(f))
    .sort()
    .map((f) => join(dir, f));
}

/** A truth figure ("1480.0") against a read one ("1480"). */
function same(read: string | null, truth: string | undefined): boolean {
  return read !== null && truth !== undefined && truth !== "" && sameDecimal(read, truth);
}

const PASS_OF: Readonly<Record<string, string>> = {
  SC: "citizen",
  PR: "pr",
  EP: "employment_pass",
  SP: "s_pass",
  WP: "work_permit",
};

interface Tally {
  files: number;
  staged: number;
  /** Files whose every compared figure matched. */
  matched: number;
  /** The second and later files of a layout read with a stored map. */
  reused: number;
  fields: number;
  fieldsMatched: number;
  misses: string[];
}

function tally(): Tally {
  return { files: 0, staged: 0, matched: 0, reused: 0, fields: 0, fieldsMatched: 0, misses: [] };
}

async function readAll(letter: string, files: readonly string[], formats: FakeSourceFormats) {
  const reader = new SheetDocumentReader({
    grids: new FinSheetGrid(),
    formats,
    currency: new FakeFirmCurrency("SGD"),
    digest: new FakeContentDigest(),
    ids: new FakeIds(),
  });
  const tenantId = `00000000-0000-4000-8000-00000000000${String(COMPANIES.indexOf(letter as (typeof COMPANIES)[number]) + 1)}`;
  const out: { path: string; draft: ReadDraft | null; problem: string | null }[] = [];
  for (const path of files) {
    const outcome = await reader.read({
      tenantId,
      intakeItemId: `00000000-0000-4000-8000-${String(out.length + 1).padStart(12, "0")}`,
      documentVersionId: "00000000-0000-4000-8000-0000000000a1",
      clientPartyId: null,
      route: "sheet",
      mediaType: "text/csv",
      filename: basename(path),
      bytes: new Uint8Array(readFileSync(path)),
    });
    out.push({
      path,
      draft: outcome.kind === "read" ? outcome.draft : null,
      problem: outcome.kind === "needs_person" ? outcome.problem : outcome.kind,
    });
  }
  return out;
}

/** Counts a read's place in its layout's history: a later file read with the
 *  map the first one taught. */
function countReuse(t: Tally, reads: readonly { draft: ReadDraft | null }[]): void {
  const seen = new Set<string>();
  for (const r of reads) {
    const id = r.draft?.formatId ?? null;
    if (id === null) continue;
    if (seen.has(id)) t.reused += 1;
    seen.add(id);
  }
}

const report: string[] = [];

describe.skipIf(PACK === "")("the sheet reader on the training pack", () => {
  it("reads every payroll-account statement CSV to the manifest's opening, closing and line count", async () => {
    for (const letter of COMPANIES) {
      const dir = companyDir(letter);
      const manifest = table(join(dir, "99_Ground_Truth", "statement_files_manifest.csv"));
      const folder = readdirSync(join(dir, "03_Bank_Statements")).find((d) => d.startsWith("Payroll_Account_")) ?? "";
      const files = filesIn(join(dir, "03_Bank_Statements", folder), /\.csv$/i);
      const reads = await readAll(letter, files, new FakeSourceFormats());
      const t = tally();
      countReuse(t, reads);
      for (const r of reads) {
        t.files += 1;
        const name = basename(r.path);
        const expected = manifest.find((m) => m.folder === `03_Bank_Statements/${folder}` && m.filename === name);
        if (r.draft === null || expected === undefined) {
          t.misses.push(`${name}: ${r.problem ?? "not in the manifest"}`);
          continue;
        }
        if (checkControl(r.draft).ok) t.staged += 1;
        const lines = r.draft.lines as StatementLineDraft[];
        const first = lines[0];
        const last = lines.at(-1);
        const opening =
          r.draft.control?.opening ??
          (first === undefined || first.balance === null ? null : subtractDecimals(first.balance, first.amount));
        const closing = r.draft.control?.closing ?? last?.balance ?? null;
        const checks = [
          same(opening, expected.opening_balance),
          same(closing, expected.closing_balance),
          String(lines.length) === expected.txn_count,
        ];
        t.fields += checks.length;
        t.fieldsMatched += checks.filter(Boolean).length;
        if (checks.every(Boolean)) t.matched += 1;
        else t.misses.push(`${name}: read ${String(opening)} / ${String(closing)} / ${String(lines.length)}, expected ${expected.opening_balance} / ${expected.closing_balance} / ${expected.txn_count}`);
      }
      report.push(`${letter} statements (${folder}): ${String(t.matched)}/${String(t.files)} files match, ${String(t.staged)} staged, ${String(t.reused)} read with a learnt map`);
      expect(t.misses, `${letter}: ${t.misses.join("; ")}`).toEqual([]);
      expect(t.matched).toBe(12);
      expect(t.reused).toBe(11);
    }
  });

  it("reads every payroll workbook and CPF submission to payroll_truth, field by field", async () => {
    for (const letter of COMPANIES) {
      const dir = companyDir(letter);
      const truth = table(join(dir, "99_Ground_Truth", "payroll_truth.csv"));
      for (const [label, files] of [
        ["payroll", filesIn(join(dir, "05_Payroll"), /\.xlsx$/i)],
        ["CPF", filesIn(join(dir, "05_Payroll", "CPF_Submission_Files"), /\.csv$/i)],
      ] as const) {
        const reads = await readAll(letter, files, new FakeSourceFormats());
        const t = tally();
        countReuse(t, reads);
        let lines = 0;
        let linesFound = 0;
        for (const r of reads) {
          t.files += 1;
          const name = basename(r.path);
          if (r.draft === null) {
            t.misses.push(`${name}: ${r.problem ?? ""}`);
            continue;
          }
          if (checkControl(r.draft).ok) t.staged += 1;
          let fileOk = true;
          for (const line of r.draft.lines as PayrollLineDraft[]) {
            lines += 1;
            const month = truth.filter((row) => row.month === line.period);
            // By the reference the sheet gives (an id, else the masked NRIC),
            // and by name only when it gives neither.
            const byRef = month.filter(
              (row) => row.emp_id === line.employeeRef || maskedNric(row.nric_fin ?? "") === line.employeeRef,
            );
            const candidates =
              byRef.length > 0
                ? byRef
                : month.filter((row) => (row.name ?? "").toLowerCase() === (line.employeeName ?? "").toLowerCase());
            // Two employees of one name (company C has two Ho Hui Mins) are
            // told apart by age, as the sheet prints a birth date.
            const row =
              candidates.length === 1
                ? candidates[0]
                : candidates.find((c) => c.age_at_month_start === String(line.age ?? ""));
            if (row === undefined) {
              fileOk = false;
              t.misses.push(`${name}: ${line.employeeRef} matched ${String(candidates.length)} truth rows`);
              continue;
            }
            linesFound += 1;
            const pairs: [string, string | null, string | undefined][] =
              label === "CPF"
                ? [
                    ["employee_cpf", line.cpfEmployee, row.employee_cpf],
                    ["employer_cpf", line.cpfEmployer, row.employer_cpf],
                    [
                      "gross",
                      line.ordinaryWage === null ? null : sumDecimals([line.ordinaryWage, line.additionalWage ?? "0"]),
                      row.gross,
                    ],
                  ]
                : [
                    ["gross", line.grossPay, row.gross],
                    ["employee_cpf", line.cpfEmployee, row.employee_cpf],
                    ["employer_cpf", line.cpfEmployer, row.employer_cpf],
                    ["sdl", line.sdl, row.sdl],
                    ["foreign_worker_levy", line.fwl, row.foreign_worker_levy],
                    ["net_pay", line.netPay, row.net_pay],
                  ];
            for (const [field, read, expected] of pairs) {
              if (read === null) continue;
              t.fields += 1;
              if (same(read, expected)) t.fieldsMatched += 1;
              else {
                fileOk = false;
                t.misses.push(`${name} ${line.employeeRef} ${field}: read ${read}, expected ${expected ?? ""}`);
              }
            }
            if (line.age !== null && row.age_at_month_start !== "") {
              t.fields += 1;
              if (String(line.age) === row.age_at_month_start) t.fieldsMatched += 1;
              else t.misses.push(`${name} ${line.employeeRef} age: read ${String(line.age)}, expected ${row.age_at_month_start ?? ""}`);
            }
            if (line.passType !== null) {
              t.fields += 1;
              if (PASS_OF[row.status ?? ""] === line.passType) t.fieldsMatched += 1;
              else t.misses.push(`${name} ${line.employeeRef} pass: read ${line.passType}, expected ${row.status ?? ""}`);
            }
          }
          // Every employee the truth has for the month is on the sheet.
          const period = (r.draft.lines[0] as PayrollLineDraft | undefined)?.period;
          const expectedRows = truth.filter((row) =>
            row.month === period && (label === "payroll" || Number(row.employee_cpf) > 0 || Number(row.employer_cpf) > 0),
          ).length;
          if (r.draft.lines.length !== expectedRows) {
            fileOk = false;
            t.misses.push(`${name}: ${String(r.draft.lines.length)} lines, the truth has ${String(expectedRows)}`);
          }
          if (fileOk) t.matched += 1;
        }
        const uncertain = new Set(reads.flatMap((r) => (r.draft?.lines ?? []).flatMap((l: LineDraft) => [...l.uncertain])));
        report.push(
          `${letter} ${label}: ${String(t.matched)}/${String(t.files)} files match, ${String(linesFound)}/${String(lines)} lines found, ` +
            `${String(t.fieldsMatched)}/${String(t.fields)} figures match, ${String(t.staged)} staged, ${String(t.reused)} read with a learnt map` +
            (uncertain.size > 0 ? `, unsure of: ${[...uncertain].join(", ")}` : ""),
        );
        expect(t.misses, `${letter} ${label}: ${t.misses.slice(0, 10).join("; ")}`).toEqual([]);
        expect(t.matched).toBe(12);
        expect(t.reused).toBe(11);
      }
    }
  });

  it("reads company C's daily POS files to the takings the ledger books each day", async () => {
    const dir = companyDir("C");
    const ledger = table(join(dir, "99_Ground_Truth", "ledger_truth.csv")).filter((r) => r.reference?.startsWith("POS-"));
    const reads = await readAll("C", filesIn(join(dir, "02_Sales_Invoices", "POS_Daily_Sales"), /\.csv$/i), new FakeSourceFormats());
    const t = tally();
    countReuse(t, reads);
    let days = 0;
    let daysMatched = 0;
    for (const r of reads) {
      t.files += 1;
      if (r.draft === null) {
        t.misses.push(`${basename(r.path)}: ${r.problem ?? ""}`);
        continue;
      }
      if (checkControl(r.draft).ok) t.staged += 1;
      const byDay = new Map<string, DocumentLineDraft[]>();
      for (const line of r.draft.lines as DocumentLineDraft[]) {
        const day = line.docDate ?? "";
        byDay.set(day, [...(byDay.get(day) ?? []), line]);
      }
      let fileOk = true;
      for (const [day, lines] of byDay) {
        days += 1;
        const entry = ledger.filter((e) => e.reference === `POS-${day}`);
        const account = (code: string, side: "debit" | "credit"): string => entry.find((e) => e.account === code)?.[side] ?? "";
        const sum = (pick: (l: DocumentLineDraft) => string | null): string | null =>
          lines.every((l) => pick(l) !== null) ? sumDecimals(lines.map((l) => pick(l) ?? "0")) : null;
        const checks = [
          same(sum((l) => l.total), account("1120", "debit")),
          same(sum((l) => l.gst), account("2100", "credit")),
          same(sum((l) => l.net), sumDecimals([account("4030", "credit") || "0", account("4040", "credit") || "0"])),
        ];
        t.fields += checks.length;
        t.fieldsMatched += checks.filter(Boolean).length;
        if (checks.every(Boolean)) daysMatched += 1;
        else {
          fileOk = false;
          t.misses.push(`${day}: ${checks.map(String).join(",")}`);
        }
      }
      if (fileOk) t.matched += 1;
    }
    report.push(
      `C POS: ${String(t.matched)}/${String(t.files)} files match, ${String(daysMatched)}/${String(days)} days match the ledger, ` +
        `${String(t.fieldsMatched)}/${String(t.fields)} figures, ${String(t.staged)} staged, ${String(t.reused)} read with a learnt map`,
    );
    expect(t.misses.slice(0, 10)).toEqual([]);
    expect(t.matched).toBe(12);
    expect(t.reused).toBe(11);
  });

  it("recognises every reference master and reads it into no lines", async () => {
    for (const letter of COMPANIES) {
      const files = filesIn(join(companyDir(letter), "00_Reference"), /\.(csv|xlsx)$/i);
      const reads = await readAll(letter, files, new FakeSourceFormats());
      expect(reads.map((r) => [basename(r.path), r.draft?.docKind ?? r.problem])).toEqual(
        files.map((f) => [basename(f), "master"]),
      );
      report.push(`${letter} masters: ${String(reads.length)}/${String(files.length)} recognised as masters`);
    }
    console.log(`\n  The training pack, read by the sheet reader:\n    ${report.join("\n    ")}\n`);
  });
});
