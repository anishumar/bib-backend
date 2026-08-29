// The job table, proven where its claims have to hold: the database (T2.6).
//
// The service's own tests use a fake that reproduces the unique key, and a fake
// agrees with the service by construction. These are the properties no fake can
// establish:
//
//   1. RLS isolates a firm's jobs.
//   2. The UNIQUE key — not the application — refuses a second job for the same
//      cause. This is the load-bearing claim of the whole engine: every trigger
//      is at-least-once, and a second job means a second filing and a second
//      invoice.
//   3. The timestamps CHECK holds against the OWNER role, which is what a
//      migration or a backfill runs as.
//   4. bib_app has no DELETE grant, so "a job is never removed" is enforced
//      rather than remembered.
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
const slugA = `job-test-a-${stamp}`;
const slugB = `job-test-b-${stamp}`;

interface Ids {
  tenantA: string;
  tenantB: string;
  engagementA: string;
  engagementB: string;
}
let ids: Ids;

/**
 * A fresh uuid per call.
 *
 * Deliberately random rather than a fixed constant. The fixtures here are never
 * torn down — `ledger.event` refuses DELETE to every role, so they cannot be —
 * and a hard-coded id would collide with the previous run's row on the primary
 * key, or worse, silently find that run's job and make the anti-join test pass
 * for the wrong reason.
 */
const ref = (): string => randomUUID();

beforeAll(async () => {
  const [a] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${slugA}, 'Job Test A', 'INR') RETURNING id
  `;
  const [b] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${slugB}, 'Job Test B', 'INR') RETURNING id
  `;
  if (!a || !b) throw new Error("could not create the two test firms");
  ids = { tenantA: a.id, tenantB: b.id, engagementA: ref(), engagementB: ref() };
});

