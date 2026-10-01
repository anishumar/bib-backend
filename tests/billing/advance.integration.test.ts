// The advance and the final bill against a REAL database (auto-invoice, phase
// 2, 0320), because every claim below is about SQL a fake cannot reproduce.
//
// ── WHAT IS PROVED HERE AND NOWHERE ELSE ───────────────────────────────────
//
//   1. THE ADVANCE BILL: a signed letter waiting on its advance owes one bill,
//      read by the catch-up, written once; a service's own advance is its own.
//   2. THE WORK STARTS when the advance invoice is PAID IN FULL (the payment
//      itself tells the gate), and on a part payment only by an admin's
//      Approve start; the engagements move, the letter records it.
//   3. THE FINAL BILL: a one-time service's job finishing writes it, at the
//      letter's price, dated the day the job finished.
//   4. FIFO, BEFORE TAX: `crm.advance_pool` says what is left; the earliest
//      bill takes it first; the invoice line bills the balance; a bill the
//      advance pays in full raises no invoice (covered).
//   5. THE REFUND: once the work is finished, what is left comes back as a
//      credit note with the reason `advance_refund`, tax included.
//   6. THE WALLS: no advance on a grouped line, never both kinds on a letter.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/billing/advance.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import {
  PostgresBillingDueWriter,
  PostgresBillingManagerFacts,
} from "../../src/infrastructure/postgres/billing-repository";
import {
  PostgresAutoBillingSetting,
  PostgresBillingDueDesk,
  PostgresBillingSchedules,
} from "../../src/infrastructure/postgres/billing-desk";
import { PostgresAdvanceBillFacts, PostgresFinalBillFacts } from "../../src/infrastructure/postgres/billing-facts";
import { PostgresEngagementRepository } from "../../src/infrastructure/postgres/engagement-repository";
import { PostgresInvoiceRepository } from "../../src/infrastructure/postgres/invoice-repository";
import { systemIds } from "../../src/platform/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { FakeAutoBillingFirms, FakeFiscalYearSource } from "../../src/testfakes/billing";
import { AdvanceBiller, AdvanceGate } from "../../src/usecase/billing/advance";
import { FinalBiller } from "../../src/usecase/billing/final";
import { BillingDeskService } from "../../src/usecase/billing/desk";
import { InvoiceService } from "../../src/usecase/invoice/service";
import type { Actor } from "../../src/domain/ledger/model";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import { FakeStaffDirectory } from "../../src/testfakes/lead";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 4 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const stamp = Date.now().toString(36);
let tenantId = "";
let firm = "";
let client = "";
let manager = "";
let admin = "";
let audit = "";
let books = "";
let letterA = "";
let auditA = "";
let booksA = "";
let letterB = "";
let auditB = "";
let me: Actor = SYSTEM_ACTOR;

const clock = { now: () => new Date("2026-12-05T06:00:00Z") };
const zone = new FakeFirmTimeZone("Asia/Kolkata");
const events = new RecordingEventSink();
const writer = new PostgresBillingDueWriter(app);
const managers = new PostgresBillingManagerFacts(app);
const engagements = new PostgresEngagementRepository(app);
const invoiceRepository = new PostgresInvoiceRepository(app);
const deskAdapter = new PostgresBillingDueDesk(app);

const advances = new AdvanceBiller({ facts: new PostgresAdvanceBillFacts(app), dues: writer, managers, ids: systemIds, events });
const gate = new AdvanceGate({
  desk: deskAdapter,
  // The engagement use case's release, at the adapter: the rows the gate moves.
  work: {
    recordAdvance: (t, letterId, by) => engagements.recordAdvance(t, letterId, by, clock.now().toISOString()),
    releaseEngagementAdvance: (t, engagementId) =>
      engagements.releaseEngagements(t, [engagementId], clock.now().toISOString()),
  },
  events,
});
const invoicing = new InvoiceService({
  invoices: invoiceRepository,
  timeZones: zone,
  firmEntities: { isFirmEntity: (_t: string, partyId: string) => Promise.resolve(partyId === firm) },
  parties: { findParty: () => Promise.resolve(null) },
  ids: systemIds,
  clock,
  events,
  issuedCopies: { file: () => Promise.resolve() },
  moneyMoved: gate,
  staff: new FakeStaffDirectory(),
});
const desk = new BillingDeskService({
  desk: deskAdapter,
  invoices: {
    raise: (input, actor) => invoicing.raise(input, actor),
    addLine: (input) => invoicing.addLine(input),
    find: (t, id) => invoiceRepository.find(t, id),
    issueCreditNote: (input, actor) => invoicing.issueCreditNote(input, actor),
  },
  schedules: new PostgresBillingSchedules(app),
  setting: new PostgresAutoBillingSetting(app),
  fiscalYears: new FakeFiscalYearSource(4),
  timeZones: zone,
  clock,
  events,
  gate,
});
const finals = new FinalBiller({
  facts: new PostgresFinalBillFacts(app),
  dues: writer,
  managers,
  setting: new PostgresAutoBillingSetting(app),
  firms: new FakeAutoBillingFirms([]),
  timeZones: zone,
  clock,
  ids: systemIds,
  events,
});

