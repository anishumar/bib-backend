// The merge, proven where its claims actually have to hold (T2.7, 0046).
//
// `merge.test.ts` proves the RULE against a fake that reproduces the
// constraints. A fake agrees with the service by construction, so these are the
// properties no fake can establish:
//
//   1. `job_engagement UNIQUE NULLS NOT DISTINCT (tenant_id, engagement_id,
//      period_start)` — the DATABASE, not the application, refuses a second job
//      for work already owed: one per engagement, forever, for a one-time
//      service, and one per engagement PER PERIOD for a recurring one (0300).
//      This is the load-bearing claim of the whole merge: a second checklist
//      is a second set of tasks and eventually a second invoice.
//   2. The PARTIAL unique index really is partial — one OPEN job per group, and
//      a second one is legal once the first has finished.
//   3. The composite foreign keys hold, so one firm's job cannot be linked to
//      another firm's engagement.
//   4. RLS isolates the link table.
//   5. The feed's real SQL resolves the grouping facts off live service bodies
//      and merges accordingly — the query, not the shape of it.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresJobRepository } from "../../src/infrastructure/postgres/job-repository";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });
const repo = new PostgresJobRepository(app);

const stamp = Date.now().toString(36);
const ref = (): string => randomUUID();

interface Fixture {
  tenant: string;
  otherTenant: string;
  client: string;
  entity1: string;
  entity2: string;
  letter1: string;
  letter2: string;
  /** GST — FinCompliance, FRC, entity 1, letter 1. */
  gst: string;
  /** TDS — FinCompliance, TRC, entity 1, letter 1. Merges with GST by team. */
  tds: string;
  /** Payroll — Payroll team, FRC, entity 1, letter 1. Never merges with them. */
  payroll: string;
  /** GST again, for the client's SECOND company. Per Company: never merges. */
  gstOther: string;
  /** Bookkeeping — MONTHLY, VCFO CONSOLE, FRC, entity 1, letter 1. Takes the
   *  per-period route (T6.13), so the activation feed never offers it. */
  books: string;
  otherTenantEngagement: string;
}
let f: Fixture;

/** A published service, as the catalogue would hold it. The three fields this
 *  task reads are `module`, `group` and `workflowTemplateKey`; the rest is what
 *  the body validator requires of any service. */
async function service(
  tenantId: string,
  key: string,
  moduleCode: string,
  groupCode: string,
  workflowKey: string | null,
  recurrence: "one_time" | "monthly" = "one_time",
): Promise<string> {
  const entryId = ref();
  await owner`
    INSERT INTO config.entry (id, tenant_id, kind, key)
    VALUES (${entryId}, ${tenantId}, 'service', ${key})
  `;
  const versionId = ref();
  const body = {
    name: key,
    ref: null,
    description: null,
    category: null,
    module: moduleCode,
    group: groupCode,
    jurisdictions: ["IN"],
    billingBasis: "fixed",
    // ONE-TIME by default, since T6.13: a monthly service is owed a job PER
    // PERIOD from a different feed, and the activation feed these tests drive
    // no longer offers it. The merge rule is the same either way; this file
    // proves it on the route that has been there since T2.7, and proves the
    // OTHER route on the one monthly line below.
    recurrence,
    slaDays: null,
    listPrice: null,
    ...(workflowKey === null ? {} : { workflowTemplateKey: workflowKey }),
  };
  await owner`
    INSERT INTO config.version (id, tenant_id, entry_id, version, status, body, published_at)
    VALUES (${versionId}, ${tenantId}, ${entryId}, 1, 'published', ${owner.json(body)}, now())
  `;
  return versionId;
}

/** One priced line and the engagement it fans out to. Everything below the
 *  letter, in one call, because every test here needs several. */
async function line(
  tenantId: string,
  letterId: string,
  clientId: string,
  entityId: string,
  versionId: string,
  position: number,
): Promise<string> {
  const lineId = ref();
  await owner`
    INSERT INTO crm.engagement_letter_line
      (id, tenant_id, engagement_letter_id, service_version_id, description, position,
       quantity, unit_amount, currency, entity_party_id)
    VALUES (${lineId}, ${tenantId}, ${letterId}, ${versionId}, ${`line ${position}`},
            ${position}, 1, 1000, 'INR', ${entityId})
  `;
  const engagementId = ref();
  await owner`
    INSERT INTO crm.engagement
      (id, tenant_id, engagement_letter_id, engagement_letter_line_id, party_id,
       entity_party_id, status, activated_at, effective_from)
    VALUES (${engagementId}, ${tenantId}, ${letterId}, ${lineId}, ${clientId},
            ${entityId}, 'active', now(), current_date)
  `;
  // The trigger the engine actually listens to. Written by hand here because
  // this test is about the FEED and the merge, not about the advance gate.
  await owner`
    INSERT INTO ledger.event
      (id, tenant_id, actor_type, actor_id, verb, object_type, object_id, payload)
    VALUES (${ref()}, ${tenantId}, 'system', NULL, 'contract.activated', 'engagement',
            ${engagementId}, '{}'::jsonb)
  `;
  return engagementId;
}

