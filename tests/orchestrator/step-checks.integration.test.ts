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
//   9. The row locks the reviewers' races needed (T6.15 review): a mark is
//      written only while its list is open, and Done, the check opening and
//      Approve read the list only after taking the lock a mark takes, each
//      proven by holding the other side's transaction open and watching the
//      database park the write behind it.
//  10. 0308: a reason or a label of only whitespace is blank, by exactly the
//      whitespace `String.prototype.trim` strips, and 0308 runs both ways.
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
import { PostgresJobStepRepository } from "../../src/infrastructure/postgres/job-step-repository";

const cfg = load();
// Notices silenced: the only ones this file provokes are the "does not exist,
// skipping" of the SECOND down, which is the no-op being proven.
const owner = postgres(cfg.db.ownerUrl, { max: 1, onnotice: () => undefined });
const app = postgres(cfg.db.appUrl, { max: 2 });
// A second owner connection, to watch pg_stat_activity while `owner` holds a
// transaction open for one side of a race.
const watch = postgres(cfg.db.ownerUrl, { max: 1, onnotice: () => undefined });
const repo = new PostgresStepCheckRepository(app);
const steps = new PostgresJobStepRepository(app);
const approvals = new PostgresStepApprovalRepository(app);

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
  label?: string;
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
      ${list}, ${over.key ?? `k-${randomUUID().slice(0, 8)}`}, ${over.label ?? "Bank statements"},
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
  await Promise.all([owner.end({ timeout: 5 }), app.end({ timeout: 5 }), watch.end({ timeout: 5 })]);
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
    if (!first) throw new Error("the first tick was refused, on a step open to marks");
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

// ── the locks (the reviewers' races) ─────────────────────────────────────────
//
// Each race is made deterministic by holding one side's transaction open as
// the OWNER, starting the other side, waiting until the database says that side
// is parked on a lock, and only then committing. So what these prove is the
// ORDER the database imposes, not a timing that happened to work.

/** Resolve once an application connection is waiting on a lock: the other half
 *  of a race is parked behind the transaction the test is holding open. */
