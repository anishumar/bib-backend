// The arithmetic behind every statutory deadline this product will ever quote
// (T3.2).
//
// This file is deliberately the longest test in the module, because it is the
// one that can be exhaustive cheaply: `domain/obligation/model.ts` is pure, has
// no clock and no database, and every date it produces is one a client will be
// held to. A wrong rule here costs the client a penalty rather than costing us
// an afternoon — and nobody re-reads a date that looks right.
//
// The four lines of T3.2's acceptance are all proved here:
//   · an Indian quarter is Apr–Jun
//   · March TDS resolves to 30 April
//   · a monthly obligation spawns twelve instances a year out
//   · (the fourth, re-running the generator, is `service.test.ts` — it needs a
//     store, not arithmetic)
import { describe, expect, it } from "vitest";
import {
  addDays,
  chainOnDay,
  coverageOf,
  daysInMonth,
  generatesFor,
  mayBeWithdrawn,
  effectiveDueRule,
  internalTargetDate,
  isIsoDate,
  periodsBetween,
  scheduleFor,
  statutoryDueDate,
  type DueRule,
  type DueRuleException,
  type ObligationTemplate,
  type Period,
} from "../../src/domain/obligation/model";

const IN_FY = 4;

function rule(over: Partial<ObligationTemplate> = {}): ObligationTemplate {
  return {
    id: "r",
    tenantId: "t",
    jurisdiction: "IN",
    entityType: null,
    lineageId: "r",
    module: null,
    name: "Filing",
    authority: null,
    recurrence: "monthly",
    fiscalYearStartMonth: IN_FY,
    dueRule: { kind: "day_of_month", dueMonthOffset: 1, dueDayOfMonth: 20, dueDaysAfter: null },
    unresolvedReason: null,
    leadTimeDays: 0,
    rulePack: "test@1",
    supersedesId: null,
    status: "unconfirmed",
    isActive: true,
    effectiveFrom: null,
    effectiveTo: null,
    ...over,
  };
}

const dayOfMonth = (offset: number, day: number): DueRule => ({
  kind: "day_of_month",
  dueMonthOffset: offset,
  dueDayOfMonth: day,
  dueDaysAfter: null,
});

const period = (start: string, end: string, label = ""): Period => ({ start, end, label });

describe("dates are days, never instants", () => {
  it("accepts real calendar days and refuses the ones that look like days", () => {
    expect(isIsoDate("2026-08-30")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false); // 2026 is not a leap year
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("2026-04-31")).toBe(false); // April has thirty days
    expect(isIsoDate("2026-8-30")).toBe(false);
  });

  it("adds days without a timezone touching the result", () => {
    // The whole reason these are strings. A Date at UTC midnight is the
    // PREVIOUS day in India, which for a filing deadline is a penalty.
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
  });

  it("knows how long a month is, February included", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });
});

