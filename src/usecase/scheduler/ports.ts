// The ports the scheduler needs from the world — the seams (T2.6).
//
// The interesting one is `JobQueue`. pg-boss is a real dependency with a real
// API, and none of it appears above this line: the use case knows that work can
// be scheduled on a cadence and handled durably, and nothing about how. That
// matters more here than usual, because a queue is exactly the kind of
// component a product replaces once — Redis, SQS, a table with SKIP LOCKED —
// and the replacement should cost one adapter.
import type { Job, JobSource, JobStatus } from "../../domain/scheduler/model";

export interface NewJob {
  readonly id: string;
  readonly tenantId: string;
  readonly sourceKind: JobSource;
  readonly sourceRef: string;
  /** When the work may begin — the T–X date, as an ISO timestamp. */
  readonly runnableAt: string;
}

export interface JobRepository {
  /**
   * Create a job, or return the one that already exists for this cause.
   *
   * IDEMPOTENT BY CONTRACT, not by the caller checking first. Every route into
   * this table is at-least-once — pg-boss redelivers on a crash, the sweep
   * re-reads events it has seen, a restart leaves a trigger unacknowledged — and
   * a check-then-insert has a race between the two halves. The unique key does
   * the work; the adapter turns the conflict into the existing row.
   *
   * Returns whether it actually inserted, because the caller records an event
   * only when something happened.
   */
  createIfAbsent(job: NewJob): Promise<{ readonly job: Job; readonly created: boolean }>;
  findById(tenantId: string, jobId: string): Promise<Job | null>;
  /** Jobs whose time has come: runnable_at has passed and they can still move. */
  listRunnable(tenantId: string, asOf: string, limit: number): Promise<readonly Job[]>;
  updateStatus(
    tenantId: string,
    jobId: string,
    status: JobStatus,
    at: string,
  ): Promise<Job>;
}

/**
 * A signed engagement that has been released and has no job yet.
 *
 * The scheduler learns about work through the LEDGER rather than through a call
 * from the engagement module, which is what the board means by "event, not a
 * direct call" (T2.4). Two things follow, and both are the point:
 *
 *   The commercial lane does not know the engine exists. `contract.activated`
 *   is written because a contract activated, not because somebody downstream
 *   wants to hear about it, and T3.5's payments will read the same event
 *   without engagement changing again.
 *
 *   The ledger IS the queue, and it is durable and replayable by construction.
 *   A worker that was down for a day finds every activation still waiting; a
 *   worker that crashed mid-spawn finds the ones it missed and no duplicate of
 *   the ones it made, because the job table's unique key refuses the second.
 */
export interface Activation {
  readonly engagementId: string;
  /** When the contract actually activated — the job's own occurredAt. */
  readonly occurredAt: string;
}

export interface ActivationFeed {
  /** Activations at this firm with no job against them yet, oldest first. */
  unspawnedActivations(tenantId: string, limit: number): Promise<readonly Activation[]>;
}

/**
 * Which firms exist — the sweep's outer loop.
 *
 * A worker has no session and therefore no tenant, but every read below it is
 * tenant-scoped by RLS. So it asks the GLOBAL tenant registry for the list and
 * then does each firm's work under that firm's context. That is the same shape
 * `withIdentity` uses for the org switcher: never a bypass, always a scope
 * chosen deliberately and named.
 */
export interface TenantDirectory {
  activeTenantIds(): Promise<readonly string[]>;
}

/** A handler the queue invokes. Takes nothing: a scheduled sweep decides its own
 *  scope from the clock, and a queue message that carried arguments would be a
 *  second, stale copy of state the database already holds. */
export type QueueHandler = () => Promise<void>;

/**
 * Durable, at-least-once background work.
 *
 * The seam pg-boss sits behind. Stated in our vocabulary and deliberately
 * small — four verbs — because everything else pg-boss offers (priorities,
 * dead-letter queues, singleton keys) is either unused or better expressed as a
 * property of the job table, where it can be queried.
 */
export interface JobQueue {
  /** Bring the queue up. Idempotent; safe on a restart. */
  start(): Promise<void>;
  /** Register a named queue and the handler that drains it. */
  register(queue: string, handler: QueueHandler): Promise<void>;
  /**
   * Run `queue` on a cron cadence.
   *
   * Keyed by the queue NAME, so a restart re-registers the same schedule rather
   * than accumulating a second one — which would double every sweep, quietly,
   * once per deploy.
   */
  schedule(queue: string, cron: string): Promise<void>;
  /** Let work in flight finish, then close. A sweep halfway through a firm must
   *  be allowed to complete, or the next start finds it abandoned. */
  stop(graceMs: number): Promise<void>;
}
