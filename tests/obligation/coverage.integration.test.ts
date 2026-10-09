// "Is this engagement's work on the compliance calendar?" is asked by three statements (coverage,
// the generator's `subjectsFor`, `gaps`); if they drift a recurring client gets two tasks for one
// filing or none. A fake agrees with whatever it was written for (once coverage used a bare `=`
// against the others' `IS NULL OR =`), so all three run here on one database, same fixtures.
// T6.16 (0309, decision 1): a rule reaches an engagement only through a LIVE link to the service it
// bought; a rule on no service reaches nothing (the old NULL = "every service" reading put 98 GST
// filings on a bookkeeping-only client, 2026-09-18). T6.16 follow-up (2026-09-26): a per-period
// service naming its own process keeps its month's task, so `filingEngagements` reads the LIVE
// published body; the last block asserts that through the real work-item spawn.
// Run with:  npm run test:integration
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresObligationCoverage } from "../../src/infrastructure/postgres/obligation-coverage";
import { PostgresCalendarSource } from "../../src/infrastructure/postgres/obligation-instance-repository";
import { FakeClock } from "../../src/testfakes/clock";
import { FakeIds } from "../../src/testfakes/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import {
  FakeEngagementWork,
  FakeLetterWork,
  FakeObligationFiling,
  FakeReviewPermissions,
  FakeReviewPolicies,
  FakeReviewers,
  FakeSpocDirectory,
  FakeWorkAxes,
  FakeWorkItemApprovalRepo,
  FakeWorkItemClients,
  FakeWorkItemRepo,
  FakeWorkItemStaff,
  FakeWorkVocabularyRepo,
  FakeJobStepHandover,
  FakeWorkOwnerDirectory,
} from "../../src/testfakes/workitem";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { WorkItemService, WorkVocabularyService } from "../../src/usecase/workitem/service";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 4 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });
const coverage = new PostgresObligationCoverage(app);
const generator = new PostgresCalendarSource(app);

const stamp = Date.now().toString(36);
let tenantId = "";
let userId = "";
let clientId = "";
let entityId = "";
/** The service the client actually signed for. */
let boughtEntryId = "";
/** A different catalogue line the client did NOT buy. */
let otherEntryId = "";
let otherVersionId = "";
let engagementId = "";
let stateId = "";

/** A `service` entry with one published version; `process` is the body's workflow template. */
async function service(
  key: string,
  process: string | null = null,
): Promise<{ entryId: string; versionId: string }> {
  const [entry] = await owner<{ id: string }[]>`
    INSERT INTO config.entry (tenant_id, kind, key)
    VALUES (${tenantId}, 'service', ${key}) RETURNING id
  `;
  if (!entry) throw new Error("entry seed failed");
  const body = process === null ? { name: key } : { name: key, workflowTemplateKey: process };
  const [version] = await owner<{ id: string }[]>`
    INSERT INTO config.version (tenant_id, entry_id, version, body, status, published_at)
    VALUES (${tenantId}, ${entry.id}, 1, ${owner.json(body)}, 'published', now())
    RETURNING id
  `;
  if (!version) throw new Error("version seed failed");
  return { entryId: entry.id, versionId: version.id };
}

/** Publish a new version, archiving the one in force: one published version per entry (0005). */
async function republish(entryId: string, body: Record<string, string>): Promise<void> {
  await owner`
    UPDATE config.version SET status = 'archived', archived_at = now()
     WHERE entry_id = ${entryId} AND status = 'published'
  `;
  await owner`
    INSERT INTO config.version (tenant_id, entry_id, version, body, status, published_at)
    SELECT ${tenantId}, ${entryId}, max(version) + 1, ${owner.json(body)}, 'published', now()
      FROM config.version WHERE entry_id = ${entryId}
  `;
}