describe("an Indian quarter is Apr–Jun, and that is the whole point of the fiscal year", () => {
  it("cuts quarters on the FINANCIAL year, not the calendar", () => {
    const qs = periodsBetween("quarterly", IN_FY, "2026-04-01", "2027-03-31");
    expect(qs.map((p) => [p.start, p.end, p.label])).toEqual([
      ["2026-04-01", "2026-06-30", "Q1 FY2026-27"],
      ["2026-07-01", "2026-09-30", "Q2 FY2026-27"],
      ["2026-10-01", "2026-12-31", "Q3 FY2026-27"],
      ["2027-01-01", "2027-03-31", "Q4 FY2026-27"],
    ]);
  });

  it("cuts them on the CALENDAR year for a country whose year starts in January", () => {
    // The same code, one field different — which is why the field is on the
    // rule and not in a constant somewhere.
    const qs = periodsBetween("quarterly", 1, "2026-01-01", "2026-12-31");
    expect(qs.map((p) => [p.start, p.label])).toEqual([
      ["2026-01-01", "Q1 2026"],
      ["2026-04-01", "Q2 2026"],
      ["2026-07-01", "Q3 2026"],
      ["2026-10-01", "Q4 2026"],
    ]);
  });

  it("steps BACK to the quarter a mid-window date falls inside", () => {
    // A window opening on 15 June belongs to Apr–Jun, not to a quarter starting
    // in June. Getting this wrong would file three-week quarters.
    const qs = periodsBetween("quarterly", IN_FY, "2026-06-15", "2026-09-30");
    expect(qs[0]?.start).toBe("2026-04-01");
    expect(qs[0]?.end).toBe("2026-06-30");
  });

  it("writes a straddling financial year the way the country writes it", () => {
    // "2026" on a filing covering Apr 2026 to Mar 2027 is exactly the ambiguity
    // that gets the wrong period filed.
    expect(periodsBetween("annual", IN_FY, "2026-04-01", "2027-03-31")[0]?.label).toBe(
      "FY2026-27",
    );
    expect(periodsBetween("annual", 1, "2026-01-01", "2026-12-31")[0]?.label).toBe("2026");
  });

  it("labels a January period as Q4 of the year that started last April", () => {
    const qs = periodsBetween("quarterly", IN_FY, "2027-01-01", "2027-03-31");
    expect(qs[0]?.label).toBe("Q4 FY2026-27");
  });

  it("halves the year for a half-yearly rule", () => {
    // MSME-1's shape. Rounding it to quarterly would produce four filings a
    // year for an obligation that has two.
    const hs = periodsBetween("half_yearly", IN_FY, "2026-04-01", "2027-03-31");
    expect(hs.map((p) => [p.start, p.end, p.label])).toEqual([
      ["2026-04-01", "2026-09-30", "H1 FY2026-27"],
      ["2026-10-01", "2027-03-31", "H2 FY2026-27"],
    ]);
  });

  it("produces nothing at all for an event-driven rule", () => {
    // No period means nothing to enumerate. FC-GPR has a formula and still
    // generates nothing, because nothing here sees a share issue.
    expect(periodsBetween("event", IN_FY, "2026-01-01", "2030-01-01")).toEqual([]);
  });

  it("produces nothing for a backwards window rather than looping", () => {
    expect(periodsBetween("monthly", IN_FY, "2026-06-01", "2026-01-01")).toEqual([]);
  });
});

describe("a monthly obligation spawns twelve instances a year out", () => {
  it("gives exactly twelve months, in order, with human labels", () => {
    const ms = periodsBetween("monthly", IN_FY, "2026-09-01", "2027-08-31");
    expect(ms).toHaveLength(12);
    expect(ms[0]).toEqual({ start: "2026-09-01", end: "2026-09-30", label: "Sep 2026" });
    expect(ms[11]).toEqual({ start: "2027-08-01", end: "2027-08-31", label: "Aug 2027" });
  });

  it("ignores the fiscal year, because a month is a month everywhere", () => {
    const indian = periodsBetween("monthly", IN_FY, "2026-01-01", "2026-03-31");
    const calendar = periodsBetween("monthly", 1, "2026-01-01", "2026-03-31");
    expect(indian).toEqual(calendar);
  });

  it("includes the month a mid-month window opens in", () => {
    // A client signed on the 14th still owes that month's return.
    const ms = periodsBetween("monthly", IN_FY, "2026-08-14", "2026-09-30");
    expect(ms.map((p) => p.label)).toEqual(["Aug 2026", "Sep 2026"]);
  });
});

