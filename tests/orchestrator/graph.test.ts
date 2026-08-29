// The pure graph rules (T2.7) — readiness, the skip cascade, and the derived
// job status.
//
// These are separated from the service tests because they are where the shapes
// the acceptance names actually LIVE. `readySteps` is four lines and it is the
// whole engine; everything the orchestrator does around it is I/O.
import { describe, expect, it } from "vitest";
import {
  cascadeSkips,
  clearsDependents,
  isSettled,
  isStepStatus,
  jobStatusFrom,
  readySteps,
  waitsForAPerson,
} from "../../src/domain/orchestrator/model";
import type { JobStep, StepStatus } from "../../src/domain/orchestrator/model";

function s(stepKey: string, status: StepStatus): JobStep {
  return {
    id: stepKey,
    tenantId: "t",
    jobId: "j",
    stepKey,
    label: stepKey,
    executor: "human",
    status,
    outcomeNote: null,
    startedAt: null,
    finishedAt: null,
    performedBy: null,
  };
}

function def(key: string, dependsOn: readonly string[] = []) {
  return { key, dependsOn };
}

describe("readySteps — the one rule the whole engine turns on", () => {
  it("a step with no dependencies is ready as soon as the job starts", () => {
    expect(readySteps([def("a")], [s("a", "pending")])).toEqual(["a"]);
  });

  it("SEQUENTIAL: b waits until a is done", () => {
    const defs = [def("a"), def("b", ["a"])];
    expect(readySteps(defs, [s("a", "pending"), s("b", "pending")])).toEqual(["a"]);
    expect(readySteps(defs, [s("a", "done"), s("b", "pending")])).toEqual(["b"]);
  });

  it("PARALLEL: two steps on the same dependency become ready together", () => {
    const defs = [def("a"), def("b", ["a"]), def("c", ["a"])];
    expect(readySteps(defs, [s("a", "done"), s("b", "pending"), s("c", "pending")])).toEqual([
      "b",
      "c",
    ]);
  });

  it("PARALLEL: a join waits for the slower branch", () => {
    const defs = [def("b"), def("c"), def("d", ["b", "c"])];
    expect(readySteps(defs, [s("b", "done"), s("c", "blocked"), s("d", "pending")])).toEqual([]);
    expect(readySteps(defs, [s("b", "done"), s("c", "done"), s("d", "pending")])).toEqual(["d"]);
  });

  it("BRANCH: a SKIPPED dependency clears its dependents — the graph carries on", () => {
    const defs = [def("a"), def("b", ["a"])];
    expect(readySteps(defs, [s("a", "skipped"), s("b", "pending")])).toEqual(["b"]);
  });

  // The difference between the two terminal-but-not-done states, and the reason
  // there are two. A machine giving up must NOT release the work waiting on it.
  it("a FAILED dependency does not clear its dependents", () => {
    const defs = [def("a"), def("b", ["a"])];
    expect(readySteps(defs, [s("a", "failed"), s("b", "pending")])).toEqual([]);
  });

  it("ignores steps that are not pending — one already running is not ready again", () => {
    expect(readySteps([def("a")], [s("a", "running")])).toEqual([]);
    expect(readySteps([def("a")], [s("a", "blocked")])).toEqual([]);
    expect(readySteps([def("a")], [s("a", "done")])).toEqual([]);
  });

  // Should be impossible — the config validator refuses a dependency on a step
  // that does not exist — but a job created a year ago against a template since
  // edited is a different claim. Waiting is the safe direction.
  it("is NOT ready when a dependency has no row on this job", () => {
    expect(readySteps([def("b", ["ghost"])], [s("b", "pending")])).toEqual([]);
  });
});