async function party(tenantId: string, name: string): Promise<string> {
  const id = ref();
  await owner`
    INSERT INTO core.party (id, tenant_id, kind, display_name)
    VALUES (${id}, ${tenantId}, 'organization', ${name})
  `;
  return id;
}

/** A DRAFT letter. `ref` has to match `el_ref_shape_chk` — the firm's own
 *  document-number shape — so it is minted from a counter rather than a slug. */
let refSeq = 1000;
async function letter(
  tenantId: string,
  clientId: string,
  issuerId: string,
  slug: string,
): Promise<string> {
  const id = ref();
  refSeq += 1;
  const documentRef = `EL-2026-${refSeq}`;
  await owner`
    INSERT INTO crm.engagement_letter
      (id, tenant_id, party_id, jurisdiction, title, status, currency, fx_rate,
       fx_rate_date, ref, issuing_entity_party_id)
    VALUES (${id}, ${tenantId}, ${clientId}, 'IN', ${slug}, 'draft', 'INR', 1,
            current_date, ${documentRef}, ${issuerId})
  `;
  return id;
}

/**
 * Sign the letter, AFTER its lines exist — which is the only order the schema
 * permits, and the fixture is written this way because being forced into it is
 * the point.
 *
 * `trg_el_line_freeze` refuses to move a line onto or off a signed letter, so a
 * fixture that created the letter signed and then added lines is a document
 * this product cannot hold. A signature is also whole or absent
 * (`el_signature_is_whole_chk`), and a non-draft has a sent_at.
 */
async function sign(letterId: string): Promise<void> {
  await owner`
    UPDATE crm.engagement_letter
    SET status = 'signed',
        sent_at = now(),
        signed_at = now(),
        signed_by_name = 'A Signatory',
        signature_method = 'attested',
        signed_content_hash = repeat('a', 64)
    WHERE id = ${letterId}
  `;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, work_split_axis)
    VALUES (${`merge-a-${stamp}`}, 'Merge Test A', 'INR', 'team') RETURNING id
  `;
  const [o] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`merge-b-${stamp}`}, 'Merge Test B', 'INR') RETURNING id
  `;
  if (!t || !o) throw new Error("could not create the test firms");

  const tenant = t.id;
  const client = await party(tenant, "Zephyr Group");
  const entity1 = await party(tenant, "Zephyr India Pvt Ltd");
  const entity2 = await party(tenant, "Zephyr Services Pvt Ltd");
  const issuer = await party(tenant, "10x Global");

  const letter1 = await letter(tenant, client, issuer, `l1-${stamp}`);
  const letter2 = await letter(tenant, client, issuer, `l2-${stamp}`);

  const svcGst = await service(tenant, `gst-${stamp}`, "FRC", "FINCOMPLIANCE", "monthly-filing");
  const svcTds = await service(tenant, `tds-${stamp}`, "TRC", "FINCOMPLIANCE", "monthly-filing");
  const svcPay = await service(tenant, `pay-${stamp}`, "FRC", "PAYROLL", "monthly-filing");

  const gst = await line(tenant, letter1, client, entity1, svcGst, 1);
  const tds = await line(tenant, letter1, client, entity1, svcTds, 2);
  const payroll = await line(tenant, letter1, client, entity1, svcPay, 3);
  // The client's SECOND company, same service, same letter. Per Company says
  // this may never join the first company's checklist.
  const gstOther = await line(tenant, letter1, client, entity2, svcGst, 4);
  // The recurring line: activated like the others, and deliberately NOT what
  // the activation feed offers — see the T6.13 block at the end of this file.
  const svcBooks = await service(tenant, `books-${stamp}`, "FRC", "VCFO CONSOLE", "monthly-books", "monthly");
  const books = await line(tenant, letter1, client, entity1, svcBooks, 5);
  await sign(letter1);
  await sign(letter2);

  // Another firm entirely, for the isolation checks.
  const otherClient = await party(o.id, "Somebody Else Ltd");
  const otherIssuer = await party(o.id, "Another Firm");
  const otherLetter = await letter(o.id, otherClient, otherIssuer, `l3-${stamp}`);
  const otherSvc = await service(o.id, `gst-${stamp}`, "FRC", "FINCOMPLIANCE", null);
  const otherTenantEngagement = await line(
    o.id,
    otherLetter,
    otherClient,
    otherClient,
    otherSvc,
    1,
  );
  await sign(otherLetter);

  f = {
    tenant,
    otherTenant: o.id,
    client,
    entity1,
    entity2,
    letter1,
    letter2,
    gst,
    tds,
    payroll,
    gstOther,
    books,
    otherTenantEngagement,
  };
});

