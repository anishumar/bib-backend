// The shipped India rule pack, held to the one rule that governs it (T3.2).
//
// ── WHAT THIS FILE IS ACTUALLY GUARDING ────────────────────────────────────
//
// `rulepack-in.ts` encodes a due date ONLY where the firm's own sheet states
// one. Not where it is publicly known, not where the author remembers it, not
// where it is "obvious". MSME-1 is genuinely due 31 October and 30 April and
// the pack does not say so, because the sheet says "applicable half-yearly
// deadlines".
//
// That discipline is exactly the kind that erodes: somebody adding a due rule
// to an unresolved obligation makes the calendar look more complete and the
// build stays green, and the wrong date reaches a client six months later. So
// the shape of every row is asserted here — a rule either COMPUTES completely
// or SAYS WHY IT CANNOT, and there is no third state.
import { describe, expect, it } from "vitest";
import {
  INDIA_RULE_PACK,
  INDIA_SEED_GENERATING_COUNT,
  INDIA_SEED_RULES,
} from "../../src/domain/obligation/rulepack-in";
import {
  isObligationRecurrence,
  periodsBetween,
  statutoryDueDate,
  effectiveDueRule,
  type DueRule,
} from "../../src/domain/obligation/model";

const byName = (name: string) => INDIA_SEED_RULES.find((r) => r.name === name);

describe("every shipped rule either computes or says why it cannot", () => {
  it("never half-states a due formula", () => {
    // The same shape `obligation_due_rule_chk` enforces in the database. A
    // half-stated rule produces no date, and a rule that produces no date
    // silently produces no calendar.
    for (const r of INDIA_SEED_RULES) {
      if (r.dueRule === "day_of_month") {
        expect(r.dueMonthOffset, `${r.name}`).not.toBeNull();
        expect(r.dueDayOfMonth, `${r.name}`).not.toBeNull();
        expect(r.dueDaysAfter, `${r.name}`).toBeNull();
      } else if (r.dueRule === "days_after") {
        expect(r.dueDaysAfter, `${r.name}`).not.toBeNull();
        expect(r.dueMonthOffset, `${r.name}`).toBeNull();
        expect(r.dueDayOfMonth, `${r.name}`).toBeNull();
      }
    }
  });

  it("gives every rule with no formula a reason a partner can act on", () => {
    // THE SILENCE CURE, at its source. A blank here is indistinguishable from
    // an unfinished import, and the rules screen would have nothing to show in
    // place of a date.
    for (const r of INDIA_SEED_RULES) {
      if (r.dueRule !== null) continue;
      expect(r.unresolvedReason, `${r.name} has no formula and no reason`).toBeTruthy();
      expect((r.unresolvedReason ?? "").length, `${r.name}'s reason is too terse`)
        .toBeGreaterThan(30);
    }
  });

  it("never carries both a formula and a reason for not having one", () => {
    for (const r of INDIA_SEED_RULES) {
      if (r.dueRule === null) continue;
      expect(r.unresolvedReason, `${r.name} claims both`).toBeNull();
    }
  });

  it("keeps every rule's applicability note, even the ones nothing can test", () => {
    // The sheet's own `Applicability Threshold / Trigger` column. Nothing in
    // this schema can TEST a turnover yet, and dropping the text would lose the
    // firm's own statement of who each rule reaches.
    for (const r of INDIA_SEED_RULES) {
      expect(r.applicabilityNote, `${r.name} lost its applicability note`).toBeTruthy();
    }
  });

  it("uses a known recurrence and a stable pack name", () => {
    for (const r of INDIA_SEED_RULES) {
      expect(isObligationRecurrence(r.recurrence), `${r.name}: ${r.recurrence}`).toBe(true);
    }
    // The pack names its SOURCE and its date. A revision is a new pack
    // alongside this one, never an edit — which is how a filing made under the
    // old rules can still explain its own due date.
    expect(INDIA_RULE_PACK).toBe("in-firm-sheet@2026.08");
  });

  it("has no duplicate rule names, because the name is part of the identity", () => {
    const names = INDIA_SEED_RULES.map((r) => r.name);
    expect(new Set(names).size, "two shipped rules share a name").toBe(names.length);
  });

  it("gives every rule a lead time of ZERO", () => {
    // T–X is the firm's own working practice and appears nowhere in its sheet.
    // A guessed lead time is a commitment the firm never made — the zero is a
    // blank a partner fills in, and it is visible on the rules screen as one.
    for (const r of INDIA_SEED_RULES) {
      expect(
        Object.prototype.hasOwnProperty.call(r, "leadTimeDays"),
        `${r.name} carries a lead time; the pack must not guess one`,
      ).toBe(false);
    }
  });
});

