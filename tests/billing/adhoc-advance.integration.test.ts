// The ad-hoc advance against a REAL database (0363, Q044-Q048), because every
// claim below is about SQL a fake cannot reproduce: the pool's derived
// balances, the lock a map shares with the raise of a bill, the trigger walls
// and the tenant wall.
//
// ── WHAT IS PROVED HERE ────────────────────────────────────────────────────
//
//   1. RAISE: a draft tax invoice and its advance row in one write; issued,
//      it is all unmapped.
//   2. MAP SUMS: split across two services of two managers, never more than is
//      left (refused, nothing written); the unmapped balance is derived.
//   3. CURRENCY: an AED advance against an INR service is refused by the use
//      case and, for any other writer, by the trigger.
//   4. FIFO: a mapped part comes off that service's earliest bill, before tax;
//      the invoice line bills the balance.
//   5. RE-MAP AFTER PARTIAL CONSUMPTION: ending a mapping keeps what bills took
//      and frees the rest; one its bills took in full cannot move.
//   6. CANCEL AND CREDIT: a mapped advance cannot be cancelled; a credit note
//      gives back only the unmapped part.
//   7. SCENARIO 1: a letter names the advance, is signed, and maps it to
//      itself (once), FIFO over its bills.
//   8. REVENUE: `invoice_manager_share` splits the advance by its mappings'
//      managers; an ordinary invoice is one row, as before.
//   9. THE WALL: another firm sees none of it and cannot point at it.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/billing/adhoc-advance.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withTenant } from "../../src/db/tenant";
import {
  PostgresBillingDueWriter,
  PostgresBillingManagerFacts,
} from "../../src/infrastructure/postgres/billing-repository";
import {
  PostgresAutoBillingSetting,
  PostgresBillingDueDesk,
  PostgresBillingSchedules,
} from "../../src/infrastructure/postgres/billing-desk";
import { PostgresInvoiceRepository } from "../../src/infrastructure/postgres/invoice-repository";
import { PostgresAdhocAdvanceStore } from "../../src/infrastructure/postgres/adhoc-advance";
import { PostgresAdvancePolicy, PostgresIssuerTaxDefaults } from "../../src/infrastructure/postgres/advance-reminders";
import { PostgresInvoiceFirmSettings } from "../../src/infrastructure/postgres/invoice-settings";
import { systemIds } from "../../src/platform/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { FakeFiscalYearSource } from "../../src/testfakes/billing";
import { FakeStaffDirectory } from "../../src/testfakes/lead";
import { BillingDeskService } from "../../src/usecase/billing/desk";
import { AdhocAdvanceService } from "../../src/usecase/billing/adhoc";
import { InvoiceService } from "../../src/usecase/invoice/service";
import type { Actor } from "../../src/domain/ledger/model";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";
import {
  AdvanceInAnotherCurrency,
  AdvanceNotIssued,
  AdvanceOfAnotherIssuer,
  AdvanceOverMapped,
  AllocationUsedUp,
  NothingToRefund,
} from "../../src/domain/billing/errors";
import { CreditExceedsUnusedAdvance, InvoiceAdvanceMapped } from "../../src/domain/invoice/errors";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 4 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const stamp = Date.now().toString(36);
let tenantId = "";
let otherTenant = "";
let firm = "";
let gulf = "";
let client = "";
let managerFrc = "";
let managerTrc = "";
let keyManager = "";
let books = "";
let incorp = "";
let aedService = "";
let me: Actor = SYSTEM_ACTOR;

const clock = { now: () => new Date("2026-12-05T06:00:00Z") };
const zone = new FakeFirmTimeZone("Asia/Kolkata");
const events = new RecordingEventSink();
const writer = new PostgresBillingDueWriter(app);
const managers = new PostgresBillingManagerFacts(app);
const invoiceRepository = new PostgresInvoiceRepository(app);
const deskAdapter = new PostgresBillingDueDesk(app);
const taxDefaults = new PostgresIssuerTaxDefaults(app);
const store = new PostgresAdhocAdvanceStore(app);
const isFirm = (_t: string, partyId: string): Promise<boolean> => Promise.resolve(partyId === firm || partyId === gulf);

