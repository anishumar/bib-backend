// The client summary against a REAL database: the SQL that splits and adds.
//
//   1. One invoice carrying two services splits its credit note, money and
//      balance between them by their share of its total.
//   2. A service is its catalogue ENTRY under its live name: a line pinned to
//      an archived version and one to the live version are one row.
//   3. A section (a letter's fee group) is one row with its services and Depts,
//      a hand line naming one of its services included; a line raised by hand
//      with no service is "other".
//   4. Pending is owed at the close whenever it was billed; overdue is the part
//      past its due date; TDS is settled, not received.
//   5. Each client's total and each currency's total; the Key Manager and SPOC
//      filters (current assignments only); drafts and cancelled count nowhere.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/dashboard/client-summary.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresDashboardRepository } from "../../src/infrastructure/postgres/dashboard-repository";
import type { ClientSummaryQuery, ClientSummaryRow } from "../../src/usecase/dashboard/ports";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });
const stamp = Date.now().toString(36);

let firm = "";
let india = "";
let kaveri = "";
let tapti = "";
let narmada = "";
let mona = "";
let ravi = "";
let neha = "";
let sunil = "";
const entries: Record<string, string> = {};
const versions: Record<string, string> = {};
const depts: Record<string, string> = {};
let groupId = "";

async function party(name: string): Promise<string> {
  const [p] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name) VALUES (${firm}, 'organization', ${name}) RETURNING id
  `;
  if (!p) throw new Error("party seed failed");
  await owner`INSERT INTO core.organization (party_id, tenant_id, legal_name) VALUES (${p.id}, ${firm}, ${name})`;
  return p.id;
}

async function staff(name: string): Promise<string> {
  const [u] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`${name.toLowerCase()}-cs-${stamp}@example.test`}, ${name}) RETURNING id
  `;
  if (!u) throw new Error("user seed failed");
  await owner`INSERT INTO tenancy.membership (tenant_id, user_id, audience, role) VALUES (${firm}, ${u.id}, 'STAFF', 'partner')`;
  return u.id;
}

async function service(key: string, name: string, module: string, status: "published" | "archived", version = 1) {
  if (entries[key] === undefined) {
    const [e] = await owner<{ id: string }[]>`
      INSERT INTO config.entry (tenant_id, kind, key) VALUES (${firm}, 'service', ${`cs-${key}-${stamp}`}) RETURNING id
    `;
    if (!e) throw new Error("service seed failed");
    entries[key] = e.id;
  }
  const [v] = await owner<{ id: string }[]>`
    INSERT INTO config.version (tenant_id, entry_id, version, body, status, published_at, archived_at)
    VALUES (${firm}, ${entries[key] ?? ""}, ${version}, ${owner.json({ name, module })}, ${status}, now(),
            ${status === "archived" ? owner`now()` : null})
    RETURNING id
  `;
  if (!v) throw new Error("version seed failed");
  versions[`${key}${String(version)}`] = v.id;
  return v.id;
}