describe("turning a period into the day the law wants it", () => {
  it("reads GSTR-3B as the 20th of the following month", () => {
    expect(statutoryDueDate(dayOfMonth(1, 20), period("2026-08-01", "2026-08-31"))).toBe(
      "2026-09-20",
    );
  });

  it("reads Advance Tax INSIDE its own quarter, at offset zero", () => {
    // 15 Jun / 15 Sep / 15 Dec / 15 Mar, and the due date is BEFORE the period
    // ends because the instalment is an estimate. The two due-rule shapes
    // covered it; no third kind was needed.
    const q1 = period("2026-04-01", "2026-06-30");
    const q4 = period("2027-01-01", "2027-03-31");
    expect(statutoryDueDate(dayOfMonth(0, 15), q1)).toBe("2026-06-15");
    expect(statutoryDueDate(dayOfMonth(0, 15), q4)).toBe("2027-03-15");
  });

  it("CLAMPS the day to the length of the month rather than rolling into the next", () => {
    // "The 31st" in a thirty-day month is the 30th, not the 1st. Date
    // arithmetic rolls if you let it, and a rolled deadline is a day late.
    expect(statutoryDueDate(dayOfMonth(1, 31), period("2026-03-01", "2026-03-31"))).toBe(
      "2026-04-30",
    );
    expect(statutoryDueDate(dayOfMonth(0, 31), period("2026-02-01", "2026-02-28"))).toBe(
      "2026-02-28",
    );
    expect(statutoryDueDate(dayOfMonth(0, 30), period("2024-02-01", "2024-02-29"))).toBe(
      "2024-02-29",
    );
  });

  it("counts plain days for a days_after rule, across a year boundary", () => {
    expect(
      statutoryDueDate(
        { kind: "days_after", dueMonthOffset: null, dueDayOfMonth: null, dueDaysAfter: 30 },
        period("2026-12-01", "2026-12-31"),
      ),
    ).toBe("2027-01-30");
  });
});

describe("March TDS resolves to 30 April — the exception, and why it is a row", () => {
  const marchIsDifferent: DueRuleException = {
    periodEndMonth: 3,
    kind: "day_of_month",
    dueMonthOffset: 1,
    dueDayOfMonth: 30,
    dueDaysAfter: null,
    note: "statutory, confirmed by the firm",
  };

  it("uses the 7th for eleven months and 30 April for March", () => {
    const base = dayOfMonth(1, 7);
    const august = period("2026-08-01", "2026-08-31");
    const march = period("2027-03-01", "2027-03-31");

    expect(statutoryDueDate(effectiveDueRule(base, [marchIsDifferent], august), august)).toBe(
      "2026-09-07",
    );
    expect(statutoryDueDate(effectiveDueRule(base, [marchIsDifferent], march), march)).toBe(
      "2027-04-30",
    );
  });

  it("matches on the month the PERIOD ends in, never the month it is due", () => {
    // Keying on the due month would mean asking the answer to find the
    // question: the due month is exactly what the exception changes. February's
    // return is DUE in March and must not be caught by a March exception.
    const february = period("2027-02-01", "2027-02-28");
    expect(effectiveDueRule(dayOfMonth(1, 7), [marchIsDifferent], february).dueDayOfMonth).toBe(7);
  });

  it("moves the quarterly TDS statement two months out for Jan–Mar", () => {
    // 31 Jul / 31 Oct / 31 Jan / 31 MAY. The fourth is two months after its
    // quarter rather than one — the same shape as March's deposit.
    const base = dayOfMonth(1, 31);
    const q4Exception: DueRuleException = {
      periodEndMonth: 3,
      kind: "day_of_month",
      dueMonthOffset: 2,
      dueDayOfMonth: 31,
      dueDaysAfter: null,
      note: "31 May, from the firm's own sheet",
    };
    const quarters = periodsBetween("quarterly", IN_FY, "2026-04-01", "2027-03-31");
    const dates = quarters.map((p) =>
      statutoryDueDate(effectiveDueRule(base, [q4Exception], p), p),
    );
    expect(dates).toEqual(["2026-07-31", "2026-10-31", "2027-01-31", "2027-05-31"]);
  });

  it("falls back to the rule's own formula when no exception matches", () => {
    const august = period("2026-08-01", "2026-08-31");
    expect(effectiveDueRule(dayOfMonth(1, 7), [], august).dueDayOfMonth).toBe(7);
  });
});