afterAll(async () => {
  // Connections only. `ledger.event` refuses DELETE to every role including the
  // owner (0003's trigger), so these fixtures cannot be torn down — every
  // integration test in this repo leaves its own, and the local database is
  // scaffolding that `npm run migrate` plus `npm run smoke` rebuilds.
  await Promise.all([owner.end({ timeout: 5 }), app.end({ timeout: 5 })]);
});

describe("the feed resolves the grouping facts from real rows", () => {
  it("carries the letter, the entity, the team and the process off the LIVE body", async () => {
    const rows = await repo.unspawnedActivations(f.tenant, 50);
    const gst = rows.find((r) => r.engagementId === f.gst);
    expect(gst).toMatchObject({
      engagementLetterId: f.letter1,
      entityPartyId: f.entity1,
      deptCode: "FRC",
      teamCode: "FINCOMPLIANCE",
      workflowKey: "monthly-filing",
    });
  });

  it("does not offer another firm's activations", async () => {
    const rows = await repo.unspawnedActivations(f.tenant, 50);
    expect(rows.map((r) => r.engagementId)).not.toContain(f.otherTenantEngagement);
  });

  it("offers nothing for an activation naming an engagement that is not there", async () => {
    // A deliberate narrowing (0046): job_engagement's foreign key means such an
    // activation could not become a job anyway, so the feed does not offer work
    // it could not create. Before the link table it produced a phantom job that
    // sat forever unable to resolve its own subject.
    const phantom = ref();
    await owner`
      INSERT INTO ledger.event
        (id, tenant_id, actor_type, actor_id, verb, object_type, object_id, payload)
      VALUES (${ref()}, ${f.tenant}, 'system', NULL, 'contract.activated', 'engagement',
              ${phantom}, '{}'::jsonb)
    `;
    const rows = await repo.unspawnedActivations(f.tenant, 50);
    expect(rows.map((r) => r.engagementId)).not.toContain(phantom);
  });
});

describe("the database refuses a second job for work already owed", () => {
  it("links an engagement once, whatever a caller asks for", async () => {
    const a = await repo.createIfAbsent({
      id: ref(),
      tenantId: f.tenant,
      sourceKind: "engagement_group",
      sourceRef: ref(),
      runnableAt: new Date().toISOString(),
      splitAxis: "team",
      splitCode: "FINCOMPLIANCE",
    });
    const b = await repo.createIfAbsent({
      id: ref(),
      tenantId: f.tenant,
      sourceKind: "engagement_group",
      sourceRef: ref(),
      runnableAt: new Date().toISOString(),
      splitAxis: "team",
      splitCode: "FINCOMPLIANCE",
    });

    expect(await repo.linkEngagements(f.tenant, a.job.id, [f.payroll])).toEqual([f.payroll]);
    // THE RULE, and it is the UNIQUE key doing it, not this code.
    expect(await repo.linkEngagements(f.tenant, b.job.id, [f.payroll])).toEqual([]);

    const detail = await repo.describeJobs(f.tenant, [a.job.id, b.job.id]);
    expect(detail.get(a.job.id)?.services.map((s) => s.engagementId)).toEqual([f.payroll]);
    expect(detail.get(b.job.id)).toBeUndefined();
  });

  it("refuses to link one firm's job to another firm's engagement", async () => {
    // The composite foreign key. A foreign-key check runs as a system operation
    // RLS does not filter, so an id-only reference would let this through
    // silently.
    const job = await repo.createIfAbsent({
      id: ref(),
      tenantId: f.tenant,
      sourceKind: "engagement_group",
      sourceRef: ref(),
      runnableAt: new Date().toISOString(),
      splitAxis: "team",
      splitCode: "FINCOMPLIANCE",
    });
    await expect(
      repo.linkEngagements(f.tenant, job.job.id, [f.otherTenantEngagement]),
    ).rejects.toThrow();
  });
});

