// Sub-step and review-point marks, proven where the claims rest: the database
// (T6.15, migration 0307).
//
// `step-checks.test.ts` proves what a PERSON is told, against fakes that agree
// with the service by construction. These go round the application, as the
// OWNER role a migration, an import or a 2 a.m. psql session runs as, and as
// `bib_app` under the tenant resolver, which is what every request runs as:
//
//   1. "Not applicable" says why, and nothing else carries a reason.
//   2. A tick names somebody and a moment, or nothing.
//   3. A review mark names its check; a sub-step mark names none; and the check
//      must be one of the SAME step.
//   4. One mark per sub-step per step; one per review point per CHECK, so a
//      second round is a second set of rows.
//   5. Another firm's step is refused, and RLS isolates the table.
//   6. `bib_app` cannot DELETE a mark.
//   7. The adapter's upsert, clear and both reads actually execute (CLAUDE.md:
//      "if you add SQL, run it"), and the upsert is idempotent in SQL.
//   8. 0307's down and up both run, inside a transaction that is rolled back,
//      so this file never leaves the table missing.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withTenant } from "../../src/db/tenant";
import { PostgresStepCheckRepository } from "../../src/infrastructure/postgres/step-check-repository";
import { PostgresStepApprovalRepository } from "../../src/infrastructure/postgres/step-approval-repository";
import { PostgresConfigRepository } from "../../src/infrastructure/postgres/config-repository";

const cfg = load();
// Notices silenced: the only ones this file provokes are the "does not exist,
// skipping" of the SECOND down, which is the no-op being proven.
const owner = postgres(cfg.db.ownerUrl, { max: 1, onnotice: () => undefined });
const app = postgres(cfg.db.appUrl, { max: 2 });
const repo = new PostgresStepCheckRepository(app);

const stamp = Date.now().toString(36);
const ref = (): string => randomUUID();

interface Fixture {
  tenant: string;
  otherTenant: string;
  job: string;
  /** A blocked step Priya performed, with an open check on it. */
  step: string;
  approval: string;
  /** A second step of the same job, and a step of the other firm. */
  otherStep: string;
  theirStep: string;
  priya: string;
  anand: string;
}
let f: Fixture;

async function newStep(tenant: string, job: string, performer: string | null): Promise<string> {
  const id = ref();
  await owner`
    INSERT INTO delivery.job_step
      (id, tenant_id, job_id, step_key, label, executor, status, started_at, performed_by)
    VALUES (${id}, ${tenant}, ${job}, ${`step-${randomUUID().slice(0, 8)}`}, 'A step', 'human', 'blocked', now(), ${performer})
  `;
  return id;
}

/** A mark written as the OWNER, going round everything but the database. */
async function mark(over: {
  list?: string;
  step?: string;
  approval?: string | null;
  key?: string;
  outcome?: string | null;
  note?: string | null;
  by?: string | null;
  at?: "now" | null;
  tenant?: string;
}): Promise<string> {
  const id = ref();
  const list = over.list ?? "checklist";
  const outcome = over.outcome === undefined ? "done" : over.outcome;
  const by = over.by === undefined ? (outcome === null ? null : f.priya) : over.by;
  const at = over.at === undefined ? (outcome === null ? null : "now") : over.at;
  await owner`
    INSERT INTO delivery.job_step_check
      (id, tenant_id, job_step_id, step_approval_id, list, item_key, label, outcome, note, marked_by_user_id, marked_at)
    VALUES (
      ${id}, ${over.tenant ?? f.tenant}, ${over.step ?? f.step},
      ${over.approval === undefined ? (list === "review" ? f.approval : null) : over.approval},
      ${list}, ${over.key ?? `k-${randomUUID().slice(0, 8)}`}, 'Bank statements',
      ${outcome}, ${over.note ?? null}, ${by}, ${at === "now" ? owner`now()` : null}
    )
  `;
  return id;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`checks-a-${stamp}`}, 'Step Checks Test A', 'INR') RETURNING id
  `;
  const [o] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`checks-b-${stamp}`}, 'Step Checks Test B', 'INR') RETURNING id
  `;
  if (!t || !o) throw new Error("could not create the test firms");
  const [p] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`priya-checks-${stamp}@example.com`}, 'Priya Shah') RETURNING id
  `;
  const [a] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`anand-checks-${stamp}@example.com`}, NULL) RETURNING id
  `;
  if (!p || !a) throw new Error("could not create the test users");

  // `source_kind = 'obligation'` so no crm rows are needed: this file is about
  // the marks, and a client, a letter and a service would prove nothing here.
  const job = ref();
  await owner`
    INSERT INTO delivery.job (id, tenant_id, source_kind, source_ref, runnable_at)
    VALUES (${job}, ${t.id}, 'obligation', ${ref()}, now())
  `;
  const theirJob = ref();
  await owner`
    INSERT INTO delivery.job (id, tenant_id, source_kind, source_ref, runnable_at)
    VALUES (${theirJob}, ${o.id}, 'obligation', ${ref()}, now())
  `;
  f = {
    tenant: t.id, otherTenant: o.id, job, step: "", approval: "", otherStep: "", theirStep: "",
    priya: p.id, anand: a.id,
  };
  f.step = await newStep(t.id, job, p.id);
  f.otherStep = await newStep(t.id, job, p.id);
  f.theirStep = await newStep(o.id, theirJob, null);
  f.approval = ref();
  await owner`
    INSERT INTO delivery.step_approval (id, tenant_id, job_id, job_step_id)
    VALUES (${f.approval}, ${t.id}, ${job}, ${f.step})
  `;
});

