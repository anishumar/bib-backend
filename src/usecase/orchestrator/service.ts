// The orchestrator (T2.7) — the thing that makes a job more than a row saying
// work is owed. No I/O, no SQL, no HTTP: everything outside arrives as an
// injected port, so this reads as a description of what the engine does.
//
// ── WHAT IT DOES, IN ORDER ──────────────────────────────────────────────────
//
//   A job that has not started: resolve the firm's published process for the
//   service, PIN that version onto the job, write one row per step, start it.
//
//   A job that has: skip the steps whose condition does not hold (and, in the
//   same pass, everything downstream of them), then take the steps that are
//   ready — an agent's are run, a person's are set aside for a person — and
//   recompute what the job's own status should be.
//
// ── THE TWO THINGS THAT ARE NOT NEGOTIABLE ──────────────────────────────────
//
// **The version is pinned, and never re-read from what is in force.** A job
// started in March walks March's process, whatever the firm has published since.
// "Why did this filing have no review step?" has to be answerable, and the only
// answer that survives a year is "because the process in force when it started
// did not have one".
//
// **Every transition is guarded on the state it was read in.** Two workers can
// sweep the same job at once and both can conclude the same step is ready. The
// repository's compare-and-set is what makes the second one lose, and losing is
// not an error — it is another worker having got there first.
import type { IdGen } from "../../platform/ids";
import type { Clock } from "../../platform/clock";
import type { Actor } from "../../domain/ledger/model";
import { SYSTEM_ACTOR } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import type { Job } from "../../domain/scheduler/model";
import type { JobStep } from "../../domain/orchestrator/model";
import {
  cascadeSkips,
  jobStatusFrom,
  readySteps,
  waitsForAPerson,
} from "../../domain/orchestrator/model";
import {
  JobNotFound,
  NoTemplatePublished,
  StepNotAPersons,
  StepNotFound,
  StepNotWaiting,
  TemplateUnreadable,
} from "../../domain/orchestrator/errors";
import type {
  AgentRuntime,
  JobStepRepository,
  JobSubject,
  JobSubjectSource,
  NewJobStep,
  ResolvedTemplate,
  TemplateSource,
  TemplateStep,
} from "./ports";
import type { JobRepository, TenantDirectory } from "../scheduler/ports";

export interface Deps {
  readonly jobs: JobRepository;
  readonly steps: JobStepRepository;
  readonly templates: TemplateSource;
  readonly subjects: JobSubjectSource;
  readonly agents: AgentRuntime;
  readonly tenants: TenantDirectory;
  readonly ids: IdGen;
  readonly clock: Clock;
  readonly events: EventSink;
}

/** How many jobs one tick takes per firm. A sweep is a fair share of the
 *  worker, not a race to drain the table — the same reason the spawn sweep has
 *  a batch. */
const WALK_BATCH = 100;

export interface WalkReport {
  readonly tenantId: string;
  /** Jobs that had their steps written for the first time. */
  readonly started: number;
  /** Step transitions actually made. */
  readonly advanced: number;
  /** Steps set aside for a person, and therefore waiting. */
  readonly awaitingPeople: number;
  /** Jobs that reached a terminal state on this tick. */
  readonly completed: number;
  /** Jobs that could not start because the firm has published no process for
   *  them. NOT an error — see `NoTemplatePublished`. Counted so the worker's
   *  log says how much work is waiting on a partner rather than on the engine. */
  readonly awaitingTemplate: number;
}

export class OrchestratorService {
  constructor(private readonly deps: Deps) {}

  /** Every firm, one after another. The outer loop of the worker's third sweep. */
  async sweep(actor: Actor = SYSTEM_ACTOR): Promise<readonly WalkReport[]> {
    const reports: WalkReport[] = [];
    for (const tenantId of await this.deps.tenants.activeTenantIds()) {
      reports.push(await this.walkForTenant(tenantId, actor));
    }
    return reports;
  }

