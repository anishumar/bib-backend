// Work vs Billing (Q041) against a REAL database: the facts adapter's SQL.
//
// ── WHAT IS PROVED HERE AND NOWHERE ELSE ───────────────────────────────────
//
//   1. A BILL'S STATUS is the desk's derivation (skipped, billed), and its
//      invoice's money is `crm.invoice_balance`: unpaid, paid.
//   2. A JOB meets its bill by engagement and period, and its done day is the
//      FIRM's (finished 20:00 UTC on 3 Sep is 4 Sep in Kolkata).
//   3. A FILING generated for an engagement sits under that engagement's
//      period row, and is never flagged.
//   4. An invoice raised BY HAND for work with no billing set up is found, and
//      offered on the row that says billing is not set up.
//   5. One-time work: its job and its final bill on one row.
//   6. THE WALL: a second firm's bill is never read.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/billing/work-vs-billing.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresWorkBillingFacts } from "../../src/infrastructure/postgres/work-billing";
import { WorkBillingService } from "../../src/usecase/billing/work-vs-billing";
import { FakeFiscalYearSource } from "../../src/testfakes/billing";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 4 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const stamp = Date.now().toString(36);
let tenantId = "";
let otherTenant = "";
let firm = "";
let client = "";
let km = "";
let serviceVersion = "";
let monthly = "";
let unscheduled = "";
let oneTime = "";
let sequence = 0;

const service = new WorkBillingService({
  facts: new PostgresWorkBillingFacts(app),
  fiscalYears: new FakeFiscalYearSource(4),
  timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
  clock: { now: () => new Date("2026-10-04T06:00:00Z") },
});

async function tenant(slug: string): Promise<string> {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, time_zone, auto_billing, auto_billing_since)
    VALUES (${slug}, 'Work vs Billing Test', 'INR', 'Asia/Kolkata', true, '2026-07-01') RETURNING id
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

async function line(letterId: string, position: number, frequency: string, amount: number): Promise<string> {
  const [ln] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter_line
      (tenant_id, engagement_letter_id, position, service_version_id, quantity, unit_amount,
       currency, discount_percent, billing_frequency, entity_party_id, description)
    VALUES (${tenantId}, ${letterId}, ${position}, ${serviceVersion}, 1, ${amount}, 'INR', 0, ${frequency},
            ${client}, ${frequency === "one_time" ? "Statutory audit" : `Bookkeeping ${position}`})
    RETURNING id
  `;
  if (!ln) throw new Error("line seed failed");
  return ln.id;
}

async function engagement(letterId: string, lineId: string, schedule: [string, string] | null): Promise<string> {
  const [e] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement
      (tenant_id, party_id, entity_party_id, engagement_letter_id, engagement_letter_line_id,
       effective_from, status, activated_at, billing_from, first_invoice_on)
    VALUES (${tenantId}, ${client}, ${client}, ${letterId}, ${lineId}, '2026-07-01'::date, 'active', now(),
            ${schedule?.[0] ?? null}::date, ${schedule?.[1] ?? null}::date)
    RETURNING id
  `;
  if (!e) throw new Error("engagement seed failed");
  return e.id;
}

async function job(
  engagementId: string,
  status: "done" | "running",
  period: [string, string, string] | null,
  finishedAt: string | null,
): Promise<string> {
  const [j] = await owner<{ id: string }[]>`
    INSERT INTO delivery.job
      (tenant_id, source_kind, source_ref, status, started_at, finished_at, period_start, period_end, period_label)
    VALUES (${tenantId}, ${period === null ? "engagement" : "engagement_period"},
            ${period === null ? engagementId : randomUUID()}, ${status},
            '2026-07-02T05:00:00Z', ${finishedAt}::timestamptz,
            ${period?.[0] ?? null}::date, ${period?.[1] ?? null}::date, ${period?.[2] ?? null})
    RETURNING id
  `;
  if (!j) throw new Error("job seed failed");
  await owner`
    INSERT INTO delivery.job_engagement (tenant_id, job_id, engagement_id, period_start)
    VALUES (${tenantId}, ${j.id}, ${engagementId}, ${period?.[0] ?? null}::date)
  `;
  return j.id;
}

