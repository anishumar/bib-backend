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
  StepNoLongerNeeded,
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
import { resolveOwner } from "../../domain/workitem/model";
import type { OwnerSource } from "../../domain/workitem/model";
import type { StepBand } from "../../domain/orchestrator/model";
import {
  NotStaffHere,
  NotYourStep,
  PerformerOutOfBand,
  StepSettled,
} from "../../domain/orchestrator/errors";
// T6.15: a step's own two lists, and the gates they put on Done and Approve.
import type {
  CheckListKind,
  ListTally,
  MarkOutcome,
  StepCheckMark,
} from "../../domain/orchestrator/model";
import { NOT_APPLICABLE_NOTE_MAX, openLines, tallyOf } from "../../domain/orchestrator/model";
import {
  NotApplicableNeedsAReason,
  SubStepNotFound,
  SubStepsOpen,
} from "../../domain/orchestrator/errors";
import { ReviewPointNotFound, ReviewPointsOpen } from "../../domain/verification/errors";
import type { StepCheckRepository } from "./ports";

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
  /** The ticks on a step's sub-steps and on a check's review points (T6.15). */
  readonly stepChecks: StepCheckRepository;
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

/**
 * One line of a step's list as a screen reads it (T6.15): the label from the
 * PINNED template, in the template's order, and who settled it and when.
 * `outcome` null is open, whether nobody ever touched it or somebody ticked it
 * and took the tick back.
 */
export interface CheckLineView {
  readonly key: string;
  readonly label: string;
  readonly outcome: MarkOutcome | null;
  /** The reason, on "not applicable" only. */
  readonly note: string | null;
  readonly markedBy: { readonly userId: string; readonly displayName: string } | null;
  readonly markedAt: string | null;
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
  /** The step's sub-steps (T6.15), empty when its process names none. */
  readonly subSteps: readonly CheckLineView[];
  /** How many of them are still open: the same count `completeStep` refuses
   *  on, so the Done button and the 409 cannot disagree. `viewer.mayComplete`
   *  keeps its meaning (WHO may tick it); this says whether it is READY. */
  readonly subStepsOpen: number;
}

/** A step a person asked to finish, past the sub-step gate: its pinned
 *  definition, read once for the gate, the move's own guard and the check
 *  policy. The counts for the transition event are NOT carried from the gate:
 *  they are read again after the move, when the list can no longer change
 *  (`subStepCounts`), so the event says what was actually submitted. */
interface SubStepGate {
  readonly def: TemplateStep | null;
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
  /** THIS check's review points (T6.15): the pinned step's lines with this
   *  round's ticks. A second round after a send-back reads them all open,
   *  because its marks are keyed on its own approval. */
  readonly reviewPoints: readonly CheckLineView[];
  /** How many are still open: what `decideCheck` refuses Approve on. */
  readonly reviewPointsOpen: number;
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

    const job = await this.deps.jobs.findById(input.tenantId, input.jobId);
    if (!job) throw new JobNotFound(input.jobId);

    // THE SUB-STEP GATE (T6.15), the same one `completeStep` applies: a person
    // accepting what a machine produced is saying the work is DONE, so they
    // are held to the step's list exactly as somebody ticking it by hand is.
    // Checked BEFORE the verdict is written, because a proposal
    // recorded as accepted on a step that then refused to finish would be an
    // answer standing on work that is not done. A rejection finishes nothing,
    // so it is never gated.
    //
    // One gap is left, stated rather than hidden: the move after the verdict
    // is guarded too (`finishOrSendForChecking`), and a tick taken back in the
    // instant between this read and that move refuses the move AFTER the
    // verdict is written. The answer then stands as accepted and the step stays
    // waiting, with no proposal on it: an ordinary open step, finished with
    // Done once the line is ticked. Closing it would mean the verdict and the
    // move in one transaction, across two repositories.
    //
    // NO DESK OR BAND RULE HERE, and that predates T6.15: deciding a machine's
    // answer has never checked whose desk the step is on (T2.8). Ticking its
    // sub-steps does (`markSubStep` shares `completeStep`'s rules), so somebody
    // who may not tick them can still accept once the desk holder has.
    const gate: SubStepGate =
      input.outcome === "rejected"
        ? { def: null }
        : await this.subStepGate(input.tenantId, job, step, await this.pinnedStepDef(input.tenantId, job, step.stepKey));

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
    return this.finishOrSendForChecking(input.tenantId, job, step, decidedBy, actor, gate);
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
    // A step withdrawn because its rule stopped applying (0304) gets its own
    // sentence. "skipped, not waiting for anybody" is true and tells somebody
    // whose step just vanished from their desk nothing about why.
    if (step.status === "skipped") throw new StepNoLongerNeeded(step.stepKey, step.outcomeNote);
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

    const def = await this.pinnedStepDef(input.tenantId, job, step.stepKey);
    await this.assertMayDo(input.tenantId, step, performedBy, def?.performer ?? null);

    // THE SUB-STEP GATE (T6.15). After the desk, so somebody who may not do
    // the step at all is told that rather than which lines are open; before
    // anything is written, so a refused Done moves nothing.
    const gate = await this.subStepGate(input.tenantId, job, step, def);

