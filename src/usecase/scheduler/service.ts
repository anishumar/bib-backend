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
import type { WorkSplitAxis } from "../../domain/serviceaxis/model";
import { groupByAxis } from "../../domain/serviceaxis/model";
import type {
  Activation,
  ActivationFeed,
  JobDetail,
  JobRepository,
  NewJob,
  TenantDirectory,
  WorkItemSpawner,
  WorkSplitSource,
} from "./ports";

export interface Deps {
  readonly jobs: JobRepository;
  readonly activations: ActivationFeed;
  readonly tenants: TenantDirectory;
  readonly splitAxis: WorkSplitSource;
  /**
   * Work items (T3.1) — the tasks a spawned job puts on people's desks.
   *
   * A SEAM, not a service call: this use case does not know what an assignee or
   * a due date is. It rides on the spawn because "work became owed" is one
   * fact, and a second sweep would leave a job showing no tasks for as long as
   * it was behind.
   */
  readonly workItems: WorkItemSpawner;
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

/**
 * The namespace a merged job's `source_ref` is derived under (T2.7).
 *
 * A merged job's cause is not a row in any table — it is a GROUP of
 * engagements — so its `source_ref` is derived from the group key instead. That
 * is what makes a redelivered sweep conflict on the same value rather than
 * inventing a second checklist for work already being done.
 *
 * A separate namespace from `JOB_NAMESPACE` on purpose: these two derive
 * different things from different inputs, and one namespace would mean a group
 * key that happened to equal an engagement id collided with it.
 */
const JOB_GROUP_NAMESPACE = "b2c8f3a1-4e57-4c9d-8f10-6d3b7a2e9c44";

/** Separates the parts of a derived group key. ASCII unit separator, written
 *  as an ESCAPE rather than a literal control character, so it survives an
 *  editor or a copy-paste that would silently turn it into nothing — which
 *  would flatten ("letterA", "entityB") and ("letterAentity", "B") to one key.
 *
 *  A control character because every part is a uuid, an axis code or a config
 *  key, and none of them may contain one. */
const KEY_SEP = "\u001f";

export interface SweepReport {
  readonly tenantId: string;
  /**
   * Why this firm's sweep did not run at all, or null when it did.
   *
   * A firm is skipped rather than the whole sweep stopping — see
   * `sweepActivations` — and the message is carried out so the worker can log
   * WHICH firm and WHY. A silently skipped firm is a calendar that stops
   * without anybody being told.
   */
  readonly failure?: string;
  /**
   * Engagements that got a job but no TASK (T3.1).
   *
   * The two are separate facts and the second must never undo the first: a job
   * is the record that work is OWED, and losing it because a task could not be
   * routed would lose the work entirely. So a task failure is counted here and
   * logged, and the job stands.
   */
  readonly tasksFailed: number;
  readonly spawned: number;
  /** Activations that already had a job — the redelivery case, and the number
   *  that proves idempotency is working rather than merely intended. */
  readonly alreadySpawned: number;
  /** Engagements that joined a job ALREADY OPEN for their group — the second
   *  line of a letter whose advance arrived a week after the first. Counted
   *  separately from `spawned` because no new checklist appeared: existing work
   *  grew, and that is a different fact for whoever reads the sweep log. */
  readonly extended: number;
}

/**
 * One group of activations that will become ONE job — the merge, decided.
 *
 * Exported for its own tests: this is the rule that answers "how many
 * checklists does this letter become", and it is worth asserting against the
 * firm's own numbers rather than only through a repository.
 */
export interface ActivationGroup {
  readonly engagementLetterId: string;
  readonly entityPartyId: string;
  readonly splitAxis: WorkSplitAxis;
  readonly splitCode: string | null;
  readonly workflowKey: string | null;
  readonly activations: readonly Activation[];
}

/**
 * Cut a firm's activations into the jobs they will become.
 *
 * Four parts to the key and each is argued in `ports.ts`, but the SHAPE is
 * worth stating here: three of them are a PRE-PARTITION and only the fourth is
 * the firm's axis. Letter, entity and workflow key decide what may legally be
 * merged at all; `groupByAxis` then answers the firm's own question — by Dept,
 * by team, or not at all — inside each of those partitions.
 *
 * Written this way rather than as one four-part hash so that `groupByAxis`
 * stays the single, tested statement of the axis rule, including its treatment
 * of an unfiled service as a real group rather than something to drop.
 *
 * On `none` this returns one group per activation, so a firm that has not said
 * how it is organised gets exactly the jobs it gets today.
 */
export function groupActivations(
  activations: readonly Activation[],
  axis: WorkSplitAxis,
): readonly ActivationGroup[] {
  // First-seen order preserved throughout, so the same letter produces the same
  // jobs in the same order on every run — a sweep whose output depends on a
  // hash order is one nobody can reproduce a complaint against.
  const partitions = new Map<string, Activation[]>();
  for (const a of activations) {
    const key = [a.engagementLetterId, a.entityPartyId, a.workflowKey ?? ""].join(KEY_SEP);
    const bucket = partitions.get(key);
    if (bucket) bucket.push(a);
    else partitions.set(key, [a]);
  }

  const groups: ActivationGroup[] = [];
  for (const members of partitions.values()) {
    const codeOf = (a: Activation): string | null =>
      axis === "dept" ? a.deptCode : axis === "team" ? a.teamCode : null;
    for (const bucket of groupByAxis(members, axis, codeOf)) {
      const first = bucket.items[0];
      if (!first) continue;
      groups.push({
        engagementLetterId: first.engagementLetterId,
        entityPartyId: first.entityPartyId,
        splitAxis: axis,
        splitCode: bucket.code,
        workflowKey: first.workflowKey,
        activations: bucket.items,
      });
    }
  }
  return groups;
}

/** When a group's work actually became owed. The earliest of its activations,
 *  because a merged job's start is the moment its FIRST service was paid for —
 *  not whichever one the feed happened to return first. */
function earliestActivation(group: ActivationGroup): string {
  return group.activations
    .map((a) => a.occurredAt)
    .reduce((a, b) => (a <= b ? a : b));
}

export class SchedulerService {
  constructor(private readonly deps: Deps) {}