async function someoneWaits(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const [row] = await watch<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND usename = 'bib_app' AND wait_event_type = 'Lock'
    `;
    if ((row?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("nothing ever waited: the write under test did not take the lock the other side holds");
}

/** Hold `hold` open as the owner while `meanwhile` runs, commit once it is
 *  parked, and hand back what it answered (or threw). */
async function whileHeld<T>(
  hold: (tx: postgres.TransactionSql) => Promise<unknown>,
  meanwhile: () => Promise<T>,
): Promise<T> {
  let settled: Promise<{ ok: true; value: T } | { ok: false; error: unknown }> | null = null;
  await owner.begin(async (tx) => {
    await hold(tx);
    settled = meanwhile().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await someoneWaits();
  });
  if (settled === null) throw new Error("the other side never started");
  const out = await (settled as Promise<{ ok: true; value: T } | { ok: false; error: unknown }>);
  if (!out.ok) throw out.error;
  return out.value;
}

const markOf = (over: { step: string; approval?: string | null; key: string; by?: string }) => ({
  id: ref(),
  tenantId: f.tenant,
  jobStepId: over.step,
  stepApprovalId: over.approval ?? null,
  list: over.approval ? ("review" as const) : ("checklist" as const),
  itemKey: over.key,
  label: "Bank statements",
  outcome: "done" as const,
  note: null,
  markedByUserId: over.by ?? f.priya,
  markedAt: "2026-09-26T09:00:00.000Z",
});

async function newApproval(step: string): Promise<string> {
  const id = ref();
  await owner`INSERT INTO delivery.step_approval (id, tenant_id, job_id, job_step_id) VALUES (${id}, ${f.tenant}, ${f.job}, ${step})`;
  return id;
}

describe("a mark is written only while its list is open, under a row lock", () => {
  it("answers both of two first ticks of one line at once, and leaves one row", async () => {
    // The reviewer's probe: before the second statement, one of every such
    // pair came back a 500 ("neither written nor found").
    const step = await newStep(f.tenant, f.job, null);
    for (let i = 0; i < 20; i++) {
      const key = `pair-${String(i)}`;
      const both = await Promise.allSettled([
        repo.upsert(markOf({ step, key })),
        repo.upsert(markOf({ step, key, by: f.anand })),
      ]);
      expect(both.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      for (const r of both) if (r.status === "fulfilled") expect(r.value?.outcome).toBe("done");
    }
    const [rows] = await owner<{ n: number }[]>`
      SELECT count(*)::int AS n FROM delivery.job_step_check WHERE job_step_id = ${step}
    `;
    expect(rows?.n).toBe(20);
  });

  it("answers a first tick that met another request's uncommitted tick of the same line with that row", async () => {
    // Deterministic form of the same race: the other request (here an insert
    // that went round the adapter) has written the line and not committed, so
    // the upsert waits on it, and then finds it by a statement of its own.
    const step = await newStep(f.tenant, f.job, null);
    const kept = await whileHeld(
      (tx) => tx`
        INSERT INTO delivery.job_step_check
          (tenant_id, job_step_id, list, item_key, label, outcome, marked_by_user_id, marked_at)
        VALUES (${f.tenant}, ${step}, 'checklist', 'held', 'Bank statements', 'done', ${f.priya}, now())
      `,
      () => repo.upsert(markOf({ step, key: "held", by: f.anand })),
    );
    expect(kept).toMatchObject({ itemKey: "held", outcome: "done", markedByUserId: f.priya });
  });

  it("makes a tick wait for Done, and refuses it once the step is done", async () => {
    const step = await newStep(f.tenant, f.job, null);
    const answer = await whileHeld(
      async (tx) => {
        await tx`SELECT id FROM delivery.job_step WHERE id = ${step} FOR NO KEY UPDATE`;
        await tx`UPDATE delivery.job_step SET status = 'done', finished_at = now(), performed_by = ${f.priya} WHERE id = ${step}`;
      },
      () => repo.upsert(markOf({ step, key: "late" })),
    );
    expect(answer).toBeNull();
    expect(await repo.clear({ tenantId: f.tenant, list: "checklist", jobStepId: step, stepApprovalId: null, itemKey: "late" })).toBe(false);
    const rows = await owner`SELECT 1 FROM delivery.job_step_check WHERE job_step_id = ${step}`;
    expect(rows).toHaveLength(0);
  });

  it("refuses a sub-step mark while the step waits to be checked, and takes one again after a send-back", async () => {
    const step = await newStep(f.tenant, f.job, f.priya);
    await expect(repo.upsert(markOf({ step, key: "s1" }))).resolves.toMatchObject({ outcome: "done" });
    const approval = await newApproval(step);
    expect(await repo.upsert(markOf({ step, key: "s2" }))).toBeNull();
    expect(await repo.clear({ tenantId: f.tenant, list: "checklist", jobStepId: step, stepApprovalId: null, itemKey: "s1" })).toBe(false);
    await owner`
      UPDATE delivery.step_approval
         SET decision = 'rejected', decided_by = ${f.anand}, decided_at = now(), notes = 'does not tie'
       WHERE id = ${approval}
    `;
    await expect(repo.upsert(markOf({ step, key: "s2" }))).resolves.toMatchObject({ outcome: "done" });
    expect(await repo.clear({ tenantId: f.tenant, list: "checklist", jobStepId: step, stepApprovalId: null, itemKey: "s1" })).toBe(true);
  });

  it("refuses a review mark on a check that is decided", async () => {
    const step = await newStep(f.tenant, f.job, f.priya);
    const approval = await newApproval(step);
    await expect(repo.upsert(markOf({ step, approval, key: "r1", by: f.anand }))).resolves.toMatchObject({ list: "review" });
    await owner`
      UPDATE delivery.step_approval
         SET decision = 'approved', decided_by = ${f.anand}, decided_at = now()
       WHERE id = ${approval}
    `;
    expect(await repo.upsert(markOf({ step, approval, key: "r2", by: f.anand }))).toBeNull();
    expect(await repo.clear({ tenantId: f.tenant, list: "review", jobStepId: step, stepApprovalId: approval, itemKey: "r1" })).toBe(false);
    const [r1] = await repo.listForApprovals(f.tenant, [approval]);
    expect(r1?.outcome).toBe("done");
  });
});

describe("a move that reads a list reads it after taking the lock", () => {
  /** A tick taken back by another request that holds the step's lock, the way
   *  the adapter's clear does, and has not committed. */
  const untickHolding = (step: string, key: string) => async (tx: postgres.TransactionSql) => {
    await tx`SELECT id FROM delivery.job_step WHERE id = ${step} FOR NO KEY UPDATE`;
    await tx`
      UPDATE delivery.job_step_check SET outcome = NULL, note = NULL, marked_by_user_id = NULL, marked_at = NULL
      WHERE list = 'checklist' AND job_step_id = ${step} AND item_key = ${key}
    `;
  };

  it("keeps Done waiting for a tick being taken back, and then refuses to finish the step", async () => {
    const step = await newStep(f.tenant, f.job, null);
    await repo.upsert(markOf({ step, key: "s1" }));
    const moved = await whileHeld(untickHolding(step, "s1"), () =>
      steps.transition(f.tenant, step, "blocked", { status: "done", at: new Date().toISOString(), performedBy: f.priya }, ["s1"]),
    );
    expect(moved).toBeNull();
    const [row] = await owner<{ status: string }[]>`SELECT status FROM delivery.job_step WHERE id = ${step}`;
    expect(row?.status).toBe("blocked");
  });

  it("keeps a check from opening while a tick is being taken back, and then opens none", async () => {
    const step = await newStep(f.tenant, f.job, f.priya);
    await repo.upsert(markOf({ step, key: "s1" }));
    const opened = await whileHeld(untickHolding(step, "s1"), () =>
      approvals.openIfAbsent(
        { id: ref(), tenantId: f.tenant, jobId: f.job, jobStepId: step, policyVersionId: null, policyKey: "manager_review" },
        ["s1"],
      ),
    );
    expect(opened).toBeNull();
    const rows = await owner`SELECT 1 FROM delivery.step_approval WHERE job_step_id = ${step}`;
    expect(rows).toHaveLength(0);
  });

  it("keeps Approve waiting for a point being taken back, and then decides nothing", async () => {
    const step = await newStep(f.tenant, f.job, f.priya);
    const approval = await newApproval(step);
    await repo.upsert(markOf({ step, approval, key: "r1", by: f.anand }));
    const decided = await whileHeld(
      async (tx) => {
        await tx`SELECT id FROM delivery.step_approval WHERE id = ${approval} FOR NO KEY UPDATE`;
        await tx`
          UPDATE delivery.job_step_check SET outcome = NULL, note = NULL, marked_by_user_id = NULL, marked_at = NULL
          WHERE list = 'review' AND step_approval_id = ${approval} AND item_key = 'r1'
        `;
      },
      () =>
        approvals.decide(
          f.tenant,
          approval,
          { decision: "approved", notes: null, decidedBy: f.anand, decidedAt: new Date().toISOString() },
          { reviewPointKeys: ["r1"], subStepKeys: [] },
        ),
    );
    expect(decided).toBeNull();
    const [row] = await owner<{ decision: string }[]>`SELECT decision FROM delivery.step_approval WHERE id = ${approval}`;
    expect(row?.decision).toBe("pending");
  });

  it("makes every guarded move once the lines are settled, empty key lists included", async () => {
    const step = await newStep(f.tenant, f.job, f.priya);
    await repo.upsert(markOf({ step, key: "s1" }));
    const approval = await approvals.openIfAbsent(
      { id: ref(), tenantId: f.tenant, jobId: f.job, jobStepId: step, policyVersionId: null, policyKey: "manager_review" },
      ["s1"],
    );
    if (!approval) throw new Error("the check did not open over a settled list");
    await repo.upsert(markOf({ step, approval: approval.id, key: "r1", by: f.anand }));
    const decided = await approvals.decide(
      f.tenant,
      approval.id,
      { decision: "approved", notes: null, decidedBy: f.anand, decidedAt: new Date().toISOString() },
      { reviewPointKeys: ["r1"], subStepKeys: ["s1"] },
    );
    expect(decided?.decision).toBe("approved");
    const done = await steps.transition(
      f.tenant, step, "blocked", { status: "done", at: new Date().toISOString(), performedBy: f.priya }, ["s1"],
    );
    expect(done?.status).toBe("done");
    // A guard over no review points still locks and decides: the empty array
    // reaches the database as an empty array.
    const other = await newStep(f.tenant, f.job, f.priya);
    const second = await newApproval(other);
    await expect(
      approvals.decide(
        f.tenant, second,
        { decision: "approved", notes: null, decidedBy: f.anand, decidedAt: new Date().toISOString() },
        { reviewPointKeys: [], subStepKeys: ["never-marked"] },
      ),
    ).resolves.toBeNull();
  });
});

// ── 0308: "blank" is whitespace, the service's own definition ────────────────

describe("0308: a reason or a label of only whitespace is blank, whatever the whitespace", () => {
  const nbsp = String.fromCharCode(0xa0);

  it("refuses a reason of a newline and a tab, or of no-break spaces, and a label of a tab", async () => {
    await expect(mark({ outcome: "not_applicable", note: "\n\t" })).rejects.toThrow(/job_step_check_not_applicable_says_why/);
    await expect(mark({ outcome: "not_applicable", note: nbsp + nbsp })).rejects.toThrow(/job_step_check_not_applicable_says_why/);
    await expect(mark({ label: "\t" })).rejects.toThrow(/job_step_check_label_is_text/);
    await expect(mark({ outcome: "not_applicable", note: `${nbsp}Not this month${nbsp}` })).resolves.toBeTruthy();
  });

  it("agrees with String.prototype.trim, code point by code point", async () => {
    // Every character trim() strips, and the nearest ones it does not
    // (next line, zero-width space, the word joiner): the CHECK must refuse a
    // reason made of exactly the first set and accept one of the second.
    const points = [
      0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
      0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
      0x85, 0x200b, 0x2060, 0x61,
    ];
    for (const cp of points) {
      const note = String.fromCodePoint(cp);
      const blankToJs = note.trim() === "";
      const accepted = await mark({ outcome: "not_applicable", note }).then(
        () => true,
        () => false,
      );
      expect({ cp: cp.toString(16), accepted }).toEqual({ cp: cp.toString(16), accepted: !blankToJs });
    }
  });

  it("runs both ways, inside a transaction that is rolled back", async () => {
    const dir = join(process.cwd(), "migrations");
    const down = await readFile(join(dir, "0308_job_step_check_blank_is_whitespace.down.sql"), "utf8");
    const up = await readFile(join(dir, "0308_job_step_check_blank_is_whitespace.up.sql"), "utf8");
    const ROLLBACK = new Error("roll back the round trip");
    const seen: string[] = [];
    const def = (tx: postgres.TransactionSql) => tx<{ d: string }[]>`
      SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'job_step_check_not_applicable_says_why'
    `;
    await owner
      .begin(async (tx) => {
        await tx.unsafe(down);
        await tx.unsafe(down);
        seen.push((await def(tx))[0]?.d ?? "");
        await tx.unsafe(up);
        seen.push((await def(tx))[0]?.d ?? "");
        throw ROLLBACK;
      })
      .catch((e: unknown) => {
        if (e !== ROLLBACK) throw e;
      });
    expect(seen[0]).toMatch(/btrim/);
    expect(seen[1]).not.toMatch(/btrim/);
    expect(seen[1]).toMatch(/~/);
  });
});