afterAll(async () => {
  await Promise.all([owner.end({ timeout: 5 }), app.end({ timeout: 5 })]);
});

describe("'not applicable' says why, and nothing else carries a reason", () => {
  it("refuses not_applicable with no note, a blank one, or one over 500 characters", async () => {
    await expect(mark({ outcome: "not_applicable", note: null })).rejects.toThrow(/job_step_check_not_applicable_says_why/);
    await expect(mark({ outcome: "not_applicable", note: "   " })).rejects.toThrow(/job_step_check_not_applicable_says_why/);
    await expect(mark({ outcome: "not_applicable", note: "x".repeat(501) })).rejects.toThrow(
      /job_step_check_not_applicable_says_why/,
    );
  });

  it("accepts not_applicable with a reason", async () => {
    await expect(mark({ outcome: "not_applicable", note: "No payroll this month" })).resolves.toBeTruthy();
  });

  it("refuses a reason on a tick, and on an open line", async () => {
    // The CASE matters here: with a plain equality, an open line's NULL
    // outcome would make the CHECK NULL, which passes.
    await expect(mark({ outcome: "done", note: "why" })).rejects.toThrow(/job_step_check_not_applicable_says_why/);
    await expect(mark({ outcome: null, note: "stale reason" })).rejects.toThrow(/job_step_check_not_applicable_says_why/);
  });

  it("refuses an outcome the engine does not know", async () => {
    await expect(mark({ outcome: "skipped" })).rejects.toThrow(/job_step_check_outcome_check/);
  });
});

describe("a tick names somebody and a moment, or nothing", () => {
  it("refuses a tick with nobody behind it, or no time", async () => {
    await expect(mark({ outcome: "done", by: null })).rejects.toThrow(/job_step_check_mark_names_somebody/);
    await expect(mark({ outcome: "done", at: null })).rejects.toThrow(/job_step_check_mark_names_somebody/);
  });

  it("refuses an open line that names a marker", async () => {
    await expect(mark({ outcome: null, by: f.priya, at: "now" })).rejects.toThrow(/job_step_check_mark_names_somebody/);
  });

  it("accepts an open line with nobody on it", async () => {
    await expect(mark({ outcome: null })).resolves.toBeTruthy();
  });
});

describe("a review mark names its check, of the same step", () => {
  it("refuses a review mark with no check, and a sub-step mark with one", async () => {
    await expect(mark({ list: "review", approval: null })).rejects.toThrow(/job_step_check_review_rows_name_their_check/);
    await expect(mark({ list: "checklist", approval: f.approval })).rejects.toThrow(
      /job_step_check_review_rows_name_their_check/,
    );
  });

  it("refuses a review mark whose step is not the step its check is about", async () => {
    // The composite key over (check, step, firm). Without it a review tick could
    // hang off one step's check while naming another step.
    const err = await mark({ list: "review", step: f.otherStep }).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23503");
    expect(String(err)).toMatch(/job_step_check_approval_step_tenant_fkey/);
  });

  it("refuses a list the engine does not have", async () => {
    await expect(mark({ list: "extra" })).rejects.toThrow(/job_step_check_list_check/);
  });
});

