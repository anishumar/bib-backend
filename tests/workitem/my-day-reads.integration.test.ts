// V2.1 (My day): the reads a person's one list is built from carry the CLIENT
// by id and the DAY the work is due, so the screen can link the client and
// sort by date without a lookup per row. Three reads, three new joins, and a
// real Postgres is the only thing that can say the joins are right.
//
//   - `describeJobs` (what a step or a step check belongs to): the client and
//     company by id, the job's period, and the earliest due day of its
//     UNFINISHED tasks;
//   - the task check queue (`work_item_approval`): the task's client and due day;
//   - the escalation queue: the task's client by id (a filing has none).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresJobRepository } from "../../src/infrastructure/postgres/job-repository";
import { PostgresWorkItemApprovalRepository } from "../../src/infrastructure/postgres/work-item-approval-repository";
import { PostgresEscalationNoticeRepository } from "../../src/infrastructure/postgres/escalation-repository";
import { PostgresObligationCoverage } from "../../src/infrastructure/postgres/obligation-coverage";
import { PostgresWorkItemRepository } from "../../src/infrastructure/postgres/work-item-repository";
import { PostgresStepApprovalRepository } from "../../src/infrastructure/postgres/step-approval-repository";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });
const jobs = new PostgresJobRepository(app);
const approvals = new PostgresWorkItemApprovalRepository(app);
const notices = new PostgresEscalationNoticeRepository(app);
const coverage = new PostgresObligationCoverage(app);
const items = new PostgresWorkItemRepository(app);
const stepChecks = new PostgresStepApprovalRepository(app);

const stamp = Date.now().toString(36);
const ref = (): string => randomUUID();

let tenant: string;
let client: string;
let entity: string;
let issuer: string;
let asha: string;
let notStarted: string;
let completed: string;
let medium: string;
let serviceV1: string;
let serviceEntry: string;
let pending: string;
let filed: string;

async function party(name: string): Promise<string> {
  const id = ref();
  await owner`INSERT INTO core.party (id, tenant_id, kind, display_name) VALUES (${id}, ${tenant}, 'organization', ${name})`;
  return id;
}

/** A signed letter with one line, its engagement, and ONE per-period job over
 *  it for September 2026. */
async function septemberJob(): Promise<{ jobId: string; engagementId: string }> {
  const letterId = ref();
  const lineId = ref();
  const engagementId = ref();
  await owner`
    INSERT INTO crm.engagement_letter
      (id, tenant_id, party_id, jurisdiction, title, status, currency, fx_rate,
       fx_rate_date, ref, issuing_entity_party_id)
    VALUES (${letterId}, ${tenant}, ${client}, 'IN', ${`myday-${stamp}`}, 'draft', 'INR', 1,
            current_date, ${`EL-2026-${String(8000 + Math.floor(Math.random() * 999))}`}, ${issuer})
  `;
  await owner`
    INSERT INTO crm.engagement_letter_line
      (id, tenant_id, engagement_letter_id, service_version_id, description, position,
       quantity, unit_amount, currency, entity_party_id)
    VALUES (${lineId}, ${tenant}, ${letterId}, ${serviceV1}, 'line 1', 1, 1, 1000, 'INR', ${entity})
  `;
  await owner`
    INSERT INTO crm.engagement
      (id, tenant_id, engagement_letter_id, engagement_letter_line_id, party_id,
       entity_party_id, status, activated_at, effective_from)
    VALUES (${engagementId}, ${tenant}, ${letterId}, ${lineId}, ${client},
            ${entity}, 'active', now(), current_date)
  `;
  await owner`
    UPDATE crm.engagement_letter
    SET status = 'signed', sent_at = now(), signed_at = now(), signed_by_name = 'A Signatory',
        signature_method = 'attested', signed_content_hash = repeat('a', 64)
    WHERE id = ${letterId}
  `;
  const jobId = ref();
  await owner`
    INSERT INTO delivery.job
      (id, tenant_id, source_kind, source_ref, split_axis, split_code,
       period_start, period_end, period_label)
    VALUES (${jobId}, ${tenant}, 'engagement_period', ${ref()}, 'none', NULL,
            '2026-09-01', '2026-09-30', 'Sep 2026')
  `;
  await owner`
    INSERT INTO delivery.job_engagement (tenant_id, job_id, engagement_id, period_start)
    VALUES (${tenant}, ${jobId}, ${engagementId}, '2026-09-01')
  `;
  return { jobId, engagementId };
}

