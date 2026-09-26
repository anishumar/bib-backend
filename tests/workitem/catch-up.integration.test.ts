// The owner rule's CATCH-UP and the letter's routing preview, read where they
// live (T6.17, 2026-09-27).
//
// The fakes reproduce these queries' WHERE clauses by construction, so a fake
// can never show a clause missing from the SQL. These are the properties only
// Postgres can show:
//
//   1. The catch-up reads ONLY work nobody has decided about: engine work (an
//      engagement's task, or a filing's through `obligation_instance`), in the
//      firm's starting state, carrying the router's note and not the sentence
//      a person leaves when they take a task off a desk; and only the client
//      asked about.
//   2. A filing's task names the engagement its obligation is owed under,
//      which the task's own row does not carry (0053).
//   3. The move is refused when anything it was decided on changed: holder,
//      note (NULL-safe on both), or the task having been started.
//   4. The letter preview reads the CLIENT from the letter and the Dept from
//      the LIVE service, as the router will once the letter is signed, and a
//      letter at another firm is not found.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresWorkItemRepository } from "../../src/infrastructure/postgres/work-item-repository";
import { PostgresLetterWorkSource } from "../../src/infrastructure/postgres/engagement-work-source";
import { TAKEN_OFF_BY_HAND_NOTE } from "../../src/domain/workitem/model";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });
const items = new PostgresWorkItemRepository(app);
const letters = new PostgresLetterWorkSource(app);

const stamp = Date.now().toString(36);
const ref = (): string => randomUUID();
const KM_NOTE = "No SPOC is recorded for FRC on this client, so it came to the client's Key Manager to hand out.";
const NOBODY_NOTE = "No SPOC is recorded for FRC on this client, the client has no Key Manager, and so nobody could be given this.";

let tenant: string;
let otherTenant: string;
let client: string;
let otherClient: string;
let entity: string;
let issuer: string;
let ravi: string;
let priya: string;
let notStarted: string;
let inProgress: string;
let medium: string;
let obligationState: string;
let frcV1: string;
let noDeptV1: string;

async function party(t: string, name: string): Promise<string> {
  const id = ref();
  await owner`INSERT INTO core.party (id, tenant_id, kind, display_name) VALUES (${id}, ${t}, 'organization', ${name})`;
  return id;
}

