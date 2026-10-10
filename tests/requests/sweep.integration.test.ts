// The requests sweep (F1.4) against real Postgres.
//
// `tests/requests/service.test.ts` proves the rules over fakes. What only a real
// database can say is here:
//
//   · THE READ. Period jobs that are not done or cancelled, each on ONE open
//     task (the state's FLAG, never its code), with the steps of the PINNED
//     body (read by version id, the orchestrator's resolved template does not
//     carry the key) and each step's `job_step` status, and the items already
//     asked on ANY task of the job.
//   · THE ASK. Through the real `ClientAskService` and its adapter: the row
//     carries the template's own due day, prompt, kinds and the three template
//     columns, `raised_by` null, the client read from the task.
//   · ONCE. A second pass writes nothing and records nothing; a merged job whose
//     first task finishes does not ask again on its second.
//   · THE FIRM'S DAY. The firm keeps Asia/Kolkata: 19:00 UTC on 31 October is
//     already 1 November there, and the items are asked; at 17:00 UTC they are
//     not. The zone is read from `tenancy.tenant` by the real adapter.
//
// The sweep is handed ONE firm, its own, so nothing it does can reach another
// firm's rows in the shared database.
//
// Run with:  npm run test:integration
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { RequestSweepService } from "../../src/usecase/requests/service";
import {
  PostgresPublishedRequestTemplates,
  PostgresRequestSubjects,
} from "../../src/infrastructure/postgres/request-sweep-repository";
import { PostgresFirmTimeZone } from "../../src/infrastructure/postgres/firm-timezone-repository";
import { PostgresClientAskRepository } from "../../src/infrastructure/postgres/client-ask-repository";
import { PostgresPortalAskRepository } from "../../src/infrastructure/postgres/portal-ask-repository";
import { ClientAskService } from "../../src/usecase/clientask/service";
import { FakeAskScope } from "../../src/testfakes/clientask";
import { FakeBlobStore, FakeContentDigest } from "../../src/testfakes/filestore";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { FakeClock } from "../../src/testfakes/clock";
import { systemIds } from "../../src/platform/ids";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 3 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const stamp = Date.now().toString(36);
const LIST_KEY = `monthly-close-${stamp}`;
const MISSING_KEY = `year-end-${stamp}`;
const DRAFT_KEY = `draft-list-${stamp}`;

let tenantId = "";
let client = "";
let openState = "";
let doneState = "";
let priority = "";
let processVersion = "";
let missingProcessVersion = "";
let listVersion = "";

/** The jobs, by what each one is for. */
const job: Record<
  "oct" | "sep" | "aug" | "unpinned" | "nov" | "doneTask" | "cancelled" | "noList" | "merged",
  string
> = { oct: "", sep: "", aug: "", unpinned: "", nov: "", doneTask: "", cancelled: "", noList: "", merged: "" };
/** Their tasks. `merged1` is the older of the merged job's two. */
const task: Record<
  "oct" | "sep" | "aug" | "unpinned" | "nov" | "doneTask" | "cancelled" | "noList" | "merged1" | "merged2",
  string
> = {
  oct: "",
  sep: "",
  aug: "",
  unpinned: "",
  nov: "",
  doneTask: "",
  cancelled: "",
  noList: "",
  merged1: "",
  merged2: "",
};

const events = new RecordingEventSink();
const clock = new FakeClock(new Date("2025-10-31T17:00:00.000Z"));

const sweep = new RequestSweepService({
  tenants: { activeTenantIds: () => Promise.resolve([tenantId]) },
  timeZones: new PostgresFirmTimeZone(app),
  subjects: new PostgresRequestSubjects(app),
  templates: new PostgresPublishedRequestTemplates(app),
  asks: new ClientAskService({
    asks: new PostgresClientAskRepository(app),
    portal: new PostgresPortalAskRepository(app),
    scope: new FakeAskScope(),
    blobs: new FakeBlobStore(),
    digest: new FakeContentDigest(),
    ids: systemIds,
    events,
    clock,
    timeZones: new PostgresFirmTimeZone(app),
    maxUploadBytes: 1_000_000,
  }),
  clock,
});