describe("T–X is the firm's own, and it can never land after the law's", () => {
  it("subtracts the lead time", () => {
    expect(internalTargetDate("2026-09-20", 5)).toBe("2026-09-15");
  });

  it("is the statutory date itself when the firm has stated no lead time", () => {
    // Every shipped rule seeds at zero, deliberately: a guessed lead time is a
    // commitment the firm never made.
    expect(internalTargetDate("2026-09-20", 0)).toBe("2026-09-20");
    expect(internalTargetDate("2026-09-20", -3)).toBe("2026-09-20");
  });

  it("is ALLOWED to fall before the period ends, and that is not a bug", () => {
    // The obvious-looking second clamp is wrong on the firm's own sheet:
    // Advance Tax for Apr–Jun is due 15 June, inside its own quarter. Clamping
    // to period end would have silently cancelled the lead time on every such
    // rule.
    const q1 = period("2026-04-01", "2026-06-30");
    const statutory = statutoryDueDate(dayOfMonth(0, 15), q1);
    expect(internalTargetDate(statutory, 10)).toBe("2026-06-05");
  });
});

describe("scheduleFor is the one place a rule plus a period becomes dates", () => {
  it("gives both dates for a rule that computes", () => {
    const august = period("2026-08-01", "2026-08-31", "Aug 2026");
    expect(scheduleFor(rule({ leadTimeDays: 6 }), [], august)).toEqual({
      statutoryDueOn: "2026-09-20",
      internalTargetOn: "2026-09-14",
    });
  });

  it("gives NOTHING for a rule with no formula, rather than a plausible date", () => {
    // The forty-six unresolved rules in the shipped pack land here. A rule that
    // cannot compute must produce no row at all — a plausible-looking wrong due
    // date is the dangerous kind, because nobody re-reads it.
    const noFormula = rule({ dueRule: null, unresolvedReason: "depends on the AGM date" });
    expect(scheduleFor(noFormula, [], period("2026-08-01", "2026-08-31"))).toBeNull();
  });

  it("applies the exception through the same call", () => {
    const march = period("2027-03-01", "2027-03-31", "Mar 2027");
    const tds = rule({ dueRule: dayOfMonth(1, 7) });
    const out = scheduleFor(
      tds,
      [
        {
          periodEndMonth: 3,
          kind: "day_of_month",
          dueMonthOffset: 1,
          dueDayOfMonth: 30,
          dueDaysAfter: null,
          note: "statutory",
        },
      ],
      march,
    );
    expect(out?.statutoryDueOn).toBe("2027-04-30");
  });
});

describe("what a rule is actually doing, and why an empty calendar is explainable", () => {
  it("says `generating` only when active, with a formula and periods, confirmed AND on a service", () => {
    expect(coverageOf(rule({ status: "confirmed" }), 1)).toBe("generating");
  });

  it("says `unlinked` for a confirmed formula no service carries (T6.16, decision 1)", () => {
    // NOT generating. A rule reaches a client only through a service the
    // client bought, and "every service" is gone as a generating reading: it
    // is the reading that put 98 GST filings on a bookkeeping-only client.
    expect(coverageOf(rule({ status: "confirmed" }), 0)).toBe("unlinked");
  });

  it("says `unlinked` before `unconfirmed`, because adding it to a service confirms it", () => {
    // A shipped pack row is both. The actionable answer is the catalogue,
    // where adding it shows its dates in words and confirms it in one act.
    expect(coverageOf(rule(), 0)).toBe("unlinked");
  });

  it("says `unconfirmed` for a formula nobody at the firm has checked, even on a service", () => {
    // NOT generating. Until 2026-09-18 this row put its filings on the calendar
    // of every live engagement in its country, including a client whose only
    // service excluded the filing — and that client's portal called them missed.
    expect(coverageOf(rule(), 1)).toBe("unconfirmed");
    expect(coverageOf(rule({ status: "unconfirmed" }), 2)).toBe("unconfirmed");
  });

  it("says `needs_formula` for a real obligation whose timing we cannot derive", () => {
    // NOT an error, and the screen must not render it as one: forty-six of the
    // fifty-seven shipped rules are here, each with the firm's own words for
    // what is missing. Asked before the link, so a service carrying it says
    // what it still needs.
    expect(coverageOf(rule({ dueRule: null, unresolvedReason: "State-specific" }), 1)).toBe(
      "needs_formula",
    );
    expect(coverageOf(rule({ dueRule: null, unresolvedReason: "State-specific" }), 0)).toBe(
      "needs_formula",
    );
  });

  it("says `event_driven` for a rule with a formula and no period to count from", () => {
    expect(coverageOf(rule({ recurrence: "event" }), 1)).toBe("event_driven");
  });

  it("says `retired` first, whatever else is true of the rule", () => {
    // A retired rule still explains an old filing's date, so it stays readable
    // — and it must not be reported as needing a formula it will never get.
    expect(coverageOf(rule({ isActive: false, dueRule: null, unresolvedReason: "x" }), 1)).toBe(
      "retired",
    );
  });
});

