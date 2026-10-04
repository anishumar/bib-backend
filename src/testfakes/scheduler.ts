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
import type { WorkSplitAxis } from "../domain/serviceaxis/model";
import type {
  Activation,
  ActivationFeed,
  CompliancePolicySource,
  JobDetail,
  JobQueue,
  JobRepository,
  NewJob,
  QueueHandler,
  RecurringEngagement,
  RecurringEngagementFeed,
  SpawnPeriod,
  TenantDirectory,
  WorkItemSpawner,
  WorkSplitSource,
} from "../usecase/scheduler/ports";

/** One row of the link table, reproduced (0046, 0300). */
export interface FakeLink {
  readonly tenantId: string;
  readonly jobId: string;
  readonly engagementId: string;
  /** Null on a one-time engagement's link, the period's first day on a
   *  period job's — and part of the key either way. */
  readonly periodStart: string | null;
}

/** ASCII unit separator — the same choice the service makes for its keys, and
 *  for the same reason: no uuid or ISO date contains one. */
const SEP = "";

export class FakeJobRepo implements JobRepository {
  readonly rows: Job[] = [];
  /**
   * The link table, reproduced: keyed on (tenant, engagement, period) with a
   * null period as ONE value — `NULLS NOT DISTINCT`, in a Map. Its whole
   * content is the constraint it enforces: one job per engagement per period,
   * and one job per engagement, ever, when there is no period.
   */
  readonly links = new Map<string, FakeLink>();

  private linkKey(tenantId: string, engagementId: string, periodStart: string | null): string {
    return [tenantId, engagementId, periodStart ?? ""].join(SEP);
  }

  createIfAbsent(job: NewJob): Promise<{ job: Job; created: boolean }> {
    // The PARTIAL unique key, reproduced (0046): (tenant, kind, ref) among jobs
    // that are still OPEN. Not the id, because the id is derived for one kind
    // and random for the others, and a caller that minted it differently must
    // STILL lose. Not every row, because a group whose job finished may legally
    // get another one — a fake that refused that would make the case
    // untestable and the case is real.
    const existing = this.rows.find(
      (r) =>
        r.tenantId === job.tenantId &&
        r.sourceKind === job.sourceKind &&
        r.sourceRef === job.sourceRef &&
        r.status !== "done" &&
        r.status !== "cancelled",
    );
    if (existing) return Promise.resolve({ job: existing, created: false });

    // The two CHECKs in 0300, reproduced as a throw: a period job without its
    // period, or a period on any other kind, is a row the database refuses.
    const periodStart = job.periodStart ?? null;
    const periodEnd = job.periodEnd ?? null;
    const periodLabel = job.periodLabel ?? null;
    const hasPeriod = periodStart !== null;
    if (hasPeriod !== (job.sourceKind === "engagement_period")) {
      throw new Error("fake job store: the kind and the period disagree (job_period_matches_kind)");
    }
    if (hasPeriod && (periodEnd === null || periodLabel === null)) {
      throw new Error("fake job store: a period is all three facts or none (job_period_is_whole)");
    }

    const row: Job = {
      id: job.id,
      tenantId: job.tenantId,
      sourceKind: job.sourceKind,
      sourceRef: job.sourceRef,
      status: "pending",
      templateVersionId: null,
      splitAxis: job.splitAxis,
      splitCode: job.splitCode,
      runnableAt: job.runnableAt,
      startedAt: null,
      finishedAt: null,
      periodStart,
      periodEnd,
      periodLabel,
    };
    this.rows.push(row);
    return Promise.resolve({ job: row, created: true });
  }

  /** `UNIQUE NULLS NOT DISTINCT (tenant_id, engagement_id, period_start)`,
   *  reproduced — and it is ABSOLUTE, not scoped to open jobs. One engagement's
   *  work for one period exists in exactly one job, forever; with no period,
   *  one job forever. Returns only what this call actually linked, as the
   *  adapter does, because the caller records an event on that and nothing
   *  else. */
  linkEngagements(
    tenantId: string,
    jobId: string,
    engagementIds: readonly string[],
    periodStart: string | null = null,
  ): Promise<readonly string[]> {
    const linked: string[] = [];
    for (const id of engagementIds) {
      const key = this.linkKey(tenantId, id, periodStart);
      if (this.links.has(key)) continue;
      this.links.set(key, { tenantId, jobId, engagementId: id, periodStart });
      linked.push(id);
    }
    return Promise.resolve(linked);
  }