async function config(
  kind: string,
  key: string,
  status: "published" | "draft",
  body: Parameters<typeof owner.json>[0],
): Promise<string> {
  const [entry] = await owner<{ id: string }[]>`
    INSERT INTO config.entry (tenant_id, kind, key)
    VALUES (${tenantId}, ${kind}, ${key}) RETURNING id
  `;
  if (!entry) throw new Error(`could not create the ${kind} entry ${key}`);
  const [version] = await owner<{ id: string }[]>`
    INSERT INTO config.version (tenant_id, entry_id, version, status, body, published_at)
    VALUES (${tenantId}, ${entry.id}, 1, ${status}, ${owner.json(body)},
            ${status === "published" ? owner`now()` : null})
    RETURNING id
  `;
  if (!version) throw new Error(`could not create the ${kind} version ${key}`);
  return version.id;
}

/** A period job, in the shape the scheduler's per-period spawn writes. */
async function periodJob(
  periodStart: string,
  periodEnd: string,
  pinned: string | null,
  status: "pending" | "running" | "cancelled" = pinned === null ? "pending" : "running",
): Promise<string> {
  const id = randomUUID();
  await owner`
    INSERT INTO delivery.job
      (id, tenant_id, source_kind, source_ref, status, template_version_id,
       started_at, finished_at, period_start, period_end, period_label)
    VALUES (${id}, ${tenantId}, 'engagement_period', ${randomUUID()}, ${status}, ${pinned},
            ${status === "pending" ? null : owner`now()`},
            ${status === "cancelled" ? owner`now()` : null},
            ${periodStart}::date, ${periodEnd}::date, ${`P ${periodEnd}`})
  `;
  return id;
}