async function user(name: string): Promise<string> {
  const [u] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`${name}-${stamp}@catchup.test`}, ${name}) RETURNING id
  `;
  if (!u) throw new Error("no user");
  await owner`
    INSERT INTO tenancy.membership (tenant_id, user_id, audience, role, is_active)
    VALUES (${tenant}, ${u.id}, 'STAFF', 'associate', true)
  `;
  return u.id;
}

async function service(key: string, moduleCode: string | null): Promise<{ entryId: string; versionId: string }> {
  const entryId = ref();
  await owner`INSERT INTO config.entry (id, tenant_id, kind, key) VALUES (${entryId}, ${tenant}, 'service', ${key})`;
  const versionId = ref();
  await owner`
    INSERT INTO config.version (id, tenant_id, entry_id, version, status, body, published_at)
    VALUES (${versionId}, ${tenant}, ${entryId}, 1, 'published',
            ${owner.json({ name: key, module: moduleCode, jurisdictions: ["IN"], billingBasis: "fixed", recurrence: "one_time" })},
            now())
  `;
  return { entryId, versionId };
}

let refSeq = 7000;
/** A letter for `forClient` with one line per service, in that order. Left a
 *  DRAFT when `sign` is false (the preview's case); otherwise signed, with an
 *  engagement per line and one job over them. */
async function letter(
  versions: readonly string[],
  sign: boolean,
  forClient = client,
): Promise<{ letterId: string; lineIds: string[]; engagementIds: string[]; jobId: string | null }> {
  const letterId = ref();
  refSeq += 1;
  await owner`
    INSERT INTO crm.engagement_letter
      (id, tenant_id, party_id, jurisdiction, title, status, currency, fx_rate,
       fx_rate_date, ref, issuing_entity_party_id)
    VALUES (${letterId}, ${tenant}, ${forClient}, 'IN', ${`catchup-${refSeq}`}, 'draft', 'INR', 1,
            current_date, ${`EL-2026-${refSeq}`}, ${issuer})
  `;
  const lineIds: string[] = [];
  const engagementIds: string[] = [];
  for (const [i, versionId] of versions.entries()) {
    const lineId = ref();
    lineIds.push(lineId);
    await owner`
      INSERT INTO crm.engagement_letter_line
        (id, tenant_id, engagement_letter_id, service_version_id, description, position,
         quantity, unit_amount, currency, entity_party_id)
      VALUES (${lineId}, ${tenant}, ${letterId}, ${versionId}, ${`line ${i + 1}`}, ${i + 1},
              1, 1000, 'INR', ${entity})
    `;
    if (sign) {
      const engagementId = ref();
      engagementIds.push(engagementId);
      await owner`
        INSERT INTO crm.engagement
          (id, tenant_id, engagement_letter_id, engagement_letter_line_id, party_id,
           entity_party_id, status, activated_at, effective_from)
        VALUES (${engagementId}, ${tenant}, ${letterId}, ${lineId}, ${forClient},
                ${entity}, 'active', now(), current_date)
      `;
    }
  }
  if (!sign) return { letterId, lineIds, engagementIds, jobId: null };
  await owner`
    UPDATE crm.engagement_letter
    SET status = 'signed', sent_at = now(), signed_at = now(), signed_by_name = 'A Signatory',
        signature_method = 'attested', signed_content_hash = repeat('a', 64)
    WHERE id = ${letterId}
  `;
  const jobId = ref();
  await owner`
    INSERT INTO delivery.job (id, tenant_id, source_kind, source_ref, split_axis, split_code)
    VALUES (${jobId}, ${tenant}, 'engagement_group', ${ref()}, 'none', NULL)
  `;
  for (const engagementId of engagementIds) {
    await owner`INSERT INTO delivery.job_engagement (tenant_id, job_id, engagement_id) VALUES (${tenant}, ${jobId}, ${engagementId})`;
  }
  return { letterId, lineIds, engagementIds, jobId };
}

async function task(row: {
  engagementId?: string | null | undefined;
  jobId?: string | null;
  assignee: string | null;
  note: string | null;
  state?: string;
  forClient?: string;
  dueOn?: string | null;
}): Promise<string> {
  const [created] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item
      (tenant_id, client_party_id, entity_party_id, engagement_id, job_id, title, state_id,
       priority_id, assignee_user_id, assignment_note, due_on)
    VALUES (${tenant}, ${row.forClient ?? client}, ${entity}, ${row.engagementId ?? null},
            ${row.jobId ?? null}, 'Monthly Accounting · Sep 2026', ${row.state ?? notStarted},
            ${medium}, ${row.assignee}, ${row.note}, ${row.dueOn ?? null})
    RETURNING id
  `;
  if (!created) throw new Error("no task");
  return created.id;
}

beforeAll(async () => {
  const [t, o] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`catchup-${stamp}`}, 'Catch-up Test', 'INR'),
           (${`catchup-other-${stamp}`}, 'Catch-up Other Firm', 'INR')
    RETURNING id
  `;
  if (!t || !o) throw new Error("could not create the test firms");
  tenant = t.id;
  otherTenant = o.id;
  client = await party(tenant, "Kaveri Foods Group");
  otherClient = await party(tenant, "Narmada Textiles");
  entity = await party(tenant, "Kaveri Foods Pvt Ltd");
  issuer = await party(tenant, "10x Global");
  await owner`
    INSERT INTO tenancy.service_axis (tenant_id, axis, code, name, sort_order)
    VALUES (${tenant}, 'dept', 'FRC', 'Financial Reporting and Compliance', 1),
           (${tenant}, 'dept', 'TRC', 'Tax, Transactions, Regulatory and Consulting', 2)
  `;
  ravi = await user("Ravi");
  priya = await user("Priya");

  // A COMPLETE vocabulary, though these tests read only the first two states:
  // `calendar.integration.test.ts` checks every firm in the database has a
  // successful terminal task state and a filed obligation state, and a
  // fixture firm without them fails it on every later run.
  const [ns, ip] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_state (tenant_id, code, name, is_initial, is_terminal, is_success, sort_order)
    VALUES (${tenant}, 'not_started', 'Not Started', true, false, false, 10),
           (${tenant}, 'in_progress', 'In Progress', false, false, false, 20),
           (${tenant}, 'completed', 'Completed', false, true, true, 90)
    RETURNING id
  `;
  const [p] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_priority (tenant_id, code, name, rank, is_default, is_statutory_default)
    VALUES (${tenant}, 'medium', 'Medium', 2, true, true) RETURNING id
  `;
  const [os] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_state (tenant_id, code, name, is_initial, sort_order)
    VALUES (${tenant}, 'pending', 'Pending', true, 10) RETURNING id
  `;
  await owner`
    INSERT INTO delivery.obligation_state (tenant_id, code, name, is_terminal, is_filed, sort_order)
    VALUES (${tenant}, 'filed', 'Filed', true, true, 90)
  `;
  if (!ns || !ip || !p || !os) throw new Error("no vocabulary");
  notStarted = ns.id;
  inProgress = ip.id;
  medium = p.id;
  obligationState = os.id;

  const frc = await service(`acc-${stamp}`, "FRC");
  frcV1 = frc.versionId;
  noDeptV1 = (await service(`misc-${stamp}`, null)).versionId;
});

