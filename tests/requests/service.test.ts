// The requests sweep (F1.4) — the rules that decide what a client is asked for,
// and when.
//
// The open-task choice, the anti-join across a job's tasks, the pinned body and
// 0385's unique index are database properties and are proven against real
// Postgres in `tests/requests/sweep.integration.test.ts`. What is here is the
// arithmetic and the refusals: which items are due, which steps ask, whose day
// "today" is, and what the sweep is NOT allowed to hold.
import { describe, expect, it } from "vitest";
import { RequestSweepService } from "../../src/usecase/requests/service";
import type { RequestSubject, PublishedRequestTemplate } from "../../src/domain/requests/model";
import { requestDates } from "../../src/domain/config/model";
import type { RequestTemplateItem } from "../../src/domain/config/model";
import {
  FakePublishedRequestTemplates,
  FakeRequestSubjects,
  FakeRequestTenants,
  FakeTemplateAskRaiser,
} from "../../src/testfakes/requests";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { ClientAskService } from "../../src/usecase/clientask/service";
import {
  FakeAskRepo,
  FakeAskScope,
  FakeAskStore,
  FakePortalAskRepo,
} from "../../src/testfakes/clientask";
import { FakeBlobStore, FakeContentDigest } from "../../src/testfakes/filestore";
import type { StepStatus } from "../../src/domain/orchestrator/model";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const JOB = "00000000-0000-4000-8000-0000000000b1";
const TASK = "00000000-0000-4000-8000-0000000000d1";
const PROCESS = "00000000-0000-4000-8000-0000000000f1";
const LIST_V1 = "00000000-0000-4000-8000-0000000000e1";
const COBALT = "00000000-0000-4000-8000-0000000000c1";

const SALES: RequestTemplateItem = {
  key: "sales",
  label: "Sales invoices for the month",
  askKind: "document",
  documentKind: "books_input",
  sendOffsetDays: 1,
  dueOffsetDays: 5,
};
const NO_CASH: RequestTemplateItem = {
  key: "no-cash",
  label: "Confirm there were no cash sales",
  askKind: "question",
  documentKind: null,
  sendOffsetDays: 1,
  dueOffsetDays: 5,
};
const PAYROLL: RequestTemplateItem = {
  key: "payroll",
  label: "Payroll register",
  askKind: "document",
  documentKind: "books_input",
  sendOffsetDays: 10,
  dueOffsetDays: 15,
};

const MONTHLY_CLOSE: PublishedRequestTemplate = {
  versionId: LIST_V1,
  key: "monthly-close",
  template: { label: "Monthly close", items: [SALES, NO_CASH, PAYROLL] },
};

function step(
  stepKey: string,
  requestTemplateKey: string | null,
  status: StepStatus | null = null,
): RequestSubject["steps"][number] {
  return { stepKey, requestTemplateKey, status };
}

function subject(over: Partial<RequestSubject> = {}): RequestSubject {
  return {
    jobId: JOB,
    workItemId: TASK,
    periodEnd: "2025-10-31",
    pinnedVersionId: PROCESS,
    steps: [step("collect", "monthly-close")],
    asked: [],
    ...over,
  };
}

function svc(opts: { now?: string; zone?: string; tenants?: readonly string[] } = {}) {
  const subjects = new FakeRequestSubjects();
  const templates = new FakePublishedRequestTemplates().publish(TENANT, MONTHLY_CLOSE);
  const asks = new FakeTemplateAskRaiser();
  const clock = new FakeClock(new Date(opts.now ?? "2025-11-01T06:00:00.000Z"));
  const service = new RequestSweepService({
    tenants: new FakeRequestTenants(opts.tenants ?? [TENANT]),
    timeZones: new FakeFirmTimeZone(opts.zone ?? "UTC"),
    subjects,
    templates,
    asks,
    clock,
  });
  return { service, subjects, templates, asks, clock };
}

const itemKeys = (asks: FakeTemplateAskRaiser): string[] =>
  asks.raised.map((a) => a.template.itemKey);