async function periodTask(jobId: string, title: string, opts: { done?: boolean; age?: string } = {}): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item
      (tenant_id, client_party_id, job_id, title, state_id, priority_id, is_client_visible,
       completed_at, created_at)
    VALUES (${tenantId}, ${client}, ${jobId}, ${title},
            ${opts.done === true ? doneState : openState}, ${priority}, true,
            ${opts.done === true ? owner`now()` : null},
            now() - ${opts.age ?? "0 minutes"}::interval)
    RETURNING id
  `;
  if (!row) throw new Error(`could not create the task ${title}`);
  return row.id;
}

async function jobStep(jobId: string, stepKey: string, status: "pending" | "skipped"): Promise<void> {
  await owner`
    INSERT INTO delivery.job_step (tenant_id, job_id, step_key, label, executor, status, outcome_note)
    VALUES (${tenantId}, ${jobId}, ${stepKey}, ${stepKey}, 'human', ${status},
            ${status === "skipped" ? "Not this month: the client sent everything with the return." : null})
  `;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, time_zone)
    VALUES (${`requests-${stamp}`}, 'Requests Sweep Test', 'INR', 'Asia/Kolkata') RETURNING id
  `;
  if (!t) throw new Error("could not create the test firm");
  tenantId = t.id;

  const [c] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenantId}, 'organization', ${`Cobalt Foods ${stamp}`}) RETURNING id
  `;
  const [open] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_state (tenant_id, code, name, is_initial, sort_order)
    VALUES (${tenantId}, 'open', 'Open', true, 10) RETURNING id
  `;
  // A SUCCESSFUL TERMINAL STATE: the "no open task" case needs one, and
  // `calendar.integration.test.ts` asks every firm in the catalogue for one.
  const [done] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_state (tenant_id, code, name, is_terminal, is_success, sort_order)
    VALUES (${tenantId}, 'completed', 'Completed', true, true, 90) RETURNING id
  `;
  const [p] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_priority (tenant_id, code, name, rank, is_default)
    VALUES (${tenantId}, 'normal', 'Normal', 20, true) RETURNING id
  `;
  if (!c || !open || !done || !p) throw new Error("could not seed the firm");
  client = c.id;
  openState = open.id;
  doneState = done.id;
  priority = p.id;

  // The firm's monthly list, PUBLISHED, and one still in DRAFT.
  const items = [
    { key: "sales", label: "Sales invoices for the month", askKind: "document", documentKind: "books_input", sendOffsetDays: 1, dueOffsetDays: 5 },
    { key: "no-cash", label: "Confirm there were no cash sales", askKind: "question", documentKind: null, sendOffsetDays: 1, dueOffsetDays: 5 },
    { key: "late", label: "Confirm the closing stock count", askKind: "question", documentKind: null, sendOffsetDays: 20, dueOffsetDays: 30 },
  ];
  listVersion = await config("request_template", LIST_KEY, "published", { label: "Monthly close", items });
  await config("request_template", DRAFT_KEY, "draft", { label: "Still being written", items });

  // The process whose first step asks for the list, and one naming a list
  // nobody published.
  const process = (requestTemplateKey: string) => ({
    label: "Monthly accounting",
    steps: [
      { key: "collect", label: "Collect the month's records", executor: "human", dependsOn: [], requestTemplateKey },
      { key: "reconcile", label: "Reconcile", executor: "human", dependsOn: ["collect"] },
    ],
  });
  processVersion = await config("workflow_template", `monthly-accounting-${stamp}`, "published", process(LIST_KEY));
  missingProcessVersion = await config("workflow_template", `year-end-close-${stamp}`, "published", process(MISSING_KEY));

  job.oct = await periodJob("2025-10-01", "2025-10-31", processVersion);
  task.oct = await periodTask(job.oct, "Monthly Accounting · Oct 2025");
  await jobStep(job.oct, "collect", "pending");
  await jobStep(job.oct, "reconcile", "pending");

  job.sep = await periodJob("2025-09-01", "2025-09-30", processVersion);
  task.sep = await periodTask(job.sep, "Monthly Accounting · Sep 2025");
  await jobStep(job.sep, "collect", "skipped");

  // August, still open in November: the backlog. No step rows at all.
  job.aug = await periodJob("2025-08-01", "2025-08-31", processVersion);
  task.aug = await periodTask(job.aug, "Monthly Accounting · Aug 2025");

  job.unpinned = await periodJob("2025-10-01", "2025-10-31", null);
  task.unpinned = await periodTask(job.unpinned, "Bookkeeping · Oct 2025");

  job.nov = await periodJob("2025-11-01", "2025-11-30", null);
  task.nov = await periodTask(job.nov, "Monthly Accounting · Nov 2025");

  job.doneTask = await periodJob("2025-10-01", "2025-10-31", processVersion);
  task.doneTask = await periodTask(job.doneTask, "Payroll · Oct 2025", { done: true });

  job.cancelled = await periodJob("2025-10-01", "2025-10-31", processVersion, "cancelled");
  task.cancelled = await periodTask(job.cancelled, "Advisory · Oct 2025");

  job.noList = await periodJob("2025-10-01", "2025-10-31", missingProcessVersion);
  task.noList = await periodTask(job.noList, "Year-end close · Oct 2025");

  // One job merged over two engagements of one company: two open tasks.
  job.merged = await periodJob("2025-10-01", "2025-10-31", processVersion);
  task.merged1 = await periodTask(job.merged, "Accounting · Oct 2025", { age: "1 hour" });
  task.merged2 = await periodTask(job.merged, "Payroll · Oct 2025");
});

afterAll(async () => {
  // The published config versions cannot be deleted (0005's freeze), so the
  // firm stays: everything else goes, and the firm is SUSPENDED so no sweep in
  // the shared database ever visits it again.
  if (tenantId !== "") {
    await owner`DELETE FROM delivery.client_ask WHERE tenant_id = ${tenantId}`;
    await owner`DELETE FROM delivery.job_step WHERE tenant_id = ${tenantId}`;
    await owner`DELETE FROM delivery.work_item WHERE tenant_id = ${tenantId}`;
    await owner`DELETE FROM delivery.job WHERE tenant_id = ${tenantId}`;
    await owner`UPDATE tenancy.tenant SET status = 'suspended' WHERE id = ${tenantId}`;
  }
  await app.end();
  await owner.end();
});

interface AskRow {
  work_item_id: string;
  prompt: string;
  ask_kind: string;
  document_kind: string | null;
  due_on: string;
  request_template_version_id: string;
  request_template_key: string;
  request_item_key: string;
  raised_by: string | null;
  client_party_id: string;
  status: string;
}