  /** One firm's runnable jobs, each advanced as far as this tick can take it. */
  async walkForTenant(tenantId: string, actor: Actor = SYSTEM_ACTOR): Promise<WalkReport> {
    const now = this.deps.clock.now().toISOString();
    const jobs = await this.deps.jobs.listRunnable(tenantId, now, WALK_BATCH);

    let started = 0;
    let advanced = 0;
    let awaitingPeople = 0;
    let completed = 0;
    let awaitingTemplate = 0;

    for (const job of jobs) {
      // One firm's broken job must not stop the rest of that firm's work, let
      // alone every other firm's. The two expected refusals are counted and
      // carried on from; anything else is re-thrown, because a bug that gets
      // swallowed in a worker is a bug nobody ever hears about.
      let outcome;
      try {
        outcome = await this.advance(tenantId, job, actor);
      } catch (err) {
        if (err instanceof NoTemplatePublished || err instanceof TemplateUnreadable) {
          awaitingTemplate += 1;
          continue;
        }
        throw err;
      }
      started += outcome.started ? 1 : 0;
      advanced += outcome.advanced;
      awaitingPeople += outcome.awaitingPeople;
      completed += outcome.completed ? 1 : 0;
    }

    return { tenantId, started, advanced, awaitingPeople, completed, awaitingTemplate };
  }

  /**
   * Advance one job as far as this tick can take it.
   *
   * Public because `worker:once` and the tests both drive a single job, and
   * because a route that lets a person complete a step calls it straight
   * afterwards — the alternative is waiting up to an hour to see the work move,
   * which is how a person concludes the button did nothing.
   */
  async advance(
    tenantId: string,
    job: Job,
    actor: Actor = SYSTEM_ACTOR,
  ): Promise<{
    readonly started: boolean;
    readonly advanced: number;
    readonly awaitingPeople: number;
    readonly completed: boolean;
  }> {
    const subject = await this.deps.subjects.subjectOf(tenantId, job.id);
    const { template, started } = await this.templateFor(tenantId, job, subject, actor);

    let steps = await this.deps.steps.listForJob(tenantId, job.id);
    if (steps.length === 0) {
      steps = await this.createSteps(tenantId, job, template, actor);
    }

    // WALK UNTIL NOTHING MOVES, rather than one layer per tick.
    //
    // An agent step finishes inside this call, and finishing it is exactly what
    // makes the next steps ready. Stopping after one pass would advance a chain
    // of agent steps at one step per sweep — five minutes each on the default
    // cron — and a person watching a job crawl concludes the engine is broken.
    //
    // It terminates because the graph is a DAG and every pass settles at least
    // one step, so there are at most as many passes as steps. The bound is a
    // guard against a future change breaking that, not against this code: it
    // stops rather than spins, and the next sweep picks the job up again.
    let advanced = 0;
    let awaitingPeople = 0;
    for (let pass = 0; pass <= template.steps.length; pass += 1) {
      const skipped = await this.applyConditions(tenantId, job, template, subject, steps, actor);
      if (skipped > 0) steps = await this.deps.steps.listForJob(tenantId, job.id);

      const taken = await this.takeReadySteps(tenantId, job, template, steps, actor);
      advanced += skipped + taken.advanced;
      awaitingPeople += taken.awaitingPeople;
      if (skipped === 0 && taken.advanced === 0) break;
      steps = await this.deps.steps.listForJob(tenantId, job.id);
    }

    const after = await this.deps.steps.listForJob(tenantId, job.id);
    const completed = await this.settleJobStatus(tenantId, job, template, after, actor);

    return { started, advanced, awaitingPeople, completed };
  }

