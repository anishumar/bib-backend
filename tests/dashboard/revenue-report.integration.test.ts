// The revenue report (Q049, 0355) against a REAL database: the SQL that adds.
//
// ── WHAT IS PROVED HERE AND NOWHERE ELSE ───────────────────────────────────
//
//   1. BY MANAGER, per currency, never converted: an INR invoice with a credit
//      note (its pre-tax share off invoiced) and a part payment; an AED
//      invoice paid in full; an invoice naming nobody; an invoice issued
//      before the period counts only in what is owed at its close.
//   2. BY ORIGINATOR, line by line: one invoice carrying two letters' work
//      credits two people, each line taking its share of the credit note,
//      the money and the balance; the originator read off the deal (the
//      lead's owner) and one a partner set; a line with no engagement found
//      through the bill it was raised from (a fee group).
//   3. The currency totals equal the sum of its people's rows.
//   4. Drafts and cancelled invoices count nowhere; another firm's never.
//   5. The originator store: the default's `how`, a person's word, the wall.
//   6. AN ADVANCE TAKEN BEFORE THE LETTER (0363), in November: by manager it
//      splits by the managers of the work it was mapped to (S4's
//      invoice_manager_share), counted as one invoice; by originator each
//      mapping is its letter's, and what is mapped to nothing is nobody's.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/dashboard/revenue-report.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresDashboardRepository } from "../../src/infrastructure/postgres/dashboard-repository";
import { PostgresOriginatorStore } from "../../src/infrastructure/postgres/originator-repository";
import type { PersonCurrencyRow, RevenueQuery } from "../../src/usecase/dashboard/ports";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });
const stamp = Date.now().toString(36);

let firm = "";
let other = "";
let india = "";
let gulf = "";
let client = "";
let mona = "";
let ravi = "";
let sunil = "";
let priya = "";
let version = "";
const letters: Record<string, string> = {};
const engagements: Record<string, string> = {};

async function tenant(slug: string): Promise<string> {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency) VALUES (${slug}, ${slug}, 'INR') RETURNING id
  `;
  if (!t) throw new Error("tenant seed failed");
  return t.id;
}

async function party(t: string, name: string): Promise<string> {
  const [p] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name) VALUES (${t}, 'organization', ${name}) RETURNING id
  `;
  if (!p) throw new Error("party seed failed");
  await owner`INSERT INTO core.organization (party_id, tenant_id, legal_name) VALUES (${p.id}, ${t}, ${name})`;
  return p.id;
}

async function company(t: string, name: string, jurisdiction: string): Promise<string> {
  const id = await party(t, name);
  await owner`INSERT INTO core.legal_entity (party_id, tenant_id, jurisdiction, entity_type)
              VALUES (${id}, ${t}, ${jurisdiction}, 'private_limited')`;
  await owner`INSERT INTO crm.firm_entity (tenant_id, party_id) VALUES (${t}, ${id})`;
  for (const [type, prefix] of [["invoice", "INV"], ["credit_note", "CN"]] as const) {
    await owner`
      INSERT INTO crm.invoice_series (tenant_id, entity_party_id, financial_year, last_number, prefix, document_type)
      VALUES (${t}, ${id}, 2026, 0, ${prefix}, ${type})
    `;
  }
  return id;
}

async function staff(t: string, name: string): Promise<string> {
  const [u] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`${name.toLowerCase()}-${stamp}@example.test`}, ${name}) RETURNING id
  `;
  if (!u) throw new Error("user seed failed");
  await owner`INSERT INTO tenancy.membership (tenant_id, user_id, audience, role) VALUES (${t}, ${u.id}, 'STAFF', 'partner')`;
  return u.id;
}

async function letter(key: string, proposalId: string | null): Promise<void> {
  const [l] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter
      (tenant_id, party_id, status, currency, fx_rate, fx_rate_date, ref, issuing_entity_party_id, jurisdiction, title,
       proposal_id)
    VALUES (${firm}, ${client}, 'draft', 'INR', 1, '2026-03-20', ${`EL-2026-000${String(Object.keys(letters).length + 1)}`}, ${india}, 'IN', 'Engagement', ${proposalId})
    RETURNING id
  `;
  if (!l) throw new Error("letter seed failed");
  letters[key] = l.id;
  const [ln] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter_line
      (tenant_id, engagement_letter_id, position, service_version_id, quantity, unit_amount,
       currency, discount_percent, billing_frequency, entity_party_id, description)
    VALUES (${firm}, ${l.id}, 1, ${version}, 1, 1000, 'INR', 0, 'one_time', ${client}, ${`Work ${key}`})
    RETURNING id
  `;
  if (!ln) throw new Error("line seed failed");
  await owner`
    UPDATE crm.engagement_letter
       SET status = 'signed', sent_at = now(), signed_at = now(), signed_by_name = 'A Director',
           signature_method = 'attested', signed_content_hash = ${"e".repeat(64)}
     WHERE id = ${l.id}
  `;
  const [e] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement
      (tenant_id, party_id, entity_party_id, engagement_letter_id, engagement_letter_line_id, effective_from, status, activated_at)
    VALUES (${firm}, ${client}, ${client}, ${l.id}, ${ln.id}, '2026-04-01', 'active', now())
    RETURNING id
  `;
  if (!e) throw new Error("engagement seed failed");
  engagements[key] = e.id;
}

