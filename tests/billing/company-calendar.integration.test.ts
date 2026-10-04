// The days billing reads off the database are the issuing COMPANY's (0337):
// the day a letter was signed (an advance bill's date) and the day a job
// finished (a final bill's date), cut on crm.issuer_zone, the company's zone
// else the firm's.
//
// The firm sits on Pacific/Kiritimati (UTC+14) and its company on
// Pacific/Pago_Pago (UTC-11): 25 hours apart, so ANY instant falls on two
// different days, and the test cannot pass by the firm's day by accident.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/billing/company-calendar.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresAdvanceBillFacts, PostgresFinalBillFacts } from "../../src/infrastructure/postgres/billing-facts";
import { PostgresBillingSchedules } from "../../src/infrastructure/postgres/billing-desk";
import { PostgresBillingDueWriter } from "../../src/infrastructure/postgres/billing-repository";
import { PostgresJobRepository } from "../../src/infrastructure/postgres/job-repository";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });
const advanceFacts = new PostgresAdvanceBillFacts(app);
const finalFacts = new PostgresFinalBillFacts(app);
const schedules = new PostgresBillingSchedules(app);
const dueWriter = new PostgresBillingDueWriter(app);
const jobs = new PostgresJobRepository(app);

const stamp = Date.now().toString(36);
const INSTANT = "2026-10-31T20:00:00Z"; // Pago Pago: 31 Oct 09:00. Kiritimati: 1 Nov 10:00.
let tenantId = "";
let client = "";
let farWest = "";
let firmItself = "";

