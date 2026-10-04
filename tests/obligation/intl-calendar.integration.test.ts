// Client filings across countries (Q070 Part B): the SQL, against a real
// database.
//
//   B1. A filing's day is read in ITS zone: the client entity's own, else its
//       country's (New York for the US), else the firm's company in that
//       country, else the firm's. `listMissable` judges each row on it and the
//       calendar reports it as `filingZone` / `filingToday`.
//   B2. `subjectsFor` carries the client's year end; a period cut on the
//       client's year never overlaps one already held (0358, Q078's default),
//       and every row records the basis it was cut on.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/obligation/intl-calendar.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { load } from "../../src/config/config";
import {
  PostgresCalendarSource,
  PostgresObligationInstanceRepository,
} from "../../src/infrastructure/postgres/obligation-instance-repository";
import type { NewObligationInstance } from "../../src/usecase/obligation/ports";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 2 });
const app = postgres(cfg.db.appUrl, { max: 2 });
const instances = new PostgresObligationInstanceRepository(app);
const calendarSource = new PostgresCalendarSource(app);

const stamp = Date.now().toString(36);
let tenant = "";
let userId = "";
let client = "";
let pending = "";

/** A client company registered in `country`, with an optional zone and year end. */
async function company(
  name: string,
  country: string,
  over: { zone?: string; yearEnd?: string; firm?: boolean } = {},
): Promise<string> {
  const [p] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenant}, 'organization', ${name}) RETURNING id
  `;
  if (!p) throw new Error("party seed failed");
  await owner`INSERT INTO core.organization (party_id, tenant_id, legal_name) VALUES (${p.id}, ${tenant}, ${name})`;
  await owner`
    INSERT INTO core.legal_entity (tenant_id, party_id, jurisdiction, entity_type, status, time_zone, financial_year_end)
    VALUES (${tenant}, ${p.id}, ${country}, 'private_limited', 'active', ${over.zone ?? null}, ${over.yearEnd ?? null})
  `;
  if (over.firm) await owner`INSERT INTO crm.firm_entity (tenant_id, party_id) VALUES (${tenant}, ${p.id})`;
  return p.id;
}

async function rule(name: string, country: string, recurrence = "monthly", basis = "rule_calendar"): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_template
      (tenant_id, jurisdiction, name, recurrence, fiscal_year_start_month,
       due_rule, due_month_offset, due_day_of_month, rule_pack, status, period_basis)
    VALUES (${tenant}, ${country}, ${name}, ${recurrence}, 4, 'day_of_month', 1, 28,
            ${`intl-${stamp}@1`}, 'confirmed', ${basis})
    RETURNING id
  `;
  if (!row) throw new Error("rule seed failed");
  return row.id;
}