describe("at most one OPEN job per group — and the index really is partial", () => {
  it("hands back the open job rather than inserting a second", async () => {
    const sourceRef = ref();
    const base = {
      tenantId: f.tenant,
      sourceKind: "engagement_group" as const,
      sourceRef,
      runnableAt: new Date().toISOString(),
      splitAxis: "team" as const,
      splitCode: "FINCOMPLIANCE",
    };
    const first = await repo.createIfAbsent({ ...base, id: ref() });
    const second = await repo.createIfAbsent({ ...base, id: ref() });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
  });

  it("allows a NEW job for the same group once the first has finished", async () => {
    const sourceRef = ref();
    const base = {
      tenantId: f.tenant,
      sourceKind: "engagement_group" as const,
      sourceRef,
      runnableAt: new Date().toISOString(),
      splitAxis: "team" as const,
      splitCode: "FINCOMPLIANCE",
    };
    const first = await repo.createIfAbsent({ ...base, id: ref() });
    const at = new Date().toISOString();
    await repo.updateStatus(f.tenant, first.job.id, "running", at);
    await repo.updateStatus(f.tenant, first.job.id, "done", at);

    // Attaching new work to a finished checklist means work nobody looks at
    // again — so a later engagement gets its own job, and the plain UNIQUE this
    // replaced would have refused it.
    const second = await repo.createIfAbsent({ ...base, id: ref() });
    expect(second.created).toBe(true);
    expect(second.job.id).not.toBe(first.job.id);
  });
});

describe("RLS on the link table", () => {
  it("hides one firm's links from another", async () => {
    const job = await repo.createIfAbsent({
      id: ref(),
      tenantId: f.tenant,
      sourceKind: "engagement_group",
      sourceRef: ref(),
      runnableAt: new Date().toISOString(),
      splitAxis: "team",
      splitCode: "FINCOMPLIANCE",
    });
    await repo.linkEngagements(f.tenant, job.job.id, [f.gstOther]);

    const theirs = await repo.describeJobs(f.otherTenant, [job.job.id]);
    expect(theirs.size).toBe(0);
  });

  it("gives the app no DELETE grant — an engagement is never unlinked", async () => {
    const rows = await owner<{ privilege_type: string }[]>`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = 'delivery' AND table_name = 'job_engagement'
        AND grantee = 'bib_app'
    `;
    expect(rows.map((r) => r.privilege_type).sort()).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });
});

// ── T6.13 / 0300: a recurring engagement takes the per-period route ─────────