async function organization(name: string): Promise<string> {
  const [p] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name) VALUES (${tenantId}, 'organization', ${name}) RETURNING id
  `;
  if (!p) throw new Error("party seed failed");
  await owner`INSERT INTO core.organization (party_id, tenant_id, legal_name) VALUES (${p.id}, ${tenantId}, ${name})`;
  return p.id;
}

let services = 0;
async function oneTimeService(): Promise<string> {
  services += 1;
  const [entry] = await owner<{ id: string }[]>`
    INSERT INTO config.entry (tenant_id, kind, key) VALUES (${tenantId}, 'service', ${`audit-${String(services)}-${stamp}`}) RETURNING id
  `;
  if (!entry) throw new Error("service seed failed");
  const [version] = await owner<{ id: string }[]>`
    INSERT INTO config.version (tenant_id, entry_id, version, body, status, published_at)
    VALUES (${tenantId}, ${entry.id}, 1, ${owner.json({ name: "Audit", recurrence: "one_time", module: "FRC" })}, 'published', now())
    RETURNING id
  `;
  if (!version) throw new Error("version seed failed");
  return version.id;
}

/** A letter by `issuer`, signed at INSTANT, with one one-time engagement whose
 *  job finished at INSTANT. */
async function signedLetter(issuer: string, ref: string): Promise<{ letterId: string; engagementId: string }> {
  const [l] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter
      (tenant_id, party_id, status, currency, fx_rate, fx_rate_date, ref, issuing_entity_party_id,
       jurisdiction, title, advance_required, advance_amount)
    VALUES (${tenantId}, ${client}, 'draft', 'INR', 1, '2026-10-01', ${ref}, ${issuer}, 'IN', 'Engagement', true, 10000)
    RETURNING id
  `;
  if (!l) throw new Error("letter seed failed");
  const version = await oneTimeService();
  const [ln] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter_line
      (tenant_id, engagement_letter_id, position, service_version_id, quantity, unit_amount, currency,
       discount_percent, billing_frequency, entity_party_id, description)
    VALUES (${tenantId}, ${l.id}, 1, ${version}, 1, 50000, 'INR', 0, 'one_time', ${client}, 'Statutory audit')
    RETURNING id
  `;
  if (!ln) throw new Error("line seed failed");
  await owner`
    UPDATE crm.engagement_letter
       SET status = 'signed', sent_at = ${INSTANT}::timestamptz, signed_at = ${INSTANT}::timestamptz,
           signed_by_name = 'A Director', signature_method = 'attested', signed_content_hash = ${"c".repeat(64)}
     WHERE id = ${l.id}
  `;
  const [e] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement
      (tenant_id, party_id, entity_party_id, engagement_letter_id, engagement_letter_line_id, effective_from, status)
    VALUES (${tenantId}, ${client}, ${client}, ${l.id}, ${ln.id}, '2026-10-01'::date, 'pending_advance')
    RETURNING id
  `;
  if (!e) throw new Error("engagement seed failed");
  const [j] = await owner<{ id: string }[]>`
    INSERT INTO delivery.job (tenant_id, source_kind, source_ref, status, started_at, finished_at)
    VALUES (${tenantId}, 'engagement', ${e.id}, 'done', ${INSTANT}::timestamptz, ${INSTANT}::timestamptz)
    RETURNING id
  `;
  if (!j) throw new Error("job seed failed");
  await owner`INSERT INTO delivery.job_engagement (tenant_id, job_id, engagement_id) VALUES (${tenantId}, ${j.id}, ${e.id})`;
  return { letterId: l.id, engagementId: e.id };
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, time_zone)
    VALUES (${`cal-bill-${stamp}`}, ${`cal-bill-${stamp}`}, 'INR', 'Pacific/Kiritimati') RETURNING id
  `;
  if (!t) throw new Error("tenant seed failed");
  tenantId = t.id;
  client = await organization("Kaveri Foods Private Limited");
  farWest = await organization("Far West Advisory Inc");
  firmItself = await organization("Far East Advisory Ltd");
  await owner`
    INSERT INTO core.legal_entity (party_id, tenant_id, jurisdiction, entity_type, time_zone)
    VALUES (${farWest}, ${tenantId}, 'AS', 'Inc', 'Pacific/Pago_Pago')
  `;
  await owner`INSERT INTO crm.firm_entity (tenant_id, party_id) VALUES (${tenantId}, ${farWest}), (${tenantId}, ${firmItself})`;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

describe("billing reads the company's day off the database (0337)", () => {
  it("dates the day a letter was signed on its company's clock", async () => {
    const west = await signedLetter(farWest, "EL-2026-0001");
    const own = await signedLetter(firmItself, "EL-2026-0002");
    expect((await advanceFacts.advanceFactsOf(tenantId, west.letterId))?.signedOn).toBe("2026-10-31");
    expect((await advanceFacts.advanceFactsOf(tenantId, own.letterId))?.signedOn).toBe("2026-11-01");
  });

  it("dates the day a job finished on its letter's company's clock", async () => {
    const west = await signedLetter(farWest, "EL-2026-0003");
    const own = await signedLetter(firmItself, "EL-2026-0004");
    const [w] = await finalFacts.oneTimeSubjects(tenantId, { engagementId: west.engagementId });
    const [o] = await finalFacts.oneTimeSubjects(tenantId, { engagementId: own.engagementId });
    expect(w?.engagements[0]?.job?.doneOn).toBe("2026-10-31");
    expect(o?.engagements[0]?.job?.doneOn).toBe("2026-11-01");
  });
});

/** An ACTIVE engagement on a yearly service of a letter by `issuer`. */
async function yearlyEngagement(issuer: string, ref: string): Promise<string> {
  services += 1;
  const [entry] = await owner<{ id: string }[]>`
    INSERT INTO config.entry (tenant_id, kind, key) VALUES (${tenantId}, 'service', ${`yearly-${String(services)}-${stamp}`}) RETURNING id
  `;
  if (!entry) throw new Error("service seed failed");
  const [version] = await owner<{ id: string }[]>`
    INSERT INTO config.version (tenant_id, entry_id, version, body, status, published_at)
    VALUES (${tenantId}, ${entry.id}, 1, ${owner.json({ name: "Annual return", recurrence: "annually", module: "FRC" })}, 'published', now())
    RETURNING id
  `;
  if (!version) throw new Error("version seed failed");
  const [l] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter
      (tenant_id, party_id, status, currency, fx_rate, fx_rate_date, ref, issuing_entity_party_id, jurisdiction, title)
    VALUES (${tenantId}, ${client}, 'draft', 'INR', 1, '2026-04-01', ${ref}, ${issuer}, 'IN', 'Engagement')
    RETURNING id
  `;
  if (!l) throw new Error("letter seed failed");
  const [ln] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter_line
      (tenant_id, engagement_letter_id, position, service_version_id, quantity, unit_amount, currency,
       discount_percent, billing_frequency, entity_party_id, description)
    VALUES (${tenantId}, ${l.id}, 1, ${version.id}, 1, 50000, 'INR', 0, 'annually', ${client}, 'Annual return')
    RETURNING id
  `;
  if (!ln) throw new Error("line seed failed");
  await owner`
    UPDATE crm.engagement_letter
       SET status = 'signed', sent_at = ${INSTANT}::timestamptz, signed_at = ${INSTANT}::timestamptz,
           signed_by_name = 'A Director', signature_method = 'attested', signed_content_hash = ${"d".repeat(64)}
     WHERE id = ${l.id}
  `;
  const [e] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement
      (tenant_id, party_id, entity_party_id, engagement_letter_id, engagement_letter_line_id, effective_from, status, activated_at)
    VALUES (${tenantId}, ${client}, ${client}, ${l.id}, ${ln.id}, '2026-04-01'::date, 'active', ${INSTANT}::timestamptz)
    RETURNING id
  `;
  if (!e) throw new Error("engagement seed failed");
  return e.id;
}

describe("an engagement keeps the year it was first cut on (0338)", () => {
  it("pins the year when billing is scheduled, never moves it, and reads it back", async () => {
    const id = await yearlyEngagement(farWest, "EL-2026-0011");
    await schedules.set(tenantId, [id], "2026-04-01", "2027-04-01", 4);
    await schedules.set(tenantId, [id], "2026-04-01", "2027-04-01", 1);
    expect((await schedules.find(tenantId, id))?.yearStartMonth).toBe(4);
    const subject = (await dueWriter.subjectsFor(tenantId)).find((s) => s.engagementId === id);
    expect(subject?.yearStartMonth).toBe(4);
    const row = (await jobs.activeRecurring(tenantId, 100)).find((r) => r.engagementId === id);
    expect(row?.yearStartMonth).toBe(4);
  });

  it("pins an unpinned engagement when its first period is cut, once", async () => {
    const id = await yearlyEngagement(farWest, "EL-2026-0012");
    expect((await jobs.activeRecurring(tenantId, 100)).find((r) => r.engagementId === id)?.yearStartMonth).toBeNull();
    await jobs.pinYearStarts(tenantId, [{ engagementId: id, month: 1 }]);
    await jobs.pinYearStarts(tenantId, [{ engagementId: id, month: 7 }]);
    expect((await jobs.activeRecurring(tenantId, 100)).find((r) => r.engagementId === id)?.yearStartMonth).toBe(1);
  });
});
