// The billing sweep against a REAL database (auto-invoice, phase 1, 0318),
// because every claim below is about SQL a fake cannot reproduce.
//
// ── WHAT IS PROVED HERE AND NOWHERE ELSE ───────────────────────────────────
//
//   1. WHO IS OFFERED: a scheduled engagement that is active or ended; not one
//      waiting for its advance, and not one with no schedule.
//   2. A FEE GROUP is billed ONCE per period at the group's amount, never per
//      engagement it covers.
//   3. PRO-RATA is the database's: `amount` is generated from the full amount
//      and the days, in numeric, and a missing price stays NULL.
//   4. WHOSE KITTY: the SPOC's manager, read through the Dept, the
//      assignment and `reports_to_user_id`.
//   5. IDEMPOTENT: a second sweep writes nothing, and the unique indexes
//      refuse a second due for the same subject and period.
//   6. THE SWITCH: only firms with auto_billing on are visited.
//   7. THE DESK: dues read by name with their status derived; raising drafts a
//      numbered invoice through InvoiceService, a line per due, in the
//      manager's kitty; a due settles once; a cancelled invoice reopens its
//      dues; the manager freezes at issue; a schedule snaps to its period.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/billing/sweep.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresAdvancePolicy, PostgresIssuerTaxDefaults } from "../../src/infrastructure/postgres/advance-reminders";
import {
  PostgresAutoBillingFirms,
  PostgresBillingDueWriter,
  PostgresBillingManagerFacts,
} from "../../src/infrastructure/postgres/billing-repository";
import { systemIds } from "../../src/platform/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { FakeAutoBillingFirms, FakeFiscalYearSource } from "../../src/testfakes/billing";
import { BillingService } from "../../src/usecase/billing/service";
import { BillingDeskService } from "../../src/usecase/billing/desk";
import {
  PostgresAutoBillingSetting,
  PostgresBillingDueDesk,
  PostgresBillingSchedules,
} from "../../src/infrastructure/postgres/billing-desk";
import { PostgresInvoiceRepository } from "../../src/infrastructure/postgres/invoice-repository";
import { PostgresRenderSource } from "../../src/infrastructure/postgres/render-source";
import { InvoiceService } from "../../src/usecase/invoice/service";
import { PostgresInvoiceFirmSettings } from "../../src/infrastructure/postgres/invoice-settings";
import type { Actor } from "../../src/domain/ledger/model";
import { FakeStaffDirectory } from "../../src/testfakes/lead";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 4 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const stamp = Date.now().toString(36);
let tenantId = "";
let firm = "";
let client = "";
let spoc = "";
let manager = "";
let keyManager = "";
let monthly = "";
let quarterlyEnded = "";
let waiting = "";
let unscheduled = "";
let groupId = "";
let serviceVersion = "";

const writer = new PostgresBillingDueWriter(app);
function service(firms: string[]): BillingService {
  return new BillingService({
    dues: writer,
    managers: new PostgresBillingManagerFacts(app),
    firms: new FakeAutoBillingFirms(firms),
    fiscalYears: new FakeFiscalYearSource(4),
    timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
    ids: systemIds,
    clock: { now: () => new Date("2026-12-05T06:00:00Z") },
    events: new RecordingEventSink(),
  });
}

async function user(name: string): Promise<string> {
  const [u] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`${name}-${stamp}@example.test`}, ${name}) RETURNING id
  `;
  if (!u) throw new Error("user seed failed");
  await owner`
    INSERT INTO tenancy.membership (tenant_id, user_id, audience, role)
    VALUES (${tenantId}, ${u.id}, 'STAFF', 'manager')
  `;
  return u.id;
}

async function company(name: string): Promise<string> {
  const [p] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name) VALUES (${tenantId}, 'organization', ${name})
    RETURNING id
  `;
  if (!p) throw new Error("party seed failed");
  await owner`INSERT INTO core.organization (party_id, tenant_id, legal_name) VALUES (${p.id}, ${tenantId}, ${name})`;
  return p.id;
}

