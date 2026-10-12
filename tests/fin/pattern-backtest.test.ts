// The pattern backtest (docs/FIN_BUILD_PLAN.md F5.6): its core on small
// fixtures, then on the training pack when the pack is there.
//
// The pack half reads `99_Ground_Truth/documents_manifest.csv` as the
// backtest's INPUT LINES. F5.6 asks for exactly that ("answer-key lines
// first"), and it is not a reader's input: no document reader is involved,
// and the pattern checks themselves never read a file. It skips when the pack
// folder is absent (CI, or a machine without it).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  TARGET_FLAGS_PER_CLIENT_MONTH,
  catchRate,
  csvRecords,
  flagStats,
  injectSpikes,
  manifestLines,
  monthsFromTo,
  nameKey,
  parseCsv,
  replayCompany,
  seededRandom,
  summarise,
} from "../../src/domain/fin/pattern-backtest";
import type { BacktestLine, CompanyInput } from "../../src/domain/fin/pattern-backtest";
import { SUGGESTED_PATTERN_SETTINGS } from "../../src/domain/fin/pattern-settings";

const S = SUGGESTED_PATTERN_SETTINGS;

describe("reading the answer key", () => {
  it("parses CSV with quoted commas, doubled quotes and CRLF", () => {
    expect(parseCsv('a,b,c\r\n1,"Freight, customs and logistics","say ""hi"""\r\n\r\n')).toEqual([
      ["a", "b", "c"],
      ["1", "Freight, customs and logistics", 'say "hi"'],
    ]);
    expect(csvRecords("x,y\n1,2\n3\n")).toEqual([
      { x: "1", y: "2" },
      { x: "3", y: "" },
    ]);
  });

  const HEADER =
    "doc_id,company,folder,filename,doc_type,issuer,recipient,doc_number,doc_date,currency,subtotal,gst,total,sgd_total,fx_rate,gst_code,suggested_gl,input_gst_claimable,template_id,format,scan_mode,flags,posted_in_ledger,bank_txn_ids,dup_of";
  const row = (id: string, type: string, issuer: string, date: string, sub: string, gst: string, sgd: string, gl: string, claim: string, posted = "Y"): string =>
    `${id},A,01,f.pdf,${type},${issuer},Client,N1,${date},SGD,${sub},${gst},${sgd},${sgd},1.0,TX,${gl},${claim},0,pdf_digital,,,${posted},,`;

  it("takes the purchase side, booked amount per GL in SGD, and leaves out what the books never took", () => {
    const csv = [
      HEADER,
      row("A-PI-1", "purchase_invoice", "SeaLink  Logistics Pte Ltd", "2025-01-13", "7111.0", "639.99", "7750.99", "6250", "Y"),
      row("A-PI-2", "purchase_invoice", "FreshPantry", "2025-09-17", "792.0", "71.28", "863.28", "6210", "N"),
      row("A-CU-1", "customs_payment", "Singapore Customs (permit payment)", "2025-03-05", "", "5046.45", "5046.45", "1200", "Y"),
      row("A-CN-1", "credit_note_in", "PackRight", "2025-07-01", "180.0", "16.2", "196.2", "6310", "Y"),
      row("A-PI-3", "purchase_invoice", "Dup Co", "2025-05-01", "100", "9", "109", "6200", "Y", "N"),
      row("A-PI-4", "purchase_invoice", "Late Co", "2026-01-06", "100", "9", "109", "6200", "Y"),
      row("A-SI-1", "sales_invoice", "Lumen", "2025-01-31", "42000", "3780", "45780", "4000", ""),
    ].join("\n");
    const read = manifestLines(csv, 2025);
    expect(read.leftOut).toEqual({ notPurchaseSide: 1, notPosted: 1, outsideYear: 1 });
    expect(read.lines.map((l) => [l.lineId, l.counterpartyKey, l.glAccount, l.month, l.amount, l.isCredit])).toEqual([
      ["A-PI-1", "sealink logistics pte ltd", "6250", "2025-01", "7111.00", false],
      ["A-PI-2", "freshpantry", "6210", "2025-09", "863.28", false],
      ["A-CU-1", "singapore customs (permit payment)", "1200", "2025-03", "5046.45", false],
      ["A-CN-1", "packright", "6310", "2025-07", "-180.00", true],
    ]);
    expect(nameKey("  Tan  Lim and Partners PAC ")).toBe("tan lim and partners pac");
  });

  it("summarises exactly, and a credit note is not a bill", () => {
    const line = (lineId: string, amount: string, isCredit = false): BacktestLine => ({
      lineId,
      counterpartyKey: "packright",
      counterpartyName: "PackRight",
      glAccount: "6310",
      month: "2025-07",
      amount,
      isCredit,
    });
    expect(summarise([line("b", "0.10"), line("a", "0.20"), line("c", "-0.05", true)])).toEqual([
      { counterpartyKey: "packright", glAccount: "6310", month: "2025-07", amount: "0.25", count: 2, lineIds: ["a", "b", "c"] },
    ]);
  });
});