afterAll(async () => {
  await owner.end();
  await app.end();
});

describe("the catch-up's candidates", () => {
  it("are the client's unstarted engine work still carrying the router's note, and nothing a person decided", async () => {
    const signed = await letter([frcV1, frcV1, frcV1, frcV1, frcV1], true);
    const [e1, e2, e3, e4, e5] = signed.engagementIds;
    const other = await letter([frcV1], true, otherClient);

    // Waiting: on the Key Manager's desk to hand out, and on nobody's.
    const onKeyManager = await task({ engagementId: e1, jobId: signed.jobId, assignee: ravi, note: KM_NOTE });
    const onNobody = await task({ engagementId: e2, jobId: signed.jobId, assignee: null, note: NOBODY_NOTE });
    // Decided: taken off a desk by a person, handed on by a person (or held by
    // the SPOC: no note either way), and started.
    await task({ engagementId: e3, jobId: signed.jobId, assignee: null, note: TAKEN_OFF_BY_HAND_NOTE });
    await task({ engagementId: e4, jobId: signed.jobId, assignee: priya, note: null });
    await task({ engagementId: e5, jobId: signed.jobId, assignee: ravi, note: KM_NOTE, state: inProgress });
    // Raised by hand: no engagement and no obligation, whatever its note says.
    await task({ assignee: null, note: "Raised by hand with no Dept, so there was nothing to route on." });
    // Another client's waiting work.
    await task({ engagementId: other.engagementIds[0], jobId: other.jobId, assignee: ravi, note: KM_NOTE, forClient: otherClient });

    const found = await items.listCatchUpCandidates(tenant, client, TAKEN_OFF_BY_HAND_NOTE);

    expect(found.map((c) => c.workItemId).sort()).toEqual([onKeyManager, onNobody].sort());
    expect(found.find((c) => c.workItemId === onKeyManager)).toEqual({
      workItemId: onKeyManager,
      jobId: signed.jobId,
      assigneeUserId: ravi,
      assignmentNote: KM_NOTE,
      engagementId: e1,
      isFiling: false,
      dueOn: null,
    });
    await owner`DELETE FROM delivery.work_item WHERE client_party_id IN (${client}, ${otherClient})`;
  });

  it("include a filing's task, named with the engagement its obligation is owed under", async () => {
    const signed = await letter([frcV1], true);
    const engagementId = signed.engagementIds[0];
    if (engagementId === undefined) throw new Error("no engagement");
    const filing = await task({ assignee: ravi, note: KM_NOTE, dueOn: "2026-10-20" });
    const [rule] = await owner<{ id: string }[]>`
      INSERT INTO delivery.obligation_template
        (tenant_id, jurisdiction, name, recurrence, fiscal_year_start_month,
         due_rule, due_month_offset, due_day_of_month, rule_pack, status)
      VALUES (${tenant}, 'IN', ${`GSTR-3B ${stamp}`}, 'monthly', 4, 'day_of_month', 1, 20,
              ${`catchup-${stamp}@1`}, 'confirmed')
      RETURNING id
    `;
    if (!rule) throw new Error("no rule");
    await owner`
      INSERT INTO delivery.obligation_instance
        (tenant_id, template_id, entity_party_id, engagement_id, period_start, period_end,
         period_label, statutory_due_on, internal_target_on, state_id, work_item_id)
      VALUES (${tenant}, ${rule.id}, ${entity}, ${engagementId}, '2026-09-01'::date, '2026-09-30'::date,
              'Sep 2026', '2026-10-20'::date, '2026-10-15'::date, ${obligationState}, ${filing})
    `;

    const found = await items.listCatchUpCandidates(tenant, client, TAKEN_OFF_BY_HAND_NOTE);

    expect(found).toEqual([
      {
        workItemId: filing,
        jobId: null,
        assigneeUserId: ravi,
        assignmentNote: KM_NOTE,
        engagementId,
        isFiling: true,
        dueOn: "2026-10-20",
      },
    ]);
    await owner`DELETE FROM delivery.obligation_instance WHERE work_item_id = ${filing}`;
    await owner`DELETE FROM delivery.work_item WHERE client_party_id = ${client}`;
  });
});

