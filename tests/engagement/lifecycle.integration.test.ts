// An engagement can end, pause and resume, and a client can then be put away
// (V2.3, V2.4, migration 0314) — against a REAL database, because every claim
// below is about SQL a fake cannot reproduce.
//
// ── WHAT IS PROVED HERE AND NOWHERE ELSE ───────────────────────────────────
//
//   1. THE SPAWN FILTER. An engagement ended on 30 September is still offered
//      by the recurring feed, with its last day, and the period rule then owes
//      it no October; a paused one is not offered; an archived client's is not
//      offered by either feed; the one-time feed offers only active ones.
//   2. Ending withdraws the engagement's untouched upcoming filings for
//      periods AFTER its last day, through T6.16's withdrawal, in the same
//      transaction, with reason `engagement_ended`; September and the past
//      ones stay.
//   3. THE GENERATOR'S CEILING. The ended engagement is still a subject, up to
//      its last day, so a rerun restores nothing after it and loses nothing
//      before it.
//   4. 0314's walls: an end record needs an ended status, a pause stamp needs
//      `paused`, and the reason is never blank.
//   5. THE ARCHIVE GUARD counts only live references: a live engagement
//      refuses, and once it has ended the client can be put away.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/engagement/lifecycle.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { load } from "../../src/config/config";
import { PostgresConfigRepository } from "../../src/infrastructure/postgres/config-repository";
import { PostgresEngagementLifecycle } from "../../src/infrastructure/postgres/engagement-lifecycle";
import { PostgresJobRepository } from "../../src/infrastructure/postgres/job-repository";
import {
  PostgresCalendarSource,
  PostgresObligationInstanceRepository,
} from "../../src/infrastructure/postgres/obligation-instance-repository";
import { PostgresRuleServiceLinkRepository } from "../../src/infrastructure/postgres/obligation-link-repository";
import {
  PostgresObligationExceptionRepository,
  PostgresObligationStateRepository,
  PostgresObligationTemplateRepository,
  PostgresResolutionOptionRepository,
} from "../../src/infrastructure/postgres/obligation-rule-repository";
import { PostgresPartyRepository } from "../../src/infrastructure/postgres/party-repository";
import { periodsToMaterialise } from "../../src/domain/scheduler/model";
import { systemIds } from "../../src/platform/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { ObligationService } from "../../src/usecase/obligation/service";
import type { Actor } from "../../src/domain/ledger/model";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 4 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

/** The firm's today for the whole file: Monday 29 September 2026. */
const TODAY = "2026-09-29";

const lifecycle = new PostgresEngagementLifecycle(app);
const jobs = new PostgresJobRepository(app);
const parties = new PostgresPartyRepository(app);
const calendarSource = new PostgresCalendarSource(app);
const obligations = new ObligationService({
  timeZones: new FakeFirmTimeZone(),
  templates: new PostgresObligationTemplateRepository(app),
  exceptions: new PostgresObligationExceptionRepository(app),
  states: new PostgresObligationStateRepository(app),
  resolutionOptions: new PostgresResolutionOptionRepository(app),
  instances: new PostgresObligationInstanceRepository(app),
  links: new PostgresRuleServiceLinkRepository(app),
  compliancePolicy: { missedFromOn: () => Promise.resolve(null) },
  calendarSource,
  services: new PostgresConfigRepository(app),
  workItems: { raiseForObligation: () => Promise.reject(new Error("not used in this test")) },
  tenants: { activeTenantIds: () => Promise.resolve([]) },
  ids: systemIds,
  clock: { now: () => new Date(`${TODAY}T06:00:00Z`) },
  events: new RecordingEventSink(),
});

const stamp = Date.now().toString(36);
let tenantId = "";
let userId = "";
let actor: Actor = { type: "system", id: null };
let clientId = "";
let books = { entryId: "", versionId: "" };
/** Kaveri: ended on 30 September. Lotus: paused. Indus: active, then archived. */
let kaveri = "";
let lotus = "";
let indus = "";
let kaveriBooks = "";
let lotusBooks = "";
let indusBooks = "";
let gstr3b = "";

