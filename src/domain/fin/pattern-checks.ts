// The pattern checks (docs/FIN_BUILD_PLAN.md F5.2) and their gate (F5.5). Pure.
//
// One call judges one client's month against that client's own past and
// returns `FindingDraft`s in lane `pattern`: shown in their own panel and NEVER
// counted in the exception score. Rules and arithmetic decide; every threshold
// is a `PatternSettings` value passed in; every money fact is a decimal string;
// the words are written at READ time from the facts (`pattern-text.ts`), never
// stored. Nothing here reads a file or a table.
//
// ── THE GATE (F5.5) ─────────────────────────────────────────────────────────
//
// No pattern finding at all for a client with fewer than `minHistoryMonths` (3)
// months of committed history before the month checked: "normal" is undefined
// until there is some. On the training pack (January–December) the checks
// therefore switch on in April by themselves.
//
// ── THE FIVE CHECKS ─────────────────────────────────────────────────────────
//
// The unit is a key: client × counterparty key × GL account. History is the
// `lookbackMonths` before the month checked.
//
//   spike: the key has at least `minHistoryMonths` baseline months, this
//     month's amount is positive and at least materiality, and its robust z is
//     above `spikeRobustZ` OR it is more than `spikeRatio` × the median. A
//     month marked seasonal is judged against the same month last year instead
//     (ratio only; no last year, no judgement). Only UPWARD: a drop is not a
//     spike, and a vendor that stops is `recurring_missing`.
//   new_vendor: a counterparty with no line at all in the history, whose lines
//     this month total at least materiality. One finding per counterparty,
//     however many accounts.
//   recurring_missing: a key whose cadence is monthly or quarterly, whose
//     counterparty has NO line this month on any account (a move to another
//     account is `gl_drift`, not a disappearance), whose bill was due
//     (`cadenceGap + missingGraceMonths` months after it was last seen, exactly:
//     ONE finding per stop, not one every month after), and whose usual
//     (median) amount is at least materiality.
//   frequency_change: a monthly or quarterly key with at least
//     `frequencyMultiple` × its usual lines this month (and at least two),
//     whose amount this month is at least materiality.
//   gl_drift: a counterparty with an ESTABLISHED coding (an account it was
//     coded to in at least `minHistoryMonths` months of the history), coded
//     this month to an account that is not usual for it, with at least
//     materiality on that account. Usual = coded there in at least
//     `minHistoryMonths` months, or accepted by a person (`expected` on an
//     earlier drift). So a second miscoding to the same account is flagged
//     again, and a vendor that really moved stops being flagged after three
//     months on the new account, or at once when a person says so.
//
// Each check's materiality (and the spike's z and ratio) is raised for this
// client by what its decisions taught (`pattern-learning.ts`).
//
// ── DEDUPE ──────────────────────────────────────────────────────────────────
//
// `pattern.<check>:<client>:<month>:<counterparty>:<account or *>`, each part
// URI-encoded, so a re-run of the same month raises nothing new and a colon in
// a key cannot make two findings collide.
import type { FindingDraft, FindingFact } from "./finding";
import type { KeyedSummary, Micros, Month, PatternCheckKey, Profile } from "./pattern";
import {
  PATTERN_CHECK_KEYS,
  addMonths,
  buildProfile,
  cadenceGap,
  firstDayOf,
  fromMicros,
  isMonth,
  lastDayOf,
  monthIndex,
  monthOfYear,
  ratioTo,
  robustZ,
  scaleMicros,
  toMicros,
} from "./pattern";
import type { PatternDecision, PatternLearning } from "./pattern-learning";
import { adjustmentsFor, barPercent, learnFromDecisions } from "./pattern-learning";
import type { PatternSettings } from "./pattern-settings";
import { patternSettingsProblems } from "./pattern-settings";

export interface PatternRun {
  readonly clientPartyId: string;
  /** The client's base currency: every summary amount is in it. */
  readonly currency: string;
  /** The month judged. */
  readonly month: Month;
  /** The client's committed summaries: history and the month itself. Months
   *  after `month` are ignored, so a replay can pass the whole year. */
  readonly summaries: readonly KeyedSummary[];
  /** The client's decisions on earlier pattern findings, oldest first. */
  readonly decisions: readonly PatternDecision[];
  readonly settings: PatternSettings;
}