/** A rule's id; a fresh rule is its own chain, so the id is also the `lineage_id` a link names. */
async function rule(input: {
  name: string;
  generating?: boolean;
  /** Default true: the rows below stand for rules the firm has answered. */
  confirmed?: boolean;
}): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_template
      (tenant_id, jurisdiction, name, recurrence, fiscal_year_start_month,
       due_rule, due_month_offset, due_day_of_month, rule_pack,
       unresolved_reason, status)
    VALUES (${tenantId}, 'IN', ${input.name}, 'monthly', 4,
            ${input.generating === false ? null : "day_of_month"},
            ${input.generating === false ? null : 1},
            ${input.generating === false ? null : 20},
            ${`cov-${stamp}@1`},
            ${input.generating === false ? "the firm has not given the day" : null},
            ${input.confirmed === false ? "unconfirmed" : "confirmed"})
    RETURNING id
  `;
  if (!row) throw new Error("rule seed failed");
  return row.id;
}

/** Put a rule's chain on a service, as the catalogue does. */
async function link(ruleId: string, entryId: string): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_rule_service
      (tenant_id, lineage_id, service_entry_id, linked_by_user_id)
    VALUES (${tenantId}, ${ruleId}, ${entryId}, ${userId}) RETURNING id
  `;
  if (!row) throw new Error("link seed failed");
  return row.id;
}

/** Take a rule off a service: the column, never a delete. */
async function unlink(linkId: string): Promise<void> {
  await owner`
    UPDATE delivery.obligation_rule_service
       SET unlinked_at = now(), unlinked_by_user_id = ${userId}
     WHERE id = ${linkId}
  `;
}

/** Links before the rule: 0309's key refuses the other order. */
async function drop(ruleId: string): Promise<void> {
  await owner`DELETE FROM delivery.obligation_instance WHERE template_id = ${ruleId}`;
  await owner`DELETE FROM delivery.obligation_rule_service WHERE lineage_id = ${ruleId}`;
  await owner`DELETE FROM delivery.obligation_template WHERE id = ${ruleId}`;
}

/** A live engagement pinning `versionId` on its own letter: drafted, one line, signed, then
 *  engaged, the order the signed-letter freeze allows. */
let letters = 0;
async function engagementFor(versionId: string, effectiveFrom: string): Promise<string> {
  letters += 1;
  const [letter] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter
      (tenant_id, party_id, status, currency, fx_rate, fx_rate_date, ref,
       issuing_entity_party_id, jurisdiction, title)
    VALUES (${tenantId}, ${clientId}, 'draft', 'INR', 1, CURRENT_DATE,
            ${`EL-2026-${String(letters).padStart(4, "0")}`}, ${entityId}, 'IN', 'Engagement')
    RETURNING id
  `;
  if (!letter) throw new Error("letter seed failed");
  const [line] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter_line
      (tenant_id, engagement_letter_id, position, service_version_id, quantity,
       unit_amount, currency, discount_percent, billing_frequency, entity_party_id,
       description, pricing_note)
    VALUES (${tenantId}, ${letter.id}, 1, ${versionId}, 1, 5000, 'INR', 0,
            'monthly', ${entityId}, 'Monthly compliance retainer', 'Priced on the schedule')
    RETURNING id
  `;
  if (!line) throw new Error("line seed failed");
  await owner`
    UPDATE crm.engagement_letter
       SET status = 'signed', sent_at = now(), signed_at = now(),
           signed_by_name = 'A Director', signature_method = 'attested',
           signed_content_hash = ${"a".repeat(64)}
     WHERE id = ${letter.id}
  `;
  const [engagement] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement
      (tenant_id, party_id, entity_party_id, engagement_letter_id,
       engagement_letter_line_id, effective_from, status, activated_at)
    VALUES (${tenantId}, ${clientId}, ${entityId}, ${letter.id}, ${line.id},
            ${effectiveFrom}::date, 'active', now())
    RETURNING id
  `;
  if (!engagement) throw new Error("engagement seed failed");
  return engagement.id;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`cov-${stamp}`}, 'Coverage Test', 'INR') RETURNING id
  `;
  if (!t) throw new Error("tenant seed failed");
  tenantId = t.id;
  const [u] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email) VALUES (${`cov-${stamp}@example.test`}) RETURNING id
  `;
  if (!u) throw new Error("user seed failed");
  userId = u.id;

  const [client] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenantId}, 'organization', 'Cobalt Foods Private Limited') RETURNING id
  `;
  const [entity] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenantId}, 'organization', 'Cobalt Foods Private Limited') RETURNING id
  `;
  if (!client || !entity) throw new Error("party seed failed");
  clientId = client.id;
  entityId = entity.id;

  // REGISTERED: rules match jurisdiction exactly, and an unregistered company is a different
  // coverage reason. `legal_entity` hangs off the ORGANIZATION subtype (the composite key insists).
  await owner`
    INSERT INTO core.organization (party_id, tenant_id, legal_name)
    VALUES (${entityId}, ${tenantId}, 'Cobalt Foods Private Limited')
  `;
  await owner`
    INSERT INTO core.legal_entity (tenant_id, party_id, jurisdiction, entity_type, status)
    VALUES (${tenantId}, ${entityId}, 'IN', 'private_limited', 'active')
  `;

  const bought = await service(`gst-monthly-${stamp}`);
  const other = await service(`payroll-${stamp}`);
  boughtEntryId = bought.entryId;
  otherEntryId = other.entryId;
  otherVersionId = other.versionId;

  engagementId = await engagementFor(bought.versionId, "2026-01-01");

  const [st] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_state (tenant_id, code, name, is_initial, sort_order)
    VALUES (${tenantId}, 'pending', 'Pending', true, 10) RETURNING id
  `;
  if (!st) throw new Error("state seed failed");
  stateId = st.id;
});

