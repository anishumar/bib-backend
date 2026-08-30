// The `workflow_template` body validator (T2.7).
//
// Every refusal here is a job that would otherwise sit half-finished with
// nothing saying why — which is the failure this whole task exists to remove,
// so it is refused at the WRITE, where a partner is looking at the screen, and
// not at run time in a worker nobody watches.
import { describe, expect, it } from "vitest";
import { validateBody, readWorkflowTemplate } from "../../src/domain/config/model";

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    label: "GST monthly filing",
    steps: [
      { key: "collect", label: "Collect data", executor: "human", dependsOn: [], condition: null },
      {
        key: "file",
        label: "File on the portal",
        executor: "human",
        dependsOn: ["collect"],
        condition: null,
      },
    ],
    ...over,
  };
}

function check(over: Record<string, unknown> = {}): string | null {
  return validateBody("workflow_template", body(over));
}

/** One step carrying one condition — the shape most of the condition tests
 *  differ by, so they differ by that alone. */
function condition(c: Record<string, unknown>): string | null {
  return check({
    steps: [{ key: "s1", label: "A", executor: "human", dependsOn: [], condition: c }],
  });
}

describe("a well-formed process", () => {
  it("is accepted", () => {
    expect(check()).toBeNull();
  });

  it("reads back with every field", () => {
    const template = readWorkflowTemplate(body());
    expect(template?.label).toBe("GST monthly filing");
    expect(template?.steps.map((s) => [s.key, s.executor, s.dependsOn])).toEqual([
      ["collect", "human", []],
      ["file", "human", ["collect"]],
    ]);
  });

  it("accepts a parallel shape — two steps on one dependency", () => {
    expect(
      check({
        steps: [
          { key: "s1", label: "A", executor: "human", dependsOn: [], condition: null },
          { key: "s2", label: "B", executor: "human", dependsOn: ["s1"], condition: null },
          { key: "s3", label: "C", executor: "human", dependsOn: ["s1"], condition: null },
          { key: "s4", label: "D", executor: "human", dependsOn: ["s2", "s3"], condition: null },
        ],
      }),
    ).toBeNull();
  });

  it("accepts a condition on the facts it knows", () => {
    expect(
      check({
        steps: [
          {
            key: "annual",
            label: "Annual summary",
            executor: "human",
            dependsOn: [],
            condition: { fact: "recurrence", op: "equals", value: "annually" },
          },
        ],
      }),
    ).toBeNull();
  });

  // THE LEGACY SHAPE, and it is not deprecated — it is frozen into every
  // version published before operators existed, and a published body can never
  // be rewritten. If this ever stops parsing, those firms' jobs stop walking.
  it("still accepts the pre-operator shape, forever", () => {
    expect(
      check({
        steps: [
          {
            key: "annual",
            label: "Annual summary",
            executor: "human",
            dependsOn: [],
            condition: { fact: "recurrence", equals: "annually" },
          },
        ],
      }),
    ).toBeNull();
  });

  it("refuses a body carrying BOTH shapes", () => {
    // Somebody's half-finished edit. Guessing which half they meant is how a
    // step quietly starts applying to the wrong clients.
    const problem = condition({ fact: "recurrence", equals: "annually", op: "not_equals" });
    expect(problem).toMatch(/both/);
  });

  it("accepts each of the four operators", () => {
    expect(condition({ fact: "jurisdiction", op: "equals", value: "IN" })).toBeNull();
    expect(condition({ fact: "jurisdiction", op: "not_equals", value: "IN" })).toBeNull();
    expect(condition({ fact: "jurisdiction", op: "in", value: ["IN", "AE"] })).toBeNull();
    expect(condition({ fact: "jurisdiction", op: "not_in", value: ["IN"] })).toBeNull();
  });

  it("refuses an operator it cannot evaluate — including the numeric ones", () => {
    // `gte` arrives with the first numeric FACT, which arrives with the data.
    // Until then it would sit in a picker beside `jurisdiction` and compare a
    // string, which is a control that looks live and is inert.
    const problem = condition({ fact: "jurisdiction", op: "gte", value: "5" });
    expect(problem).toMatch(/equals, not_equals, in, not_in/);
    expect(problem).toMatch(/numeric/);
  });

  it("refuses a list operator given a single value, and the reverse", () => {
    expect(condition({ fact: "jurisdiction", op: "in", value: "IN" })).toMatch(/array/);
    expect(condition({ fact: "jurisdiction", op: "equals", value: ["IN"] })).toMatch(/string/);
  });

  it("refuses an EMPTY list — a step that never runs is not a condition", () => {
    expect(condition({ fact: "jurisdiction", op: "in", value: [] })).toMatch(/non-empty array/);
  });
});