async function task(row: {
  jobId?: string | null;
  engagementId?: string | null;
  state?: string;
  dueOn?: string | null;
}): Promise<string> {
  const [created] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item
      (tenant_id, client_party_id, entity_party_id, engagement_id, job_id, title, state_id,
       priority_id, assignee_user_id, due_on, completed_at)
    VALUES (${tenant}, ${client}, ${entity}, ${row.engagementId ?? null}, ${row.jobId ?? null},
            'Monthly close · Sep 2026', ${row.state ?? notStarted}, ${medium}, ${asha},
            ${row.dueOn ?? null}, ${row.state === completed ? new Date().toISOString() : null})
    RETURNING id
  `;
  if (!created) throw new Error("no task");
  return created.id;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`myday-${stamp}`}, 'My Day Reads', 'INR') RETURNING id
  `;
  if (!t) throw new Error("no firm");
  tenant = t.id;
  client = await party("Kaveri Foods");
  entity = await party("Kaveri Foods Private Limited");
  issuer = await party("10x Global");

  const [u] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`asha-${stamp}@myday.test`}, 'Asha') RETURNING id
  `;
  if (!u) throw new Error("no user");
  asha = u.id;
  await owner`
    INSERT INTO tenancy.membership (tenant_id, user_id, audience, role, is_active)
    VALUES (${tenant}, ${asha}, 'STAFF', 'associate', true)
  `;

  // A COMPLETE vocabulary: `calendar.integration.test.ts` checks every firm in
  // the database has a successful terminal task state and a filed obligation
  // state, and a fixture firm without them fails it on every later run.
  const [ns, done] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_state (tenant_id, code, name, is_initial, is_terminal, is_success, sort_order)
    VALUES (${tenant}, 'not_started', 'Not Started', true, false, false, 10),
           (${tenant}, 'completed', 'Completed', false, true, true, 90)
    RETURNING id
  `;
  const [p] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_priority (tenant_id, code, name, rank, is_default, is_statutory_default)
    VALUES (${tenant}, 'medium', 'Medium', 2, true, true) RETURNING id
  `;
  const [pend] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_state (tenant_id, code, name, is_initial, sort_order)
    VALUES (${tenant}, 'pending', 'Pending', true, 10) RETURNING id
  `;
  const [fil] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_state (tenant_id, code, name, is_terminal, is_filed, sort_order)
    VALUES (${tenant}, 'filed', 'Filed', true, true, 90) RETURNING id
  `;
  if (!pend || !fil) throw new Error("no filing states");
  pending = pend.id;
  filed = fil.id;
  if (!ns || !done || !p) throw new Error("no vocabulary");
  notStarted = ns.id;
  completed = done.id;
  medium = p.id;

  const entryId = ref();
  serviceEntry = entryId;
  await owner`INSERT INTO config.entry (id, tenant_id, kind, key) VALUES (${entryId}, ${tenant}, 'service', ${`books-${stamp}`})`;
  serviceV1 = ref();
  await owner`
    INSERT INTO config.version (id, tenant_id, entry_id, version, status, body, published_at)
    VALUES (${serviceV1}, ${tenant}, ${entryId}, 1, 'published',
            ${owner.json({ name: "Monthly bookkeeping", module: "FRC", jurisdictions: ["IN"], billingBasis: "fixed", recurrence: "monthly" })},
            now())
  `;
});

afterAll(async () => {
  await owner.end();
  await app.end();
});

describe("describeJobs names the client by id, the period and the job's due day (V2.1)", () => {
  it("dates a step by the EARLIEST UNFINISHED task of its job, and names both parties", async () => {
    const { jobId, engagementId } = await septemberJob();
    // Finished work does not date the job: its due day is history. (One task
    // per engagement is the database's rule, so the other two hang off the job
    // alone, as a merged job's tasks for its other services would.)
    await task({ jobId, engagementId, state: completed, dueOn: "2026-09-28" });
    await task({ jobId, dueOn: "2026-10-10" });
    await task({ jobId, dueOn: "2026-10-05" });

    const detail = (await jobs.describeJobs(tenant, [jobId])).get(jobId);

    expect(detail).toMatchObject({
      clientName: "Kaveri Foods",
      clientPartyId: client,
      entityName: "Kaveri Foods Private Limited",
      entityPartyId: entity,
      periodLabel: "Sep 2026",
      dueOn: "2026-10-05",
    });
    expect(detail?.services.map((s) => s.serviceName)).toEqual(["Monthly bookkeeping"]);
  });

  it("says null for the due day when no unfinished task carries one", async () => {
    const { jobId, engagementId } = await septemberJob();
    await task({ jobId, engagementId, dueOn: null });
    expect((await jobs.describeJobs(tenant, [jobId])).get(jobId)?.dueOn).toBeNull();
  });
});

describe("a job is never due after the law's date for its filings (audit 2026-10-03, CA#11)", () => {
  // Kulkarni's "GST returns · Sep 2026" job read due 20 Oct (period end + the
  // service's 20-day turnaround) while its GSTR-1 was legally due 11 Oct, and
  // TDS/ITR jobs read "No due date" though their filings had dates. A job's
  // due day now also counts the earliest UNFILED filing its work is for: same
  // company, a rule on the job's service, a period inside the job's.

  /** A GSTR-1-like rule on the job's service, and its filing for `period`. */
  async function filing(over: {
    engagementId: string | null;
    statutoryDueOn: string;
    periodStart?: string;
    periodEnd?: string;
    state?: string;
    withdrawn?: boolean;
  }): Promise<string> {
    const [rule] = await owner<{ id: string; lineage_id: string }[]>`
      INSERT INTO delivery.obligation_template
        (tenant_id, jurisdiction, name, recurrence, fiscal_year_start_month,
         due_rule, due_month_offset, due_day_of_month, rule_pack, status)
      VALUES (${tenant}, 'IN', ${`GSTR-1 ${ref()}`}, 'monthly', 4, 'day_of_month', 1, 11, ${`ca11-${stamp}`}, 'confirmed')
      RETURNING id, lineage_id
    `;
    if (!rule) throw new Error("no rule");
    await owner`
      INSERT INTO delivery.obligation_rule_service (tenant_id, lineage_id, service_entry_id)
      VALUES (${tenant}, ${rule.lineage_id}, ${serviceEntry})
    `;
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO delivery.obligation_instance
        (tenant_id, template_id, lineage_id, entity_party_id, engagement_id, period_start, period_end,
         period_label, statutory_due_on, internal_target_on, state_id, withdrawn_at, withdrawn_reason)
      VALUES (${tenant}, ${rule.id}, ${rule.lineage_id}, ${entity}, ${over.engagementId},
              ${over.periodStart ?? "2026-09-01"}, ${over.periodEnd ?? "2026-09-30"}, 'Sep 2026',
              ${over.statutoryDueOn}, ${over.statutoryDueOn}, ${over.state ?? pending},
              ${over.withdrawn === true ? new Date().toISOString() : null},
              ${over.withdrawn === true ? "service_unlinked" : null})
      RETURNING id
    `;
    if (!row) throw new Error("no filing");
    return row.id;
  }

  // One company and one service across these tests, so each test's open
  // filings would reach the next test's job through the service link, which
  // is the rule working. Closed after each, so every test starts clean.
  afterEach(async () => {
    await owner`
      UPDATE delivery.obligation_instance SET state_id = ${filed}
       WHERE tenant_id = ${tenant} AND withdrawn_at IS NULL
    `;
  });

  it("is due on the GSTR-1's legal date, not the turnaround after the month", async () => {
    const { jobId, engagementId } = await septemberJob();
    await task({ jobId, engagementId, dueOn: "2026-10-20" });
    await filing({ engagementId, statutoryDueOn: "2026-10-11" });
    const detail = (await jobs.describeJobs(tenant, [jobId])).get(jobId);
    expect(detail).toMatchObject({ dueOn: "2026-10-11", filingDueOn: "2026-10-11" });
  });

  it("has a due day when only its filings carry one (TDS, ITR)", async () => {
    const { jobId, engagementId } = await septemberJob();
    await task({ jobId, engagementId, dueOn: null });
    // Attached to no engagement: the generator gives a period's row to ONE
    // engagement of the company, and this job's work is for it all the same.
    await filing({ engagementId: null, statutoryDueOn: "2026-10-07" });
    expect((await jobs.describeJobs(tenant, [jobId])).get(jobId)?.dueOn).toBe("2026-10-07");
  });

  it("dates a month's task by the same rule when it is created", async () => {
    const { engagementId } = await septemberJob();
    await filing({ engagementId: null, statutoryDueOn: "2026-10-11" });
    await filing({ engagementId, statutoryDueOn: "2026-10-20" });
    const sep = { start: "2026-09-01", end: "2026-09-30" };
    expect(await coverage.earliestFilingDue(tenant, engagementId, sep)).toBe("2026-10-11");
    expect(await coverage.earliestFilingDue(tenant, engagementId, { start: "2026-11-01", end: "2026-11-30" })).toBeNull();
  });

  it("ignores a filing already filed, withdrawn, or for another period", async () => {
    const { jobId, engagementId } = await septemberJob();
    await task({ jobId, engagementId, dueOn: "2026-10-20" });
    await filing({ engagementId, statutoryDueOn: "2026-10-11", state: filed });
    await filing({ engagementId, statutoryDueOn: "2026-10-09", withdrawn: true });
    await filing({ engagementId, statutoryDueOn: "2026-09-11", periodStart: "2026-08-01", periodEnd: "2026-08-31" });
    const detail = (await jobs.describeJobs(tenant, [jobId])).get(jobId);
    expect(detail).toMatchObject({ dueOn: "2026-10-20", filingDueOn: null });
  });
});