async function user(name: string, role: string): Promise<string> {
  const [u] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`${name}-${stamp}@example.test`}, ${name}) RETURNING id
  `;
  if (!u) throw new Error("user seed failed");
  await owner`INSERT INTO tenancy.membership (tenant_id, user_id, audience, role) VALUES (${tenantId}, ${u.id}, 'STAFF', ${role})`;
  return u.id;
}

async function company(name: string): Promise<string> {
  const [p] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name) VALUES (${tenantId}, 'organization', ${name}) RETURNING id
  `;
  if (!p) throw new Error("party seed failed");
  await owner`INSERT INTO core.organization (party_id, tenant_id, legal_name) VALUES (${p.id}, ${tenantId}, ${name})`;
  return p.id;
}

async function service(key: string, recurrence: string): Promise<string> {
  const [entry] = await owner<{ id: string }[]>`
    INSERT INTO config.entry (tenant_id, kind, key) VALUES (${tenantId}, 'service', ${`${key}-${stamp}`}) RETURNING id
  `;
  if (!entry) throw new Error("service seed failed");
  const [version] = await owner<{ id: string }[]>`
    INSERT INTO config.version (tenant_id, entry_id, version, body, status, published_at)
    VALUES (${tenantId}, ${entry.id}, 1, ${owner.json({ name: key, recurrence, module: "FRC" })}, 'published', now())
    RETURNING id
  `;
  if (!version) throw new Error("version seed failed");
  return version.id;
}

let refs = 0;
async function letter(advance: string | null): Promise<string> {
  refs += 1;
  const [l] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter
      (tenant_id, party_id, status, currency, fx_rate, fx_rate_date, ref, issuing_entity_party_id,
       jurisdiction, title, advance_required, advance_amount)
    VALUES (${tenantId}, ${client}, 'draft', 'INR', 1, CURRENT_DATE, ${`EL-2026-${String(refs).padStart(4, "0")}`},
            ${firm}, 'IN', 'Engagement', ${advance !== null}, ${advance}::numeric)
    RETURNING id
  `;
  if (!l) throw new Error("letter seed failed");
  return l.id;
}

async function line(
  letterId: string,
  position: number,
  version: string,
  frequency: string,
  amount: number,
  advance: number | null = null,
): Promise<string> {
  const [ln] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter_line
      (tenant_id, engagement_letter_id, position, service_version_id, quantity, unit_amount, currency,
       discount_percent, billing_frequency, entity_party_id, description, advance_amount)
    VALUES (${tenantId}, ${letterId}, ${position}, ${version}, 1, ${amount}, 'INR', 0, ${frequency},
            ${client}, ${frequency === "one_time" ? "Statutory audit FY 2025-26" : "Bookkeeping"}, ${advance})
    RETURNING id
  `;
  if (!ln) throw new Error("line seed failed");
  return ln.id;
}

async function signAndFanOut(letterId: string, lines: readonly string[]): Promise<string[]> {
  await owner`
    UPDATE crm.engagement_letter
       SET status = 'signed', sent_at = now(), signed_at = now(), signed_by_name = 'A Director',
           signature_method = 'attested', signed_content_hash = ${"c".repeat(64)}
     WHERE id = ${letterId}
  `;
  const ids: string[] = [];
  for (const lineId of lines) {
    const [e] = await owner<{ id: string }[]>`
      INSERT INTO crm.engagement
        (tenant_id, party_id, entity_party_id, engagement_letter_id, engagement_letter_line_id, effective_from, status)
      VALUES (${tenantId}, ${client}, ${client}, ${letterId}, ${lineId}, '2026-10-01'::date, 'pending_advance')
      RETURNING id
    `;
    if (!e) throw new Error("engagement seed failed");
    ids.push(e.id);
  }
  return ids;
}

