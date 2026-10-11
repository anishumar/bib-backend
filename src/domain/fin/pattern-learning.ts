// What a person's decisions on pattern findings teach the next check
// (docs/FIN_BUILD_PLAN.md F5.4). Pure.
//
// A machine said "check this"; a person decided (ground rule 2), and their
// decision is `fin.finding_decision`: ask the client, correct, or dismiss with a
// reason code. Nothing here changes a finding or a decision. It only reads them
// back, in the order they were taken, and derives two things the next run uses:
//
//   1. what the key's BASELINE is (`ProfileAdjustments`, applied by
//      `buildProfile` in pattern.ts), from the dismissal's reason:
//        - `price_change`: the vendor's price moved, so the baseline RESTARTS at
//          that month; the months before it describe a price that no longer
//          applies. Until three months at the new price exist, the key has too
//          little history for a spike (the same rule as a new key).
//        - `one_off`: that month was not normal and is LEFT OUT of the
//          baseline, amount and line count alike. The grain is the month,
//          because a summary is; a spike finding is about the month's total
//          for the key, so for the usual one-bill month that IS the invoice.
//        - `seasonal`: that calendar month (say, December) is LEFT OUT of the
//          ordinary baseline from then on, and is judged against the SAME MONTH
//          LAST YEAR instead (pattern-checks.ts); a recurring vendor that is
//          seasonally absent is not "missing" in that month either.
//        - `expected`: on a GL drift, the new account becomes one of the
//          counterparty's usual accounts at once (otherwise it takes three
//          months there). On any other check, nothing changes but the count
//          below: "expected" says the flag was not news, not that the past was
//          wrong.
//        - `other`: nothing changes but the count below.
//      A decision with no `glAccount` (a new vendor across several accounts)
//      applies to every account of that counterparty.
//
//   2. how high the client's BAR is per check (`levels`): a check MOSTLY
//      dismissed for a client gets quieter for that client. Decisions on one
//      check are taken in consecutive blocks of `window` (5), oldest first: a
//      block with at least `raiseAtShare` (4 of 5) dismissed — any reason —
//      raises the level by one, and a block with at most `lowerAtShare` (1 of 5)
//      dismissed lowers it by one (people are acting on the flags again). The
//      level is capped at `maxLevel` (3) and never below 0; each level adds
//      `stepPercent` (50%) to the check's materiality, and for a spike to its z
//      and ratio thresholds too. An unfinished last block is not judged yet,
//      so one dismissal never moves anything.
//
// Only decisions on months BEFORE the month being checked count: a decision is
// always taken after its finding, and a re-run of a month must raise the same
// findings it raised the first time (the dedupe key does the rest).
import type { Month, PatternCheckKey, ProfileAdjustments } from "./pattern";
import { NO_ADJUSTMENTS, PATTERN_CHECK_KEYS, monthIndex, monthOfYear } from "./pattern";
import type { PatternLearningSettings } from "./pattern-settings";

export type DismissReason = "price_change" | "one_off" | "seasonal" | "expected" | "other";

export const DISMISS_REASONS: readonly DismissReason[] = ["price_change", "one_off", "seasonal", "expected", "other"];

/** F4.2's three decisions. */
export type DecisionKind = "ask_client" | "correct" | "dismiss";

/** One decision on one pattern finding, as the learning reads it: the
 *  finding's key facts plus what the person chose. The store maps a
 *  `fin.finding_decision` row (and its finding) to this. */
export interface PatternDecision {
  readonly checkKey: PatternCheckKey;
  readonly counterpartyKey: string;
  /** Null when the finding spanned several accounts (a new vendor). */
  readonly glAccount: string | null;
  /** The finding's month. */
  readonly month: Month;
  readonly decision: DecisionKind;
  /** Present exactly when `decision` is `dismiss` (a CHECK on the table). */
  readonly reason: DismissReason | null;
}

export interface PatternLearning {
  /** The baseline changes per `keyOf(counterparty, account)`; a null account
   *  is stored under `keyOf(counterparty, null)` and applies to all. */
  readonly adjustments: ReadonlyMap<string, ProfileAdjustments>;
  /** Accounts a person accepted for a counterparty (`expected` on a drift). */
  readonly acceptedAccounts: ReadonlyMap<string, ReadonlySet<string>>;
  /** 0…maxLevel per check. */
  readonly levels: Readonly<Record<PatternCheckKey, number>>;
}

const ALL_ACCOUNTS = "\u0000*";

/** The map key for a counterparty and an account (or every account). */
export function keyOf(counterpartyKey: string, glAccount: string | null): string {
  return `${counterpartyKey}\u0000${glAccount ?? ALL_ACCOUNTS}`;
}

interface MutableAdjustments {
  baselineFrom: Month | null;
  oneOffMonths: Set<Month>;
  seasonalMonthsOfYear: Set<number>;
}

