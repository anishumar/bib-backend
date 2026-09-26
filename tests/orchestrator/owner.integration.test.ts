// The owner rule's facts, read where the bug lived (2026-09-27).
//
// Until this file, NOTHING tested `PostgresJobDeskResolver`, and its SQL found
// the SPOC only through the job's split code. A firm keeping a client's work
// together has no split code, so every job's steps went to nobody while its
// task went to the SPOC: measured on a local database, 0 of 619 steps assigned
// on such jobs, 30 of 30 on jobs split by Dept. A fake resolver agrees with the
// service by construction, so these are the properties only Postgres can show:
//
//   1. A kept-together job finds its Dept from its SERVICES (the bug), and a
//      job split by Dept from its split code.
//   2. A job holding two Depts' work says so, by the Depts' names.
//   3. Only ACTIVE staff are candidates, on every rung: a SPOC who left, a Key
//      Manager who left, and a signatory whose access was revoked are nobody.
//   4. A Key Manager named from a later day is not today's.
//   5. The service's own faults (no Dept, a Dept the firm does not have) are
//      named rather than read as "no SPOC".
//   6. The task router's reads (`spocsFor`, `PostgresWorkOwnerDirectory`) give
//      the same people, so a task and its steps cannot be decided apart.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresJobDeskResolver } from "../../src/infrastructure/postgres/job-desk-resolver";
import { PostgresWorkOwnerDirectory } from "../../src/infrastructure/postgres/work-owner";
import { PostgresClientAssignmentRepository } from "../../src/infrastructure/postgres/client-assignment-repository";
import { resolveOwner } from "../../src/domain/workitem/model";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });
const desks = new PostgresJobDeskResolver(app);
const owners = new PostgresWorkOwnerDirectory(app);
const assignments = new PostgresClientAssignmentRepository(app);

const stamp = Date.now().toString(36);
const ref = (): string => randomUUID();
const TODAY = "2026-09-27";

let tenant: string;
let client: string;
let entity: string;
let issuer: string;
let frc: string;
let trc: string;
const users: Record<"priya" | "gone" | "kavya" | "sid" | "rajat", string> = {
  priya: "",
  gone: "",
  kavya: "",
  sid: "",
  rajat: "",
};