let letters = 0;
async function letter(): Promise<string> {
  letters += 1;
  const [l] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter
      (tenant_id, party_id, status, currency, fx_rate, fx_rate_date, ref,
       issuing_entity_party_id, jurisdiction, title)
    VALUES (${tenantId}, ${client}, 'draft', 'INR', 1, CURRENT_DATE,
            ${`EL-2026-${String(letters).padStart(4, "0")}`}, ${firm}, 'IN', 'Engagement')
    RETURNING id
  `;
  if (!l) throw new Error("letter seed failed");
  return l.id;
}

async function line(
  letterId: string,
  position: number,
  frequency: string,
  amount: number | null,
  feeGroupId: string | null = null,
): Promise<string> {
  const [ln] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter_line
      (tenant_id, engagement_letter_id, position, service_version_id, quantity, unit_amount,
       currency, discount_percent, billing_frequency, entity_party_id, description, pricing_note,
       fee_group_id)
    VALUES (${tenantId}, ${letterId}, ${position}, ${serviceVersion}, 1, ${amount}, 'INR', 0, ${frequency},
            ${client}, 'Accounting and bookkeeping', ${amount === null && feeGroupId === null ? "As agreed" : null}, ${feeGroupId})
    RETURNING id
  `;
  if (!ln) throw new Error("line seed failed");
  return ln.id;
}

async function sign(letterId: string): Promise<void> {
  await owner`
    UPDATE crm.engagement_letter
       SET status = 'signed', sent_at = now(), signed_at = now(), signed_by_name = 'A Director',
           signature_method = 'attested', signed_content_hash = ${"b".repeat(64)}
     WHERE id = ${letterId}
  `;
}