const zeroLevels = (): Record<PatternCheckKey, number> => ({
  "pattern.spike": 0,
  "pattern.new_vendor": 0,
  "pattern.recurring_missing": 0,
  "pattern.frequency_change": 0,
  "pattern.gl_drift": 0,
});

/**
 * Read the client's decisions, in the order they were taken (oldest first;
 * ties keep the caller's order), and derive what the check of `before` uses.
 * Decisions on `before` or later are ignored.
 */
export function learnFromDecisions(
  decisions: readonly PatternDecision[],
  before: Month,
  settings: PatternLearningSettings,
): PatternLearning {
  const cut = monthIndex(before);
  const relevant = decisions
    .map((d, i) => ({ d, i, m: monthIndex(d.month) }))
    .filter((x) => x.m < cut)
    .sort((a, b) => a.m - b.m || a.i - b.i)
    .map((x) => x.d);

  const adjustments = new Map<string, MutableAdjustments>();
  const accepted = new Map<string, Set<string>>();
  const slot = (d: PatternDecision): MutableAdjustments => {
    const k = keyOf(d.counterpartyKey, d.glAccount);
    let a = adjustments.get(k);
    if (a === undefined) {
      a = { baselineFrom: null, oneOffMonths: new Set(), seasonalMonthsOfYear: new Set() };
      adjustments.set(k, a);
    }
    return a;
  };

  for (const d of relevant) {
    if (d.decision !== "dismiss" || d.reason === null) continue;
    switch (d.reason) {
      case "price_change": {
        const a = slot(d);
        if (a.baselineFrom === null || monthIndex(d.month) > monthIndex(a.baselineFrom)) a.baselineFrom = d.month;
        break;
      }
      case "one_off":
        slot(d).oneOffMonths.add(d.month);
        break;
      case "seasonal":
        slot(d).seasonalMonthsOfYear.add(monthOfYear(d.month));
        break;
      case "expected":
        if (d.checkKey === "pattern.gl_drift" && d.glAccount !== null) {
          const set = accepted.get(d.counterpartyKey) ?? new Set<string>();
          set.add(d.glAccount);
          accepted.set(d.counterpartyKey, set);
        }
        break;
      case "other":
        break;
    }
  }

  const levels = zeroLevels();
  for (const check of PATTERN_CHECK_KEYS) {
    const onCheck = relevant.filter((d) => d.checkKey === check);
    let level = 0;
    for (let start = 0; start + settings.window <= onCheck.length; start += settings.window) {
      const block = onCheck.slice(start, start + settings.window);
      const dismissed = block.filter((d) => d.decision === "dismiss").length / block.length;
      if (dismissed >= settings.raiseAtShare) level = Math.min(settings.maxLevel, level + 1);
      else if (dismissed <= settings.lowerAtShare) level = Math.max(0, level - 1);
    }
    levels[check] = level;
  }

  const frozen = new Map<string, ProfileAdjustments>();
  for (const [k, a] of adjustments) {
    frozen.set(k, {
      baselineFrom: a.baselineFrom,
      oneOffMonths: [...a.oneOffMonths].sort(),
      seasonalMonthsOfYear: [...a.seasonalMonthsOfYear].sort((x, y) => x - y),
    });
  }
  return { adjustments: frozen, acceptedAccounts: accepted, levels };
}

/** No decisions at all: every baseline as the months made it, every bar at
 *  the firm's own setting. */
export const NOTHING_LEARNT: PatternLearning = { adjustments: new Map(), acceptedAccounts: new Map(), levels: zeroLevels() };

/** One key's baseline changes: its own, merged with any its counterparty
 *  carries for every account. */
export function adjustmentsFor(learning: PatternLearning, counterpartyKey: string, glAccount: string): ProfileAdjustments {
  const own = learning.adjustments.get(keyOf(counterpartyKey, glAccount));
  const all = learning.adjustments.get(keyOf(counterpartyKey, null));
  if (own === undefined && all === undefined) return NO_ADJUSTMENTS;
  const parts = [own, all].filter((p): p is ProfileAdjustments => p !== undefined);
  const froms = parts.map((p) => p.baselineFrom).filter((m): m is Month => m !== null);
  const baselineFrom = froms.length === 0 ? null : froms.reduce((a, b) => (monthIndex(b) > monthIndex(a) ? b : a));
  return {
    baselineFrom,
    oneOffMonths: [...new Set(parts.flatMap((p) => p.oneOffMonths))].sort(),
    seasonalMonthsOfYear: [...new Set(parts.flatMap((p) => p.seasonalMonthsOfYear))].sort((x, y) => x - y),
  };
}

/** The percentage a check's bars are at for this client: 100 at level 0. */
export function barPercent(learning: PatternLearning, check: PatternCheckKey, settings: PatternLearningSettings): number {
  return 100 + learning.levels[check] * settings.stepPercent;
}