async function user(name: string, active: boolean): Promise<string> {
  const [u] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`${name}-${stamp}@owner.test`}, ${name}) RETURNING id
  `;
  if (!u) throw new Error("no user");
  await owner`
    INSERT INTO tenancy.membership (tenant_id, user_id, audience, role, is_active)
    VALUES (${tenant}, ${u.id}, 'STAFF', 'associate', ${active})
  `;
  return u.id;
}

async function party(name: string): Promise<string> {
  const id = ref();
  await owner`
    INSERT INTO core.party (id, tenant_id, kind, display_name)
    VALUES (${id}, ${tenant}, 'organization', ${name})
  `;
  return id;
}

async function service(key: string, moduleCode: string | null): Promise<string> {
  const entryId = ref();
  await owner`
    INSERT INTO config.entry (id, tenant_id, kind, key)
    VALUES (${entryId}, ${tenant}, 'service', ${key})
  `;
  const versionId = ref();
  const body = {
    name: key,
    ref: null,
    description: null,
    category: null,
    module: moduleCode,
    group: null,
    jurisdictions: ["IN"],
    billingBasis: "fixed",
    recurrence: "one_time",
    slaDays: null,
    listPrice: null,
  };
  await owner`
    INSERT INTO config.version (id, tenant_id, entry_id, version, status, body, published_at)
    VALUES (${versionId}, ${tenant}, ${entryId}, 1, 'published', ${owner.json(body)}, now())
  `;
  return versionId;
}

let refSeq = 5000;
/** A signed letter with one engagement per service, and one job over all of
 *  them, cut the way `split` says. Returns the job's id. */
async function job(
  services: readonly string[],
  split: { axis: "none" | "dept" | "team"; code: string | null } = { axis: "none", code: null },
): Promise<string> {
  const letterId = ref();
  refSeq += 1;
  await owner`
    INSERT INTO crm.engagement_letter
      (id, tenant_id, party_id, jurisdiction, title, status, currency, fx_rate,
       fx_rate_date, ref, issuing_entity_party_id)
    VALUES (${letterId}, ${tenant}, ${client}, 'IN', ${`owner-${refSeq}`}, 'draft', 'INR', 1,
            current_date, ${`EL-2026-${refSeq}`}, ${issuer})
  `;
  const engagements: string[] = [];
  for (const [i, versionId] of services.entries()) {
    const lineId = ref();
    await owner`
      INSERT INTO crm.engagement_letter_line
        (id, tenant_id, engagement_letter_id, service_version_id, description, position,
         quantity, unit_amount, currency, entity_party_id)
      VALUES (${lineId}, ${tenant}, ${letterId}, ${versionId}, ${`line ${i + 1}`}, ${i + 1},
              1, 1000, 'INR', ${entity})
    `;
    const engagementId = ref();
    await owner`
      INSERT INTO crm.engagement
        (id, tenant_id, engagement_letter_id, engagement_letter_line_id, party_id,
         entity_party_id, status, activated_at, effective_from)
      VALUES (${engagementId}, ${tenant}, ${letterId}, ${lineId}, ${client},
              ${entity}, 'active', now(), current_date)
    `;
    engagements.push(engagementId);
  }
  await owner`
    UPDATE crm.engagement_letter
    SET status = 'signed', sent_at = now(), signed_at = now(), signed_by_name = 'A Signatory',
        signature_method = 'attested', signed_content_hash = repeat('a', 64)
    WHERE id = ${letterId}
  `;
  const jobId = ref();
  await owner`
    INSERT INTO delivery.job (id, tenant_id, source_kind, source_ref, split_axis, split_code)
    VALUES (${jobId}, ${tenant}, 'engagement_group', ${ref()}, ${split.axis}, ${split.code})
  `;
  for (const engagementId of engagements) {
    await owner`
      INSERT INTO delivery.job_engagement (tenant_id, job_id, engagement_id)
      VALUES (${tenant}, ${jobId}, ${engagementId})
    `;
  }
  return jobId;
}

async function assign(
  role: "spoc" | "key_manager",
  userId: string,
  axisId: string | null,
  validFrom = "2026-01-01",
): Promise<string> {
  const id = ref();
  await owner`
    INSERT INTO crm.client_assignment (id, tenant_id, client_party_id, role, axis_id, user_id, valid_from)
    VALUES (${id}, ${tenant}, ${client}, ${role}, ${axisId}, ${userId}, ${validFrom})
  `;
  return id;
}

async function unassign(id: string): Promise<void> {
  // Ended the day after it began, so it is in force on no day these tests ask
  // about, whenever it started.
  await owner`UPDATE crm.client_assignment SET valid_to = valid_from + 1 WHERE id = ${id}`;
}

let frcService: string;
let trcService: string;
let noDeptService: string;
let strayService: string;

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`owner-${stamp}`}, 'Owner Rule Test', 'INR') RETURNING id
  `;
  if (!t) throw new Error("could not create the test firm");
  tenant = t.id;
  client = await party("Kaveri Foods Group");
  entity = await party("Kaveri Foods Pvt Ltd");
  issuer = await party("10x Global");

  const [f, r] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.service_axis (tenant_id, axis, code, name, sort_order)
    VALUES (${tenant}, 'dept', 'FRC', 'Financial Reporting and Compliance', 1),
           (${tenant}, 'dept', 'TRC', 'Tax, Transactions, Regulatory and Consulting', 2)
    RETURNING id
  `;
  if (!f || !r) throw new Error("no depts");
  frc = f.id;
  trc = r.id;

  users.priya = await user("Priya", true);
  users.gone = await user("Gone", false);
  users.kavya = await user("Kavya", true);
  users.sid = await user("Sid", true);
  users.rajat = await user("Rajat", false);

  frcService = await service(`acc-${stamp}`, "FRC");
  trcService = await service(`tax-${stamp}`, "TRC");
  noDeptService = await service(`misc-${stamp}`, null);
  strayService = await service(`stray-${stamp}`, "FRX");
});

afterAll(async () => {
  await owner.end();
  await app.end();
});

describe("the job's Dept", () => {
  it("comes from its SERVICE when the firm keeps a client's work together: the bug", async () => {
    const spoc = await assign("spoc", users.priya, frc);
    try {
      const facts = await desks.ownerFactsFor(tenant, await job([frcService]), TODAY);
      expect(facts.noLookup).toBeNull();
      expect(facts.deptName).toBe("Financial Reporting and Compliance");
      expect(facts.spocs.map((s) => s.userId)).toEqual([users.priya]);
      expect(resolveOwner(facts)).toMatchObject({ userId: users.priya, how: "spoc", note: null });
    } finally {
      await unassign(spoc);
    }
  });

  it("comes from the split code when the firm splits by Dept", async () => {
    const spoc = await assign("spoc", users.priya, trc);
    try {
      // The split code wins over the service: this job was cut as TRC's.
      const facts = await desks.ownerFactsFor(tenant, await job([frcService], { axis: "dept", code: "TRC" }), TODAY);
      expect(facts.deptName).toBe("Tax, Transactions, Regulatory and Consulting");
      expect(facts.spocs.map((s) => s.userId)).toEqual([users.priya]);
    } finally {
      await unassign(spoc);
    }
  });

  it("is SEVERAL when a kept-together job holds two Depts' work, named in the firm's order", async () => {
    const facts = await desks.ownerFactsFor(tenant, await job([trcService, frcService]), TODAY);
    expect(facts.noLookup).toEqual({
      kind: "several_depts",
      names: ["Financial Reporting and Compliance", "Tax, Transactions, Regulatory and Consulting"],
    });
    expect(facts.spocs).toEqual([]);
  });

  it("names the service's own fault: filed under no Dept, or under a Dept the firm does not have", async () => {
    expect((await desks.ownerFactsFor(tenant, await job([noDeptService]), TODAY)).noLookup).toEqual({ kind: "no_dept" });
    expect((await desks.ownerFactsFor(tenant, await job([strayService]), TODAY)).noLookup).toEqual({
      kind: "unknown_dept",
      code: "FRX",
    });
  });
});

describe("only active staff, on every rung", () => {
  it("passes over a SPOC who has left the firm, to the Key Manager", async () => {
    const spoc = await assign("spoc", users.gone, frc);
    const km = await assign("key_manager", users.kavya, null);
    try {
      const jobId = await job([frcService]);
      const facts = await desks.ownerFactsFor(tenant, jobId, TODAY);
      expect(facts.spocs).toEqual([]);
      expect(facts.keyManager).toEqual({ userId: users.kavya, displayName: "Kavya" });
      expect(resolveOwner(facts)).toMatchObject({ userId: users.kavya, how: "key_manager" });
      // The task router reads the same people.
      expect(await assignments.spocsFor(tenant, client, frc, TODAY)).toEqual([]);
      expect(await owners.keyManagerFor(tenant, client, TODAY)).toEqual({ userId: users.kavya, displayName: "Kavya" });
    } finally {
      await unassign(spoc);
      await unassign(km);
    }
  });

  it("does not treat a Key Manager named from a later day as today's, and falls to the signatory", async () => {
    const km = await assign("key_manager", users.kavya, null, "2026-10-01");
    await owner`
      UPDATE tenancy.tenant SET firm_signatory_user_id = ${users.sid}, firm_signatory_title = 'Partner'
      WHERE id = ${tenant}
    `;
    try {
      const facts = await desks.ownerFactsFor(tenant, await job([frcService]), TODAY);
      expect(facts.keyManager).toBeNull();
      expect(facts.partner).toEqual({ userId: users.sid, displayName: "Sid" });
      expect(resolveOwner(facts)).toMatchObject({ userId: users.sid, how: "partner" });
      expect(await owners.signingPartner(tenant)).toEqual({ userId: users.sid, displayName: "Sid" });
    } finally {
      await unassign(km);
    }
  });

  it("passes over a signatory whose access was revoked: nobody, with the note saying so", async () => {
    await owner`
      UPDATE tenancy.tenant SET firm_signatory_user_id = ${users.rajat}, firm_signatory_title = 'Partner'
      WHERE id = ${tenant}
    `;
    const facts = await desks.ownerFactsFor(tenant, await job([frcService]), TODAY);
    expect(facts.partner).toBeNull();
    expect(await owners.signingPartner(tenant)).toBeNull();
    expect(resolveOwner(facts)).toMatchObject({ userId: null, how: null });
  });
});

describe("who holds the job's task", () => {
  // A firm created by a raw INSERT has no work vocabulary (0050 seeded the
  // firms that existed then), so the two states and one priority are written.
  let open = "";
  let finished = "";
  let medium = "";
  beforeAll(async () => {
    const [o, f] = await owner<{ id: string }[]>`
      INSERT INTO delivery.work_item_state (tenant_id, code, name, is_initial, is_terminal, is_success, sort_order)
      VALUES (${tenant}, 'not_started', 'Not Started', true, false, false, 10),
             (${tenant}, 'completed', 'Completed', false, true, true, 90)
      RETURNING id
    `;
    const [p] = await owner<{ id: string }[]>`
      INSERT INTO delivery.work_item_priority (tenant_id, code, name, rank, is_default, is_statutory_default)
      VALUES (${tenant}, 'medium', 'Medium', 2, true, true) RETURNING id
    `;
    if (!o || !f || !p) throw new Error("no vocabulary");
    open = o.id;
    finished = f.id;
    medium = p.id;
  });

  async function task(jobId: string, assignee: string | null, terminal = false): Promise<void> {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO delivery.work_item (tenant_id, client_party_id, job_id, title, state_id, priority_id, assignee_user_id)
      VALUES (${tenant}, ${client}, ${jobId}, 'Monthly Accounting · Sep 2026', ${open}, ${medium}, ${assignee})
      RETURNING id
    `;
    if (!row) throw new Error("no task");
    if (terminal) {
      await owner`
        UPDATE delivery.work_item SET state_id = ${finished}, started_at = now(), completed_at = now()
        WHERE id = ${row.id}
      `;
    }
  }

  it("is the one person every open task of the job is on", async () => {
    const jobId = await job([frcService]);
    await task(jobId, users.kavya);
    // A finished task on somebody else's desk does not count.
    await task(jobId, users.priya, true);
    expect((await desks.ownerFactsFor(tenant, jobId, TODAY)).taskHolder).toEqual({ userId: users.kavya, displayName: "Kavya" });
  });

  it("is nobody when the open tasks are on two desks, one is on nobody's, or the holder has left", async () => {
    const two = await job([frcService]);
    await task(two, users.kavya);
    await task(two, users.priya);
    expect((await desks.ownerFactsFor(tenant, two, TODAY)).taskHolder).toBeNull();

    const unheld = await job([frcService]);
    await task(unheld, null);
    expect((await desks.ownerFactsFor(tenant, unheld, TODAY)).taskHolder).toBeNull();

    const left = await job([frcService]);
    await task(left, users.gone);
    expect((await desks.ownerFactsFor(tenant, left, TODAY)).taskHolder).toBeNull();

    const none = await job([frcService]);
    expect((await desks.ownerFactsFor(tenant, none, TODAY)).taskHolder).toBeNull();
  });
});