describe("one mark per line: per step for sub-steps, per CHECK for review points", () => {
  it("refuses a second sub-step mark on the same line of the same step", async () => {
    await mark({ key: "bank" });
    await expect(mark({ key: "bank" })).rejects.toThrow(/job_step_check_one_per_sub_step/);
  });

  it("refuses a second review mark on the same line of the same check", async () => {
    await mark({ list: "review", key: "pl" });
    await expect(mark({ list: "review", key: "pl" })).rejects.toThrow(/job_step_check_one_per_review_point/);
  });

  it("lets the two lists reuse a key on one step", async () => {
    await mark({ list: "checklist", key: "same" });
    await expect(mark({ list: "review", key: "same" })).resolves.toBeTruthy();
  });

  it("lets a SECOND check of the same step carry the same review point: round two starts empty", async () => {
    const step = await newStep(f.tenant, f.job, f.priya);
    const first = ref();
    await owner`INSERT INTO delivery.step_approval (id, tenant_id, job_id, job_step_id) VALUES (${first}, ${f.tenant}, ${f.job}, ${step})`;
    await mark({ list: "review", step, approval: first, key: "bs" });
    await owner`
      UPDATE delivery.step_approval
         SET decision = 'rejected', decided_by = ${f.anand}, decided_at = now(), notes = 'does not tie'
       WHERE id = ${first}
    `;
    const second = ref();
    await owner`INSERT INTO delivery.step_approval (id, tenant_id, job_id, job_step_id) VALUES (${second}, ${f.tenant}, ${f.job}, ${step})`;
    await expect(mark({ list: "review", step, approval: second, key: "bs" })).resolves.toBeTruthy();
  });
});