let sequence = 0;
/** An invoice, its lines on, THEN its status (the order the freezes allow). */
async function invoice(input: {
  t?: string;
  entity: string;
  manager: string | null;
  currency: string;
  lines: readonly { engagement: string | null; unit: string; tax: string }[];
  status: "draft" | "issued" | "cancelled";
  issuedOn: string | null;
}): Promise<{ id: string; lines: string[] }> {
  sequence += 1;
  const t = input.t ?? firm;
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO crm.invoice
      (tenant_id, party_id, entity_party_id, number, financial_year, sequence_number,
       status, currency, fx_rate, fx_rate_date, issued_on, due_on, manager_user_id)
    VALUES (${t}, ${t === firm ? client : await party(t, "Other client")}, ${input.entity},
            ${`INV/${stamp}/${String(sequence)}`}, 2026, ${sequence},
            'draft', ${input.currency}, ${input.currency === "INR" ? "1" : "22.5"}, '2026-04-01', null, null, ${input.manager})
    RETURNING id
  `;
  if (!row) throw new Error("invoice seed failed");
  const ids: string[] = [];
  let position = 0;
  for (const l of input.lines) {
    position += 1;
    const [ln] = await owner<{ id: string }[]>`
      INSERT INTO crm.invoice_line
        (tenant_id, invoice_id, engagement_id, description, position, quantity, unit_amount, currency, tax_percent)
      VALUES (${t}, ${row.id}, ${l.engagement}, 'Work', ${position}, 1, ${l.unit}, ${input.currency}, ${l.tax})
      RETURNING id
    `;
    if (!ln) throw new Error("invoice line seed failed");
    ids.push(ln.id);
  }
  if (input.status !== "draft") {
    await owner`UPDATE crm.invoice SET status = 'issued', issued_on = ${input.issuedOn} WHERE id = ${row.id}`;
  }
  if (input.status === "cancelled") {
    await owner`UPDATE crm.invoice SET status = 'cancelled' WHERE id = ${row.id}`;
  }
  return { id: row.id, lines: ids };
}

async function pay(invoiceId: string, amount: string, currency: string, on: string, t = firm): Promise<void> {
  await owner`
    INSERT INTO crm.payment (tenant_id, invoice_id, amount, currency, received_on, method)
    VALUES (${t}, ${invoiceId}, ${amount}, ${currency}, ${on}, 'bank_transfer')
  `;
}

beforeAll(async () => {
  firm = await tenant(`rr-${stamp}`);
  other = await tenant(`rr-other-${stamp}`);
  india = await company(firm, "The Firm India", "IN");
  gulf = await company(firm, "The Firm Gulf", "AE");
  client = await party(firm, `Kaveri Foods ${stamp}`);
  mona = await staff(firm, "Mona");
  ravi = await staff(firm, "Ravi");
  sunil = await staff(firm, "Sunil");
  priya = await staff(firm, "Priya");

  const [entry] = await owner<{ id: string }[]>`
    INSERT INTO config.entry (tenant_id, kind, key) VALUES (${firm}, 'service', ${`rr-${stamp}`}) RETURNING id
  `;
  if (!entry) throw new Error("service seed failed");
  const [v] = await owner<{ id: string }[]>`
    INSERT INTO config.version (tenant_id, entry_id, version, body, status, published_at)
    VALUES (${firm}, ${entry.id}, 1, ${owner.json({ name: "Advisory" })}, 'published', now())
    RETURNING id
  `;
  if (!v) throw new Error("version seed failed");
  version = v.id;

  // A: won by Sunil (the lead's owner; Mona prepared the proposal).
  const [lead] = await owner<{ id: string }[]>`
    INSERT INTO crm.lead (tenant_id, party_id, source, title, stage, owner_user_id)
    VALUES (${firm}, ${client}, 'inbound', 'Kaveri audit', 'qualified', ${sunil}) RETURNING id
  `;
  if (!lead) throw new Error("lead seed failed");
  const [proposal] = await owner<{ id: string }[]>`
    INSERT INTO crm.proposal
      (tenant_id, party_id, title, currency, fx_rate, fx_rate_date, ref, issuing_entity_party_id, lead_id, prepared_by_user_id)
    VALUES (${firm}, ${client}, 'Audit', 'INR', 1, '2026-03-01', 'PR-2026-0001', ${india}, ${lead.id}, ${mona})
    RETURNING id
  `;
  if (!proposal) throw new Error("proposal seed failed");
  await letter("A", proposal.id);
  // B: no deal behind it; a partner says Priya won it.
  await letter("B", null);
  await owner`
    INSERT INTO crm.letter_originator (tenant_id, engagement_letter_id, originator_user_id, set_by_user_id)
    VALUES (${firm}, ${letters.B ?? ""}, ${priya}, ${mona})
  `;
  // C: no deal, nobody said: no originator.
  await letter("C", null);

  // I1 (INR, Mona): A's work 1,00,000 and B's 50,000, both at 18% = 1,77,000.
  const i1 = await invoice({
    entity: india,
    manager: mona,
    currency: "INR",
    lines: [
      { engagement: engagements.A ?? null, unit: "100000", tax: "18" },
      { engagement: engagements.B ?? null, unit: "50000", tax: "18" },
    ],
    status: "issued",
    issuedOn: "2026-05-10",
  });
  await pay(i1.id, "59000", "INR", "2026-06-01");
  await owner`
    INSERT INTO crm.credit_note
      (tenant_id, invoice_id, entity_party_id, number, financial_year, sequence_number, amount, currency, issued_on, reason)
    VALUES (${firm}, ${i1.id}, ${india}, ${`CN/${stamp}/1`}, 2026, 1, 11800, 'INR', '2026-06-15', 'goodwill')
  `;
  // I2 (AED, Ravi, the Gulf company): A's work, 1,000 + 5%, paid in full.
  const i2 = await invoice({
    entity: gulf,
    manager: ravi,
    currency: "AED",
    lines: [{ engagement: engagements.A ?? null, unit: "1000", tax: "5" }],
    status: "issued",
    issuedOn: "2026-07-01",
  });
  await pay(i2.id, "1050", "AED", "2026-07-15");
  // I5 (INR, nobody): a fee group's line, no engagement on it; its bill names
  // the group, so the line is the group's letter's (Priya's). Unpaid.
  const i5 = await invoice({
    entity: india,
    manager: null,
    currency: "INR",
    lines: [{ engagement: null, unit: "10000", tax: "0" }],
    status: "issued",
    issuedOn: "2026-08-01",
  });
  // The group sits on a letter of its own (a signed letter takes no new
  // group), whose originator a partner set to Priya too.
  const [gl] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter
      (tenant_id, party_id, status, currency, fx_rate, fx_rate_date, ref, issuing_entity_party_id, jurisdiction, title)
    VALUES (${firm}, ${client}, 'draft', 'INR', 1, '2026-03-20', 'EL-2026-0009', ${india}, 'IN', 'Engagement')
    RETURNING id
  `;
  if (!gl) throw new Error("group letter seed failed");
  letters.G = gl.id;
  await owner`
    INSERT INTO crm.letter_originator (tenant_id, engagement_letter_id, originator_user_id)
    VALUES (${firm}, ${gl.id}, ${priya})
  `;
  const [group] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter_fee_group
      (tenant_id, engagement_letter_id, currency, position, title, billing_frequency, amount)
    VALUES (${firm}, ${gl.id}, 'INR', 1, 'Retainer', 'monthly', 10000)
    RETURNING id
  `;
  if (!group) throw new Error("fee group seed failed");
  await owner`
    INSERT INTO crm.billing_due
      (tenant_id, kind, party_id, issuing_entity_party_id, currency, fee_group_id, period_start, period_end,
       period_label, bill_on, full_amount, served_days, period_days, manager_how, manager_note,
       invoice_id, invoice_line_id)
    VALUES (${firm}, 'period', ${client}, ${india}, 'INR', ${group.id}, '2026-07-01', '2026-07-31', 'Jul 2026',
            '2026-07-31', 10000, 31, 31, 'none', 'Fixture', ${i5.id}, ${i5.lines[0] ?? null})
  `;
  // I6 (INR, Mona): C's work, issued BEFORE the period, unpaid: owed only.
  await invoice({
    entity: india,
    manager: mona,
    currency: "INR",
    lines: [{ engagement: engagements.C ?? null, unit: "20000", tax: "0" }],
    status: "issued",
    issuedOn: "2026-03-01",
  });
  // A draft and a cancelled invoice: nowhere.
  await invoice({
    entity: india,
    manager: mona,
    currency: "INR",
    lines: [{ engagement: engagements.A ?? null, unit: "999", tax: "0" }],
    status: "draft",
    issuedOn: null,
  });
  await invoice({
    entity: india,
    manager: mona,
    currency: "INR",
    lines: [{ engagement: engagements.A ?? null, unit: "888", tax: "0" }],
    status: "cancelled",
    issuedOn: "2026-06-01",
  });
  // I7 (INR, Ravi), 15 Nov: an ad-hoc advance of 30,000 + 18%. 20,000 is
  // mapped to letter A's service (Mona manages it), 5,000 to letter B when it
  // was signed (nobody named), 5,000 to nothing yet.
  const i7 = await invoice({
    entity: india,
    manager: ravi,
    currency: "INR",
    lines: [{ engagement: null, unit: "30000", tax: "18" }],
    status: "issued",
    issuedOn: "2026-11-15",
  });
  const [adv] = await owner<{ id: string }[]>`
    INSERT INTO crm.adhoc_advance (tenant_id, invoice_id, currency, raised_by_user_id)
    VALUES (${firm}, ${i7.id}, 'INR', ${ravi}) RETURNING id
  `;
  if (!adv) throw new Error("advance seed failed");
  // Paid in full on 20 Nov, so nothing of it is owed at any close above.
  await pay(i7.id, "35400", "INR", "2026-11-20");
  await owner`
    INSERT INTO crm.advance_allocation
      (tenant_id, adhoc_advance_id, invoice_id, currency, engagement_id, amount, manager_user_id, how, reason)
    VALUES (${firm}, ${adv.id}, ${i7.id}, 'INR', ${engagements.A ?? null}, 20000, ${mona}, 'by_hand', 'Fixture')
  `;
  await owner`
    INSERT INTO crm.advance_allocation
      (tenant_id, adhoc_advance_id, invoice_id, currency, engagement_letter_id, amount, manager_user_id, how, reason)
    VALUES (${firm}, ${adv.id}, ${i7.id}, 'INR', ${letters.B ?? null}, 5000, null, 'letter_signed', 'Fixture')
  `;
  // Another firm's invoice in the period.
  const otherCo = await company(other, "Other Firm", "IN");
  await invoice({
    t: other,
    entity: otherCo,
    manager: null,
    currency: "INR",
    lines: [{ engagement: null, unit: "777", tax: "0" }],
    status: "issued",
    issuedOn: "2026-06-01",
  });
});

afterAll(async () => {
  await Promise.all([owner.end({ timeout: 5 }), app.end({ timeout: 5 })]);
});

const repo = new PostgresDashboardRepository(app);
const Q: Omit<RevenueQuery, "by"> = { from: "2026-04-01", to: "2026-09-30", asOf: "2026-09-30" };
const pick = (rows: readonly PersonCurrencyRow[], userId: string | null, currency: string) =>
  rows.find((r) => r.scope === "person" && r.userId === userId && r.currency === currency);
const total = (rows: readonly PersonCurrencyRow[], currency: string) =>
  rows.find((r) => r.scope === "currency" && r.currency === currency);
const n = (s: string | undefined) => Number(s ?? "NaN");

describe("the revenue report by manager (Q049)", () => {
  it("adds per manager and per currency, never across currencies", async () => {
    const rows = await repo.revenueByPerson(firm, { by: "manager", ...Q });
    expect(pick(rows, mona, "INR")).toMatchObject({ invoices: 1 });
    // 1,50,000 less the credit note's pre-tax share (11,800 x 150000/177000 = 10,000).
    expect(n(pick(rows, mona, "INR")?.invoiced)).toBe(140000);
    expect(n(pick(rows, mona, "INR")?.collected)).toBe(59000);
    // I1: 1,77,000 - 59,000 - 11,800 = 1,06,200, plus I6's 20,000 from March.
    expect(n(pick(rows, mona, "INR")?.outstanding)).toBe(126200);
    expect(pick(rows, ravi, "AED")).toMatchObject({ invoices: 1 });
    expect([n(pick(rows, ravi, "AED")?.invoiced), n(pick(rows, ravi, "AED")?.collected)]).toEqual([1000, 1050]);
    expect(n(pick(rows, ravi, "AED")?.outstanding)).toBe(0);
    expect(n(pick(rows, null, "INR")?.invoiced)).toBe(10000);
    expect(rows.some((r) => r.currency === "AED" && r.userId === mona)).toBe(false);
  });

  it("each currency's total is its people's sum; drafts, cancelled and other firms count nowhere", async () => {
    const rows = await repo.revenueByPerson(firm, { by: "manager", ...Q });
    expect([n(total(rows, "INR")?.invoiced), n(total(rows, "INR")?.collected), n(total(rows, "INR")?.outstanding)]).toEqual([
      150000, 59000, 136200,
    ]);
    expect(total(rows, "INR")?.invoices).toBe(2);
    expect(n(total(rows, "AED")?.invoiced)).toBe(1000);
  });

  it("narrows to one company and one currency", async () => {
    const gulfOnly = await repo.revenueByPerson(firm, { by: "manager", ...Q, issuerPartyId: gulf });
    expect([...new Set(gulfOnly.map((r) => r.currency))]).toEqual(["AED"]);
    const inr = await repo.revenueByPerson(firm, { by: "manager", ...Q, currency: "INR" });
    expect(inr.every((r) => r.currency === "INR")).toBe(true);
  });
});

describe("the revenue report by originator (Q049)", () => {
  it("credits each line's letter: the lead's owner, a partner's word, a fee group's bill", async () => {
    const rows = await repo.revenueByPerson(firm, { by: "originator", ...Q });
    // Sunil (letter A): 1,00,000 less 11,800 x 100000/177000; 59,000 x 118000/177000; 1,06,200 x 118000/177000.
    expect(pick(rows, sunil, "INR")).toMatchObject({
      invoiced: "93333.3333",
      collected: "39333.3333",
      outstanding: "70800.0000",
      invoices: 1,
    });
    // Priya (letter B by a partner's word): 50,000 less 3,333.3333, plus the
    // fee group's 10,000 found through its bill.
    expect(pick(rows, priya, "INR")).toMatchObject({
      invoiced: "56666.6667",
      collected: "19666.6667",
      outstanding: "45400.0000",
      invoices: 2,
    });
    // Sunil again, in AED: never added to his INR.
    expect(pick(rows, sunil, "AED")).toMatchObject({ invoiced: "1000.0000", collected: "1050.0000" });
    // Letter C has no originator: owed from March, nothing invoiced in the period.
    expect(pick(rows, null, "INR")).toMatchObject({ invoiced: "0", outstanding: "20000.0000", invoices: 0 });
    expect(rows.some((r) => r.userId === mona)).toBe(false);
  });

  it("the originators of a currency add up to its total", async () => {
    const rows = await repo.revenueByPerson(firm, { by: "originator", ...Q });
    const people = rows.filter((r) => r.scope === "person" && r.currency === "INR");
    const sum = (k: "invoiced" | "collected" | "outstanding") => people.reduce((a, r) => a + Number(r[k]), 0);
    expect(sum("invoiced")).toBeCloseTo(n(total(rows, "INR")?.invoiced), 3);
    expect(sum("collected")).toBeCloseTo(n(total(rows, "INR")?.collected), 3);
    expect(sum("outstanding")).toBeCloseTo(n(total(rows, "INR")?.outstanding), 3);
  });
});

describe("an advance taken before the letter in the revenue report (0363)", () => {
  const NOV: Omit<RevenueQuery, "by"> = { from: "2026-11-01", to: "2026-11-30", asOf: "2026-11-30" };

  it("by manager: nobody's while no bill has taken it, its money too (Q085, 0376)", async () => {
    const rows = await repo.revenueByPerson(firm, { by: "manager", ...NOV });
    // Mapped 20,000 to Mona's service and 5,000 to a letter, and still all
    // unearned: no bill has taken any of it.
    expect(pick(rows, null, "INR")).toMatchObject({ invoiced: "30000.0000", invoices: 1 });
    expect(n(pick(rows, null, "INR")?.collected)).toBe(35400);
    // Mona and Ravi earned none of it (Mona's row carries only older invoices' balance).
    expect(n(pick(rows, mona, "INR")?.invoiced ?? "0")).toBe(0);
    expect(n(pick(rows, ravi, "INR")?.invoiced ?? "0")).toBe(0);
    expect(total(rows, "INR")).toMatchObject({ invoiced: "30000.0000", invoices: 1 });
  });

  it("by manager: the part a bill takes is that bill's manager's, in the month the bill counts (Q085)", async () => {
    // December: Mona's service bills 30,000, takes 20,000 of the advance and
    // invoices the 10,000 balance on 10 Dec.
    const [adv] = await owner<{ invoice_id: string }[]>`
      SELECT invoice_id FROM crm.adhoc_advance WHERE tenant_id = ${firm} LIMIT 1
    `;
    const dec = await invoice({
      entity: india,
      manager: mona,
      currency: "INR",
      lines: [{ engagement: engagements.A ?? null, unit: "10000", tax: "0" }],
      status: "issued",
      issuedOn: "2026-12-10",
    });
    await owner`
      INSERT INTO crm.billing_due
        (tenant_id, kind, party_id, issuing_entity_party_id, currency, engagement_id, period_start, period_end,
         period_label, bill_on, full_amount, served_days, period_days, manager_user_id, manager_how, manager_note,
         invoice_id, invoice_line_id, advance_invoice_id, advance_applied)
      VALUES (${firm}, 'period', ${client}, ${india}, 'INR', ${engagements.A ?? null}, '2026-11-01', '2026-11-30',
              'Nov 2026', '2026-11-30', 30000, 30, 30, ${mona}, 'spoc_manager', null,
              ${dec.id}, ${dec.lines[0] ?? null}, ${adv?.invoice_id ?? null}, 20000)
    `;
    const DEC: Omit<RevenueQuery, "by"> = { from: "2026-12-01", to: "2026-12-31", asOf: "2026-12-31" };
    const rows = await repo.revenueByPerson(firm, { by: "manager", ...DEC });
    expect(pick(rows, mona, "INR")).toMatchObject({ invoiced: "30000.0000", invoices: 1 });
    expect(pick(rows, null, "INR")).toMatchObject({ invoiced: "-20000.0000", invoices: 0 });
    // The firm's total is still what it invoiced in December.
    expect(total(rows, "INR")).toMatchObject({ invoiced: "10000.0000", invoices: 1 });
    // November, the advance's own month, does not move.
    expect(total(await repo.revenueByPerson(firm, { by: "manager", ...NOV }), "INR")).toMatchObject({ invoiced: "30000.0000" });
  });

  it("by originator: each mapping is its letter's, the unmapped part nobody's", async () => {
    const rows = await repo.revenueByPerson(firm, { by: "originator", ...NOV });
    expect(n(pick(rows, sunil, "INR")?.invoiced)).toBe(20000);
    expect(n(pick(rows, priya, "INR")?.invoiced)).toBe(5000);
    expect(n(pick(rows, null, "INR")?.invoiced)).toBe(5000);
    expect(n(total(rows, "INR")?.invoiced)).toBe(30000);
    // Its money follows the parts, tax included: 35,400 paid, 20:5:5.
    expect(n(pick(rows, sunil, "INR")?.collected)).toBeCloseTo(23600, 3);
    expect(n(pick(rows, priya, "INR")?.collected)).toBeCloseTo(5900, 3);
    expect(n(pick(rows, null, "INR")?.collected)).toBeCloseTo(5900, 3);
  });
});

describe("the originator store (0355)", () => {
  const store = new PostgresOriginatorStore(app);

  it("reads the default off the deal, and a person's word over it", async () => {
    expect(await store.find(firm, letters.A ?? "")).toMatchObject({ userId: sunil, how: "lead_owner", name: "Sunil" });
    expect(await store.find(firm, letters.B ?? "")).toMatchObject({ userId: priya, how: "set", setBy: { userId: mona } });
    expect(await store.find(firm, letters.C ?? "")).toMatchObject({ userId: null, how: "none" });
    await store.write(firm, letters.A ?? "", priya, mona);
    expect(await store.find(firm, letters.A ?? "")).toMatchObject({ userId: priya, how: "set" });
    await store.write(firm, letters.A ?? "", sunil, mona);
  });

  it("knows active staff, and THE WALL: another firm cannot read or write this firm's letter", async () => {
    expect(await store.isActiveStaff(firm, mona)).toBe(true);
    expect(await store.isActiveStaff(other, mona)).toBe(false);
    expect(await store.find(other, letters.A ?? "")).toBeNull();
    await expect(store.write(other, letters.A ?? "", null, null)).rejects.toThrow();
  });
});
