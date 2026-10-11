// Learning from decisions (docs/FIN_BUILD_PLAN.md F5.4): a test for each
// dismissal reason, and for "a check mostly dismissed for a client raises that
// client's threshold". Nothing here changes a finding or a decision; it only
// changes what the NEXT check compares against.
import { describe, expect, it } from "vitest";
import type { FindingDraft } from "../../src/domain/fin/finding";
import type { KeyedSummary, PatternCheckKey } from "../../src/domain/fin/pattern";
import { patternFindings } from "../../src/domain/fin/pattern-checks";
import type { DismissReason, PatternDecision } from "../../src/domain/fin/pattern-learning";
import { DISMISS_REASONS, adjustmentsFor, barPercent, keyOf, learnFromDecisions } from "../../src/domain/fin/pattern-learning";
import { SUGGESTED_PATTERN_SETTINGS } from "../../src/domain/fin/pattern-settings";

const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const S = SUGGESTED_PATTERN_SETTINGS;

function key(counterpartyKey: string, glAccount: string, byMonth: Record<string, string>): KeyedSummary[] {
  return Object.entries(byMonth).map(([month, amount]) => ({
    counterpartyKey,
    glAccount,
    month,
    amount,
    count: 1,
    lineIds: [`${counterpartyKey}-${month}`],
  }));
}

