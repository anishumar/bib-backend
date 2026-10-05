// A period job's task files its period's filings (Q063, 0357): the SQL the
// rule rests on, against a real database.
//
//   1. `listJobFilingsForTask` finds the task's company's filings INSIDE the
//      job's period, on a chain the task's service carries, and nothing else:
//      not the quarter the month falls in, not another month, not another
//      service's filing, not a filed or withdrawn one.
//   2. `markFiled` names the task and `clearFiled` takes back only a row that
//      names it, decided in the WHERE.
//   3. 0357's CHECK: a row names a filer only while it is filed.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/obligation/job-filings.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresObligationInstanceRepository } from "../../src/infrastructure/postgres/obligation-instance-repository";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 2 });
const app = postgres(cfg.db.appUrl, { max: 2 });
const instances = new PostgresObligationInstanceRepository(app);

const stamp = Date.now().toString(36);
let tenant = "";
let userId = "";
let client = "";
let entity = "";
let pending = "";
let filedState = "";
let notStarted = "";
let priority = "";

async function service(key: string): Promise<{ entryId: string; versionId: string }> {
  const [entry] = await owner<{ id: string }[]>`
    INSERT INTO config.entry (tenant_id, kind, key) VALUES (${tenant}, 'service', ${key}) RETURNING id
  `;
  if (!entry) throw new Error("entry seed failed");
  const [version] = await owner<{ id: string }[]>`
    INSERT INTO config.version (tenant_id, entry_id, version, body, status, published_at)
    VALUES (${tenant}, ${entry.id}, 1, ${owner.json({ name: key })}, 'published', now())
    RETURNING id
  `;
  if (!version) throw new Error("version seed failed");
  return { entryId: entry.id, versionId: version.id };
}

async function rule(name: string, recurrence: string, entryId: string | null): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_template
      (tenant_id, jurisdiction, name, recurrence, fiscal_year_start_month,
       due_rule, due_month_offset, due_day_of_month, rule_pack, status)
    VALUES (${tenant}, 'IN', ${name}, ${recurrence}, 4, 'day_of_month', 1, 20, ${`jf-${stamp}@1`}, 'confirmed')
    RETURNING id
  `;
  if (!row) throw new Error("rule seed failed");
  if (entryId !== null) {
    await owner`
      INSERT INTO delivery.obligation_rule_service (tenant_id, lineage_id, service_entry_id, linked_by_user_id)
      VALUES (${tenant}, ${row.id}, ${entryId}, ${userId})
    `;
  }
  return row.id;
}

let letters = 0;
async function engagementFor(versionId: string): Promise<string> {
  letters += 1;
  const [letter] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter
      (tenant_id, party_id, status, currency, fx_rate, fx_rate_date, ref,
       issuing_entity_party_id, jurisdiction, title)
    VALUES (${tenant}, ${client}, 'draft', 'INR', 1, CURRENT_DATE,
            ${`EL-2026-${String(letters).padStart(4, "0")}`}, ${entity}, 'IN', 'Engagement')
    RETURNING id
  `;
  if (!letter) throw new Error("letter seed failed");
  const [line] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter_line
      (tenant_id, engagement_letter_id, position, service_version_id, quantity,
       unit_amount, currency, discount_percent, billing_frequency, entity_party_id,
       description, pricing_note)
    VALUES (${tenant}, ${letter.id}, 1, ${versionId}, 1, 5000, 'INR', 0,
            'monthly', ${entity}, 'Monthly GST', 'Priced on the schedule')
    RETURNING id
  `;
  if (!line) throw new Error("line seed failed");
  await owner`
    UPDATE crm.engagement_letter
       SET status = 'signed', sent_at = now(), signed_at = now(),
           signed_by_name = 'A Director', signature_method = 'attested',
           signed_content_hash = ${"a".repeat(64)}
     WHERE id = ${letter.id}
  `;
  const [engagement] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement
      (tenant_id, party_id, entity_party_id, engagement_letter_id,
       engagement_letter_line_id, effective_from, status, activated_at)
    VALUES (${tenant}, ${client}, ${entity}, ${letter.id}, ${line.id}, '2026-01-01', 'active', now())
    RETURNING id
  `;
  if (!engagement) throw new Error("engagement seed failed");
  return engagement.id;
}

