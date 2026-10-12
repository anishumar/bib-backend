// The pattern backtest's core (docs/FIN_BUILD_PLAN.md F5.6). Pure: it is
// handed the training pack's text and returns numbers; `scripts/fin-backtest.ts`
// reads the files and prints, and `tests/fin/pattern-backtest.test.ts` asserts.
// Nothing in the product imports this file.
//
// ── WHICH LINES: THE ANSWER KEY'S `documents_manifest.csv` ───────────────────
//
// F5.6 runs on ANSWER-KEY lines first (pipeline lines come when F2 and F3
// produce them). Of the two candidates the manifest is the one used, because:
//   - it is one row per DOCUMENT, the grain of the standard line
//     (`DocumentLineDraft`: one line per document), so the backtest exercises
//     the grain the pipeline will commit;
//   - it names the counterparty (`issuer`) and the GL account (`suggested_gl`,
//     the coding F3.3 will produce) in COLUMNS. `ledger_truth.csv` has the
//     vendor only inside free-text narration, and posts receipts and customs
//     permits under bank and card references rather than the document id
//     (company A's 20 receipts have no ledger row under their own id);
//   - `posted_in_ledger = N` marks what the books never took (the duplicate
//     and the prior-year invoice: rule-lane findings, not history).
// This reads `99_Ground_Truth` as the backtest's INPUT, which F5.6 allows and
// ground rule 6 does not forbid: it is the scorecard side, never the pipeline.
//
// The purchase side only: purchase invoices, receipts, customs permit payments
// and supplier credit notes (negative). The amount is what the document books
// to its GL account in SGD: `sgd_total` less recoverable GST (`gst`, when
// `input_gst_claimable` is Y), or the whole `sgd_total` when the GST is not
// claimable (company E, a blocked invoice) or the account IS input GST (a
// customs permit). In this pack no foreign-currency document charges GST, so
// `gst` is already SGD. The month is the document date's; a document dated
// outside the year replayed (the cut-off invoice of January 2026, the
// December 2024 one) is left out.
import type { FindingDraft } from "./finding";
import type { KeyedSummary, Micros, Month } from "./pattern";
import { addMonths, buildProfile, fromMicros, monthIndex, monthOfDay, toMicros } from "./pattern";
import { NOTHING_LEARNT, adjustmentsFor } from "./pattern-learning";
import { patternFindings } from "./pattern-checks";
import type { PatternSettings } from "./pattern-settings";
import { explainPatternFinding } from "./pattern-text";

// ── CSV ──────────────────────────────────────────────────────────────────────

/** RFC 4180: commas, quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (quoted) {
      if (c === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text.charAt(i + 1) === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** Rows as records keyed by the header row. */
