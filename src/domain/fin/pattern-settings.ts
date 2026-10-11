// How loud the pattern checks are (docs/FIN_BUILD_PLAN.md F5.2, F5.4). Pure.
//
// Every threshold of lane B is a value here, passed in, never a constant in a
// check: they are PER-FIRM values (the plan's own words), and a firm that finds
// the panel too noisy moves a number, not a deploy. Materiality in particular is
// an OPEN DECISION with 10x ("the materiality amount", Open decisions, blocking
// F5.2), so nothing here is the firm's answer.
//
// `SUGGESTED_PATTERN_SETTINGS` is a STARTING POINT a firm adopts deliberately,
// in `SUGGESTED_TIERS`' spirit (domain/agent/model.ts): written down, tuned
// against the training pack by the backtest (`scripts/fin-backtest.ts`), and
// NOT seeded and NOT a decision. Where its numbers came from is said beside
// each one.
import { toMicros } from "./pattern";

/** What a person's decisions do to a client's thresholds (F5.4). */
export interface PatternLearningSettings {
  /** Decisions are judged in consecutive blocks of this many, oldest first;
   *  an unfinished last block is not judged yet. */
  readonly window: number;
  /** A block with at least this share dismissed raises the client's level for
   *  that check by one: "mostly dismissed". */
  readonly raiseAtShare: number;
  /** A block with at most this share dismissed (people acted on the flags)
   *  lowers it by one, never below zero. */
  readonly lowerAtShare: number;
  /** Each level adds this percentage to the check's bars (materiality, and the
   *  spike's z and ratio). Linear: level 2 of 50% is twice the bar. */
  readonly stepPercent: number;
  /** The highest level: the bar never rises above (100 + max × step)%. */
  readonly maxLevel: number;
}

export interface PatternSettings {
  /** Nothing smaller than this is a pattern finding: a decimal string in the
   *  CLIENT'S base currency (the caller passes the right one). For a spike it
   *  is this month's amount, for a missing vendor its usual (median) amount,
   *  for the others this month's amount on the lines concerned. */
  readonly materiality: string;
  /** F5.5: no pattern finding for a client with fewer months of committed
   *  history than this, and no spike for a key with fewer baseline months. */
  readonly minHistoryMonths: number;
  /** How far back a profile looks, in months before the month checked. Twelve
   *  keeps "same month last year" (seasonal) inside the window. */
  readonly lookbackMonths: number;
  /** Spike: robust z above this … */
  readonly spikeRobustZ: number;
  /** … OR more than this many times the median. */
  readonly spikeRatio: number;
  /** σ's floor as a share of the median (see pattern.ts): a flat retainer's
   *  MAD is zero. */
  readonly minSpreadRatio: number;
  /** Frequency change: at least this many times the usual lines a month (and
   *  never fewer than two). */
  readonly frequencyMultiple: number;
  /** Recurring missing: months of grace after the bill was due (0 = flag the
   *  first month a monthly biller misses). */
  readonly missingGraceMonths: number;
  readonly learning: PatternLearningSettings;
}

/**
 * A starting point, NOT a decision (see the file header). Measured with
 * `npx tsx scripts/fin-backtest.ts` on the pack's answer-key lines, April to
 * December 2025, five companies (45 client-months):
 *
 *   - materiality S$1,000 (the pack is SGD): the most sensitive round figure
 *     that keeps the clean pack within the proposed 2 flags per client-month
 *     (15 flags, at most 2 in one month, none over). S$2k gives 10 flags, S$5k
 *     5, S$10k 4; with none at all, 44 flags and 5 client-months over. The
 *     amount is OPEN with 10x, and the backtest prints that table for them;
 *   - 3 months of history: the plan's own number (F5.2 and F5.5);
 *   - 12 months back: one year, so a seasonal month can see last year's;
 *   - z > 6 or > 3× the median: the plan's own spike rule (F5.2);
 *   - σ floor 0.1 of the median: TUNED. With no floor (the plan's rule read
 *     literally) the clean pack raised 5 spikes at S$1k, every one a steady
 *     biller moving 1.2–1.5× against a MAD made tiny by 3–7 calm months
 *     (PowerGrid S$1,120 against S$807–821). 0.05 still raised 2; 0.1 raises
 *     none and catches exactly what no floor catches (2× spikes 22 of 32);
 *     0.2 also raises none but catches no 2× spike at all;
 *   - two bills where one is usual: the plan's example;
 *   - no grace on a missing monthly bill;
 *   - learning: blocks of 5; 4 of 5 dismissed raises one step of 50%, 1 of 5
 *     or fewer lowers one; at most 3 steps (2.5× the bar). Not measurable on
 *     the pack (a replay has no decisions); a judgement, stated.
 */