/** A period job for `[start, end]` and its task on `engagementId`. */
async function jobTask(engagementId: string, start: string, end: string, label: string): Promise<string> {
  const [job] = await owner<{ id: string }[]>`
    INSERT INTO delivery.job (tenant_id, source_kind, source_ref, period_start, period_end, period_label)
    VALUES (${tenant}, 'engagement_period', ${randomUUID()}, ${start}::date, ${end}::date, ${label})
    RETURNING id
  `;
  if (!job) throw new Error("job seed failed");
  const id = randomUUID();
  await owner`
    INSERT INTO delivery.work_item
      (id, tenant_id, client_party_id, entity_party_id, engagement_id, job_id, title,
       state_id, priority_id, is_client_visible)
    VALUES (${id}, ${tenant}, ${client}, ${entity}, ${engagementId}, ${job.id}, ${`GST · ${label}`},
            ${notStarted}, ${priority}, false)
  `;
  return id;
}

async function filing(
  ruleId: string,
  start: string,
  end: string,
  label: string,
  over: { engagementId?: string; withdrawn?: boolean } = {},
): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_instance
      (tenant_id, template_id, entity_party_id, engagement_id, period_start, period_end, period_label,
       statutory_due_on, internal_target_on, state_id,
       withdrawn_at, withdrawn_by_user_id, withdrawn_reason)
    VALUES (${tenant}, ${ruleId}, ${entity}, ${over.engagementId ?? null}, ${start}::date, ${end}::date,
            ${label}, (${end}::date + 20), (${end}::date + 20), ${pending},
            ${over.withdrawn ? owner`now()` : null}, ${over.withdrawn ? userId : null},
            ${over.withdrawn ? "service_unlinked" : null})
    RETURNING id
  `;
  if (!row) throw new Error("filing seed failed");
  return row.id;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, time_zone)
    VALUES (${`jf-${stamp}`}, 'Job Filings QA', 'INR', 'Asia/Kolkata') RETURNING id
  `;
  if (!t) throw new Error("tenant seed failed");
  tenant = t.id;
  const [u] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email) VALUES (${`jf-${stamp}@example.test`}) RETURNING id
  `;
  if (!u) throw new Error("user seed failed");
  userId = u.id;
  const [c] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenant}, 'organization', 'Deccan Agro Group') RETURNING id
  `;
  const [e] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenant}, 'organization', 'Deccan Agro Foods Pvt Ltd') RETURNING id
  `;
  if (!c || !e) throw new Error("party seed failed");
  client = c.id;
  entity = e.id;
  await owner`
    INSERT INTO core.organization (party_id, tenant_id, legal_name)
    VALUES (${entity}, ${tenant}, 'Deccan Agro Foods Pvt Ltd')
  `;
  await owner`
    INSERT INTO core.legal_entity (tenant_id, party_id, jurisdiction, entity_type, status)
    VALUES (${tenant}, ${entity}, 'IN', 'private_limited', 'active')
  `;
  const states = await owner<{ code: string; id: string }[]>`
    INSERT INTO delivery.work_item_state (tenant_id, code, name, is_initial, is_terminal, is_success, sort_order)
    VALUES (${tenant}, 'not_started', 'Not Started', true, false, false, 10),
           (${tenant}, 'completed', 'Completed', false, true, true, 90)
    RETURNING code, id
  `;
  notStarted = states.find((s) => s.code === "not_started")?.id ?? "";
  const [p] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_priority (tenant_id, code, name, rank, is_default, is_statutory_default)
    VALUES (${tenant}, 'medium', 'Medium', 3, true, true) RETURNING id
  `;
  const [pend] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_state (tenant_id, code, name, is_initial, sort_order)
    VALUES (${tenant}, 'pending', 'Pending', true, 10) RETURNING id
  `;
  const [fil] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_state (tenant_id, code, name, is_terminal, is_filed, sort_order)
    VALUES (${tenant}, 'filed', 'Filed', true, true, 90) RETURNING id
  `;
  if (!p || !pend || !fil || notStarted === "") throw new Error("vocabulary seed failed");
  priority = p.id;
  pending = pend.id;
  filedState = fil.id;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