async function engagement(
  letterId: string,
  lineId: string,
  opts: { status?: string; schedule?: [string, string] | null; endsOn?: string } = {},
): Promise<string> {
  const status = opts.status ?? "active";
  const schedule = opts.schedule === undefined ? ["2026-10-01", "2026-11-01"] : opts.schedule;
  const [e] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement
      (tenant_id, party_id, entity_party_id, engagement_letter_id, engagement_letter_line_id,
       effective_from, status, activated_at, billing_from, first_invoice_on,
       ends_on, ended_at, end_reason)
    VALUES (${tenantId}, ${client}, ${client}, ${letterId}, ${lineId}, '2026-07-01'::date, ${status},
            ${status === "pending_advance" ? null : new Date()},
            ${schedule?.[0] ?? null}::date, ${schedule?.[1] ?? null}::date,
            ${opts.endsOn ?? null}::date, ${opts.endsOn === undefined ? null : new Date()},
            ${opts.endsOn === undefined ? null : "Left"})
    RETURNING id
  `;
  if (!e) throw new Error("engagement seed failed");
  return e.id;
}

interface DueRow {
  engagement_id: string | null;
  fee_group_id: string | null;
  period_label: string;
  bill_on: string;
  full_amount: string | null;
  amount: string | null;
  served_days: number;
  period_days: number;
  manager_user_id: string | null;
  manager_how: string;
}

async function dues(): Promise<DueRow[]> {
  return owner<DueRow[]>`
    SELECT engagement_id, fee_group_id, period_label, bill_on::text, full_amount::text, amount::text,
           served_days, period_days, manager_user_id, manager_how
      FROM crm.billing_due WHERE tenant_id = ${tenantId}
     ORDER BY bill_on, period_label, engagement_id NULLS LAST
  `;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`billing-${stamp}`}, 'Billing Sweep Test', 'INR') RETURNING id
  `;
  if (!t) throw new Error("tenant seed failed");
  tenantId = t.id;

  spoc = await user("spoc");
  manager = await user("manager");
  keyManager = await user("keymanager");
  await owner`
    UPDATE tenancy.membership SET reports_to_user_id = ${manager}
     WHERE tenant_id = ${tenantId} AND user_id = ${spoc}
  `;

  firm = await company("The Firm");
  // One of the firm's own companies (0313), so it has an invoice series.
  await owner`INSERT INTO crm.firm_entity (tenant_id, party_id) VALUES (${tenantId}, ${firm})`;
  client = await company(`Kaveri Foods ${stamp}`);

  const [axis] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.service_axis (tenant_id, axis, code, name)
    VALUES (${tenantId}, 'dept', 'FRC', 'Financial Reporting') RETURNING id
  `;
  if (!axis) throw new Error("axis seed failed");
  await owner`
    INSERT INTO crm.client_assignment (tenant_id, client_party_id, role, axis_id, user_id, valid_from)
    VALUES (${tenantId}, ${client}, 'spoc', ${axis.id}, ${spoc}, '2026-01-01'),
           (${tenantId}, ${client}, 'key_manager', NULL, ${keyManager}, '2026-01-01')
  `;

  const [entry] = await owner<{ id: string }[]>`
    INSERT INTO config.entry (tenant_id, kind, key) VALUES (${tenantId}, 'service', ${`books-${stamp}`})
    RETURNING id
  `;
  if (!entry) throw new Error("service seed failed");
  const [version] = await owner<{ id: string }[]>`
    INSERT INTO config.version (tenant_id, entry_id, version, body, status, published_at)
    VALUES (${tenantId}, ${entry.id}, 1,
            ${owner.json({ name: "Bookkeeping", recurrence: "monthly", module: "FRC" })}, 'published', now())
    RETURNING id
  `;
  if (!version) throw new Error("version seed failed");
  serviceVersion = version.id;

  // One letter: a monthly line on its own, a quarterly line that ended on
  // 30 November, a line waiting for its advance, and an unscheduled one.
  const one = await letter();
  const monthlyLine = await line(one, 1, "monthly", 25000);
  const quarterlyLine = await line(one, 2, "quarterly", 30000);
  const waitingLine = await line(one, 3, "monthly", 1000);
  const unscheduledLine = await line(one, 4, "monthly", 2000);
  await sign(one);
  monthly = await engagement(one, monthlyLine);
  quarterlyEnded = await engagement(one, quarterlyLine, {
    status: "completed",
    // Billed in advance, so its bill date (1 October) has come by 5 December.
    schedule: ["2026-10-01", "2026-10-01"],
    endsOn: "2026-11-30",
  });
  waiting = await engagement(one, waitingLine, { status: "pending_advance" });
  unscheduled = await engagement(one, unscheduledLine, { schedule: null });

  // A second letter: one fee of 9,000 a month for two services.
  const two = await letter();
  const [g] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter_fee_group
      (tenant_id, engagement_letter_id, currency, position, title, billing_frequency, amount)
    VALUES (${tenantId}, ${two}, 'INR', 1, 'Retainer', 'monthly', 9000)
    RETURNING id
  `;
  if (!g) throw new Error("fee group seed failed");
  groupId = g.id;
  const a = await line(two, 1, "monthly", null, groupId);
  const b = await line(two, 2, "monthly", null, groupId);
  await sign(two);
  await engagement(two, a);
  await engagement(two, b);
});

afterAll(async () => {
  await owner`
    UPDATE crm.engagement
       SET status = 'cancelled', activated_at = coalesce(activated_at, now()),
           billing_from = NULL, first_invoice_on = NULL
     WHERE tenant_id = ${tenantId} AND ended_at IS NULL
  `;
  await owner`UPDATE tenancy.tenant SET auto_billing = false WHERE id = ${tenantId}`;
  await app.end();
  await owner.end();
});