describe("the generation predicate for ONE engagement: the rule, and a link to its service (T6.16)", () => {
  const GST = "svc-gst";
  const FULL = "svc-full";
  const BOOKS = "svc-books";
  const confirmed = rule({ id: "r2", lineageId: "chain", status: "confirmed" });

  it("generates for an engagement whose service carries the rule's chain", () => {
    expect(generatesFor(confirmed, [{ lineageId: "chain", serviceEntryId: GST }], GST)).toBe(true);
  });

  it("generates NOTHING for a rule no service carries, whatever the engagement bought", () => {
    // Decision 1. The old NULL reached every engagement; nothing does now.
    expect(generatesFor(confirmed, [], GST)).toBe(false);
    expect(generatesFor(confirmed, [], null)).toBe(false);
  });

  it("does not generate for a service that does not carry it: the bookkeeping client", () => {
    expect(generatesFor(confirmed, [{ lineageId: "chain", serviceEntryId: GST }], BOOKS)).toBe(false);
  });

  it("generates for BOTH services of one rule, which is how it is written once and reused", () => {
    const links = [
      { lineageId: "chain", serviceEntryId: GST },
      { lineageId: "chain", serviceEntryId: FULL },
    ];
    expect(generatesFor(confirmed, links, GST)).toBe(true);
    expect(generatesFor(confirmed, links, FULL)).toBe(true);
    expect(generatesFor(confirmed, links, BOOKS)).toBe(false);
  });

  it("reads the link on the CHAIN, so a successor is on its predecessor's services", () => {
    const successor = rule({ id: "r3", lineageId: "chain", supersedesId: "r2", status: "confirmed" });
    expect(generatesFor(successor, [{ lineageId: "chain", serviceEntryId: GST }], GST)).toBe(true);
    // A link to some OTHER chain carries nothing for this one.
    expect(generatesFor(successor, [{ lineageId: "other", serviceEntryId: GST }], GST)).toBe(false);
  });

  it("still refuses an unconfirmed or formula-less rule, linked or not", () => {
    const links = [{ lineageId: "chain", serviceEntryId: GST }];
    expect(generatesFor(rule({ lineageId: "chain" }), links, GST)).toBe(false);
    expect(
      generatesFor(
        rule({ lineageId: "chain", status: "confirmed", dueRule: null, unresolvedReason: "x" }),
        links,
        GST,
      ),
    ).toBe(false);
  });

  it("is reached by nothing when the engagement's service cannot be resolved", () => {
    // The safe direction under decision 1: the coverage screen names the gap,
    // where a guess would put a filing on a client who did not buy it.
    expect(generatesFor(confirmed, [{ lineageId: "chain", serviceEntryId: GST }], null)).toBe(false);
  });
});