export function csvRecords(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  if (header === undefined) return [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

// ── Lines from the answer key ────────────────────────────────────────────────

export interface BacktestLine {
  readonly lineId: string;
  readonly counterpartyKey: string;
  readonly counterpartyName: string;
  readonly glAccount: string;
  readonly month: Month;
  /** SGD, a decimal string. */
  readonly amount: string;
  /** A supplier credit note: a line of the month, but not a BILL, so it is
   *  not counted in the summary's `count` (two bills a month is the
   *  frequency check's signal; an invoice and its credit note is not). */
  readonly isCredit: boolean;
}

export interface ManifestRead {
  readonly lines: readonly BacktestLine[];
  readonly leftOut: { readonly notPurchaseSide: number; readonly notPosted: number; readonly outsideYear: number };
}

const PURCHASE_SIDE = new Set(["purchase_invoice", "receipt", "customs_payment", "credit_note_in"]);
const INPUT_GST_ACCOUNT = "1200";

/** F3.2's last rung, for the backtest: the issuer's name, trimmed, lower case,
 *  spaces collapsed. (The real key prefers the UEN and the GST number.) */
export function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** The purchase-side lines of one company's `documents_manifest.csv`, for
 *  documents dated in `year`. */
export function manifestLines(csv: string, year: number): ManifestRead {
  const lines: BacktestLine[] = [];
  let notPurchaseSide = 0;
  let notPosted = 0;
  let outsideYear = 0;
  for (const r of csvRecords(csv)) {
    const docType = r.doc_type ?? "";
    if (!PURCHASE_SIDE.has(docType)) {
      notPurchaseSide += 1;
      continue;
    }
    if (r.posted_in_ledger !== "Y") {
      notPosted += 1;
      continue;
    }
    const day = r.doc_date ?? "";
    if (!day.startsWith(`${String(year)}-`)) {
      outsideYear += 1;
      continue;
    }
    const gl = r.suggested_gl ?? "";
    const total = toMicros(r.sgd_total ?? "", `sgd_total of ${r.doc_id ?? "?"}`);
    const gst = r.gst === undefined || r.gst === "" ? 0n : toMicros(r.gst, `gst of ${r.doc_id ?? "?"}`);
    const booked: Micros = gl === INPUT_GST_ACCOUNT ? total : r.input_gst_claimable === "Y" ? total - gst : total;
    const signed = docType === "credit_note_in" ? -booked : booked;
    const issuer = r.issuer ?? "";
    lines.push({
      lineId: r.doc_id ?? "",
      counterpartyKey: nameKey(issuer),
      counterpartyName: issuer,
      glAccount: gl,
      month: monthOfDay(day),
      amount: fromMicros(signed),
      isCredit: docType === "credit_note_in",
    });
  }
  return { lines, leftOut: { notPurchaseSide, notPosted, outsideYear } };
}

/** One summary per counterparty × account × month, summed exactly; `count`
 *  is the month's bills (credit notes are in the amount and the line ids, not
 *  in the count). */
export function summarise(lines: readonly BacktestLine[]): KeyedSummary[] {
  const groups = new Map<
    string,
    { s: Omit<KeyedSummary, "amount" | "count" | "lineIds">; amount: Micros; bills: number; lineIds: string[] }
  >();
  for (const l of lines) {
    const id = `${l.counterpartyKey}\u0000${l.glAccount}\u0000${l.month}`;
    const g = groups.get(id) ?? {
      s: { counterpartyKey: l.counterpartyKey, glAccount: l.glAccount, month: l.month },
      amount: 0n,
      bills: 0,
      lineIds: [],
    };
    g.amount += toMicros(l.amount);
    if (!l.isCredit) g.bills += 1;
    g.lineIds.push(l.lineId);
    groups.set(id, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g.s, amount: fromMicros(g.amount), count: g.bills, lineIds: g.lineIds.sort() }))
    .sort((a, b) => monthIndex(a.month) - monthIndex(b.month) || cmp(a.counterpartyKey, b.counterpartyKey) || cmp(a.glAccount, b.glAccount));
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ── The replay ───────────────────────────────────────────────────────────────

export interface CompanyInput {
  readonly company: string;
  readonly lines: readonly BacktestLine[];
}

export interface MonthFlags {
  readonly company: string;
  readonly month: Month;
  readonly findings: readonly FindingDraft[];
  /** The rendered sentence of each finding, in the same order. */
  readonly sentences: readonly string[];
}

/** The months from `from` to `to`, inclusive. */
export function monthsFromTo(from: Month, to: Month): Month[] {
  const out: Month[] = [];
  for (let m = from; monthIndex(m) <= monthIndex(to); m = addMonths(m, 1)) out.push(m);
  return out;
}

const namesOf = (lines: readonly BacktestLine[]): Map<string, string> => new Map(lines.map((l) => [l.counterpartyKey, l.counterpartyName]));

/**
 * Every month of `months` checked with no decisions (nobody has decided
 * anything in a replay). The gate (3 months of history) switches the checks
 * on by itself.
 */
export function replayCompany(input: CompanyInput, months: readonly Month[], settings: PatternSettings): MonthFlags[] {
  const summaries = summarise(input.lines);
  const names = namesOf(input.lines);
  return months.map((month) => {
    const findings = patternFindings({ clientPartyId: input.company, currency: "SGD", month, summaries, decisions: [], settings });
    const sentences = findings.map((f) => {
      const key = typeof f.facts.counterpartyKey === "string" ? f.facts.counterpartyKey : "";
      return explainPatternFinding(f, { counterpartyName: names.get(key) ?? key });
    });
    return { company: input.company, month, findings, sentences };
  });
}

// ── Injected spikes ──────────────────────────────────────────────────────────

/** mulberry32: a tiny seeded generator, so the injections are the same every
 *  run and on every machine. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Injection {
  readonly company: string;
  readonly month: Month;
  readonly counterpartyKey: string;
  readonly glAccount: string;
  /** How big the spike was, in times the median ("10" is a 10× spike). */
  readonly multiple: number;
  /** The key's baseline median that month, and what was put in its place. */
  readonly median: string;
  readonly injected: string;
  /** The injected amount is under materiality: not flagged BY DESIGN, so not
   *  counted as caught or missed. */
  readonly underMateriality: boolean;
  readonly caught: boolean;
}

export interface InjectionResult {
  readonly injections: readonly Injection[];
  /** Key-months with enough history to be spiked at all. */
  readonly candidates: number;
  /** Of those, how many a 10× spike would still leave under materiality (never
   *  chosen: no spike of theirs could be flagged by design). */
  readonly belowMateriality: number;
}

/** The share caught among the injections that were at least materiality. */
export function catchRate(injections: readonly Injection[]): { caught: number; counted: number } {
  const counted = injections.filter((i) => !i.underMateriality);
  return { caught: counted.filter((i) => i.caught).length, counted: counted.length };
}

/**
 * Choose `count` key-months with `seed` and replace each month's amount with
 * `multiplePercent`/100 × the key's baseline median (1000 = a 10× spike),
 * rounded to the cent, one at a time, then see whether `pattern.spike` catches
 * it. A candidate is a key billed that month with at least `minHistoryMonths`
 * baseline months and a positive median, in `months`, whose 10× spike would
 * reach materiality. The choice does not depend on the multiple, so the same
 * key-months are spiked at every size and the catch rates compare.
 */
export function injectSpikes(
  input: CompanyInput,
  months: readonly Month[],
  settings: PatternSettings,
  seed: number,
  count: number,
  multiplePercent = 1000,
): InjectionResult {
  const summaries = summarise(input.lines);
  const materiality = toMicros(settings.materiality);
  const candidates: { s: KeyedSummary; median: Micros }[] = [];
  let all = 0;
  for (const month of months) {
    for (const s of summaries.filter((x) => x.month === month)) {
      const history = summaries.filter(
        (x) => x.counterpartyKey === s.counterpartyKey && x.glAccount === s.glAccount && monthIndex(x.month) < monthIndex(month),
      );
      const p = buildProfile({
        counterpartyKey: s.counterpartyKey,
        glAccount: s.glAccount,
        history,
        asOf: addMonths(month, -1),
        lookbackMonths: settings.lookbackMonths,
        minSpreadRatio: settings.minSpreadRatio,
        adjustments: adjustmentsFor(NOTHING_LEARNT, s.counterpartyKey, s.glAccount),
      });
      if (p === null || p.median === null || p.median <= 0n || p.baseline.length < settings.minHistoryMonths) continue;
      all += 1;
      if (p.median * 10n < materiality) continue;
      candidates.push({ s, median: p.median });
    }
  }
  const random = seededRandom(seed);
  const pool = [...candidates];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = pool[i];
    const b = pool[j];
    if (a === undefined || b === undefined) continue;
    pool[i] = b;
    pool[j] = a;
  }
  const CENT = 10_000n;
  const injections = pool.slice(0, count).map(({ s, median }) => {
    const injected = ((median * BigInt(multiplePercent)) / 100n + CENT / 2n) / CENT * CENT;
    const spiked = summaries.map((x) => (x === s ? { ...x, amount: fromMicros(injected) } : x));
    const findings = patternFindings({ clientPartyId: input.company, currency: "SGD", month: s.month, summaries: spiked, decisions: [], settings });
    const caught = findings.some(
      (f) => f.checkKey === "pattern.spike" && f.facts.counterpartyKey === s.counterpartyKey && f.facts.glAccount === s.glAccount,
    );
    return {
      company: input.company,
      month: s.month,
      counterpartyKey: s.counterpartyKey,
      glAccount: s.glAccount,
      multiple: multiplePercent / 100,
      median: fromMicros(median),
      injected: fromMicros(injected),
      underMateriality: injected < materiality,
      caught,
    };
  });
  return { injections, candidates: all, belowMateriality: all - candidates.length };
}

// ── The numbers ──────────────────────────────────────────────────────────────

export interface FlagStats {
  readonly clientMonths: number;
  readonly flags: number;
  readonly maxPerClientMonth: number;
  /** Client-months above the proposed target of 2. */
  readonly overTarget: number;
  readonly byCheck: Readonly<Record<string, number>>;
}

export const TARGET_FLAGS_PER_CLIENT_MONTH = 2;

export function flagStats(months: readonly MonthFlags[]): FlagStats {
  const byCheck: Record<string, number> = {};
  let flags = 0;
  let max = 0;
  let over = 0;
  for (const m of months) {
    flags += m.findings.length;
    max = Math.max(max, m.findings.length);
    if (m.findings.length > TARGET_FLAGS_PER_CLIENT_MONTH) over += 1;
    for (const f of m.findings) byCheck[f.checkKey] = (byCheck[f.checkKey] ?? 0) + 1;
  }
  return { clientMonths: months.length, flags, maxPerClientMonth: max, overTarget: over, byCheck };
}