describe("the billing sweep on a real database (0318)", () => {
  it("writes the dues the schedule owes, and only those", async () => {
    const [report] = await service([tenantId]).sweep();
    expect(report).toMatchObject({ tenantId, created: 5, alreadyDue: 0, awaitingFiscalYear: 0 });

    const rows = await dues();
    const subjects = new Set(rows.map((r) => r.engagement_id ?? r.fee_group_id));
    expect(subjects).toEqual(new Set([monthly, quarterlyEnded, groupId]));
    expect(subjects.has(waiting)).toBe(false);
    expect(subjects.has(unscheduled)).toBe(false);
  });

  it("bills a monthly service each month, in arrears, to the SPOC's manager", async () => {
    const rows = (await dues()).filter((r) => r.engagement_id === monthly);
    expect(rows.map((r) => [r.period_label, r.bill_on, r.full_amount, r.amount])).toEqual([
      ["Oct 2026", "2026-11-01", "25000.0000", "25000.00"],
      ["Nov 2026", "2026-12-01", "25000.0000", "25000.00"],
    ]);
    expect(rows.every((r) => r.manager_user_id === manager && r.manager_how === "spoc_manager")).toBe(true);
  });

  it("bills a fee group once per period at the group's amount", async () => {
    const rows = (await dues()).filter((r) => r.fee_group_id === groupId);
    expect(rows.map((r) => [r.period_label, r.amount, r.engagement_id])).toEqual([
      ["Oct 2026", "9000.00", null],
      ["Nov 2026", "9000.00", null],
    ]);
  });

  it("pro-rates an ended quarter by days, in the database", async () => {
    const rows = (await dues()).filter((r) => r.engagement_id === quarterlyEnded);
    expect(rows).toHaveLength(1);
    // 61 of 92 days of 30,000: 19,891.304... rounded to the paisa.
    expect(rows[0]).toMatchObject({ served_days: 61, period_days: 92, full_amount: "30000.0000", amount: "19891.30" });
  });

  it("writes nothing the second time, and the unique keys refuse a copy", async () => {
    const [again] = await service([tenantId]).sweep();
    expect(again).toMatchObject({ created: 0 });

    const copy = await writer.insert(tenantId, [
      {
        id: systemIds.newId(),
        partyId: client,
        issuingEntityPartyId: firm,
        currency: "INR",
        engagementId: monthly,
        feeGroupId: null,
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        periodLabel: "Oct 2026",
        billOn: "2026-11-01",
        fullAmount: "1.0000",
        servedDays: 31,
        periodDays: 31,
        managerUserId: null,
        managerHow: "none",
        managerNote: "copy",
      },
    ]);
    expect(copy).toEqual([]);
  });

  it("keeps a missing price missing", async () => {
    // A line priced "as agreed": the due is written with no amount at all,
    // never a zero somebody could issue.
    const [id] = await writer.insert(tenantId, [
      {
        id: systemIds.newId(),
        partyId: client,
        issuingEntityPartyId: firm,
        currency: "INR",
        engagementId: unscheduled,
        feeGroupId: null,
        periodStart: "2026-06-01",
        periodEnd: "2026-06-30",
        periodLabel: "Jun 2026",
        billOn: "2026-07-01",
        fullAmount: null,
        servedDays: 30,
        periodDays: 30,
        managerUserId: manager,
        managerHow: "spoc_manager",
        managerNote: null,
      },
    ]);
    const [row] = await owner<{ full_amount: string | null; amount: string | null }[]>`
      SELECT full_amount::text, amount::text FROM crm.billing_due WHERE id = ${id ?? ""}
    `;
    expect(row).toEqual({ full_amount: null, amount: null });
    // Out of the desk's way: the desk tests below count what the sweep wrote.
    await owner`
      UPDATE crm.billing_due SET skipped_at = now(), skipped_by_user_id = ${manager}, skip_reason = 'test row'
       WHERE id = ${id ?? ""}
    `;
  });

  it("offers a firm to the sweep only once it turns auto-billing on", async () => {
    const firms = new PostgresAutoBillingFirms(app);
    expect(await firms.firmsWithAutoBilling()).not.toContain(tenantId);
    await owner`UPDATE tenancy.tenant SET auto_billing = true WHERE id = ${tenantId}`;
    expect(await firms.firmsWithAutoBilling()).toContain(tenantId);
  });

  it("reads and moves the go-live day inside the firm (Q027)", async () => {
    const firms = new PostgresAutoBillingFirms(app);
    const setting = new PostgresAutoBillingSetting(app);
    const before = await setting.since(tenantId);
    await setting.setSince(tenantId, "2026-11-01");
    expect(await firms.billingStartsOn(tenantId)).toBe("2026-11-01");
    expect(await setting.since(tenantId)).toBe("2026-11-01");
    await owner`UPDATE tenancy.tenant SET auto_billing_since = ${before} WHERE id = ${tenantId}`;
  });
});