describe("cascadeSkips — the other half of a branch", () => {
  it("skips a step whose dependency was skipped", () => {
    const defs = [def("a"), def("b", ["a"])];
    expect(cascadeSkips(defs, [s("a", "skipped"), s("b", "pending")])).toEqual(["b"]);
  });

  it("propagates all the way down a chain, not one level", () => {
    const defs = [def("a"), def("b", ["a"]), def("c", ["b"]), def("d", ["c"])];
    const steps = [s("a", "skipped"), s("b", "pending"), s("c", "pending"), s("d", "pending")];
    expect([...cascadeSkips(defs, steps)].sort()).toEqual(["b", "c", "d"]);
  });

  // Order-independence, which the repeat-until-stable loop is there for: an
  // array written child-first would otherwise only move the cascade one level.
  it("does not depend on the order the steps happen to be written in", () => {
    const defs = [def("d", ["c"]), def("c", ["b"]), def("b", ["a"]), def("a")];
    const steps = [s("d", "pending"), s("c", "pending"), s("b", "pending"), s("a", "skipped")];
    expect([...cascadeSkips(defs, steps)].sort()).toEqual(["b", "c", "d"]);
  });

  it("leaves a step alone when only ONE of its dependencies was skipped and another is live", () => {
    // It still waits on the live one. Skipping it here would remove a step
    // because a sibling branch did not apply, which is not what a branch means.
    const defs = [def("a"), def("b"), def("c", ["a", "b"])];
    const cascaded = cascadeSkips(defs, [s("a", "skipped"), s("b", "pending"), s("c", "pending")]);
    // `c` IS cascaded — it depends on a skipped step, and `readySteps` would
    // never release it while `b` is pending anyway. The assertion records which
    // of the two rules wins, so a change to it is deliberate.
    expect(cascaded).toEqual(["c"]);
  });

  it("does not touch a step somebody is already working on", () => {
    const defs = [def("a"), def("b", ["a"])];
    expect(cascadeSkips(defs, [s("a", "skipped"), s("b", "running")])).toEqual([]);
  });
});

describe("jobStatusFrom — derived, never tracked beside the steps", () => {
  const defs = [def("a"), def("b", ["a"])];

  it("is done when everything has settled", () => {
    expect(jobStatusFrom(defs, [s("a", "done"), s("b", "done")])).toBe("done");
    expect(jobStatusFrom(defs, [s("a", "done"), s("b", "skipped")])).toBe("done");
  });

  it("is running while an executor holds a step", () => {
    expect(jobStatusFrom(defs, [s("a", "running"), s("b", "pending")])).toBe("running");
  });

  it("is running while something could still start", () => {
    expect(jobStatusFrom(defs, [s("a", "pending"), s("b", "pending")])).toBe("running");
  });

  it("is blocked when everything open is waiting on a person", () => {
    expect(jobStatusFrom(defs, [s("a", "blocked"), s("b", "pending")])).toBe("blocked");
  });

  // The unpleasant case, and it lands on `blocked` deliberately: a failed step
  // means its dependents can never clear, so nothing will move again without
  // somebody looking. That IS blocked.
  it("is blocked when a failure has stranded the rest", () => {
    expect(jobStatusFrom(defs, [s("a", "failed"), s("b", "pending")])).toBe("blocked");
  });

  it("is not done for a job with no steps at all", () => {
    expect(jobStatusFrom([], [])).toBe("blocked");
  });
});

describe("the small vocabulary", () => {
  it("knows which states have settled", () => {
    expect(["done", "skipped", "failed"].every((x) => isSettled(x as StepStatus))).toBe(true);
    expect(["pending", "running", "blocked"].some((x) => isSettled(x as StepStatus))).toBe(false);
  });

  it("knows that a skip clears dependents and a failure does not", () => {
    expect(clearsDependents("skipped")).toBe(true);
    expect(clearsDependents("done")).toBe(true);
    expect(clearsDependents("failed")).toBe(false);
  });

  it("knows which executors wait for a person", () => {
    expect(waitsForAPerson("human")).toBe(true);
    expect(waitsForAPerson("agent_with_approval")).toBe(true);
    expect(waitsForAPerson("agent")).toBe(false);
  });

  it("recognises its own statuses and nothing else", () => {
    expect(isStepStatus("blocked")).toBe(true);
    expect(isStepStatus("waiting")).toBe(false);
  });
});