async function asksOn(workItemId: string): Promise<AskRow[]> {
  return owner<AskRow[]>`
    SELECT work_item_id, prompt, ask_kind, document_kind, due_on::text AS due_on,
           request_template_version_id, request_template_key, request_item_key,
           raised_by, client_party_id, status
      FROM delivery.client_ask
     WHERE tenant_id = ${tenantId} AND work_item_id = ${workItemId}
     ORDER BY request_item_key
  `;
}

const raisedEvents = () => events.verbs().filter((v) => v === "client_ask.raised").length;

describe("the read", () => {
  it("offers each period job still owed once, on an open task, with its pinned steps", async () => {
    const subjects = await new PostgresRequestSubjects(app).periodJobs(tenantId);
    const byJob = new Map(subjects.map((s) => [s.jobId, s]));

    // Not offered: a job whose only task is finished, and a cancelled job.
    expect(byJob.has(job.doneTask)).toBe(false);
    expect(byJob.has(job.cancelled)).toBe(false);
    expect([...byJob.keys()].sort()).toEqual(
      [job.oct, job.sep, job.aug, job.unpinned, job.nov, job.noList, job.merged].sort(),
    );

    expect(byJob.get(job.oct)).toEqual({
      jobId: job.oct,
      workItemId: task.oct,
      periodEnd: "2025-10-31",
      pinnedVersionId: processVersion,
      steps: [
        { stepKey: "collect", requestTemplateKey: LIST_KEY, status: "pending" },
        { stepKey: "reconcile", requestTemplateKey: null, status: "pending" },
      ],
      asked: [],
    });
    // No step rows yet: null, which asks.
    expect(byJob.get(job.aug)?.steps[0]).toEqual({ stepKey: "collect", requestTemplateKey: LIST_KEY, status: null });
    expect(byJob.get(job.sep)?.steps[0]?.status).toBe("skipped");
    expect(byJob.get(job.unpinned)).toMatchObject({ pinnedVersionId: null, steps: [] });
    // The merged job is ONE subject, on its older task.
    expect(byJob.get(job.merged)?.workItemId).toBe(task.merged1);
  });

  it("reads a request template only when it is PUBLISHED", async () => {
    const templates = new PostgresPublishedRequestTemplates(app);
    const published = await templates.publishedByKey(tenantId, LIST_KEY);
    expect(published?.versionId).toBe(listVersion);
    expect(published?.key).toBe(LIST_KEY);
    expect(published?.template.items.map((i) => i.key)).toEqual(["sales", "no-cash", "late"]);
    expect(await templates.publishedByKey(tenantId, DRAFT_KEY)).toBeNull();
    expect(await templates.publishedByKey(tenantId, MISSING_KEY)).toBeNull();
    // What gates `awaitingPin`: this firm has published one, a firm with none
    // (here, one that does not exist) has not.
    expect(await templates.anyPublished(tenantId)).toBe(true);
    expect(await templates.anyPublished(randomUUID())).toBe(false);
  });
});