async function company(name: string): Promise<string> {
  const [p] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name) VALUES (${tenantId}, 'organization', ${name})
    RETURNING id
  `;
  if (!p) throw new Error("party seed failed");
  await owner`INSERT INTO core.organization (party_id, tenant_id, legal_name) VALUES (${p.id}, ${tenantId}, ${name})`;
  await owner`
    INSERT INTO core.legal_entity (tenant_id, party_id, jurisdiction, entity_type, status)
    VALUES (${tenantId}, ${p.id}, 'IN', 'private_limited', 'active')
  `;
  return p.id;
}

/** A signed letter with one monthly line, and its engagement, active from 1 July.
 *  The company is its own client, so archiving the company is archiving the client. */
let letters = 0;
async function monthlyBooksFor(entity: string): Promise<string> {
  letters += 1;
  const [letter] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter
      (tenant_id, party_id, status, currency, fx_rate, fx_rate_date, ref,
       issuing_entity_party_id, jurisdiction, title)
    VALUES (${tenantId}, ${entity}, 'draft', 'INR', 1, CURRENT_DATE,
            ${`EL-2026-${String(letters).padStart(4, "0")}`}, ${clientId}, 'IN', 'Engagement')
    RETURNING id
  `;
  if (!letter) throw new Error("letter seed failed");
  const [line] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter_line
      (tenant_id, engagement_letter_id, position, service_version_id, quantity, unit_amount,
       currency, discount_percent, billing_frequency, entity_party_id, description, pricing_note)
    VALUES (${tenantId}, ${letter.id}, 1, ${books.versionId}, 1, 5000, 'INR', 0, 'monthly', ${entity},
            'Monthly bookkeeping', 'Per month')
    RETURNING id
  `;
  if (!line) throw new Error("line seed failed");
  await owner`
    UPDATE crm.engagement_letter
       SET status = 'signed', sent_at = now(), signed_at = now(), signed_by_name = 'A Director',
           signature_method = 'attested', signed_content_hash = ${"a".repeat(64)}
     WHERE id = ${letter.id}
  `;
  const [engagement] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement
      (tenant_id, party_id, entity_party_id, engagement_letter_id, engagement_letter_line_id,
       effective_from, status, activated_at)
    VALUES (${tenantId}, ${entity}, ${entity}, ${letter.id}, ${line.id}, '2026-07-01'::date,
            'active', now())
    RETURNING id
  `;
  if (!engagement) throw new Error("engagement seed failed");
  // The activation the one-time feed reads, as the engagement module writes it.
  await owner`
    INSERT INTO ledger.event (id, tenant_id, verb, object_type, object_id, actor_type, actor_id, payload)
    VALUES (${randomUUID()}, ${tenantId}, 'contract.activated', 'engagement', ${engagement.id}, 'system', NULL,
            ${owner.json({ effectiveFrom: "2026-07-01" })})
  `;
  return engagement.id;
}

interface Row {
  period_start: string;
  engagement_id: string | null;
  withdrawn_reason: string | null;
}

