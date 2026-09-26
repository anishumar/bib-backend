// A service lists its compliance filings; a filing is written once (T6.16,
// migration 0309) — against a REAL database, because every claim below is
// about SQL a fake cannot reproduce.
//
// ── WHAT IS PROVED HERE AND NOWHERE ELSE ───────────────────────────────────
//
//   1. The generation SQL with links: a filing written for a service fills the
//      calendar of that service's live clients at once; a second service the
//      same client holds writes nothing twice; a client holding both gets ONE
//      filing per period, on the EARLIEST engagement, by rule.
//   2. Removing a filing withdraws exactly the untouched upcoming rows no
//      other linked service covers, in ONE transaction with the removal, and
//      re-points the covered ones to the engagement that owes them now.
//   3. EVERY SQL reader leaves a withdrawn row out: the calendar, the T-X
//      raise and its attach, the missed sweep and its write, the restater,
//      the escalation watch and its queue, the nudge candidates and their
//      write, and the portal (a policy, proved by dropping it). A staff read
//      by id still sees it: the guarded shape, not the bare narrowing.
//   4. A supersession leaves a withdrawn row where it is and does not count
//      it as kept; the successor is on the chain's services with nothing
//      copied.
//   5. Adding the filing back restores the SAME rows in place, re-dated by
//      the rule that governs each period: one live row per period.
//   6. 0309's walls, each by the constraint that refuses it; and the
//      migration's data move and its down, round-tripped inside a transaction
//      that is rolled back.
//
// Run with:  npm run test:integration
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { load } from "../../src/config/config";
import { withPortal, withTenant } from "../../src/db/tenant";
import { PostgresConfigRepository } from "../../src/infrastructure/postgres/config-repository";
import {
  PostgresEscalationNoticeRepository,
  PostgresEscalationSubjects,
} from "../../src/infrastructure/postgres/escalation-repository";
import { PostgresNudgeCandidates, PostgresNudgeRepository } from "../../src/infrastructure/postgres/nudge-repository";
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
import { PostgresPortalHomeRepository } from "../../src/infrastructure/postgres/portal-home-repository";
import { systemIds } from "../../src/platform/ids";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import { FakeFirmTimeZone } from "../../src/testfakes/tenancy";
import { ObligationService } from "../../src/usecase/obligation/service";
import type { Actor } from "../../src/domain/ledger/model";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 4 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

/** The firm's today, for every "upcoming" in this file. */
const TODAY = "2026-08-30";

const instances = new PostgresObligationInstanceRepository(app);
const templates = new PostgresObligationTemplateRepository(app);
const links = new PostgresRuleServiceLinkRepository(app);
const events = new RecordingEventSink();
const service = new ObligationService({
  timeZones: new FakeFirmTimeZone(),
  templates,
  exceptions: new PostgresObligationExceptionRepository(app),
  states: new PostgresObligationStateRepository(app),
  resolutionOptions: new PostgresResolutionOptionRepository(app),
  instances,
  links,
  compliancePolicy: { missedFromOn: () => Promise.resolve(null) },
  calendarSource: new PostgresCalendarSource(app),
  services: new PostgresConfigRepository(app),
  // Nothing here raises through the service: the raise feed is read directly,
  // so a fake that invented a task id would only hide a wiring fault.
  workItems: { raiseForObligation: () => Promise.reject(new Error("not used in this test")) },
  tenants: { activeTenantIds: () => Promise.resolve([]) },
  ids: systemIds,
  clock: { now: () => new Date(`${TODAY}T06:00:00Z`) },
  events,
});

const stamp = Date.now().toString(36);
let tenantId = "";
let userId = "";
let actor: Actor = { type: "system", id: null };
let clientId = "";
/** A company holding BOTH services. */
let e1 = "";
/** A company holding only the GST service. */
let e2 = "";
let gst = "";
let full = "";
let roleEntry = "";
let e1Gst = "";
let e1Full = "";
let e2Gst = "";
let workState = "";
let workPriority = "";

/** A `service` entry with one published version. */
async function serviceEntry(key: string): Promise<{ entryId: string; versionId: string }> {
  const [entry] = await owner<{ id: string }[]>`
    INSERT INTO config.entry (tenant_id, kind, key) VALUES (${tenantId}, 'service', ${key}) RETURNING id
  `;
  if (!entry) throw new Error("entry seed failed");
  const [version] = await owner<{ id: string }[]>`
    INSERT INTO config.version (tenant_id, entry_id, version, body, status, published_at)
    VALUES (${tenantId}, ${entry.id}, 1, ${owner.json({ name: key })}, 'published', now())
    RETURNING id
  `;
  if (!version) throw new Error("version seed failed");
  return { entryId: entry.id, versionId: version.id };
}

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

/** A live engagement on a letter of its own: draft, one line, signed, then the
 *  engagement, which is the order the signed-letter freeze allows. */
