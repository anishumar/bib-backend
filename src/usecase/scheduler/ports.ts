// The ports the scheduler needs from the world — the seams (T2.6).
//
// The interesting one is `JobQueue`. pg-boss is a real dependency with a real
// API, and none of it appears above this line: the use case knows that work can
// be scheduled on a cadence and handled durably, and nothing about how. That
// matters more here than usual, because a queue is exactly the kind of
// component a product replaces once — Redis, SQS, a table with SKIP LOCKED —
// and the replacement should cost one adapter.
import type { Job, JobSource, JobStatus } from "../../domain/scheduler/model";
import type { WorkSplitAxis } from "../../domain/serviceaxis/model";

export interface NewJob {
  readonly id: string;
  readonly tenantId: string;
  readonly sourceKind: JobSource;
  readonly sourceRef: string;
  /** When the work may begin — the T–X date, as an ISO timestamp. */
  readonly runnableAt: string;
  /** How this job was cut, copied onto the row at spawn (0046). Recorded rather
   *  than derived because the work board renders it, and because a firm
   *  re-filing a service next quarter has not changed why THIS job was cut the
   *  way it was. `none` for every unmerged job. */
  readonly splitAxis: WorkSplitAxis;
  /** The Dept or delivery team this job's work was filed under. Null on `none`,
   *  and null on a firm that DOES split when the service is filed under
   *  nothing — which is a real state and groups together, not dropped. */
  readonly splitCode: string | null;
}

/** One service inside a job, named as the client's own letter names it. */
export interface JobService {
  readonly engagementId: string;
  /**
   * The service name off the PINNED version — what the client actually bought.
   *
   * Pinned rather than live, unlike the grouping facts and the workflow key,
   * and the difference is the same one the whole product turns on: the name is
   * a term of the document, and a service renamed next quarter must not restate
   * what a letter said. The team and the process are ours and read live; the
   * name is theirs and reads frozen.
   */
  readonly serviceName: string;
}

/** What one job is for, in words. See `describeJobs`. */
export interface JobDetail {
  /** Who the work is delivered TO — one legal entity per job, always, because
   *  the group key says so and the firm's Per Company rule requires it. */
  readonly entityName: string | null;
  /** Who is BILLED. Not the same question, and often not the same party. */
  readonly clientName: string | null;
  /** In the order their advances were recorded — the order the client bought
   *  them in, which is the order a merged card should read. */
  readonly services: readonly JobService[];
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

  /**
   * Attach engagements to a job — the merge, written down.
   *
   * Returns the ids it actually linked, so the caller records an event only for
   * work that genuinely joined. An engagement already linked to this job (a
   * redelivered message) and one already linked to ANOTHER job (which should
   * not happen, and which `UNIQUE (tenant_id, engagement_id)` makes impossible
   * rather than unlikely) both come back absent, and both are the right answer:
   * this call did not add that work.
   *
   * Never removes. Unlinking an engagement from the job that delivered it would
   * erase the only record of what that work was.
   */
  linkEngagements(
    tenantId: string,
    jobId: string,
    engagementIds: readonly string[],
  ): Promise<readonly string[]>;

  /**
   * What a set of jobs is FOR, in words — the read model the work board needs.
   *
   * A list endpoint returns names, not ids, and this codebase has learnt that
   * five times (`MemberRecord`, `LeadRecord`, `ProposalRecord`, Party 360). The
   * work board's own comment recorded it as an outstanding gap: it rendered
   * "engagement <uuid>", because a job's cause was an id and nothing else.
   *
   * The merge is what makes it unavoidable rather than merely untidy. A merged
   * job's `sourceRef` names NO row, so a uuid on that card is not even a uuid
   * somebody could look up. And "why are there two FinCompliance cards" is only
   * answerable if each says which services it holds.
   *
   * Takes a set of ids and returns one entry per job, so a list costs ONE query
   * rather than one per row — the lookup-per-row this rule exists to prevent.
   */
  describeJobs(
    tenantId: string,
    jobIds: readonly string[],
  ): Promise<ReadonlyMap<string, JobDetail>>;

  findById(tenantId: string, jobId: string): Promise<Job | null>;
  /** Jobs whose time has come: runnable_at has passed and they can still move. */
  listRunnable(tenantId: string, asOf: string, limit: number): Promise<readonly Job[]>;
  updateStatus(
    tenantId: string,
    jobId: string,
    status: JobStatus,
    at: string,
  ): Promise<Job>;
  /**
   * Record which workflow version this job will walk — ONCE, and never again.
   *
   * The write half of pinning (T2.7), and the guard is the point: the adapter
   * sets `template_version_id` only where it is still null, so a second sweep,
   * a redelivered message or a later edit to the firm's process cannot move a
   * job onto a different path than the one it started down. That is the whole
   * argument for the column existing, and a plain UPDATE would give it away.
   *
   * Returns whether this call was the one that set it.
   */
  pinTemplate(tenantId: string, jobId: string, versionId: string): Promise<boolean>;
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

  // ── The grouping key, carried on the activation (T2.7) ────────────────────
  //
  // Read here rather than looked up per candidate, because grouping compares
  // activations against each other and N round trips inside a sweep would be N
  // chances to read a different state than the first. Same argument
  // `JobSubject` makes for being one query.

  /**
   * The letter this engagement's line belongs to — part of the key, so a job
   * can FINISH.
   *
   * An entity that signs a letter in April and another in July has signed two
   * contracts. Without this, July's work would join April's still-open
   * checklist and one job would grow for the life of the client relationship.
   */
  readonly engagementLetterId: string;
  /**
   * The legal entity the work is delivered to — THE part of the key that is not
   * negotiable.
   *
   * The firm's own rule, confirmed by its owner: Per Company. vCFO for four
   * companies is four engagements because each company files its own returns.
   * Merging across entities would put two companies' filings on one checklist.
   */
  readonly entityPartyId: string;
  /** The live service body's `module` — the Dept. Null when the firm has filed
   *  the service under none, which is a real state and not an error. */
  readonly deptCode: string | null;
  /** The live service body's `group` — the delivery team. Null likewise. */
  readonly teamCode: string | null;
  /**
   * The live service body's `workflowTemplateKey` — part of the key.
   *
   * A template IS "how we do this". Two services naming two processes are two
   * processes by the firm's own account, and forcing them into one checklist
   * would invent an order between them that nobody wrote, over step keys that
   * can collide. Null — no process written — is its own group, and those jobs
   * wait visibly exactly as they do now.
   *
   * LIVE, not the version the client signed, for the reason `JobSubject`
   * already gives at length: a client agreed to the service, not to our
   * internal steps, and pinning belongs one level down where the JOB pins the
   * workflow version.
   */
  readonly workflowKey: string | null;
}

export interface ActivationFeed {
  /** Activations at this firm with no job against them yet, oldest first. */
  unspawnedActivations(tenantId: string, limit: number): Promise<readonly Activation[]>;
}

/**
 * How this firm cuts a client's work up — `tenancy.tenant.work_split_axis`
 * (G2.4), and T2.7 is its first and only reader.
 *
 * Declared here rather than imported from `usecase/serviceaxis`, which owns the
 * same shape for the write side. Two use cases never import each other in this
 * codebase; the port is stated twice in each one's own vocabulary and satisfied
 * ONCE by the adapter, exactly as `AxisDirectory` and `RoleDirectory` are.
 */
export interface WorkSplitSource {
  read(tenantId: string): Promise<WorkSplitAxis>;
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