async function finishJob(engagementId: string, finishedAt: string): Promise<string> {
  const [j] = await owner<{ id: string }[]>`
    INSERT INTO delivery.job (tenant_id, source_kind, source_ref, status, started_at, finished_at)
    VALUES (${tenantId}, 'engagement', ${engagementId}, 'done', ${finishedAt}::timestamptz, ${finishedAt}::timestamptz)
    RETURNING id
  `;
  if (!j) throw new Error("job seed failed");
  await owner`INSERT INTO delivery.job_engagement (tenant_id, job_id, engagement_id) VALUES (${tenantId}, ${j.id}, ${engagementId})`;
  return j.id;
}

async function advanceDue(letterId: string) {
  return (await desk.list({ tenantId })).dues.find((d) => d.kind === "advance" && d.letter.id === letterId);
}

async function statuses(ids: readonly string[]): Promise<string[]> {
  const rows = await owner<{ id: string; status: string }[]>`
    SELECT id, status FROM crm.engagement WHERE id = ANY(${owner.array(ids as string[])}::uuid[])
  `;
  return ids.map((id) => rows.find((r) => r.id === id)?.status ?? "?");
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, auto_billing)
    VALUES (${`advance-${stamp}`}, 'Advance Test', 'INR', true) RETURNING id
  `;
  if (!t) throw new Error("tenant seed failed");
  tenantId = t.id;

  const spoc = await user("spoc", "manager");
  manager = await user("manager", "manager");
  admin = await user("admin", "partner");
  me = { type: "human", id: manager };
  await owner`UPDATE tenancy.membership SET reports_to_user_id = ${manager} WHERE tenant_id = ${tenantId} AND user_id = ${spoc}`;

  firm = await company("The Firm");
  await owner`INSERT INTO crm.firm_entity (tenant_id, party_id) VALUES (${tenantId}, ${firm})`;
  client = await company(`Kaveri Foods ${stamp}`);
  const [axis] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.service_axis (tenant_id, axis, code, name) VALUES (${tenantId}, 'dept', 'FRC', 'Financial Reporting')
    RETURNING id
  `;
  if (!axis) throw new Error("axis seed failed");
  await owner`
    INSERT INTO crm.client_assignment (tenant_id, client_party_id, role, axis_id, user_id, valid_from)
    VALUES (${tenantId}, ${client}, 'spoc', ${axis.id}, ${spoc}, '2026-01-01')
  `;

  audit = await service("audit", "one_time");
  books = await service("books", "monthly");

  // Letter A: one advance of 50,000 for the whole letter; an audit and
  // monthly bookkeeping.
  letterA = await letter("50000");
  const auditLine = await line(letterA, 1, audit, "one_time", 100000);
  const booksLine = await line(letterA, 2, books, "monthly", 30000);
  [auditA = "", booksA = ""] = await signAndFanOut(letterA, [auditLine, booksLine]);

  // Letter B: no letter advance; the audit has its OWN advance of 40,000 on a
  // fee of 30,000, so the advance covers the bill and 10,000 is left over.
  letterB = await letter(null);
  const auditLineB = await line(letterB, 1, audit, "one_time", 30000, 40000);
  [auditB = ""] = await signAndFanOut(letterB, [auditLineB]);
});

afterAll(async () => {
  await owner`
    UPDATE crm.engagement SET status = 'cancelled', activated_at = coalesce(activated_at, now())
     WHERE tenant_id = ${tenantId} AND ended_at IS NULL
  `;
  await owner`UPDATE tenancy.tenant SET auto_billing = false WHERE id = ${tenantId}`;
  await app.end();
  await owner.end();
});