describe("the sweep, over real rows, on the firm's day", () => {
  it("at 17:00 UTC on 31 October (22:30 in Kolkata) asks only for the backlog", async () => {
    clock.set("2025-10-31T17:00:00.000Z");
    const [report] = await sweep.sweep();
    expect(report).toEqual({
      tenantId,
      raised: 3,
      alreadyRaised: 0,
      overdueOnRaise: 3,
      noTemplate: 1,
      awaitingPin: 1,
    });
    // October's items are due to be asked on 1 November: nothing yet.
    expect(await asksOn(task.oct)).toEqual([]);
    // August's, all of them, with the firm's own days already gone by.
    expect((await asksOn(task.aug)).map((a) => [a.request_item_key, a.due_on])).toEqual([
      ["late", "2025-09-30"],
      ["no-cash", "2025-09-05"],
      ["sales", "2025-09-05"],
    ]);
  });

  it("at 19:00 UTC — already 1 November in Kolkata — asks for October, with the template's own day", async () => {
    clock.set("2025-10-31T19:00:00.000Z");
    const [report] = await sweep.sweep();
    expect(report).toEqual({
      tenantId,
      raised: 4,
      alreadyRaised: 3,
      overdueOnRaise: 0,
      noTemplate: 1,
      awaitingPin: 1,
    });

    expect(await asksOn(task.oct)).toEqual([
      {
        work_item_id: task.oct,
        prompt: "Confirm there were no cash sales",
        ask_kind: "question",
        document_kind: null,
        due_on: "2025-11-05",
        request_template_version_id: listVersion,
        request_template_key: LIST_KEY,
        request_item_key: "no-cash",
        raised_by: null,
        client_party_id: client,
        status: "open",
      },
      {
        work_item_id: task.oct,
        prompt: "Sales invoices for the month",
        ask_kind: "document",
        document_kind: "books_input",
        due_on: "2025-11-05",
        request_template_version_id: listVersion,
        request_template_key: LIST_KEY,
        request_item_key: "sales",
        raised_by: null,
        client_party_id: client,
        status: "open",
      },
    ]);
    // The merged job asked once, on its older task.
    expect((await asksOn(task.merged1)).map((a) => a.request_item_key)).toEqual(["no-cash", "sales"]);
    expect(await asksOn(task.merged2)).toEqual([]);
  });

  it("asks nothing where it must not: a skipped step, an unpinned job, an unpublished list, a finished task, a cancelled job", async () => {
    for (const t of [task.sep, task.unpinned, task.nov, task.noList, task.doneTask, task.cancelled]) {
      expect(await asksOn(t), t).toEqual([]);
    }
  });

  it("a second pass raises nothing and records nothing", async () => {
    const before = raisedEvents();
    const [rows] = await owner<{ n: number }[]>`
      SELECT count(*)::int AS n FROM delivery.client_ask WHERE tenant_id = ${tenantId}
    `;
    const [report] = await sweep.sweep();
    expect(report).toMatchObject({ raised: 0, alreadyRaised: 7, overdueOnRaise: 0 });
    const [after] = await owner<{ n: number }[]>`
      SELECT count(*)::int AS n FROM delivery.client_ask WHERE tenant_id = ${tenantId}
    `;
    expect(after?.n).toBe(rows?.n);
    expect(rows?.n).toBe(7);
    expect(raisedEvents()).toBe(before);
    // One `client_ask.raised` per row created, across every pass.
    expect(raisedEvents()).toBe(7);
  });

  it("a merged job whose first task finishes does not ask again on its second", async () => {
    await owner`
      UPDATE delivery.work_item SET state_id = ${doneState}, completed_at = now()
       WHERE id = ${task.merged1}
    `;
    const subjects = await new PostgresRequestSubjects(app).periodJobs(tenantId);
    const merged = subjects.find((s) => s.jobId === job.merged);
    // The read now offers the other task, and still knows what the job asked.
    expect(merged?.workItemId).toBe(task.merged2);
    expect(merged?.asked.map((a) => a.itemKey).sort()).toEqual(["no-cash", "sales"]);

    const [report] = await sweep.sweep();
    expect(report).toMatchObject({ raised: 0, alreadyRaised: 7 });
    expect(await asksOn(task.merged2)).toEqual([]);
  });

  it("a step marked skipped stops its later items; the job's other open task still gets the late item", async () => {
    await owner`
      UPDATE delivery.job_step
         SET status = 'skipped', outcome_note = 'The client sent the stock count with the books.'
       WHERE job_id = ${job.oct} AND step_key = 'collect'
    `;
    // 21 November in Kolkata: October's "late" item (send 20) is due to be asked.
    clock.set("2025-11-21T06:00:00.000Z");
    const [report] = await sweep.sweep();
    expect(report).toEqual({
      tenantId,
      // The merged job's late item, on the task still open.
      raised: 1,
      // August's three and the merged job's two.
      alreadyRaised: 5,
      overdueOnRaise: 0,
      noTemplate: 1,
      awaitingPin: 1,
    });
    expect((await asksOn(task.oct)).map((a) => a.request_item_key)).toEqual(["no-cash", "sales"]);
    expect(await asksOn(task.merged2)).toEqual([
      expect.objectContaining({ request_item_key: "late", due_on: "2025-11-30", raised_by: null }),
    ]);
  });
});