describe("an item is asked on its send day, and not before", () => {
  it("raises nothing before the send day", async () => {
    // October, send 1: asked on 1 November. On 31 October nothing is due.
    const { service, subjects, asks } = svc({ now: "2025-10-31T12:00:00.000Z" });
    subjects.add(TENANT, subject());
    const [report] = await service.sweep();
    expect(asks.calls).toEqual([]);
    expect(report).toMatchObject({ raised: 0, alreadyRaised: 0, overdueOnRaise: 0 });
  });

  it("raises it ON the send day, and an item with a later send day waits for its own", async () => {
    const { service, subjects, asks } = svc({ now: "2025-11-01T06:00:00.000Z" });
    subjects.add(TENANT, subject());
    const [report] = await service.sweep();
    expect(itemKeys(asks)).toEqual(["sales", "no-cash"]);
    expect(report).toMatchObject({ tenantId: TENANT, raised: 2, alreadyRaised: 0, overdueOnRaise: 0 });
  });

  it("raises it after the send day too", async () => {
    const { service, subjects, asks } = svc({ now: "2025-11-12T06:00:00.000Z" });
    subjects.add(TENANT, subject());
    const [report] = await service.sweep();
    expect(itemKeys(asks)).toEqual(["sales", "no-cash", "payroll"]);
    expect(report?.raised).toBe(3);
  });

  it("hands the raiser the item's own words, kinds, due day and the version it came from", async () => {
    const { service, subjects, asks } = svc();
    subjects.add(TENANT, subject());
    await service.sweep();
    expect(asks.calls).toEqual([
      {
        tenantId: TENANT,
        workItemId: TASK,
        prompt: "Sales invoices for the month",
        askKind: "document",
        documentKind: "books_input",
        // requestDates' own answer, never a day the sweep worked out itself.
        dueOn: requestDates("2025-10-31", SALES).dueOn,
        template: { versionId: LIST_V1, templateKey: "monthly-close", itemKey: "sales" },
      },
      {
        tenantId: TENANT,
        workItemId: TASK,
        prompt: "Confirm there were no cash sales",
        askKind: "question",
        documentKind: null,
        dueOn: requestDates("2025-10-31", NO_CASH).dueOn,
        template: { versionId: LIST_V1, templateKey: "monthly-close", itemKey: "no-cash" },
      },
    ]);
    expect(asks.calls.map((c) => c.dueOn)).toEqual(["2025-11-05", "2025-11-05"]);
  });
});

describe("once per item per job", () => {
  it("a second pass raises nothing, and says the items were already asked", async () => {
    // The unique index's answer, `created: false`: a redelivered message or the
    // next morning's run.
    const { service, subjects, asks } = svc();
    subjects.add(TENANT, subject());
    const [first] = await service.sweep();
    const [second] = await service.sweep();
    expect(first).toMatchObject({ raised: 2, alreadyRaised: 0 });
    expect(second).toMatchObject({ raised: 0, alreadyRaised: 2 });
    expect(asks.raised).toHaveLength(2);
  });

  it("an item the job already asked for (the read's answer) is counted and never offered again", async () => {
    const { service, subjects, asks } = svc();
    subjects.add(TENANT, subject({ asked: [{ templateKey: "monthly-close", itemKey: "sales" }] }));
    const [report] = await service.sweep();
    expect(asks.calls.map((c) => c.template.itemKey)).toEqual(["no-cash"]);
    expect(report).toMatchObject({ raised: 1, alreadyRaised: 1 });
  });

  it("an item asked from ANOTHER template with the same item key is not this one", async () => {
    const { service, subjects, asks } = svc();
    subjects.add(TENANT, subject({ asked: [{ templateKey: "quarter-close", itemKey: "sales" }] }));
    await service.sweep();
    expect(itemKeys(asks)).toEqual(["sales", "no-cash"]);
  });
});