describe("the filings a period job's task files (Q063)", () => {
  it("finds exactly the task's company's filings inside the job's period on its service's chains", async () => {
    const gst = await service(`gst-${stamp}`);
    const payroll = await service(`payroll-${stamp}`);
    const gstr1 = await rule("GSTR-1", "monthly", gst.entryId);
    const gstr3b = await rule("GSTR-3B", "monthly", gst.entryId);
    const quarterly = await rule("GST quarterly statement", "quarterly", gst.entryId);
    const pf = await rule("PF return", "monthly", payroll.entryId);
    const unlinked = await rule("A rule on no service", "monthly", null);
    const engagement = await engagementFor(gst.versionId);
    const task = await jobTask(engagement, "2026-09-01", "2026-09-30", "Sep 2026");

    const sep1 = await filing(gstr1, "2026-09-01", "2026-09-30", "Sep 2026");
    const sep3b = await filing(gstr3b, "2026-09-01", "2026-09-30", "Sep 2026");
    // Owed under this very engagement, on a chain with no live link: still this job's.
    const ownedHere = await filing(unlinked, "2026-09-01", "2026-09-30", "Sep 2026", { engagementId: engagement });
    // Not this job's:
    const aug = await filing(gstr1, "2026-08-01", "2026-08-31", "Aug 2026");
    const quarter = await filing(quarterly, "2026-07-01", "2026-09-30", "Q2 FY2026-27");
    const otherService = await filing(pf, "2026-09-01", "2026-09-30", "Sep 2026");
    const nobodys = await filing(unlinked, "2026-10-01", "2026-10-31", "Oct 2026");
    const withdrawn = await filing(gstr1, "2026-10-01", "2026-10-31", "Oct 2026", { withdrawn: true });
    void [aug, quarter, otherService, nobodys, withdrawn];

    const found = (await instances.listJobFilingsForTask(tenant, task)).map((r) => r.id).sort();
    expect(found).toEqual([sep1, sep3b, ownedHere].sort());
  });

  it("files with the task's name on the row, and takes back only what that task filed", async () => {
    const gst = await service(`gst2-${stamp}`);
    const r = await rule("GSTR-3B (2)", "monthly", gst.entryId);
    const engagement = await engagementFor(gst.versionId);
    const jobTaskId = await jobTask(engagement, "2026-11-01", "2026-11-30", "Nov 2026");
    const other = await jobTask(engagement, "2026-12-01", "2026-12-31", "Dec 2026");
    const nov = await filing(r, "2026-11-01", "2026-11-30", "Nov 2026");

    // 23:30 UTC on 4 Dec is 05:00 on 5 Dec in India: an Indian filing is
    // filed on ITS day, not the UTC one (S7; the zone is FILING_ZONE's).
    expect(await instances.markFiled(tenant, nov, "2026-12-04T23:30:00Z", filedState, jobTaskId)).toBe("2026-12-05");
    expect((await instances.findById(tenant, nov))?.filedByWorkItemId).toBe(jobTaskId);
    expect((await instances.listFiledBy(tenant, jobTaskId)).map((x) => x.id)).toEqual([nov]);
    // A filed row is no longer one the job could file.
    expect(await instances.listJobFilingsForTask(tenant, jobTaskId)).toEqual([]);
    // Another task cannot un-file it; the one that filed it can.
    expect(await instances.clearFiled(tenant, nov, pending, other)).toBe(false);
    expect(await instances.clearFiled(tenant, nov, pending, jobTaskId)).toBe(true);
    expect(await instances.findById(tenant, nov)).toMatchObject({ filedOn: null, filedByWorkItemId: null });

    // Q084: the portal day typed at close wins over the instant's day.
    expect(await instances.markFiled(tenant, nov, "2026-12-05T06:00:00Z", filedState, jobTaskId, "2026-12-02")).toBe(
      "2026-12-02",
    );
    expect(await instances.clearFiled(tenant, nov, pending, jobTaskId)).toBe(true);

    // The calendar names the filer.
    await instances.markFiled(tenant, nov, "2026-12-05T06:00:00Z", filedState, jobTaskId);
    const [row] = await instances.calendar(tenant, { filedByWorkItemId: jobTaskId, includeSettled: true });
    expect(row).toMatchObject({ id: nov, filedByWorkItemId: jobTaskId, filedByTitle: "GST · Nov 2026" });
  });

  it("a task that is not a period job's files nothing", async () => {
    const id = randomUUID();
    await owner`
      INSERT INTO delivery.work_item (id, tenant_id, client_party_id, title, state_id, priority_id, is_client_visible)
      VALUES (${id}, ${tenant}, ${client}, 'Ad hoc', ${notStarted}, ${priority}, false)
    `;
    expect(await instances.listJobFilingsForTask(tenant, id)).toEqual([]);
  });

  it("refuses a filer on a row that is not filed (0357)", async () => {
    const gst = await service(`gst3-${stamp}`);
    const r = await rule("GSTR-1 (3)", "monthly", gst.entryId);
    const engagement = await engagementFor(gst.versionId);
    const task = await jobTask(engagement, "2027-01-01", "2027-01-31", "Jan 2027");
    const jan = await filing(r, "2027-01-01", "2027-01-31", "Jan 2027");
    await expect(
      owner`UPDATE delivery.obligation_instance SET filed_by_work_item_id = ${task} WHERE id = ${jan}`,
    ).rejects.toThrow(/obligation_instance_filed_by_needs_filed/);
  });
});