describe("the tenant wall", () => {
  it("refuses a mark on another firm's step, as bib_app under this firm's own context", async () => {
    const err = await withTenant(app, f.tenant, (db) =>
      db`
        INSERT INTO delivery.job_step_check
          (tenant_id, job_step_id, list, item_key, label, outcome, marked_by_user_id, marked_at)
        VALUES (${f.tenant}, ${f.theirStep}, 'checklist', 'x', 'X', 'done', ${f.priya}, now())
      `,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23503");
  });

  it("hides one firm's marks from another", async () => {
    await mark({ key: `rls-${stamp}` });
    const mine = await withTenant(app, f.tenant, (db) => db<{ n: string }[]>`
      SELECT count(*)::text AS n FROM delivery.job_step_check WHERE item_key = ${`rls-${stamp}`}
    `);
    const theirs = await withTenant(app, f.otherTenant, (db) => db<{ n: string }[]>`
      SELECT count(*)::text AS n FROM delivery.job_step_check WHERE item_key = ${`rls-${stamp}`}
    `);
    expect(mine[0]?.n).toBe("1");
    expect(theirs[0]?.n).toBe("0");
  });

  it("gives bib_app no DELETE: unticking is an outcome of NULL, never a row removed", async () => {
    const id = await mark({});
    const err = await withTenant(app, f.tenant, (db) =>
      db`DELETE FROM delivery.job_step_check WHERE id = ${id}`,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("42501"); // insufficient_privilege
    const [grant] = await owner<{ del: boolean; upd: boolean }[]>`
      SELECT has_table_privilege('bib_app', 'delivery.job_step_check', 'DELETE') AS del,
             has_table_privilege('bib_app', 'delivery.job_step_check', 'UPDATE') AS upd
    `;
    expect(grant).toEqual({ del: false, upd: true });
  });
});

describe("the adapter's SQL, executed", () => {
  it("writes a sub-step tick, reads it back with the marker's name, and is idempotent", async () => {
    const step = await newStep(f.tenant, f.job, null);
    const first = await repo.upsert({
      id: ref(), tenantId: f.tenant, jobStepId: step, stepApprovalId: null, list: "checklist",
      itemKey: "s1", label: "Bank statements", outcome: "done", note: null,
      markedByUserId: f.priya, markedAt: "2026-09-25T09:00:00.000Z",
    });
    expect(first).toMatchObject({ outcome: "done", markedByUserId: f.priya, markedByName: "Priya Shah", markedAt: "2026-09-25T09:00:00.000Z" });

    // The same answer again, by somebody else, later: nothing moves.
    const again = await repo.upsert({
      id: ref(), tenantId: f.tenant, jobStepId: step, stepApprovalId: null, list: "checklist",
      itemKey: "s1", label: "Bank statements", outcome: "done", note: null,
      markedByUserId: f.anand, markedAt: "2026-09-25T10:00:00.000Z",
    });
    expect(again).toMatchObject({ id: first.id, markedByUserId: f.priya, markedAt: "2026-09-25T09:00:00.000Z" });

    // A different answer overwrites, on the same row. Anand has no display name,
    // so the address stands in, rather than a blank beside the tick.
    const changed = await repo.upsert({
      id: ref(), tenantId: f.tenant, jobStepId: step, stepApprovalId: null, list: "checklist",
      itemKey: "s1", label: "Bank statements", outcome: "not_applicable", note: "No bank account yet",
      markedByUserId: f.anand, markedAt: "2026-09-25T11:00:00.000Z",
    });
    expect(changed).toMatchObject({
      id: first.id, outcome: "not_applicable", note: "No bank account yet",
      markedByUserId: f.anand, markedByName: `anand-checks-${stamp}@example.com`,
    });

    const onJob = await repo.listForJob(f.tenant, f.job);
    expect(onJob.filter((m) => m.jobStepId === step)).toHaveLength(1);

    await repo.clear({ tenantId: f.tenant, list: "checklist", jobStepId: step, stepApprovalId: null, itemKey: "s1" });
    const [cleared] = (await repo.listForJob(f.tenant, f.job)).filter((m) => m.jobStepId === step);
    expect(cleared).toMatchObject({ outcome: null, note: null, markedByUserId: null, markedByName: null, markedAt: null });
  });

  it("never inserts a row to take back a tick nobody made", async () => {
    const step = await newStep(f.tenant, f.job, null);
    await repo.clear({ tenantId: f.tenant, list: "checklist", jobStepId: step, stepApprovalId: null, itemKey: "never" });
    const rows = await owner`SELECT 1 FROM delivery.job_step_check WHERE job_step_id = ${step}`;
    expect(rows).toHaveLength(0);
  });

  it("writes review points against the CHECK, and reads them by check", async () => {
    const step = await newStep(f.tenant, f.job, f.priya);
    const approval = ref();
    await owner`INSERT INTO delivery.step_approval (id, tenant_id, job_id, job_step_id) VALUES (${approval}, ${f.tenant}, ${f.job}, ${step})`;
    const written = await repo.upsert({
      id: ref(), tenantId: f.tenant, jobStepId: step, stepApprovalId: approval, list: "review",
      itemKey: "r1", label: "P&L movements", outcome: "done", note: null,
      markedByUserId: f.anand, markedAt: "2026-09-25T12:00:00.000Z",
    });
    expect(written).toMatchObject({ list: "review", stepApprovalId: approval, itemKey: "r1" });
    const byCheck = await repo.listForApprovals(f.tenant, [approval]);
    expect(byCheck.map((m) => m.itemKey)).toEqual(["r1"]);
    expect(await repo.listForApprovals(f.tenant, [])).toEqual([]);

    await repo.clear({ tenantId: f.tenant, list: "review", jobStepId: step, stepApprovalId: approval, itemKey: "r1" });
    const [open] = await repo.listForApprovals(f.tenant, [approval]);
    expect(open?.outcome).toBeNull();
  });
});

describe("the reads the lists ride on, executed", () => {
  it("reads a stored template's lists through the config adapter, and a check carries its job's pin", async () => {
    // A real published `workflow_template` body with both lists, pinned onto a
    // job with a check open: the config adapter must hand the orchestrator both
    // lists, and the check queue's join must carry the pin, or the screen has
    // no review points to show.
    const [entry] = await owner<{ id: string }[]>`
      INSERT INTO config.entry (tenant_id, kind, key)
      VALUES (${f.tenant}, 'workflow_template', ${`close-${stamp}`}) RETURNING id
    `;
    if (!entry) throw new Error("could not create the config entry");
    const body = {
      label: "Monthly close",
      steps: [
        {
          key: "review", label: "Manager review", executor: "human", dependsOn: [], condition: null,
          verificationPolicyKey: "manager_review", performer: null,
          checklist: [{ key: "s1", label: "Close pack assembled" }],
          reviewPoints: [{ key: "r1", label: "P&L movements" }, { key: "r2", label: "Balance sheet movements" }],
        },
      ],
    };
    const [version] = await owner<{ id: string }[]>`
      INSERT INTO config.version (tenant_id, entry_id, version, status, body, published_at)
      VALUES (${f.tenant}, ${entry.id}, 1, 'published', ${JSON.stringify(body)}::text::jsonb, now()) RETURNING id
    `;
    if (!version) throw new Error("could not publish the version");

    const template = await new PostgresConfigRepository(app).pinnedTemplate(f.tenant, version.id);
    expect(template?.steps[0]?.checklist).toEqual([{ key: "s1", label: "Close pack assembled" }]);
    expect(template?.steps[0]?.reviewPoints.map((l) => l.key)).toEqual(["r1", "r2"]);

    const job = ref();
    await owner`
      INSERT INTO delivery.job (id, tenant_id, source_kind, source_ref, runnable_at, template_version_id)
      VALUES (${job}, ${f.tenant}, 'obligation', ${ref()}, now(), ${version.id})
    `;
    const step = await newStep(f.tenant, job, f.priya);
    const approval = ref();
    await owner`INSERT INTO delivery.step_approval (id, tenant_id, job_id, job_step_id) VALUES (${approval}, ${f.tenant}, ${job}, ${step})`;
    const approvals = new PostgresStepApprovalRepository(app);
    const [onJob] = await approvals.listForJob(f.tenant, job);
    expect(onJob?.templateVersionId).toBe(version.id);
    const queued = (await approvals.listPending(f.tenant)).find((c) => c.approval.id === approval);
    expect(queued?.templateVersionId).toBe(version.id);
  });
});

describe("0307 runs both ways", () => {
  it("drops cleanly and re-creates, inside a transaction that is rolled back", async () => {
    const dir = join(process.cwd(), "migrations");
    const down = await readFile(join(dir, "0307_job_step_check.down.sql"), "utf8");
    const up = await readFile(join(dir, "0307_job_step_check.up.sql"), "utf8");
    const ROLLBACK = new Error("roll back the round trip");
    const seen: { afterDown: unknown; afterUp: unknown } = { afterDown: null, afterUp: null };
    const probe = (tx: postgres.TransactionSql) => tx<{ table: boolean; key: boolean; constraints: string }[]>`
      SELECT to_regclass('delivery.job_step_check') IS NOT NULL AS table,
             EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'step_approval_id_step_tenant_key') AS key,
             (SELECT count(*)::text FROM pg_constraint WHERE conname LIKE 'job_step_check_%') AS constraints
    `;
    await owner
      .begin(async (tx) => {
        await tx.unsafe(down);
        seen.afterDown = (await probe(tx))[0];
        // Twice, as somebody rescuing a database by hand might.
        await tx.unsafe(down);
        await tx.unsafe(up);
        seen.afterUp = (await probe(tx))[0];
        throw ROLLBACK;
      })
      .catch((e: unknown) => {
        if (e !== ROLLBACK) throw e;
      });
    expect(seen.afterDown).toEqual({ table: false, key: false, constraints: "0" });
    expect(seen.afterUp).toMatchObject({ table: true, key: true });
    expect(Number((seen.afterUp as { constraints: string }).constraints)).toBeGreaterThanOrEqual(10);
    // And the rollback left the real table where it was.
    const [still] = await owner<{ table: boolean }[]>`SELECT to_regclass('delivery.job_step_check') IS NOT NULL AS table`;
    expect(still?.table).toBe(true);
  });
});
