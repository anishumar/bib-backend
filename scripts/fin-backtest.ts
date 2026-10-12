// The pattern backtest (docs/FIN_BUILD_PLAN.md F5.6):
//
//   npx tsx scripts/fin-backtest.ts [--pack <dir>] [--materiality 2000]
//     [--min-spread 0.2] [--spike-z 6] [--spike-ratio 3] [--seed 20251231]
//     [--per-company 8] [--no-details]
//
// Replays the training pack January–December 2025 per company on ANSWER-KEY
// lines (`99_Ground_Truth/documents_manifest.csv`; why that file, and which
// lines, is in src/domain/fin/pattern-backtest.ts), with the pattern checks
// switching on from April (the 3-month gate does it by itself), and prints the
// flags per client-month per check. Then it injects 10× spikes (a fixed seed,
// several per company, one at a time) and reports how many `pattern.spike`
// caught. Proposed targets: at most 2 flags per client-month on the clean pack,
// and every injected 10× spike caught. The settings default to
// SUGGESTED_PATTERN_SETTINGS; the flags override them for tuning.
//
// It reads files and prints, and nothing else: no database, no network. The
// arithmetic is all in the domain.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TARGET_FLAGS_PER_CLIENT_MONTH,
  catchRate,
  flagStats,
  injectSpikes,
  manifestLines,
  monthsFromTo,
  replayCompany,
} from "../src/domain/fin/pattern-backtest";
import type { CompanyInput, Injection, MonthFlags } from "../src/domain/fin/pattern-backtest";
import type { PatternSettings } from "../src/domain/fin/pattern-settings";
import { SUGGESTED_PATTERN_SETTINGS, patternSettingsProblems } from "../src/domain/fin/pattern-settings";
import { formatCompact } from "../src/domain/fin/pattern-text";

const YEAR = 2025;
const CHECKS = ["pattern.spike", "pattern.new_vendor", "pattern.recurring_missing", "pattern.frequency_change", "pattern.gl_drift"];
const SHORT: Record<string, string> = {
  "pattern.spike": "spike",
  "pattern.new_vendor": "new",
  "pattern.recurring_missing": "missing",
  "pattern.frequency_change": "freq",
  "pattern.gl_drift": "gl",
};

function arg(argv: readonly string[], flag: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq !== undefined) return eq.slice(flag.length + 1);
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

