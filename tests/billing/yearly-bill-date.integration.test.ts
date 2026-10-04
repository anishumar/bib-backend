// Q071 against a REAL database (0354): the yearly bill's filing, and finished
// work for "Raise invoice now".
//
// ── WHAT IS PROVED HERE AND NOWHERE ELSE ───────────────────────────────────
//
//   1. The sweep's subjects carry the client company's filings of the rules
//      the service carries (linked on the lineage), and not a filing of a rule
//      the service does not carry, nor a withdrawn one.
//   2. The sweep writes the yearly bill ON the audit's due date, named for the
//      filing's year, with `dated_by_filing_id` held by its foreign key.
//   3. Finished work is read: a period job done (its day the FIRM's), a filing
//      whose job is done, narrowed to one job.
//   4. "Raise invoice now" writes the bill today, once; the sweep then writes
//      no second bill for that year.
//   5. THE WALL: a bill can name only a filing of its own firm.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/billing/yearly-bill-date.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { systemIds } from "../../src/platform/ids";
import {
  PostgresAutoBillingFirms,
  PostgresBillingDueWriter,
  PostgresBillingManagerFacts,
} from "../../src/infrastructure/postgres/billing-repository";
import { PostgresDoneWorkFacts } from "../../src/infrastructure/postgres/done-work";
import { BillingService } from "../../src/usecase/billing/service";
import { EarlyBiller } from "../../src/usecase/billing/early";
import { FakeAutoBillingSetting, FakeFiscalYearSource } from "../../src/testfakes/billing";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { RecordingEventSink } from "../../src/testfakes/ledger";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 4 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const stamp = Date.now().toString(36);
let tenantId = "";
let otherTenant = "";
let firm = "";
let client = "";
let entry = "";
let audit = "";
let auditFiling = "";
let monthlyFiling = "";
let unlinkedFiling = "";
let withdrawnFiling = "";
let books = "";
let booksJob = "";
let filingJob = "";

function sweepAt(now: string) {
  return new BillingService({
    dues: new PostgresBillingDueWriter(app),
    managers: new PostgresBillingManagerFacts(app),
    firms: new PostgresAutoBillingFirms(app),
    fiscalYears: new FakeFiscalYearSource(4),
    timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
    // Fresh ids: the table's key is global, and a fixed id from an earlier
    // run would be refused by ON CONFLICT and look like "nothing due".
    ids: systemIds,
    clock: { now: () => new Date(now) },
    events: new RecordingEventSink(),
  });
}

function earlyAt(now: string) {
  const setting = new FakeAutoBillingSetting();
  void setting.set(tenantId, true);
  return new EarlyBiller({
    dues: new PostgresBillingDueWriter(app),
    work: new PostgresDoneWorkFacts(app),
    managers: new PostgresBillingManagerFacts(app),
    setting,
    fiscalYears: new FakeFiscalYearSource(4),
    timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
    clock: { now: () => new Date(now) },
    ids: systemIds,
    events: new RecordingEventSink(),
  });
}

async function tenant(slug: string): Promise<string> {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, time_zone, auto_billing, auto_billing_since)
    VALUES (${slug}, 'Yearly Bill Test', 'INR', 'Asia/Kolkata', true, '2026-01-01') RETURNING id
  `;
  if (!t) throw new Error("tenant seed failed");
  return t.id;
}

async function company(t: string, name: string): Promise<string> {
  const [p] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name) VALUES (${t}, 'organization', ${name}) RETURNING id
  `;
  if (!p) throw new Error("party seed failed");
  await owner`INSERT INTO core.organization (party_id, tenant_id, legal_name) VALUES (${p.id}, ${t}, ${name})`;
  return p.id;
}

async function rule(name: string, recurrence: string): Promise<{ id: string; lineage: string }> {
  const [r] = await owner<{ id: string; lineage_id: string }[]>`
    INSERT INTO delivery.obligation_template
      (tenant_id, jurisdiction, name, recurrence, due_rule, due_month_offset, due_day_of_month, lead_time_days,
       rule_pack, status, is_active)
    VALUES (${tenantId}, 'IN', ${name}, ${recurrence}, 'day_of_month', 6, 30, 10, ${`yb-${stamp}`}, 'confirmed', true)
    RETURNING id, lineage_id
  `;
  if (!r) throw new Error("rule seed failed");
  return { id: r.id, lineage: r.lineage_id };
}