afterAll(async () => {
  await owner`DELETE FROM delivery.obligation_instance WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.obligation_rule_service WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.obligation_template WHERE tenant_id = ${tenantId}`;
  // Also any 'pending' an interrupted earlier run left on `cov-` tenants: states with no filed one
  // read as a firm 0054's backfill missed, which calendar.integration.test.ts asserts never happens.
  await owner`
    DELETE FROM delivery.obligation_state s
     USING tenancy.tenant t
     WHERE s.tenant_id = t.id AND t.slug LIKE 'cov-%' AND s.code = 'pending'
       AND NOT EXISTS (SELECT 1 FROM delivery.obligation_instance oi WHERE oi.state_id = s.id)
  `;
  await owner`DELETE FROM tenancy.user_account WHERE id = ${userId}`;
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

/** The engagements the GENERATOR reaches for this rule, in its order. */
async function reachedBy(ruleId: string): Promise<string[]> {
  const [row] = await owner<{ jurisdiction: string; entity_type: string | null; lineage_id: string }[]>`
    SELECT jurisdiction, entity_type, lineage_id
      FROM delivery.obligation_template WHERE id = ${ruleId}
  `;
  if (!row) throw new Error("rule vanished");
  const subjects = await generator.subjectsFor(tenantId, {
    lineageId: row.lineage_id,
    jurisdiction: row.jurisdiction,
    entityType: row.entity_type,
  });
  return subjects.map((s) => s.engagementId);
}

async function gapFor(id: string) {
  return (await generator.gaps(tenantId)).find((g) => g.engagementId === id);
}

describe("a rule on NO service, the shipped pack's every row — decision 1", () => {
  it("reaches nothing: coverage, the filing question and the generator all say no", async () => {
    const id = await rule({ name: `GSTR-3B nowhere ${stamp}` });

    expect((await coverage.coveredEngagements(tenantId, [engagementId])).has(engagementId)).toBe(false);
    expect((await coverage.filingEngagements(tenantId, [engagementId])).has(engagementId)).toBe(false);
    expect(await reachedBy(id)).toEqual([]);
    // The gap names the fix: link it in the catalogue.
    expect((await gapFor(engagementId))?.reason).toBe("no_rule_names_this_service");

    await drop(id);
  });
});

describe("a rule LINKED to a service", () => {
  it("covers the engagement, is a filing, and is reached, when it is the service the client bought", async () => {
    const id = await rule({ name: `GSTR-3B bought ${stamp}` });
    await link(id, boughtEntryId);

    expect((await coverage.coveredEngagements(tenantId, [engagementId])).has(engagementId)).toBe(true);
    expect((await coverage.filingEngagements(tenantId, [engagementId])).has(engagementId)).toBe(true);
    // The generator too: coverage alone would pass an implementation that covers everything.
    expect(await reachedBy(id)).toEqual([engagementId]);
    // Nothing produced yet, so the gap is the ordinary "nothing due yet".
    expect((await gapFor(engagementId))?.reason).toBe("nothing_due_yet");

    await drop(id);
  });

  it("is none of them when it is linked to a service the client did not buy", async () => {
    // The negative half: stops the fix being "return everything".
    const id = await rule({ name: `Payroll only ${stamp}` });
    await link(id, otherEntryId);

    expect((await coverage.coveredEngagements(tenantId, [engagementId])).has(engagementId)).toBe(false);
    expect((await coverage.filingEngagements(tenantId, [engagementId])).has(engagementId)).toBe(false);
    expect(await reachedBy(id)).toEqual([]);
    expect((await gapFor(engagementId))?.reason).toBe("no_rule_names_this_service");

    await drop(id);
  });

  it("reaches nothing again once the link is REMOVED, and the link row stays as history", async () => {
    const id = await rule({ name: `GSTR-3B removed ${stamp}` });
    const linkId = await link(id, boughtEntryId);
    expect(await reachedBy(id)).toEqual([engagementId]);

    await unlink(linkId);
    expect(await reachedBy(id)).toEqual([]);
    expect((await coverage.coveredEngagements(tenantId, [engagementId])).has(engagementId)).toBe(false);
    const [kept] = await owner<{ n: string }[]>`
      SELECT count(*)::text AS n FROM delivery.obligation_rule_service WHERE id = ${linkId}
    `;
    expect(kept?.n).toBe("1");

    await drop(id);
  });
});

describe("a linked rule that cannot produce a date does not count as coverage", () => {
  it("is uncovered while its formula is missing — most of the shipped rules", async () => {
    // Coverage means "the calendar will produce work"; an unanswered rule produces nothing, so the
    // engagement still needs its own task (the opposite silent mistake).
    const id = await rule({ name: `MSME-1 unanswered ${stamp}`, generating: false });
    await link(id, boughtEntryId);

    expect((await coverage.coveredEngagements(tenantId, [engagementId])).has(engagementId)).toBe(false);
    expect((await gapFor(engagementId))?.reason).toBe("rules_need_a_formula");

    await drop(id);
  });

  it("is uncovered while it is retired, even with a formula", async () => {
    const id = await rule({ name: `Retired ${stamp}` });
    await link(id, boughtEntryId);
    await owner`UPDATE delivery.obligation_template SET is_active = false WHERE id = ${id}`;

    expect((await coverage.coveredEngagements(tenantId, [engagementId])).has(engagementId)).toBe(false);
    expect((await gapFor(engagementId))?.reason).toBe("rules_retired");

    await drop(id);
  });

  it("is uncovered while nobody at the firm has confirmed it, and the gap names the rule", async () => {
    // Adding in the catalogue confirms; this is a partner un-confirming it in the library later.
    const id = await rule({ name: `Unanswered pack row ${stamp}`, confirmed: false });
    await link(id, boughtEntryId);

    expect((await coverage.coveredEngagements(tenantId, [engagementId])).has(engagementId)).toBe(false);
    const gap = await gapFor(engagementId);
    expect(gap?.reason).toBe("rules_unconfirmed");
    expect(gap?.blockedRuleIds).toContain(id);

    await drop(id);
  });
});

// T6.16: one rule on two services.

describe("one filing, two services of the same client", () => {
  it("reaches BOTH engagements, earliest first — the order the generator keeps the first of", async () => {
    const id = await rule({ name: `GSTR-3B shared ${stamp}` });
    await link(id, boughtEntryId);
    await link(id, otherEntryId);
    // Same company, the other service, started EARLIER: the one the generator keeps.
    const earlier = await engagementFor(otherVersionId, "2025-10-01");

    expect(await reachedBy(id)).toEqual([earlier, engagementId]);
    expect((await coverage.filingEngagements(tenantId, [engagementId, earlier])).size).toBe(2);

    // ONE live row per period, on the earlier engagement, covers the OTHER too (its service carries
    // the chain); asking only for its own id read it as a gap forever.
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO delivery.obligation_instance
        (tenant_id, template_id, entity_party_id, engagement_id, period_start, period_end,
         period_label, statutory_due_on, internal_target_on, state_id)
      VALUES (${tenantId}, ${id}, ${entityId}, ${earlier}, '2026-09-01'::date, '2026-09-30'::date,
              'Sep 2026', '2026-10-20'::date, '2026-10-20'::date, ${stateId})
      RETURNING id
    `;
    if (!row) throw new Error("instance seed failed");
    expect(await gapFor(engagementId)).toBeUndefined();
    expect(await gapFor(earlier)).toBeUndefined();

    // A WITHDRAWN row is not coverage: it is off the calendar.
    await owner`
      UPDATE delivery.obligation_instance
         SET withdrawn_at = now(), withdrawn_by_user_id = ${userId}, withdrawn_reason = 'service_unlinked'
       WHERE id = ${row.id}
    `;
    expect((await gapFor(engagementId))?.reason).toBe("nothing_due_yet");
    expect((await gapFor(earlier))?.reason).toBe("nothing_due_yet");

    await drop(id);
    await owner`UPDATE crm.engagement SET status = 'cancelled' WHERE id = ${earlier}`;
  });
});

// T6.16 follow-up: a service with its own process keeps its month's task.

const SPAWNER = { type: "human" as const, id: "00000000-0000-4000-8000-00000000c0a1" };
const SEPTEMBER_JOB = "00000000-0000-4000-8000-00000000c0b1";

/** Engagements that got September's umbrella task from the REAL work-item use case over THIS
 *  Postgres coverage; the desk (no SPOC, fresh vocabulary) is faked. */
async function monthTasks(engagementIds: readonly string[], versionId: string): Promise<string[]> {
  const vocabulary = new FakeWorkVocabularyRepo();
  const items = new FakeWorkItemRepo();
  const approvals = new FakeWorkItemApprovalRepo();
  items.vocabulary = vocabulary;
  items.approvals = approvals;
  approvals.items = items;
  const engagements = new FakeEngagementWork();
  const ids = new FakeIds();
  const events = new RecordingEventSink();
  await new WorkVocabularyService({ vocabulary, ids, events }).seedDefaultVocabulary(tenantId, SPAWNER);
  for (const id of engagementIds) {
    engagements.rows.push({
      engagementId: id,
      clientPartyId: clientId,
      entityPartyId: entityId,
      effectiveFrom: "2026-01-01",
      serviceVersionId: versionId,
      serviceName: "Monthly Accounting",
      slaDays: 10,
      deptCode: null,
    });
  }
  const spawner = new WorkItemService({
    items,
    approvals,
    vocabulary,
    clients: new FakeWorkItemClients(),
    staff: new FakeWorkItemStaff(),
    spocs: new FakeSpocDirectory(),
    owners: new FakeWorkOwnerDirectory(),
    jobSteps: new FakeJobStepHandover(),
    timeZones: new FakeFirmTimeZone(),
    axes: new FakeWorkAxes(),
    policies: new FakeReviewPolicies(),
    reviewers: new FakeReviewers(),
    permissions: new FakeReviewPermissions(),
    engagements,
    letters: new FakeLetterWork(),
    obligations: coverage,
    filings: new FakeObligationFiling(),
    ids,
    clock: new FakeClock(new Date("2026-10-01T04:00:00Z")),
    events,
  });
  await spawner.spawnForEngagements(tenantId, SEPTEMBER_JOB, engagementIds, SPAWNER, {
    label: "Sep 2026",
    end: "2026-09-30",
  });
  return items.rows.map((r) => r.engagementId).filter((id): id is string => id !== null);
}

describe("a per-period service with a PROCESS of its own keeps its month's task", () => {
  it("process + a linked filing: its filings are generated AND September's task is raised", async () => {
    // The firm's case: Monthly Accounting (a ten-step close) carrying TDS lost "Monthly Accounting · Sep 2026".
    const books = await service(`monthly-accounting-${stamp}`, "monthly-accounting-close");
    const eng = await engagementFor(books.versionId, "2026-01-01");
    const id = await rule({ name: `TDS on books ${stamp}` });
    await link(id, books.entryId);

    // The calendar still dates TDS, and the one-time activation task is still skipped.
    expect(await reachedBy(id)).toContain(eng);
    expect((await coverage.coveredEngagements(tenantId, [eng])).has(eng)).toBe(true);
    // But the service is not merely its filings, so the month's task stays.
    expect((await coverage.filingEngagements(tenantId, [eng])).has(eng)).toBe(false);
    expect(await monthTasks([eng], books.versionId)).toEqual([eng]);

    await drop(id);
    await owner`UPDATE crm.engagement SET status = 'cancelled' WHERE id = ${eng}`;
  });

  it("no process + a linked filing: the service IS its filings, and no month's task is raised", async () => {
    // A pure "GST Compliance": T6.13's behaviour, kept.
    const gst = await service(`gst-compliance-${stamp}`);
    const eng = await engagementFor(gst.versionId, "2026-01-01");
    const id = await rule({ name: `GSTR-3B compliance ${stamp}` });
    await link(id, gst.entryId);

    expect((await coverage.coveredEngagements(tenantId, [eng])).has(eng)).toBe(true);
    expect((await coverage.filingEngagements(tenantId, [eng])).has(eng)).toBe(true);
    expect(await monthTasks([eng], gst.versionId)).toEqual([]);

    await drop(id);
    await owner`UPDATE crm.engagement SET status = 'cancelled' WHERE id = ${eng}`;
  });

  it("process + no linked filing: nothing covers it, and the month's task is raised", async () => {
    const books = await service(`bookkeeping-only-${stamp}`, "monthly-accounting-close");
    const eng = await engagementFor(books.versionId, "2026-01-01");

    expect((await coverage.coveredEngagements(tenantId, [eng])).has(eng)).toBe(false);
    expect((await coverage.filingEngagements(tenantId, [eng])).has(eng)).toBe(false);
    expect(await monthTasks([eng], books.versionId)).toEqual([eng]);

    await owner`UPDATE crm.engagement SET status = 'cancelled' WHERE id = ${eng}`;
  });

  it("reads the process LIVE, never from the version the client signed", async () => {
    // Signed on a version with no process (a brought-in book); the period job pins the CURRENT
    // process when it opens, so the task must follow what is published now.
    const svc = await service(`bookkeeping-live-${stamp}`);
    const eng = await engagementFor(svc.versionId, "2026-01-01");
    const id = await rule({ name: `TDS live ${stamp}` });
    await link(id, svc.entryId);
    expect((await coverage.filingEngagements(tenantId, [eng])).has(eng)).toBe(true);
    expect(await monthTasks([eng], svc.versionId)).toEqual([]);

    await republish(svc.entryId, {
      name: `bookkeeping-live-${stamp}`,
      workflowTemplateKey: "monthly-accounting-close",
    });
    expect((await coverage.filingEngagements(tenantId, [eng])).has(eng)).toBe(false);
    expect(await monthTasks([eng], svc.versionId)).toEqual([eng]);

    // And taking the process away makes the service its filings again.
    await republish(svc.entryId, { name: `bookkeeping-live-${stamp}` });
    expect((await coverage.filingEngagements(tenantId, [eng])).has(eng)).toBe(true);

    await drop(id);
    await owner`UPDATE crm.engagement SET status = 'cancelled' WHERE id = ${eng}`;
  });
});
