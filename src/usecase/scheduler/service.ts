// The scheduler use case (T2.6) — the engine's first moving part.
//
// Two responsibilities, and they are deliberately not the same method:
//
//   SPAWN   turn a thing that happened into a job that is owed. Today the only
//           cause is a released engagement; T3.2's obligations join it.
//   ADVANCE move a job through its lifecycle. T2.7's orchestrator will do the
//           interesting half; this owns the transitions and their guards.
//
// No I/O, no SQL, no pg-boss: everything arrives as an injected port, so the
// whole engine is testable with fakes and a fixed clock, and none of it knows
// what a queue is.
import type { IdGen } from "../../platform/ids";
import type { Clock } from "../../platform/clock";
import type { Actor } from "../../domain/ledger/model";
import { SYSTEM_ACTOR } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import type { Job, JobStatus } from "../../domain/scheduler/model";
import { isTerminal } from "../../domain/scheduler/model";
import { InvalidTransition, JobNotFound } from "../../domain/scheduler/errors";
import type {
  ActivationFeed,
  JobRepository,
  NewJob,
  TenantDirectory,
} from "./ports";

export interface Deps {
  readonly jobs: JobRepository;
  readonly activations: ActivationFeed;
  readonly tenants: TenantDirectory;
  readonly ids: IdGen;
  readonly clock: Clock;
  readonly events: EventSink;
}

/** How many activations one sweep will turn into jobs, per firm. A bound rather
 *  than a limit anybody has hit: a sweep that tried to drain an unbounded
 *  backlog in one transaction is how a worker stops finishing. */
const SPAWN_BATCH = 200;

/** The namespace derived job ids are minted under. A constant, because the id
 *  must be the same on every replay — that is the entire point of it. */
const JOB_NAMESPACE = "6f1d5b0e-7d3a-4a3c-9d1e-2b7a9c4f1e00";

export interface SweepReport {
  readonly tenantId: string;
  readonly spawned: number;
  /** Activations that already had a job — the redelivery case, and the number
   *  that proves idempotency is working rather than merely intended. */
  readonly alreadySpawned: number;
}

export class SchedulerService {
  constructor(private readonly deps: Deps) {}

  /**
   * One pass over every firm: turn released engagements into jobs.
   *
   * The outer loop is the tenant list because a worker has no session, and
   * everything below it is tenant-scoped by RLS. Each firm is independent, so
   * one firm's failure must not stop the others — a single bad row would
   * otherwise silently stop the calendar for every client of every firm.
   */
  async sweepActivations(actor: Actor = SYSTEM_ACTOR): Promise<readonly SweepReport[]> {
    const tenantIds = await this.deps.tenants.activeTenantIds();
    const reports: SweepReport[] = [];
    for (const tenantId of tenantIds) {
      reports.push(await this.spawnForTenant(tenantId, actor));
    }
    return reports;
  }

  /**
   * Turn one firm's unspawned activations into jobs.
   *
   * Idempotent all the way down, and that is structural rather than careful:
   * the job id is DERIVED from the engagement id, so a replay mints the same
   * id; the unique key on (tenant, kind, ref) refuses the second insert; and
   * the event is recorded only when a row was actually created. A worker that
   * crashes between the insert and the event will, on the next pass, find the
   * job present and record nothing — one job, one event, whatever happened.
   */
  async spawnForTenant(tenantId: string, actor: Actor = SYSTEM_ACTOR): Promise<SweepReport> {
    const pending = await this.deps.activations.unspawnedActivations(tenantId, SPAWN_BATCH);
    let spawned = 0;
    let alreadySpawned = 0;

    for (const activation of pending) {
      const job: NewJob = {
        id: this.deps.ids.derivedId(JOB_NAMESPACE, activation.engagementId),
        tenantId,
        sourceKind: "engagement",
        sourceRef: activation.engagementId,
        // Work agreed and paid for may begin now. An engagement carries no lead
        // time of its own — the client is waiting — unlike an obligation, whose
        // whole point is to become runnable T–X before a statutory date.
        runnableAt: this.deps.clock.now().toISOString(),
      };
      const result = await this.deps.jobs.createIfAbsent(job);
      if (!result.created) {
        alreadySpawned += 1;
        continue;
      }
      spawned += 1;
      await this.deps.events.recordEvent({
        tenantId,
        verb: "job.spawned",
        objectId: result.job.id,
        actor,
        // Ids and machine facts. `occurredAt` of the activation rather than of
        // this sweep: the fact is when the contract became active, not when a
        // cron happened to notice.
        payload: {
          sourceKind: "engagement",
          sourceRef: activation.engagementId,
          activatedAt: activation.occurredAt,
        },
      });
    }
    return { tenantId, spawned, alreadySpawned };
  }

  /** What this firm has that is ready to run. T2.7's orchestrator asks this. */
  async runnableJobs(tenantId: string, limit = 100): Promise<readonly Job[]> {
    return this.deps.jobs.listRunnable(tenantId, this.deps.clock.now().toISOString(), limit);
  }

  async getJob(tenantId: string, jobId: string): Promise<Job> {
    const job = await this.deps.jobs.findById(tenantId, jobId);
    if (!job) throw new JobNotFound(jobId);
    return job;
  }

  /**
   * Move a job to a new status.
   *
   * The guard is the reason this is a method rather than a repository call.
   * Every trigger into this engine is at-least-once, so a redelivered message
   * WILL arrive for a job that has already finished — and restarting finished
   * work is not a harmless retry, it is a second filing, a second task on
   * somebody's desk, and eventually a second invoice. Terminal is final;
   * anything that must happen again is a new job with its own cause.
   *
   * Idempotent on the status it already holds: the same message twice records
   * one event, because the second time nothing changed.
   */
  async transition(
    tenantId: string,
    jobId: string,
    status: JobStatus,
    actor: Actor = SYSTEM_ACTOR,
  ): Promise<Job> {
    const job = await this.getJob(tenantId, jobId);
    if (job.status === status) return job;
    if (isTerminal(job.status)) throw new InvalidTransition(job.status, status);

    const at = this.deps.clock.now().toISOString();
    const updated = await this.deps.jobs.updateStatus(tenantId, job.id, status, at);
    await this.deps.events.recordEvent({
      tenantId,
      verb: isTerminal(status) ? "job.completed" : "job.step_advanced",
      objectId: job.id,
      actor,
      payload: { from: job.status, to: status, sourceRef: job.sourceRef },
    });
    return updated;
  }
}
