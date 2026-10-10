// A process step names the request template its job asks the client for (F1.2):
// `WorkflowStep.requestTemplateKey`, a config KEY read live. Absent and null
// both mean the step asks for nothing — every process published before the
// field existed is frozen and must go on reading exactly as it did.
import { describe, expect, it } from "vitest";
import { readWorkflowTemplate, validateBody } from "../../src/domain/config/model";

/** A two-step monthly process; the second step carries whatever is given. */
function body(requestTemplateKey?: unknown): Record<string, unknown> {
  const collect: Record<string, unknown> = {
    key: "collect",
    label: "Collect the month's papers",
    executor: "human",
    dependsOn: [],
    condition: null,
    verificationPolicyKey: null,
    performer: null,
  };
  if (requestTemplateKey !== undefined) collect["requestTemplateKey"] = requestTemplateKey;
  const reconcile = {
    key: "reconcile",
    label: "Reconcile",
    executor: "human",
    dependsOn: ["collect"],
    condition: null,
    verificationPolicyKey: null,
    performer: null,
  };
  return { label: "Monthly accounting", steps: [collect, reconcile] };
}

const check = (key?: unknown): string | null => validateBody("workflow_template", body(key));

describe("a step's request template", () => {
  it("is optional: a step without the field is valid and reads as null", () => {
    expect(check()).toBeNull();
    const steps = readWorkflowTemplate(body())?.steps;
    expect(steps?.[0]?.requestTemplateKey).toBeNull();
    // The step that never mentioned it at all, the shape of every frozen body.
    expect(steps?.[1]?.requestTemplateKey).toBeNull();
  });

  it("accepts null, which is how the editor says 'asks for nothing'", () => {
    expect(check(null)).toBeNull();
    expect(readWorkflowTemplate(body(null))?.steps[0]?.requestTemplateKey).toBeNull();
  });

  it("accepts a config key and reads it back as written", () => {
    for (const key of ["monthly-close", "quarterly_vat", "close"]) {
      expect(check(key), key).toBeNull();
      expect(readWorkflowTemplate(body(key))?.steps[0]?.requestTemplateKey).toBe(key);
    }
  });

  it("refuses anything that is not a config key, naming the step and the value", () => {
    for (const bad of ["Monthly Close", "monthly--close", "-close", "", `a${"b".repeat(64)}`, 7, true, ["monthly-close"]]) {
      const problem = check(bad);
      expect(problem, JSON.stringify(bad)).toContain("steps[0].requestTemplateKey must be the key of a request_template");
      expect(problem).toContain("or null for a step that asks the client for nothing");
    }
    expect(check("Monthly Close")).toContain('Got "Monthly Close"');
  });

  it("checks shape only: a key nobody has published yet is accepted at the write", () => {
    // Read live when a job reaches the step; a firm may write its process
    // before its list, and a frozen body must outlive the template it names.
    expect(check("not-written-yet")).toBeNull();
  });

  it("an unreadable key makes the whole body unreadable, as every other step field does", () => {
    expect(readWorkflowTemplate(body("Not A Key"))).toBeNull();
  });
});