describe("the catch-up's move", () => {
  it("moves a waiting task and writes the new note", async () => {
    const signed = await letter([frcV1], true);
    const id = await task({ engagementId: signed.engagementIds[0], jobId: signed.jobId, assignee: ravi, note: KM_NOTE });

    const moved = await items.reroute(tenant, id, { assigneeUserId: ravi, note: KM_NOTE }, { assigneeUserId: priya, note: null });

    expect(moved).toMatchObject({ id, assigneeUserId: priya, assignmentNote: null });
  });

  it("moves a task from nobody's desk: the NULL holder matches", async () => {
    const signed = await letter([frcV1], true);
    const id = await task({ engagementId: signed.engagementIds[0], jobId: signed.jobId, assignee: null, note: NOBODY_NOTE });

    const moved = await items.reroute(tenant, id, { assigneeUserId: null, note: NOBODY_NOTE }, { assigneeUserId: ravi, note: KM_NOTE });

    expect(moved).toMatchObject({ assigneeUserId: ravi, assignmentNote: KM_NOTE });
  });

  it("is refused when somebody moved it, re-noted it, or started it since it was read", async () => {
    const signed = await letter([frcV1, frcV1, frcV1], true);
    const [a, b, c] = signed.engagementIds;
    const handed = await task({ engagementId: a, jobId: signed.jobId, assignee: priya, note: null });
    const renoted = await task({ engagementId: b, jobId: signed.jobId, assignee: ravi, note: "a different sentence" });
    const started = await task({ engagementId: c, jobId: signed.jobId, assignee: ravi, note: KM_NOTE, state: inProgress });

    const expected = { assigneeUserId: ravi, note: KM_NOTE };
    expect(await items.reroute(tenant, handed, expected, { assigneeUserId: priya, note: null })).toBeNull();
    expect(await items.reroute(tenant, renoted, expected, { assigneeUserId: priya, note: null })).toBeNull();
    expect(await items.reroute(tenant, started, expected, { assigneeUserId: priya, note: null })).toBeNull();

    const rows = await owner<{ id: string; assignee_user_id: string | null }[]>`
      SELECT id, assignee_user_id FROM delivery.work_item WHERE id IN (${handed}, ${renoted}, ${started})
    `;
    expect(new Map(rows.map((r) => [r.id, r.assignee_user_id]))).toEqual(
      new Map([
        [handed, priya],
        [renoted, ravi],
        [started, ravi],
      ]),
    );
  });

  it("cannot reach another firm's task", async () => {
    const signed = await letter([frcV1], true);
    const id = await task({ engagementId: signed.engagementIds[0], jobId: signed.jobId, assignee: ravi, note: KM_NOTE });
    expect(await items.reroute(otherTenant, id, { assigneeUserId: ravi, note: KM_NOTE }, { assigneeUserId: priya, note: null })).toBeNull();
    expect(await items.listCatchUpCandidates(otherTenant, client, TAKEN_OFF_BY_HAND_NOTE)).toEqual([]);
  });
});

describe("an unsigned letter's lines, for the routing preview", () => {
  it("are the letter's client and, per line in order, the LIVE service's Dept", async () => {
    // A service of its own: a published version is frozen, so what this test
    // publishes stays published.
    const moving = await service(`moving-${stamp}`, "FRC");
    const draft = await letter([noDeptV1, moving.versionId], false);

    // The firm moves the service to TRC after the letter was drafted. The line
    // stays pinned to v1 (its name and price), and the work will be routed by
    // the live Dept, as `EngagementWorkSource` reads it once signed.
    await owner`UPDATE config.version SET status = 'archived', archived_at = now() WHERE id = ${moving.versionId}`;
    await owner`
      INSERT INTO config.version (id, tenant_id, entry_id, version, status, body, published_at)
      VALUES (${ref()}, ${tenant}, ${moving.entryId}, 2, 'published',
              ${owner.json({ name: "renamed", module: "TRC", jurisdictions: ["IN"], billingBasis: "fixed", recurrence: "one_time" })},
              now())
    `;

    expect(await letters.linesOf(tenant, draft.letterId)).toEqual({
      clientPartyId: client,
      lines: [
        { lineId: draft.lineIds[0], name: `misc-${stamp}`, deptCode: null },
        { lineId: draft.lineIds[1], name: `moving-${stamp}`, deptCode: "TRC" },
      ],
    });
  });

  it("is nothing for a letter that is not there, or is another firm's", async () => {
    const draft = await letter([frcV1], false);
    expect(await letters.linesOf(tenant, ref())).toBeNull();
    expect(await letters.linesOf(otherTenant, draft.letterId)).toBeNull();
  });
});