describe("which steps ask", () => {
  it("a SKIPPED step asks for nothing", async () => {
    const { service, subjects, asks } = svc();
    subjects.add(TENANT, subject({ steps: [step("collect", "monthly-close", "skipped")] }));
    const [report] = await service.sweep();
    expect(asks.calls).toEqual([]);
    expect(report).toMatchObject({ raised: 0, noTemplate: 0 });
  });

  it("a FAILED step asks for nothing", async () => {
    const { service, subjects, asks } = svc();
    subjects.add(TENANT, subject({ steps: [step("collect", "monthly-close", "failed")] }));
    await service.sweep();
    expect(asks.calls).toEqual([]);
  });

  it("every other state asks, and so does a step with no row yet", async () => {
    for (const status of ["pending", "running", "blocked", "done", null] as const) {
      const { service, subjects, asks } = svc();
      subjects.add(TENANT, subject({ steps: [step("collect", "monthly-close", status)] }));
      await service.sweep();
      expect(itemKeys(asks), String(status)).toEqual(["sales", "no-cash"]);
    }
  });

  it("two steps naming one template ask once, and one skipped does not stop the other", async () => {
    const { service, subjects, asks, templates } = svc();
    subjects.add(
      TENANT,
      subject({
        steps: [
          step("collect", "monthly-close", "skipped"),
          step("chase", "monthly-close", "pending"),
        ],
      }),
    );
    const [report] = await service.sweep();
    expect(itemKeys(asks)).toEqual(["sales", "no-cash"]);
    expect(report?.raised).toBe(2);
    expect(templates.lookups).toHaveLength(1);
  });

  it("a step that names no template asks for nothing", async () => {
    const { service, subjects, asks, templates } = svc();
    subjects.add(TENANT, subject({ steps: [step("reconcile", null), step("review", null)] }));
    const [report] = await service.sweep();
    expect(asks.calls).toEqual([]);
    expect(templates.lookups).toEqual([]);
    expect(report).toMatchObject({ raised: 0, noTemplate: 0, awaitingPin: 0 });
  });
});

describe("a step naming a template nobody published", () => {
  it("is counted as noTemplate, and nothing is asked for it", async () => {
    const { service, subjects, asks } = svc();
    subjects.add(TENANT, subject({ steps: [step("collect", "year-end-pack")] }));
    const [report] = await service.sweep();
    expect(asks.calls).toEqual([]);
    expect(report).toMatchObject({ raised: 0, noTemplate: 1 });
  });

  it("does not stop the same job's other step asking from a template that IS published", async () => {
    const { service, subjects, asks } = svc();
    subjects.add(
      TENANT,
      subject({ steps: [step("collect", "year-end-pack"), step("chase", "monthly-close")] }),
    );
    const [report] = await service.sweep();
    expect(itemKeys(asks)).toEqual(["sales", "no-cash"]);
    expect(report).toMatchObject({ raised: 2, noTemplate: 1 });
  });

  it("the registry is asked once per key per firm per pass, however many jobs name it", async () => {
    const { service, subjects, templates } = svc();
    for (const n of [1, 2, 3]) {
      subjects.add(
        TENANT,
        subject({
          jobId: `00000000-0000-4000-8000-0000000000b${String(n)}`,
          workItemId: `00000000-0000-4000-8000-0000000000d${String(n)}`,
          steps: [step("collect", "monthly-close"), step("extra", "year-end-pack")],
        }),
      );
    }
    const [report] = await service.sweep();
    expect(templates.lookups.map((l) => l.key).sort()).toEqual(["monthly-close", "year-end-pack"]);
    expect(report).toMatchObject({ raised: 6, noTemplate: 3 });
    // A new pass asks again: a template published since must be seen.
    await service.sweep();
    expect(templates.lookups).toHaveLength(4);
  });
});