describe("the ratio of what computes to what is still a question", () => {
  it("ships fifty-seven rules for the sheet's fifty-five lines", () => {
    // The two extra are GSTR-1 and GSTR-3B, each of which occupies one sheet
    // line describing TWO regimes ("Monthly / Quarterly"). Folding them into one
    // row would have meant either inventing the QRMP date or losing the monthly
    // one.
    expect(INDIA_SEED_RULES).toHaveLength(57);
  });

  it("computes exactly ten of them, and no more", () => {
    // THE NUMBER THIS FILE EXISTS TO PIN. If this goes up, somebody has given a
    // due date to an obligation the firm never dated — which looks like
    // progress and is the most expensive mistake available in this module.
    // Raising it is a deliberate act with a source, not a green build.
    expect(INDIA_SEED_GENERATING_COUNT).toBe(10);
  });

  it("names the ten, so a change has to say which one moved", () => {
    const generating = INDIA_SEED_RULES.filter(
      (r) => r.dueRule !== null && r.recurrence !== "event",
    ).map((r) => r.name);
    expect(generating.sort()).toEqual(
      [
        "Advance Tax",
        "DIR-3 KYC / KYC-Web",
        "DPT-3",
        "EPFO ECR / PF",
        "ESI",
        "FLA Return",
        "GSTR-1",
        "GSTR-3B",
        "Quarterly TDS statements",
        "TDS deposit",
      ].sort(),
    );
  });

  it("records FC-GPR's formula even though it can never fire yet", () => {
    // The odd one out: a rule that HAS a formula and still generates nothing,
    // because it is event-driven and nothing here sees a share issue. Keeping
    // the formula means it works the day one is captured, rather than needing
    // to be researched again.
    const fcgpr = byName("FC-GPR");
    expect(fcgpr?.recurrence).toBe("event");
    expect(fcgpr?.dueRule).toBe("days_after");
    expect(fcgpr?.dueDaysAfter).toBe(30);
  });

  it("leaves MSME-1 undated, which is the discipline working", () => {
    // The dates are publicly known. The sheet does not state them, so the pack
    // does not either — this assertion is here so that "helpfully" filling them
    // in fails the build and has to be a decision somebody takes.
    const msme = byName("MSME-1");
    expect(msme?.recurrence).toBe("half_yearly");
    expect(msme?.dueRule).toBeNull();
    expect(msme?.unresolvedReason).toContain("half-yearly deadlines");
  });
});

describe("the two rules that carry exceptions produce the firm's own dates", () => {
  function due(name: string, from: string, to: string): string[] {
    const r = byName(name);
    if (!r || r.dueRule === null) throw new Error(`${name} does not compute`);
    const base: DueRule = {
      kind: r.dueRule,
      dueMonthOffset: r.dueMonthOffset,
      dueDayOfMonth: r.dueDayOfMonth,
      dueDaysAfter: r.dueDaysAfter,
    };
    const exceptions = (r.exceptions ?? []).map((e) => ({
      periodEndMonth: e.periodEndMonth,
      kind: e.dueRule,
      dueMonthOffset: e.dueMonthOffset,
      dueDayOfMonth: e.dueDayOfMonth,
      dueDaysAfter: e.dueDaysAfter,
      note: e.note,
    }));
    return periodsBetween(r.recurrence, 4, from, to).map((p) =>
      statutoryDueDate(effectiveDueRule(base, exceptions, p), p),
    );
  }

  it("deposits TDS on the 7th, and March's on 30 April", () => {
    // Right eleven months a year and quietly wrong every April is the worst
    // available failure here: nobody re-reads a date that looks right, and the
    // cost lands on the client as a penalty.
    expect(due("TDS deposit", "2026-04-01", "2027-03-31")).toEqual([
      "2026-05-07", "2026-06-07", "2026-07-07", "2026-08-07",
      "2026-09-07", "2026-10-07", "2026-11-07", "2026-12-07",
      "2027-01-07", "2027-02-07", "2027-03-07", "2027-04-30",
    ]);
  });

  it("files the quarterly TDS statements 31 Jul / 31 Oct / 31 Jan / 31 May", () => {
    expect(due("Quarterly TDS statements", "2026-04-01", "2027-03-31")).toEqual([
      "2026-07-31", "2026-10-31", "2027-01-31", "2027-05-31",
    ]);
  });

  it("pays Advance Tax on 15 Jun / 15 Sep / 15 Dec / 15 Mar", () => {
    expect(due("Advance Tax", "2026-04-01", "2027-03-31")).toEqual([
      "2026-06-15", "2026-09-15", "2026-12-15", "2027-03-15",
    ]);
  });

  it("files GSTR-3B on the 20th and GSTR-1 on the 11th, twelve times a year", () => {
    const threeB = due("GSTR-3B", "2026-04-01", "2027-03-31");
    const one = due("GSTR-1", "2026-04-01", "2027-03-31");
    expect(threeB).toHaveLength(12);
    expect(threeB[4]).toBe("2026-09-20"); // August's return
    expect(one[4]).toBe("2026-09-11");
  });

  it("gives every exception a note, because an unexplained carve-out is unreviewable", () => {
    for (const r of INDIA_SEED_RULES) {
      for (const e of r.exceptions ?? []) {
        expect(e.note, `${r.name} month ${String(e.periodEndMonth)}`).toBeTruthy();
      }
    }
  });
});
