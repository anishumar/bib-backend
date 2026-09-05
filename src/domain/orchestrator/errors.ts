// Sentinel errors — the closed vocabulary of ways walking a job's steps fails.
// They live in the domain so the meaning is owned here; the api layer maps them
// to HTTP status codes (domainerr.ts). Match with `instanceof`, never a string
// search.
//
// A new code here is a COMPILE error until it is mapped: every family's switch
// in `api/domainerr.ts` ends `default: return unmapped(err.code)` and `unmapped`
// takes `never`. That arrangement exists because `StaffGradeError` once shipped
// unmapped and every refusal answered 500 — invisible to unit tests, which
// assert on the thrown sentinel and are perfectly happy.

export class OrchestratorError extends Error {
  constructor(
    readonly code: OrchestratorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type OrchestratorErrorCode =
  | "JOB_NOT_FOUND"
  | "STEP_NOT_FOUND"
  | "NO_TEMPLATE_PUBLISHED"
  | "TEMPLATE_UNREADABLE"
  | "STEP_NOT_WAITING"
  | "PROPOSAL_UNDECIDED"
  | "NOTHING_PROPOSED"
  | "CORRECTION_CHANGED_NOTHING"
  | "AWAITING_CHECK";

export class JobNotFound extends OrchestratorError {
  constructor(jobId: string) {
    super("JOB_NOT_FOUND", `No job ${JSON.stringify(jobId)} at this firm`);
  }
}

export class StepNotFound extends OrchestratorError {
  constructor(ref: string) {
    super("STEP_NOT_FOUND", `No step ${JSON.stringify(ref)} on this job`);
  }
}

export class NoTemplatePublished extends OrchestratorError {
  constructor(key: string) {
    // Not a failure of the job, and the message says so. A firm that has not
    // written its process yet has jobs that WAIT — visibly — which is the only
    // honest state. The alternative is this product inventing a process on the
    // firm's behalf, or a job quietly completing with no work done.
    super(
      "NO_TEMPLATE_PUBLISHED",
      `This firm has no published workflow template ${JSON.stringify(key)}, so a job using it ` +
        `cannot start. The work is not lost — the job waits until a process is published. ` +
        `Write it on the workflow screen and publish it; jobs already waiting pick it up on ` +
        `the next sweep.`,
    );
  }
}

export class TemplateUnreadable extends OrchestratorError {
  constructor(versionId: string) {
    // The pinned-history case. A job resolves the version it STARTED on, which
    // may be years old; if that body no longer parses, the honest answer is to
    // stop and say which version, not to fall back to today's process — the
    // whole point of pinning is that the job does not silently change path.
    super(
      "TEMPLATE_UNREADABLE",
      `The workflow version ${JSON.stringify(versionId)} this job is pinned to does not read ` +
        `as a workflow template. The job is deliberately NOT moved onto the current version: ` +
        `a job that silently changed process is the thing pinning exists to prevent.`,
    );
  }
}

export class StepNotWaiting extends OrchestratorError {
  constructor(stepKey: string, status: string) {
    super(
      "STEP_NOT_WAITING",
      `Step ${JSON.stringify(stepKey)} is ${JSON.stringify(status)}, not waiting for anybody. ` +
        `Only a blocked step can be completed by hand — a second completion would overwrite ` +
        `who did it and when.`,
    );
  }
}

/**
 * A step a machine has answered, which nobody has decided about yet (T2.8).
 *
 * Replaces `StepNotAPersons`, whose case stopped existing: every `blocked` step
 * is now a person's to finish, including an `agent` step nobody built an agent
 * for. What is refused instead is finishing one BEHIND the proposal — ticking
 * "done" on a step where a machine produced an answer records that a person did
 * the work and leaves what the machine said undecided forever, which is exactly
 * the accuracy signal `agent_run` exists to keep.
 */
export class ProposalUndecided extends OrchestratorError {
  constructor(stepKey: string) {
    super(
      "PROPOSAL_UNDECIDED",
      `Step ${JSON.stringify(stepKey)} has an answer from a machine that nobody has ` +
        `decided about. Accept it, correct it, or reject it with a reason — ticking it done ` +
        `would record that a person did the work and lose whether the machine was right.`,
    );
  }
}

/**
 * Somebody tried to accept or correct an answer nothing produced (T2.8).
 *
 * The ordinary case is a `human` step, or a machine step nobody built an agent
 * for: both are blocked and both are finished with the plain Done button. This
 * is what stops a decision route being used as a second way to tick one off,
 * which would write "accepted" against a proposal that never existed and put a
 * fictional point into the accuracy record.
 */
export class NothingProposed extends OrchestratorError {
  constructor(stepKey: string) {
    super(
      "NOTHING_PROPOSED",
      `Step ${JSON.stringify(stepKey)} has no answer from a machine to decide about. It is ` +
        `waiting for a person to do the work and mark it done.`,
    );
  }
}

/**
 * A "correction" that corrected nothing (T2.8).
 *
 * The schema refuses this too, and that CHECK is the real enforcement — it has
 * to hold against an import or an agent. But a constraint violation reaching a
 * person as "internal error" tells them nothing, and this is a mistake somebody
 * makes by clicking Correct and then changing their mind: an acceptance,
 * mis-recorded. Counted as a correction it understates the agent, which is why
 * it is refused rather than quietly stored.
 *
 * FOUND BY RUNNING IT. The database said no and the API answered 500, because a
 * raw `PostgresError` belongs to no domain family. Same shape as the two before
 * it on this project, and the fix is the same: the service refuses it in words,
 * and the CHECK stays as the wall for everything that never reaches the service.
 */
export class CorrectionChangedNothing extends OrchestratorError {
  constructor(stepKey: string) {
    super(
      "CORRECTION_CHANGED_NOTHING",
      `The correction to step ${JSON.stringify(stepKey)} is identical to what the machine ` +
        `proposed. If it was right, accept it — recording it as a correction would say the ` +
        `machine got it wrong, and that number is the only measure of whether it is improving.`,
    );
  }
}

/**
 * Somebody tried to tick off a step that is already waiting to be CHECKED
 * (T2.9).
 *
 * Almost always the maker clicking Done a second time, on a screen that had not
 * refreshed. Without this the second click would find a check already open and
 * silently do nothing — a button that looks like it worked and did not, which
 * is the shape of bug this codebase keeps finding by opening the page.
 */
export class AwaitingCheck extends OrchestratorError {
  constructor(stepKey: string) {
    super(
      "AWAITING_CHECK",
      `Step ${JSON.stringify(stepKey)} is finished and waiting for somebody else to check it. ` +
        `It is not yours to tick off again — and by the firm's own rule it could not be ` +
        `yours to approve either.`,
    );
  }
}