let letters = 0;
async function engagementFor(entity: string, versionId: string, effectiveFrom: string): Promise<string> {
  letters += 1;
  const [letter] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter
      (tenant_id, party_id, status, currency, fx_rate, fx_rate_date, ref,
       issuing_entity_party_id, jurisdiction, title)
    VALUES (${tenantId}, ${clientId}, 'draft', 'INR', 1, CURRENT_DATE,
            ${`EL-2026-${String(letters).padStart(4, "0")}`}, ${entity}, 'IN', 'Engagement')
    RETURNING id
  `;
  if (!letter) throw new Error("letter seed failed");
  const [line] = await owner<{ id: string }[]>`
    INSERT INTO crm.engagement_letter_line
      (tenant_id, engagement_letter_id, position, service_version_id, quantity, unit_amount,
       currency, discount_percent, billing_frequency, entity_party_id, description, pricing_note)
    VALUES (${tenantId}, ${letter.id}, 1, ${versionId}, 1, 5000, 'INR', 0, 'monthly', ${entity},
            'Monthly compliance', 'Priced on the schedule')
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
    VALUES (${tenantId}, ${clientId}, ${entity}, ${letter.id}, ${line.id}, ${effectiveFrom}::date,
            'active', now())
    RETURNING id
  `;
  if (!engagement) throw new Error("engagement seed failed");
  return engagement.id;
}

interface Row {
  id: string;
  template_id: string;
  lineage_id: string;
  entity_party_id: string;
  engagement_id: string | null;
  period_label: string;
  period_start: string;
  statutory: string;
  internal: string;
  work_item_id: string | null;
  withdrawn_at: string | null;
  withdrawn_by_user_id: string | null;
  withdrawn_reason: string | null;
}

/** What the calendar holds for one chain, read as the OWNER (no RLS, no
 *  filter): the truth the readers are measured against. */
async function rowsOf(lineageId: string): Promise<Row[]> {
  return owner<Row[]>`
    SELECT id, template_id, lineage_id, entity_party_id, engagement_id, period_label,
           period_start::text, statutory_due_on::text AS statutory,
           internal_target_on::text AS internal, work_item_id,
           withdrawn_at::text, withdrawn_by_user_id, withdrawn_reason
      FROM delivery.obligation_instance
     WHERE tenant_id = ${tenantId} AND lineage_id = ${lineageId}
     ORDER BY entity_party_id, period_start
  `;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`filings-${stamp}`}, 'Service Filings Test', 'INR') RETURNING id
  `;
  if (!t) throw new Error("tenant seed failed");
  tenantId = t.id;
  const [u] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email) VALUES (${`filings-${stamp}@example.test`}) RETURNING id
  `;
  if (!u) throw new Error("user seed failed");
  userId = u.id;
  actor = { type: "human", id: userId };

  const [c] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenantId}, 'organization', 'Cobalt Group') RETURNING id
  `;
  if (!c) throw new Error("client seed failed");
  clientId = c.id;
  e1 = await company(`Cobalt Foods ${stamp}`);
  e2 = await company(`Cobalt Logistics ${stamp}`);

  const g = await serviceEntry(`gst-monthly-${stamp}`);
  const f = await serviceEntry(`full-compliance-${stamp}`);
  gst = g.entryId;
  full = f.entryId;
  const [role] = await owner<{ id: string }[]>`
    INSERT INTO config.entry (tenant_id, kind, key) VALUES (${tenantId}, 'role', ${`role-${stamp}`})
    RETURNING id
  `;
  if (!role) throw new Error("role entry seed failed");
  roleEntry = role.id;

  // Cobalt Foods holds both services, GST first; Cobalt Logistics only GST.
  e1Gst = await engagementFor(e1, g.versionId, "2026-01-01");
  e1Full = await engagementFor(e1, f.versionId, "2026-03-01");
  e2Gst = await engagementFor(e2, g.versionId, "2026-01-01");

  await service.seedDefaultStates(tenantId, actor);

  const [ws] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_state (tenant_id, code, name, is_initial, sort_order)
    VALUES (${tenantId}, 'open', 'Open', true, 10) RETURNING id
  `;
  const [wp] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_priority (tenant_id, code, name, rank)
    VALUES (${tenantId}, 'normal', 'Normal', 3) RETURNING id
  `;
  if (!ws || !wp) throw new Error("work vocabulary seed failed");
  workState = ws.id;
  workPriority = wp.id;
});