describe("the billing desk on a real database (0318)", () => {
  const invoiceRepository = new PostgresInvoiceRepository(app);
  const clock = { now: () => new Date("2026-12-05T06:00:00Z") };
  const invoicing = new InvoiceService({
    invoices: invoiceRepository,
    timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
    firmEntities: { isFirmEntity: (_t: string, partyId: string) => Promise.resolve(partyId === firm) },
    parties: { findParty: () => Promise.resolve(null) },
    ids: systemIds,
    clock,
    events: new RecordingEventSink(),
    issuedCopies: { file: () => Promise.resolve() },
    staff: new FakeStaffDirectory(),
    settings: new PostgresInvoiceFirmSettings(app),
  });
  const deskAdapter = new PostgresBillingDueDesk(app);
  const desk = new BillingDeskService({
    desk: deskAdapter,
    invoices: {
      prepareDraft: (input) => invoicing.prepareDraft(input),
      prepareLine: (draft, input) => invoicing.prepareLine(draft, input),
      recordRaised: (invoice, actor) => invoicing.recordRaised(invoice, actor),
      find: (t, id) => invoiceRepository.find(t, id),
      issueCreditNote: (input, actor) => invoicing.issueCreditNote(input, actor),
    },
    schedules: new PostgresBillingSchedules(app),
    setting: new PostgresAutoBillingSetting(app),
    fiscalYears: new FakeFiscalYearSource(4),
    timeZones: new FakeFirmTimeZone("Asia/Kolkata"),
    clock,
    events: new RecordingEventSink(),
    taxDefaults: new PostgresIssuerTaxDefaults(app),
    policy: new PostgresAdvancePolicy(app),
    firmEntities: { isFirmEntity: () => Promise.resolve(true) },
  });
  let me: Actor = { type: "system", id: null };
  let invoiceId = "";

  async function monthlyDues() {
    return (await desk.list({ tenantId, filters: { status: "all" } })).dues.filter((d) => d.engagementId === monthly);
  }

  it("reads every due by name, with its status derived", async () => {
    me = { type: "human", id: manager };
    const { dues } = await desk.list({ tenantId, filters: { status: "all" } });
    const oct = dues.find((d) => d.engagementId === monthly && d.periodLabel === "Oct 2026");
    expect(oct).toMatchObject({
      party: { id: client },
      issuer: { id: firm, displayName: "The Firm" },
      // The letter line's wording, not the catalogue's "Bookkeeping".
      serviceName: "Accounting and bookkeeping",
      // The live service's module: how a bill with no price finds its SPOC.
      deptCodes: ["FRC"],
      priced: true,
      entityName: `Kaveri Foods ${stamp}`,
      engagementIds: [monthly],
      letter: { ref: "EL-2026-0001", fxRate: "1.0000000000" },
      manager: { userId: manager, email: `manager-${stamp}@example.test` },
      status: "open",
      invoice: null,
      skipped: null,
      lastTaxPercent: null,
      daysSinceBillOn: 34,
      escalated: true,
    });
    const group = dues.find((d) => d.feeGroupId === groupId);
    expect(group?.serviceName).toBe("Retainer");
    expect(group?.engagementIds).toHaveLength(2);
  });

  it("decides My day in the query, before the ceiling (review item 14)", async () => {
    const mineOn = (userId: string, today: string) =>
      deskAdapter.list(tenantId, { mine: { userId, isAdmin: false, today, escalateAfterDays: 7 } });
    const forManager = await mineOn(manager, "2026-12-05");
    expect(forManager.length).toBeGreaterThan(0);
    expect(forManager.every((d) => d.kind !== "advance" && (d.status === "open" || d.status === "drafted"))).toBe(true);
    expect(
      forManager.every((d) => d.manager?.userId === manager || d.managerReportsTo?.userId === manager || d.fullAmount === null),
    ).toBe(true);
    // Somebody with no bill, no report and no SPOC duty sees nothing.
    expect(await mineOn(client, "2026-12-05")).toEqual([]);
  });

  it("raises a draft from two dues, a line each, in the manager's kitty", async () => {
    const mine = await monthlyDues();
    const out = await desk.raise(
      { tenantId, dueIds: mine.map((d) => d.id), lines: mine.map((d) => ({ dueId: d.id, taxPercent: "18" })) },
      me,
    );
    invoiceId = out.invoiceId ?? "";
    expect(out.conflicts).toEqual([]);
    // A draft: numbered when an admin issues it (0322).
    expect(out.number).toBeNull();

    const [inv] = await owner<{ manager_user_id: string; status: string }[]>`
      SELECT manager_user_id, status FROM crm.invoice WHERE id = ${invoiceId}
    `;
    expect(inv).toEqual({ manager_user_id: manager, status: "draft" });
    const lines = await owner<{ description: string; unit_amount: string; tax_percent: string; engagement_id: string }[]>`
      SELECT description, unit_amount::text, tax_percent::text, engagement_id
        FROM crm.invoice_line WHERE invoice_id = ${invoiceId} ORDER BY position
    `;
    expect(lines).toEqual([
      { description: "Accounting and bookkeeping, Oct 2026", unit_amount: "25000.0000", tax_percent: "18.00", engagement_id: monthly },
      { description: "Accounting and bookkeeping, Nov 2026", unit_amount: "25000.0000", tax_percent: "18.00", engagement_id: monthly },
    ]);
    const after = await monthlyDues();
    expect(after.map((d) => d.status)).toEqual(["drafted", "drafted"]);
    expect(after[0]?.invoice).toMatchObject({ id: invoiceId, status: "draft" });
    // The next bill for this engagement offers the rate it was billed at.
    expect(after[0]?.lastTaxPercent).toBe("18.00");
  });

  it("offers a manual line the rate last used on that work, else the company's default (CA#5)", async () => {
    // A line typed by hand started at 0% tax although the firm had saved 18%:
    // a hurried accounts person issued a tax invoice with no tax on it.
    const record = await new PostgresInvoiceRepository(app).describe(tenantId, invoiceId);
    expect(record?.taxSuggestions.byEngagement).toEqual([{ engagementId: monthly, taxPercent: "18.00" }]);
    expect(record?.taxSuggestions.companyDefault).toBeNull();
    await owner`
      INSERT INTO crm.issuer_tax_default (tenant_id, entity_party_id, tax_percent) VALUES (${tenantId}, ${firm}, 12)
    `;
    const after = await new PostgresInvoiceRepository(app).describe(tenantId, invoiceId);
    await owner`DELETE FROM crm.issuer_tax_default WHERE tenant_id = ${tenantId}`;
    expect(after?.taxSuggestions.companyDefault).toBe("12.00");
  });

  it("refuses to raise a due that is already on an invoice", async () => {
    const [drafted] = await monthlyDues();
    if (drafted === undefined) throw new Error("no drafted due");
    await expect(
      desk.raise({ tenantId, dueIds: [drafted.id], lines: [{ dueId: drafted.id, taxPercent: "18" }] }, me),
    ).rejects.toMatchObject({ code: "BILLING_DUE_NOT_OPEN" });
  });

  it("settles a due only once, whoever asks second", async () => {
    const [group] = (await desk.list({ tenantId, filters: { status: "all" } })).dues.filter((d) => d.feeGroupId === groupId);
    if (group === undefined) throw new Error("no group due");
    expect(await deskAdapter.skip(tenantId, group.id, manager, "Waived")).toBe(true);
    expect(await deskAdapter.skip(tenantId, group.id, manager, "Again")).toBe(false);
    expect(await deskAdapter.markInvoiced(tenantId, group.id, invoiceId, null)).toBe(false);
    const [after] = await deskAdapter.findMany(tenantId, [group.id]);
    expect(after).toMatchObject({ status: "skipped", skipped: { reason: "Waived", by: { userId: manager } } });
  });

  it("opens a due again when its invoice is cancelled", async () => {
    await invoicing.cancel(tenantId, invoiceId, me);
    const again = await monthlyDues();
    expect(again.map((d) => d.status)).toEqual(["open", "open"]);
    expect(again[0]?.invoice).toMatchObject({ id: invoiceId, status: "cancelled" });
  });

  it("freezes whose revenue an invoice is once it is issued", async () => {
    const mine = await monthlyDues();
    const out = await desk.raise(
      { tenantId, dueIds: mine.map((d) => d.id), lines: mine.map((d) => ({ dueId: d.id, taxPercent: "18" })) },
      me,
    );
    const raised = out.invoiceId ?? "";
    await invoicing.issue(tenantId, raised, me, "2026-12-05");
    await expect(
      owner`UPDATE crm.invoice SET manager_user_id = ${keyManager} WHERE id = ${raised}`,
    ).rejects.toThrow(/cannot change/);
    expect((await monthlyDues()).map((d) => d.status)).toEqual(["billed", "billed"]);
    invoiceId = raised;
  });

  it("names its manager and the engagement letter it bills, on the read and on the PDF", async () => {
    const record = await invoiceRepository.describe(tenantId, invoiceId);
    expect(record?.manager).toMatchObject({ userId: manager, email: `manager-${stamp}@example.test` });
    expect(record?.letters.map((l) => l.ref)).toEqual(["EL-2026-0001"]);

    const source = new PostgresRenderSource(app, () => Promise.resolve(null));
    const described = await source.describe({ tenantId, kind: "invoice", subjectRef: invoiceId });
    expect(described?.document.meta).toContainEqual({ label: "Engagement letter", value: "EL-2026-0001" });
  });

  it("lists the engagement with no schedule and sets one, snapped to its period", async () => {
    const rows = await desk.unscheduled(tenantId);
    const row = rows.find((r) => r.engagementId === unscheduled);
    expect(row).toMatchObject({
      serviceName: "Accounting and bookkeeping",
      billingFrequency: "monthly",
      // Billed on its last day (Q042).
      suggestion: { billingFrom: "2026-12-01", firstInvoiceOn: "2026-12-31" },
    });
    expect(rows.some((r) => r.engagementId === monthly)).toBe(false);

    const set = await desk.setSchedule(
      { tenantId, engagementId: unscheduled, billingFrom: "2026-12-10", firstInvoiceOn: "2027-01-01" },
      me,
    );
    expect(set).toMatchObject({ billingFrom: "2026-12-01", firstInvoiceOn: "2027-01-01" });
  });

  it("turns the firm's switch", async () => {
    await desk.setAutoBilling(tenantId, false, me);
    expect(await desk.autoBilling(tenantId)).toBe(false);
    await desk.setAutoBilling(tenantId, true, me);
    expect(await desk.autoBilling(tenantId)).toBe(true);
  });
});
