// The requests sweep's pure rules (F1.4): which steps ask, when a job's
// unpinned process is worth counting, and what one template comes to on one
// job today.
import { describe, expect, it } from "vitest";
import {
  awaitsPin,
  emptyReport,
  planAsks,
  templateKeysToAsk,
} from "../../src/domain/requests/model";
import type { PublishedRequestTemplate, RequestSubject } from "../../src/domain/requests/model";

const LIST: PublishedRequestTemplate = {
  versionId: "00000000-0000-4000-8000-0000000000e1",
  key: "monthly-close",
  template: {
    label: "Monthly close",
    items: [
      {
        key: "bank",
        label: "Bank statements",
        askKind: "document",
        documentKind: "books_input",
        sendOffsetDays: 0,
        dueOffsetDays: 5,
      },
      {
        key: "approve-pl",
        label: "Approve the draft P&L",
        askKind: "approval",
        documentKind: null,
        sendOffsetDays: 12,
        dueOffsetDays: 20,
      },
    ],
  },
};

function subject(over: Partial<RequestSubject> = {}): RequestSubject {
  return {
    jobId: "00000000-0000-4000-8000-0000000000b1",
    workItemId: "00000000-0000-4000-8000-0000000000d1",
    periodEnd: "2026-02-28",
    pinnedVersionId: "00000000-0000-4000-8000-0000000000f1",
    steps: [],
    asked: [],
    ...over,
  };
}

describe("templateKeysToAsk", () => {
  it("keeps step order, drops skipped and failed steps and steps naming nothing, and names each key once", () => {
    expect(
      templateKeysToAsk([
        { stepKey: "a", requestTemplateKey: "year-end", status: "skipped" },
        { stepKey: "b", requestTemplateKey: "monthly-close", status: null },
        { stepKey: "c", requestTemplateKey: null, status: "pending" },
        { stepKey: "d", requestTemplateKey: "payroll", status: "failed" },
        { stepKey: "e", requestTemplateKey: "monthly-close", status: "done" },
        { stepKey: "f", requestTemplateKey: "year-end", status: "blocked" },
      ]),
    ).toEqual(["monthly-close", "year-end"]);
  });

  it("is empty for a process that asks for nothing", () => {
    expect(templateKeysToAsk([])).toEqual([]);
  });
});

describe("awaitsPin", () => {
  it("is true only for an unpinned job whose period ends today or has ended", () => {
    const unpinned = subject({ pinnedVersionId: null });
    expect(awaitsPin(unpinned, "2026-02-27")).toBe(false);
    expect(awaitsPin(unpinned, "2026-02-28")).toBe(true);
    expect(awaitsPin(unpinned, "2026-03-01")).toBe(true);
    expect(awaitsPin(subject(), "2026-03-01")).toBe(false);
  });
});

describe("planAsks", () => {
  it("an offset-0 item is due on the period's last day itself; a leap-free February ends on the 28th", () => {
    const plan = planAsks(subject(), LIST, "2026-02-28");
    expect(plan.toRaise.map((a) => [a.template.itemKey, a.dueOn, a.overdue])).toEqual([
      ["bank", "2026-03-05", false],
    ]);
    expect(plan.alreadyAsked).toBe(0);
  });

  it("carries what the client reads and the version the ask pins", () => {
    const [ask] = planAsks(subject(), LIST, "2026-03-12").toRaise.slice(1);
    expect(ask).toEqual({
      workItemId: "00000000-0000-4000-8000-0000000000d1",
      prompt: "Approve the draft P&L",
      askKind: "approval",
      documentKind: null,
      dueOn: "2026-03-20",
      template: {
        versionId: "00000000-0000-4000-8000-0000000000e1",
        templateKey: "monthly-close",
        itemKey: "approve-pl",
      },
      overdue: false,
    });
  });

  it("an item already asked is counted only once its send day has come", () => {
    const asked = subject({
      asked: [
        { templateKey: "monthly-close", itemKey: "bank" },
        { templateKey: "monthly-close", itemKey: "approve-pl" },
      ],
    });
    expect(planAsks(asked, LIST, "2026-03-01")).toEqual({ toRaise: [], alreadyAsked: 1 });
    expect(planAsks(asked, LIST, "2026-03-12")).toEqual({ toRaise: [], alreadyAsked: 2 });
  });

  it("is overdue strictly after the due day, never on it", () => {
    expect(planAsks(subject(), LIST, "2026-03-05").toRaise[0]?.overdue).toBe(false);
    expect(planAsks(subject(), LIST, "2026-03-06").toRaise[0]?.overdue).toBe(true);
  });
});

describe("emptyReport", () => {
  it("is every count at zero and no failure", () => {
    expect(emptyReport("t")).toEqual({
      tenantId: "t",
      raised: 0,
      alreadyRaised: 0,
      overdueOnRaise: 0,
      noTemplate: 0,
      awaitingPin: 0,
    });
  });
});
