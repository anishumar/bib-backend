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
import type { Actor } from "../../domain/ledger/model";

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
  /**
   * The period an `engagement_period` job is for (T6.13, 0300) — all three
   * set on that kind, and absent or null on every other, which every caller
   * written before this task already is. The database CHECKs the agreement so
   * a caller cannot half-state it.
   */
  readonly periodStart?: string | null;
  readonly periodEnd?: string | null;
  readonly periodLabel?: string | null;
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
   *
   * `periodStart` is the period an `engagement_period` job is for, and null —
   * the default — for every other kind (0300). It is part of the link's key:
   * one engagement, one job PER PERIOD, and `NULLS NOT DISTINCT` keeps the
   * old absolute rule for every one-time engagement.
   */
  linkEngagements(
    tenantId: string,
    jobId: string,
    engagementIds: readonly string[],
    periodStart?: string | null,
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
  /**
   * Every job that has not finished, soonest window first — the work BOARD's
   * read (T6.13), as opposed to the orchestrator's.
   *
   * The two used to be one query. A per-period job is created the day its
   * period begins and opens the day after it ends, so for a whole month the
   * board must show it as UPCOMING — the firm plans capacity from that row —
   * while the orchestrator must not touch it. `listRunnable` is what the
   * engine walks; this is what a person sees.
   */
  listOpen(tenantId: string, limit: number): Promise<readonly Job[]>;
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

/**
 * Turning an engagement into work on somebody's DESK (T3.1).
 *
 * The scheduler creates the JOB — how the work gets done, which template it
 * walks. It does not know what an assignee, a due date or a priority is, and it
 * should not: those belong to the work item, whose whole reason for existing is
 * that ad hoc work has them too and has no job at all.
 *
 * So this is a seam and not a call into another service. Declared here in the
 * scheduler's own vocabulary, satisfied by `WorkItemService.spawnForEngagements`
 * in the composition root — two use cases never import each other in this
 * codebase.
 *
 * It rides on the spawn rather than running on its own timer because the two
 * are ONE fact: work became owed. Two sweeps would mean a job with no tasks on
 * it for as long as the second was behind, which is a work board that says a
 * client is being looked after when nobody has it.
 *
 * IDEMPOTENT, and the caller relies on it: every path into the sweep is
 * at-least-once, and the implementation conflicts on `(tenant_id,
 * engagement_id)` rather than counting on the caller to be careful. Returns how
 * many were actually created, for the sweep's log.
 */
/**
 * The period a per-period job's umbrella task is for (T6.13): what to call
 * it, and the day the turnaround counts from. Passed through to the work-item
 * side, which owns what a due date is.
 */
export interface SpawnPeriod {
  readonly label: string;
  /** The period's last day, `YYYY-MM-DD`. */
  readonly end: string;
}

export interface WorkItemSpawner {
  spawnForEngagements(
    tenantId: string,
    jobId: string,
    engagementIds: readonly string[],
    actor: Actor,
    period?: SpawnPeriod,
  ): Promise<number>;
}

export interface ActivationFeed {
  /**
   * Activations at this firm with no job against them yet, oldest first.
   *
   * EXCLUDING recurring engagements (T6.13). A service whose pinned body says
   * `monthly`, `quarterly` or `annually` is owed a job PER PERIOD, not one at
   * activation; the `RecurringEngagementFeed` below is its route into the
   * engine, and offering it here too would build the one-time checklist this
   * task exists to stop — a job that walks the process once and can never be
   * completed because the engagement runs a year.
   */
  unspawnedActivations(tenantId: string, limit: number): Promise<readonly Activation[]>;
}

/**
 * An ACTIVE engagement whose service comes round every period (T6.13).
 *
 * The same grouping facts an `Activation` carries, read the same way — Dept,
 * team and process off the LIVE body — plus the three the period arithmetic
 * needs: how often it recurs and what turnaround it promised, both off the
 * PINNED version because they are terms of the letter the client signed, and
 * the day the engagement began.
 *
 * `linkedPeriods` is the anti-join, carried on the row rather than re-queried
 * per period: the periods this engagement already has a job for, so a sweep
 * can decide which are missing without one write per period per engagement
 * per hour. Four hundred clients times three services is twelve hundred
 * engagements, and an hourly sweep that attempted twelve hundred inserts to
 * find out nothing was missing would be a sweep nobody could reason about.
 */
export interface RecurringEngagement {
  readonly engagementId: string;
  readonly engagementLetterId: string;
  readonly entityPartyId: string;
  readonly deptCode: string | null;
  readonly teamCode: string | null;
  readonly workflowKey: string | null;
  /** `crm.engagement.effective_from`, a calendar day. */
  readonly effectiveFrom: string;
  /** The pinned service body's `recurrence`, verbatim. */
  readonly recurrence: string;
  /** The pinned service body's `slaDays`; null when none was stated. */
  readonly slaDays: number | null;
  /** `period_start` of every link row this engagement already has. */
  readonly linkedPeriods: readonly string[];
}

export interface RecurringEngagementFeed {
  /** Active recurring engagements at this firm, oldest start first. */
  activeRecurring(tenantId: string, limit: number): Promise<readonly RecurringEngagement[]>;
}

/**
 * The two firm-level facts the per-period spawn reads off the compliance
 * policy (T6.13): the go-live floor, which is where catch-up stops, and the
 * month the financial year starts, without which a quarter cannot be cut.
 *
 * Declared here in the scheduler's own vocabulary and satisfied by the same
 * config adapter that answers `usecase/obligation`'s version of the first
 * question — the port is stated twice, the adapter once, as every shared read
 * in this codebase is.
 */
export interface CompliancePolicySource {
  missedFromOn(tenantId: string): Promise<string | null>;
  fiscalYearStartMonth(tenantId: string): Promise<number | null>;
}

/**
 * Which calendar this firm's days are cut on (0071).
 *
 * The per-period spawn needs it twice: to know what "today" is for the firm
 * before deciding which periods have begun, and to turn "the day after the
 * period ends" into the instant `runnable_at` actually is. Both are the day
 * bugs this product has already had three of, and the zone is the cure.
 */
export interface FirmTimeZone {
  timeZoneFor(tenantId: string): Promise<string>;
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