describe("a job whose process is not pinned yet", () => {
  it("is counted as awaitingPin once its period has ended, and asks nothing", async () => {
    const { service, subjects, asks, templates } = svc({ now: "2025-11-02T06:00:00.000Z" });
    subjects.add(TENANT, subject({ pinnedVersionId: null, steps: [] }));
    const [report] = await service.sweep();
    expect(asks.calls).toEqual([]);
    expect(templates.lookups).toEqual([]);
    expect(report).toMatchObject({ raised: 0, awaitingPin: 1 });
  });

  it("is counted on its period's LAST day too — the S7 caveat, where an offset-0 item waits a pass", async () => {
    const { service, subjects } = svc({ now: "2025-10-31T06:00:00.000Z" });
    subjects.add(TENANT, subject({ pinnedVersionId: null, steps: [] }));
    const [report] = await service.sweep();
    expect(report?.awaitingPin).toBe(1);
  });

  it("is not counted at a firm that has published no request template: nothing could be asked", async () => {
    // The orchestrator already says the job waits for its process; saying it
    // again here, every morning, about asks that cannot exist is noise.
    const { service, subjects, templates } = svc({ tenants: [OTHER], now: "2025-11-02T06:00:00.000Z" });
    subjects.add(OTHER, subject({ pinnedVersionId: null, steps: [] }));
    subjects.add(OTHER, subject({ jobId: "00000000-0000-4000-8000-0000000000b2", pinnedVersionId: null, steps: [] }));
    const [report] = await service.sweep();
    expect(report).toMatchObject({ tenantId: OTHER, raised: 0, awaitingPin: 0 });
    expect(templates.lookups).toEqual([]);
  });

  it("is not counted while its period is still running: nothing could be due", async () => {
    const { service, subjects } = svc({ now: "2025-11-12T06:00:00.000Z" });
    subjects.add(TENANT, subject({ periodEnd: "2025-11-30", pinnedVersionId: null, steps: [] }));
    const [report] = await service.sweep();
    expect(report?.awaitingPin).toBe(0);
  });

  it("is asked on the next pass, once pinned", async () => {
    const { service, subjects, asks } = svc();
    subjects.set(TENANT, [subject({ pinnedVersionId: null, steps: [] })]);
    const [before] = await service.sweep();
    expect(asks.calls).toEqual([]);
    expect(before?.awaitingPin).toBe(1);
    // The orchestrator pins it between passes.
    subjects.set(TENANT, [subject()]);
    const [after] = await service.sweep();
    expect(itemKeys(asks)).toEqual(["sales", "no-cash"]);
    expect(after).toMatchObject({ raised: 2, awaitingPin: 0 });
  });
});

describe("today is the FIRM's day", () => {
  it("a firm in Singapore at 2025-10-31T17:00Z is already on 1 November: asked", async () => {
    const { service, subjects, asks } = svc({ now: "2025-10-31T17:00:00.000Z", zone: "Asia/Singapore" });
    subjects.add(TENANT, subject());
    const [report] = await service.sweep();
    expect(itemKeys(asks)).toEqual(["sales", "no-cash"]);
    expect(report?.raised).toBe(2);
  });

  it("the same instant at a firm on UTC is still 31 October: not yet", async () => {
    const { service, subjects, asks } = svc({ now: "2025-10-31T17:00:00.000Z", zone: "UTC" });
    subjects.add(TENANT, subject());
    await service.sweep();
    expect(asks.calls).toEqual([]);
  });

  it("and a firm west of Greenwich is still on 31 October after midnight UTC", async () => {
    const { service, subjects, asks } = svc({ now: "2025-11-01T03:00:00.000Z", zone: "America/New_York" });
    subjects.add(TENANT, subject());
    await service.sweep();
    expect(asks.calls).toEqual([]);
  });
});

describe("the backlog: a job left open from an earlier period", () => {
  it("asks with the firm's own due day, already past, and counts it as overdueOnRaise", async () => {
    const { service, subjects, asks } = svc({ now: "2025-11-01T06:00:00.000Z" });
    subjects.add(TENANT, subject({ periodEnd: "2025-08-31" }));
    const [report] = await service.sweep();
    expect(asks.calls.map((c) => [c.template.itemKey, c.dueOn])).toEqual([
      ["sales", "2025-09-05"],
      ["no-cash", "2025-09-05"],
      ["payroll", "2025-09-15"],
    ]);
    expect(report).toMatchObject({ raised: 3, overdueOnRaise: 3 });
  });

  it("counts only the asks whose due day has passed, and not one due today", async () => {
    // October's asks are due 5 November; on the 5th they are due TODAY, which
    // is not past. August's are.
    const { service, subjects } = svc({ now: "2025-11-05T06:00:00.000Z" });
    subjects.add(TENANT, subject());
    subjects.add(
      TENANT,
      subject({
        jobId: "00000000-0000-4000-8000-0000000000b2",
        workItemId: "00000000-0000-4000-8000-0000000000d2",
        periodEnd: "2025-08-31",
      }),
    );
    const [report] = await service.sweep();
    expect(report).toMatchObject({ raised: 5, overdueOnRaise: 3 });
  });

  it("an ask refused as already raised is not counted as overdue", async () => {
    const { service, subjects } = svc();
    subjects.add(TENANT, subject({ periodEnd: "2025-08-31" }));
    await service.sweep();
    const [second] = await service.sweep();
    expect(second).toMatchObject({ raised: 0, alreadyRaised: 3, overdueOnRaise: 0 });
  });
});