  /**
   * One job's steps, in the order its TEMPLATE wrote them.
   *
   * The template's order, not the database's: `job_step` is stored keyed and
   * read back sorted by key, which is deterministic and meaningless to a person.
   * A process reads top to bottom, and a work board that showed
   * "annual_review" above "collect" because of the alphabet would be unreadable.
   *
   * A job whose pinned template no longer resolves still lists its steps — the
   * ROWS are the history and they are readable whatever happened to the config.
   * Only the ordering falls back to the stored one.
   */
  async stepsOf(tenantId: string, jobId: string): Promise<readonly JobStep[]> {
    const job = await this.deps.jobs.findById(tenantId, jobId);
    if (!job) throw new JobNotFound(jobId);

    const steps = await this.deps.steps.listForJob(tenantId, jobId);
    if (job.templateVersionId === null) return steps;

    const template = await this.deps.templates.pinnedTemplate(
      tenantId,
      job.templateVersionId,
    );
    if (!template) return steps;

    const order = new Map(template.steps.map((s, i) => [s.key, i]));
    return [...steps].sort(
      (a, b) =>
        (order.get(a.stepKey) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.stepKey) ?? Number.MAX_SAFE_INTEGER),
    );
  }

  /**
   * A person says a step is done.
   *
   * This is the OTHER half of the engine and it matters as much as the sweep: a
   * product whose steps only a machine can finish is a product a firm cannot use
   * until every agent exists. Every step of every process can be a person's, and
   * the firm's work runs today.
   */
  async completeStep(
    input: {
      readonly tenantId: string;
      readonly jobId: string;
      readonly stepKey: string;
    },
    actor: Actor,
    performedBy: string,
  ): Promise<JobStep> {
    const job = await this.deps.jobs.findById(input.tenantId, input.jobId);
    if (!job) throw new JobNotFound(input.jobId);

    const step = await this.deps.steps.findByKey(input.tenantId, input.jobId, input.stepKey);
    if (!step) throw new StepNotFound(input.stepKey);
    // `blocked` is precisely the state that means "waiting for somebody". A
    // second completion would overwrite who did it and when, which is the one
    // fact this row exists to hold.
    if (step.status !== "blocked") throw new StepNotWaiting(step.stepKey, step.status);
    if (!waitsForAPerson(step.executor)) {
      // Except when nobody built the agent. Then the step IS a person's, whatever
      // the template intended — that is the rule that keeps a firm working while
      // the agents are still being written.
      if (!(step.executor === "agent" && !this.deps.agents.canRun(step.stepKey))) {
        throw new StepNotAPersons(step.stepKey, step.executor);
      }
    }

    const at = this.deps.clock.now().toISOString();
    const done = await this.deps.steps.transition(input.tenantId, step.id, "blocked", {
      status: "done",
      at,
      performedBy,
    });
    // Lost the race with another writer — somebody else completed it between the
    // read and the write. Their record stands; ours would only overwrite it.
    if (!done) throw new StepNotWaiting(step.stepKey, "done");

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "job.step_advanced",
      objectId: job.id,
      actor,
      payload: { stepKey: step.stepKey, from: "blocked", to: "done", executor: step.executor },
    });

    // Immediately, not on the next tick. Finishing a step is what makes the next
    // ones ready, and a person who ticks something and sees nothing change
    // concludes the button did not work.
    await this.advance(input.tenantId, job, actor);
    return done;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * The process this job walks — pinned if it already started, resolved and
   * pinned if it has not.
   *
   * The whole of pinning lives in this method's shape: once `templateVersionId`
   * is set, what is in force is never consulted again.
   */
  private async templateFor(
    tenantId: string,
    job: Job,
    subject: JobSubject | null,
    actor: Actor,
  ): Promise<{ readonly template: ResolvedTemplate; readonly started: boolean }> {
    if (job.templateVersionId !== null) {
      const pinned = await this.deps.templates.pinnedTemplate(tenantId, job.templateVersionId);
      if (!pinned) throw new TemplateUnreadable(job.templateVersionId);
      return { template: pinned, started: false };
    }

    const key = subject?.workflowTemplateKey ?? null;
    if (key === null) throw new NoTemplatePublished("(none named by the service)");
    const published = await this.deps.templates.publishedTemplate(tenantId, key);
    if (!published) throw new NoTemplatePublished(key);

    await this.deps.jobs.pinTemplate(tenantId, job.id, published.versionId);
    await this.deps.events.recordEvent({
      tenantId,
      verb: "job.template_pinned",
      objectId: job.id,
      actor,
      // The VERSION id, because the key alone answers the wrong question. "Which
      // process" is answered by the key; "which wording of it" is what somebody
      // asks a year later, and only the version id can say.
      payload: { templateKey: key, versionId: published.versionId },
    });
    return { template: published, started: true };
  }

  /** One row per step, in one write, idempotently. */
  private async createSteps(
    tenantId: string,
    job: Job,
    template: ResolvedTemplate,
    actor: Actor,
  ): Promise<readonly JobStep[]> {
    const rows: NewJobStep[] = template.steps.map((s) => ({
      // DERIVED from the job and the step key, so a redelivered message builds
      // the same ids and the insert conflicts instead of duplicating. Same
      // argument the job's own id makes.
      id: this.deps.ids.derivedId(job.id, s.key),
      tenantId,
      jobId: job.id,
      stepKey: s.key,
      label: s.label,
      executor: s.executor,
    }));
    const result = await this.deps.steps.createAllIfAbsent(rows);
    if (result.created) {
      await this.deps.events.recordEvent({
        tenantId,
        verb: "job.started",
        objectId: job.id,
        actor,
        payload: { steps: rows.length, templateVersionId: template.versionId },
      });
    }
    return result.steps;
  }

  /**
   * Skip the steps whose condition does not hold, and everything downstream.
   *
   * Only steps that are otherwise READY are judged. A step whose dependencies
   * have not cleared is not evaluated yet, deliberately: a condition read too
   * early is read against facts that may not have been established, and the
   * cheapest way to never do that is to judge a step at the moment it would
   * otherwise start.
   */
  private async applyConditions(
    tenantId: string,
    job: Job,
    template: ResolvedTemplate,
    subject: JobSubject | null,
    steps: readonly JobStep[],
    actor: Actor,
  ): Promise<number> {
    const byKey = new Map(steps.map((s) => [s.stepKey, s]));
    const defs = new Map(template.steps.map((s) => [s.key, s]));
    let skipped = 0;

    for (const key of readySteps(template.steps, steps)) {
      const def = defs.get(key);
      const step = byKey.get(key);
      if (!def?.condition || !step) continue;

      const verdict = evaluateCondition(def.condition, subject);
      if (verdict.holds) continue;

      const moved = await this.deps.steps.transition(tenantId, step.id, "pending", {
        status: "skipped",
        at: this.deps.clock.now().toISOString(),
        outcomeNote: verdict.why,
      });
      if (!moved) continue;
      skipped += 1;
      await this.deps.events.recordEvent({
        tenantId,
        verb: "job.step_skipped",
        objectId: job.id,
        actor,
        // The FACT and the values, never the prose note: the note is written for
        // a person and this log cannot be erased. `fact`/`expected`/`actual` is
        // what a query needs — "how often does the UAE branch skip the GST step"
        // is a GROUP BY, and a sentence does not group.
        payload: {
          stepKey: step.stepKey,
          fact: def.condition.fact,
          expected: def.condition.equals,
          actual: verdict.actual,
        },
      });
    }

    if (skipped === 0) return 0;

    // The other half of a branch. Without it, everything downstream of a skipped
    // step waits forever on something that will never be `done`.
    const after = await this.deps.steps.listForJob(tenantId, job.id);
    const afterByKey = new Map(after.map((s) => [s.stepKey, s]));
    for (const key of cascadeSkips(template.steps, after)) {
      const step = afterByKey.get(key);
      if (!step) continue;
      const moved = await this.deps.steps.transition(tenantId, step.id, "pending", {
        status: "skipped",
        at: this.deps.clock.now().toISOString(),
        outcomeNote: "a step this one depends on was skipped",
      });
      if (!moved) continue;
      skipped += 1;
      await this.deps.events.recordEvent({
        tenantId,
        verb: "job.step_skipped",
        objectId: job.id,
        actor,
        payload: { stepKey: step.stepKey, because: "upstream_skipped" },
      });
    }
    return skipped;
  }

  /** Start every step that can start: agents run, people's steps wait. */
  private async takeReadySteps(
    tenantId: string,
    job: Job,
    template: ResolvedTemplate,
    steps: readonly JobStep[],
    actor: Actor,
  ): Promise<{ readonly advanced: number; readonly awaitingPeople: number }> {
    const byKey = new Map(steps.map((s) => [s.stepKey, s]));
    let advanced = 0;
    let awaitingPeople = 0;

    for (const key of readySteps(template.steps, steps)) {
      const step = byKey.get(key);
      if (!step) continue;

      // A person's step, or an agent's that nobody has built yet. Both wait, and
      // they are the same state on purpose: the firm's work carries on, and an
      // `agent` step sitting `blocked` is exactly the visible fact that an agent
      // is missing. No note is stored for it — the executor and the status say
      // it between them, and a stored sentence would be prose duplicating a
      // fact two columns already hold.
      const noAgent = step.executor === "agent" && !this.deps.agents.canRun(step.stepKey);
      if (waitsForAPerson(step.executor) || noAgent) {
        const moved = await this.deps.steps.transition(tenantId, step.id, "pending", {
          status: "blocked",
          at: this.deps.clock.now().toISOString(),
        });
        if (!moved) continue;
        awaitingPeople += 1;
        advanced += 1;
        await this.deps.events.recordEvent({
          tenantId,
          verb: "job.step_advanced",
          objectId: job.id,
          actor,
          payload: {
            stepKey: step.stepKey,
            from: "pending",
            to: "blocked",
            executor: step.executor,
            ...(noAgent ? { awaitingAgent: true } : {}),
          },
        });
        continue;
      }

      const running = await this.deps.steps.transition(tenantId, step.id, "pending", {
        status: "running",
        at: this.deps.clock.now().toISOString(),
      });
      // Another worker took it. Not an error.
      if (!running) continue;

      const outcome = await this.deps.agents.run({
        tenantId,
        jobId: job.id,
        stepKey: step.stepKey,
      });
      const at = this.deps.clock.now().toISOString();
      const finished = await this.deps.steps.transition(tenantId, running.id, "running", {
        status: outcome.done ? "done" : "failed",
        at,
        ...(outcome.done ? {} : { outcomeNote: outcome.note }),
      });
      if (!finished) continue;
      advanced += 1;
      await this.deps.events.recordEvent({
        tenantId,
        verb: outcome.done ? "job.step_advanced" : "job.step_failed",
        objectId: job.id,
        actor,
        payload: outcome.done
          ? { stepKey: step.stepKey, from: "running", to: "done", executor: step.executor }
          : { stepKey: step.stepKey, executor: step.executor },
      });
    }
    return { advanced, awaitingPeople };
  }

  /** Bring the job's own status in line with its steps, and say so once. */
  private async settleJobStatus(
    tenantId: string,
    job: Job,
    template: ResolvedTemplate,
    steps: readonly JobStep[],
    actor: Actor,
  ): Promise<boolean> {
    const should = jobStatusFrom(template.steps, steps);
    if (should === job.status) return false;

    await this.deps.jobs.updateStatus(
      tenantId,
      job.id,
      should,
      this.deps.clock.now().toISOString(),
    );
    if (should !== "done") return false;

    await this.deps.events.recordEvent({
      tenantId,
      verb: "job.completed",
      objectId: job.id,
      actor,
      // Both numbers, because "finished" and "finished having skipped four of
      // its six steps" are different facts and only one of them is reassuring.
      payload: {
        steps: steps.length,
        skipped: steps.filter((s) => s.status === "skipped").length,
      },
    });
    return true;
  }
}