describe("a recurring engagement is owed a job PER PERIOD, and the database holds that", () => {
  const period = (start: string, end: string, label: string) => ({
    id: ref(),
    tenantId: f.tenant,
    sourceKind: "engagement_period" as const,
    sourceRef: ref(),
    runnableAt: new Date().toISOString(),
    splitAxis: "team" as const,
    splitCode: "VCFO CONSOLE",
    periodStart: start,
    periodEnd: end,
    periodLabel: label,
  });

  it("is NOT offered by the activation feed, though its contract activated", async () => {
    // The monthly line's `contract.activated` event is in the ledger exactly
    // like the other four. The feed's own predicate keeps it out — a one-time
    // checklist for a monthly service is the thing this task exists to stop.
    const offered = await repo.unspawnedActivations(f.tenant, 50);
    expect(offered.map((a) => a.engagementId)).not.toContain(f.books);
  });

  it("IS offered by the recurring feed, with the letter's terms and no periods yet", async () => {
    const rows = await repo.activeRecurring(f.tenant, 50);
    const books = rows.find((r) => r.engagementId === f.books);
    expect(books).toMatchObject({
      engagementLetterId: f.letter1,
      entityPartyId: f.entity1,
      recurrence: "monthly",
      slaDays: null,
      // LIVE grouping facts, as the activation feed reads them.
      deptCode: "FRC",
      teamCode: "VCFO CONSOLE",
      workflowKey: "monthly-books",
      linkedPeriods: [],
    });
    // A DATE, read as text — never an instant.
    expect(books?.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // And the one-time lines are not in it.
    expect(rows.map((r) => r.engagementId)).not.toContain(f.gst);
  });

  it("links one engagement to one job PER PERIOD — the KEY refuses a second for the same month", async () => {
    const september = await repo.createIfAbsent(period("2026-09-01", "2026-09-30", "Sep 2026"));
    expect(september.created).toBe(true);
    expect(september.job).toMatchObject({
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      periodLabel: "Sep 2026",
    });
    expect(await repo.linkEngagements(f.tenant, september.job.id, [f.books], "2026-09-01")).toEqual([
      f.books,
    ]);

    // A SECOND job for the same month, different cause: the link is refused by
    // the key, and the caller is told nothing joined.
    const duplicate = await repo.createIfAbsent(period("2026-09-01", "2026-09-30", "Sep 2026"));
    expect(await repo.linkEngagements(f.tenant, duplicate.job.id, [f.books], "2026-09-01")).toEqual(
      [],
    );

    // A different month is a different piece of work: legal.
    const october = await repo.createIfAbsent(period("2026-10-01", "2026-10-31", "Oct 2026"));
    expect(await repo.linkEngagements(f.tenant, october.job.id, [f.books], "2026-10-01")).toEqual([
      f.books,
    ]);

    // And the feed's anti-join now reports both, oldest first.
    const rows = await repo.activeRecurring(f.tenant, 50);
    expect(rows.find((r) => r.engagementId === f.books)?.linkedPeriods).toEqual([
      "2026-09-01",
      "2026-10-01",
    ]);
  });

  it("keeps the OLD absolute rule for a one-time engagement: a null period is one value", async () => {
    // A fresh one-time line on its own letter, so nothing else in this file
    // has linked it. NULLS NOT DISTINCT is what makes the three-column key
    // still refuse a second null-period link — a plain UNIQUE would treat
    // every NULL as a fresh value and let the at-least-once duplicate through.
    const letterId = await letter(f.tenant, f.client, f.entity2, `once-${stamp}`);
    const svc = await service(f.tenant, `once-${stamp}`, "FRC", "FINCOMPLIANCE", null);
    const once = await line(f.tenant, letterId, f.client, f.entity1, svc, 1);
    await sign(letterId);

    const first = await repo.createIfAbsent({
      id: ref(),
      tenantId: f.tenant,
      sourceKind: "engagement",
      sourceRef: once,
      runnableAt: new Date().toISOString(),
      splitAxis: "none",
      splitCode: null,
    });
    expect(await repo.linkEngagements(f.tenant, first.job.id, [once])).toEqual([once]);

    const second = await repo.createIfAbsent({
      id: ref(),
      tenantId: f.tenant,
      sourceKind: "engagement_group",
      sourceRef: ref(),
      runnableAt: new Date().toISOString(),
      splitAxis: "team",
      splitCode: "FINCOMPLIANCE",
    });
    expect(await repo.linkEngagements(f.tenant, second.job.id, [once])).toEqual([]);
  });

  it("refuses a period job without its period, and a period on any other kind", async () => {
    // The two CHECKs in 0300: the kind and the period are one fact.
    await expect(
      repo.createIfAbsent({
        id: ref(),
        tenantId: f.tenant,
        sourceKind: "engagement_period",
        sourceRef: ref(),
        runnableAt: new Date().toISOString(),
        splitAxis: "none",
        splitCode: null,
      }),
    ).rejects.toThrow(/job_period_matches_kind/);

    await expect(
      repo.createIfAbsent({
        id: ref(),
        tenantId: f.tenant,
        sourceKind: "engagement",
        sourceRef: ref(),
        runnableAt: new Date().toISOString(),
        splitAxis: "none",
        splitCode: null,
        periodStart: "2026-09-01",
        periodEnd: "2026-09-30",
        periodLabel: "Sep 2026",
      }),
    ).rejects.toThrow(/job_period_matches_kind/);
  });

  it("lists an upcoming period job for the board, and not for the orchestrator", async () => {
    const opens = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const upcoming = await repo.createIfAbsent({
      ...period("2026-11-01", "2026-11-30", "Nov 2026"),
      runnableAt: opens,
    });
    const open = await repo.listOpen(f.tenant, 100);
    expect(open.map((j) => j.id)).toContain(upcoming.job.id);
    const runnable = await repo.listRunnable(f.tenant, new Date().toISOString(), 100);
    expect(runnable.map((j) => j.id)).not.toContain(upcoming.job.id);
  });
});