/** A signed letter for `client` with one line per service version, each line's engagement. */
async function letter(
  client: string,
  ref: string,
  lines: readonly { version: string; group?: string }[],
): Promise<string[]> {
  const [l] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter
      (tenant_id, party_id, status, currency, fx_rate, fx_rate_date, ref, issuing_entity_party_id, jurisdiction, title)
    VALUES (${firm}, ${client}, 'draft', 'INR', 1, '2026-03-20', ${ref}, ${india}, 'IN', 'Engagement')
    RETURNING id
  `;
  if (!l) throw new Error("letter seed failed");
  let group: string | null = null;
  if (lines.some((x) => x.group !== undefined)) {
    const [g] = await owner<{ id: string }[]>`
      INSERT INTO crm.engagement_letter_fee_group
        (tenant_id, engagement_letter_id, currency, position, title, billing_frequency, amount)
      VALUES (${firm}, ${l.id}, 'INR', 1, ${lines.find((x) => x.group !== undefined)?.group ?? ""}, 'monthly', 10000)
      RETURNING id
    `;
    if (!g) throw new Error("group seed failed");
    group = g.id;
    groupId = g.id;
  }
  const lineIds: string[] = [];
  for (const [i, x] of lines.entries()) {
    const [ln] = await owner<{ id: string }[]>`
      INSERT INTO crm.engagement_letter_line
        (tenant_id, engagement_letter_id, position, service_version_id, quantity, unit_amount,
         currency, discount_percent, billing_frequency, entity_party_id, description, fee_group_id)
      VALUES (${firm}, ${l.id}, ${i + 1}, ${x.version}, 1, ${x.group === undefined ? 1000 : null}, 'INR', 0,
              ${x.group === undefined ? "one_time" : null}, ${client}, ${`Signed wording ${String(i + 1)}`},
              ${x.group === undefined ? null : group})
      RETURNING id
    `;
    if (!ln) throw new Error("line seed failed");
    lineIds.push(ln.id);
  }
  await owner`
    UPDATE crm.engagement_letter
       SET status = 'signed', sent_at = now(), signed_at = now(), signed_by_name = 'A Director',
           signature_method = 'attested', signed_content_hash = ${"e".repeat(64)}
     WHERE id = ${l.id}
  `;
  const engagements: string[] = [];
  for (const ln of lineIds) {
    const [e] = await owner<{ id: string }[]>`
      INSERT INTO crm.engagement
        (tenant_id, party_id, entity_party_id, engagement_letter_id, engagement_letter_line_id, effective_from, status, activated_at)
      VALUES (${firm}, ${client}, ${client}, ${l.id}, ${ln}, '2026-04-01', 'active', now())
      RETURNING id
    `;
    if (!e) throw new Error("engagement seed failed");
    engagements.push(e.id);
  }
  return engagements;
}

let sequence = 0;
async function invoice(input: {
  client: string;
  lines: readonly { engagement: string | null; unit: string; tax: string }[];
  status: "draft" | "issued" | "cancelled";
  issuedOn: string | null;
  dueOn: string | null;
}): Promise<{ id: string; lines: string[] }> {
  sequence += 1;
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO crm.invoice
      (tenant_id, party_id, entity_party_id, number, financial_year, sequence_number,
       status, currency, fx_rate, fx_rate_date, issued_on, due_on)
    VALUES (${firm}, ${input.client}, ${india}, ${`CS/${stamp}/${String(sequence)}`}, 2026, ${sequence},
            'draft', 'INR', 1, '2026-04-01', null, ${input.dueOn})
    RETURNING id
  `;
  if (!row) throw new Error("invoice seed failed");
  const ids: string[] = [];
  for (const [i, l] of input.lines.entries()) {
    const [ln] = await owner<{ id: string }[]>`
      INSERT INTO crm.invoice_line
        (tenant_id, invoice_id, engagement_id, description, position, quantity, unit_amount, currency, tax_percent)
      VALUES (${firm}, ${row.id}, ${l.engagement}, 'Work', ${i + 1}, 1, ${l.unit}, 'INR', ${l.tax})
      RETURNING id
    `;
    if (!ln) throw new Error("invoice line seed failed");
    ids.push(ln.id);
  }
  if (input.status !== "draft") {
    await owner`UPDATE crm.invoice SET status = 'issued', issued_on = ${input.issuedOn} WHERE id = ${row.id}`;
  }
  if (input.status === "cancelled") await owner`UPDATE crm.invoice SET status = 'cancelled' WHERE id = ${row.id}`;
  return { id: row.id, lines: ids };
}

async function assign(
  client: string,
  role: "key_manager" | "spoc",
  user: string,
  dept: string | null,
  from = "2026-01-01",
  to: string | null = null,
) {
  await owner`
    INSERT INTO crm.client_assignment (tenant_id, client_party_id, role, axis_id, user_id, valid_from, valid_to)
    VALUES (${firm}, ${client}, ${role}, ${dept === null ? null : (depts[dept] ?? null)}, ${user}, ${from}, ${to})
  `;
}

const repo = new PostgresDashboardRepository(app);
const WINDOW: ClientSummaryQuery = { from: "2026-04-01", to: "2026-09-30", asOf: "2026-09-30", today: "2026-09-30" };
const read = (q: Partial<ClientSummaryQuery> = {}) => repo.clientSummary(firm, { ...WINDOW, ...q });
const subject = (rows: readonly ClientSummaryRow[], client: string, kind: string, name?: string) =>
  rows.find((r) => r.scope === "subject" && r.partyId === client && r.kind === kind && (name === undefined || r.name === name));