/**
 * Whether a step's condition holds.
 *
 * **An unresolved fact does NOT skip the step**, and this is the decision in
 * this function. A service that never stated its recurrence, or an entity with
 * no registered jurisdiction, is a gap in the firm's data — and treating a gap
 * as "the condition is false" would quietly remove steps from a process because
 * somebody left a field blank. The safe direction is to DO the work: an extra
 * review step costs an hour, a missing one costs a filing.
 */
export function evaluateCondition(
  condition: { readonly fact: string; readonly equals: string },
  subject: JobSubject | null,
): { readonly holds: boolean; readonly actual: string | null; readonly why: string } {
  const actual = resolveFact(condition.fact, subject);
  if (actual === null) {
    return {
      holds: true,
      actual: null,
      why: `${condition.fact} is not stated, so the step was kept`,
    };
  }
  const holds = actual === condition.equals;
  return {
    holds,
    actual,
    why: `${condition.fact} is ${JSON.stringify(actual)}, and this step applies only when it is ${JSON.stringify(condition.equals)}`,
  };
}

function resolveFact(fact: string, subject: JobSubject | null): string | null {
  if (!subject) return null;
  switch (fact) {
    case "recurrence":
      return subject.recurrence;
    case "jurisdiction":
      return subject.jurisdiction;
    default:
      // A fact the config domain accepts and this resolver has not learnt yet.
      // Unresolved rather than thrown, which lands on the rule above: the step
      // is KEPT. A template naming a fact the engine cannot read must not
      // silently delete steps from a process.
      return null;
  }
}

export type { TemplateStep };