describe("one firm's failure", () => {
  it("is reported, and the firms after it are still asked", async () => {
    const { service, subjects, templates, asks } = svc({ tenants: [OTHER, TENANT] });
    templates.publish(OTHER, MONTHLY_CLOSE);
    subjects.fail(OTHER, "the read fell over");
    subjects.add(TENANT, subject());
    const reports = await service.sweep();
    expect(reports).toEqual([
      {
        tenantId: OTHER,
        raised: 0,
        alreadyRaised: 0,
        overdueOnRaise: 0,
        noTemplate: 0,
        awaitingPin: 0,
        failure: "the read fell over",
      },
      { tenantId: TENANT, raised: 2, alreadyRaised: 0, overdueOnRaise: 0, noTemplate: 0, awaitingPin: 0 },
    ]);
    expect(asks.raised.every((a) => a.tenantId === TENANT)).toBe(true);
  });

  it("a firm with nothing published and no jobs reports zeros, not a failure", async () => {
    const { service } = svc({ tenants: [OTHER] });
    expect(await service.sweep()).toEqual([
      { tenantId: OTHER, raised: 0, alreadyRaised: 0, overdueOnRaise: 0, noTemplate: 0, awaitingPin: 0 },
    ]);
  });
});

describe("what the sweep may hold", () => {
  it("reads, one raise and a clock: no mailer, nothing that could close an ask or move a task", () => {
    // The chaser's test, for the chaser's reason. A new name in this list is a
    // decision somebody writes down here.
    const wired = ["tenants", "timeZones", "subjects", "templates", "asks", "clock"];
    const actual = Object.keys(
      (svc().service as unknown as { deps: Record<string, unknown> }).deps,
    ).sort();
    expect(actual).toEqual([...wired].sort());
  });
});

describe("through the real ask module", () => {
  // The sweep's raiser in production is `ClientAskService` itself, satisfying
  // the port structurally. Here it runs over the ask module's own fakes, so
  // what the sweep hands over is checked by the code that writes the ask.
  function realAsks() {
    const store = new FakeAskStore().workItem(TASK, COBALT, "Monthly Accounting · Oct 2025");
    const events = new RecordingEventSink();
    const asks = new ClientAskService({
      asks: new FakeAskRepo(store),
      portal: new FakePortalAskRepo(store),
      scope: new FakeAskScope(),
      blobs: new FakeBlobStore(),
      digest: new FakeContentDigest(),
      ids: new FakeIds(),
      events,
      clock: new FakeClock(new Date("2025-11-01T06:00:00.000Z")),
      timeZones: new FakeFirmTimeZone("UTC"),
      maxUploadBytes: 1_000_000,
    });
    const subjects = new FakeRequestSubjects().add(TENANT, subject());
    const service = new RequestSweepService({
      tenants: new FakeRequestTenants([TENANT]),
      timeZones: new FakeFirmTimeZone("UTC"),
      subjects,
      templates: new FakePublishedRequestTemplates().publish(TENANT, MONTHLY_CLOSE),
      asks,
      clock: new FakeClock(new Date("2025-11-01T06:00:00.000Z")),
    });
    return { service, store, events };
  }

  it("raises each ask once, with the firm's day and the template it came from, and one event each", async () => {
    const { service, store, events } = realAsks();
    const [first] = await service.sweep();
    const [second] = await service.sweep();
    expect(first).toMatchObject({ raised: 2 });
    expect(second).toMatchObject({ raised: 0, alreadyRaised: 2 });
    expect(store.asks.map((a) => [a.prompt, a.dueOn, a.clientPartyId, a.raisedBy])).toEqual([
      ["Sales invoices for the month", "2025-11-05", COBALT, null],
      ["Confirm there were no cash sales", "2025-11-05", COBALT, null],
    ]);
    expect(store.asks.map((a) => a.fromTemplate)).toEqual([
      { versionId: LIST_V1, templateKey: "monthly-close", itemKey: "sales" },
      { versionId: LIST_V1, templateKey: "monthly-close", itemKey: "no-cash" },
    ]);
    // `client_ask.raised` is the ask module's to write, once per row created,
    // as the SYSTEM.
    const raised = events.recorded.filter((e) => e.verb === "client_ask.raised");
    expect(raised).toHaveLength(2);
    expect(raised.every((e) => e.actorType === "system")).toBe(true);
  });
});
