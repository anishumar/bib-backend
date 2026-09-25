// A job's steps, proven where the claims actually have to hold: the database
// (T2.7).
//
// Five properties, and none survives a fake — a fake agrees with the service by
// construction:
//
//   1. RLS isolates one firm's steps from another's.
//   2. `UNIQUE (job_id, step_key)` refuses the second copy of a step, which is
//      what makes the orchestrator's at-least-once step creation safe.
//   3. The timestamp CHECK holds against the OWNER role, which is what a
//      migration or a psql session runs as. `skipped` never having a FINISH
//      time is the interesting one: a skip that wrote one would make "when did
//      this job's work end" answer with the moment somebody skipped something.
//      Since 0304 it may keep the time it OPENED, when it was withdrawn after
//      opening — and the real `transition` keeps it.
//   4. A skip and a failure must carry a reason, and nothing else may.
//   5. The compare-and-set in `transition` really is atomic — two concurrent
//      claims of the same step, and exactly one wins. This is the property that
//      stops two workers both starting the same work, and it cannot be tested
//      anywhere but here.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresJobStepRepository } from "../../src/infrastructure/postgres/job-step-repository";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 2 });
const app = postgres(cfg.db.appUrl, { max: 4 });
const steps = new PostgresJobStepRepository(app);

const stamp = Date.now().toString(36);
const slugA = `step-test-a-${stamp}`;
const slugB = `step-test-b-${stamp}`;

interface Ids {
  tenantA: string;
  tenantB: string;
  jobA: string;
  jobB: string;
}
let ids: Ids;

beforeAll(async () => {
  // Two firms. Isolation you cannot see is isolation you cannot trust.
  const [a] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${slugA}, 'Harbour Point', 'INR') RETURNING id
  `;
  const [b] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${slugB}, 'Northfield Advisory', 'INR') RETURNING id
  `;
  if (!a || !b) throw new Error("could not create the two test firms");

  // A job each. `source_ref` is not a foreign key, so a synthetic uuid is a
  // legitimate cause here — this file is about the STEPS.
  const [ja] = await owner<{ id: string }[]>`
    INSERT INTO delivery.job (tenant_id, source_kind, source_ref)
    VALUES (${a.id}, 'engagement', gen_random_uuid()) RETURNING id
  `;
  const [jb] = await owner<{ id: string }[]>`
    INSERT INTO delivery.job (tenant_id, source_kind, source_ref)
    VALUES (${b.id}, 'engagement', gen_random_uuid()) RETURNING id
  `;
  if (!ja || !jb) throw new Error("could not create the two test jobs");

  ids = { tenantA: a.id, tenantB: b.id, jobA: ja.id, jobB: jb.id };
});

afterAll(async () => {
  // Nothing is deleted, the house pattern: these rows hang off tenants that
  // `ledger.event` may reference, and that table refuses DELETE to the owner
  // role as well as the app one. A run is cheap.
  await Promise.all([owner.end({ timeout: 5 }), app.end({ timeout: 5 })]);
});

async function asTenant<T>(
  tenantId: string,
  run: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return app.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return run(tx);
  }) as Promise<T>;
}

function newStep(tenantId: string, jobId: string, stepKey: string) {
  return {
    id: crypto.randomUUID(),
    tenantId,
    jobId,
    stepKey,
    label: stepKey,
    executor: "human",
    assigneeUserId: null,
  };
}