describe("the task check queue carries the task's client by id and its due day (V2.1)", () => {
  it("reads both off the task", async () => {
    const item = await task({ dueOn: "2026-10-12" });
    await owner`
      INSERT INTO delivery.work_item_approval (tenant_id, work_item_id)
      VALUES (${tenant}, ${item})
    `;
    const row = (await approvals.listPending(tenant)).find((c) => c.workItemId === item);
    expect(row).toMatchObject({ clientName: "Kaveri Foods", clientPartyId: client, dueOn: "2026-10-12" });
    // And the company the work is for (audit 2026-10-03, F32).
    expect(row).toMatchObject({ entityPartyId: entity, entityName: "Kaveri Foods Private Limited" });
  });
});

describe("the escalation queue carries the task's client by id (V2.1)", () => {
  it("names the client a task escalation is about", async () => {
    const item = await task({ dueOn: "2026-09-20" });
    await owner`
      INSERT INTO delivery.escalation_notice
        (tenant_id, work_item_id, rung_key, watch, after_days, target, raised_to_user_id,
         raised_on, days_past)
      VALUES (${tenant}, ${item}, 'r1', 'work_item_due', 1, 'assignee', ${asha}, '2026-09-22', 2)
    `;
    const row = (await notices.listFor(tenant, null)).find((r) => r.workItemId === item);
    expect(row).toMatchObject({ clientName: "Kaveri Foods", clientPartyId: client, dueOn: "2026-09-20" });
  });
});

