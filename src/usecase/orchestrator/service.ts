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
  runsAMachine,
} from "../../domain/orchestrator/model";
import { ASK_A_PERSON, decideFor } from "../../domain/agent/model";
import type { ProposalOutcome } from "../../domain/agent/model";
import {
  AwaitingCheck,
  JobNotFound,
  NoTemplatePublished,
  CorrectionChangedNothing,
  NothingProposed,
  ProposalUndecided,
  StepNotFound,
  StepNotWaiting,
  TemplateUnreadable,
} from "../../domain/orchestrator/errors";
import type {
  AgentRun,
  AgentRunRepository,
  AgentRuntime,
  TierSource,
  JobStepRepository,
  JobSubject,
  JobSubjectSource,
  NewJobStep,
  ResolvedTemplate,
  TemplateSource,
  TemplateStep,
} from "./ports";
import type { JobRepository, TenantDirectory } from "../scheduler/ports";
// T2.9 lives here rather than in a service of its own, and it is the same
// judgement T2.8 made about `decideProposal`: a check is part of a STEP's
// lifecycle, and this is the thing that owns a step's lifecycle. Splitting it
// out would mean either a handler calling two use cases (which the layer rule
// forbids for good reason) or two services holding each other, since opening a
// check happens when work finishes and finishing work happens when a check
// passes. The RULE is in `domain/verification`; only the orchestration is here.
import type {
  CheckerDirectory,
  PendingCheck,
  StepApprovalRepository,
  VerificationPolicySource,
} from "../verification/ports";
import type {
  CheckerCandidate,
  Eligibility,
  Maker,
  StepApproval,
  VerificationPolicy,
} from "../../domain/verification/model";
import { isEligible } from "../../domain/verification/model";
import {
  ApprovalAlreadyDecided,
  ApprovalNotFound,
  NotEligibleToCheck,
  RejectionNeedsAReason,
} from "../../domain/verification/errors";
import type { Permission } from "../../domain/authz/model";
import type { PermissionSource } from "../authz/ports";
import type { FirmTimeZone, StepDeskResolver } from "./ports";
import { dayInZone } from "../../domain/scheduler/zone";
import { bandLabel, withinBand } from "../../domain/orchestrator/model";
import {
  NotStaffHere,
  NotYourStep,
  PerformerOutOfBand,
  StepSettled,
} from "../../domain/orchestrator/errors";

export interface Deps {
  readonly jobs: JobRepository;
  readonly steps: JobStepRepository;
  readonly templates: TemplateSource;
  readonly subjects: JobSubjectSource;
  readonly agents: AgentRuntime;
  /** The firm's confidence thresholds, and the run book they judge (T2.8). */
  readonly tiers: TierSource;
  readonly runs: AgentRunRepository;
  /** The firm's checks, its published rules about who may make them, and the
   *  roster those rules are evaluated against (T2.9). */
  readonly checks: StepApprovalRepository;
  readonly policies: VerificationPolicySource;
  readonly checkers: CheckerDirectory;
  /** Whose desk a job's steps default to (0301). */
  readonly desks: StepDeskResolver;
  /** Resolves a role to its permissions, so eligibility can require the same
   *  `work:write` that doing the step required. Shared with the authz service
   *  rather than restated — one notion of what a role carries. */
  readonly permissions: PermissionSource;
  readonly tenants: TenantDirectory;
  readonly timeZones: FirmTimeZone;
  readonly ids: IdGen;
  readonly clock: Clock;
  readonly events: EventSink;
}

/** One step as the job page reads it (0301). */
export interface DescribedStep {
  readonly step: JobStep;
  readonly performer: ResolvedTemplate["steps"][number]["performer"];
  readonly assignee: { readonly userId: string; readonly displayName: string } | null;
  readonly viewer: {
    readonly mayComplete: boolean;
    readonly reason: "ON_ANOTHER_DESK" | "OUTSIDE_BAND" | null;
  };
}

/** How many jobs one tick takes per firm. A sweep is a fair share of the
 *  worker, not a race to drain the table — the same reason the spawn sweep has
 *  a batch. */
const WALK_BATCH = 100;

/**
 * A pending check, as a queue row — with the VIEWER's own verdict on it.
 *
 * The verdict rides on the row rather than filtering the list, because a queue
 * that hides what you cannot take also hides that six filings have been waiting
 * a week for somebody senior enough. A screen offers the button on `eligible`
 * and says the reason on the rest.
 */
export interface CheckOnDesk extends PendingCheck {
  /** Which rule governed it, or null when the firm had published none. Shown so
   *  "why is only one person eligible" is answerable on the screen rather than
   *  by reading config. */
  readonly rule: string | null;
  readonly viewer: Eligibility;
}

/** One member of staff, and whether they may check one particular thing. The
 *  whole roster comes back with a verdict each — see `eligibleCheckers`. */