describe("the advance bill and the gate on a real database (0320)", () => {
  it("finds the letters owing an advance bill, and writes each once", async () => {
    const owing = await new PostgresAdvanceBillFacts(app).lettersOwingAdvanceBills(tenantId);
    expect(new Set(owing)).toEqual(new Set([letterA, letterB]));
    expect(await advances.billAdvances({ tenantId, letterId: letterA }, SYSTEM_ACTOR)).toEqual({ created: 1 });
    expect(await advances.billAdvances({ tenantId, letterId: letterA }, SYSTEM_ACTOR)).toEqual({ created: 0 });
    expect(await advances.billAdvances({ tenantId, letterId: letterB }, SYSTEM_ACTOR)).toEqual({ created: 1 });
    expect(await new PostgresAdvanceBillFacts(app).lettersOwingAdvanceBills(tenantId)).toEqual([]);

    const a = await advanceDue(letterA);
    expect(a).toMatchObject({
      kind: "advance",
      engagementLetterId: letterA,
      engagementId: null,
      serviceName: "All services",
      fullAmount: "50000.0000",
      amount: "50000.00",
      status: "open",
    });
    expect(a?.engagementIds).toHaveLength(2);
    const b = await advanceDue(letterB);
    expect(b).toMatchObject({ engagementId: auditB, serviceName: "Statutory audit FY 2025-26", amount: "40000.00" });
  });

  it("starts the letter's work on a part payment only when an admin approves", async () => {
    const a = await advanceDue(letterA);
    if (a === undefined) throw new Error("no advance bill");
    const out = await desk.raise({ tenantId, dueIds: [a.id], lines: [{ dueId: a.id, taxPercent: "18" }] }, me);
    expect(out.invoiceId).not.toBeNull();
    const invoiceId = out.invoiceId ?? "";
    await invoicing.issue(tenantId, invoiceId, me, "2026-12-05");
    await invoicing.recordPayment(
      { tenantId, invoiceId, amount: "20000", receivedOn: "2026-12-05", method: "bank_transfer" },
      me,
    );
    expect(await statuses([auditA, booksA])).toEqual(["pending_advance", "pending_advance"]);
    expect((await gate.list(tenantId)).find((x) => x.id === a.id)?.state).toBe("part_paid");

    const after = await gate.approveStart({ tenantId, dueId: a.id }, { type: "human", id: admin });
    expect(after.state).toBe("started");
    expect(after.released).toMatchObject({ how: "approved", by: { userId: admin } });
    expect(await statuses([auditA, booksA])).toEqual(["active", "active"]);
    const [l] = await owner<{ advance_recorded_by: string | null }[]>`
      SELECT advance_recorded_by FROM crm.engagement_letter WHERE id = ${letterA}
    `;
    expect(l?.advance_recorded_by).toBe(admin);
  });

  it("starts a service's own work by itself once its advance invoice is paid in full", async () => {
    const b = await advanceDue(letterB);
    if (b === undefined) throw new Error("no advance bill");
    const out = await desk.raise({ tenantId, dueIds: [b.id], lines: [{ dueId: b.id, taxPercent: "18" }] }, me);
    const invoiceId = out.invoiceId ?? "";
    await invoicing.issue(tenantId, invoiceId, me, "2026-12-05");
    // 40,000 plus 18% GST: the advance is before tax.
    await invoicing.recordPayment(
      { tenantId, invoiceId, amount: "47200", receivedOn: "2026-12-05", method: "bank_transfer" },
      me,
    );
    expect(await statuses([auditB])).toEqual(["active"]);
    const [row] = await owner<{ released_how: string | null }[]>`SELECT released_how FROM crm.billing_due WHERE id = ${b.id}`;
    expect(row?.released_how).toBe("paid");
  });
});