  /** Every link row for one firm's engagement, in insertion order. What a
   *  test asks when it wants "which jobs is this engagement in". */
  linksFor(tenantId: string, engagementId: string): readonly FakeLink[] {
    return [...this.links.values()].filter(
      (l) => l.tenantId === tenantId && l.engagementId === engagementId,
    );
  }

  /** The read model, from whatever the test put in `serviceNames`. Deliberately
   *  thin: the join is the adapter's business, and an integration test is what
   *  proves it. What this must reproduce is the SHAPE — one entry per job, its
   *  services in link order — because that is what the handler maps. */
  serviceNames = new Map<string, string>();
  entityNames = new Map<string, string>();
  clientNames = new Map<string, string>();

  describeJobs(
    tenantId: string,
    jobIds: readonly string[],
  ): Promise<ReadonlyMap<string, JobDetail>> {
    const out = new Map<string, JobDetail>();
    for (const jobId of jobIds) {
      const services: { engagementId: string; serviceName: string }[] = [];
      let entityName: string | null = null;
      let clientName: string | null = null;
      for (const link of this.links.values()) {
        if (link.tenantId !== tenantId || link.jobId !== jobId) continue;
        services.push({
          engagementId: link.engagementId,
          serviceName: this.serviceNames.get(link.engagementId) ?? "(unnamed service)",
        });
        entityName ??= this.entityNames.get(link.engagementId) ?? null;
        clientName ??= this.clientNames.get(link.engagementId) ?? null;
      }
      if (services.length > 0) {
        out.set(jobId, {
          entityName,
          clientName,
          // The ids and the due day are the adapter's joins; the fake answers
          // what a test put in these maps, and null otherwise.
          entityPartyId: this.entityPartyIds.get(jobId) ?? null,
          clientPartyId: this.clientPartyIds.get(jobId) ?? null,
          periodLabel: this.rows.find((j) => j.id === jobId)?.periodLabel ?? null,
          dueOn: this.dueOns.get(jobId) ?? null,
          filingDueOn: this.filingDueOns.get(jobId) ?? null,
          services,
        });
      }
    }
    return Promise.resolve(out);
  }
  entityPartyIds = new Map<string, string>();
  clientPartyIds = new Map<string, string>();
  dueOns = new Map<string, string>();
  filingDueOns = new Map<string, string>();

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

  /** The board's read (T6.13): the same statuses, no clock, so an upcoming
   *  period job is in it and a finished one is not. */
  listOpen(tenantId: string, limit: number): Promise<readonly Job[]> {
    const rows = this.rows
      .filter(
        (r) =>
          r.tenantId === tenantId &&
          (r.status === "pending" || r.status === "running" || r.status === "blocked"),
      )
      .sort((a, b) => a.runnableAt.localeCompare(b.runnableAt) || a.id.localeCompare(b.id))
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

  cancel(tenantId: string, jobId: string, at: string): Promise<Job | null> {
    const index = this.rows.findIndex((r) => r.tenantId === tenantId && r.id === jobId);
    const current = this.rows[index];
    // The adapter's guard: only an open job moves.
    if (!current || current.status === "done" || current.status === "cancelled") {
      return Promise.resolve(null);
    }
    const next: Job = { ...current, status: "cancelled", startedAt: current.startedAt ?? at, finishedAt: at };
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
    // Over the LINK table, matching the adapter (0046). A merged job's
    // `sourceRef` is a derived group key naming no engagement, so the old test
    // — against `sourceRef` — would report every merged engagement as unspawned
    // and the sweep would build it a second checklist on the very next pass.
    const spawned = new Set(
      [...(this.jobs?.links.values() ?? [])]
        .filter((l) => l.tenantId === tenantId)
        .map((l) => l.engagementId),
    );
    return Promise.resolve(
      all
        .filter((a) => !spawned.has(a.engagementId))
        .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
        .slice(0, limit),
    );
  }
}

/**
 * The recurring-engagement read (T6.13), as a list a test writes to.
 *
 * `linkedPeriods` is DERIVED from the same job store the service writes to,
 * exactly as the adapter aggregates it from the link table — so "a second
 * sweep spawns nothing" is measuring the feed and the store together, which is
 * the property, rather than a list the test happened to fill in.
 */
export class FakeRecurringFeed implements RecurringEngagementFeed {
  readonly byTenant = new Map<string, Omit<RecurringEngagement, "linkedPeriods">[]>();
  jobs: FakeJobRepo | null = null;
  /** Engagement id -> the year start pinned on it (0337), as the adapter's
   *  `crm.engagement.year_start_month`: written once, never moved. */
  readonly pins = new Map<string, number>();