export const SUGGESTED_PATTERN_SETTINGS: PatternSettings = {
  materiality: "1000.00",
  minHistoryMonths: 3,
  lookbackMonths: 12,
  spikeRobustZ: 6,
  spikeRatio: 3,
  minSpreadRatio: 0.1,
  frequencyMultiple: 2,
  missingGraceMonths: 0,
  learning: { window: 5, raiseAtShare: 0.8, lowerAtShare: 0.2, stepPercent: 50, maxLevel: 3 },
};

const positiveInt = (v: number): boolean => Number.isInteger(v) && v > 0;
const share = (v: number): boolean => Number.isFinite(v) && v >= 0 && v <= 1;

/**
 * What is wrong with a set of settings, one sentence per field, naming the
 * field, the value and what is allowed. Empty when they are usable. A firm's
 * own settings go through this before they are stored.
 */
export function patternSettingsProblems(s: PatternSettings): string[] {
  const problems: string[] = [];
  const bad = (field: string, value: unknown, allowed: string): void => {
    problems.push(`${field} is ${JSON.stringify(value)}; it must be ${allowed}`);
  };
  let materialityOk = true;
  try {
    if (toMicros(s.materiality, "materiality") < 0n) materialityOk = false;
  } catch {
    materialityOk = false;
  }
  if (!materialityOk) bad("materiality", s.materiality, 'a non-negative decimal string, at most 4 places ("2000.00")');
  if (!positiveInt(s.minHistoryMonths) || s.minHistoryMonths > 24) bad("minHistoryMonths", s.minHistoryMonths, "a whole number from 1 to 24");
  if (!positiveInt(s.lookbackMonths) || s.lookbackMonths > 36) bad("lookbackMonths", s.lookbackMonths, "a whole number from 1 to 36");
  if (positiveInt(s.minHistoryMonths) && positiveInt(s.lookbackMonths) && s.lookbackMonths < s.minHistoryMonths) {
    bad("lookbackMonths", s.lookbackMonths, `at least minHistoryMonths (${String(s.minHistoryMonths)}), or no key could ever have enough history`);
  }
  if (!Number.isFinite(s.spikeRobustZ) || s.spikeRobustZ <= 0) bad("spikeRobustZ", s.spikeRobustZ, "a number above 0");
  if (!Number.isFinite(s.spikeRatio) || s.spikeRatio <= 1) bad("spikeRatio", s.spikeRatio, "a number above 1 (times the median)");
  if (!Number.isFinite(s.minSpreadRatio) || s.minSpreadRatio < 0 || s.minSpreadRatio > 1) bad("minSpreadRatio", s.minSpreadRatio, "a share from 0 to 1");
  if (!Number.isFinite(s.frequencyMultiple) || s.frequencyMultiple <= 1) bad("frequencyMultiple", s.frequencyMultiple, "a number above 1");
  if (!Number.isInteger(s.missingGraceMonths) || s.missingGraceMonths < 0 || s.missingGraceMonths > 6) {
    bad("missingGraceMonths", s.missingGraceMonths, "a whole number from 0 to 6");
  }
  const l = s.learning;
  if (!positiveInt(l.window) || l.window > 50) bad("learning.window", l.window, "a whole number from 1 to 50");
  if (!share(l.raiseAtShare) || l.raiseAtShare <= 0.5) bad("learning.raiseAtShare", l.raiseAtShare, "a share above 0.5 and at most 1 (\"mostly\")");
  if (!share(l.lowerAtShare) || l.lowerAtShare >= 0.5) bad("learning.lowerAtShare", l.lowerAtShare, "a share from 0 to below 0.5");
  if (!positiveInt(l.stepPercent) || l.stepPercent > 200) bad("learning.stepPercent", l.stepPercent, "a whole percentage from 1 to 200");
  if (!Number.isInteger(l.maxLevel) || l.maxLevel < 0 || l.maxLevel > 10) bad("learning.maxLevel", l.maxLevel, "a whole number from 0 to 10");
  return problems;
}