describe("the final bill and FIFO on a real database (0320)", () => {
  it("takes the earliest bill first: a month of bookkeeping off the letter's advance", async () => {
    // October's bookkeeping, written as the period sweep would.
    await writer.insert(tenantId, [
      {
        id: systemIds.newId(),
        partyId: client,
        issuingEntityPartyId: firm,
        currency: "INR",
        engagementId: booksA,
        feeGroupId: null,
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        periodLabel: "Oct 2026",
        billOn: "2026-11-01",
        fullAmount: "30000",
        servedDays: 31,
        periodDays: 31,
        managerUserId: manager,
        managerHow: "spoc_manager",
        managerNote: null,
      },
    ]);
    const oct = (await desk.list({ tenantId })).dues.find((d) => d.engagementId === booksA && d.kind === "period");
    expect(oct?.advancePool).toMatchObject({ remaining: "50000.00" });
    const out = await desk.raise({ tenantId, dueIds: [oct?.id ?? ""], lines: [{ dueId: oct?.id ?? "", taxPercent: "18" }] }, me);
    expect(out.covered).toEqual([oct?.id]);
    expect(out.invoiceId).toBeNull();
    const [pool] = await owner<{ remaining: string }[]>`
      SELECT remaining::text FROM crm.advance_pool WHERE engagement_letter_id = ${letterA}
    `;
    expect(pool?.remaining).toBe("20000.00");
  });

  it("writes the audit's final bill when its job finishes, and bills the balance after the advance", async () => {
    const jobId = await finishJob(auditA, "2026-11-20T05:00:00Z");
    expect(await finals.jobDone({ tenantId, jobId }, SYSTEM_ACTOR)).toEqual({ created: 1 });
    const fin = (await desk.list({ tenantId })).dues.find((d) => d.engagementId === auditA && d.kind === "final");
    expect(fin).toMatchObject({ billOn: "2026-11-20", amount: "100000.00", periodLabel: "Final" });
    expect(fin?.advancePool).toMatchObject({ remaining: "20000.00" });

    const out = await desk.raise({ tenantId, dueIds: [fin?.id ?? ""], lines: [{ dueId: fin?.id ?? "", taxPercent: "18" }] }, me);
    const [ln] = await owner<{ unit_amount: string; description: string }[]>`
      SELECT unit_amount::text, description FROM crm.invoice_line WHERE invoice_id = ${out.invoiceId ?? ""}
    `;
    expect(ln?.unit_amount).toBe("80000.0000");
    expect(ln?.description).toMatch(/^Statutory audit FY 2025-26, final bill: fee INR 1,00,000.00 less advance INR 20,000.00 \(/);
    expect(await finals.jobDone({ tenantId, jobId }, SYSTEM_ACTOR)).toEqual({ created: 0 });
  });

  it("refuses, under the lock, to take more than is left of an advance", async () => {
    const [adv] = await owner<{ invoice_id: string }[]>`
      SELECT invoice_id FROM crm.advance_pool WHERE engagement_letter_id = ${letterA}
    `;
    const [spare] = await owner<{ id: string }[]>`
      SELECT id FROM crm.billing_due WHERE tenant_id = ${tenantId} AND kind = 'period' AND engagement_id = ${booksA}
    `;
    // Nothing is left; the October bill is covered, not open, so it is the
    // pool, not the bill, that refuses here.
    expect(await deskAdapter.markCovered(tenantId, spare?.id ?? "", { invoiceId: adv?.invoice_id ?? "", amount: "1" })).toBe(false);
  });

  it("covers a bill the service's own advance pays in full, and offers the rest back", async () => {
    const jobId = await finishJob(auditB, "2026-11-25T05:00:00Z");
    await finals.jobDone({ tenantId, jobId }, SYSTEM_ACTOR);
    const fin = (await desk.list({ tenantId })).dues.find((d) => d.engagementId === auditB && d.kind === "final");
    const out = await desk.raise({ tenantId, dueIds: [fin?.id ?? ""], lines: [{ dueId: fin?.id ?? "", taxPercent: "18" }] }, me);
    expect(out).toMatchObject({ invoiceId: null, covered: [fin?.id] });
    expect((await desk.list({ tenantId })).dues.find((d) => d.id === fin?.id)?.status).toBe("covered");

    const refunds = await desk.refunds(tenantId);
    expect(refunds.map((r) => [r.advance.engagementId, r.remaining, r.refundAmount])).toEqual([
      // 10,000 left before tax; the credit note gives back its 18% too.
      [auditB, "10000.00", "11800.00"],
    ]);
    // Letter A's advance is used up and its bookkeeping goes on: not listed.

    const note = await desk.refund({ tenantId, dueId: refunds[0]?.advance.id ?? "", asOf: "2026-12-05" }, { type: "human", id: admin });
    const [cn] = await owner<{ amount: string; reason: string }[]>`
      SELECT amount::text, reason FROM crm.credit_note WHERE id = ${note.id}
    `;
    expect(cn).toEqual({ amount: "11800.0000", reason: "advance_refund" });
    expect(await desk.refunds(tenantId)).toEqual([]);
  });
});

describe("the walls (0320)", () => {
  it("refuses an advance on a grouped line, and both kinds of advance on one letter", async () => {
    const l = await letter("1000");
    await expect(line(l, 1, audit, "one_time", 5000, 500)).rejects.toThrow(/whole letter/);
    const n = await letter(null);
    await line(n, 1, audit, "one_time", 5000, 500);
    await expect(
      owner`UPDATE crm.engagement_letter SET advance_required = true, advance_amount = 1000 WHERE id = ${n}`,
    ).rejects.toThrow(/own advance/);
    const [g] = await owner<{ id: string }[]>`
      INSERT INTO crm.engagement_letter_fee_group (tenant_id, engagement_letter_id, currency, position, title, billing_frequency, amount)
      VALUES (${tenantId}, ${n}, 'INR', 1, 'Retainer', 'monthly', 9000) RETURNING id
    `;
    await expect(
      owner`
        INSERT INTO crm.engagement_letter_line
          (tenant_id, engagement_letter_id, position, service_version_id, quantity, currency, discount_percent,
           billing_frequency, entity_party_id, description, fee_group_id, advance_amount)
        VALUES (${tenantId}, ${n}, 2, ${books}, 1, 'INR', 0, 'monthly', ${client}, 'Grouped', ${g?.id ?? ""}, 100)
      `,
    ).rejects.toThrow(/el_line_grouped_has_no_advance_chk/);
  });
});
