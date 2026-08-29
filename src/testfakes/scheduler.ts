// In-memory port fakes for the scheduler (T2.6). `implements` each port, so a
// drift between a fake and the real adapter is a compile error rather than a
// test that passes against a world the product does not have.
//
// The one behaviour these MUST reproduce is idempotency: the job store refuses a
// second row for the same cause exactly as the unique key does. A fake that
// happily inserted twice would let every "a redelivered message does nothing"
// test pass while the property was broken in production — the opposite of what
// the test is for.
import type { Job, JobStatus } from "../domain/scheduler/model";
import type {
  Activation,
  ActivationFeed,
  JobQueue,
  JobRepository,
  NewJob,
  QueueHandler,
  TenantDirectory,
} from "../usecase/scheduler/ports";

export class FakeJobRepo implements JobRepository {
  readonly rows: Job[] = [];

  createIfAbsent(job: NewJob): Promise<{ job: Job; created: boolean }> {
    // The unique key, reproduced. (tenant, kind, ref) — not the id, because the
    // id is derived and a caller that minted it differently must STILL lose.
    const existing = this.rows.find(
      (r) =>
        r.tenantId === job.tenantId &&
        r.sourceKind === job.sourceKind &&
        r.sourceRef === job.sourceRef,
    );
    if (existing) return Promise.resolve({ job: existing, created: false });

    const row: Job = {
      id: job.id,
      tenantId: job.tenantId,
      sourceKind: job.sourceKind,
      sourceRef: job.sourceRef,
      status: "pending",
      templateVersionId: null,
      runnableAt: job.runnableAt,
      startedAt: null,
      finishedAt: null,
    };
    this.rows.push(row);
    return Promise.resolve({ job: row, created: true });
  }

  findById(tenantId: string, jobId: string): Promise<Job | null> {
    return Promise.resolve(
      this.rows.find((r) => r.tenantId === tenantId && r.id === jobId) ?? null,
    );
  }

  listRunnable(tenantId: string, asOf: string, limit: number): Promise<readonly Job[]> {
    const rows = this.rows
      .filter(
        (r) =>
          r.tenantId === tenantId &&
          // `blocked` included, matching the adapter. A blocked job is one
          // waiting on a person, and it must still be swept — see the note on
          // PostgresJobRepository.listRunnable.
          (r.status === "pending" || r.status === "running" || r.status === "blocked") &&
          r.runnableAt <= asOf,
      )
      .sort((a, b) => a.runnableAt.localeCompare(b.runnableAt))
      .slice(0, limit);
    return Promise.resolve(rows);
  }

  /** Pins ONCE, like the adapter: a second call finds a version already there
   *  and reports that it did not set it. A fake that overwrote would make the
   *  race the real guard exists for untestable. */
  pinTemplate(tenantId: string, jobId: string, versionId: string): Promise<boolean> {
    const i = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === jobId);
    const current = this.rows[i];
    if (i < 0 || !current) throw new Error(`job ${jobId} not in the fake`);
    if (current.templateVersionId !== null) return Promise.resolve(false);
    this.rows[i] = { ...current, templateVersionId: versionId };
    return Promise.resolve(true);
  }

  updateStatus(
    tenantId: string,
    jobId: string,
    status: JobStatus,
    at: string,
  ): Promise<Job> {
    const index = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === jobId);
    const current = this.rows[index];
    if (!current) throw new Error(`fake job store: no job ${jobId}`);
    const terminal = status === "done" || status === "cancelled";
    const next: Job = {
      ...current,
      status,
      // COALESCE, reproduced: a job that goes running -> blocked -> running keeps
      // the moment it FIRST started, which is what "how long in flight" means.
      startedAt: status === "pending" ? null : (current.startedAt ?? at),
      finishedAt: terminal ? at : null,
    };
    this.rows[index] = next;
    return Promise.resolve(next);
  }
}

/** The ledger read, as a list a test can write to directly. */
export class FakeActivationFeed implements ActivationFeed {
  /** Keyed by tenant, because the real feed is a tenant-scoped read and a test
   *  that could see across firms would prove nothing about the sweep's loop. */
  readonly byTenant = new Map<string, Activation[]>();
  /** Jobs already spawned, so the fake can reproduce the anti-join. Set by the
   *  test harness to the same store the service writes to. */
  jobs: FakeJobRepo | null = null;

  add(tenantId: string, activation: Activation): void {
    const list = this.byTenant.get(tenantId) ?? [];
    list.push(activation);
    this.byTenant.set(tenantId, list);
  }

  unspawnedActivations(tenantId: string, limit: number): Promise<readonly Activation[]> {
    const all = this.byTenant.get(tenantId) ?? [];
    // The NOT EXISTS half. Without it the fake would hand the same activation
    // back on every sweep and the "second pass does nothing" test would be
    // measuring the job store alone rather than the feed and the store together.
    const spawned = new Set(
      (this.jobs?.rows ?? [])
        .filter((j) => j.tenantId === tenantId && j.sourceKind === "engagement")
        .map((j) => j.sourceRef),
    );
    return Promise.resolve(
      all
        .filter((a) => !spawned.has(a.engagementId))
        .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
        .slice(0, limit),
    );
  }
}

export class FakeTenantDirectory implements TenantDirectory {
  constructor(readonly ids: string[] = []) {}
  activeTenantIds(): Promise<readonly string[]> {
    return Promise.resolve(this.ids);
  }
}

/**
 * A queue that records what was registered and lets a test fire it by hand.
 *
 * Deliberately does NOT simulate cron. A test that waited for a schedule would
 * be testing pg-boss, which has its own tests; what matters here is that the
 * handler is registered under the right name with the right cadence, and that
 * running it twice is safe.
 */
export class FakeJobQueue implements JobQueue {
  readonly handlers = new Map<string, QueueHandler>();
  readonly schedules = new Map<string, string>();
  started = false;
  stoppedWithGraceMs: number | null = null;

  start(): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }

  register(queue: string, handler: QueueHandler): Promise<void> {
    this.handlers.set(queue, handler);
    return Promise.resolve();
  }

  schedule(queue: string, cron: string): Promise<void> {
    // A Map, so registering the same queue twice REPLACES rather than
    // accumulates — the property that stops every deploy doubling the sweep.
    this.schedules.set(queue, cron);
    return Promise.resolve();
  }

  stop(graceMs: number): Promise<void> {
    this.stoppedWithGraceMs = graceMs;
    this.started = false;
    return Promise.resolve();
  }

  /** Fire a registered queue as the scheduler would. */
  async fire(queue: string): Promise<void> {
    const handler = this.handlers.get(queue);
    if (!handler) throw new Error(`fake queue: nothing registered for ${queue}`);
    await handler();
  }
}