const invoicing = new InvoiceService({
  invoices: invoiceRepository,
  timeZones: zone,
  firmEntities: { isFirmEntity: isFirm },
  parties: { findParty: () => Promise.resolve(null) },
  ids: systemIds,
  clock,
  events,
  issuedCopies: { file: () => Promise.resolve() },
  staff: new FakeStaffDirectory(),
  settings: new PostgresInvoiceFirmSettings(app),
});
const drafter = {
  prepareDraft: (input: Parameters<InvoiceService["prepareDraft"]>[0]) => invoicing.prepareDraft(input),
  prepareLine: (draft: Parameters<InvoiceService["prepareLine"]>[0], input: Parameters<InvoiceService["prepareLine"]>[1]) =>
    invoicing.prepareLine(draft, input),
  recordRaised: (invoice: Parameters<InvoiceService["recordRaised"]>[0], actor: Actor) => invoicing.recordRaised(invoice, actor),
  find: (t: string, id: string) => invoiceRepository.find(t, id),
  issueCreditNote: (input: Parameters<InvoiceService["issueCreditNote"]>[0], actor: Actor) =>
    invoicing.issueCreditNote(input, actor),
  refreshTax: (t: string, id: string) => invoicing.refreshTax(t, id),
};
const desk = new BillingDeskService({
  desk: deskAdapter,
  invoices: drafter,
  schedules: new PostgresBillingSchedules(app),
  setting: new PostgresAutoBillingSetting(app),
  fiscalYears: new FakeFiscalYearSource(4),
  timeZones: zone,
  clock,
  events,
  taxDefaults,
  policy: new PostgresAdvancePolicy(app),
  firmEntities: { isFirmEntity: isFirm },
});
const adhoc = new AdhocAdvanceService({
  store,
  invoices: drafter,
  taxDefaults,
  managers,
  timeZones: zone,
  ids: systemIds,
  clock,
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

async function company(t: string, name: string): Promise<string> {
  const [p] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name) VALUES (${t}, 'organization', ${name}) RETURNING id
  `;
  if (!p) throw new Error("party seed failed");
  await owner`INSERT INTO core.organization (party_id, tenant_id, legal_name) VALUES (${p.id}, ${t}, ${name})`;
  return p.id;
}

async function serviceVersion(key: string, recurrence: string, module: string): Promise<string> {
  const [entry] = await owner<{ id: string }[]>`
    INSERT INTO config.entry (tenant_id, kind, key) VALUES (${tenantId}, 'service', ${`${key}-${stamp}`}) RETURNING id
  `;
  if (!entry) throw new Error("service seed failed");
  const [version] = await owner<{ id: string }[]>`
    INSERT INTO config.version (tenant_id, entry_id, version, body, status, published_at)
    VALUES (${tenantId}, ${entry.id}, 1, ${owner.json({ name: key, recurrence, module })}, 'published', now())
    RETURNING id
  `;
  if (!version) throw new Error("version seed failed");
  return version.id;
}

let refs = 0;
async function letter(issuer: string, currency: string, status: "draft" | "signed" = "draft"): Promise<string> {
  refs += 1;
  const [l] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter
      (tenant_id, party_id, status, currency, fx_rate, fx_rate_date, ref, issuing_entity_party_id,
       jurisdiction, title, advance_required)
    VALUES (${tenantId}, ${client}, 'draft', ${currency}, ${currency === "INR" ? 1 : 22.6}, CURRENT_DATE,
            ${`EL-2026-${String(refs).padStart(4, "0")}`}, ${issuer}, 'IN', 'Engagement', false)
    RETURNING id
  `;
  if (!l) throw new Error("letter seed failed");
  if (status === "signed") await sign(l.id);
  return l.id;
}

async function sign(letterId: string): Promise<void> {
  await owner`
    UPDATE crm.engagement_letter
       SET status = 'signed', sent_at = now(), signed_at = now(), signed_by_name = 'A Director',
           signature_method = 'attested', signed_content_hash = ${"c".repeat(64)}
     WHERE id = ${letterId}
  `;
}

async function engagement(
  letterId: string,
  position: number,
  version: string,
  frequency: string,
  amount: number,
  currency: string,
): Promise<string> {
  const [ln] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter_line
      (tenant_id, engagement_letter_id, position, service_version_id, quantity, unit_amount, currency,
       discount_percent, billing_frequency, entity_party_id, description)
    VALUES (${tenantId}, ${letterId}, ${position}, ${version}, 1, ${amount}, ${currency}, 0, ${frequency},
            ${client}, ${frequency === "one_time" ? "Company incorporation" : "Monthly bookkeeping"})
    RETURNING id
  `;
  if (!ln) throw new Error("line seed failed");
  return ln.id;
}

async function fanOut(letterId: string, lineIds: readonly string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const lineId of lineIds) {
    const [e] = await owner<{ id: string }[]>`
      INSERT INTO crm.engagement
        (tenant_id, party_id, entity_party_id, engagement_letter_id, engagement_letter_line_id, effective_from,
         status, activated_at)
      VALUES (${tenantId}, ${client}, ${client}, ${letterId}, ${lineId}, '2026-10-01'::date, 'active', now())
      RETURNING id
    `;
    if (!e) throw new Error("engagement seed failed");
    ids.push(e.id);
  }
  return ids;
}

async function periodBill(engagementId: string, month: string, amount: string): Promise<string> {
  const id = systemIds.newId();
  await writer.insert(tenantId, [
    {
      id,
      partyId: client,
      issuingEntityPartyId: firm,
      currency: "INR",
      engagementId,
      feeGroupId: null,
      periodStart: `2026-${month}-01`,
      periodEnd: `2026-${month}-${month === "11" ? "30" : "31"}`,
      periodLabel: `${month}/2026`,
      billOn: `2026-${month}-${month === "11" ? "30" : "31"}`,
      fullAmount: amount,
      servedDays: 30,
      periodDays: 30,
      managerUserId: managerFrc,
      managerHow: "spoc_manager",
      managerNote: null,
    },
  ]);
  return id;
}

async function raiseAndIssue(input: {
  entity: string;
  currency: string;
  amount: string;
  fxRate?: string;
}): Promise<{ advanceId: string; invoiceId: string }> {
  const out = await adhoc.raise(
    {
      tenantId,
      partyId: client,
      entityPartyId: input.entity,
      currency: input.currency,
      amount: input.amount,
      taxPercent: "18",
      fxRate: input.fxRate,
      note: "Received before the letter",
      asOf: "2026-12-05",
      callerSeesFees: true,
    },
    me,
  );
  await invoicing.issue(tenantId, out.invoice.id, me, "2026-12-05");
  return { advanceId: out.advanceId, invoiceId: out.invoice.id };
}

async function unmappedOf(advanceId: string): Promise<string | null> {
  return (await adhoc.get(tenantId, advanceId)).unmapped;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, auto_billing)
    VALUES (${`adhoc-${stamp}`}, 'Adhoc Advance Test', 'INR', true) RETURNING id
  `;
  if (!t) throw new Error("tenant seed failed");
  tenantId = t.id;
  const [o] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency) VALUES (${`adhoc-other-${stamp}`}, 'Other Firm', 'INR') RETURNING id
  `;
  if (!o) throw new Error("tenant seed failed");
  otherTenant = o.id;

  managerFrc = await user("mgr-frc", "manager");
  managerTrc = await user("mgr-trc", "manager");
  keyManager = await user("key-manager", "partner");
  const spocFrc = await user("spoc-frc", "associate");
  const spocTrc = await user("spoc-trc", "associate");
  me = { type: "human", id: managerFrc };
  await owner`UPDATE tenancy.membership SET reports_to_user_id = ${managerFrc} WHERE tenant_id = ${tenantId} AND user_id = ${spocFrc}`;
  await owner`UPDATE tenancy.membership SET reports_to_user_id = ${managerTrc} WHERE tenant_id = ${tenantId} AND user_id = ${spocTrc}`;

  firm = await company(tenantId, "The Firm");
  gulf = await company(tenantId, "The Firm FZE");
  await owner`INSERT INTO crm.firm_entity (tenant_id, party_id) VALUES (${tenantId}, ${firm}), (${tenantId}, ${gulf})`;
  client = await company(tenantId, `Kaveri Foods ${stamp}`);
  for (const [code, spoc] of [["FRC", spocFrc], ["TRC", spocTrc]] as const) {
    const [axis] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.service_axis (tenant_id, axis, code, name) VALUES (${tenantId}, 'dept', ${code}, ${code}) RETURNING id
    `;
    if (!axis) throw new Error("axis seed failed");
    await owner`
      INSERT INTO crm.client_assignment (tenant_id, client_party_id, role, axis_id, user_id, valid_from)
      VALUES (${tenantId}, ${client}, 'spoc', ${axis.id}, ${spoc}, '2026-01-01')
    `;
  }
  await owner`
    INSERT INTO crm.client_assignment (tenant_id, client_party_id, role, user_id, valid_from)
    VALUES (${tenantId}, ${client}, 'key_manager', ${keyManager}, '2026-01-01')
  `;

  const booksVersion = await serviceVersion("books", "monthly", "FRC");
  const incorpVersion = await serviceVersion("incorp", "one_time", "TRC");
  // Letter 1, the firm's Indian company in INR: bookkeeping (FRC) and an
  // incorporation (TRC), two managers.
  const l1 = await letter(firm, "INR");
  const l1Lines = [
    await engagement(l1, 1, booksVersion, "monthly", 30000, "INR"),
    await engagement(l1, 2, incorpVersion, "one_time", 20000, "INR"),
  ];
  await sign(l1);
  [books = "", incorp = ""] = await fanOut(l1, l1Lines);
  // Letter 2, the Gulf company in AED.
  const l2 = await letter(gulf, "AED");
  const l2Lines = [await engagement(l2, 1, booksVersion, "monthly", 2000, "AED")];
  await sign(l2);
  [aedService = ""] = await fanOut(l2, l2Lines);
});