/** Every month from `from` to `to` at one amount. */
function flat(counterpartyKey: string, glAccount: string, from: string, to: string, amount: string): KeyedSummary[] {
  const out: KeyedSummary[] = [];
  let [y, m] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(...key(counterpartyKey, glAccount, { [`${String(y)}-${String(m).padStart(2, "0")}`]: amount }));
    m += 1;
    if (m === 13) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

const rent = flat("landlord", "6110", "2024-01", "2025-12", "9800");

function check(summaries: readonly KeyedSummary[], month: string, decisions: readonly PatternDecision[] = []): FindingDraft[] {
  return patternFindings({ clientPartyId: CLIENT, currency: "SGD", month, summaries, decisions, settings: S });
}

const spikesOf = (f: readonly FindingDraft[], cp: string): FindingDraft[] =>
  f.filter((x) => x.checkKey === "pattern.spike" && x.facts.counterpartyKey === cp);

function dismiss(checkKey: PatternCheckKey, counterpartyKey: string, glAccount: string | null, month: string, reason: DismissReason): PatternDecision {
  return { checkKey, counterpartyKey, glAccount, month, decision: "dismiss", reason };
}

describe("price_change resets the baseline from that month", () => {
  // S$1,000 a month, then from July S$4,000 a month: the July spike is
  // dismissed as a price change.
  const acme = [
    ...flat("acme", "6200", "2025-01", "2025-06", "1000"),
    ...flat("acme", "6200", "2025-07", "2025-10", "4000"),
  ];
  const decision = dismiss("pattern.spike", "acme", "6200", "2025-07", "price_change");

  it("without the decision, every month at the new price is a spike against the old one", () => {
    expect(spikesOf(check([...rent, ...acme], "2025-07"), "acme")).toHaveLength(1);
    expect(spikesOf(check([...rent, ...acme], "2025-08"), "acme")).toHaveLength(1);
  });

  it("with it, the months before July leave the baseline, and the new price is normal once it has history", () => {
    expect(spikesOf(check([...rent, ...acme], "2025-08", [decision]), "acme")).toEqual([]);
    expect(spikesOf(check([...rent, ...acme], "2025-10", [decision]), "acme")).toEqual([]);
    const profile = adjustmentsFor(learnFromDecisions([decision], "2025-10", S.learning), "acme", "6200");
    expect(profile.baselineFrom).toBe("2025-07");
  });

  it("and a spike against the NEW price is still caught", () => {
    const big = [...acme.filter((x) => x.month !== "2025-10"), ...key("acme", "6200", { "2025-10": "40000" })];
    const [f] = spikesOf(check([...rent, ...big], "2025-10", [decision]), "acme");
    expect(f?.facts).toMatchObject({ median: "4000.00", baselineMonths: 3, ratio: 10 });
  });

  it("the latest price change wins", () => {
    const later = dismiss("pattern.spike", "acme", "6200", "2025-09", "price_change");
    const learnt = learnFromDecisions([later, decision], "2025-11", S.learning);
    expect(adjustmentsFor(learnt, "acme", "6200").baselineFrom).toBe("2025-09");
  });
});

describe("one_off leaves that month out of the baseline", () => {
  // A steady cleaner, then May's deep clean (dismissed as a one-off), then a
  // 65% jump in June. The one-off widened the spread enough to hide it.
  const clean = key("cleanco", "6300", { "2025-01": "1000", "2025-02": "1100", "2025-03": "900", "2025-04": "1000", "2025-05": "3000", "2025-06": "1650" });
  const decision = dismiss("pattern.spike", "cleanco", "6300", "2025-05", "one_off");

  it("May itself was flagged", () => {
    expect(spikesOf(check([...rent, ...clean], "2025-05"), "cleanco")).toHaveLength(1);
  });

  it("without the decision, June's jump hides behind May's spread; with it, June is flagged", () => {
    expect(spikesOf(check([...rent, ...clean], "2025-06"), "cleanco")).toEqual([]);
    const [f] = spikesOf(check([...rent, ...clean], "2025-06", [decision]), "cleanco");
    expect(f?.facts).toMatchObject({ median: "1000.00", mad: "50.00", baselineMonths: 4, usualHigh: "1100.00", robustZ: 6.5 });
  });

  it("a decision with no account applies to every account of that counterparty", () => {
    const learnt = learnFromDecisions([dismiss("pattern.new_vendor", "cleanco", null, "2025-05", "one_off")], "2025-06", S.learning);
    expect(adjustmentsFor(learnt, "cleanco", "6300").oneOffMonths).toEqual(["2025-05"]);
    expect(adjustmentsFor(learnt, "cleanco", "6310").oneOffMonths).toEqual(["2025-05"]);
    expect(learnt.adjustments.has(keyOf("cleanco", null))).toBe(true);
  });
});

describe("seasonal compares against the same month last year", () => {
  // A caterer: S$2,000 a month, S$9,000 every December. December 2024 was
  // flagged and dismissed as seasonal.
  const caterer = [
    ...flat("caterer", "5000", "2024-01", "2024-11", "2000"),
    ...key("caterer", "5000", { "2024-12": "9000" }),
    ...flat("caterer", "5000", "2025-01", "2025-11", "2000"),
  ];
  const decision = dismiss("pattern.spike", "caterer", "5000", "2024-12", "seasonal");

  it("without the decision, December 2025 is a spike against the ordinary months", () => {
    expect(spikesOf(check([...rent, ...caterer, ...key("caterer", "5000", { "2025-12": "9500" })], "2025-12"), "caterer")).toHaveLength(1);
  });

  it("with it, December 2025 at last December's level is not flagged", () => {
    expect(spikesOf(check([...rent, ...caterer, ...key("caterer", "5000", { "2025-12": "9500" })], "2025-12", [decision]), "caterer")).toEqual([]);
  });

  it("and a December far above LAST December is flagged, against last December", () => {
    const [f] = spikesOf(check([...rent, ...caterer, ...key("caterer", "5000", { "2025-12": "30000" })], "2025-12", [decision]), "caterer");
    expect(f?.facts).toMatchObject({ comparedWith: "same_month_last_year", lastYearAmount: "9000.00", ratio: 3.33, robustZ: null });
  });

  it("the ordinary months no longer count December in their baseline", () => {
    const learnt = learnFromDecisions([decision], "2025-12", S.learning);
    expect(adjustmentsFor(learnt, "caterer", "5000").seasonalMonthsOfYear).toEqual([12]);
  });

  it("a recurring vendor seasonally absent is not 'missing' in that month", () => {
    // Billed every month but August; August 2024's missing bill was dismissed as seasonal.
    const school = [...flat("canteen", "6270", "2024-01", "2024-07", "3000"), ...flat("canteen", "6270", "2024-09", "2025-07", "3000")];
    const missing = (d: readonly PatternDecision[]): FindingDraft[] =>
      check([...rent, ...school], "2025-08", d).filter((f) => f.checkKey === "pattern.recurring_missing");
    expect(missing([])).toHaveLength(1);
    expect(missing([dismiss("pattern.recurring_missing", "canteen", "6270", "2024-08", "seasonal")])).toEqual([]);
  });
});

describe("expected: on a GL drift the account becomes usual at once; elsewhere it only counts", () => {
  const landlord6210 = key("landlord", "6210", { "2025-07": "4200", "2025-08": "4200" });

  it("a second month on the drifted account is flagged again, unless a person said it was expected", () => {
    const drifts = (d: readonly PatternDecision[]): FindingDraft[] =>
      check([...rent, ...landlord6210], "2025-08", d).filter((f) => f.checkKey === "pattern.gl_drift");
    expect(drifts([])).toHaveLength(1);
    expect(drifts([dismiss("pattern.gl_drift", "landlord", "6210", "2025-07", "expected")])).toEqual([]);
  });

  it("on another check it changes no baseline", () => {
    const learnt = learnFromDecisions([dismiss("pattern.spike", "acme", "6200", "2025-07", "expected")], "2025-08", S.learning);
    expect(adjustmentsFor(learnt, "acme", "6200")).toEqual({ baselineFrom: null, oneOffMonths: [], seasonalMonthsOfYear: [] });
    expect(learnt.acceptedAccounts.size).toBe(0);
  });
});

describe("other changes no baseline, and counts toward 'mostly dismissed'", () => {
  it("leaves every baseline as the months made it", () => {
    const learnt = learnFromDecisions([dismiss("pattern.spike", "acme", "6200", "2025-07", "other")], "2025-08", S.learning);
    expect(learnt.adjustments.size).toBe(0);
    expect(learnt.levels["pattern.spike"]).toBe(0);
  });

  it("five new-vendor flags dismissed (any reason) raise that check's bar by 50% for this client", () => {
    const reasons: DismissReason[] = ["other", "other", "expected", "one_off", "other"];
    const decisions = reasons.map((r, i) => dismiss("pattern.new_vendor", `v${String(i)}`, "6200", `2025-0${String(i + 2)}`, r));
    const learnt = learnFromDecisions(decisions, "2025-08", S.learning);
    expect(learnt.levels["pattern.new_vendor"]).toBe(1);
    expect(barPercent(learnt, "pattern.new_vendor", S.learning)).toBe(150);
    expect(learnt.levels["pattern.spike"]).toBe(0);
    const at = (amount: string): FindingDraft[] => check([...rent, ...key("newco", "6400", { "2025-08": amount })], "2025-08", decisions);
    expect(at("1200")).toEqual([]);
    expect(at("1600")[0]?.facts).toMatchObject({ thresholdLevel: 1, amount: "1600.00" });
    expect(check([...rent, ...key("newco", "6400", { "2025-08": "1200" })], "2025-08")).toHaveLength(1);
  });
});

describe("how the bar moves", () => {
  const block = (decision: PatternDecision["decision"], n: number, offset = 0): PatternDecision[] =>
    Array.from({ length: n }, (_, i) => ({
      checkKey: "pattern.spike" as const,
      counterpartyKey: `v${String(offset + i)}`,
      glAccount: "6200",
      month: "2025-03",
      decision,
      reason: decision === "dismiss" ? ("other" as const) : null,
    }));

  it("'mostly' is 4 of 5: 3 of 5 dismissed moves nothing", () => {
    const three = [...block("dismiss", 3), ...block("ask_client", 2, 3)];
    expect(learnFromDecisions(three, "2025-04", S.learning).levels["pattern.spike"]).toBe(0);
    const four = [...block("dismiss", 4), ...block("correct", 1, 4)];
    expect(learnFromDecisions(four, "2025-04", S.learning).levels["pattern.spike"]).toBe(1);
  });

  it("an unfinished block is not judged: four dismissals of four move nothing yet", () => {
    expect(learnFromDecisions(block("dismiss", 4), "2025-04", S.learning).levels["pattern.spike"]).toBe(0);
  });

  it("is capped at 3 steps (2.5× the bar)", () => {
    const learnt = learnFromDecisions(block("dismiss", 30), "2025-04", S.learning);
    expect(learnt.levels["pattern.spike"]).toBe(3);
    expect(barPercent(learnt, "pattern.spike", S.learning)).toBe(250);
  });

  it("comes back down when people act on the flags again (1 of 5 or fewer dismissed)", () => {
    const learnt = learnFromDecisions([...block("dismiss", 10), ...block("ask_client", 5, 10)], "2025-04", S.learning);
    expect(learnt.levels["pattern.spike"]).toBe(1);
    expect(learnFromDecisions([...block("dismiss", 5), ...block("correct", 10, 5)], "2025-04", S.learning).levels["pattern.spike"]).toBe(0);
  });

  it("a raised spike bar needs a bigger spike: 4× the median is flagged at level 0, not at level 1 (4.5×)", () => {
    const wide = key("wide", "5000", { "2025-01": "1000", "2025-02": "9000", "2025-03": "5000", "2025-04": "2000", "2025-05": "8000", "2025-06": "20000" });
    expect(spikesOf(check(wide, "2025-06"), "wide")).toHaveLength(1);
    expect(spikesOf(check(wide, "2025-06", block("dismiss", 5)), "wide")).toEqual([]);
  });
});

describe("only decisions on earlier months count", () => {
  it("a decision on the month being checked (or later) changes nothing, so a re-run raises the same findings", () => {
    const acme = [...flat("acme", "6200", "2025-01", "2025-06", "1000"), ...key("acme", "6200", { "2025-07": "4000" })];
    const sameMonth = dismiss("pattern.spike", "acme", "6200", "2025-07", "price_change");
    expect(check([...rent, ...acme], "2025-07", [sameMonth])).toEqual(check([...rent, ...acme], "2025-07"));
  });

  it("every reason code is handled", () => {
    expect(DISMISS_REASONS).toEqual(["price_change", "one_off", "seasonal", "expected", "other"]);
    for (const reason of DISMISS_REASONS) {
      expect(() => learnFromDecisions([dismiss("pattern.spike", "x", "1", "2025-01", reason)], "2025-02", S.learning)).not.toThrow();
    }
  });
});
