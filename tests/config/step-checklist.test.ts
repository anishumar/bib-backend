// A step's own two lists in the `workflow_template` body (T6.15): the sub-steps
// whoever does the step ticks, and the review points whoever checks it ticks.
//
// The validator's other rules are in `tests/orchestrator/template.test.ts`;
// these are the new fields' refusals, each with its sentence, and the one
// property that matters most: every template published before the fields
// existed still parses, and reads as a step with no lists at all.
import { describe, expect, it } from "vitest";
import { readWorkflowTemplate, validateBody } from "../../src/domain/config/model";

type Line = { key: string; label: string };

/** Monthly accounting, cut down to the two steps the lists are about: the doer's
 *  collection step and the manager's review, which is checked by a policy. */
function body(over: {
  checklist?: unknown;
  reviewPoints?: unknown;
  executor?: string;
  verificationPolicyKey?: string | null;
} = {}): Record<string, unknown> {
  const collect: Record<string, unknown> = {
    key: "collect",
    label: "Collect source data",
    executor: over.executor ?? "human",
    dependsOn: [],
    condition: null,
    verificationPolicyKey: over.verificationPolicyKey === undefined ? "manager_review" : over.verificationPolicyKey,
    performer: null,
  };
  if ("checklist" in over) collect["checklist"] = over.checklist;
  if ("reviewPoints" in over) collect["reviewPoints"] = over.reviewPoints;
  return { label: "Monthly accounting", steps: [collect] };
}

const check = (over: Parameters<typeof body>[0] = {}): string | null => validateBody("workflow_template", body(over));

const lines = (n: number, prefix = "s"): Line[] =>
  Array.from({ length: n }, (_, i) => ({ key: `${prefix}${String(i + 1)}`, label: `Line ${String(i + 1)}` }));

describe("a step with lists", () => {
  it("accepts sub-steps and review points, and reads them back in their order", () => {
    const b = body({
      checklist: [
        { key: "s1", label: "Bank statements" },
        { key: "s2", label: "  Sales data  " },
      ],
      reviewPoints: [{ key: "r1", label: "P&L movements" }],
    });
    expect(validateBody("workflow_template", b)).toBeNull();
    const step = readWorkflowTemplate(b)?.steps[0];
    // Trimmed on the way out, so a tick copies what the screen shows.
    expect(step?.checklist).toEqual([
      { key: "s1", label: "Bank statements" },
      { key: "s2", label: "Sales data" },
    ]);
    expect(step?.reviewPoints).toEqual([{ key: "r1", label: "P&L movements" }]);
  });

  it("accepts empty lists and null, which the editor may send", () => {
    expect(check({ checklist: [], reviewPoints: [] })).toBeNull();
    expect(check({ checklist: null, reviewPoints: null })).toBeNull();
  });

  it("lets the two lists reuse a key: they are different lists ticked by different people", () => {
    expect(check({ checklist: [{ key: "k1", label: "A" }], reviewPoints: [{ key: "k1", label: "B" }] })).toBeNull();
  });

  it("accepts forty lines and sub-steps on a step a machine drafts and a person approves", () => {
    expect(check({ checklist: lines(40) })).toBeNull();
    expect(check({ checklist: lines(3), executor: "agent_with_approval" })).toBeNull();
  });
});

describe("an old body without the fields", () => {
  it("still parses, and every step reads as having no lists", () => {
    // A published version is FROZEN: every template written before T6.15 has
    // neither field and never will, and a job pinned to one must behave
    // exactly as before. Not a migration to run; a shape to keep reading.
    const old = body();
    expect(validateBody("workflow_template", old)).toBeNull();
    const step = readWorkflowTemplate(old)?.steps[0];
    expect(step?.checklist).toEqual([]);
    expect(step?.reviewPoints).toEqual([]);
  });
});

describe("the refusals, each with its sentence", () => {
  it("refuses a blank label, naming the step's index, the list and the value", () => {
    expect(check({ checklist: [{ key: "s1", label: "   " }] })).toMatch(
      /steps\[0\]\.checklist\[0\]\.label must be 1 to 200 characters once spaces are trimmed.*Got " {3}"/,
    );
  });

  it("refuses a label over 200 characters", () => {
    expect(check({ checklist: [{ key: "s1", label: "x".repeat(201) }] })).toMatch(/1 to 200 characters/);
  });

  it("refuses a key that is not a handle", () => {
    expect(check({ checklist: [{ key: "Bank Statements", label: "Bank statements" }] })).toMatch(
      /steps\[0\]\.checklist\[0\]\.key must be a lowercase handle.*Got "Bank Statements"/,
    );
  });

  it("refuses a key used twice in one list", () => {
    expect(
      check({ reviewPoints: [{ key: "r1", label: "A" }, { key: "r1", label: "B" }] }),
    ).toMatch(/steps\[0\]\.reviewPoints\[1\]\.key "r1" appears twice in this step's review points/);
  });

  it("refuses forty-one lines", () => {
    expect(check({ checklist: lines(41) })).toMatch(/has 41 sub-steps, and one step holds at most 40/);
  });

  it("refuses a line with a field it does not know, and one that is not an object", () => {
    expect(check({ checklist: [{ key: "s1", label: "A", done: true }] })).toMatch(
      /steps\[0\]\.checklist\[0\]: unknown field "done"/,
    );
    expect(check({ checklist: ["Bank statements"] })).toMatch(/checklist\[0\] must be \{ key, label \}/);
    expect(check({ checklist: "Bank statements" })).toMatch(/checklist must be a list of sub-steps/);
  });

  it("refuses review points on a step that names no check", () => {
    // Nobody would ever tick them: review points are ticked by whoever checks
    // the step, and this one is checked by nobody.
    expect(check({ reviewPoints: [{ key: "r1", label: "P&L movements" }], verificationPolicyKey: null })).toBe(
      'steps[0] (step "collect"): review points are ticked by whoever checks this step, and this ' +
        "step names no check. Choose who checks it, or move these to the sub-steps.",
    );
  });

  it("refuses sub-steps on a step a machine does on its own", () => {
    // Nobody would ever tick them, so the machine would finish the step with
    // its list open: a gate with a hole in it.
    expect(check({ checklist: lines(2), executor: "agent" })).toBe(
      'steps[0] (step "collect"): sub-steps are ticked by a person, and this step is done by a ' +
        "machine on its own. Choose 'A person' or 'Automatically, then a person approves'.",
    );
  });

  it("puts no em dash in any of the new sentences", () => {
    // The plain-words pass (2026-09-18): these are read by a partner on the
    // process editor.
    const sentences = [
      check({ checklist: [{ key: "s1", label: " " }] }),
      check({ checklist: [{ key: "S 1", label: "A" }] }),
      check({ checklist: [{ key: "s1", label: "A" }, { key: "s1", label: "B" }] }),
      check({ checklist: lines(41) }),
      check({ checklist: 7 }),
      check({ reviewPoints: lines(1, "r"), verificationPolicyKey: null }),
      check({ checklist: lines(1), executor: "agent" }),
    ];
    for (const s of sentences) {
      expect(s).not.toBeNull();
      expect(s).not.toContain("—");
    }
  });
});