/** The client's months of committed history before `month` (F5.5's count). */
export function historyMonthsBefore(summaries: readonly KeyedSummary[], month: Month): number {
  const cut = monthIndex(month);
  return new Set(summaries.map((s) => monthIndex(s.month)).filter((i) => i < cut)).size;
}

const cmpText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const keyId = (counterpartyKey: string, glAccount: string): string => `${counterpartyKey}\u0000${glAccount}`;

function dedupeKey(check: PatternCheckKey, client: string, month: Month, counterpartyKey: string, glAccount: string | null): string {
  return [check, client, month, counterpartyKey, glAccount ?? "*"].map(encodeURIComponent).join(":");
}

const round = (v: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

/** A z-score as a fact: one decimal, null when it is infinite (σ was zero). */
const zFact = (z: number): number | null => (Number.isFinite(z) ? round(z, 1) : null);

const maybeAmount = (v: Micros | null): string | null => (v === null ? null : fromMicros(v));

interface CurrentKey {
  readonly counterpartyKey: string;
  readonly glAccount: string;
  readonly amount: Micros;
  readonly count: number;
  readonly lineIds: readonly string[];
}

/**
 * The pattern findings for one client's month. Deterministic: the same input
 * gives the same findings in the same order (check, then counterparty, then
 * account). Throws when `patternSettingsProblems` refuses the settings, naming
 * every problem: a firm's settings are checked before they are stored, so a
 * refusal here is a caller's bug.
 */
export function patternFindings(run: PatternRun): FindingDraft[] {
  const problems = patternSettingsProblems(run.settings);
  if (problems.length > 0) throw new RangeError(`pattern settings refused: ${problems.join("; ")}`);
  if (!isMonth(run.month)) throw new RangeError(`the month checked is written YYYY-MM, not ${JSON.stringify(run.month)}`);

  const s = run.settings;
  const cut = monthIndex(run.month);
  if (historyMonthsBefore(run.summaries, run.month) < s.minHistoryMonths) return [];

  const first = cut - s.lookbackMonths;
  const asOf = addMonths(run.month, -1);
  const learning: PatternLearning = learnFromDecisions(run.decisions, run.month, s.learning);
  const materiality = toMicros(s.materiality, "materiality");
  const bar = (check: PatternCheckKey): number => barPercent(learning, check, s.learning);
  const floorFor = (check: PatternCheckKey): Micros => scaleMicros(materiality, bar(check));

  // History per key and per counterparty, and this month per key.
  const history = new Map<string, KeyedSummary[]>();
  const historyMonthsOf = new Map<string, Set<number>>();
  const historyAccountsOf = new Map<string, Map<string, Set<number>>>();
  const current = new Map<string, CurrentKey>();
  for (const sm of run.summaries) {
    const i = monthIndex(sm.month);
    const id = keyId(sm.counterpartyKey, sm.glAccount);
    if (i === cut) {
      const prior = current.get(id);
      const amount = toMicros(sm.amount, `the ${sm.month} amount of ${sm.counterpartyKey} / ${sm.glAccount}`);
      current.set(id, {
        counterpartyKey: sm.counterpartyKey,
        glAccount: sm.glAccount,
        amount: (prior?.amount ?? 0n) + amount,
        count: (prior?.count ?? 0) + sm.count,
        lineIds: [...(prior?.lineIds ?? []), ...sm.lineIds].sort(),
      });
    } else if (i < cut && i >= first) {
      const list = history.get(id) ?? [];
      list.push(sm);
      history.set(id, list);
      const months = historyMonthsOf.get(sm.counterpartyKey) ?? new Set<number>();
      months.add(i);
      historyMonthsOf.set(sm.counterpartyKey, months);
      const accounts = historyAccountsOf.get(sm.counterpartyKey) ?? new Map<string, Set<number>>();
      const accountMonths = accounts.get(sm.glAccount) ?? new Set<number>();
      accountMonths.add(i);
      accounts.set(sm.glAccount, accountMonths);
      historyAccountsOf.set(sm.counterpartyKey, accounts);
    }
  }

  const profileOf = (counterpartyKey: string, glAccount: string): Profile | null =>
    buildProfile({
      counterpartyKey,
      glAccount,
      history: history.get(keyId(counterpartyKey, glAccount)) ?? [],
      asOf,
      lookbackMonths: s.lookbackMonths,
      minSpreadRatio: s.minSpreadRatio,
      adjustments: adjustmentsFor(learning, counterpartyKey, glAccount),
    });

  const findings: { readonly order: readonly [number, string, string]; readonly draft: FindingDraft }[] = [];
  const raise = (
    check: PatternCheckKey,
    counterpartyKey: string,
    glAccount: string | null,
    lineIds: readonly string[],
    facts: Record<string, FindingFact>,
  ): void => {
    findings.push({
      order: [PATTERN_CHECK_KEYS.indexOf(check), counterpartyKey, glAccount ?? ""],
      draft: {
        lane: "pattern",
        checkKey: check,
        clientPartyId: run.clientPartyId,
        periodStart: firstDayOf(run.month),
        periodEnd: lastDayOf(run.month),
        lineIds: [...lineIds],
        facts: {
          counterpartyKey,
          glAccount,
          month: run.month,
          currency: run.currency,
          thresholdLevel: learning.levels[check],
          ...facts,
        },
        dedupeKey: dedupeKey(check, run.clientPartyId, run.month, counterpartyKey, glAccount),
      },
    });
  };

  const currentCounterparties = new Map<string, CurrentKey[]>();
  for (const c of current.values()) {
    const list = currentCounterparties.get(c.counterpartyKey) ?? [];
    list.push(c);
    currentCounterparties.set(c.counterpartyKey, list);
  }

  const spike = (c: CurrentKey, p: Profile): void => {
    const floor = floorFor("pattern.spike");
    if (c.amount <= 0n || c.amount < floor) return;
    const percent = bar("pattern.spike") / 100;
    const zBar = s.spikeRobustZ * percent;
    const ratioBar = s.spikeRatio * percent;
    const seasonal = p.adjustments.seasonalMonthsOfYear.includes(monthOfYear(run.month));
    if (seasonal) {
      const lastYear = addMonths(run.month, -12);
      const ly = p.months.find((m) => m.month === lastYear);
      if (ly === undefined || ly.amount <= 0n) return;
      const ratio = ratioTo(c.amount, ly.amount);
      if (ratio === null || ratio <= ratioBar) return;
      raise("pattern.spike", c.counterpartyKey, c.glAccount, c.lineIds, {
        amount: fromMicros(c.amount),
        lineCount: c.count,
        comparedWith: "same_month_last_year",
        lastYearAmount: fromMicros(ly.amount),
        median: maybeAmount(p.median),
        mad: maybeAmount(p.mad),
        usualLow: maybeAmount(p.usualLow),
        usualHigh: maybeAmount(p.usualHigh),
        baselineMonths: p.baseline.length,
        ratio: round(ratio, 2),
        robustZ: null,
      });
      return;
    }
    if (p.baseline.length < s.minHistoryMonths || p.median === null || p.mad === null) return;
    const z = robustZ(c.amount, p.median, p.mad, s.minSpreadRatio);
    const ratio = ratioTo(c.amount, p.median);
    const byZ = z > zBar;
    const byRatio = ratio !== null && ratio > ratioBar;
    if (!byZ && !byRatio) return;
    raise("pattern.spike", c.counterpartyKey, c.glAccount, c.lineIds, {
      amount: fromMicros(c.amount),
      lineCount: c.count,
      comparedWith: "baseline",
      lastYearAmount: null,
      median: fromMicros(p.median),
      mad: fromMicros(p.mad),
      usualLow: maybeAmount(p.usualLow),
      usualHigh: maybeAmount(p.usualHigh),
      baselineMonths: p.baseline.length,
      ratio: ratio === null ? null : round(ratio, 2),
      robustZ: zFact(z),
    });
  };

  const frequency = (c: CurrentKey, p: Profile): void => {
    if (cadenceGap(p.cadence) === null || p.usualCount === null) return;
    if (c.count < 2 || c.count < s.frequencyMultiple * p.usualCount) return;
    if (c.amount < floorFor("pattern.frequency_change")) return;
    raise("pattern.frequency_change", c.counterpartyKey, c.glAccount, c.lineIds, {
      amount: fromMicros(c.amount),
      lineCount: c.count,
      usualCount: p.usualCount,
      cadence: p.cadence,
      median: maybeAmount(p.median),
      baselineMonths: p.baseline.length,
    });
  };

  // spike and frequency_change: keys billed this month, against their own past.
  for (const c of current.values()) {
    const p = profileOf(c.counterpartyKey, c.glAccount);
    if (p === null) continue;
    spike(c, p);
    frequency(c, p);
  }

  // new_vendor and gl_drift: counterparties billed this month.
  const clientFirst = run.summaries.reduce((m, sm) => Math.min(m, monthIndex(sm.month)), cut);
  for (const [counterpartyKey, keys] of currentCounterparties) {
    const accounts = historyAccountsOf.get(counterpartyKey);
    if (accounts === undefined) {
      const amount = keys.reduce((sum, k) => sum + k.amount, 0n);
      if (amount < floorFor("pattern.new_vendor")) continue;
      const only = keys.length === 1 ? (keys[0]?.glAccount ?? null) : null;
      raise(
        "pattern.new_vendor",
        counterpartyKey,
        only,
        keys.flatMap((k) => k.lineIds).sort(),
        {
          amount: fromMicros(amount),
          lineCount: keys.reduce((n, k) => n + k.count, 0),
          glAccountCount: keys.length,
          historyMonths: cut - Math.max(first, clientFirst),
        },
      );
      continue;
    }
    const monthsSeen = historyMonthsOf.get(counterpartyKey)?.size ?? 0;
    const acceptedHere = learning.acceptedAccounts.get(counterpartyKey);
    const established = [...accounts.entries()].filter(([, months]) => months.size >= s.minHistoryMonths);
    const usual = established.sort(
      ([a, am], [b, bm]) => bm.size - am.size || Math.max(...bm) - Math.max(...am) || cmpText(a, b),
    )[0];
    if (usual === undefined) continue;
    for (const k of keys) {
      const isUsual = established.some(([account]) => account === k.glAccount) || acceptedHere?.has(k.glAccount) === true;
      if (isUsual || k.amount < floorFor("pattern.gl_drift")) continue;
      raise("pattern.gl_drift", counterpartyKey, k.glAccount, k.lineIds, {
        amount: fromMicros(k.amount),
        lineCount: k.count,
        usualGlAccount: usual[0],
        usualMonths: usual[1].size,
        monthsSeen,
        monthsOnThisAccount: accounts.get(k.glAccount)?.size ?? 0,
      });
    }
  }

  // recurring_missing: regular keys whose counterparty billed nothing at all.
  for (const list of history.values()) {
    const sample = list[0];
    if (sample === undefined || currentCounterparties.has(sample.counterpartyKey)) continue;
    const p = profileOf(sample.counterpartyKey, sample.glAccount);
    if (p === null) continue;
    const gap = cadenceGap(p.cadence);
    if (gap === null || p.median === null) continue;
    if (p.adjustments.seasonalMonthsOfYear.includes(monthOfYear(run.month))) continue;
    const dueGap = gap + s.missingGraceMonths;
    if (cut - monthIndex(p.lastSeen) !== dueGap) continue;
    if (p.median < floorFor("pattern.recurring_missing")) continue;
    const last = p.months[p.months.length - 1];
    raise("pattern.recurring_missing", sample.counterpartyKey, sample.glAccount, [], {
      cadence: p.cadence,
      lastSeen: p.lastSeen,
      lastAmount: last === undefined ? null : fromMicros(last.amount),
      median: fromMicros(p.median),
      monthsSeen: p.monthsSeen,
      dueGap,
    });
  }

  return findings
    .sort((a, b) => a.order[0] - b.order[0] || cmpText(a.order[1], b.order[1]) || cmpText(a.order[2], b.order[2]))
    .map((f) => f.draft);
}