describe("the tenant wall around a job's steps", () => {
  it("shows a firm only its own", async () => {
    await steps.createAllIfAbsent([newStep(ids.tenantA, ids.jobA, "wall-a")]);
    await steps.createAllIfAbsent([newStep(ids.tenantB, ids.jobB, "wall-b")]);

    const mine = await steps.listForJob(ids.tenantA, ids.jobA);
    expect(mine.map((s) => s.stepKey)).toEqual(["wall-a"]);
  });

  it("hides another firm's job's steps even when the job id is known", async () => {
    const rows = await asTenant(ids.tenantA, (tx) =>
      tx<{ id: string }[]>`SELECT id FROM delivery.job_step WHERE job_id = ${ids.jobB}`,
    );
    expect(rows).toHaveLength(0);
  });

  it("refuses to write a step into another firm's job", async () => {
    await expect(
      asTenant(ids.tenantA, (tx) =>
        tx`
          INSERT INTO delivery.job_step (tenant_id, job_id, step_key, label, executor)
          VALUES (${ids.tenantB}, ${ids.jobB}, 'smuggled', 'Smuggled', 'human')
        `,
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe("a step exists once per job, however many times the engine tries", () => {
  it("creates the whole set the first time and nothing the second", async () => {
    const jobId = ids.jobA;
    const rows = ["idem-1", "idem-2", "idem-3"].map((k) => newStep(ids.tenantA, jobId, k));

    const first = await steps.createAllIfAbsent(rows);
    expect(first.created).toBe(true);

    // A REDELIVERED message: same job, same keys, different ids. The unique key
    // is on (job, step_key), so minting different ids must still lose.
    const second = await steps.createAllIfAbsent(
      ["idem-1", "idem-2", "idem-3"].map((k) => newStep(ids.tenantA, jobId, k)),
    );
    expect(second.created).toBe(false);

    const all = await steps.listForJob(ids.tenantA, jobId);
    expect(all.filter((s) => s.stepKey.startsWith("idem-"))).toHaveLength(3);
  });

  it("refuses a duplicate step key against the OWNER role too", async () => {
    await owner`
      INSERT INTO delivery.job_step (tenant_id, job_id, step_key, label, executor)
      VALUES (${ids.tenantA}, ${ids.jobA}, 'dup', 'Dup', 'human')
    `;
    await expect(
      owner`
        INSERT INTO delivery.job_step (tenant_id, job_id, step_key, label, executor)
        VALUES (${ids.tenantA}, ${ids.jobA}, 'dup', 'Again', 'human')
      `,
    ).rejects.toThrow(/job_step_one_per_key|duplicate key/i);
  });
});

describe("the schema refuses states the orchestrator must never produce", () => {
  it("refuses an executor outside the three", async () => {
    await expect(
      owner`
        INSERT INTO delivery.job_step (tenant_id, job_id, step_key, label, executor)
        VALUES (${ids.tenantA}, ${ids.jobA}, 'bad-exec', 'X', 'robot')
      `,
    ).rejects.toThrow(/job_step_executor_check|check constraint/i);
  });

  it("refuses a finished step with no start time", async () => {
    await expect(
      owner`
        INSERT INTO delivery.job_step
          (tenant_id, job_id, step_key, label, executor, status, finished_at)
        VALUES (${ids.tenantA}, ${ids.jobA}, 'bad-ts', 'X', 'human', 'done', now())
      `,
    ).rejects.toThrow(/timestamps_follow_status/i);
  });

  // A skip never FINISHED. Writing a finish time on one would make "when did
  // this job's work actually end" answer with the moment somebody skipped
  // something. (Since 0304 it may carry a START time: see the transition test.)
  it("refuses a SKIPPED step that carries a finish time", async () => {
    await expect(
      owner`
        INSERT INTO delivery.job_step
          (tenant_id, job_id, step_key, label, executor, status, outcome_note,
           started_at, finished_at)
        VALUES (${ids.tenantA}, ${ids.jobA}, 'bad-skip', 'X', 'human', 'skipped', 'why',
                now(), now())
      `,
    ).rejects.toThrow(/timestamps_follow_status/i);
  });

  it("still refuses a PENDING step that carries a start time", async () => {
    await expect(
      owner`
        INSERT INTO delivery.job_step
          (tenant_id, job_id, step_key, label, executor, status, started_at)
        VALUES (${ids.tenantA}, ${ids.jobA}, 'bad-pending', 'X', 'human', 'pending', now())
      `,
    ).rejects.toThrow(/timestamps_follow_status/i);
  });

  it("refuses a skip with no reason", async () => {
    await expect(
      owner`
        INSERT INTO delivery.job_step (tenant_id, job_id, step_key, label, executor, status)
        VALUES (${ids.tenantA}, ${ids.jobA}, 'noteless', 'X', 'human', 'skipped')
      `,
    ).rejects.toThrow(/note_when_not_done/i);
  });

  it("refuses a reason on a step that is merely blocked", async () => {
    await expect(
      owner`
        INSERT INTO delivery.job_step
          (tenant_id, job_id, step_key, label, executor, status, outcome_note, started_at)
        VALUES (${ids.tenantA}, ${ids.jobA}, 'noted', 'X', 'human', 'blocked', 'why', now())
      `,
    ).rejects.toThrow(/note_when_not_done/i);
  });

  it("refuses a skipped step that names somebody, because nobody performs a skip", async () => {
    const [u] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.user_account (email, display_name)
      VALUES (${`step-test-${stamp}@harbour.example`}, 'Anita Rao') RETURNING id
    `;
    await expect(
      owner`
        INSERT INTO delivery.job_step
          (tenant_id, job_id, step_key, label, executor, status, outcome_note, performed_by)
        VALUES (${ids.tenantA}, ${ids.jobA}, 'skip-actor', 'X', 'human', 'skipped', 'why',
                ${u?.id ?? null})
      `,
    ).rejects.toThrow(/skipped_has_no_performer/i);
  });
});

// THE property that cannot be tested anywhere else. Two workers sweeping the
// same firm will both decide the same step is ready; exactly one may take it.
describe("two workers claiming the same step", () => {
  it("lets exactly one win, and the loser is told rather than overwriting", async () => {
    const key = `race-${stamp}`;
    const created = await steps.createAllIfAbsent([newStep(ids.tenantA, ids.jobA, key)]);
    const step = created.steps[0];
    if (!step) throw new Error("the race step was not created");

    const at = new Date().toISOString();
    const [first, second] = await Promise.all([
      steps.transition(ids.tenantA, step.id, "pending", { status: "running", at }),
      steps.transition(ids.tenantA, step.id, "pending", { status: "running", at }),
    ]);

    const winners = [first, second].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
  });

  it("refuses a transition from a state the step is no longer in", async () => {
    const key = `stale-${stamp}`;
    const created = await steps.createAllIfAbsent([newStep(ids.tenantA, ids.jobA, key)]);
    const step = created.steps[0];
    if (!step) throw new Error("the stale step was not created");

    const at = new Date().toISOString();
    await steps.transition(ids.tenantA, step.id, "pending", { status: "blocked", at });
    // A caller holding a stale read still thinks it is pending.
    const stale = await steps.transition(ids.tenantA, step.id, "pending", {
      status: "running",
      at,
    });
    expect(stale).toBeNull();
  });

  it("keeps the original start time through to completion", async () => {
    const key = `times-${stamp}`;
    const created = await steps.createAllIfAbsent([newStep(ids.tenantA, ids.jobA, key)]);
    const step = created.steps[0];
    if (!step) throw new Error("the timing step was not created");

    const started = "2026-08-29T09:00:00.000Z";
    const finished = "2026-08-29T11:30:00.000Z";
    const running = await steps.transition(ids.tenantA, step.id, "pending", {
      status: "blocked",
      at: started,
    });
    expect(running?.startedAt).toBe(started);

    const done = await steps.transition(ids.tenantA, step.id, "blocked", {
      status: "done",
      at: finished,
    });
    // COALESCE keeps the first start — "how long did this step take" is the
    // question, and overwriting it would make every step look instantaneous.
    expect(done?.startedAt).toBe(started);
    expect(done?.finishedAt).toBe(finished);
  });

  it("keeps the day a step OPENED when it is withdrawn afterwards (0304)", async () => {
    const key = `withdrawn-${stamp}`;
    const created = await steps.createAllIfAbsent([newStep(ids.tenantA, ids.jobA, key)]);
    const step = created.steps[0];
    if (!step) throw new Error("the withdrawn step was not created");

    const opened = "2026-08-29T09:00:00.000Z";
    await steps.transition(ids.tenantA, step.id, "pending", { status: "blocked", at: opened });
    const skipped = await steps.transition(ids.tenantA, step.id, "blocked", {
      status: "skipped",
      at: "2026-09-02T10:00:00.000Z",
      outcomeNote: "This step had already opened and no longer applies.",
    });
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.startedAt).toBe(opened);
    expect(skipped?.finishedAt).toBeNull();
  });

  it("still gives a step skipped BEFORE it opened no start time", async () => {
    const key = `never-${stamp}`;
    const created = await steps.createAllIfAbsent([newStep(ids.tenantA, ids.jobA, key)]);
    const step = created.steps[0];
    if (!step) throw new Error("the never-opened step was not created");

    const skipped = await steps.transition(ids.tenantA, step.id, "pending", {
      status: "skipped",
      at: "2026-09-02T10:00:00.000Z",
      outcomeNote: "recurrence is \"monthly\", and this step applies only when it is \"annually\"",
    });
    expect(skipped?.startedAt).toBeNull();
    expect(skipped?.finishedAt).toBeNull();
  });
});

describe("the config registry accepts the sixth kind", () => {
  it("stores a workflow_template entry", async () => {
    const [entry] = await owner<{ id: string }[]>`
      INSERT INTO config.entry (tenant_id, kind, key)
      VALUES (${ids.tenantA}, 'workflow_template', 'gst-monthly') RETURNING id
    `;
    expect(entry?.id).toBeDefined();
  });

  it("still refuses a kind nothing validates", async () => {
    await expect(
      owner`
        INSERT INTO config.entry (tenant_id, kind, key)
        VALUES (${ids.tenantA}, 'rule_pack', 'gst-in') RETURNING id
      `,
    ).rejects.toThrow(/entry_kind_check|check constraint/i);
  });
});