const figures = (r: ClientSummaryRow | undefined) =>
  r === undefined
    ? undefined
    : [r.billed, r.received, r.tds, r.pending, r.overdue].map((x) => Number(x).toFixed(4)).concat(String(r.invoices));

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency) VALUES (${`cs-${stamp}`}, ${`cs-${stamp}`}, 'INR') RETURNING id
  `;
  if (!t) throw new Error("tenant seed failed");
  firm = t.id;
  india = await party("The Firm India");
  await owner`INSERT INTO core.legal_entity (party_id, tenant_id, jurisdiction, entity_type)
              VALUES (${india}, ${firm}, 'IN', 'private_limited')`;
  await owner`INSERT INTO crm.firm_entity (tenant_id, party_id) VALUES (${firm}, ${india})`;
  for (const [type, prefix] of [["invoice", "INV"], ["credit_note", "CN"]] as const) {
    await owner`
      INSERT INTO crm.invoice_series (tenant_id, entity_party_id, financial_year, last_number, prefix, document_type)
      VALUES (${firm}, ${india}, 2026, 0, ${prefix}, ${type})
    `;
  }
  kaveri = await party(`Kaveri Foods ${stamp}`);
  tapti = await party(`Tapti Mills ${stamp}`);
  narmada = await party(`Narmada Exports ${stamp}`);
  mona = await staff("Mona");
  ravi = await staff("Ravi");
  neha = await staff("Neha");
  sunil = await staff("Sunil");
  for (const [code, name] of [["FRC", "Financial Reporting"], ["TRC", "Tax"]] as const) {
    const [d] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.service_axis (tenant_id, axis, code, name) VALUES (${firm}, 'dept', ${code}, ${name}) RETURNING id
    `;
    if (!d) throw new Error("dept seed failed");
    depts[code] = d.id;
  }
  // Accounting was republished under a new name: v1 archived, v2 live.
  await service("acc", "Accounting", "FRC", "archived", 1);
  await service("acc", "Accounting & Books", "FRC", "published", 2);
  await service("gst", "GST returns", "TRC", "published");
  await service("pay", "Payroll", "TRC", "published");

  // Kaveri: Mona is the Key Manager (Ravi was, until July); Ravi the FRC SPOC, Neha the TRC one.
  await assign(kaveri, "key_manager", ravi, null, "2025-01-01", "2026-07-01");
  await assign(kaveri, "key_manager", mona, null, "2026-07-01");
  await assign(kaveri, "spoc", ravi, "FRC");
  await assign(kaveri, "spoc", neha, "TRC");
  await assign(tapti, "key_manager", sunil, null);
  await assign(tapti, "spoc", neha, "TRC");

  const [accOld, gst] = await letter(kaveri, "EL-2026-0001", [
    { version: versions.acc1 ?? "" },
    { version: versions.gst1 ?? "" },
  ]);
  const [accNew] = await letter(kaveri, "EL-2026-0002", [{ version: versions.acc2 ?? "" }]);
  const [, payroll] = await letter(kaveri, "EL-2026-0003", [
    { version: versions.acc2 ?? "", group: "Retainer" },
    { version: versions.pay1 ?? "", group: "Retainer" },
  ]);
  const [taptiGst] = await letter(tapti, "EL-2026-0004", [{ version: versions.gst1 ?? "" }]);

  // I1: Accounting 1,00,000 + GST work 50,000, both at 18% = 1,77,000; due
  // 25 May. 59,000 paid, an 11,800 credit note. Owed 1,06,200, all overdue.
  const i1 = await invoice({
    client: kaveri,
    lines: [
      { engagement: accOld ?? null, unit: "100000", tax: "18" },
      { engagement: gst ?? null, unit: "50000", tax: "18" },
    ],
    status: "issued",
    issuedOn: "2026-05-10",
    dueOn: "2026-05-25",
  });
  await owner`INSERT INTO crm.payment (tenant_id, invoice_id, amount, currency, received_on, method)
              VALUES (${firm}, ${i1.id}, 59000, 'INR', '2026-06-01', 'bank_transfer')`;
  await owner`
    INSERT INTO crm.credit_note
      (tenant_id, invoice_id, entity_party_id, number, financial_year, sequence_number, amount, currency, issued_on, reason)
    VALUES (${firm}, ${i1.id}, ${india}, ${`CN/CS/${stamp}/1`}, 2026, 1, 11800, 'INR', '2026-06-15', 'goodwill')
  `;
  // I4: the live Accounting, billed in March (before the window), unpaid: owed only.
  await invoice({
    client: kaveri,
    lines: [{ engagement: accNew ?? null, unit: "20000", tax: "0" }],
    status: "issued",
    issuedOn: "2026-03-01",
    dueOn: "2026-03-31",
  });
  // I2: the section's August bill, no due date: owed, not overdue.
  const i2 = await invoice({
    client: kaveri,
    lines: [{ engagement: null, unit: "10000", tax: "0" }],
    status: "issued",
    issuedOn: "2026-08-01",
    dueOn: null,
  });
  await owner`
    INSERT INTO crm.billing_due
      (tenant_id, kind, party_id, issuing_entity_party_id, currency, fee_group_id, period_start, period_end,
       period_label, bill_on, full_amount, served_days, period_days, manager_how, manager_note,
       invoice_id, invoice_line_id)
    VALUES (${firm}, 'period', ${kaveri}, ${india}, 'INR', ${groupId}, '2026-07-01', '2026-07-31', 'Jul 2026',
            '2026-07-31', 10000, 31, 31, 'none', 'Fixture', ${i2.id}, ${i2.lines[0] ?? null})
  `;
  // I7: raised by hand for Payroll, a service in the section: the section's.
  await invoice({
    client: kaveri,
    lines: [{ engagement: payroll ?? null, unit: "3000", tax: "0" }],
    status: "issued",
    issuedOn: "2026-09-10",
    dueOn: null,
  });
  // I5: raised by hand, no service.
  await invoice({
    client: kaveri,
    lines: [{ engagement: null, unit: "5000", tax: "0" }],
    status: "issued",
    issuedOn: "2026-09-01",
    dueOn: null,
  });
  // I3: Tapti's GST, 20,000; 18,000 paid and 2,000 TDS: nothing owed.
  const i3 = await invoice({
    client: tapti,
    lines: [{ engagement: taptiGst ?? null, unit: "20000", tax: "0" }],
    status: "issued",
    issuedOn: "2026-07-01",
    dueOn: "2026-07-15",
  });
  await owner`INSERT INTO crm.payment (tenant_id, invoice_id, amount, tds_amount, currency, received_on, method)
              VALUES (${firm}, ${i3.id}, 18000, 2000, 'INR', '2026-07-10', 'bank_transfer')`;
  // I6: Narmada's advance taken before its letter (0363), 30,000 + 18%, no
  // due date, 11,800 paid: 20,000 mapped to its GST work, 10,000 to nothing.
  const [narmadaGst] = await letter(narmada, "EL-2026-0005", [{ version: versions.gst1 ?? "" }]);
  const i6 = await invoice({
    client: narmada,
    lines: [{ engagement: null, unit: "30000", tax: "18" }],
    status: "issued",
    issuedOn: "2026-09-15",
    dueOn: null,
  });
  const [adv] = await owner<{ id: string }[]>`
    INSERT INTO crm.adhoc_advance (tenant_id, invoice_id, currency, raised_by_user_id)
    VALUES (${firm}, ${i6.id}, 'INR', ${mona}) RETURNING id
  `;
  if (!adv) throw new Error("advance seed failed");
  await owner`
    INSERT INTO crm.advance_allocation
      (tenant_id, adhoc_advance_id, invoice_id, currency, engagement_id, amount, manager_user_id, how, reason)
    VALUES (${firm}, ${adv.id}, ${i6.id}, 'INR', ${narmadaGst ?? null}, 20000, ${mona}, 'by_hand', 'Fixture')
  `;
  await owner`INSERT INTO crm.payment (tenant_id, invoice_id, amount, currency, received_on, method)
              VALUES (${firm}, ${i6.id}, 11800, 'INR', '2026-09-20', 'bank_transfer')`;
  // Nowhere: a draft and a cancelled one.
  await invoice({ client: kaveri, lines: [{ engagement: gst ?? null, unit: "999", tax: "0" }], status: "draft", issuedOn: null, dueOn: null });
  await invoice({
    client: kaveri,
    lines: [{ engagement: gst ?? null, unit: "888", tax: "0" }],
    status: "cancelled",
    issuedOn: "2026-06-01",
    dueOn: null,
  });
});