async function filing(
  templateId: string,
  period: [string, string, string],
  dueOn: string,
  stateId: string,
): Promise<string> {
  const [f] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_instance
      (tenant_id, template_id, entity_party_id, period_start, period_end, period_label,
       statutory_due_on, internal_target_on, state_id)
    VALUES (${tenantId}, ${templateId}, ${client}, ${period[0]}::date, ${period[1]}::date, ${period[2]},
            ${dueOn}::date, ${dueOn}::date, ${stateId})
    RETURNING id
  `;
  if (!f) throw new Error("filing seed failed");
  return f.id;
}

beforeAll(async () => {
  tenantId = await tenant(`yb-${stamp}`);
  otherTenant = await tenant(`yb-other-${stamp}`);
  firm = await company(tenantId, "The Firm");
  await owner`INSERT INTO crm.firm_entity (tenant_id, party_id) VALUES (${tenantId}, ${firm})`;
  client = await company(tenantId, `Kaveri Foods ${stamp}`);

  const [e] = await owner<{ id: string }[]>`
    INSERT INTO config.entry (tenant_id, kind, key) VALUES (${tenantId}, 'service', ${`audit-${stamp}`}) RETURNING id
  `;
  if (!e) throw new Error("service seed failed");
  entry = e.id;
  const [version] = await owner<{ id: string }[]>`
    INSERT INTO config.version (tenant_id, entry_id, version, body, status, published_at)
    VALUES (${tenantId}, ${entry}, 1, ${owner.json({ name: "Statutory audit", recurrence: "annual", module: "FRC" })},
            'published', now())
    RETURNING id
  `;
  if (!version) throw new Error("version seed failed");

  const [letter] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter
      (tenant_id, party_id, status, currency, fx_rate, fx_rate_date, ref, issuing_entity_party_id, jurisdiction, title)
    VALUES (${tenantId}, ${client}, 'draft', 'INR', 1, '2026-03-20', 'EL-2026-0001', ${firm}, 'IN', 'Engagement')
    RETURNING id
  `;
  if (!letter) throw new Error("letter seed failed");
  const lineIds: string[] = [];
  for (const [position, words] of [
    [1, "Statutory audit"],
    [2, "Annual compliance"],
  ] as const) {
    const [ln] = await owner<{ id: string }[]>`
      INSERT INTO crm.engagement_letter_line
        (tenant_id, engagement_letter_id, position, service_version_id, quantity, unit_amount,
         currency, discount_percent, billing_frequency, entity_party_id, description)
      VALUES (${tenantId}, ${letter.id}, ${position}, ${version.id}, 1, 150000, 'INR', 0, 'annually', ${client}, ${words})
      RETURNING id
    `;
    if (!ln) throw new Error("line seed failed");
    lineIds.push(ln.id);
  }
  await owner`
    UPDATE crm.engagement_letter
       SET status = 'signed', sent_at = now(), signed_at = now(), signed_by_name = 'A Director',
           signature_method = 'attested', signed_content_hash = ${"c".repeat(64)}
     WHERE id = ${letter.id}
  `;
  const engagementIds: string[] = [];
  for (const lineId of lineIds) {
    const [en] = await owner<{ id: string }[]>`
      INSERT INTO crm.engagement
        (tenant_id, party_id, entity_party_id, engagement_letter_id, engagement_letter_line_id,
         effective_from, status, activated_at, billing_from, first_invoice_on, year_start_month)
      VALUES (${tenantId}, ${client}, ${client}, ${letter.id}, ${lineId}, '2026-04-01', 'active', now(),
              '2026-04-01', '2027-03-31', 4)
      RETURNING id
    `;
    if (!en) throw new Error("engagement seed failed");
    engagementIds.push(en.id);
  }
  audit = engagementIds[0] ?? "";
  books = engagementIds[1] ?? "";

  // The audit rule is linked to the service; the ITR rule is not. Both lines
  // pin the same service, so both engagements carry the audit filing: the
  // second ("Annual compliance") is billed early below, before the sweep.
  const auditRule = await rule("Statutory audit", "annual");
  const gstr = await rule("GSTR-1", "monthly");
  const itr = await rule("Income tax return", "annual");
  for (const r of [auditRule, gstr]) {
    await owner`
      INSERT INTO delivery.obligation_rule_service (tenant_id, lineage_id, service_entry_id)
      VALUES (${tenantId}, ${r.lineage}, ${entry})
    `;
  }
  const [pending] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_state (tenant_id, code, name, sort_order)
    VALUES (${tenantId}, 'pending', 'Pending', 10) RETURNING id
  `;
  if (!pending) throw new Error("state seed failed");
  auditFiling = await filing(auditRule.id, ["2025-04-01", "2026-03-31", "FY2025-26"], "2026-09-30", pending.id);
  monthlyFiling = await filing(gstr.id, ["2026-04-01", "2026-04-30", "Apr 2026"], "2026-05-11", pending.id);
  unlinkedFiling = await filing(itr.id, ["2025-04-01", "2026-03-31", "FY2025-26"], "2026-07-31", pending.id);
  withdrawnFiling = await filing(auditRule.id, ["2024-04-01", "2025-03-31", "FY2024-25"], "2026-06-30", pending.id);
  await owner`
    UPDATE delivery.obligation_instance SET withdrawn_at = now(), withdrawn_reason = 'service_unlinked'
     WHERE id = ${withdrawnFiling}
  `;

  // "Annual compliance": its year's job finished at 20:00 UTC on 19 August,
  // which is 20 August in Kolkata.
  const [j] = await owner<{ id: string }[]>`
    INSERT INTO delivery.job
      (tenant_id, source_kind, source_ref, status, started_at, finished_at, period_start, period_end, period_label)
    VALUES (${tenantId}, 'engagement_period', ${randomUUID()}, 'done', '2026-04-02T05:00:00Z',
            '2026-08-19T20:00:00Z', '2026-04-01', '2027-03-31', 'FY2026-27')
    RETURNING id
  `;
  if (!j) throw new Error("job seed failed");
  booksJob = j.id;
  await owner`
    INSERT INTO delivery.job_engagement (tenant_id, job_id, engagement_id, period_start)
    VALUES (${tenantId}, ${booksJob}, ${books}, '2026-04-01')
  `;
  // The audit filing's own job, done.
  const [fj] = await owner<{ id: string }[]>`
    INSERT INTO delivery.job (tenant_id, source_kind, source_ref, status, started_at, finished_at)
    VALUES (${tenantId}, 'obligation', ${auditFiling}, 'done', '2026-09-01T05:00:00Z', '2026-09-20T06:00:00Z')
    RETURNING id
  `;
  if (!fj) throw new Error("filing job seed failed");
  filingJob = fj.id;
});

afterAll(async () => {
  await Promise.all([owner.end({ timeout: 5 }), app.end({ timeout: 5 })]);
});

describe("a yearly bill on its filing's due date (Q071, 0354)", () => {
  it("reads the filings of the rules the service carries, not another rule's, not a withdrawn one", async () => {
    const subjects = await new PostgresBillingDueWriter(app).subjectsFor(tenantId);
    const s = subjects.find((x) => x.engagementId === audit);
    const ids = (s?.statutoryFilings ?? []).map((f) => f.id).sort();
    expect(ids).toEqual([auditFiling, monthlyFiling].sort());
    expect(ids).not.toContain(unlinkedFiling);
    expect(ids).not.toContain(withdrawnFiling);
    const a = s?.statutoryFilings?.find((f) => f.id === auditFiling);
    expect(a).toMatchObject({ dueOn: "2026-09-30", periodLabel: "FY2025-26", name: "Statutory audit" });
  });

  it("reads finished work: a period job on the firm's day, and a filing whose job is done", async () => {
    const facts = new PostgresDoneWorkFacts(app);
    const all = await facts.doneWork(tenantId, { since: "2026-01-01" });
    const job = all.find((w) => w.id === booksJob);
    expect(job).toMatchObject({ kind: "job", doneOn: "2026-08-20", engagementIds: [books] });
    const f = all.find((w) => w.id === auditFiling);
    expect(f).toMatchObject({ kind: "filing", jobId: filingJob, name: "Statutory audit" });
    expect([...(f?.engagementIds ?? [])].sort()).toEqual([audit, books].sort());
    expect(all.some((w) => w.id === monthlyFiling)).toBe(false);

    const one = await facts.doneWork(tenantId, { since: "2026-01-01", jobId: booksJob });
    expect(one.map((w) => w.id)).toEqual([booksJob]);
  });

  it("bills a finished year early, today, once", async () => {
    const early = earlyAt("2026-08-21T06:00:00Z");
    const offers = await early.candidates(tenantId, { jobId: booksJob });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      subjectKey: `e:${books}`,
      plannedBillOn: "2026-09-30",
      period: { start: "2026-04-01", end: "2027-03-31", label: "FY2025-26" },
      serviceName: "Annual compliance",
    });
    const { dueId } = await early.billEarly(
      { tenantId, subjectKey: `e:${books}`, periodStart: "2026-04-01" },
      { type: "system", id: null },
    );
    const [row] = await owner<{ bill_on: string; period_label: string; dated_by_filing_id: string | null }[]>`
      SELECT bill_on::text, period_label, dated_by_filing_id FROM crm.billing_due WHERE id = ${dueId}
    `;
    expect(row).toEqual({ bill_on: "2026-08-21", period_label: "FY2025-26", dated_by_filing_id: auditFiling });
    await expect(
      early.billEarly({ tenantId, subjectKey: `e:${books}`, periodStart: "2026-04-01" }, { type: "system", id: null }),
    ).rejects.toMatchObject({ code: "BILL_EARLY_REFUSED" });
  });

  it("the sweep writes the audit's bill ON its due date, and no second bill for the year billed early", async () => {
    expect((await sweepAt("2026-09-29T06:00:00Z").sweepTenant(tenantId)).created).toBe(0);
    expect((await sweepAt("2026-09-30T06:00:00Z").sweepTenant(tenantId)).created).toBe(1);
    const rows = await owner<{ engagement_id: string; bill_on: string; period_label: string; dated_by_filing_id: string | null }[]>`
      SELECT engagement_id, bill_on::text, period_label, dated_by_filing_id
        FROM crm.billing_due WHERE tenant_id = ${tenantId} ORDER BY engagement_id = ${audit} DESC
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      engagement_id: audit,
      bill_on: "2026-09-30",
      period_label: "FY2025-26",
      dated_by_filing_id: auditFiling,
    });
  });

  it("THE WALL: a bill cannot name another firm's filing", async () => {
    const otherClient = await company(otherTenant, "Other Client");
    const [t] = await owner<{ id: string }[]>`
      INSERT INTO delivery.obligation_template
        (tenant_id, jurisdiction, name, recurrence, due_rule, due_month_offset, due_day_of_month, lead_time_days,
         rule_pack, status, is_active)
      VALUES (${otherTenant}, 'IN', 'Statutory audit', 'annual', 'day_of_month', 6, 30, 10, ${`yb-o-${stamp}`},
              'confirmed', true)
      RETURNING id
    `;
    const [st] = await owner<{ id: string }[]>`
      INSERT INTO delivery.obligation_state (tenant_id, code, name, sort_order)
      VALUES (${otherTenant}, 'pending', 'Pending', 10) RETURNING id
    `;
    if (!t || !st) throw new Error("other firm seed failed");
    const [theirs] = await owner<{ id: string }[]>`
      INSERT INTO delivery.obligation_instance
        (tenant_id, template_id, entity_party_id, period_start, period_end, period_label,
         statutory_due_on, internal_target_on, state_id)
      VALUES (${otherTenant}, ${t.id}, ${otherClient}, '2025-04-01', '2026-03-31', 'FY2025-26',
              '2026-09-30', '2026-09-30', ${st.id})
      RETURNING id
    `;
    if (!theirs) throw new Error("other filing seed failed");
    await expect(owner`
      UPDATE crm.billing_due SET dated_by_filing_id = ${theirs.id}
       WHERE tenant_id = ${tenantId} AND engagement_id = ${audit}
    `).rejects.toThrow(/billing_due_dated_by_filing_fkey/);
  });
});