afterAll(async () => {
  await owner`DELETE FROM delivery.escalation_notice WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.obligation_nudge WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.obligation_instance WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.work_item WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.work_item_state WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.work_item_priority WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.obligation_rule_service WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.obligation_template_exception WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.obligation_template WHERE tenant_id = ${tenantId}`;
  await owner`UPDATE crm.engagement SET status = 'cancelled' WHERE tenant_id = ${tenantId}`;
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

// ── the chain the whole file walks ──────────────────────────────────────────

let gstr3b = "";
/** One of Cobalt Logistics' filings that came off, and one somebody started. */
let withdrawnRow = "";
let startedRow = "";

describe("linking a filing to a service puts it on the calendar, once per period", () => {
  it("a filing WRITTEN for a service fills the calendar for that service's clients at once", async () => {
    const { rule, effect } = await service.createRule(
      {
        tenantId,
        jurisdiction: "IN",
        serviceEntryIds: [gst],
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
    expect(rule.lineageId).toBe(rule.id);

    const rows = await rowsOf(gstr3b);
    expect(effect.spawned).toBe(rows.length);
    expect(rows.length).toBeGreaterThan(20);
    // Both companies, each on its own GST engagement.
    expect(rows.filter((r) => r.entity_party_id === e1).every((r) => r.engagement_id === e1Gst)).toBe(true);
    expect(rows.filter((r) => r.entity_party_id === e2).every((r) => r.engagement_id === e2Gst)).toBe(true);
    // ONE per (entity, period).
    const keys = rows.map((r) => `${r.entity_party_id}|${r.period_start}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("adding it to a SECOND service the same client holds writes nothing twice", async () => {
    const before = await rowsOf(gstr3b);
    const { effect } = await service.linkRule({ tenantId, serviceEntryId: full, ruleId: gstr3b }, actor);
    expect(effect).toMatchObject({ linked: true, confirmed: false, spawned: 0, restored: 0 });
    const after = await rowsOf(gstr3b);
    expect(after).toEqual(before);

    // The library names both services, from the same query as the rule.
    const record = (await service.listRules(tenantId)).find((r) => r.template.id === gstr3b);
    expect(record?.usedIn.map((u) => u.serviceEntryId)).toEqual([gst, full]);
    expect(record?.usedIn.every((u) => u.serviceName !== null && u.linkedAt.endsWith("Z"))).toBe(true);
  });

  it("a filing on BOTH services from the start lands on the EARLIEST engagement, by rule", async () => {
    // Listed with the later service first: the order it was asked in must not
    // decide which engagement the row carries.
    const { rule } = await service.createRule(
      {
        tenantId,
        jurisdiction: "IN",
        serviceEntryIds: [full, gst],
        name: "GSTR-1",
        recurrence: "monthly",
        fiscalYearStartMonth: 4,
        dueRule: { kind: "day_of_month", dueMonthOffset: 1, dueDayOfMonth: 11 },
        leadTimeDays: 0,
        rulePack: `gst-in@${stamp}`,
      },
      actor,
    );
    const rows = (await rowsOf(rule.id)).filter((r) => r.entity_party_id === e1);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.engagement_id === e1Gst)).toBe(true);
    const labels = rows.map((r) => r.period_label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("removing a filing from a service withdraws what it no longer owes, and nothing else", () => {
  it("withdraws the untouched upcoming rows no other service covers, and keeps and counts the rest", async () => {
    // Somebody is already working one of Cobalt Logistics' upcoming returns.
    const started = (await rowsOf(gstr3b)).find(
      (r) => r.entity_party_id === e2 && r.period_label === "Oct 2026",
    );
    if (!started) throw new Error("no October row for Cobalt Logistics");
    startedRow = started.id;
    const [wi] = await owner<{ id: string }[]>`
      INSERT INTO delivery.work_item (tenant_id, client_party_id, title, state_id, priority_id)
      VALUES (${tenantId}, ${clientId}, 'GSTR-3B Oct 2026', ${workState}, ${workPriority}) RETURNING id
    `;
    await owner`UPDATE delivery.obligation_instance SET work_item_id = ${wi?.id ?? null} WHERE id = ${startedRow}`;

    const before = await rowsOf(gstr3b);
    const ahead = (entity: string) =>
      before.filter((r) => r.entity_party_id === entity && r.statutory >= TODAY);
    const behind = (entity: string) =>
      before.filter((r) => r.entity_party_id === entity && r.statutory < TODAY);

    const { effect } = await service.unlinkRule({ tenantId, serviceEntryId: gst, ruleId: gstr3b }, actor);

    expect(effect).toEqual({
      unlinked: true,
      // Cobalt Logistics held only GST: its upcoming rows come off, except the
      // one on a desk.
      withdrawn: ahead(e2).length - 1,
      kept: before.length - (ahead(e2).length - 1),
      keptStarted: 1,
      keptPastDue: behind(e1).length + behind(e2).length,
      // Cobalt Foods still holds Full compliance, which carries the filing.
      keptCoveredElsewhere: ahead(e1).length,
    });

    const after = await rowsOf(gstr3b);
    const off = after.filter((r) => r.withdrawn_at !== null);
    expect(off).toHaveLength(effect.withdrawn);
    expect(off.every((r) => r.entity_party_id === e2 && r.statutory >= TODAY)).toBe(true);
    expect(off.every((r) => r.withdrawn_reason === "service_unlinked")).toBe(true);
    expect(off.every((r) => r.withdrawn_by_user_id === userId)).toBe(true);
    expect(after.find((r) => r.id === startedRow)?.withdrawn_at).toBeNull();
    // KEPT AND MARKED, never deleted.
    expect(after).toHaveLength(before.length);
    // Cobalt Foods' rows now name the engagement that owes them.
    expect(after.filter((r) => r.entity_party_id === e1).every((r) => r.engagement_id === e1Full)).toBe(true);
    // And the link is history, not gone.
    const links = await owner<{ unlinked_at: string | null; unlinked_by_user_id: string | null }[]>`
      SELECT unlinked_at::text, unlinked_by_user_id FROM delivery.obligation_rule_service
       WHERE tenant_id = ${tenantId} AND lineage_id = ${gstr3b} AND service_entry_id = ${gst}
    `;
    expect(links).toHaveLength(1);
    expect(links[0]?.unlinked_by_user_id).toBe(userId);

    withdrawnRow = off[0]?.id ?? "";
    expect(withdrawnRow).not.toBe("");
  });

  it("removing it again changes nothing", async () => {
    const { effect } = await service.unlinkRule({ tenantId, serviceEntryId: gst, ruleId: gstr3b }, actor);
    expect(effect.unlinked).toBe(false);
  });
});

describe("a withdrawn filing is in NO reader", () => {
  it("is not on the calendar, however the calendar is asked", async () => {
    const rows = await instances.calendar(tenantId, { includeSettled: true, limit: 500 });
    expect(rows.some((r) => r.id === withdrawnRow)).toBe(false);
    expect(rows.some((r) => r.id === startedRow)).toBe(true);
  });

  it("never gets a task: not in the raise feed, and the attach refuses it", async () => {
    const due = await instances.listRaisable(tenantId, "2027-12-31", 500);
    expect(due.some((r) => r.id === withdrawnRow)).toBe(false);
    const [wi] = await owner<{ id: string }[]>`
      INSERT INTO delivery.work_item (tenant_id, client_party_id, title, state_id, priority_id)
      VALUES (${tenantId}, ${clientId}, 'Should not attach', ${workState}, ${workPriority}) RETURNING id
    `;
    expect(await instances.attachWorkItem(tenantId, withdrawnRow, wi?.id ?? "")).toBe(false);
  });

  it("is never MISSED, however far past its date the sweep runs", async () => {
    const missable = await instances.listMissable(tenantId, "2027-12-31", null, 500);
    expect(missable.some((r) => r.id === withdrawnRow)).toBe(false);
    const states = await service.listStates(tenantId);
    const missed = states.find((s) => s.isMissed);
    if (!missed) throw new Error("no missed state");
    expect(await instances.markMissed(tenantId, withdrawnRow, missed.id)).toBe(false);
    expect((await instances.decisionQueue(tenantId, 200)).some((r) => r.id === withdrawnRow)).toBe(false);
  });

  it("is not restated, and is counted apart", async () => {
    const unstarted = await instances.listUnstarted(tenantId, gstr3b);
    expect(unstarted.some((r) => r.id === withdrawnRow)).toBe(false);
    expect(
      await instances.restate(tenantId, [
        { id: withdrawnRow, statutoryDueOn: "2027-01-05", internalTargetOn: "2027-01-05" },
      ]),
    ).toBe(0);
    const all = await instances.countFor(tenantId, gstr3b);
    const live = await instances.countLiveFor(tenantId, gstr3b);
    const off = (await rowsOf(gstr3b)).filter((r) => r.withdrawn_at !== null).length;
    expect(all - live).toBe(off);
  });

  it("is not watched by the escalation ladder, and a notice already raised about it leaves the queue", async () => {
    const watched = await new PostgresEscalationSubjects(app).openObligations(tenantId);
    expect(watched.some((r) => r.obligationId === withdrawnRow)).toBe(false);
    expect(watched.some((r) => r.obligationId === startedRow)).toBe(true);

    await owner`
      INSERT INTO delivery.escalation_notice
        (tenant_id, obligation_instance_id, rung_key, watch, after_days, target,
         raised_to_user_id, raised_on, days_past)
      VALUES (${tenantId}, ${withdrawnRow}, 'target', 'obligation_target', 0, 'assignee',
              ${userId}, '2026-08-30'::date, 0),
             (${tenantId}, ${startedRow}, 'target', 'obligation_target', 0, 'assignee',
              ${userId}, '2026-08-30'::date, 0)
    `;
    const queue = await new PostgresEscalationNoticeRepository(app).listFor(tenantId, null);
    expect(queue.some((n) => n.obligationInstanceId === withdrawnRow)).toBe(false);
    expect(queue.some((n) => n.obligationInstanceId === startedRow)).toBe(true);
  });

  it("is never nudged: not a candidate, and the write refuses it", async () => {
    const candidates = await new PostgresNudgeCandidates(app).upcomingFilings(tenantId, TODAY, 400);
    expect(candidates.some((c) => c.obligationId === withdrawnRow)).toBe(false);
    const written = await new PostgresNudgeRepository(app).record(tenantId, [
      {
        obligationId: withdrawnRow,
        entityPartyId: e2,
        rungKey: "week-before",
        beforeDays: 7,
        daysUntil: 7,
        dueOn: "2026-09-20",
      },
    ]);
    expect(written).toEqual([]);
  });

  it("never reaches the client's portal, and the staff read by id is untouched", async () => {
    const portal = await withPortal(app, tenantId, [e2], (db) =>
      db<{ id: string }[]>`SELECT id FROM delivery.obligation_instance WHERE tenant_id = ${tenantId}`,
    );
    expect(portal.some((r) => r.id === withdrawnRow)).toBe(false);
    expect(portal.some((r) => r.id === startedRow)).toBe(true);
    const home = await new PostgresPortalHomeRepository(app).read(tenantId, [e2], TODAY);
    expect(home.filings.some((f) => f.obligationId === withdrawnRow)).toBe(false);

    // THE GUARDED SHAPE: a staff session still reads it, which is what lets a
    // relink find the row it restores. The bare narrowing would hide it here.
    const staff = await withTenant(app, tenantId, (db) =>
      db<{ id: string }[]>`SELECT id FROM delivery.obligation_instance WHERE id = ${withdrawnRow}`,
    );
    expect(staff).toHaveLength(1);
    expect((await instances.findById(tenantId, withdrawnRow))?.withdrawnReason).toBe("service_unlinked");
  });

  it("NEGATIVE CONTROL: drop the policy and the portal sees it (rolled back)", async () => {
    // A test that passes with the wall removed proves only that the rows
    // exist. The portal read runs as bib_app on the owner's connection so it
    // sees the policy dropped inside the same transaction.
    const ROLLBACK = new Error("roll back the negative control");
    let leaked = -1;
    await owner
      .begin(async (tx) => {
        await tx`DROP POLICY obligation_instance_portal_live ON delivery.obligation_instance`;
        await tx`SET LOCAL ROLE bib_app`;
        await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await tx`SELECT set_config('app.portal', 'on', true)`;
        await tx`SELECT set_config('app.portal_parties', ${e2}, true)`;
        const rows = await tx<{ id: string }[]>`
          SELECT id FROM delivery.obligation_instance WHERE id = ${withdrawnRow}
        `;
        leaked = rows.length;
        throw ROLLBACK;
      })
      .catch((e: unknown) => {
        if (e !== ROLLBACK) throw e;
      });
    expect(leaked).toBe(1);
    const [still] = await owner<{ n: string }[]>`
      SELECT count(*)::text AS n FROM pg_policies WHERE policyname = 'obligation_instance_portal_live'
    `;
    expect(still?.n).toBe("1");
  });
});

describe("the law changes, and the filing comes back", () => {
  let successor = "";

  it("a supersession leaves a withdrawn row where it is, and does not count it as kept", async () => {
    const CUTOVER = "2026-11-01";
    const off = (await rowsOf(gstr3b)).filter((r) => r.withdrawn_at !== null && r.period_start >= CUTOVER);
    expect(off.length).toBeGreaterThan(0);

    const { rule, effect } = await service.supersedeRule(
      tenantId,
      gstr3b,
      {
        effectiveFrom: CUTOVER,
        rulePack: `gst-in@${stamp}.b`,
        dueRule: { kind: "day_of_month", dueMonthOffset: 1, dueDayOfMonth: 11, dueDaysAfter: null },
      },
      actor,
    );
    successor = rule.id;
    // Nothing past the cutover was started, and a withdrawn row is not "kept".
    expect(effect.locked).toBe(0);
    const after = await rowsOf(gstr3b);
    for (const w of off) {
      expect(after.find((r) => r.id === w.id)?.template_id).toBe(gstr3b);
    }
    // The chain's services came with it, nothing copied: Full compliance.
    const record = (await service.listRules(tenantId)).find((r) => r.template.id === successor);
    expect(record?.usedIn.map((u) => u.serviceEntryId)).toEqual([full]);
    expect((await service.filingsForService(tenantId, full)).map((r) => r.template.id)).toContain(successor);
  });

  it("adding it back restores the SAME rows in place, re-dated by the rule that governs each period", async () => {
    const before = await rowsOf(gstr3b);
    const offIds = before.filter((r) => r.withdrawn_at !== null).map((r) => r.id);

    const { effect } = await service.linkRule({ tenantId, serviceEntryId: gst, ruleId: successor }, actor);
    expect(effect.linked).toBe(true);
    expect(effect.restored).toBe(offIds.length);

    const after = await rowsOf(gstr3b);
    for (const id of offIds) {
      const row = after.find((r) => r.id === id);
      expect(row?.withdrawn_at).toBeNull();
      expect(row?.engagement_id).toBe(e2Gst);
      // From the cutover on it is the successor's, on the 11th; before it, the
      // predecessor's, on the 20th. `scheduleFor`, never SQL arithmetic.
      if ((row?.period_start ?? "") >= "2026-11-01") {
        expect(row?.template_id).toBe(successor);
        expect(row?.statutory.endsWith("-11")).toBe(true);
      } else {
        expect(row?.template_id).toBe(gstr3b);
        expect(row?.statutory.endsWith("-20")).toBe(true);
      }
    }
    // ONE LIVE ROW PER PERIOD, whichever service reached it.
    const [dupes] = await owner<{ n: string }[]>`
      SELECT count(*)::text AS n FROM (
        SELECT 1 FROM delivery.obligation_instance
         WHERE tenant_id = ${tenantId} AND lineage_id = ${gstr3b} AND withdrawn_at IS NULL
         GROUP BY entity_party_id, period_start HAVING count(*) > 1
      ) d
    `;
    expect(dupes?.n).toBe("0");
    const restored = events.recorded.filter((e) => e.verb === "obligation.restored");
    expect(restored.length).toBeGreaterThanOrEqual(offIds.length);
    expect(restored.every((e) => typeof e.payload.withdrawnAt === "string")).toBe(true);
  });
});

describe("0309's walls, each by the constraint that refuses it", () => {
  const expectRefused = async (p: Promise<unknown>, pattern: RegExp) => {
    await expect(p).rejects.toThrow(pattern);
  };

  it("one LIVE link per filing and service", async () => {
    await expectRefused(
      owner`
        INSERT INTO delivery.obligation_rule_service (tenant_id, lineage_id, service_entry_id)
        VALUES (${tenantId}, ${gstr3b}, ${full})
      `,
      /obligation_rule_service_live_key/,
    );
  });

  it("a link names the chain's ROOT, never a successor's own id", async () => {
    const [s] = await owner<{ id: string }[]>`
      SELECT id FROM delivery.obligation_template WHERE supersedes_id = ${gstr3b}
    `;
    await expectRefused(
      owner`
        INSERT INTO delivery.obligation_rule_service (tenant_id, lineage_id, service_entry_id)
        VALUES (${tenantId}, ${s?.id ?? ""}, ${gst})
      `,
      /obligation_rule_service_lineage_root_fkey/,
    );
  });

  it("a link names a SERVICE, never a role or any other catalogue entry", async () => {
    await expectRefused(
      owner`
        INSERT INTO delivery.obligation_rule_service (tenant_id, lineage_id, service_entry_id)
        VALUES (${tenantId}, ${gstr3b}, ${roleEntry})
      `,
      /obligation_rule_service_service_fkey/,
    );
  });

  it("a removal needs a person, and a removal is final", async () => {
    const [live] = await owner<{ id: string }[]>`
      SELECT id FROM delivery.obligation_rule_service
       WHERE tenant_id = ${tenantId} AND lineage_id = ${gstr3b} AND service_entry_id = ${full}
         AND unlinked_at IS NULL
    `;
    await expectRefused(
      owner`UPDATE delivery.obligation_rule_service SET unlinked_at = now() WHERE id = ${live?.id ?? ""}`,
      /obligation_rule_service_unlinked_chk/,
    );
    await expectRefused(
      owner`UPDATE delivery.obligation_rule_service SET service_entry_id = ${gst} WHERE id = ${live?.id ?? ""}`,
      /fixed when it is written/,
    );
    const [removed] = await owner<{ id: string }[]>`
      SELECT id FROM delivery.obligation_rule_service
       WHERE tenant_id = ${tenantId} AND unlinked_at IS NOT NULL LIMIT 1
    `;
    await expectRefused(
      owner`UPDATE delivery.obligation_rule_service SET unlinked_at = NULL, unlinked_by_user_id = NULL WHERE id = ${removed?.id ?? ""}`,
      /a removal is final/,
    );
  });

  it("the app may not delete a link, nor move anything but the removal", async () => {
    await expectRefused(
      withTenant(app, tenantId, (db) => db`DELETE FROM delivery.obligation_rule_service`),
      /permission denied/,
    );
    await expectRefused(
      withTenant(app, tenantId, (db) => db`UPDATE delivery.obligation_rule_service SET linked_at = now()`),
      /permission denied/,
    );
  });

  it("a withdrawn filing is untouched by definition, and says why", async () => {
    const [row] = await owner<{ id: string }[]>`
      SELECT id FROM delivery.obligation_instance
       WHERE tenant_id = ${tenantId} AND work_item_id IS NOT NULL LIMIT 1
    `;
    await expectRefused(
      owner`
        UPDATE delivery.obligation_instance
           SET withdrawn_at = now(), withdrawn_reason = 'service_unlinked'
         WHERE id = ${row?.id ?? ""}
      `,
      /obligation_instance_withdrawn_chk/,
    );
    await expectRefused(
      owner`UPDATE delivery.obligation_instance SET withdrawn_at = now() WHERE id = ${withdrawnRow}`,
      /obligation_instance_withdrawn_chk/,
    );
    await expectRefused(
      owner`
        UPDATE delivery.obligation_instance
           SET withdrawn_at = now(), withdrawn_reason = 'no_longer_wanted'
         WHERE id = ${withdrawnRow}
      `,
      /withdrawn_reason_check/,
    );
  });
});

describe("0309 runs both ways, and moves the data", () => {
  it("moves a named service into a link, gives a NULL one none, and refuses a down that would un-withdraw", async () => {
    const dir = join(process.cwd(), "migrations");
    const down = await readFile(join(dir, "0309_service_compliance_filings.down.sql"), "utf8");
    const up = await readFile(join(dir, "0309_service_compliance_filings.up.sql"), "utf8");
    const ROLLBACK = new Error("roll back the round trip");
    const seen: {
      refused: string;
      afterDown: { table: boolean; column: boolean } | null;
      named: number;
      unnamed: number;
      afterUp: { table: boolean; column: boolean } | null;
    } = { refused: "", afterDown: null, named: -1, unnamed: -1, afterUp: null };
    const probe = async (tx: postgres.TransactionSql) => {
      const [r] = await tx<{ table: boolean; column: boolean }[]>`
        SELECT to_regclass('delivery.obligation_rule_service') IS NOT NULL AS table,
               EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'delivery' AND table_name = 'obligation_template'
                          AND column_name = 'service_entry_id') AS column
      `;
      return r ?? null;
    };

    await owner
      .begin(async (tx) => {
        // A withdrawn filing exists: the down must refuse BEFORE touching
        // anything, because the schema before 0309 cannot keep it off.
        await tx`
          UPDATE delivery.obligation_instance
             SET withdrawn_at = now(), withdrawn_by_user_id = ${userId}, withdrawn_reason = 'service_unlinked'
           WHERE id = ${withdrawnRow}
        `;
        await tx
          .savepoint((sp) => sp.unsafe(down))
          .catch((e: unknown) => {
            seen.refused = e instanceof Error ? e.message : String(e);
          });

        // Decided (inside this rolled-back transaction): nothing is withdrawn.
        await tx`
          UPDATE delivery.obligation_instance
             SET withdrawn_at = NULL, withdrawn_by_user_id = NULL, withdrawn_reason = NULL
           WHERE withdrawn_at IS NOT NULL
        `;
        await tx.unsafe(down);
        // Twice, as somebody rescuing a database by hand might.
        await tx.unsafe(down);
        seen.afterDown = await probe(tx);

        // The shape 0309 found: one rule naming a service, one naming none.
        const [named] = await tx<{ id: string }[]>`
          INSERT INTO delivery.obligation_template
            (tenant_id, jurisdiction, name, recurrence, fiscal_year_start_month, due_rule,
             due_month_offset, due_day_of_month, rule_pack, status, service_entry_id)
          VALUES (${tenantId}, 'IN', 'TDS deposit', 'monthly', 4, 'day_of_month', 1, 7,
                  ${`move-${stamp}`}, 'confirmed', ${gst})
          RETURNING id
        `;
        const [unnamed] = await tx<{ id: string }[]>`
          INSERT INTO delivery.obligation_template
            (tenant_id, jurisdiction, name, recurrence, fiscal_year_start_month, due_rule,
             due_month_offset, due_day_of_month, rule_pack, status)
          VALUES (${tenantId}, 'IN', 'PT monthly', 'monthly', 4, 'day_of_month', 1, 15,
                  ${`move-${stamp}`}, 'confirmed')
          RETURNING id
        `;
        await tx.unsafe(up);
        seen.afterUp = await probe(tx);
        const count = async (id: string) => {
          const [r] = await tx<{ n: string }[]>`
            SELECT count(*)::text AS n FROM delivery.obligation_rule_service
             WHERE lineage_id = ${id} AND unlinked_at IS NULL AND linked_by_user_id IS NULL
          `;
          return Number(r?.n ?? -1);
        };
        seen.named = await count(named?.id ?? "");
        seen.unnamed = await count(unnamed?.id ?? "");
        throw ROLLBACK;
      })
      .catch((e: unknown) => {
        if (e !== ROLLBACK) throw e;
      });

    expect(seen.refused).toMatch(/taken off the calendar when a service stopped including them/);
    expect(seen.afterDown).toEqual({ table: false, column: true });
    expect(seen.afterUp).toEqual({ table: true, column: false });
    // EXACTLY one system link for the rule that named a service; none for the
    // one that named none, which under decision 1 stops generating.
    expect(seen.named).toBe(1);
    expect(seen.unnamed).toBe(0);
    // And the rollback left the real schema where it was.
    const [still] = await owner<{ table: boolean }[]>`
      SELECT to_regclass('delivery.obligation_rule_service') IS NOT NULL AS table
    `;
    expect(still?.table).toBe(true);
  });
});

// ── the review's findings: the cover test and the two writers of a chain ────

/** A filing written in the library (on no service, so nothing generates yet)
 *  under its own pack, for the tests below that link it by hand. */
async function libraryRule(name: string, dueDayOfMonth: number, serviceEntryIds?: string[]) {
  const { rule } = await service.createRule(
    {
      tenantId,
      jurisdiction: "IN",
      ...(serviceEntryIds === undefined ? {} : { serviceEntryIds }),
      name,
      recurrence: "monthly",
      fiscalYearStartMonth: 4,
      dueRule: { kind: "day_of_month", dueMonthOffset: 1, dueDayOfMonth },
      leadTimeDays: 0,
      rulePack: `review-${stamp}`,
    },
    actor,
  );
  return rule;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wait until some other session is BLOCKED on the transaction `xid`: the only
 * honest way to know a concurrent write has reached the point a test holds it
 * at. `pg_locks` is readable by every role, and a row or key wait shows as an
 * ungranted lock on the holder's transaction id.
 */
async function blockedOn(xid: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const [r] = await owner<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_locks
       WHERE locktype = 'transactionid' AND NOT granted AND transactionid::text = ${xid}
    `;
    if ((r?.n ?? 0) > 0) return;
    await pause(50);
  }
  throw new Error(`nothing ever waited on transaction ${xid}`);
}

/**
 * Hold a transaction open on the owner's connection: `work` runs inside it,
 * and it ends (committed, or rolled back when `rollback` is set) only when the
 * returned `release` is called. `ready` resolves with its transaction id.
 */
function holdOpen(
  work: (tx: postgres.TransactionSql) => Promise<unknown>,
  rollback = false,
): { ready: Promise<string>; release: () => void; done: Promise<void> } {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: (xid: string) => void = () => undefined;
  const readyP = new Promise<string>((resolve) => {
    ready = resolve;
  });
  const ROLLBACK = new Error("roll back the held transaction");
  const done = owner
    .begin(async (tx) => {
      await work(tx);
      const [x] = await tx<{ xid: string }[]>`SELECT (pg_current_xact_id()::text::numeric % 4294967296)::text AS xid`;
      ready(x?.xid ?? "");
      await released;
      if (rollback) throw ROLLBACK;
    })
    .then(() => undefined)
    .catch((e: unknown) => {
      if (e !== ROLLBACK) throw e;
    });
  return { ready: readyP, release, done };
}

describe("another service covers a filing only from the day its engagement starts (review)", () => {
  it("withdraws the periods before a later-starting engagement, and moves only the ones it owes", async () => {
    // Cobalt Futures holds service A from January and has SIGNED service B,
    // active but starting on 1 December (`pending_start` on the screen). Both
    // carry the filing, so every row sits on A, the earlier engagement.
    const a = await serviceEntry(`floor-a-${stamp}`);
    const b = await serviceEntry(`floor-b-${stamp}`);
    const x = await company(`Cobalt Futures ${stamp}`);
    const onA = await engagementFor(x, a.versionId, "2026-01-01");
    const onB = await engagementFor(x, b.versionId, "2026-12-01");
    const rule = await libraryRule("PF return", 15, [a.entryId, b.entryId]);
    const before = await rowsOf(rule.id);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((r) => r.engagement_id === onA)).toBe(true);
    const past = before.filter((r) => r.statutory < TODAY);
    const beforeB = before.filter((r) => r.statutory >= TODAY && r.statutory < "2026-12-01");
    const owedByB = before.filter((r) => r.statutory >= "2026-12-01");
    expect(past.length).toBeGreaterThan(0);
    expect(beforeB.length).toBeGreaterThan(0);
    expect(owedByB.length).toBeGreaterThan(0);

    const { effect } = await service.unlinkRule({ tenantId, serviceEntryId: a.entryId, ruleId: rule.id }, actor);

    // B owes nothing that falls due before it starts, which is the
    // generator's own floor, so September to November come off.
    expect(effect).toMatchObject({
      withdrawn: beforeB.length,
      keptCoveredElsewhere: owedByB.length,
      keptPastDue: past.length,
      keptStarted: 0,
    });
    const after = await rowsOf(rule.id);
    const byId = new Map(after.map((r) => [r.id, r]));
    for (const r of beforeB) expect(byId.get(r.id)?.withdrawn_at).not.toBeNull();
    for (const r of owedByB) {
      expect(byId.get(r.id)?.withdrawn_at).toBeNull();
      expect(byId.get(r.id)?.engagement_id).toBe(onB);
    }
    // A row already past its date stays where it was: it fell due before B
    // existed, so B is not the engagement that owed it.
    for (const r of past) expect(byId.get(r.id)?.engagement_id).toBe(onA);

    // And the generator agrees: a sweep of the same window brings none back.
    const again = await service.generate(tenantId, { from: "2026-06-01", to: "2027-08-30" }, actor, rule.id);
    expect(again.restored).toBe(0);
    const still = await rowsOf(rule.id);
    for (const r of beforeB) expect(still.find((s) => s.id === r.id)?.withdrawn_at).not.toBeNull();
  });
});

describe("two writers of one filing's calendar take turns (review)", () => {
  it("two removals of one filing from two services at once still take it off: the second waits", async () => {
    const a = await serviceEntry(`race-a-${stamp}`);
    const b = await serviceEntry(`race-b-${stamp}`);
    const y = await company(`Cobalt Twins ${stamp}`);
    const onA = await engagementFor(y, a.versionId, "2026-01-01");
    await engagementFor(y, b.versionId, "2026-03-01");
    const rule = await libraryRule("ESI return", 15, [a.entryId, b.entryId]);
    const ahead = (await rowsOf(rule.id)).filter((r) => r.statutory >= TODAY);
    expect(ahead.length).toBeGreaterThan(0);
    expect(ahead.every((r) => r.engagement_id === onA)).toBe(true);

    // THE INTERLEAVING, forced rather than hoped for. The calendar rows are
    // held, so the first removal reads them (seeing B's link still live, so
    // "covered elsewhere") and then waits to move them onto B. The second
    // removal is started while it waits. Without a lock on the chain it ran
    // straight through, found no row on B's engagement, and withdrew nothing,
    // and the first then moved every row onto a service that no longer
    // carried the filing: live filings with no link, which nothing withdraws.
    const hold = holdOpen((tx) => tx`
      SELECT id FROM delivery.obligation_instance
       WHERE tenant_id = ${tenantId} AND lineage_id = ${rule.id} FOR UPDATE
    `);
    const xid = await hold.ready;
    const first = service.unlinkRule({ tenantId, serviceEntryId: a.entryId, ruleId: rule.id }, actor);
    await blockedOn(xid);
    const second = service.unlinkRule({ tenantId, serviceEntryId: b.entryId, ruleId: rule.id }, actor);
    // It WAITS for the first: the chain's lock is held until that commits.
    // Released in `finally`, so a red run fails rather than hangs.
    try {
      expect(await Promise.race([second.then(() => "finished"), pause(750).then(() => "waiting")])).toBe(
        "waiting",
      );
    } finally {
      hold.release();
    }
    await hold.done;
    const [one, two] = await Promise.all([first, second]);

    // No service carries it now, so nothing upcoming is left on the calendar.
    const after = (await rowsOf(rule.id)).filter((r) => r.statutory >= TODAY);
    expect(after.filter((r) => r.withdrawn_at === null)).toEqual([]);
    expect(one.effect.withdrawn + two.effect.withdrawn).toBe(ahead.length);
  });

  it("a removal that lands while the generator is writing waits for it, and then withdraws what it wrote", async () => {
    const a = await serviceEntry(`race-gen-${stamp}`);
    const z = await company(`Cobalt Sprint ${stamp}`);
    const onA = await engagementFor(z, a.versionId, "2026-01-01");
    // Written in the library and linked by hand, so the calendar is empty
    // until the generator below runs.
    const rule = await libraryRule("LWF return", 15);
    expect(
      await links.link(tenantId, { id: randomUUID(), lineageId: rule.id, serviceEntryId: a.entryId, byUserId: userId }),
    ).toBe(true);
    expect(await rowsOf(rule.id)).toEqual([]);
    const states = await service.listStates(tenantId);
    const start = states.find((s) => s.isInitial);
    if (!start) throw new Error("no initial state");

    // THE INTERLEAVING: an uncommitted row holding October's key makes the
    // generator's insert wait mid-statement, after it has read the link as
    // live. The removal is started while it waits. Without a lock on the
    // chain it ran straight through and found nothing to withdraw, then the
    // generator committed a year of filings for a service that no longer
    // carried them. The held row is rolled back, so the generator writes
    // October itself.
    const hold = holdOpen(
      (tx) => tx`
        INSERT INTO delivery.obligation_instance
          (tenant_id, template_id, entity_party_id, engagement_id, period_start, period_end,
           period_label, statutory_due_on, internal_target_on, state_id)
        VALUES (${tenantId}, ${rule.id}, ${z}, ${onA}, '2026-10-01', '2026-10-31', 'Oct 2026',
                '2026-11-15', '2026-11-15', ${start.id})
      `,
      true,
    );
    const xid = await hold.ready;
    const generated = service.generate(tenantId, { from: "2026-06-01", to: "2027-08-30" }, actor, rule.id);
    await blockedOn(xid);
    const removed = service.unlinkRule({ tenantId, serviceEntryId: a.entryId, ruleId: rule.id }, actor);
    // It WAITS for the generator's write to commit.
    try {
      expect(await Promise.race([removed.then(() => "finished"), pause(750).then(() => "waiting")])).toBe(
        "waiting",
      );
    } finally {
      hold.release();
    }
    await hold.done;
    const [gen, { effect }] = await Promise.all([generated, removed]);

    expect(gen.created).toBeGreaterThan(0);
    const rows = await rowsOf(rule.id);
    expect(rows).toHaveLength(gen.created);
    const ahead = rows.filter((r) => r.statutory >= TODAY);
    expect(ahead.length).toBeGreaterThan(0);
    // Every upcoming one it wrote came off with the service, and was counted.
    expect(ahead.filter((r) => r.withdrawn_at === null)).toEqual([]);
    expect(effect.withdrawn).toBe(ahead.length);
  });
});