export interface CheckerVerdict extends Eligibility {
  readonly userId: string;
  readonly displayName: string;
  readonly gradeName: string | null;
}

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
   * What a person decided about what a machine proposed (T2.8).
   *
   * The write that makes `applied` a stored fact rather than a column with no
   * writer — the shape this codebase has been caught by before. Three outcomes,
   * and they are not interchangeable:
   *
   *   accepted   the machine was right. The step is done, by this person.
   *   corrected  the machine was close. What actually stands is recorded
   *              ALONGSIDE what was proposed, never over it, and the schema
   *              refuses a "correction" that changed nothing. The step is done.
   *   rejected   the machine was wrong, with a reason the schema insists on.
   *              The step stays BLOCKED, because rejecting an answer is not
   *              doing the work — somebody still has to, and then ticks it off
   *              the ordinary way.
   *
   * Accepted and corrected are kept apart because the difference between them is
   * the entire accuracy signal, and that number is the only evidence that could
   * ever justify moving a threshold.
   */
  async decideProposal(
    input: {
      readonly tenantId: string;
      readonly jobId: string;
      readonly stepKey: string;
      readonly outcome: ProposalOutcome;
      readonly applied: Record<string, unknown> | null;
      readonly rejectedReason: string | null;
    },
    actor: Actor,
    decidedBy: string,
  ): Promise<JobStep> {
    const step = await this.deps.steps.findByKey(input.tenantId, input.jobId, input.stepKey);
    if (!step) throw new StepNotFound(input.stepKey);
    if (step.status !== "blocked") throw new StepNotWaiting(step.stepKey, step.status);

    const open = await this.deps.runs.openForStep(input.tenantId, step.id);
    if (!open) throw new NothingProposed(step.stepKey);

    // Refused HERE as well as by the CHECK, and the difference is who is being
    // told. The constraint has to hold against an import, a script or an agent;
    // this exists so that a PERSON who clicked Correct and then changed nothing
    // is told what to do instead of being shown "internal error". A raw
    // constraint violation carries no actionable message, which is how this was
    // found — by clicking it.
    if (
      input.outcome === "corrected" &&
      JSON.stringify(input.applied) === JSON.stringify(open.proposed)
    ) {
      throw new CorrectionChangedNothing(step.stepKey);
    }

    const at = this.deps.clock.now().toISOString();
    // Only where nothing has been decided, in SQL — two people looking at the
    // same queue can click at once, and the second must not overwrite the
    // first's answer. Null means somebody got there first.
    const decided = await this.deps.runs.decide(input.tenantId, open.id, {
      outcome: input.outcome,
      // An acceptance applies the proposal ITSELF, taken from the run rather
      // than from the caller — so "accepted" cannot quietly carry a different
      // value than the one proposed. The schema refuses that too; this is why
      // it never has to.
      applied: input.outcome === "accepted" ? open.proposed : input.applied,
      rejectedReason: input.outcome === "rejected" ? input.rejectedReason : null,
      decidedBy,
      decidedAt: at,
    });
    if (!decided) throw new ProposalUndecided(step.stepKey);

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "agent_run.decided",
      objectId: open.id,
      actor,
      // WHICH of the three, and never the values. Accepted-vs-corrected is the
      // accuracy signal and belongs here; the values themselves can hold a
      // client's own data, and this log cannot be erased.
      payload: {
        stepKey: step.stepKey,
        outcome: input.outcome,
        confidence: open.confidence,
        decision: open.decision,
        model: open.model,
        promptVersion: open.promptVersion,
      },
    });

    // A rejection is not the work being done. The machine's answer is thrown
    // away, the step stays waiting, and whoever rejected it still has to do it
    // and tick it off the ordinary way.
    if (input.outcome === "rejected") return step;

    // Through the SAME gate a human step goes through (T2.9), and that is the
    // decision: whether a firm's review happens must not depend on whether a
    // machine drafted the work. The person who accepted the machine's output is
    // the MAKER here — they own it now — which the gate records and which the
    // database then refuses to let them approve.
    const job = await this.deps.jobs.findById(input.tenantId, input.jobId);
    if (!job) throw new JobNotFound(input.jobId);
    return this.finishOrSendForChecking(input.tenantId, job, step, decidedBy, actor);
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
  /** The undecided proposals in this job, keyed by step id — what the job screen
   *  puts in front of a person. Passed straight through; the query is the
   *  adapter's and a use case that reassembled it would be a second place for it
   *  to drift. */
  async proposalsFor(
    tenantId: string,
    jobId: string,
  ): Promise<ReadonlyMap<string, AgentRun>> {
    return this.deps.runs.openForJob(tenantId, jobId);
  }

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

    // EVERY blocked step is a person's to finish, and T2.8 is what made that
    // true rather than mostly true. `blocked` now has exactly three causes — a
    // human step, a machine step nobody built an agent for, and a machine step
    // whose answer is waiting on a decision — and a person is the answer to all
    // three. The executor check that used to sit here refused the third.
    //
    // What is refused instead is finishing one BEHIND the machine's answer.
    // Ticking "done" would record that a person did the work and leave what the
    // machine proposed undecided forever, which is precisely the accuracy signal
    // this task exists to keep.
    const open = await this.deps.runs.openForStep(input.tenantId, step.id);
    if (open) throw new ProposalUndecided(step.stepKey);

    // A step already waiting to be CHECKED is not a step to tick off again.
    // Without this, the maker could re-complete their own work and the second
    // pass would find a check already open and silently do nothing — a button
    // that looks like it worked and did not.
    const openCheck = await this.deps.checks.findOpenForStep(input.tenantId, step.id);
    if (openCheck) throw new AwaitingCheck(step.stepKey);

    // WHOSE DESK (0301). A step on somebody else's desk is theirs to tick;
    // taking it first is one click and one ledger row, and it is what makes
    // `performed_by` an answer rather than a coincidence. A step on nobody's
    // desk may be ticked by anybody the process's band allows.
    const staff = await this.deps.checkers.activeStaff(input.tenantId);
    if (step.assigneeUserId !== null && step.assigneeUserId !== performedBy) {
      const holder = staff.find((m) => m.userId === step.assigneeUserId);
      throw new NotYourStep(step.stepKey, holder?.displayName ?? "somebody else");
    }
    const band = await this.bandOf(input.tenantId, job, step.stepKey);
    if (band !== null) {
      const me = staff.find((m) => m.userId === performedBy);
      if (!withinBand(me?.gradeRank ?? null, band)) {
        throw new PerformerOutOfBand(step.stepKey, me?.displayName ?? "you", me?.gradeName ?? null, bandLabel(band));
      }
    }

    return this.finishOrSendForChecking(input.tenantId, job, step, performedBy, actor);
  }

  /** The grade band the pinned process names for a step, or null. */
  private async bandOf(tenantId: string, job: Job, stepKey: string): Promise<ResolvedTemplate["steps"][number]["performer"]> {
    if (job.templateVersionId === null) return null;
    const template = await this.deps.templates.pinnedTemplate(tenantId, job.templateVersionId);
    return template?.steps.find((s) => s.key === stepKey)?.performer ?? null;
  }

  /**
   * Put a step on somebody's desk — theirs (taken), somebody else's (handed
   * over) or nobody's (released). The band is checked, the roster is checked,
   * and every move is a ledger row that says which of the three it was.
   */
  async assignStep(
    input: {
      readonly tenantId: string;
      readonly jobId: string;
      readonly stepKey: string;
      readonly assigneeUserId: string | null;
    },
    actor: Actor,
    byUserId: string,
  ): Promise<JobStep> {
    const job = await this.deps.jobs.findById(input.tenantId, input.jobId);
    if (!job) throw new JobNotFound(input.jobId);
    const step = await this.deps.steps.findByKey(input.tenantId, input.jobId, input.stepKey);
    if (!step) throw new StepNotFound(input.stepKey);
    if (step.status === "done" || step.status === "skipped" || step.status === "failed") {
      throw new StepSettled(step.stepKey, step.status);
    }
    if (input.assigneeUserId !== null) {
      const staff = await this.deps.checkers.activeStaff(input.tenantId);
      const who = staff.find((m) => m.userId === input.assigneeUserId);
      if (!who) throw new NotStaffHere(input.assigneeUserId);
      const band = await this.bandOf(input.tenantId, job, step.stepKey);
      if (band !== null && !withinBand(who.gradeRank, band)) {
        throw new PerformerOutOfBand(step.stepKey, who.displayName, who.gradeName, bandLabel(band));
      }
    }
    const moved = await this.deps.steps.assign(input.tenantId, step.id, input.assigneeUserId);
    if (!moved) throw new StepSettled(step.stepKey, "settled");
    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "job.step_assigned",
      objectId: job.id,
      actor,
      payload: {
        stepKey: step.stepKey,
        assigneeUserId: input.assigneeUserId,
        previousAssigneeUserId: step.assigneeUserId,
        how:
          input.assigneeUserId === null
            ? "released"
            : input.assigneeUserId === byUserId
              ? "taken"
              : "handover",
      },
    });
    return moved;
  }

  /** Every open step on one person's desk, across the firm's jobs. */
  async myOpenSteps(tenantId: string, userId: string): Promise<readonly JobStep[]> {
    return this.deps.steps.listOpenForUser(tenantId, userId);
  }

  /** Who may do a step: active staff inside its band, for a hand-over picker. */
  async performersFor(
    tenantId: string,
    jobId: string,
    stepKey: string,
  ): Promise<readonly { readonly userId: string; readonly displayName: string; readonly gradeName: string | null }[]> {
    const job = await this.deps.jobs.findById(tenantId, jobId);
    if (!job) throw new JobNotFound(jobId);
    const band = await this.bandOf(tenantId, job, stepKey);
    const staff = await this.deps.checkers.activeStaff(tenantId);
    return staff
      .filter((m) => withinBand(m.gradeRank, band))
      .map((m) => ({ userId: m.userId, displayName: m.displayName, gradeName: m.gradeName }));
  }

  /**
   * A job's steps with what the page needs beside each: the band, whose desk,
   * and whether THIS viewer may tick it — computed here, once, so the button
   * and the refusal cannot disagree.
   */
  async describeSteps(
    tenantId: string,
    jobId: string,
    viewerUserId: string,
  ): Promise<readonly DescribedStep[]> {
    const job = await this.deps.jobs.findById(tenantId, jobId);
    if (!job) throw new JobNotFound(jobId);
    const steps = await this.stepsOf(tenantId, jobId);
    const template =
      job.templateVersionId === null
        ? null
        : await this.deps.templates.pinnedTemplate(tenantId, job.templateVersionId);
    const bands = new Map((template?.steps ?? []).map((s) => [s.key, s.performer]));
    const staff = await this.deps.checkers.activeStaff(tenantId);
    const byUser = new Map(staff.map((m) => [m.userId, m]));
    const viewer = byUser.get(viewerUserId) ?? null;
    return steps.map((step) => {
      const performer = bands.get(step.stepKey) ?? null;
      // The band first. A viewer outside it can neither tick the step nor
      // take it — `assignStep` refuses the same grade — so "on another desk"
      // must not turn into a "Take it" button for a partner reading a
      // junior's step. Found on 10x Global's August close: every step sat on
      // Rohan's desk, and Sid was offered all ten.
      const reason: DescribedStep["viewer"]["reason"] = !withinBand(viewer?.gradeRank ?? null, performer)
        ? "OUTSIDE_BAND"
        : step.assigneeUserId !== null && step.assigneeUserId !== viewerUserId
          ? "ON_ANOTHER_DESK"
          : null;
      return {
        step,
        performer,
        assignee:
          step.assigneeUserId === null
            ? null
            : {
                userId: step.assigneeUserId,
                displayName: byUser.get(step.assigneeUserId)?.displayName ?? "somebody no longer on the roster",
              },
        viewer: { mayComplete: reason === null, reason },
      };
    });
  }

  /**
   * The work is finished. Is anybody supposed to look at it? (T2.9)
   *
   * The one place both "a person ticked it off" and "a person accepted what a
   * machine proposed" arrive at, because the answer must not depend on which of
   * those it was. A firm that says a filing is reviewed by a Manager means
   * reviewed, whoever or whatever prepared it.
   *
   * A step whose template names no policy finishes exactly as it did before
   * T2.9 — which is every step of every process published until now.
   *
   * A step that names one does NOT become `done`. It stays `blocked`, which is
   * already the state meaning "waiting on a person", now with a fourth cause;
   * `performed_by` is written so the database knows who the maker was; and a
   * `step_approval` row opens. The job does not advance, and that is the whole
   * value of the feature — a review that does not hold up the work downstream
   * is a review nobody has to do.
   */
  private async finishOrSendForChecking(
    tenantId: string,
    job: Job,
    step: JobStep,
    performedBy: string,
    actor: Actor,
  ): Promise<JobStep> {
    const at = this.deps.clock.now().toISOString();
    const policyKey = await this.policyKeyFor(tenantId, job, step.stepKey);

    if (policyKey !== null) {
      // blocked -> blocked, recording WHO did it. The status does not move, and
      // the timestamp CHECK in 0044 is satisfied either way: a blocked step
      // already has a `started_at` and must not have a `finished_at`, which is
      // exactly true of work waiting to be checked.
      const held = await this.deps.steps.transition(tenantId, step.id, "blocked", {
        status: "blocked",
        at,
        performedBy,
      });
      if (!held) throw new StepNotWaiting(step.stepKey, "done");

      // Resolved AFTER the maker is recorded, because the row the database
      // derives `submitted_by` from is the one just written. Opening the check
      // first would freeze a null maker onto it and quietly disable maker !=
      // checker for this step.
      const resolved = await this.deps.policies.publishedPolicy(tenantId, policyKey);
      const approval = await this.deps.checks.openIfAbsent({
        id: this.deps.ids.newId(),
        tenantId,
        jobId: job.id,
        jobStepId: step.id,
        // Null when the step names a policy the firm has since withdrawn. The
        // check still opens — under maker != checker alone — because the firm
        // said this step is reviewed, and unpublishing the rule about WHO does
        // it is not the same as saying nobody does.
        policyVersionId: resolved?.versionId ?? null,
        policyKey,
      });
      // Null means somebody else opened one between the read and the write. That
      // is the unique partial index doing its job, and it is not an error: the
      // step is waiting to be checked either way, which is what the caller
      // asked for.
      if (approval !== null) {
        await this.deps.events.recordEvent({
          tenantId,
          verb: "job.step_advanced",
          objectId: job.id,
          actor,
          payload: {
            stepKey: step.stepKey,
            from: "blocked",
            to: "blocked",
            executor: step.executor,
            awaitingCheck: true,
            policyKey,
            // Whether a rule was actually in force, so "why was this approved by
            // an associate" is answerable. Never WHO — that is on the row.
            policyResolved: resolved !== null,
          },
        });
      }
      return held;
    }

    const done = await this.deps.steps.transition(tenantId, step.id, "blocked", {
      status: "done",
      at,
      performedBy,
    });
    // Lost the race with another writer — somebody else completed it between the
    // read and the write. Their record stands; ours would only overwrite it.
    if (!done) throw new StepNotWaiting(step.stepKey, "done");

    await this.deps.events.recordEvent({
      tenantId,
      verb: "job.step_advanced",
      objectId: job.id,
      actor,
      payload: { stepKey: step.stepKey, from: "blocked", to: "done", executor: step.executor },
    });

    // Immediately, not on the next tick. Finishing a step is what makes the next
    // ones ready, and a person who ticks something and sees nothing change
    // concludes the button did not work.
    await this.advance(tenantId, job, actor);
    return done;
  }

  /**
   * The `verification_policy` key this step's PINNED template names, or null.
   *
   * From the pin, never from what is in force, for the reason the pin exists at
   * all: a firm adding a review step to its process in April must not
   * retroactively put a March job's finished work in front of a reviewer.
   *
   * A job with no pinned template has not started, so no step of it can be
   * being completed. A template that no longer parses answers null, which is
   * the same fact `TemplateUnreadable` reports elsewhere but must not throw
   * here — refusing to let somebody tick off finished work because a config row
   * went bad would strand the job entirely.
   */
  private async policyKeyFor(tenantId: string, job: Job, stepKey: string): Promise<string | null> {
    if (job.templateVersionId === null) return null;
    const template = await this.deps.templates.pinnedTemplate(tenantId, job.templateVersionId);
    const def = template?.steps.find((s) => s.key === stepKey) ?? null;
    return def?.verificationPolicyKey ?? null;
  }

  // ── the verification queue (T2.9) ──────────────────────────────────────────

  /**
   * Everything at this firm waiting to be checked, oldest first.
   *
   * The whole firm's, not "mine", and that is deliberate. Under a rank
   * threshold there is no "mine" — any Manager may take any of it — and a queue
   * filtered to what the viewer can act on hides the fact that six filings have
   * been sitting for a week because nobody senior enough is looking. The
   * ELIGIBILITY of the viewer rides on each row instead, so a screen can offer
   * the button on the ones they may take and say why on the ones they may not.
   *
   * Oldest first, by when the work was submitted. NOT by an SLA due date: the
   * firm has not given its internal turnaround times (client ask 3.4 is open),
   * and `service.slaDays` has no writer with a real number in it. Ordering by a
   * date this code invented would be a priority the firm never set.
   */
  async pendingChecks(tenantId: string, viewer: string | null): Promise<readonly CheckOnDesk[]> {
    const pending = await this.deps.checks.listPending(tenantId);
    if (pending.length === 0) return [];
    return this.withEligibility(tenantId, pending, viewer);
  }

  /** Every check this job has ever had, the rejections included — the job
   *  screen's read. A sent-back step that was later approved shows both, which
   *  is the only place "this took two goes" is visible. */
  async checksForJob(
    tenantId: string,
    jobId: string,
    viewer: string | null,
  ): Promise<readonly CheckOnDesk[]> {
    const rows = await this.deps.checks.listForJob(tenantId, jobId);
    if (rows.length === 0) return [];
    return this.withEligibility(tenantId, rows, viewer);
  }

  /**
   * A person approves or sends back somebody else's work.
   *
   * Every refusal here has a WALL underneath it and that is the arrangement, not
   * a duplication: the CHECK in 0048 is what holds against a script, an import
   * or an agent, and these are what a person is TOLD. A constraint violation
   * reaching a browser as "internal error" is precisely the fifth bug T2.8 found
   * by opening the page, and it was the same shape — a rule enforced only in the
   * database, refused in no words.
   */
  async decideCheck(
    input: {
      readonly tenantId: string;
      readonly approvalId: string;
      readonly decision: "approved" | "rejected";
      readonly notes: string | null;
    },
    actor: Actor,
    decidedBy: string,
  ): Promise<JobStep> {
    const approval = await this.deps.checks.findById(input.tenantId, input.approvalId);
    if (!approval) throw new ApprovalNotFound(input.approvalId);
    if (approval.decision !== "pending") {
      throw new ApprovalAlreadyDecided(input.approvalId, approval.decision);
    }

    const notes = input.notes === null ? null : input.notes.trim();
    // Refused HERE as well as by the CHECK, for `CorrectionChangedNothing`'s
    // reason: this is the one a PERSON hits, by clicking Send back and typing
    // nothing, and they need a sentence rather than a constraint name.
    if (input.decision === "rejected" && (notes === null || notes === "")) {
      throw new RejectionNeedsAReason();
    }

    const step = await this.deps.steps.findById(input.tenantId, approval.jobStepId);
    if (!step) throw new StepNotFound(approval.jobStepId);
    const job = await this.deps.jobs.findById(input.tenantId, approval.jobId);
    if (!job) throw new JobNotFound(approval.jobId);

    const eligibility = await this.eligibilityOf(input.tenantId, approval, decidedBy);
    if (!eligibility.eligible && eligibility.reason !== null) {
      throw new NotEligibleToCheck(eligibility.reason);
    }

    const at = this.deps.clock.now().toISOString();
    const decided = await this.deps.checks.decide(input.tenantId, approval.id, {
      decision: input.decision,
      notes,
      decidedBy,
      decidedAt: at,
    });
    // Somebody else answered between the read and the write. Their decision is
    // part of the audit record and ours would overwrite it.
    if (!decided) throw new ApprovalAlreadyDecided(input.approvalId, "decided");

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      // The two verbs registered in the event contract with no writer since the
      // contract was written. They have one now.
      verb: input.decision === "approved" ? "output.approved" : "output.rejected",
      objectId: approval.id,
      actor,
      // Never the note. "Sent back" is the fact; WHY is prose that can name a
      // client, and this log cannot be erased. The note lives on the row, which
      // can be corrected and is not the audit trail.
      payload: {
        jobId: approval.jobId,
        stepKey: step.stepKey,
        policyKey: approval.policyKey,
        checkedUnderPolicy: approval.policyVersionId !== null,
      },
    });

    if (input.decision === "rejected") {
      // The step does NOT move. Rejecting is not doing the work — somebody has
      // to redo it and submit it again, and that second attempt opens a SECOND
      // approval row, because "it was sent back once" is part of the record.
      // The same shape a rejected agent proposal takes.
      return step;
    }

    const done = await this.deps.steps.transition(input.tenantId, step.id, "blocked", {
      status: "done",
      at,
      // The MAKER, not the checker. This column answers "who did the work", and
      // overwriting it with the approver would erase the left-hand side of the
      // rule that was just enforced — and make every checked step look as though
      // the reviewer had done it.
      performedBy: step.performedBy ?? undefined,
    });
    if (!done) throw new StepNotWaiting(step.stepKey, "done");

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      verb: "job.step_advanced",
      objectId: approval.jobId,
      actor,
      payload: {
        stepKey: step.stepKey,
        from: "blocked",
        to: "done",
        executor: step.executor,
        checked: true,
      },
    });

    // Immediately, for `completeStep`'s reason — an approval is what makes the
    // rest of the job ready, and a reviewer who approves something and sees the
    // job sit still concludes it did not go through.
    await this.advance(input.tenantId, job, actor);
    return done;
  }

  /**
   * Who, of the firm's own staff, may check this particular piece of work.
   *
   * Returned as the WHOLE roster with a verdict and a reason on each, not as a
   * filtered list. A screen that shows four eligible names and silently omits
   * the fifth cannot answer "why can Priya not approve this", which is the
   * question somebody actually asks — and the answer ("she is ungraded", "she
   * is the one who did it") is the thing that gets fixed.
   */
  async eligibleCheckers(
    tenantId: string,
    approvalId: string,
  ): Promise<readonly CheckerVerdict[]> {
    const approval = await this.deps.checks.findById(tenantId, approvalId);
    if (!approval) throw new ApprovalNotFound(approvalId);

    const [policy, maker, candidates] = await Promise.all([
      this.policyOf(tenantId, approval),
      this.makerOf(tenantId, approval),
      this.candidates(tenantId),
    ]);

    return candidates.map((c) => ({
      userId: c.candidate.userId,
      displayName: c.candidate.displayName,
      gradeName: c.candidate.gradeName,
      ...isEligible(c.candidate, maker, policy),
    }));
  }

  /**
   * The rule this check was opened under.
   *
   * PINNED, always — `pinnedPolicy`, never `publishedPolicy`. A firm that raises
   * its review bar this afternoon must not find this morning's open checks
   * suddenly unapprovable by the people who were already looking at them, and an
   * audit asking "who was allowed to approve this" must get March's answer.
   *
   * Null when the step named no policy, or named one the firm had already
   * withdrawn when the check opened. Then maker != checker is the whole rule,
   * which `isEligible` applies with a null policy.
   */
  private async policyOf(
    tenantId: string,
    approval: StepApproval,
  ): Promise<VerificationPolicy | null> {
    if (approval.policyVersionId === null) return null;
    const resolved = await this.deps.policies.pinnedPolicy(tenantId, approval.policyVersionId);
    return resolved?.policy ?? null;
  }

  /** The maker, WITH their own reporting line — the reporting-line rule asks who
   *  THEY report to, which is a fact about them and not about the candidate. */
  private async makerOf(tenantId: string, approval: StepApproval): Promise<Maker | null> {
    if (approval.submittedBy === null) return null;
    const staff = await this.deps.checkers.activeStaff(tenantId);
    const row = staff.find((s) => s.userId === approval.submittedBy);
    // A maker who has since been deactivated still made the work. Their
    // reporting line is gone with their active membership, which a
    // `reporting_line` policy correctly reads as "nobody is their manager any
    // more" — and the firm falls back to the rank half, or to nobody, visibly.
    return { userId: approval.submittedBy, reportsToUserId: row?.reportsToUserId ?? null };
  }

  /**
   * The firm's staff as candidates, with `work:write` already resolved.
   *
   * Permissions are looked up ONCE PER ROLE rather than once per person: a
   * hundred-person firm has five roles, and the alternative is a hundred config
   * reads to render one screen — the per-row lookup this codebase has now been
   * caught by five times.
   */
  private async candidates(
    tenantId: string,
  ): Promise<readonly { readonly candidate: CheckerCandidate }[]> {
    const staff = await this.deps.checkers.activeStaff(tenantId);
    const byRole = new Map<string, readonly Permission[]>();
    for (const role of new Set(staff.map((s) => s.role))) {
      byRole.set(role, await this.deps.permissions.permissionsFor(tenantId, role));
    }
    return staff.map((s) => ({
      candidate: {
        userId: s.userId,
        displayName: s.displayName,
        gradeRank: s.gradeRank,
        gradeName: s.gradeName,
        canWrite: (byRole.get(s.role) ?? []).includes("work:write"),
      },
    }));
  }

  /** One person's verdict on one check — what `decideCheck` refuses on, and what
   *  a queue row carries so the screen knows whether to offer the button. */
  private async eligibilityOf(
    tenantId: string,
    approval: StepApproval,
    userId: string,
  ): Promise<Eligibility> {
    const [policy, maker, candidates] = await Promise.all([
      this.policyOf(tenantId, approval),
      this.makerOf(tenantId, approval),
      this.candidates(tenantId),
    ]);
    const me = candidates.find((c) => c.candidate.userId === userId);
    // Not on the active roster at all. Their session resolved, so they hold a
    // membership; this is the deactivated-between-requests case, and it is a
    // refusal rather than a crash.
    if (!me) return { eligible: false, reason: "NO_WORK_PERMISSION" };
    return isEligible(me.candidate, maker, policy);
  }

  /**
   * Attach the viewer's verdict to a list of checks, resolving the roster ONCE.
   *
   * The loop matters: a queue of thirty rows would otherwise re-read the staff
   * list and every role's permissions thirty times. The policy still resolves
   * per row, because each row pins its own version and two rows can legitimately
   * have been opened under different ones — which is exactly the case a firm
   * that revised its rule this week produces.
   */
  private async withEligibility(
    tenantId: string,
    rows: readonly PendingCheck[],
    viewer: string | null,
  ): Promise<readonly CheckOnDesk[]> {
    const candidates = await this.candidates(tenantId);
    const me = viewer === null ? undefined : candidates.find((c) => c.candidate.userId === viewer);

    const out: CheckOnDesk[] = [];
    for (const row of rows) {
      const policy = await this.policyOf(tenantId, row.approval);
      const maker = await this.makerOf(tenantId, row.approval);
      const verdict: Eligibility =
        me === undefined
          ? { eligible: false, reason: "NO_WORK_PERMISSION" }
          : isEligible(me.candidate, maker, policy);
      out.push({ ...row, rule: policy?.rule ?? null, viewer: verdict });
    }
    return out;
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
    // WHOSE DESK, BY DEFAULT (0301): the Dept SPOC on this client, when they
    // are inside the step's band. Outside it — an Analyst's step on a client
    // whose SPOC is a Director — the step starts on nobody's desk and the job
    // page says so, rather than routing work to somebody the process says
    // should not do it. The umbrella task already goes to the same person.
    // The assignment window is a pair of DATE columns, and the day a job opens
    // is the firm's day (0071), not Greenwich's.
    const today = dayInZone(this.deps.clock.now().toISOString(), await this.deps.timeZones.timeZoneFor(tenantId));
    const spoc = await this.deps.desks.spocFor(tenantId, job.id, today);
    const spocRank =
      spoc === null
        ? null
        : ((await this.deps.checkers.activeStaff(tenantId)).find((m) => m.userId === spoc)?.gradeRank ?? null);
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
      assigneeUserId:
        s.executor === "human" && spoc !== null && withinBand(spocRank, s.performer) ? spoc : null,
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
      for (const r of rows) {
        if (r.assigneeUserId === null) continue;
        await this.deps.events.recordEvent({
          tenantId,
          verb: "job.step_assigned",
          objectId: job.id,
          actor,
          payload: { stepKey: r.stepKey, assigneeUserId: r.assigneeUserId, previousAssigneeUserId: null, how: "spoc" },
        });
      }
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
          // The OPERATOR rides along now. Without it "expected: IN, actual: AE"
          // reads as a plain mismatch whichever way the rule pointed, and
          // "how often does a not_in rule fire" would be unanswerable.
          op: def.condition.op,
          expected: def.condition.value,
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

      // A person's step, or a machine's that nobody has built yet. Both wait, and
      // they are the same state on purpose: the firm's work carries on, and an
      // `agent` step sitting `blocked` is exactly the visible fact that an agent
      // is missing. No note is stored for it — the executor and the status say
      // it between them, and a stored sentence would be prose duplicating a
      // fact two columns already hold.
      //
      // `agent_with_approval` MOVED OUT of this branch in T2.8, and it was a real
      // gap. `waitsForAPerson` returns true for it, so it used to be blocked
      // here and `agents.run` was never reached — the machine produced nothing,
      // and the person had nothing to approve. Its own comment said "the machine
      // produces the output and a PERSON decides whether it stands", and the
      // code did only the second half. It runs the agent now; what it will never
      // do is commit unattended, whatever the confidence says.
      const machine = runsAMachine(step.executor);
      const noAgent = machine && !this.deps.agents.canRun(step.stepKey);
      if (!machine || noAgent) {
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
      const { model, promptVersion } = this.deps.agents.provenance();

      // A FAILURE RECORDS NO RUN. `agent_run` holds what a machine produced,
      // and a machine that gave up produced nothing — a row with an invented
      // proposal would put a fabricated answer into the accuracy record.
      if (!outcome.done) {
        const failed = await this.deps.steps.transition(tenantId, running.id, "running", {
          status: "failed",
          at,
          outcomeNote: outcome.note,
        });
        if (!failed) continue;
        advanced += 1;
        await this.deps.events.recordEvent({
          tenantId,
          verb: "job.step_failed",
          objectId: job.id,
          actor,
          payload: { stepKey: step.stepKey, executor: step.executor, model, promptVersion },
        });
        continue;
      }

      // THE GUARDRAIL, decided here and enforced by a CHECK on the insert below.
      //
      // The thresholds are read LIVE and then COPIED onto the run, because "was
      // this allowed" must be answerable against the numbers in force at the
      // moment of judgement rather than whatever is published a year later.
      // Absent config is not an error and not a default: it is `ASK_A_PERSON`,
      // which commits nothing.
      const published = await this.deps.tiers.publishedTiers(tenantId);
      const tiers = published?.tiers ?? ASK_A_PERSON;
      const approvalRequired = step.executor === "agent_with_approval";
      const decision = decideFor(outcome.confidence, tiers, approvalRequired);

      const committing = decision === "committed";
      const settled = await this.deps.steps.transition(tenantId, running.id, "running", {
        status: committing ? "done" : "blocked",
        at,
      });
      if (!settled) continue;

      // Written AFTER the step has settled, so a run row never describes an
      // action the step did not actually take.
      const run = await this.deps.runs.record({
        id: this.deps.ids.newId(),
        tenantId,
        jobId: job.id,
        jobStepId: settled.id,
        confidence: outcome.confidence,
        autoCommitAt: tiers.autoCommitAt,
        reviewAt: tiers.reviewAt,
        tierVersionId: published?.versionId ?? null,
        decision,
        approvalRequired,
        proposed: outcome.proposed,
        // A commit applies its own proposal, at the same moment and by nobody.
        // Anything else has nothing applied until a person decides.
        applied: committing ? outcome.proposed : null,
        model,
        promptVersion,
      });

      advanced += 1;
      if (!committing) awaitingPeople += 1;
      // `agent_run.completed` and `agent_run.escalated` have been in the verb
      // registry since the ledger was written and NOTHING has ever emitted
      // them — the "registered feature with no writer" shape this codebase keeps
      // catching. T2.8 is their writer. The object is the RUN, not the job,
      // which is what the registry already says they are about.
      await this.deps.events.recordEvent({
        tenantId,
        verb: decision === "escalated" ? "agent_run.escalated" : "agent_run.completed",
        objectId: run.id,
        actor,
        // The CONFIDENCE and the bar it was judged against, never the proposal
        // itself: the ledger holds machine facts and cannot be erased, and an
        // agent's output can carry a client's own data.
        payload: {
          stepKey: step.stepKey,
          executor: step.executor,
          decision,
          confidence: outcome.confidence,
          autoCommitAt: tiers.autoCommitAt,
          reviewAt: tiers.reviewAt,
          model,
          promptVersion,
          ...(committing ? { from: "running", to: "done" } : {}),
        },
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
  condition: {
    readonly fact: string;
    readonly op: string;
    readonly value: string | readonly string[];
  },
  subject: JobSubject | null,
): { readonly holds: boolean; readonly actual: string | null; readonly why: string } {
  const actual = resolveFact(condition.fact, subject);

  // FIRST, AND BEFORE THE OPERATOR IS EVEN LOOKED AT. On a negative operator
  // this is the whole subtlety: "the jurisdiction is not IN" reads as TRUE when
  // the jurisdiction is unknown, and it is not true — it is unknown. Evaluating
  // `not_equals` against a null would make a blank field silently satisfy a
  // condition, which is the same failure as skipping on one, arrived at from
  // the opposite side.
  if (actual === null) {
    return {
      holds: true,
      actual: null,
      why: `${condition.fact} is not stated, so the step was kept`,
    };
  }

  const holds = compare(actual, condition.op, condition.value);
  return { holds, actual, why: explain(condition.fact, actual, condition.op, condition.value) };
}

/**
 * The four comparisons, and the default that keeps the step.
 *
 * An operator this function has not learnt is treated as "holds", for
 * `resolveFact`'s reason: a template naming something the engine cannot
 * evaluate must not silently delete steps from a process. The config validator
 * refuses an unknown operator at the write, so this is the second wall rather
 * than the first.
 */
function compare(actual: string, op: string, value: string | readonly string[]): boolean {
  switch (op) {
    case "equals":
      return actual === value;
    case "not_equals":
      return actual !== value;
    case "in":
      return Array.isArray(value) && value.includes(actual);
    case "not_in":
      return Array.isArray(value) && !value.includes(actual);
    default:
      return true;
  }
}

/**
 * Why a step was skipped, in words, for the note on the row. The LEDGER gets
 * the fact and the values instead — a sentence does not GROUP BY.
 *
 * A `switch` with a default, mirroring `compare`, and NOT a ternary chain. The
 * chain was the first draft and it had a real bug: an operator neither branch
 * recognised fell through to the `not_in` arm and called `.join` on a string,
 * so a template naming an unknown operator crashed the sweep instead of keeping
 * the step. `compare` had already returned "keep" correctly — the explanation
 * is what threw. Found by the test for exactly that case.
 */
function explain(
  fact: string,
  actual: string,
  op: string,
  value: string | readonly string[],
): string {
  const list = Array.isArray(value) ? value.join(", ") : String(value);
  let applies: string;
  switch (op) {
    case "equals":
      applies = `only when it is ${JSON.stringify(value)}`;
      break;
    case "not_equals":
      applies = `only when it is anything but ${JSON.stringify(value)}`;
      break;
    case "in":
      applies = `only when it is one of ${list}`;
      break;
    case "not_in":
      applies = `only when it is none of ${list}`;
      break;
    default:
      applies = `under a rule this engine cannot read (${JSON.stringify(op)}), so it was kept`;
  }
  return `${fact} is ${JSON.stringify(actual)}, and this step applies ${applies}`;
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