/** An issued invoice with one line for the engagement, tax 0. */
async function issuedInvoice(engagementId: string, unit: string, dueOn: string): Promise<{ id: string; line: string }> {
  sequence += 1;
  const [inv] = await owner<{ id: string }[]>`
    INSERT INTO crm.invoice
      (tenant_id, party_id, entity_party_id, number, financial_year, sequence_number,
       status, currency, fx_rate, fx_rate_date, issued_on, due_on, manager_user_id)
    VALUES (${tenantId}, ${client}, ${firm}, ${`INV/${stamp}/${String(sequence)}`}, 2026, ${sequence},
            'draft', 'INR', 1, '2026-07-01', null, ${dueOn}::date, ${km})
    RETURNING id
  `;
  if (!inv) throw new Error("invoice seed failed");
  const [ln] = await owner<{ id: string }[]>`
    INSERT INTO crm.invoice_line
      (tenant_id, invoice_id, engagement_id, description, position, quantity, unit_amount, currency, tax_percent)
    VALUES (${tenantId}, ${inv.id}, ${engagementId}, 'Work', 1, 1, ${unit}, 'INR', 0)
    RETURNING id
  `;
  if (!ln) throw new Error("invoice line seed failed");
  await owner`UPDATE crm.invoice SET status = 'issued', issued_on = '2026-09-01' WHERE id = ${inv.id}`;
  return { id: inv.id, line: ln.id };
}

async function bill(input: {
  engagementId: string;
  kind?: "period" | "final";
  period: [string, string, string];
  billOn: string;
  invoice?: { id: string; line: string };
  skippedReason?: string;
}): Promise<string> {
  const [d] = await owner<{ id: string }[]>`
    INSERT INTO crm.billing_due
      (tenant_id, kind, party_id, issuing_entity_party_id, currency, engagement_id,
       period_start, period_end, period_label, bill_on, full_amount, served_days, period_days,
       manager_user_id, manager_how, manager_note, invoice_id, invoice_line_id,
       skipped_at, skipped_by_user_id, skip_reason)
    VALUES (${tenantId}, ${input.kind ?? "period"}, ${client}, ${firm}, 'INR', ${input.engagementId},
            ${input.period[0]}::date, ${input.period[1]}::date, ${input.period[2]}, ${input.billOn}::date,
            25000, 1, 1, ${km}, 'key_manager', 'No SPOC for this Dept', ${input.invoice?.id ?? null},
            ${input.invoice?.line ?? null},
            ${input.skippedReason === undefined ? null : new Date("2026-08-05T06:00:00Z")},
            ${input.skippedReason === undefined ? null : km}, ${input.skippedReason ?? null})
    RETURNING id
  `;
  if (!d) throw new Error("bill seed failed");
  return d.id;
}