describe("the shapes that would produce a job nobody can explain", () => {
  it("refuses a process with no steps", () => {
    expect(check({ steps: [] })).toMatch(/non-empty array/);
  });

  it("refuses a duplicate step key — the second step would silently not exist", () => {
    const problem = check({
      steps: [
        { key: "s1", label: "A", executor: "human", dependsOn: [], condition: null },
        { key: "s1", label: "Also A", executor: "human", dependsOn: [], condition: null },
      ],
    });
    expect(problem).toMatch(/appears twice/);
  });

  it("refuses a dependency on a step this template does not have", () => {
    const problem = check({
      steps: [{ key: "s1", label: "A", executor: "human", dependsOn: ["ghost"], condition: null }],
    });
    // The message NAMES the missing key and lists what there is, because "this
    // template is invalid" is not something anybody can act on.
    expect(problem).toMatch(/"ghost".*does not have/s);
    expect(problem).toMatch(/Steps: s1/);
  });

  it("refuses a step that depends on itself", () => {
    const problem = check({
      steps: [{ key: "s1", label: "A", executor: "human", dependsOn: ["s1"], condition: null }],
    });
    expect(problem).toMatch(/its own step/);
  });

  it("refuses a CYCLE, and says which steps form it", () => {
    const problem = check({
      steps: [
        { key: "s1", label: "A", executor: "human", dependsOn: ["s3"], condition: null },
        { key: "s2", label: "B", executor: "human", dependsOn: ["s1"], condition: null },
        { key: "s3", label: "C", executor: "human", dependsOn: ["s2"], condition: null },
      ],
    });
    expect(problem).toMatch(/cycle/);
    // The PATH, not a boolean — "a -> c -> b -> a" is fixable and "invalid" is
    // not.
    expect(problem).toMatch(/->/);
  });

  it("refuses a duplicate dependency on one step", () => {
    expect(
      check({
        steps: [
          { key: "s1", label: "A", executor: "human", dependsOn: [], condition: null },
          { key: "s2", label: "B", executor: "human", dependsOn: ["s1", "s1"], condition: null },
        ],
      }),
    ).toMatch(/twice/);
  });
});

describe("the fields, and what their refusals tell somebody", () => {
  it("refuses an unknown field rather than storing it and doing nothing with it", () => {
    expect(check({ stages: [] })).toMatch(/unknown field/);
    expect(
      check({
        steps: [
          { key: "s1", label: "A", executor: "human", dependsOn: [], condition: null, owner: "x" },
        ],
      }),
    ).toMatch(/unknown field/);
  });

  it("refuses a step key that is not a handle", () => {
    expect(
      check({
        steps: [
          { key: "Manager Review", label: "A", executor: "human", dependsOn: [], condition: null },
        ],
      }),
    ).toMatch(/lowercase handle/);
  });

  it("refuses an executor outside the three, and the message says human is the ordinary one", () => {
    const problem = check({
      steps: [{ key: "s1", label: "A", executor: "robot", dependsOn: [], condition: null }],
    });
    expect(problem).toMatch(/human, agent, agent_with_approval/);
    // The sentence that tells a firm it can use this product today.
    expect(problem).toMatch(/runs today/);
  });

  it("refuses a condition on a fact the engine cannot resolve", () => {
    const problem = check({
      steps: [
        {
          key: "s1",
          label: "A",
          executor: "human",
          dependsOn: [],
          condition: { fact: "turnover", equals: "big" },
        },
      ],
    });
    expect(problem).toMatch(/recurrence, jurisdiction/);
    // And says how the set grows, because the real list is a client question
    // that is still open.
    expect(problem).toMatch(/closed on/);
  });

  it("refuses an empty label on a step — somebody reads it", () => {
    expect(
      check({
        steps: [{ key: "s1", label: "  ", executor: "human", dependsOn: [], condition: null }],
      }),
    ).toMatch(/somebody reads it/);
  });
});

describe("reading a stored body back", () => {
  it("returns null rather than throwing when the body is not a template", () => {
    // The pinned-history case: a caller resolving a version from a year ago is
    // reading the past, and a past that does not parse is a fact rather than an
    // exception to raise at whoever asked.
    expect(readWorkflowTemplate({ label: "x" })).toBeNull();
    expect(readWorkflowTemplate({})).toBeNull();
  });

  it("carries a condition through unchanged", () => {
    const template = readWorkflowTemplate(
      body({
        steps: [
          {
            key: "annual",
            label: "Annual",
            executor: "agent_with_approval",
            dependsOn: [],
            condition: { fact: "jurisdiction", equals: "AE" },
          },
        ],
      }),
    );
    // NORMALISED on the way out. The stored body above is the legacy shape —
    // what every version published before operators existed carries — and the
    // reader turns it into the one shape the engine evaluates. A published
    // version is frozen, so this is not a migration waiting to happen.
    expect(template?.steps[0]?.condition).toEqual({
      fact: "jurisdiction",
      op: "equals",
      value: "AE",
    });
    expect(template?.steps[0]?.executor).toBe("agent_with_approval");
  });
});