  pinYearStarts(_tenantId: string, pins: readonly { engagementId: string; month: number }[]): Promise<void> {
    for (const p of pins) if (!this.pins.has(p.engagementId)) this.pins.set(p.engagementId, p.month);
    return Promise.resolve();
  }

  add(tenantId: string, row: Omit<RecurringEngagement, "linkedPeriods">): void {
    const list = this.byTenant.get(tenantId) ?? [];
    list.push(row);
    this.byTenant.set(tenantId, list);
  }

  activeRecurring(tenantId: string, limit: number): Promise<readonly RecurringEngagement[]> {
    const rows = (this.byTenant.get(tenantId) ?? [])
      .slice()
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
      .slice(0, limit)
      .map((r) => ({
        ...r,
        yearStartMonth: r.yearStartMonth ?? this.pins.get(r.engagementId) ?? null,
        linkedPeriods: (this.jobs?.linksFor(tenantId, r.engagementId) ?? [])
          .map((l) => l.periodStart)
          .filter((p): p is string => p !== null),
      }));
    return Promise.resolve(rows);
  }
}

/** The two compliance-policy facts, settable by a test. Both null by default,
 *  which is what an unpublished policy means: no floor, and no financial year
 *  — so a quarterly service produces nothing until a test says otherwise. */
export class FakeCompliancePolicy implements CompliancePolicySource {
  floor: string | null = null;
  fiscalYear: number | null = null;

  missedFromOn(_tenantId: string): Promise<string | null> {
    return Promise.resolve(this.floor);
  }

  fiscalYearStartMonth(_tenantId: string): Promise<number | null> {
    return Promise.resolve(this.fiscalYear);
  }
}

/** The firm's `work_split_axis`, as a value a test sets directly. Defaults to
 *  `none`, which is the product's default and the behaviour every test written
 *  before T2.7's merge is asserting against. */
export class FakeWorkSplit implements WorkSplitSource {
  constructor(public axis: WorkSplitAxis = "none") {}
  read(): Promise<WorkSplitAxis> {
    return Promise.resolve(this.axis);
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

/**
 * The work-item seam (T3.1), recorded rather than performed.
 *
 * The scheduler's job here is to hand over the engagements it just linked; what
 * the work-item service does with them is `tests/workitem/`'s business. So this
 * records the calls and asserts nothing — but it records them PER JOB, because
 * the thing worth testing on this side is that a second sweep hands over
 * NOTHING, which is the same at-least-once property the job table has. The
 * period is recorded too (T6.13): that a month's task was asked for WITH its
 * month is the one thing the scheduler owes the work-item side.
 */
export class FakeWorkItemSpawner implements WorkItemSpawner {
  readonly calls: {
    readonly tenantId: string;
    readonly jobId: string;
    readonly engagementIds: readonly string[];
    readonly period: SpawnPeriod | null;
  }[] = [];

  spawnForEngagements(
    tenantId: string,
    jobId: string,
    engagementIds: readonly string[],
    _actor: unknown,
    period?: SpawnPeriod,
  ): Promise<number> {
    this.calls.push({ tenantId, jobId, engagementIds: [...engagementIds], period: period ?? null });
    return Promise.resolve(engagementIds.length);
  }

  /** Every engagement handed over across every call, flattened — what a test
   *  asserts on when it wants "and nothing was handed over twice". */
  get handedOver(): readonly string[] {
    return this.calls.flatMap((c) => c.engagementIds);
  }
}