afterAll(async () => {
  // Connections only — the fixtures stay, as every other integration test in
  // this repo leaves its own. That is not laziness: this test writes a
  // `contract.activated` event, and `ledger.event` refuses DELETE to EVERY
  // role, the owner included (0003's trigger). A teardown that tried would fail
  // exactly as the ledger is designed to make it fail, and the tenant could not
  // go either while an event still references it.
  //
  // The local database is scaffolding — `npm run migrate` on a fresh one plus
  // `npm run smoke` rebuilds everything these tests need.
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

describe("idempotency, enforced by the key rather than by the caller", () => {
  it("refuses a second job for the same cause, whatever id it carries", async () => {
    // THE test for this table. A redelivered queue message, a re-run sweep and a
    // hand-run script all arrive here, and the second must lose — even when it
    // minted a different uuid, because the key is on the CAUSE and not the id.
    const first = await repo.createIfAbsent({
      id: ref(),
      tenantId: ids.tenantA,
      sourceKind: "engagement",
      sourceRef: ids.engagementA,
      runnableAt: new Date().toISOString(),
      splitAxis: "none" as const,
      splitCode: null,
    });
    const second = await repo.createIfAbsent({
      id: ref(),
      tenantId: ids.tenantA,
      sourceKind: "engagement",
      sourceRef: ids.engagementA,
      runnableAt: new Date().toISOString(),
      splitAxis: "none" as const,
      splitCode: null,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);

    const rows = await asTenant(ids.tenantA, (tx) =>
      tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM delivery.job WHERE source_ref = ${ids.engagementA}
      `,
    );
    expect(rows[0]?.n).toBe("1");
  });

  it("does not touch updated_at on a redelivery", async () => {
    // Why this is ON CONFLICT DO NOTHING plus a read, rather than DO UPDATE:
    // an UPDATE would bump updated_at on every redelivery, so a job spawned once
    // and redelivered fifty times would answer "when did this last change" with
    // "just now", forever.
    const [before] = await asTenant(ids.tenantA, (tx) =>
      tx<{ updated_at: Date }[]>`
        SELECT updated_at FROM delivery.job WHERE source_ref = ${ids.engagementA}
      `,
    );
    await repo.createIfAbsent({
      id: ref(),
      tenantId: ids.tenantA,
      sourceKind: "engagement",
      sourceRef: ids.engagementA,
      runnableAt: new Date().toISOString(),
      splitAxis: "none" as const,
      splitCode: null,
    });
    const [after] = await asTenant(ids.tenantA, (tx) =>
      tx<{ updated_at: Date }[]>`
        SELECT updated_at FROM delivery.job WHERE source_ref = ${ids.engagementA}
      `,
    );
    expect(after?.updated_at.toISOString()).toBe(before?.updated_at.toISOString());
  });

  it("lets two firms each have a job for the same source id", async () => {
    // The unique key is scoped per firm. Two firms cannot share an engagement in
    // practice, but a key that was global would be a tenant leak in constraint
    // form — one firm's insert failing because of a row it cannot see.
    const other = await repo.createIfAbsent({
      id: ref(),
      tenantId: ids.tenantB,
      sourceKind: "engagement",
      sourceRef: ids.engagementA,
      runnableAt: new Date().toISOString(),
      splitAxis: "none" as const,
      splitCode: null,
    });
    expect(other.created).toBe(true);
  });
});

describe("the tenant wall around a job", () => {
  it("shows a firm only its own jobs", async () => {
    const rows = await asTenant(ids.tenantA, (tx) =>
      tx<{ tenant_id: string }[]>`SELECT tenant_id FROM delivery.job`,
    );
    expect(rows.every((r) => r.tenant_id === ids.tenantA)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("refuses to write a job into another firm", async () => {
    await expect(
      asTenant(ids.tenantA, (tx) =>
        tx`
          INSERT INTO delivery.job (tenant_id, source_kind, source_ref)
          VALUES (${ids.tenantB}, 'engagement', ${ref()})
        `,
      ),
    ).rejects.toMatchObject({ code: "42501" }); // insufficient_privilege (WITH CHECK)
  });

  it("finds another firm's job as not-found rather than as forbidden", async () => {
    // The job exists; firm A simply cannot see it. RLS answers zero rows, so
    // "not yours" and "not there" are the same answer to a caller — which is
    // what stops an id being an existence oracle.
    const [theirs] = await asTenant(ids.tenantB, (tx) =>
      tx<{ id: string }[]>`SELECT id FROM delivery.job WHERE tenant_id = ${ids.tenantB} LIMIT 1`,
    );
    if (!theirs) throw new Error("firm B has no job to look for");
    expect(await repo.findById(ids.tenantA, theirs.id)).toBeNull();
  });
});

describe("the constraints hold against the OWNER role too", () => {
  // The role migrations and backfills run as. A rule enforced only in the
  // service is walked past by the next script somebody writes.

  it("refuses a pending job that claims to have started", async () => {
    await expect(
      owner`
        INSERT INTO delivery.job (tenant_id, source_kind, source_ref, status, started_at)
        VALUES (${ids.tenantA}, 'engagement', ${ref()}, 'pending', now())
      `,
    ).rejects.toMatchObject({ code: "23514" }); // check_violation
  });

  it("refuses a finished job with no start time", async () => {
    await expect(
      owner`
        INSERT INTO delivery.job (tenant_id, source_kind, source_ref, status, finished_at)
        VALUES (${ids.tenantA}, 'engagement', ${ref()}, 'done', now())
      `,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses a source kind nobody declared", async () => {
    await expect(
      owner`
        INSERT INTO delivery.job (tenant_id, source_kind, source_ref)
        VALUES (${ids.tenantA}, 'invoice', ${ref()})
      `,
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("a job is never removed", () => {
  it("gives the app no DELETE grant at all", async () => {
    // Cancelling is a STATE. A cancelled job that vanished would take the reason
    // with it, and "why did this work stop" is exactly what gets asked later.
    // Enforced by the grant rather than by every future caller remembering.
    const rows = await owner<{ privilege_type: string }[]>`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = 'delivery' AND table_name = 'job' AND grantee = 'bib_app'
    `;
    expect(rows.map((r) => r.privilege_type).sort()).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });
});

describe("the activation feed reads the ledger and stops when the job exists", () => {
  it("does not offer an activation whose engagement is not there", async () => {
    // CHANGED BY 0046, and deliberately. The anti-join used to be over
    // `job.source_ref` and this fixture's engagement ids are bare uuids with no
    // crm rows behind them, which was fine while the feed read nothing but the
    // ledger.
    //
    // The feed now resolves each activation's letter, entity and service so it
    // can decide which checklist the work belongs on, and `job_engagement`
    // carries a foreign key to `crm.engagement` — so an activation naming a row
    // that is not there could not become a job even if it were offered. It is
    // not offered. Before the link table it produced a phantom job that sat
    // forever unable to resolve its own subject, which was the same fault one
    // step further downstream.
    //
    // The anti-join proper, with real engagements behind it, is
    // `merge.integration.test.ts` — it needs a letter, lines and a published
    // service, which is a fixture this file deliberately does not have.
    await owner`
      INSERT INTO ledger.event (id, tenant_id, actor_type, actor_id, verb, object_type, object_id, payload)
      VALUES (${ref()}, ${ids.tenantA}, 'system', NULL, 'contract.activated', 'engagement', ${ids.engagementB}, '{}'::jsonb)
    `;

    const offered = await repo.unspawnedActivations(ids.tenantA, 10);
    expect(offered.map((a) => a.engagementId)).not.toContain(ids.engagementB);
  });

  it("does not offer another firm's activations", async () => {
    const theirs = await repo.unspawnedActivations(ids.tenantB, 10);
    expect(theirs.map((a) => a.engagementId)).not.toContain(ids.engagementB);
  });
});

describe("what is runnable", () => {
  it("excludes a job whose window has not opened", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const source = ref();
    await repo.createIfAbsent({
      id: ref(),
      tenantId: ids.tenantA,
      sourceKind: "obligation",
      sourceRef: source,
      runnableAt: future,
      splitAxis: "none" as const,
      splitCode: null,
    });
    const runnable = await repo.listRunnable(ids.tenantA, new Date().toISOString(), 50);
    expect(runnable.map((j) => j.sourceRef)).not.toContain(source);

    const later = await repo.listRunnable(ids.tenantA, future, 50);
    expect(later.map((j) => j.sourceRef)).toContain(source);
  });

  it("drops a job once it reaches a terminal state", async () => {
    const [job] = await repo.listRunnable(ids.tenantA, new Date().toISOString(), 1);
    if (!job) throw new Error("nothing runnable to finish");
    const at = new Date().toISOString();
    await repo.updateStatus(ids.tenantA, job.id, "running", at);
    const done = await repo.updateStatus(ids.tenantA, job.id, "done", at);

    expect(done.finishedAt).not.toBeNull();
    const runnable = await repo.listRunnable(ids.tenantA, new Date().toISOString(), 50);
    expect(runnable.map((j) => j.id)).not.toContain(job.id);
  });

  it("keeps the first start time across a block and a resume", async () => {
    // COALESCE, at the database. "How long has this been in flight" means since
    // it FIRST started, not since it last resumed.
    const created = await repo.createIfAbsent({
      id: ref(),
      tenantId: ids.tenantA,
      sourceKind: "obligation",
      sourceRef: ref(),
      runnableAt: new Date().toISOString(),
      splitAxis: "none" as const,
      splitCode: null,
    });
    const started = await repo.updateStatus(
      ids.tenantA,
      created.job.id,
      "running",
      new Date().toISOString(),
    );
    await repo.updateStatus(ids.tenantA, created.job.id, "blocked", new Date().toISOString());
    const resumed = await repo.updateStatus(
      ids.tenantA,
      created.job.id,
      "running",
      new Date(Date.now() + 60_000).toISOString(),
    );
    expect(resumed.startedAt).toBe(started.startedAt);
  });
});