afterAll(async () => {
  await owner`
    UPDATE crm.engagement SET status = 'cancelled', ended_at = now() WHERE tenant_id = ${tenantId} AND ended_at IS NULL
  `.catch(() => undefined);
  await owner`UPDATE tenancy.tenant SET auto_billing = false WHERE id = ${tenantId}`;
  await app.end();
  await owner.end();
});

describe("the ad-hoc advance on a real database (0363)", () => {
  let first = { advanceId: "", invoiceId: "" };

  it("raises a draft tax invoice with its advance row; a draft cannot be mapped; issued, all of it is unmapped", async () => {
    const out = await adhoc.raise(
      {
        tenantId,
        partyId: client,
        entityPartyId: firm,
        currency: "INR",
        amount: "50000",
        taxPercent: "18",
        note: "Received before the letter",
        asOf: "2026-12-05",
        callerSeesFees: true,
      },
      me,
    );
    expect(out.invoice.status).toBe("draft");
    expect(out.invoice.number).toBeNull();
    const draft = await adhoc.get(tenantId, out.advanceId);
    expect(draft).toMatchObject({ net: "50000.00", total: "59000.00", unmapped: null, mapped: "0.00" });
    // The client's Key Manager is the invoice's manager when nobody is named.
    expect(draft.manager?.userId).toBe(keyManager);
    await expect(
      adhoc.map({ tenantId, advanceId: out.advanceId, targets: [{ engagementId: books, amount: "1" }], reason: "x", callerSeesFees: true }, me),
    ).rejects.toBeInstanceOf(AdvanceNotIssued);

    await invoicing.issue(tenantId, out.invoice.id, me, "2026-12-05");
    first = { advanceId: out.advanceId, invoiceId: out.invoice.id };
    expect(await unmappedOf(first.advanceId)).toBe("50000.00");
    expect((await adhoc.list(tenantId, { status: "open" })).map((a) => a.id)).toContain(first.advanceId);
  });

  it("splits it across two services of two managers, and never maps more than is left", async () => {
    await expect(
      adhoc.map(
        {
          tenantId,
          advanceId: first.advanceId,
          targets: [
            { engagementId: books, amount: "40000" },
            { engagementId: incorp, amount: "10000.01" },
          ],
          reason: "Too much",
          callerSeesFees: true,
        },
        me,
      ),
    ).rejects.toBeInstanceOf(AdvanceOverMapped);
    expect(await unmappedOf(first.advanceId)).toBe("50000.00");

    const mapped = await adhoc.map(
      {
        tenantId,
        advanceId: first.advanceId,
        targets: [
          { engagementId: books, amount: "40000" },
          { engagementId: incorp, amount: "10000" },
        ],
        reason: "Bookkeeping from October, and the incorporation",
        callerSeesFees: true,
      },
      me,
    );
    expect(mapped.unmapped).toBe("0.00");
    expect(mapped.mapped).toBe("50000.00");
    // Each part is its service's manager's: FRC's SPOC reports to managerFrc,
    // TRC's to managerTrc.
    const byService = new Map(mapped.allocations.map((a) => [a.target.kind === "service" ? a.target.engagementId : "", a]));
    expect(byService.get(books)?.manager?.userId).toBe(managerFrc);
    expect(byService.get(incorp)?.manager?.userId).toBe(managerTrc);
    // Fully mapped: off the default (open) list.
    expect((await adhoc.list(tenantId, { status: "open" })).map((a) => a.id)).not.toContain(first.advanceId);
    expect(events.verbs().filter((v) => v === "advance_allocation.mapped")).toHaveLength(2);
  });

  it("splits the revenue by the mappings' managers; an ordinary invoice is one row, as before", async () => {
    const rows = await withTenant(app, tenantId, (db) => db<{ manager_user_id: string | null; net_share: string; basis: string }[]>`
      SELECT manager_user_id, round(net_share, 2)::text AS net_share, basis
        FROM crm.invoice_manager_share WHERE invoice_id = ${first.invoiceId}
       ORDER BY basis, net_share
    `);
    expect(rows).toEqual(
      expect.arrayContaining([
        { manager_user_id: managerFrc, net_share: "40000.00", basis: "allocation" },
        { manager_user_id: managerTrc, net_share: "10000.00", basis: "allocation" },
        { manager_user_id: keyManager, net_share: "0.00", basis: "unmapped" },
      ]),
    );
  });

  it("takes a mapped part off the service's earliest bill, before tax, and bills the balance", async () => {
    // October 30,000: all of it off the 40,000 mapped to bookkeeping.
    const oct = await periodBill(books, "10", "30000");
    const before = (await desk.list({ tenantId, filters: { status: "all" } })).dues.find((d) => d.id === oct);
    expect(before?.advancePool).toMatchObject({ invoiceId: first.invoiceId, remaining: "40000.00" });
    expect(before?.advancePool?.allocationId).toBeTruthy();
    const out = await desk.raise({ tenantId, dueIds: [oct], lines: [{ dueId: oct, taxPercent: "18" }] }, me);
    expect(out.covered).toEqual([oct]);
    // November 30,000: 10,000 left of the mapping, so the invoice bills 20,000.
    const nov = await periodBill(books, "11", "30000");
    const raised = await desk.raise({ tenantId, dueIds: [nov], lines: [{ dueId: nov, taxPercent: "18" }] }, me);
    expect(raised.invoiceId).not.toBeNull();
    const [line] = await withTenant(app, tenantId, (db) => db<{ unit_amount: string; description: string }[]>`
      SELECT unit_amount::text AS unit_amount, description FROM crm.invoice_line WHERE invoice_id = ${raised.invoiceId ?? ""}
    `);
    expect(Number(line?.unit_amount)).toBe(20000);
    expect(line?.description).toContain("less advance");
    const afterBills = await adhoc.get(tenantId, first.advanceId);
    const booksPart = afterBills.allocations.find((a) => a.target.kind === "service" && a.target.engagementId === books);
    expect(booksPart).toMatchObject({ taken: "40000.00", left: "0.00" });
  });

  it("re-maps after partial consumption: keeps what bills took, frees the rest; a used-up part cannot move", async () => {
    const second = await raiseAndIssue({ entity: firm, currency: "INR", amount: "25000" });
    const mapped = await adhoc.map(
      { tenantId, advanceId: second.advanceId, targets: [{ engagementId: books, amount: "25000" }], reason: "Books", callerSeesFees: true },
      me,
    );
    const part = mapped.allocations[0];
    if (part === undefined) throw new Error("no allocation");
    // December's 30,000 takes 25,000... the first advance's books part is used
    // up, so December takes this one: then make December smaller.
    const dec = await periodBill(books, "12", "15000");
    await desk.raise({ tenantId, dueIds: [dec], lines: [{ dueId: dec, taxPercent: "18" }] }, me);
    const taken = (await adhoc.get(tenantId, second.advanceId)).allocations[0];
    expect(taken).toMatchObject({ taken: "15000.00", left: "10000.00" });

    const ended = await adhoc.end({ tenantId, advanceId: second.advanceId, allocationId: part.id, reason: "Move the rest to the incorporation" }, me);
    expect(ended.unmapped).toBe("10000.00");
    expect(ended.allocations[0]?.ended).toMatchObject({ kept: "15000.0000" });
    // The freed part maps elsewhere.
    const remapped = await adhoc.map(
      { tenantId, advanceId: second.advanceId, targets: [{ engagementId: incorp, amount: "10000" }], reason: "Re-mapped", callerSeesFees: true },
      me,
    );
    expect(remapped.unmapped).toBe("0.00");
    expect(remapped.mapped).toBe("25000.00");

    // The first advance's bookkeeping part was taken in full: it cannot move.
    const used = (await adhoc.get(tenantId, first.advanceId)).allocations.find(
      (a) => a.target.kind === "service" && a.target.engagementId === books,
    );
    await expect(
      adhoc.end({ tenantId, advanceId: first.advanceId, allocationId: used?.id ?? "", reason: "Try" }, me),
    ).rejects.toBeInstanceOf(AllocationUsedUp);
  });

  it("refuses an AED advance against an INR service, in the use case and at the wall", async () => {
    const aed = await raiseAndIssue({ entity: gulf, currency: "AED", amount: "5000", fxRate: "22.6" });
    await expect(
      adhoc.map({ tenantId, advanceId: aed.advanceId, targets: [{ engagementId: books, amount: "100" }], reason: "x", callerSeesFees: true }, me),
    ).rejects.toBeInstanceOf(AdvanceOfAnotherIssuer);
    // Same company, other currency: an INR advance of the Gulf company against
    // its AED service.
    const inrGulf = await raiseAndIssue({ entity: gulf, currency: "INR", amount: "1000" });
    await expect(
      adhoc.map({ tenantId, advanceId: inrGulf.advanceId, targets: [{ engagementId: aedService, amount: "100" }], reason: "x", callerSeesFees: true }, me),
    ).rejects.toBeInstanceOf(AdvanceInAnotherCurrency);
    // Any other writer meets the trigger.
    await expect(
      withTenant(app, tenantId, (db) => db`
        INSERT INTO crm.advance_allocation
          (tenant_id, adhoc_advance_id, invoice_id, currency, engagement_id, amount, how, reason)
        VALUES (${tenantId}, ${inrGulf.advanceId}, ${inrGulf.invoiceId}, 'INR', ${aedService}, 100, 'by_hand', 'raw')
      `),
    ).rejects.toThrow(/not mapped to work billed in AED/);
    // The AED advance maps to the AED service.
    const ok = await adhoc.map(
      { tenantId, advanceId: aed.advanceId, targets: [{ engagementId: aedService, amount: "2000" }], reason: "Gulf books", callerSeesFees: true },
      me,
    );
    expect(ok.unmapped).toBe("3000.00");
  });

  it("will not cancel a mapped advance, and credits back only the unmapped part", async () => {
    await expect(invoicing.cancel(tenantId, first.invoiceId, me)).rejects.toBeInstanceOf(InvoiceAdvanceMapped);
    await expect(adhoc.giveBack({ tenantId, advanceId: first.advanceId, asOf: "2026-12-05" }, me)).rejects.toBeInstanceOf(
      NothingToRefund,
    );
    // A credit note on the mapped part is refused by the B06 cap.
    await expect(
      invoicing.issueCreditNote({ tenantId, invoiceId: first.invoiceId, amount: "100", reason: "advance_refund", asOf: "2026-12-05" }, me),
    ).rejects.toBeInstanceOf(CreditExceedsUnusedAdvance);

    // A fresh advance with nothing mapped is given back whole, tax included.
    const third = await raiseAndIssue({ entity: firm, currency: "INR", amount: "10000" });
    const credit = await adhoc.giveBack({ tenantId, advanceId: third.advanceId, asOf: "2026-12-05" }, me);
    expect(credit.number).toBeTruthy();
    const [cn] = await withTenant(app, tenantId, (db) => db<{ amount: string; reason: string }[]>`
      SELECT amount::text AS amount, reason FROM crm.credit_note WHERE id = ${credit.creditNoteId}
    `);
    expect(cn).toMatchObject({ reason: "advance_refund" });
    expect(Number(cn?.amount)).toBe(11800);
    expect(await unmappedOf(third.advanceId)).toBe("0.00");
  });

  it("scenario 1: a letter names the advance, is signed, and maps it to itself once, coming off its bills", async () => {
    const fourth = await raiseAndIssue({ entity: firm, currency: "INR", amount: "12000" });
    const draftLetter = await letter(firm, "INR");
    const lineId = await engagement(draftLetter, 1, await serviceVersion("gst", "monthly", "FRC"), "monthly", 9000, "INR");
    // Another currency is refused; the right one is named.
    await expect(
      adhoc.setNamed({ tenantId, letterId: draftLetter, advances: [{ adhocAdvanceId: fourth.advanceId, amount: "12000.01" }], callerSeesFees: true }),
    ).rejects.toBeInstanceOf(AdvanceOverMapped);
    await adhoc.setNamed({ tenantId, letterId: draftLetter, advances: [{ adhocAdvanceId: fourth.advanceId, amount: "12000" }], callerSeesFees: true });
    expect((await adhoc.forLetter(tenantId, draftLetter)).named.map((n) => n.advance.id)).toEqual([fourth.advanceId]);

    await sign(draftLetter);
    const [gst = ""] = await fanOut(draftLetter, [lineId]);
    // Frozen with the letter's other terms.
    await expect(
      withTenant(app, tenantId, (db) => db`DELETE FROM crm.engagement_letter_advance WHERE engagement_letter_id = ${draftLetter}`),
    ).rejects.toThrow();

    expect(await adhoc.mapNamedOnSigning({ tenantId, letterId: draftLetter }, SYSTEM_ACTOR)).toEqual({ mapped: 1 });
    // Once: the catch-up after it maps nothing again.
    expect(await adhoc.mapNamedOnSigning({ tenantId }, SYSTEM_ACTOR)).toEqual({ mapped: 0 });
    const named = await adhoc.get(tenantId, fourth.advanceId);
    expect(named.unmapped).toBe("0.00");
    expect(named.allocations[0]).toMatchObject({ how: "letter_signed", target: { kind: "letter", letterId: draftLetter } });
    expect(named.allocations[0]?.manager?.userId).toBe(keyManager);

    // Its first bill takes it, FIFO, before tax.
    const id = systemIds.newId();
    await writer.insert(tenantId, [
      {
        id,
        partyId: client,
        issuingEntityPartyId: firm,
        currency: "INR",
        engagementId: gst,
        feeGroupId: null,
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        periodLabel: "Oct 2026",
        billOn: "2026-10-31",
        fullAmount: "9000",
        servedDays: 31,
        periodDays: 31,
        managerUserId: managerFrc,
        managerHow: "spoc_manager",
        managerNote: null,
      },
    ]);
    const bill = (await desk.list({ tenantId, filters: { status: "all" } })).dues.find((d) => d.id === id);
    expect(bill?.advancePool).toMatchObject({ invoiceId: fourth.invoiceId, remaining: "12000.00" });
    expect((await desk.raise({ tenantId, dueIds: [id], lines: [{ dueId: id, taxPercent: "18" }] }, me)).covered).toEqual([id]);
    expect((await adhoc.get(tenantId, fourth.advanceId)).allocations[0]).toMatchObject({ taken: "9000.00", left: "3000.00" });
  });

  it("keeps it behind the tenant wall: another firm sees none of it and cannot point at it", async () => {
    const seen = await withTenant(app, otherTenant, async (db) => {
      const [a] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM crm.adhoc_advance`;
      const [b] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM crm.advance_allocation`;
      const [c] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM crm.engagement_letter_advance`;
      const [d] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM crm.advance_pool WHERE source <> 'letter_bill'`;
      return [a?.n, b?.n, c?.n, d?.n];
    });
    expect(seen).toEqual([0, 0, 0, 0]);
    expect(await new PostgresAdhocAdvanceStore(app).list(otherTenant, { status: "all" })).toEqual([]);
    // Writing as the other firm, naming this firm's advance: refused by the
    // composite keys (the advance is not that firm's).
    await expect(
      withTenant(app, otherTenant, (db) => db`
        INSERT INTO crm.advance_allocation
          (tenant_id, adhoc_advance_id, invoice_id, currency, engagement_id, amount, how, reason)
        VALUES (${otherTenant}, ${first.advanceId}, ${first.invoiceId}, 'INR', ${books}, 1, 'by_hand', 'cross')
      `),
    ).rejects.toThrow();
    // And this firm's row cannot be written as another firm's.
    await expect(
      withTenant(app, otherTenant, (db) => db`
        INSERT INTO crm.adhoc_advance (tenant_id, invoice_id, currency, raised_by_user_id)
        VALUES (${tenantId}, ${first.invoiceId}, 'INR', ${managerFrc})
      `),
    ).rejects.toThrow();
  });
});