async function filingDue(ruleId: string, entity: string, due: string): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_instance
      (tenant_id, template_id, entity_party_id, period_start, period_end, period_label,
       statutory_due_on, internal_target_on, state_id)
    VALUES (${tenant}, ${ruleId}, ${entity}, '2026-09-01', '2026-09-30', 'Sep 2026',
            ${due}::date, ${due}::date, ${pending})
    RETURNING id
  `;
  if (!row) throw new Error("filing seed failed");
  return row.id;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, time_zone)
    VALUES (${`intl-${stamp}`}, 'Intl Calendar QA', 'INR', 'Asia/Kolkata') RETURNING id
  `;
  if (!t) throw new Error("tenant seed failed");
  tenant = t.id;
  const [u] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email) VALUES (${`intl-${stamp}@example.test`}) RETURNING id
  `;
  if (!u) throw new Error("user seed failed");
  userId = u.id;
  const [c] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name) VALUES (${tenant}, 'organization', 'Global Group') RETURNING id
  `;
  if (!c) throw new Error("client seed failed");
  client = c.id;
  const [pend] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_state (tenant_id, code, name, is_initial, sort_order)
    VALUES (${tenant}, 'pending', 'Pending', true, 10) RETURNING id
  `;
  await owner`
    INSERT INTO delivery.obligation_state (tenant_id, code, name, is_terminal, is_filed, sort_order)
    VALUES (${tenant}, 'filed', 'Filed', true, true, 90)
  `;
  if (!pend) throw new Error("state seed failed");
  pending = pend.id;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

describe("B1: a filing is judged on its own country's day", () => {
  // 19:00 UTC on 28 Oct: 00:30 on the 29th in India, 23:00 on the 28th in
  // Dubai, 15:00 in New York, 12:00 in Los Angeles, 06:00 on the 29th in
  // Sydney. Every filing below is due on the 28th.
  const NOW = "2026-10-28T19:00:00Z";
  const FIRM_DAY = "2026-10-29";
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const india = await company("Kaveri Foods Pvt Ltd", "IN");
    const uae = await company("Gulf Trading FZ-LLC", "AE");
    const us = await company("Hudson Analytics Inc", "US");
    const california = await company("Pacific Labs Inc", "US", { zone: "America/Los_Angeles" });
    const australia = await company("Harbour Pty Ltd", "AU");
    await company("10x Advisory Australia Pty Ltd", "AU", { zone: "Australia/Sydney", firm: true });
    ids["IN"] = await filingDue(await rule("GSTR-3B", "IN"), india, "2026-10-28");
    ids["AE"] = await filingDue(await rule("VAT return", "AE"), uae, "2026-10-28");
    const usRule = await rule("Form 941", "US");
    ids["US"] = await filingDue(usRule, us, "2026-10-28");
    ids["US-LA"] = await filingDue(usRule, california, "2026-10-28");
    ids["AU"] = await filingDue(await rule("BAS", "AU"), australia, "2026-10-28");
  });

  it("flags India's and Australia's (whose midnight has passed), not Dubai's, New York's or LA's", async () => {
    const missable = await instances.listMissable(tenant, FIRM_DAY, null, 500, NOW);
    const by = new Map(missable.map((m) => [m.id, m]));
    expect(by.has(ids["IN"] ?? "")).toBe(true);
    expect(by.has(ids["AU"] ?? "")).toBe(true);
    expect(by.has(ids["AE"] ?? "")).toBe(false);
    expect(by.has(ids["US"] ?? "")).toBe(false);
    expect(by.has(ids["US-LA"] ?? "")).toBe(false);
    expect(by.get(ids["IN"] ?? "")).toMatchObject({ filingDay: "2026-10-29", filingZone: "Asia/Kolkata" });
    // No country zone for AU: the firm's own Australian company's.
    expect(by.get(ids["AU"] ?? "")).toMatchObject({ filingDay: "2026-10-29", filingZone: "Australia/Sydney" });
  });

  it("an hour and a half later, Dubai's has passed too; New York's has not", async () => {
    const missable = await instances.listMissable(tenant, FIRM_DAY, null, 500, "2026-10-28T20:30:00Z");
    const found = new Set(missable.map((m) => m.id));
    expect(found.has(ids["AE"] ?? "")).toBe(true);
    expect(found.has(ids["US"] ?? "")).toBe(false);
  });

  it("the calendar says whose day each row is on", async () => {
    const rows = await instances.calendar(tenant, { now: NOW, includeSettled: true, limit: 500 });
    const by = new Map(rows.map((r) => [r.id, r]));
    expect(by.get(ids["IN"] ?? "")).toMatchObject({ filingZone: "Asia/Kolkata", filingToday: "2026-10-29" });
    expect(by.get(ids["AE"] ?? "")).toMatchObject({ filingZone: "Asia/Dubai", filingToday: "2026-10-28" });
    expect(by.get(ids["US"] ?? "")).toMatchObject({ filingZone: "America/New_York", filingToday: "2026-10-28" });
    expect(by.get(ids["US-LA"] ?? "")).toMatchObject({ filingZone: "America/Los_Angeles", filingToday: "2026-10-28" });
    expect(by.get(ids["AU"] ?? "")).toMatchObject({ filingZone: "Australia/Sydney", filingToday: "2026-10-29" });
  });
});

describe("B2: periods on the client's year end", () => {
  it("hands the generator each subject's year end", async () => {
    const sg = await company("Lion City Pte Ltd", "SG", { yearEnd: "12-31" });
    const [entry] = await owner<{ id: string }[]>`
      INSERT INTO config.entry (tenant_id, kind, key) VALUES (${tenant}, 'service', ${`sg-${stamp}`}) RETURNING id
    `;
    if (!entry) throw new Error("entry seed failed");
    const [version] = await owner<{ id: string }[]>`
      INSERT INTO config.version (tenant_id, entry_id, version, body, status, published_at)
      VALUES (${tenant}, ${entry.id}, 1, ${owner.json({ name: "SG annual" })}, 'published', now()) RETURNING id
    `;
    if (!version) throw new Error("version seed failed");
    const r = await rule("Annual return", "SG", "annual", "client_year_end");
    await owner`
      INSERT INTO delivery.obligation_rule_service (tenant_id, lineage_id, service_entry_id, linked_by_user_id)
      VALUES (${tenant}, ${r}, ${entry.id}, ${userId})
    `;
    const [letter] = await owner<{ id: string }[]>`
      INSERT INTO crm.engagement_letter
        (tenant_id, party_id, status, currency, fx_rate, fx_rate_date, ref, issuing_entity_party_id, jurisdiction, title)
      VALUES (${tenant}, ${client}, 'draft', 'INR', 1, CURRENT_DATE, 'EL-2026-0001', ${sg}, 'SG', 'Engagement')
      RETURNING id
    `;
    if (!letter) throw new Error("letter seed failed");
    const [line] = await owner<{ id: string }[]>`
      INSERT INTO crm.engagement_letter_line
        (tenant_id, engagement_letter_id, position, service_version_id, quantity, unit_amount, currency,
         discount_percent, billing_frequency, entity_party_id, description, pricing_note)
      VALUES (${tenant}, ${letter.id}, 1, ${version.id}, 1, 5000, 'INR', 0, 'annually', ${sg}, 'Annual', 'Priced')
      RETURNING id
    `;
    if (!line) throw new Error("line seed failed");
    await owner`
      UPDATE crm.engagement_letter
         SET status = 'signed', sent_at = now(), signed_at = now(), signed_by_name = 'A Director',
             signature_method = 'attested', signed_content_hash = ${"a".repeat(64)}
       WHERE id = ${letter.id}
    `;
    await owner`
      INSERT INTO crm.engagement
        (tenant_id, party_id, entity_party_id, engagement_letter_id, engagement_letter_line_id,
         effective_from, status, activated_at)
      VALUES (${tenant}, ${client}, ${sg}, ${letter.id}, ${line.id}, '2026-01-01', 'active', now())
    `;
    const subjects = await calendarSource.subjectsFor(tenant, { lineageId: r, jurisdiction: "SG", entityType: null });
    expect(subjects.map((s) => [s.entityPartyId, s.financialYearEnd])).toEqual([[sg, "12-31"]]);
  });

  it("never writes a client-year period over one already held, and records the basis", async () => {
    const sg = await company("Merlion Holdings Pte Ltd", "SG", { yearEnd: "06-30" });
    const r = await rule("Corporate income tax", "SG", "annual", "client_year_end");
    const propose = (start: string, end: string, label: string, basis: NewObligationInstance["periodBasis"]) =>
      instances.createIfAbsent([
        {
          id: randomUUID(),
          tenantId: tenant,
          templateId: r,
          entityPartyId: sg,
          engagementId: null,
          periodStart: start,
          periodEnd: end,
          periodLabel: label,
          statutoryDueOn: "2027-11-30",
          internalTargetOn: "2027-11-30",
          stateId: pending,
          periodBasis: basis,
        },
      ]);
    // Generated while the client was on a December year end.
    const first = await propose("2026-01-01", "2026-12-31", "2026", "client_year_end");
    expect(first.created).toHaveLength(1);
    // Now on June: July 2026 to June 2027 overlaps it, and is not written.
    expect((await propose("2026-07-01", "2027-06-30", "FY2026-27", "client_year_end")).created).toHaveLength(0);
    // The next one clear of it is.
    expect((await propose("2027-07-01", "2028-06-30", "FY2027-28", "client_year_end")).created).toHaveLength(1);
    // A fallback row says so.
    const fb = await propose("2028-07-01", "2029-06-30", "FY2028-29", "rule_fallback");
    const [made] = fb.created;
    expect((await instances.findById(tenant, made?.id ?? ""))?.periodBasis).toBe("rule_fallback");
  });

  it("refuses a basis the schema does not know (0358)", async () => {
    await expect(
      owner`
        INSERT INTO delivery.obligation_template
          (tenant_id, jurisdiction, name, recurrence, fiscal_year_start_month, due_rule, due_month_offset,
           due_day_of_month, rule_pack, status, period_basis)
        VALUES (${tenant}, 'SG', 'Bad', 'annual', 4, 'day_of_month', 1, 28, ${`bad-${stamp}`}, 'confirmed', 'the_moon')
      `,
    ).rejects.toThrow(/obligation_template_period_basis_check/);
  });
});