async function rowsFor(engagementId: string): Promise<Row[]> {
  return owner<Row[]>`
    SELECT period_start::text, engagement_id, withdrawn_reason
      FROM delivery.obligation_instance
     WHERE tenant_id = ${tenantId} AND lineage_id = ${gstr3b} AND engagement_id = ${engagementId}
     ORDER BY period_start
  `;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`lifecycle-${stamp}`}, 'Engagement Lifecycle Test', 'INR') RETURNING id
  `;
  if (!t) throw new Error("tenant seed failed");
  tenantId = t.id;
  const [u] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email) VALUES (${`lifecycle-${stamp}@example.test`}) RETURNING id
  `;
  if (!u) throw new Error("user seed failed");
  userId = u.id;
  actor = { type: "human", id: userId };

  // The firm's own company issues the letters.
  const [c] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenantId}, 'organization', 'The Firm') RETURNING id
  `;
  if (!c) throw new Error("firm seed failed");
  clientId = c.id;

  const [entry] = await owner<{ id: string }[]>`
    INSERT INTO config.entry (tenant_id, kind, key) VALUES (${tenantId}, 'service', ${`books-${stamp}`})
    RETURNING id
  `;
  if (!entry) throw new Error("service seed failed");
  const [version] = await owner<{ id: string }[]>`
    INSERT INTO config.version (tenant_id, entry_id, version, body, status, published_at)
    VALUES (${tenantId}, ${entry.id}, 1,
            ${owner.json({ name: "Monthly bookkeeping", recurrence: "monthly" })}, 'published', now())
    RETURNING id
  `;
  if (!version) throw new Error("version seed failed");
  books = { entryId: entry.id, versionId: version.id };

  kaveri = await company(`Kaveri Foods ${stamp}`);
  lotus = await company(`Lotus Retail ${stamp}`);
  indus = await company(`Indus Motors ${stamp}`);
  kaveriBooks = await monthlyBooksFor(kaveri);
  lotusBooks = await monthlyBooksFor(lotus);
  indusBooks = await monthlyBooksFor(indus);

  await obligations.seedDefaultStates(tenantId, actor);
  const { rule } = await obligations.createRule(
    {
      tenantId,
      jurisdiction: "IN",
      serviceEntryIds: [books.entryId],
      name: "GSTR-3B",
      authority: "GST",
      module: "GST",
      recurrence: "monthly",
      fiscalYearStartMonth: 4,
      dueRule: { kind: "day_of_month", dueMonthOffset: 1, dueDayOfMonth: 20 },
      leadTimeDays: 0,
      rulePack: `gst-in@${stamp}`,
    },
    actor,
  );
  gstr3b = rule.id;
});

afterAll(async () => {
  await owner`DELETE FROM delivery.obligation_instance WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.obligation_rule_service WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.obligation_template WHERE tenant_id = ${tenantId}`;
  // Out of every other test's sweep, the way the other suites leave theirs.
  await owner`
    UPDATE crm.engagement SET status = 'cancelled', paused_at = NULL, paused_by_user_id = NULL
     WHERE tenant_id = ${tenantId} AND ended_at IS NULL
  `;
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

describe("ending an engagement on 30 September (V2.3)", () => {
  it("withdraws its untouched filings for periods after the end, and keeps September and the past", async () => {
    const before = await rowsFor(kaveriBooks);
    expect(before.map((r) => r.period_start)).toContain("2026-10-01");
    expect(before.every((r) => r.withdrawn_reason === null)).toBe(true);

    const out = await lifecycle.end(tenantId, {
      engagementId: kaveriBooks,
      expect: "active",
      status: "completed",
      endsOn: "2026-09-30",
      reason: "Moved their books to another firm.",
      byUserId: userId,
      firmToday: TODAY,
    });

    expect(out?.engagement).toMatchObject({ status: "completed", endsOn: "2026-09-30" });
    const after = await rowsFor(kaveriBooks);
    const later = after.filter((r) => r.period_start > "2026-09-30");
    const served = after.filter((r) => r.period_start <= "2026-09-30");
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((r) => r.withdrawn_reason === "engagement_ended")).toBe(true);
    // September's return (due 20 October) and the past ones stay: the firm
    // served those months, so it files them.
    expect(served.map((r) => r.period_start)).toContain("2026-09-01");
    expect(served.every((r) => r.withdrawn_reason === null)).toBe(true);
    expect(out?.filings.withdrawn).toBe(later.length);
    // Nobody else's calendar moved.
    expect((await rowsFor(indusBooks)).every((r) => r.withdrawn_reason === null)).toBe(true);
  });

  it("is refused a second time by the guard in the write", async () => {
    const again = await lifecycle.end(tenantId, {
      engagementId: kaveriBooks,
      expect: "active",
      status: "completed",
      endsOn: "2026-10-31",
      reason: "again",
      byUserId: userId,
      firmToday: TODAY,
    });
    expect(again).toBeNull();
  });

  it("THE SPAWN FILTER: the feed still offers it, to its last day, and October is not owed", async () => {
    const offered = (await jobs.activeRecurring(tenantId, 50)).find((r) => r.engagementId === kaveriBooks);
    expect(offered).toMatchObject({ endsOn: "2026-09-30", resumedOn: null });
    const october = periodsToMaterialise({
      recurrence: "monthly",
      fiscalYearStartMonth: 4,
      effectiveFrom: "2026-07-01",
      floor: "2026-07-01",
      today: "2026-10-05",
      slaDays: 0,
      endsOn: offered?.endsOn ?? null,
      resumedOn: offered?.resumedOn ?? null,
    });
    expect(october.map((p) => p.label)).toEqual(["Jul 2026", "Aug 2026", "Sep 2026"]);
    // And the one-time feed never offers an engagement that is not active.
    const activations = await jobs.unspawnedActivations(tenantId, 50);
    expect(activations.map((a) => a.engagementId)).not.toContain(kaveriBooks);
  });

  it("THE GENERATOR'S CEILING: a rerun restores nothing after the end and loses nothing before it", async () => {
    const subjects = await calendarSource.subjectsFor(tenantId, {
      lineageId: gstr3b,
      jurisdiction: "IN",
      entityType: null,
    });
    expect(subjects.find((s) => s.engagementId === kaveriBooks)).toMatchObject({ endsOn: "2026-09-30" });

    const before = await rowsFor(kaveriBooks);
    await obligations.generate(tenantId, { from: "2026-07-01", to: "2027-09-29" }, actor);
    expect(await rowsFor(kaveriBooks)).toEqual(before);
  });
});

describe("pausing (V2.3)", () => {
  it("takes the engagement out of both spawn feeds and the generator, and resuming brings it back", async () => {
    const paused = await lifecycle.pause(tenantId, { engagementId: lotusBooks, byUserId: userId, pausedOn: "2026-09-29" });
    expect(paused).toMatchObject({ status: "paused", pausedOn: "2026-09-29" });
    expect((await jobs.activeRecurring(tenantId, 50)).map((r) => r.engagementId)).not.toContain(lotusBooks);
    expect(
      (await calendarSource.subjectsFor(tenantId, { lineageId: gstr3b, jurisdiction: "IN", entityType: null }))
        .map((s) => s.engagementId),
    ).not.toContain(lotusBooks);

    const resumed = await lifecycle.resume(tenantId, { engagementId: lotusBooks, resumedOn: TODAY });
    expect(resumed).toMatchObject({ status: "active", pausedAt: null, resumedOn: TODAY });
    const offered = (await jobs.activeRecurring(tenantId, 50)).find((r) => r.engagementId === lotusBooks);
    expect(offered?.resumedOn).toBe(TODAY);
  });
});

describe("0314's walls", () => {
  it("refuses an end record on a live status, a pause stamp on anything but paused, and a blank reason", async () => {
    await expect(owner`
      UPDATE crm.engagement SET ends_on = '2026-09-30', end_reason = 'x', ended_at = now()
       WHERE id = ${indusBooks}
    `).rejects.toMatchObject({ constraint_name: "engagement_end_means_ended" });
    await expect(owner`
      UPDATE crm.engagement SET paused_at = now() WHERE id = ${indusBooks}
    `).rejects.toMatchObject({ constraint_name: "engagement_pause_means_paused" });
    await expect(owner`
      UPDATE crm.engagement SET status = 'completed', ends_on = '2026-09-30', end_reason = '   ', ended_at = now()
       WHERE id = ${indusBooks}
    `).rejects.toMatchObject({ constraint_name: "engagement_end_reason_said" });
  });
});

describe("THE ARCHIVE GUARD counts only what is live (decided 2026-09-28)", () => {
  it("refuses while the engagement is live, and puts the client away once it has ended", async () => {
    await expect(parties.archive(tenantId, indus)).rejects.toMatchObject({
      code: "PARTY_HAS_REFERENCES",
      referrers: ["a live engagement"],
    });

    await lifecycle.end(tenantId, {
      engagementId: indusBooks,
      expect: "active",
      status: "completed",
      endsOn: "2026-10-31",
      reason: "Closed the company.",
      byUserId: userId,
      firmToday: TODAY,
    });
    const archived = await parties.archive(tenantId, indus);
    expect(archived.archivedAt).not.toBeNull();

    // And an archived client is offered by neither feed, ended or not.
    expect((await jobs.activeRecurring(tenantId, 50)).map((r) => r.engagementId)).not.toContain(indusBooks);
    expect((await jobs.unspawnedActivations(tenantId, 50)).map((a) => a.engagementId)).not.toContain(indusBooks);
  });
});