function numberArg(argv: readonly string[], flag: string, fallback: number): number {
  const v = arg(argv, flag);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${flag} must be a number, not ${JSON.stringify(v)}`);
  return n;
}

/** The pack beside the repo, or beside the folder holding a worktree. */
function findPack(explicit: string | undefined): string | null {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const candidates =
    explicit !== undefined
      ? [resolve(explicit)]
      : [join(root, "../fincompliace/SG_BiB_Training_Data_Pack"), join(root, "../../fincompliace/SG_BiB_Training_Data_Pack")];
  return candidates.find((c) => existsSync(join(c, "README.md"))) ?? null;
}

/** Each company's answer-key lines for the year. */
function readPack(pack: string): { companies: CompanyInput[]; leftOut: string[] } {
  const companies: CompanyInput[] = [];
  const leftOut: string[] = [];
  for (const dir of readdirSync(pack).filter((d) => d.startsWith("Company_")).sort()) {
    const company = dir.slice("Company_".length, "Company_".length + 1);
    const read = manifestLines(readFileSync(join(pack, dir, "99_Ground_Truth", "documents_manifest.csv"), "utf8"), YEAR);
    companies.push({ company, lines: read.lines });
    leftOut.push(
      `${company}: ${String(read.lines.length)} purchase-side lines; left out ${String(read.leftOut.notPosted)} not posted, ` +
        `${String(read.leftOut.outsideYear)} dated outside ${String(YEAR)}, ${String(read.leftOut.notPurchaseSide)} sales/payroll documents`,
    );
  }
  return { companies, leftOut };
}

const pad = (s: string, n: number): string => s.padEnd(n);
const lpad = (s: string, n: number): string => s.padStart(n);

function table(months: readonly MonthFlags[]): string[] {
  const out = [`${pad("co", 3)}${pad("month", 9)}${CHECKS.map((c) => lpad(SHORT[c] ?? c, 8)).join("")}${lpad("total", 7)}`];
  for (const m of months) {
    const counts = CHECKS.map((c) => m.findings.filter((f) => f.checkKey === c).length);
    const total = m.findings.length;
    const mark = total > TARGET_FLAGS_PER_CLIENT_MONTH ? "  <- over target" : "";
    out.push(`${pad(m.company, 3)}${pad(m.month, 9)}${counts.map((n) => lpad(String(n), 8)).join("")}${lpad(String(total), 7)}${mark}`);
  }
  return out;
}

function summaryLine(months: readonly MonthFlags[]): string {
  const s = flagStats(months);
  const by = CHECKS.map((c) => `${SHORT[c] ?? c} ${String(s.byCheck[c] ?? 0)}`).join(", ");
  return (
    `${String(s.clientMonths)} client-months, ${String(s.flags)} flags (${(s.flags / Math.max(1, s.clientMonths)).toFixed(2)} a client-month), ` +
    `max ${String(s.maxPerClientMonth)} in one, ${String(s.overTarget)} over the target of ${String(TARGET_FLAGS_PER_CLIENT_MONTH)}; ${by}`
  );
}

/** The spike sizes injected, in percent of the median: 10× is the target,
 *  the smaller ones show how much margin the settings leave. */
const MULTIPLES = [1000, 500, 300, 200];

function run(companies: readonly CompanyInput[], settings: PatternSettings, seed: number, perCompany: number) {
  const months = monthsFromTo(`${String(YEAR)}-01`, `${String(YEAR)}-12`);
  const checked = monthsFromTo(`${String(YEAR)}-04`, `${String(YEAR)}-12`);
  const replay = companies.flatMap((c) => replayCompany(c, months, settings));
  const gatedFlags = replay.filter((m) => m.month < `${String(YEAR)}-04`).reduce((n, m) => n + m.findings.length, 0);
  const onMonths = replay.filter((m) => m.month >= `${String(YEAR)}-04`);
  const bySize = MULTIPLES.map((percent) => {
    const results = companies.map((c, i) => injectSpikes(c, checked, settings, seed + i, perCompany, percent));
    return {
      percent,
      injections: results.flatMap((r): Injection[] => [...r.injections]),
      candidates: results.reduce((n, r) => n + r.candidates, 0),
      belowMateriality: results.reduce((n, r) => n + r.belowMateriality, 0),
    };
  });
  return { onMonths, gatedFlags, bySize };
}

function rateText(injections: readonly Injection[]): string {
  const r = catchRate(injections);
  const pct = r.counted === 0 ? 0 : (100 * r.caught) / r.counted;
  return `${String(r.caught)}/${String(r.counted)} (${pct.toFixed(0)}%)`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const pack = findPack(arg(argv, "--pack"));
  if (pack === null) {
    console.error(
      "The training pack was not found. Pass --pack <dir> (the folder holding Company_A_… and README.md); " +
        "by default it is looked for at ../fincompliace/SG_BiB_Training_Data_Pack beside the repo or beside its worktree folder.",
    );
    process.exit(2);
  }
  const base = SUGGESTED_PATTERN_SETTINGS;
  const settings: PatternSettings = {
    ...base,
    materiality: arg(argv, "--materiality") ?? base.materiality,
    minSpreadRatio: numberArg(argv, "--min-spread", base.minSpreadRatio),
    spikeRobustZ: numberArg(argv, "--spike-z", base.spikeRobustZ),
    spikeRatio: numberArg(argv, "--spike-ratio", base.spikeRatio),
  };
  const problems = patternSettingsProblems(settings);
  if (problems.length > 0) {
    console.error(`Settings refused: ${problems.join("; ")}`);
    process.exit(2);
  }
  const seed = numberArg(argv, "--seed", 20251231);
  const perCompany = numberArg(argv, "--per-company", 8);
  const details = !argv.includes("--no-details");

  const { companies, leftOut } = readPack(pack);
  const r = run(companies, settings, seed, perCompany);
  const money = (v: string): string => formatCompact(v, "SGD");

  const print = (line = ""): void => {
    console.log(line);
  };
  print("FinCompliance pattern backtest (F5.6), answer-key lines");
  print(`pack: ${pack}`);
  print(
    `settings: materiality ${money(settings.materiality)}, spike z > ${String(settings.spikeRobustZ)} or > ${String(settings.spikeRatio)}× median, ` +
      `σ floor ${String(settings.minSpreadRatio)} of median, ${String(settings.minHistoryMonths)} months to switch on, ` +
      `${String(settings.lookbackMonths)} months back, frequency ≥ ${String(settings.frequencyMultiple)}× usual`,
  );
  for (const l of leftOut) print(`  ${l}`);
  print();
  print(`Flags per client-month per check (checks on from ${String(YEAR)}-04; January to March are gated: ${String(r.gatedFlags)} flags there)`);
  for (const l of table(r.onMonths)) print(l);
  print();
  print(`Clean pack: ${summaryLine(r.onMonths)}`);
  for (const c of companies) {
    print(`  ${c.company}: ${summaryLine(r.onMonths.filter((m) => m.company === c.company))}`);
  }
  if (details) {
    print();
    print("Every flag on the clean pack:");
    for (const m of r.onMonths) {
      m.findings.forEach((f, i) => {
        print(`  ${m.company} ${m.month} ${pad(SHORT[f.checkKey] ?? f.checkKey, 8)} ${m.sentences[i] ?? ""}`);
      });
    }
  }
  print();
  const ten = r.bySize.find((b) => b.percent === 1000);
  if (ten !== undefined) {
    print(`Injected 10× spikes (10 × the key's baseline median, seed ${String(seed)}, up to ${String(perCompany)} per company, one at a time):`);
    if (details) {
      for (const i of ten.injections) {
        print(
          `  ${i.company} ${i.month} ${pad(`${i.counterpartyKey} / ${i.glAccount}`, 48)} median ${pad(money(i.median), 9)} → ${pad(money(i.injected), 9)} ${i.caught ? "caught" : "MISSED"}`,
        );
      }
    }
    print(
      `Caught ${rateText(ten.injections)}. ${String(ten.candidates)} key-months had the history to be spiked; ` +
        `${String(ten.belowMateriality)} of them would stay under materiality even at 10× and were not chosen.`,
    );
  }
  print("The same key-months at smaller sizes (an injection under materiality is not counted):");
  for (const b of r.bySize) print(`  ${lpad(String(b.percent / 100), 3)}× the median: caught ${rateText(b.injections)}`);

  print();
  print("σ floor sensitivity (spike flags on the clean pack, and the catch rate by size):");
  for (const floor of [0, 0.05, 0.1, 0.2]) {
    const f = run(companies, { ...settings, minSpreadRatio: floor }, seed, perCompany);
    const spikes = flagStats(f.onMonths).byCheck["pattern.spike"] ?? 0;
    const sizes = f.bySize.map((b) => `${String(b.percent / 100)}× ${rateText(b.injections)}`).join(", ");
    print(`  floor ${pad(String(floor), 5)} ${lpad(String(spikes), 2)} spike flags; ${sizes}`);
  }
  print();
  print("Materiality sensitivity (everything else as above):");
  for (const m of ["1000.00", "2000.00", "5000.00", "10000.00"]) {
    const t = run(companies, { ...settings, materiality: m }, seed, perCompany);
    const st = flagStats(t.onMonths);
    const tenx = t.bySize.find((b) => b.percent === 1000)?.injections ?? [];
    print(
      `  ${pad(money(m), 8)} ${lpad(String(st.flags), 4)} flags, max ${String(st.maxPerClientMonth)} a client-month, ` +
        `${String(st.overTarget)} over target; injected 10× caught ${rateText(tenx)}`,
    );
  }
}

main();