  /**
   * One pass over every firm: turn released engagements into jobs.
   *
   * The outer loop is the tenant list because a worker has no session, and
   * everything below it is tenant-scoped by RLS.
   *
   * ── ONE FIRM'S FAILURE MUST NOT STOP THE OTHERS ──────────────────────────
   *
   * This comment said exactly that from T2.6 and the code did not do it: a
   * throw in `spawnForTenant` propagated straight out of the loop and every
   * firm after it in the list was skipped, silently, until somebody read a
   * worker log. T3.1 is what found it — a single firm with no work-item states
   * stopped the calendar for every client of every firm on the box.
   *
   * So each firm is caught, and the failure is REPORTED rather than swallowed:
   * `failure` on the report is what the worker logs, and `worker:once` prints.
   * A sweep that quietly skipped a firm forever would be worse than one that
   * stopped, because at least a stopped one is noticed.
   */
  async sweepActivations(actor: Actor = SYSTEM_ACTOR): Promise<readonly SweepReport[]> {
    const tenantIds = await this.deps.tenants.activeTenantIds();
    const reports: SweepReport[] = [];
    for (const tenantId of tenantIds) {
      try {
        reports.push(await this.spawnForTenant(tenantId, actor));
      } catch (err: unknown) {
        reports.push({
          tenantId,
          spawned: 0,
          alreadySpawned: 0,
          extended: 0,
          tasksFailed: 0,
          failure: err instanceof Error ? err.message : String(err),
        });
      }
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
    // The firm's own answer to "what splits our work", read once per sweep.
    // Once per firm rather than once per group: a partner changing the setting
    // halfway through a sweep must not cut one letter two different ways.
    const axis = await this.deps.splitAxis.read(tenantId);
    const pending = await this.deps.activations.unspawnedActivations(tenantId, SPAWN_BATCH);
    let spawned = 0;
    let alreadySpawned = 0;
    let extended = 0;
    let tasksFailed = 0;

    for (const group of groupActivations(pending, axis)) {
      const engagementIds = group.activations.map((a) => a.engagementId);
      const result = await this.deps.jobs.createIfAbsent(this.jobFor(tenantId, group));

      // LINK BEFORE JUDGING WHAT HAPPENED, and always — for a job this call
      // created and for one it found already open. The link table is what
      // "this engagement's work is owed HERE" means, and it carries the
      // absolute rule (one engagement, one job, forever). Deciding first and
      // linking conditionally would leave a created job with no rows in it if
      // anything below threw.
      const linked = await this.deps.jobs.linkEngagements(tenantId, result.job.id, engagementIds);

      // THE TASKS, for whatever actually joined — on a job this call created
      // (everything joins) and on one it found already open (only the new
      // lines). Idempotent on its own side, so a redelivered sweep adds
      // nothing, and AFTER the link for the same reason the link comes first:
      // a work item pointing at a job that has no engagements on it would be a
      // task nothing can explain.
      //
      // Deliberately not inside the `if (result.created)` branch. The second
      // line of a letter whose advance arrived a week later joins an OPEN job,
      // and it is a real piece of work that somebody has to do — leaving it
      // task-less is exactly the hole `job.scope_extended` exists to make
      // visible.
      //
      // CAUGHT, because the two are separate facts and the second must never
      // undo the first. A job is the record that work is OWED; a task is whose
      // desk it lands on. If the firm has no work-item states, or the routing
      // cannot resolve, the JOB still stands and the number is reported — the
      // alternative is losing the record that the client is owed anything at
      // all, which is strictly worse than a job with nothing on a desk yet.
      try {
        await this.deps.workItems.spawnForEngagements(tenantId, result.job.id, linked, actor);
      } catch {
        tasksFailed += linked.length;
      }

      if (result.created) {
        spawned += 1;
        await this.deps.events.recordEvent({
          tenantId,
          verb: "job.spawned",
          objectId: result.job.id,
          actor,
          // Ids and machine facts. `activatedAt` of the EARLIEST activation in
          // the group rather than of this sweep: the fact is when the work
          // became owed, not when a cron happened to notice.
          payload: {
            sourceKind: result.job.sourceKind,
            sourceRef: result.job.sourceRef,
            engagementIds,
            splitAxis: group.splitAxis,
            splitCode: group.splitCode,
            activatedAt: earliestActivation(group),
          },
        });
        continue;
      }

      if (linked.length === 0) {
        // Nothing joined and nothing was created: a redelivered message for
        // work already recorded. The number that proves idempotency is working
        // rather than merely intended.
        alreadySpawned += 1;
        continue;
      }

      // A JOB ALREADY OPEN FOR THIS GROUP GREW. The second line of a letter
      // whose advance arrived a week after the first, joining the checklist its
      // team is already working. A real fact about work in flight, and its own
      // verb: "why did this job gain a service on the 14th" is a question
      // somebody asks, and `job.spawned` cannot answer it.
      extended += 1;
      await this.deps.events.recordEvent({
        tenantId,
        verb: "job.scope_extended",
        objectId: result.job.id,
        actor,
        payload: {
          sourceKind: result.job.sourceKind,
          sourceRef: result.job.sourceRef,
          engagementIds: linked,
          splitAxis: group.splitAxis,
          splitCode: group.splitCode,
        },
      });
    }
    return { tenantId, spawned, alreadySpawned, extended, tasksFailed };
  }

  /**
   * The job one group becomes — and the two shapes it can take.
   *
   * `none` keeps EXACTLY what T2.6 wrote: kind `engagement`, the engagement's
   * own id as the cause, and a DERIVED job id so a replay mints the same row.
   * That is every job written before today and every job a firm on the default
   * setting writes after it, and calling those something else would restate
   * history that is already true.
   *
   * `dept` / `team` is a genuinely different cause. Its `source_ref` names no
   * row in any table — it is the group key, derived — and its id is RANDOM
   * rather than derived, because a group whose job finishes may legally get a
   * second job when a later engagement arrives, and a derived id would collide
   * with the finished one's primary key. Idempotency there is the partial
   * unique index on open jobs, not the id.
   */
  private jobFor(tenantId: string, group: ActivationGroup): NewJob {
    // Work agreed and paid for may begin now. An engagement carries no lead
    // time of its own — the client is waiting — unlike an obligation, whose
    // whole point is to become runnable T–X before a statutory date.
    const runnableAt = this.deps.clock.now().toISOString();
    const first = group.activations[0];

    if (group.splitAxis === "none" && group.activations.length === 1 && first) {
      return {
        id: this.deps.ids.derivedId(JOB_NAMESPACE, first.engagementId),
        tenantId,
        sourceKind: "engagement",
        sourceRef: first.engagementId,
        runnableAt,
        splitAxis: "none",
        splitCode: null,
      };
    }

    const sourceRef = this.deps.ids.derivedId(
      JOB_GROUP_NAMESPACE,
      [
        group.engagementLetterId,
        group.entityPartyId,
        group.splitAxis,
        group.splitCode ?? "",
        group.workflowKey ?? "",
      ].join(KEY_SEP),
    );
    return {
      id: this.deps.ids.newId(),
      tenantId,
      sourceKind: "engagement_group",
      sourceRef,
      runnableAt,
      splitAxis: group.splitAxis,
      splitCode: group.splitCode,
    };
  }

  /** What this firm has that is ready to run. T2.7's orchestrator asks this. */
  async runnableJobs(tenantId: string, limit = 100): Promise<readonly Job[]> {
    return this.deps.jobs.listRunnable(tenantId, this.deps.clock.now().toISOString(), limit);
  }

  /** What a set of jobs is FOR, in words — the work board's read model. Passed
   *  straight through: the join is the adapter's, and a use case that
   *  reassembled it here would be a second place for it to drift. */
  async describeJobs(
    tenantId: string,
    jobIds: readonly string[],
  ): Promise<ReadonlyMap<string, JobDetail>> {
    return this.deps.jobs.describeJobs(tenantId, jobIds);
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
