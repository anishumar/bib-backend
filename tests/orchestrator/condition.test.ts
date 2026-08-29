// The four operators a step condition may use, and the one rule that survives
// all of them.
//
// `evaluateCondition` is pure, so every case here is a table row rather than a
// fixture. The service tests in `walk.test.ts` prove that a false condition
// actually SKIPS the step and cascades; this file is about what "false" means.
//
// ── WHY THERE IS NO `gte` HERE ──────────────────────────────────────────────
//
// Because there is no numeric FACT to compare. Both facts this engine can
// resolve — `recurrence` and `jurisdiction` — are strings, and nothing in the
// schema stores a turnover, an employee count or a paid-up capital. The firm's
// own compliance list makes a threshold its single most common driver, and that
// is exactly why the shape moved now and the operators did not: adding an
// operator later is backward compatible against a frozen body, changing the
// shape would not have been.
import { describe, expect, it } from "vitest";
import { evaluateCondition } from "../../src/usecase/orchestrator/service";
import type { JobSubject } from "../../src/usecase/orchestrator/ports";

function subject(over: Partial<JobSubject> = {}): JobSubject {
  return {
    workflowTemplateKey: "gst-monthly",
    recurrence: "monthly",
    jurisdiction: "IN",
    ...over,
  };
}

function holds(
  op: string,
  value: string | readonly string[],
  s: JobSubject | null = subject(),
): boolean {
  return evaluateCondition({ fact: "jurisdiction", op, value }, s).holds;
}

describe("equals", () => {
  it("holds on a match and not otherwise", () => {
    expect(holds("equals", "IN")).toBe(true);
    expect(holds("equals", "AE")).toBe(false);
  });
});

describe("not_equals — the inverse a firm could not write before", () => {
  it('expresses "everyone except"', () => {
    // "The FEMA review applies to everybody except domestic-only clients."
    // Before this operator that needed a separate template per jurisdiction.
    expect(holds("not_equals", "AE")).toBe(true);
    expect(holds("not_equals", "IN")).toBe(false);
  });
});

describe("in / not_in — a list, instead of one template per jurisdiction", () => {
  it("holds when the fact is one of the listed values", () => {
    expect(holds("in", ["IN", "AE", "SG"])).toBe(true);
    expect(holds("in", ["AE", "SG"])).toBe(false);
  });

  it("not_in is its complement", () => {
    expect(holds("not_in", ["AE", "SG"])).toBe(true);
    expect(holds("not_in", ["IN", "AE"])).toBe(false);
  });

  it("a single-item list behaves exactly like equals", () => {
    expect(holds("in", ["IN"])).toBe(holds("equals", "IN"));
    expect(holds("in", ["AE"])).toBe(holds("equals", "AE"));
  });
});

describe("AN UNRESOLVED FACT KEEPS THE STEP — under every operator", () => {
  // The decision the whole condition system turns on, and the one most likely
  // to be "simplified" later by somebody reading it as a missing else. A
  // service that never stated its recurrence, or an entity with no registered
  // jurisdiction, is a gap in the firm's DATA — and treating a gap as an answer
  // quietly removes steps from a process because a field was left blank. An
  // extra review costs an hour; a missing one costs a filing.
  const unstated = subject({ jurisdiction: null });

  it("keeps it on the positive operators", () => {
    expect(holds("equals", "IN", unstated)).toBe(true);
    expect(holds("in", ["IN", "AE"], unstated)).toBe(true);
  });

  it("KEEPS IT ON THE NEGATIVE ONES TOO, which is the subtle half", () => {
    // "The jurisdiction is not IN" reads as TRUE when the jurisdiction is
    // unknown — and it is not true, it is unknown. Evaluating `not_equals`
    // against a null would let a blank field SATISFY a condition, which is the
    // same failure as skipping on one, reached from the opposite side. Both
    // answers here are "keep", and they are the same answer for the same
    // reason.
    expect(holds("not_equals", "IN", unstated)).toBe(true);
    expect(holds("not_equals", "AE", unstated)).toBe(true);
    expect(holds("not_in", ["IN"], unstated)).toBe(true);
    expect(holds("not_in", ["AE"], unstated)).toBe(true);
  });

  it("says WHY, so the note on the skipped row is readable", () => {
    const verdict = evaluateCondition(
      { fact: "jurisdiction", op: "not_equals", value: "IN" },
      unstated,
    );
    expect(verdict.actual).toBeNull();
    expect(verdict.why).toContain("not stated");
  });

  it("keeps it when the job has no subject at all", () => {
    // A job whose cause cannot be resolved — an engagement that was removed.
    // Not a reason to crash a sweep, and not a reason to delete steps either.
    expect(holds("equals", "IN", null)).toBe(true);
    expect(holds("not_in", ["IN"], null)).toBe(true);
  });
});

describe("an operator the evaluator has not learnt", () => {
  it("keeps the step rather than skipping it", () => {
    // The config validator refuses an unknown operator at the WRITE, so this is
    // the second wall rather than the first. Same direction as an unresolved
    // fact: a template naming something this engine cannot evaluate must not
    // silently delete steps from a process.
    expect(holds("between", "IN")).toBe(true);
    expect(holds("gte", "5")).toBe(true);
  });
});

describe("the prose on a skip", () => {
  it("reads as a sentence for each operator", () => {
    const cases: [string, string | readonly string[], string][] = [
      ["equals", "AE", "only when it is"],
      ["not_equals", "IN", "anything but"],
      ["in", ["AE", "SG"], "one of"],
      ["not_in", ["IN"], "none of"],
    ];
    for (const [op, value, fragment] of cases) {
      const verdict = evaluateCondition({ fact: "jurisdiction", op, value }, subject());
      expect(verdict.why, op).toContain(fragment);
      // The ACTUAL value is always in it — a note saying only what was expected
      // leaves the reader looking up what the client's jurisdiction actually is.
      expect(verdict.why, op).toContain("IN");
    }
  });
});