afterAll(async () => {
  await Promise.all([owner.end({ timeout: 5 }), app.end({ timeout: 5 })]);
});

describe("the client summary", () => {
  it("splits one invoice's credit note, money and balance between its services", async () => {
    const rows = await read();
    // Accounting: 2/3 of I1, plus I4's 20,000 owed (billed before the window).
    expect(figures(subject(rows, kaveri, "service", "Accounting & Books"))).toEqual([
      "110133.3333", "39333.3333", "0.0000", "90800.0000", "90800.0000", "1",
    ]);
    expect(figures(subject(rows, kaveri, "service", "GST returns"))).toEqual([
      "55066.6667", "19666.6667", "0.0000", "35400.0000", "35400.0000", "1",
    ]);
  });

  it("is one row per catalogue service under its live name, with its Dept", async () => {
    const rows = await read();
    const acc = rows.filter((r) => r.scope === "subject" && r.partyId === kaveri && r.subjectKey === entries.acc);
    expect(acc).toHaveLength(1);
    expect(acc[0]?.name).toBe("Accounting & Books");
    expect(acc[0]?.deptCodes).toEqual(["FRC"]);
  });

  it("keeps a section whole (a line naming a service in it too), and a line with no service apart", async () => {
    const rows = await read();
    const section = subject(rows, kaveri, "section");
    expect(section?.name).toBe("Retainer");
    expect(section?.services).toEqual(["Accounting & Books", "Payroll"]);
    expect([...(section?.deptCodes ?? [])].sort()).toEqual(["FRC", "TRC"]);
    expect(figures(section)).toEqual(["13000.0000", "0.0000", "0.0000", "13000.0000", "0.0000", "2"]);
    expect(figures(subject(rows, kaveri, "other"))).toEqual(["5000.0000", "0.0000", "0.0000", "5000.0000", "0.0000", "1"]);
  });

  it("counts TDS as settled, not received", async () => {
    const rows = await read();
    expect(figures(subject(rows, tapti, "service", "GST returns"))).toEqual([
      "20000.0000", "18000.0000", "2000.0000", "0.0000", "0.0000", "1",
    ]);
  });

  it("splits an advance taken before the letter by its mappings", async () => {
    const rows = await read();
    expect(figures(subject(rows, narmada, "service", "GST returns"))).toEqual([
      "23600.0000", "7866.6667", "0.0000", "15733.3333", "0.0000", "1",
    ]);
    expect(figures(subject(rows, narmada, "advance"))).toEqual([
      "11800.0000", "3933.3333", "0.0000", "7866.6667", "0.0000", "1",
    ]);
  });

  it("totals each client and each currency, drafts and cancelled nowhere", async () => {
    const rows = await read();
    const client = rows.find((r) => r.scope === "client" && r.partyId === kaveri);
    expect(figures(client)).toEqual(["183200.0000", "59000.0000", "0.0000", "144200.0000", "126200.0000", "4"]);
    const inr = rows.find((r) => r.scope === "currency" && r.currency === "INR");
    expect(figures(inr)).toEqual(["238600.0000", "88800.0000", "2000.0000", "167800.0000", "126200.0000", "6"]);
  });

  it("reads only its own firm's invoices", async () => {
    const [t] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.tenant (slug, name, reporting_currency) VALUES (${`cs-other-${stamp}`}, 'Other', 'INR') RETURNING id
    `;
    expect(await repo.clientSummary(t?.id ?? "", WINDOW)).toEqual([]);
  });

  it("keeps a Key Manager's clients: the one in force, not the one before", async () => {
    const mine = await read({ keyManagerUserId: mona });
    expect(new Set(mine.filter((r) => r.partyId !== null).map((r) => r.partyId))).toEqual(new Set([kaveri]));
    expect(figures(mine.find((r) => r.scope === "currency"))?.[0]).toBe("183200.0000");
    const before = await read({ keyManagerUserId: ravi });
    expect(before).toEqual([]);
  });

  it("keeps a SPOC's rows: the client, and the Dept of the work", async () => {
    const frc = await read({ spocUserId: ravi });
    const kinds = frc.filter((r) => r.scope === "subject").map((r) => `${r.kind ?? ""}:${r.name ?? ""}`).sort();
    expect(kinds).toEqual(["section:Retainer", "service:Accounting & Books"]);
    const trc = await read({ spocUserId: neha });
    const names = trc.filter((r) => r.scope === "subject").map((r) => `${r.partyId === tapti ? "T" : "K"}:${r.name ?? ""}`).sort();
    expect(names).toEqual(["K:GST returns", "K:Retainer", "T:GST returns"]);
  });

  it("names the account team in force, with the Depts", async () => {
    const teams = await repo.accountTeams(firm, [kaveri, tapti], "2026-09-30");
    const km = teams.people.filter((p) => p.role === "key_manager").map((p) => [p.clientPartyId, p.name]);
    expect(km).toEqual(expect.arrayContaining([[kaveri, "Mona"], [tapti, "Sunil"]]));
    expect(km).toHaveLength(2);
    expect(teams.people.filter((p) => p.role === "spoc" && p.clientPartyId === kaveri).map((p) => [p.name, p.deptCode]).sort())
      .toEqual([["Neha", "TRC"], ["Ravi", "FRC"]]);
    expect(teams.depts).toEqual([
      { code: "FRC", name: "Financial Reporting" },
      { code: "TRC", name: "Tax" },
    ]);
  });
});