describe("which filing removing a rule from a service may take off the calendar (T6.16)", () => {
  const TODAY = "2026-09-26";
  const open = { isTerminal: false, needsDecision: false };
  const untouched = {
    workItemId: null,
    filedOn: null,
    resolvedAt: null,
    withdrawnAt: null,
    statutoryDueOn: "2026-10-20",
  };

  it("takes an untouched filing whose date is still ahead", () => {
    expect(mayBeWithdrawn(untouched, open, TODAY)).toBe(true);
  });

  it("takes one due TODAY on the firm's calendar: the deadline has not passed", () => {
    expect(mayBeWithdrawn({ ...untouched, statutoryDueOn: TODAY }, open, TODAY)).toBe(true);
  });

  it("keeps one whose date has passed: removing it would hide a deadline the client may have missed", () => {
    expect(mayBeWithdrawn({ ...untouched, statutoryDueOn: "2026-09-25" }, open, TODAY)).toBe(false);
  });

  it("keeps one somebody started, filed or decided", () => {
    expect(mayBeWithdrawn({ ...untouched, workItemId: "wi" }, open, TODAY)).toBe(false);
    expect(mayBeWithdrawn({ ...untouched, filedOn: "2026-09-01" }, open, TODAY)).toBe(false);
    expect(
      mayBeWithdrawn({ ...untouched, resolvedAt: "2026-09-01T00:00:00.000Z" }, open, TODAY),
    ).toBe(false);
  });

  it("keeps one waiting on a decision or already settled, by the state's FLAGS", () => {
    expect(mayBeWithdrawn(untouched, { isTerminal: false, needsDecision: true }, TODAY)).toBe(false);
    expect(mayBeWithdrawn(untouched, { isTerminal: true, needsDecision: false }, TODAY)).toBe(false);
  });

  it("does not take one twice", () => {
    expect(
      mayBeWithdrawn({ ...untouched, withdrawnAt: "2026-09-20T00:00:00.000Z" }, open, TODAY),
    ).toBe(false);
  });
});

describe("which row of a chain governs TODAY's period, and what changes next (T6.16 follow-up)", () => {
  // GSTR-3B, due the 20th, and the law changing to the 22nd from April 2027:
  // the predecessor is closed at the cutover and the successor opens there.
  const before = rule({ id: "a", lineageId: "a", effectiveTo: "2027-04-01" });
  const after = rule({
    id: "b",
    lineageId: "a",
    supersedesId: "a",
    effectiveFrom: "2027-04-01",
    dueRule: dayOfMonth(1, 22),
  });

  it("is the predecessor while today's period is before the cutover, with the successor next", () => {
    // The row with no end is the SUCCESSOR, and showing it said September's
    // return was due on the 22nd while the calendar dated it the 20th.
    const on = chainOnDay([after, before], "2026-09-26");
    expect(on.governing?.id).toBe("a");
    expect(on.next?.id).toBe("b");
  });

  it("is the successor from the cutover, with nothing next", () => {
    const on = chainOnDay([before, after], "2027-04-01");
    expect(on.governing?.id).toBe("b");
    expect(on.next).toBeNull();
  });

  it("judges the PERIOD containing the day, never the day, so a cutover mid-quarter waits for the quarter", () => {
    // A quarterly rule changing from 15 August: today's quarter (Jul-Sep in
    // India) began before it, so the old rule governs it and the new one is
    // next. Testing the day would have handed the quarter over mid-way.
    const q1 = rule({ id: "q1", lineageId: "q1", recurrence: "quarterly", effectiveTo: "2026-08-15" });
    const q2 = rule({
      id: "q2",
      lineageId: "q1",
      recurrence: "quarterly",
      effectiveFrom: "2026-08-15",
    });
    const on = chainOnDay([q1, q2], "2026-09-26");
    expect(on.governing?.id).toBe("q1");
    expect(on.next?.id).toBe("q2");
  });

  it("is one row with nothing next on a chain nobody has amended", () => {
    const only = rule();
    expect(chainOnDay([only], "2026-09-26")).toEqual({ governing: only, next: null });
  });

  it("governs nothing today on a chain written to start later, and names that start as next", () => {
    const later = rule({ id: "l", lineageId: "l", effectiveFrom: "2027-04-01" });
    expect(chainOnDay([later], "2026-09-26")).toEqual({ governing: null, next: later });
  });

  it("reads an event-driven rule on the day itself, since it has no period", () => {
    const old = rule({ id: "e1", lineageId: "e1", recurrence: "event", effectiveTo: "2026-10-01" });
    const upcoming = rule({ id: "e2", lineageId: "e1", recurrence: "event", effectiveFrom: "2026-10-01" });
    expect(chainOnDay([old, upcoming], "2026-09-30")).toEqual({ governing: old, next: upcoming });
    expect(chainOnDay([old, upcoming], "2026-10-01")).toEqual({ governing: upcoming, next: null });
  });
});