    return this.finishOrSendForChecking(input.tenantId, job, step, performedBy, actor, gate);
  }

  /**
   * WHOSE DESK (0301), and whether this person may do the step at all. Shared
   * by ticking a step done and ticking one of its sub-steps (T6.15), because a
   * sub-step is the same work in smaller pieces: somebody who could not tick
   * the step must not be able to tick it line by line either.
   *
   * A step on somebody else's desk is theirs to tick; taking it first is one
   * click and one ledger row, and it is what makes `performed_by` an answer
   * rather than a coincidence. A step on nobody's desk may be ticked by anybody
   * the process's band allows.
   */
  private async assertMayDo(tenantId: string, step: JobStep, userId: string, band: StepBand | null): Promise<void> {
    const staff = await this.deps.checkers.activeStaff(tenantId);
    if (step.assigneeUserId !== null && step.assigneeUserId !== userId) {
      const holder = staff.find((m) => m.userId === step.assigneeUserId);
      throw new NotYourStep(step.stepKey, holder?.displayName ?? "somebody else");
    }
    if (band !== null) {
      const me = staff.find((m) => m.userId === userId);
      if (!withinBand(me?.gradeRank ?? null, band)) {
        throw new PerformerOutOfBand(step.stepKey, me?.displayName ?? "you", me?.gradeName ?? null, bandLabel(band));
      }
    }
  }

  /**
   * Refuse to finish a step while any of its sub-steps is open (T6.15).
   *
   * A step whose pinned process names no sub-steps, or whose pinned version no
   * longer reads, passes with nothing to say: every job pinned before T6.15
   * behaves exactly as it did, and a job must never be stranded because a
   * config row went bad (`pinnedStepDef`'s reason). Only then are the marks
   * read, so a step with no list costs no query.
   *
   * THIS READ IS FOR THE SENTENCE, NOT FOR THE MOVE. It names what is left, in
   * the order the process wrote it. The move itself is guarded again under the
   * step's row lock (`finishOrSendForChecking`), because a tick taken back
   * between here and there, from a second tab or by a colleague on a step on
   * nobody's desk, would otherwise finish the step with a line open.
   */
  private async subStepGate(tenantId: string, job: Job, step: JobStep, def: TemplateStep | null): Promise<SubStepGate> {
    const lines = def?.checklist ?? [];
    if (lines.length === 0) return { def };
    const marks = outcomesOf(marksOn(await this.deps.stepChecks.listForJob(tenantId, job.id), "checklist", step.id));
    const open = openLines(lines, marks);
    if (open.length > 0) throw new SubStepsOpen(step.stepKey, step.label, open.map((l) => l.label));
    return { def };
  }

  /**
   * How a step's sub-steps stand, for a transition event: `{ subSteps }` with
   * the counts, or nothing at all for a step with no list. Read AFTER the move,
   * once the list is closed to marks, so the counts are the list that was
   * actually submitted rather than the one the gate saw a moment earlier.
   */
  private async subStepCounts(
    tenantId: string,
    job: Job,
    step: JobStep,
    def: TemplateStep | null,
  ): Promise<{ readonly subSteps?: ListTally }> {
    const lines = def?.checklist ?? [];
    if (lines.length === 0) return {};
    const marks = outcomesOf(marksOn(await this.deps.stepChecks.listForJob(tenantId, job.id), "checklist", step.id));
    return { subSteps: tallyOf(lines, marks) };
  }

  /**
   * Why a move guarded on the sub-steps was refused, in words (T6.15): the
   * guard answers only "not now", and a person needs to know which "not".
   * Read again, because the answer is whatever changed after the gate.
   */
  private async whyNotFinished(tenantId: string, job: Job, step: JobStep, def: TemplateStep | null): Promise<Error> {
    const now = await this.deps.steps.findById(tenantId, step.id);
    if (now?.status === "skipped") return new StepNoLongerNeeded(step.stepKey, now.outcomeNote);
    if (now?.status !== "blocked") return new StepNotWaiting(step.stepKey, now?.status ?? "done");
    const marks = outcomesOf(marksOn(await this.deps.stepChecks.listForJob(tenantId, job.id), "checklist", step.id));
    const open = openLines(def?.checklist ?? [], marks);
    if (open.length > 0) return new SubStepsOpen(step.stepKey, step.label, open.map((l) => l.label));
    // Settled and still waiting, yet the move lost: somebody else's move got
    // there first, the ordinary race every transition here reads as this.
    return new StepNotWaiting(step.stepKey, "done");
  }

  /**
   * Why a sub-step mark found its list closed (T6.15). The service read the
   * step as open a moment before; the mark's own check, under the step's lock,
   * found it otherwise, and this says what it found.
   */
  private async whySubStepsLocked(tenantId: string, step: JobStep): Promise<Error> {
    const now = await this.deps.steps.findById(tenantId, step.id);
    if (now?.status === "skipped") return new StepNoLongerNeeded(step.stepKey, now.outcomeNote);
    if (now?.status !== "blocked") return new StepNotWaiting(step.stepKey, now?.status ?? "done");
    if (await this.deps.checks.findOpenForStep(tenantId, step.id)) return new AwaitingCheck(step.stepKey);
    // Approved a moment ago and about to be done: the list that was approved
    // is closed too, and "done" is what it is about to be.
    return new StepNotWaiting(step.stepKey, "done");
  }

  /**
   * Why a decision on a check was not recorded (T2.9, T6.15): somebody else
   * decided it first, which is what a lost race always meant here, or, on
   * Approve, a review point (or a sub-step) was taken back after the gate read
   * the lists. Read again, for the same reason as `whyNotFinished`.
   */
  private async whyNotDecided(
    tenantId: string,
    approval: StepApproval,
    job: Job,
    step: JobStep,
    def: TemplateStep | null,
  ): Promise<Error> {
    const now = await this.deps.checks.findById(tenantId, approval.id);
    if (now !== null && now.decision !== "pending") return new ApprovalAlreadyDecided(approval.id, now.decision);
    const reviewLines = def?.reviewPoints ?? [];
    const subLines = def?.checklist ?? [];
    if (reviewLines.length > 0 || subLines.length > 0) {
      const marks = await this.deps.stepChecks.listForJob(tenantId, job.id);
      const open = openLines(reviewLines, outcomesOf(marksOn(marks, "review", approval.id)));
      if (open.length > 0) return new ReviewPointsOpen(step.stepKey, step.label, open.map((l) => l.label));
      const subOpen = openLines(subLines, outcomesOf(marksOn(marks, "checklist", step.id)));
      if (subOpen.length > 0) return new SubStepsOpen(step.stepKey, step.label, subOpen.map((l) => l.label), "checker");
    }
    return new ApprovalAlreadyDecided(approval.id, "decided");
  }

  /**
   * What the job's PINNED process says about one step, or null.
   *
   * From the pin, never from what is in force, for the reason the pin exists at
   * all: a firm adding a review step or a sub-step to its process in April must
   * not retroactively put a March job's finished work in front of a reviewer,
   * or shut a March step behind a list nobody was shown.
   *
   * A job with no pinned template has not started, so no step of it can be
   * being completed. A template that no longer parses answers null, which is the
   * same fact `TemplateUnreadable` reports elsewhere but must not throw here:
   * refusing to let somebody tick off finished work because a config row went
   * bad would strand the job entirely. Null therefore means no band, no check
   * and no list, which is the most permissive reading and the one that keeps
   * work moving.
   */
  private async pinnedStepDef(tenantId: string, job: Job, stepKey: string): Promise<TemplateStep | null> {
    if (job.templateVersionId === null) return null;
    const template = await this.deps.templates.pinnedTemplate(tenantId, job.templateVersionId);
    return template?.steps.find((s) => s.key === stepKey) ?? null;
  }

  /** The grade band the pinned process names for a step, or null. */
  private async bandOf(tenantId: string, job: Job, stepKey: string): Promise<ResolvedTemplate["steps"][number]["performer"]> {
    return (await this.pinnedStepDef(tenantId, job, stepKey))?.performer ?? null;
  }

  // ── a step's own lists: sub-steps and review points (T6.15) ─────────────────

  /**
   * The person whose step it is ticks one of its sub-steps, marks it not
   * applicable with a reason, or takes the tick back (`outcome: null`).
   *
   * THE TICKS ARE LOCKED ONCE THE WORK IS SUBMITTED. Only a `blocked` step with
   * no open check takes a mark: a pending step has not opened, a done one is
   * settled, and a step waiting to be checked is work somebody else is now
   * looking at, so the list they are looking at must not move under them. After
   * a send-back the check is closed and the doer may change their ticks again;
   * nothing about the send-back clears them, because the work behind them is
   * still the work.
   *
   * An undecided machine proposal does NOT lock them: on an
   * `agent_with_approval` step the person accepting the answer ticks the list
   * first, and `decideProposal` holds them to it.
   *
   * No ledger event per tick, for 0051's reason about the task checklist: the
   * row already says who and when, and ten events per step would bury the
   * transitions somebody actually reads. The counts ride on `job.step_advanced`
   * when the step moves.
   */
  async markSubStep(
    input: {
      readonly tenantId: string;
      readonly jobId: string;
      readonly stepKey: string;
      readonly itemKey: string;
      readonly outcome: MarkOutcome | null;
      readonly note: string | null;
    },
    _actor: Actor,
    byUserId: string,
  ): Promise<JobStep> {
    const job = await this.deps.jobs.findById(input.tenantId, input.jobId);
    if (!job) throw new JobNotFound(input.jobId);
    const step = await this.deps.steps.findByKey(input.tenantId, input.jobId, input.stepKey);
    if (!step) throw new StepNotFound(input.stepKey);
    if (step.status === "skipped") throw new StepNoLongerNeeded(step.stepKey, step.outcomeNote);
    if (step.status !== "blocked") throw new StepNotWaiting(step.stepKey, step.status);

    const openCheck = await this.deps.checks.findOpenForStep(input.tenantId, step.id);
    if (openCheck) throw new AwaitingCheck(step.stepKey);

    const def = await this.pinnedStepDef(input.tenantId, job, step.stepKey);
    await this.assertMayDo(input.tenantId, step, byUserId, def?.performer ?? null);

    const line = (def?.checklist ?? []).find((l) => l.key === input.itemKey);
    if (!line) throw new SubStepNotFound(step.stepKey, input.itemKey);

    // The reads above are what a person is told; the write checks again under
    // the step's row lock, and refuses if Done, Approve or a sweep moved the
    // step in between (`StepCheckRepository`).
    const written = await this.writeMark({
      tenantId: input.tenantId,
      list: "checklist",
      jobStepId: step.id,
      stepApprovalId: null,
      line,
      outcome: input.outcome,
      note: input.note,
      byUserId,
    });
    if (!written) throw await this.whySubStepsLocked(input.tenantId, step);
    return step;
  }

  /**
   * Whoever may CHECK a step ticks one of its review points (T6.15), marks it
   * not applicable with a reason, or takes the tick back.
   *
   * Only an eligible checker, by `eligibilityOf` itself, so the rule that
   * decides who may approve is the rule that decides who may tick the points
   * the approval stands on, and maker != checker holds here with no second
   * statement of it: the person who did the work can never tick their own
   * review points.
   *
   * Keyed on the APPROVAL, never the step. A send-back closes this check, the
   * redo opens a new one, and the new one starts with every point open, while
   * this round's ticks stay on this round's row: "it took two goes" keeps what
   * each checker looked at.
   */
  async markReviewPoint(
    input: {
      readonly tenantId: string;
      readonly approvalId: string;
      readonly itemKey: string;
      readonly outcome: MarkOutcome | null;
      readonly note: string | null;
    },
    _actor: Actor,
    byUserId: string,
  ): Promise<CheckOnDesk> {
    const approval = await this.deps.checks.findById(input.tenantId, input.approvalId);
    if (!approval) throw new ApprovalNotFound(input.approvalId);
    if (approval.decision !== "pending") {
      throw new ApprovalAlreadyDecided(input.approvalId, approval.decision);
    }

    const eligibility = await this.eligibilityOf(input.tenantId, approval, byUserId);
    if (!eligibility.eligible && eligibility.reason !== null) {
      throw new NotEligibleToCheck(eligibility.reason);
    }

    const step = await this.deps.steps.findById(input.tenantId, approval.jobStepId);
    if (!step) throw new StepNotFound(approval.jobStepId);
    const job = await this.deps.jobs.findById(input.tenantId, approval.jobId);
    if (!job) throw new JobNotFound(approval.jobId);

    const def = await this.pinnedStepDef(input.tenantId, job, step.stepKey);
    const line = (def?.reviewPoints ?? []).find((l) => l.key === input.itemKey);
    if (!line) throw new ReviewPointNotFound(step.stepKey, input.itemKey);

    const written = await this.writeMark({
      tenantId: input.tenantId,
      list: "review",
      // The APPROVAL's step, never one the caller names, so the pairing the
      // composite foreign key in 0307 insists on is true by construction.
      jobStepId: approval.jobStepId,
      stepApprovalId: approval.id,
      line,
      outcome: input.outcome,
      note: input.note,
      byUserId,
    });
    // Decided between the read above and the write, which checked again under
    // the check's own row lock: a tick must never land on an approval somebody
    // has already given, nor move a point under a Send back.
    if (!written) {
      const now = await this.deps.checks.findById(input.tenantId, approval.id);
      throw new ApprovalAlreadyDecided(input.approvalId, now?.decision ?? "decided");
    }

    const rows = await this.deps.checks.listForJob(input.tenantId, approval.jobId);
    const row = rows.find((r) => r.approval.id === approval.id);
    if (!row) throw new ApprovalNotFound(input.approvalId);
    const [described] = await this.withEligibility(input.tenantId, [row], byUserId);
    if (!described) throw new ApprovalNotFound(input.approvalId);
    return described;
  }

  /**
   * One mark, written or cleared, with the one rule both lists share: "not
   * applicable" needs a reason, trimmed, of a sentence or two. A tick needs
   * none, and a reason sent with one is dropped rather than stored, because the
   * row's reason column means "why this did not apply" and nothing else.
   *
   * False when the repository found the list closed to marks under its lock;
   * the caller says why, because only it knows which list it asked about.
   */
  private async writeMark(m: {
    readonly tenantId: string;
    readonly list: CheckListKind;
    readonly jobStepId: string;
    readonly stepApprovalId: string | null;
    readonly line: { readonly key: string; readonly label: string };
    readonly outcome: MarkOutcome | null;
    readonly note: string | null;
    readonly byUserId: string;
  }): Promise<boolean> {
    if (m.outcome === null) {
      return this.deps.stepChecks.clear({
        tenantId: m.tenantId,
        list: m.list,
        jobStepId: m.jobStepId,
        stepApprovalId: m.stepApprovalId,
        itemKey: m.line.key,
      });
    }
    let note: string | null = null;
    if (m.outcome === "not_applicable") {
      note = (m.note ?? "").trim();
      if (note === "") throw new NotApplicableNeedsAReason(m.line.label);
      if (note.length > NOT_APPLICABLE_NOTE_MAX) throw new NotApplicableNeedsAReason(m.line.label, true);
    }
    const written = await this.deps.stepChecks.upsert({
      id: this.deps.ids.newId(),
      tenantId: m.tenantId,
      jobStepId: m.jobStepId,
      stepApprovalId: m.stepApprovalId,
      list: m.list,
      itemKey: m.line.key,
      label: m.line.label,
      outcome: m.outcome,
      note,
      markedByUserId: m.byUserId,
      markedAt: this.deps.clock.now().toISOString(),
    });
    return written !== null;
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

  /**
   * A job's steps follow its task (2026-09-27): the `JobStepHandover` the work
   * item use case calls when a task is put on somebody's desk.
   *
   * The owner rule hands a job's TASK to its Key Manager or signing partner
   * when the client has no SPOC, and that person is usually outside the
   * steps' band, so the steps start on nobody's desk. Handing the task on is
   * the act that hands the job out, so it moves every human step that is not
   * settled and is held by NOBODY or by the task's PREVIOUS owner, to the new
   * owner, wherever the step's band admits them. A step somebody else took
   * stays theirs: they chose it. A step outside the new owner's band stays
   * where it is, for the job page's hand-over.
   *
   * Each move is a `job.step_assigned` row with `how: "with_task"`, so "why
   * is this step on Kavya's desk" has an answer that is not "somebody handed
   * it over". Returns how many moved. A job or a person that cannot be found
   * moves nothing and says so with a zero: the task's own move has already
   * happened and must not be undone by its steps.
   */
  async adoptUnheldSteps(
    tenantId: string,
    jobId: string,
    fromUserId: string | null,
    toUserId: string,
    actor: Actor,
  ): Promise<number> {
    const job = await this.deps.jobs.findById(tenantId, jobId);
    if (!job) return 0;
    const who = (await this.deps.checkers.activeStaff(tenantId)).find((m) => m.userId === toUserId);
    if (!who) return 0;
    let moved = 0;
    for (const step of await this.deps.steps.listForJob(tenantId, jobId)) {
      if (step.executor !== "human") continue;
      if (step.status === "done" || step.status === "skipped" || step.status === "failed") continue;
      const held = step.assigneeUserId;
      if (held === toUserId) continue;
      if (held !== null && held !== fromUserId) continue;
      const band = await this.bandOf(tenantId, job, step.stepKey);
      if (band !== null && !withinBand(who.gradeRank, band)) continue;
      // Refused in SQL on a step that settled since the read: null back, and
      // the step is simply not counted.
      const after = await this.deps.steps.assign(tenantId, step.id, toUserId);
      if (!after) continue;
      moved += 1;
      await this.deps.events.recordEvent({
        tenantId,
        verb: "job.step_assigned",
        objectId: job.id,
        actor,
        payload: {
          stepKey: step.stepKey,
          assigneeUserId: toUserId,
          previousAssigneeUserId: held,
          how: "with_task",
        },
      });
    }
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
    const defs = new Map((template?.steps ?? []).map((s) => [s.key, s]));
    const staff = await this.deps.checkers.activeStaff(tenantId);
    const byUser = new Map(staff.map((m) => [m.userId, m]));
    const viewer = byUser.get(viewerUserId) ?? null;
    // Every mark on the job in ONE read (T6.15), and only when the process
    // names a sub-step anywhere: a job pinned before T6.15 costs nothing.
    const anyList = (template?.steps ?? []).some((s) => s.checklist.length > 0);
    const marks = anyList ? await this.deps.stepChecks.listForJob(tenantId, jobId) : [];
    return steps.map((step) => {
      const def = defs.get(step.stepKey) ?? null;
      const performer = def?.performer ?? null;
      const subSteps = lineViews(def?.checklist ?? [], marksOn(marks, "checklist", step.id));
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
        subSteps,
        subStepsOpen: subSteps.filter((l) => l.outcome === null).length,
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
    // The step's pinned definition, from the gate both callers pass through
    // first (T6.15). The review policy is read from the same definition: one
    // pinned read where there used to be two.
    gate: SubStepGate,
  ): Promise<JobStep> {
    const at = this.deps.clock.now().toISOString();
    // The `verification_policy` key the PINNED step names, or null for a step
    // nobody checks. From the pin, for `pinnedStepDef`'s reason.
    const policyKey = gate.def?.verificationPolicyKey ?? null;
    // THE MOVE IS GUARDED ON THE SUB-STEPS (T6.15), under the step's row lock,
    // whatever the gate read a moment ago: see `subStepGate`. Empty for a step
    // with no list, which is every step of every process before T6.15, and
    // then the moves below are exactly the ones they always were.
    const subStepKeys = (gate.def?.checklist ?? []).map((l) => l.key);

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
      // The sub-step guard rides on the OPENING, not on the transition above:
      // the transition leaves the step `blocked`, so the list is still open to
      // marks after it, and it is the check opening that closes it. Guarding
      // the insert under the step's lock is what makes the list the checker
      // sees the list that was submitted.
      const approval = await this.deps.checks.openIfAbsent(
        {
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
        },
        subStepKeys,
      );
      if (approval === null && subStepKeys.length > 0 && (await this.deps.checks.findOpenForStep(tenantId, step.id)) === null) {
        // Null with no check open: the guard refused. A line was taken back
        // after the gate read it (or the step moved). Nothing was opened, so
        // the maker recorded above is put back as it was: a refused Done
        // moves nothing, and a step that says who submitted it when nobody's
        // submission stands would read as work waiting that is not.
        await this.deps.steps.transition(tenantId, step.id, "blocked", {
          status: "blocked",
          at,
          performedBy: step.performedBy ?? undefined,
        });
        throw await this.whyNotFinished(tenantId, job, step, gate.def);
      }
      // Otherwise null means somebody else opened one between the read and the
      // write. That is the unique partial index doing its job, and it is not an
      // error: the step is waiting to be checked either way, which is what the
      // caller asked for.
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
            // Counts only, never a label or a reason: the log cannot be erased,
            // and a step with no sub-steps says nothing about them at all.
            ...(await this.subStepCounts(tenantId, job, step, gate.def)),
          },
        });
      }
      return held;
    }

    const done = await this.deps.steps.transition(
      tenantId,
      step.id,
      "blocked",
      { status: "done", at, performedBy },
      subStepKeys,
    );
    // Lost the race with another writer — somebody else completed it between the
    // read and the write. Their record stands; ours would only overwrite it. Or,
    // on a step with sub-steps, a line was taken back after the gate read it,
    // and the guard kept the step open; which of the two is said in words.
    if (!done) {
      throw subStepKeys.length > 0
        ? await this.whyNotFinished(tenantId, job, step, gate.def)
        : new StepNotWaiting(step.stepKey, "done");
    }

    await this.deps.events.recordEvent({
      tenantId,
      verb: "job.step_advanced",
      objectId: job.id,
      actor,
      payload: {
        stepKey: step.stepKey,
        from: "blocked",
        to: "done",
        executor: step.executor,
        ...(await this.subStepCounts(tenantId, job, step, gate.def)),
      },
    });

    // Immediately, not on the next tick. Finishing a step is what makes the next
    // ones ready, and a person who ticks something and sees nothing change
    // concludes the button did not work.
    await this.advance(tenantId, job, actor);
    return done;
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

    // THE REVIEW-POINT GATE (T6.15), on APPROVE ONLY. Sending work back is
    // never held up by it: the checker may find the problem at point three,
    // and making them tick the rest to say so would make the record claim they
    // looked at things they stopped looking at. After eligibility, so somebody
    // who may not check this at all is told that first.
    //
    // AND THE SUB-STEPS, AS A WALL UNDER A WALL. The doer's ticks were closed
    // when the work was submitted and every sub-step mark refuses a step with a
    // check pending (under the step's row lock, `StepCheckRepository`), so
    // through this service an approval cannot find them open. A mark written
    // round the service can, and approving then would finish a step with a line
    // open, so Approve is refused too, with a sentence for the checker: the
    // lines are the doer's, and Send back is how they get to them.
    //
    // THESE READS ARE FOR THE SENTENCE. The decision is guarded again under the
    // check's row lock (the lock every review mark takes), so a point taken back
    // by a second checker between this read and the decision refuses it.
    const def = await this.pinnedStepDef(input.tenantId, job, step.stepKey);
    const reviewLines = def?.reviewPoints ?? [];
    const subLines = def?.checklist ?? [];
    const hasLists = reviewLines.length > 0 || subLines.length > 0;
    if (input.decision === "approved" && hasLists) {
      const marks = await this.deps.stepChecks.listForJob(input.tenantId, job.id);
      const open = openLines(reviewLines, outcomesOf(marksOn(marks, "review", approval.id)));
      if (open.length > 0) throw new ReviewPointsOpen(step.stepKey, step.label, open.map((l) => l.label));
      const subOpen = openLines(subLines, outcomesOf(marksOn(marks, "checklist", step.id)));
      if (subOpen.length > 0) {
        throw new SubStepsOpen(step.stepKey, step.label, subOpen.map((l) => l.label), "checker");
      }
    }

    const at = this.deps.clock.now().toISOString();
    const decided = await this.deps.checks.decide(
      input.tenantId,
      approval.id,
      { decision: input.decision, notes, decidedBy, decidedAt: at },
      input.decision === "approved" && hasLists
        ? { reviewPointKeys: reviewLines.map((l) => l.key), subStepKeys: subLines.map((l) => l.key) }
        : undefined,
    );
    // Somebody else answered between the read and the write. Their decision is
    // part of the audit record and ours would overwrite it. Or, on Approve, a
    // line was taken back after the gate read it; which of the two is said.
    if (!decided) throw await this.whyNotDecided(input.tenantId, approval, job, step, def);

    // Counts only, on both verbs: "sent back with two of six points ticked" is
    // a fact worth a GROUP BY, and which two is prose that stays on the rows.
    // Read AFTER the decision, once neither list can move (review marks refuse a
    // decided check; sub-step marks refuse one pending or approved), so the
    // counts are the lists the decision was made on.
    const after = hasLists ? await this.deps.stepChecks.listForJob(input.tenantId, job.id) : [];
    const reviewTally =
      reviewLines.length > 0 ? { reviewPoints: tallyOf(reviewLines, outcomesOf(marksOn(after, "review", approval.id))) } : {};
    const subTally =
      subLines.length > 0 ? { subSteps: tallyOf(subLines, outcomesOf(marksOn(after, "checklist", step.id))) } : {};

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
        ...reviewTally,
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
        ...subTally,
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

    // REVIEW POINTS (T6.15). Each row's lines come from its job's PINNED
    // version, which the row carries from the same query that read it; each
    // version is resolved once however many rows share it, and every mark on
    // every row is ONE read, made only when some row has a line to mark.
    const versions = new Map<string, Promise<ResolvedTemplate | null>>();
    const linesOf = async (row: PendingCheck): Promise<readonly { readonly key: string; readonly label: string }[]> => {
      if (row.templateVersionId === null) return [];
      let template = versions.get(row.templateVersionId);
      if (template === undefined) {
        template = this.deps.templates.pinnedTemplate(tenantId, row.templateVersionId);
        versions.set(row.templateVersionId, template);
      }
      return (await template)?.steps.find((s) => s.key === row.stepKey)?.reviewPoints ?? [];
    };
    const lines = await Promise.all(rows.map(linesOf));
    const marks = lines.some((l) => l.length > 0)
      ? await this.deps.stepChecks.listForApprovals(tenantId, rows.map((r) => r.approval.id))
      : [];

    const out: CheckOnDesk[] = [];
    for (const [i, row] of rows.entries()) {
      const policy = await this.policyOf(tenantId, row.approval);
      const maker = await this.makerOf(tenantId, row.approval);
      const verdict: Eligibility =
        me === undefined
          ? { eligible: false, reason: "NO_WORK_PERMISSION" }
          : isEligible(me.candidate, maker, policy);
      const reviewPoints = lineViews(lines[i] ?? [], marksOn(marks, "review", row.approval.id));
      out.push({
        ...row,
        rule: policy?.rule ?? null,
        viewer: verdict,
        reviewPoints,
        reviewPointsOpen: reviewPoints.filter((l) => l.outcome === null).length,
      });
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
    // WHOSE DESK, BY DEFAULT (0301, then 2026-09-27): the job's owner under
    // `resolveOwner`, the ladder the job's task is routed by (SPOC, Key
    // Manager, the person who signs for the firm), when that person is inside
    // the step's band. Outside it (a Key Manager who is a Director, on an
    // Analyst's step) the step starts on nobody's desk and the job page says
    // so, rather than routing work to somebody the process says should not do
    // it: that owner holds the job's TASK, and handing the task on takes these
    // steps with it (`adoptUnheldSteps`). The assignment window is a pair of
    // DATE columns, and the day a job opens is the firm's day (0071).
    const today = dayInZone(this.deps.clock.now().toISOString(), await this.deps.timeZones.timeZoneFor(tenantId));
    const facts = await this.deps.desks.ownerFactsFor(tenantId, job.id, today);
    const ladder = resolveOwner(facts);
    // WHOEVER HOLDS THE JOB'S TASK FIRST. A month's task exists from the
    // period's start and its steps only from the period's end, so the task may
    // already have been handed out; the steps follow that, and are recorded as
    // going with the task unless the ladder would have named the same person.
    const holder = facts.taskHolder;
    const owner: { readonly userId: string | null; readonly how: OwnerSource | "with_task" | null } =
      holder === null
        ? ladder
        : { userId: holder.userId, how: holder.userId === ladder.userId ? ladder.how : "with_task" };
    const ownerId = owner.userId;
    const ownerRank =
      ownerId === null
        ? null
        : ((await this.deps.checkers.activeStaff(tenantId)).find((m) => m.userId === ownerId)?.gradeRank ?? null);
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
        s.executor === "human" && ownerId !== null && withinBand(ownerRank, s.performer) ? ownerId : null,
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
          payload: {
            stepKey: r.stepKey,
            assigneeUserId: r.assigneeUserId,
            previousAssigneeUserId: null,
            how: owner.how ?? "spoc",
          },
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

    skipped += await this.withdrawOpenedSteps(tenantId, job, template, subject, steps, actor);

    if (skipped === 0) return 0;

    // The other half of a branch. Without it, everything downstream of a skipped
    // step waits forever on something that will never be `done`.
    //
    // `cascadeSkips` still takes only PENDING steps, and after 0304 that is still
    // complete rather than a gap: a dependent cannot open before everything it
    // depends on has settled, a settled step is never skipped afterwards, and a
    // step withdrawn below was by definition not settled — so whatever depends on
    // it has not opened either.
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

  /**
   * A step that has OPENED is judged again, and withdrawn if its rule no longer
   * holds and nobody has done anything on it yet (0304).
   *
   * ── WHY THE JUDGEMENT IS NOT ONLY AT THE START ─────────────────────────────
   *
   * The facts a condition reads are not frozen when the step opens. The
   * recurrence comes from the service, read LIVE; the jurisdiction from the
   * entity's registration, which a firm corrects. A step judged once at the
   * start could sit on a desk for weeks after the firm's own rule stopped
   * applying to it, and the only way off that desk was to tick it done — a
   * record of work nobody did, which is worse than the step waiting.
   *
   * ── WHAT IS NEVER WITHDRAWN ───────────────────────────────────────────────
   *
   * Anything with work on it. A step somebody has ticked and sent for checking
   * carries `performed_by`; a step a machine answered carries an undecided
   * proposal. Either way the work EXISTS, and silently discarding it because a
   * catalogue field changed is the failure this engine is built to avoid. It
   * goes on to be checked or decided the ordinary way.
   *
   * And an UNKNOWN fact never withdraws anything — `evaluateCondition`'s rule,
   * unchanged: a blank field keeps the step. Only a definite "no" moves it.
   *
   * ── WHAT THE PERSON SEES, AND WHAT THE LEDGER KEEPS ───────────────────────
   *
   * The step leaves their desk (it is no longer open) and stays on the job's
   * page, dimmed, with its start time kept and a note saying it had opened and
   * why it no longer applies. `assignee_user_id` is left as it was: whose desk
   * it was on is part of that history. The ledger gets the same
   * `job.step_skipped` a skip at the start gets — the fact, the operator, the
   * values — plus `from`, `afterStart` and the assignee's id, so "how often do
   * steps get pulled off somebody's desk" is a query rather than a guess.
   */
  private async withdrawOpenedSteps(
    tenantId: string,
    job: Job,
    template: ResolvedTemplate,
    subject: JobSubject | null,
    steps: readonly JobStep[],
    actor: Actor,
  ): Promise<number> {
    const defs = new Map(template.steps.map((s) => [s.key, s]));
    let withdrawn = 0;
    // Read at most once per walk, and only when a step is actually about to be
    // withdrawn: this pass runs on every sweep of every open job.
    let marks: Promise<readonly StepCheckMark[]> | null = null;

    for (const step of steps) {
      if (step.status !== "blocked" && step.status !== "running") continue;
      const def = defs.get(step.stepKey);
      if (!def?.condition) continue;

      const verdict = evaluateCondition(def.condition, subject);
      if (verdict.holds) continue;

      // Work recorded on it: leave it to finish the ordinary way.
      if (step.performedBy !== null) continue;
      if (await this.deps.runs.openForStep(tenantId, step.id)) continue;
      // A TICKED SUB-STEP IS WORK RECORDED (T6.15). "Bank statements collected"
      // is somebody saying they did part of this step, and discarding it
      // because a catalogue field changed is exactly what this pass refuses to
      // do to a step sent for checking. A "not applicable" counts too: it is a
      // person's judgement about this step, with a reason, and it is on the row.
      if (def.checklist.length > 0) {
        marks ??= this.deps.stepChecks.listForJob(tenantId, job.id);
        const mine = marksOn(await marks, "checklist", step.id);
        if ([...mine.values()].some((m) => m.outcome !== null)) continue;
      }

      const moved = await this.deps.steps.transition(tenantId, step.id, step.status, {
        status: "skipped",
        at: this.deps.clock.now().toISOString(),
        outcomeNote: `This step had already opened and no longer applies: ${verdict.why}.`,
      });
      if (!moved) continue;
      withdrawn += 1;
      await this.deps.events.recordEvent({
        tenantId,
        verb: "job.step_skipped",
        objectId: job.id,
        actor,
        payload: {
          stepKey: step.stepKey,
          fact: def.condition.fact,
          op: def.condition.op,
          expected: def.condition.value,
          actual: verdict.actual,
          from: step.status,
          afterStart: true,
          assigneeUserId: step.assigneeUserId,
        },
      });
    }
    return withdrawn;
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
      // A STEP WITH SUB-STEPS IS NEVER FINISHED UNATTENDED (T6.15). The config
      // validator already refuses sub-steps on an `agent` step, so a published
      // template cannot reach this with any; this is the second wall, for a
      // body that reached the engine another way. Nobody would ever tick the
      // lines of a step a machine closed on its own, so it asks for a person,
      // and a person accepting the answer is held to the list in
      // `decideProposal`. Recorded on the run as `approval_required`, which is
      // what it is: the step needs somebody to say it is done.
      const def = template.steps.find((s) => s.key === step.stepKey);
      const hasSubSteps = (def?.checklist.length ?? 0) > 0;
      const approvalRequired = step.executor === "agent_with_approval" || hasSubSteps;
      const decision = decideFor(outcome.confidence, tiers, approvalRequired);

      const committing = decision === "committed";
      // A COMMITTED ANSWER ON A CHECKED STEP IS STILL CHECKED. 0048 wrote this
      // down on the day checks existed: `submitted_by` is nullable for "a step
      // an agent COMMITTED unattended", and "anybody eligible may check it". The
      // engine never did it, and moved such a step straight to done, so a firm
      // saying "a Manager reviews this" was not reviewed whenever a machine
      // happened to be sure. T6.15 made the hole visible: review points on such
      // a step could never be ticked, because no check ever opened to tick
      // them on. So the step waits `blocked` with a check open and no maker,
      // exactly as 0048 describes; approving it finishes it and advances the
      // job, sending it back leaves it for a person to redo, as for any check.
      const policyKey = def?.verificationPolicyKey ?? null;
      const checked = committing && policyKey !== null;
      const settled = await this.deps.steps.transition(tenantId, running.id, "running", {
        status: committing && !checked ? "done" : "blocked",
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
      if (!committing || checked) awaitingPeople += 1;
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
          ...(committing ? { from: "running", to: checked ? "blocked" : "done" } : {}),
          ...(checked ? { awaitingCheck: true } : {}),
        },
      });

      if (checked) {
        // The check opens the way `finishOrSendForChecking` opens one, against
        // the policy in force now, and with no maker: `performed_by` is null
        // because no person made this, so the database derives a null
        // `submitted_by` and maker != checker has nobody to compare. No
        // sub-step guard, because a machine's step has no sub-steps (the
        // validator refuses them, and a step with any is never committed).
        const resolved = await this.deps.policies.publishedPolicy(tenantId, policyKey);
        const approval = await this.deps.checks.openIfAbsent({
          id: this.deps.ids.newId(),
          tenantId,
          jobId: job.id,
          jobStepId: settled.id,
          policyVersionId: resolved?.versionId ?? null,
          policyKey,
        });
        if (approval !== null) {
          await this.deps.events.recordEvent({
            tenantId,
            verb: "job.step_advanced",
            objectId: job.id,
            actor,
            payload: {
              stepKey: step.stepKey,
              from: "running",
              to: "blocked",
              executor: step.executor,
              awaitingCheck: true,
              policyKey,
              policyResolved: resolved !== null,
            },
          });
        }
      }
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

/**
 * One list's marks on one step (a sub-step) or on one check (a review point),
 * keyed by line. Sub-step marks are found by their STEP and carry no check;
 * review marks by their CHECK, which is what keeps one round's ticks off the
 * next round's list.
 */
function marksOn(
  all: readonly StepCheckMark[],
  list: CheckListKind,
  ownerId: string,
): ReadonlyMap<string, StepCheckMark> {
  const out = new Map<string, StepCheckMark>();
  for (const m of all) {
    if (m.list !== list) continue;
    if ((list === "checklist" ? m.jobStepId : m.stepApprovalId) !== ownerId) continue;
    out.set(m.itemKey, m);
  }
  return out;
}

function outcomesOf(marks: ReadonlyMap<string, StepCheckMark>): ReadonlyMap<string, MarkOutcome | null> {
  return new Map([...marks].map(([k, m]) => [k, m.outcome]));
}

/**
 * A list as the screen reads it: the PINNED template's lines, in its order,
 * each with its mark. The label is the template's, not the row's copy; the two
 * are the same version, so they cannot differ. The marker's name comes from
 * the same query as the mark, so a tick by somebody who has since left still
 * says who.
 */
function lineViews(
  lines: readonly { readonly key: string; readonly label: string }[],
  marks: ReadonlyMap<string, StepCheckMark>,
): readonly CheckLineView[] {
  return lines.map((l) => {
    const m = marks.get(l.key);
    const settled = m !== undefined && m.outcome !== null;
    return {
      key: l.key,
      label: l.label,
      outcome: settled ? m.outcome : null,
      note: settled ? m.note : null,
      markedBy:
        settled && m.markedByUserId !== null
          ? { userId: m.markedByUserId, displayName: m.markedByName ?? "somebody no longer on the roster" }
          : null,
      markedAt: settled ? m.markedAt : null,
    };
  });
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