describe("sent back shows on the maker's desk (audit 2026-10-03, CA#29)", () => {
  let ravi: string;

  beforeAll(async () => {
    const [u] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.user_account (email, display_name)
      VALUES (${`ravi-${stamp}@myday.test`}, 'Ravi Kumar') RETURNING id
    `;
    if (!u) throw new Error("no checker");
    ravi = u.id;
  });

  it("carries the latest send-back's note on the task until it is sent again", async () => {
    const item = await task({ dueOn: "2026-10-20" });
    await owner`
      INSERT INTO delivery.work_item_approval (tenant_id, work_item_id, decision, notes, decided_by, decided_at)
      VALUES (${tenant}, ${item}, 'approved', NULL, ${ravi}, '2026-10-01T04:00:00Z'),
             (${tenant}, ${item}, 'rejected', 'Two bills missing from the ITC working', ${ravi}, '2026-10-02T05:30:00Z')
    `;
    expect((await items.findRecord(tenant, item))?.sentBack).toEqual({
      notes: "Two bills missing from the ITC working",
      decidedAt: "2026-10-02T05:30:00.000Z",
      decidedByName: "Ravi Kumar",
    });

    await owner`INSERT INTO delivery.work_item_approval (tenant_id, work_item_id) VALUES (${tenant}, ${item})`;
    expect((await items.findRecord(tenant, item))?.sentBack).toBeNull();
  });

  it("is not said of a finished task, or of one whose latest decision was an approval", async () => {
    const done = await task({ state: completed });
    await owner`
      INSERT INTO delivery.work_item_approval (tenant_id, work_item_id, decision, notes, decided_by, decided_at)
      VALUES (${tenant}, ${done}, 'rejected', 'redo', ${ravi}, '2026-10-02T05:30:00Z')
    `;
    expect((await items.findRecord(tenant, done))?.sentBack).toBeNull();

    const approved = await task({});
    await owner`
      INSERT INTO delivery.work_item_approval (tenant_id, work_item_id, decision, notes, decided_by, decided_at)
      VALUES (${tenant}, ${approved}, 'rejected', 'redo', ${ravi}, '2026-10-01T05:30:00Z'),
             (${tenant}, ${approved}, 'approved', NULL, ${ravi}, '2026-10-02T05:30:00Z')
    `;
    expect((await items.findRecord(tenant, approved))?.sentBack).toBeNull();
  });

  it("names the steps whose latest check sent them back, and none with a check open", async () => {
    const { jobId } = await septemberJob();
    const step = async (key: string): Promise<string> => {
      const id = ref();
      await owner`
        INSERT INTO delivery.job_step
          (id, tenant_id, job_id, step_key, label, executor, status, started_at, performed_by)
        VALUES (${id}, ${tenant}, ${jobId}, ${key}, 'Reconcile the bank', 'human', 'blocked', now(), ${asha})
      `;
      return id;
    };
    const back = await step("reconcile");
    const again = await step("collect");
    const neverChecked = await step("file");
    await owner`
      INSERT INTO delivery.step_approval (tenant_id, job_id, job_step_id, decision, notes, decided_by, decided_at)
      VALUES (${tenant}, ${jobId}, ${back}, 'rejected', 'Bank charges not booked', ${ravi}, '2026-10-02T05:30:00Z'),
             (${tenant}, ${jobId}, ${again}, 'rejected', 'redo', ${ravi}, '2026-10-02T05:30:00Z')
    `;
    await owner`INSERT INTO delivery.step_approval (tenant_id, job_id, job_step_id) VALUES (${tenant}, ${jobId}, ${again})`;

    expect(await stepChecks.sentBackFor(tenant, [back, again, neverChecked])).toEqual([
      {
        jobStepId: back,
        notes: "Bank charges not booked",
        decidedAt: "2026-10-02T05:30:00.000Z",
        decidedByName: "Ravi Kumar",
      },
    ]);
  });
});