beforeAll(async () => {
  tenantId = await tenant(`wvb-${stamp}`);
  otherTenant = await tenant(`wvb-other-${stamp}`);

  const [u] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`km-${stamp}@example.test`}, 'Kiran Mehta') RETURNING id
  `;
  if (!u) throw new Error("user seed failed");
  km = u.id;
  await owner`INSERT INTO tenancy.membership (tenant_id, user_id, audience, role) VALUES (${tenantId}, ${km}, 'STAFF', 'manager')`;

  firm = await company(tenantId, "The Firm");
  await owner`INSERT INTO crm.firm_entity (tenant_id, party_id) VALUES (${tenantId}, ${firm})`;
  await owner`
    INSERT INTO crm.invoice_series (tenant_id, entity_party_id, financial_year, last_number, prefix, document_type)
    VALUES (${tenantId}, ${firm}, 2026, 0, 'INV', 'invoice')
  `;
  client = await company(tenantId, `Kaveri Foods ${stamp}`);
  await owner`
    INSERT INTO crm.client_assignment (tenant_id, client_party_id, role, axis_id, user_id, valid_from)
    VALUES (${tenantId}, ${client}, 'key_manager', NULL, ${km}, '2026-01-01')
  `;

  const [entry] = await owner<{ id: string }[]>`
    INSERT INTO config.entry (tenant_id, kind, key) VALUES (${tenantId}, 'service', ${`books-${stamp}`}) RETURNING id
  `;
  if (!entry) throw new Error("service seed failed");
  const [version] = await owner<{ id: string }[]>`
    INSERT INTO config.version (tenant_id, entry_id, version, body, status, published_at)
    VALUES (${tenantId}, ${entry.id}, 1, ${owner.json({ name: "Bookkeeping", recurrence: "monthly" })}, 'published', now())
    RETURNING id
  `;
  if (!version) throw new Error("version seed failed");
  serviceVersion = version.id;

  const [letter] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter
      (tenant_id, party_id, status, currency, fx_rate, fx_rate_date, ref, issuing_entity_party_id, jurisdiction, title)
    VALUES (${tenantId}, ${client}, 'draft', 'INR', 1, '2026-06-20', 'EL-2026-0001', ${firm}, 'IN', 'Engagement')
    RETURNING id
  `;
  if (!letter) throw new Error("letter seed failed");
  const lines = [
    await line(letter.id, 1, "monthly", 25000),
    await line(letter.id, 2, "monthly", 8000),
    await line(letter.id, 3, "one_time", 100000),
  ];
  await owner`
    UPDATE crm.engagement_letter
       SET status = 'signed', sent_at = now(), signed_at = now(), signed_by_name = 'A Director',
           signature_method = 'attested', signed_content_hash = ${"b".repeat(64)}
     WHERE id = ${letter.id}
  `;
  monthly = await engagement(letter.id, lines[0] ?? "", ["2026-07-01", "2026-08-01"]);
  unscheduled = await engagement(letter.id, lines[1] ?? "", null);
  oneTime = await engagement(letter.id, lines[2] ?? "", null);

  // July: skipped. August: done, billed, unpaid past its due date. September:
  // still being worked on, billed and paid (a retainer's normal month).
  await job(monthly, "done", ["2026-07-01", "2026-07-31", "Jul 2026"], "2026-08-02T06:00:00Z");
  await bill({
    engagementId: monthly,
    period: ["2026-07-01", "2026-07-31", "Jul 2026"],
    billOn: "2026-08-01",
    skippedReason: "Waived for July",
  });
  await job(monthly, "done", ["2026-08-01", "2026-08-31", "Aug 2026"], "2026-09-03T20:00:00Z");
  await bill({
    engagementId: monthly,
    period: ["2026-08-01", "2026-08-31", "Aug 2026"],
    billOn: "2026-09-01",
    invoice: await issuedInvoice(monthly, "25000", "2026-09-20"),
  });
  await job(monthly, "running", ["2026-09-01", "2026-09-30", "Sep 2026"], null);
  const paid = await issuedInvoice(monthly, "25000", "2026-10-15");
  await owner`
    INSERT INTO crm.payment (tenant_id, invoice_id, amount, currency, received_on, method)
    VALUES (${tenantId}, ${paid.id}, '25000', 'INR', '2026-10-02', 'bank_transfer')
  `;
  await bill({
    engagementId: monthly,
    period: ["2026-09-01", "2026-09-30", "Sep 2026"],
    billOn: "2026-10-01",
    invoice: paid,
  });

  // Billing never set up: September done, no bill, one invoice raised by hand.
  await job(unscheduled, "done", ["2026-09-01", "2026-09-30", "Sep 2026"], "2026-10-01T06:00:00Z");
  await issuedInvoice(unscheduled, "8000", "2026-09-10");

  // One-time: done 15 Sep and billed on a final bill.
  await job(oneTime, "done", null, "2026-09-15T06:00:00Z");
  const auditInvoice = await issuedInvoice(oneTime, "100000", "2026-10-30");
  await bill({
    engagementId: oneTime,
    kind: "final",
    period: ["2026-09-15", "2026-09-15", "Statutory audit"],
    billOn: "2026-09-15",
    invoice: auditInvoice,
  });

  // A GSTR-3B for September, generated for the monthly engagement.
  const [state] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_state (tenant_id, code, name, sort_order) VALUES (${tenantId}, 'pending', 'Pending', 10) RETURNING id
  `;
  const [template] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_template
      (tenant_id, jurisdiction, name, recurrence, due_rule, due_month_offset, due_day_of_month, lead_time_days, rule_pack, status, is_active)
    VALUES (${tenantId}, 'IN', 'GSTR-3B', 'monthly', 'day_of_month', 1, 20, 5, ${`wvb-${stamp}`}, 'confirmed', true)
    RETURNING id
  `;
  if (!state || !template) throw new Error("filing seed failed");
  await owner`
    INSERT INTO delivery.obligation_instance
      (tenant_id, template_id, entity_party_id, engagement_id, period_start, period_end, period_label,
       statutory_due_on, internal_target_on, state_id)
    VALUES (${tenantId}, ${template.id}, ${client}, ${monthly}, '2026-09-01', '2026-09-30', 'Sep 2026',
            '2026-10-20', '2026-10-15', ${state.id})
  `;

  // The other firm: a client and a bill that must never be read here.
  const otherFirm = await company(otherTenant, "Other Firm");
  const otherClient = await company(otherTenant, "Other Client");
  const [ol] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter
      (tenant_id, party_id, status, currency, fx_rate, fx_rate_date, ref, issuing_entity_party_id, jurisdiction, title)
    VALUES (${otherTenant}, ${otherClient}, 'draft', 'INR', 1, '2026-06-20', 'EL-2026-0001', ${otherFirm}, 'IN', 'Engagement')
    RETURNING id
  `;
  if (!ol) throw new Error("other letter seed failed");
  const [oentry] = await owner<{ id: string }[]>`
    INSERT INTO config.entry (tenant_id, kind, key) VALUES (${otherTenant}, 'service', ${`other-${stamp}`}) RETURNING id
  `;
  if (!oentry) throw new Error("other service seed failed");
  const [over] = await owner<{ id: string }[]>`
    INSERT INTO config.version (tenant_id, entry_id, version, body, status, published_at)
    VALUES (${otherTenant}, ${oentry.id}, 1, ${owner.json({ name: "Other", recurrence: "monthly" })}, 'published', now())
    RETURNING id
  `;
  if (!over) throw new Error("other version seed failed");
  const [oll] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter_line
      (tenant_id, engagement_letter_id, position, service_version_id, quantity, unit_amount, currency, discount_percent, billing_frequency, entity_party_id, description)
    VALUES (${otherTenant}, ${ol.id}, 1, ${over.id}, 1, 1000, 'INR', 0, 'monthly', ${otherClient}, 'Other work')
    RETURNING id
  `;
  if (!oll) throw new Error("other line seed failed");
  const [oe] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement
      (tenant_id, party_id, entity_party_id, engagement_letter_id, engagement_letter_line_id, effective_from, status, activated_at)
    VALUES (${otherTenant}, ${otherClient}, ${otherClient}, ${ol.id}, ${oll.id}, '2026-07-01', 'active', now())
    RETURNING id
  `;
  if (!oe) throw new Error("other engagement seed failed");
  await owner`
    INSERT INTO crm.billing_due
      (tenant_id, kind, party_id, issuing_entity_party_id, currency, engagement_id, period_start, period_end,
       period_label, bill_on, full_amount, served_days, period_days, manager_how, manager_note)
    VALUES (${otherTenant}, 'period', ${otherClient}, ${otherFirm}, 'INR', ${oe.id}, '2026-09-01', '2026-09-30',
            'Sep 2026', '2026-10-01', 1000, 30, 30, 'none', 'No SPOC and no Key Manager')
  `;
});

afterAll(async () => {
  await Promise.all([owner.end({ timeout: 5 }), app.end({ timeout: 5 })]);
});

describe("Work vs Billing on a real database (Q041)", () => {
  it("reads one row per service and period, and only this firm's", async () => {
    const out = await service.list(tenantId, {});
    expect(out.today).toBe("2026-10-04");
    expect(out.rows.every((r) => r.party.id === client)).toBe(true);
    expect(out.rows.map((r) => `${r.serviceName} | ${r.period?.label ?? "once"}`).sort()).toEqual(
      [
        "Bookkeeping 1 | Aug 2026",
        "Bookkeeping 1 | Jul 2026",
        "Bookkeeping 1 | Sep 2026",
        "Bookkeeping 2 | Sep 2026",
        "Statutory audit | once",
      ].sort(),
    );
  });

  it("shows the skipped bill with its reason and who skipped it", async () => {
    const jul = (await service.list(tenantId, {})).rows.find((r) => r.period?.label === "Jul 2026");
    expect(jul?.bill?.status).toBe("skipped");
    expect(jul?.flags).toEqual([
      expect.objectContaining({
        code: "skipped",
        reason: "Waived for July",
        by: { userId: km, displayName: "Kiran Mehta" },
      }),
    ]);
  });

  it("flags August unpaid 14 days past due, and dates its job on the firm's day", async () => {
    const aug = (await service.list(tenantId, {})).rows.find((r) => r.period?.label === "Aug 2026");
    expect(aug?.workDoneOn).toBe("2026-09-04");
    expect(aug?.invoice).toMatchObject({
      status: "issued",
      invoiced: "25000.0000",
      outstanding: "25000.0000",
    });
    expect(aug?.payment).toEqual({
      state: "unpaid",
      dueOn: "2026-09-20",
      daysOverdue: 14,
    });
    expect(aug?.flags.map((f) => [f.code, f.days])).toEqual([["unpaid_overdue", 14]]);
  });

  it("does NOT flag September: billed and paid while the work is still open, with its filing under it", async () => {
    const sep = (await service.list(tenantId, {})).rows.find(
      (r) => r.period?.label === "Sep 2026" && r.serviceName === "Bookkeeping 1",
    );
    expect(sep?.work).toBe("in_progress");
    expect(sep?.payment?.state).toBe("paid");
    expect(sep?.flags).toEqual([]);
    expect(sep?.notes.map((n) => n.code)).toEqual(["raised_before_work_done"]);
    expect(sep?.filings.map((f) => [f.name, f.periodLabel, f.dueOn])).toEqual([["GSTR-3B", "Sep 2026", "2026-10-20"]]);
  });

  it("flags work done with billing not set up, and finds the invoice raised by hand", async () => {
    const row = (await service.list(tenantId, {})).rows.find((r) => r.serviceName === "Bookkeeping 2");
    expect(row?.engagementIds).toEqual([unscheduled]);
    expect(row?.flags.map((f) => [f.code, f.cause])).toEqual([["no_bill", "no_schedule"]]);
    expect(row?.handInvoices?.count).toBe(1);
    expect(row?.handInvoices?.last?.number).toMatch(/^INV\//);
  });

  it("puts one-time work and its final bill on one row", async () => {
    const audit = (await service.list(tenantId, {})).rows.find((r) => r.kind === "one_time");
    expect(audit?.engagementIds).toEqual([oneTime]);
    expect(audit?.bill).toMatchObject({ kind: "final", status: "billed" });
    expect(audit?.workDoneOn).toBe("2026-09-15");
    expect(audit?.flags).toEqual([]);
  });

  it("narrows to problems and to one client in the query", async () => {
    const problems = await service.list(tenantId, {
      problemsOnly: true,
      partyId: client,
    });
    expect(problems.rows.map((r) => r.period?.label).sort()).toEqual(["Aug 2026", "Jul 2026", "Sep 2026"]);
    expect(problems.summary.byFlag).toMatchObject({
      skipped: 1,
      unpaid_overdue: 1,
      no_bill: 1,
    });
    const nobody = await service.list(tenantId, {
      partyId: "00000000-0000-4000-8000-000000000000",
    });
    expect(nobody.rows).toEqual([]);
  });

  it("reads the other firm's own bill only behind its own wall", async () => {
    const other = await service.list(otherTenant, {});
    expect(other.rows.map((r) => r.serviceName)).toEqual(["Other work"]);
    expect(other.rows.some((r) => r.party.id === client)).toBe(false);
  });
});