describe("the replay and the injections, on a small company", () => {
  const lines: BacktestLine[] = [];
  const add = (cp: string, gl: string, month: string, amount: string): void => {
    lines.push({ lineId: `${cp}-${month}`, counterpartyKey: cp, counterpartyName: cp.toUpperCase(), glAccount: gl, month, amount, isCredit: false });
  };
  for (const mm of ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"]) {
    add("rent", "6100", `2025-${mm}`, "9800");
    add("cloud", "6140", `2025-${mm}`, String(7000 + Number(mm) * 100));
  }
  add("newco", "6130", "2025-05", "12000");
  const company: CompanyInput = { company: "Z", lines };
  const year = monthsFromTo("2025-01", "2025-12");

  it("gates January to March and flags the new vendor in May, with its sentence", () => {
    const months = replayCompany(company, year, S);
    expect(months.slice(0, 3).every((m) => m.findings.length === 0)).toBe(true);
    const may = months.find((m) => m.month === "2025-05");
    expect(may?.sentences).toEqual(["NEWCO: new vendor, S$12,000 this month (1 bill); none in the previous 4 months"]);
    expect(flagStats(months.slice(3))).toMatchObject({ clientMonths: 9, flags: 1, maxPerClientMonth: 1, overTarget: 0 });
  });

  it("catches every injected 10× spike, choosing the same key-months at every size", () => {
    const checked = monthsFromTo("2025-04", "2025-12");
    const ten = injectSpikes(company, checked, S, 7, 6);
    const two = injectSpikes(company, checked, S, 7, 6, 200);
    expect(ten.injections).toHaveLength(6);
    expect(catchRate(ten.injections)).toEqual({ caught: 6, counted: 6 });
    expect(two.injections.map((i) => [i.month, i.counterpartyKey])).toEqual(ten.injections.map((i) => [i.month, i.counterpartyKey]));
    for (const i of ten.injections) expect(i.injected).toBe(`${String(Number(i.median) * 10)}.00`);
  });

  it("the seeded choice is the same on every run", () => {
    const a = seededRandom(20251231);
    const b = seededRandom(20251231);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

// ── The training pack ────────────────────────────────────────────────────────

function findPack(): string | null {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const candidates = [join(root, "../fincompliace/SG_BiB_Training_Data_Pack"), join(root, "../../fincompliace/SG_BiB_Training_Data_Pack")];
  return candidates.find((c) => existsSync(join(c, "README.md"))) ?? null;
}

const PACK = findPack();

describe.skipIf(PACK === null)("the training pack (F5.6), answer-key lines", () => {
  const companies: CompanyInput[] =
    PACK === null
      ? []
      : readdirSync(PACK)
          .filter((d) => d.startsWith("Company_"))
          .sort()
          .map((dir) => ({
            company: dir.slice("Company_".length, "Company_".length + 1),
            lines: manifestLines(readFileSync(join(PACK, dir, "99_Ground_Truth", "documents_manifest.csv"), "utf8"), 2025).lines,
          }));
  const year = monthsFromTo("2025-01", "2025-12");
  const checked = monthsFromTo("2025-04", "2025-12");

  it("has the five companies' purchase lines", () => {
    expect(companies.map((c) => c.company)).toEqual(["A", "B", "C", "D", "E"]);
    expect(companies.every((c) => c.lines.length > 100)).toBe(true);
  });

  it("the checks switch on in April by the 3-month gate, and the clean pack stays within 2 flags per client-month", () => {
    const replay = companies.flatMap((c) => replayCompany(c, year, S));
    expect(replay.filter((m) => m.month < "2025-04").every((m) => m.findings.length === 0)).toBe(true);
    const stats = flagStats(replay.filter((m) => m.month >= "2025-04"));
    expect(stats.clientMonths).toBe(45);
    expect(stats.maxPerClientMonth).toBeLessThanOrEqual(TARGET_FLAGS_PER_CLIENT_MONTH);
    expect(stats.overTarget).toBe(0);
    // No spike on the clean pack: the σ floor's whole point (without it, 5).
    expect(stats.byCheck["pattern.spike"] ?? 0).toBe(0);
    expect(replay.every((m) => m.findings.every((f) => f.lane === "pattern"))).toBe(true);
  });

  it("catches 100% of injected 10× spikes", () => {
    const injections = companies.flatMap((c, i) => [...injectSpikes(c, checked, S, 20251231 + i, 8).injections]);
    const rate = catchRate(injections);
    expect(rate.counted).toBe(40);
    expect(rate.caught).toBe(rate.counted);
  });
});
