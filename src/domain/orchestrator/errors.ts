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
  | "STEP_NOT_A_PERSONS";

export class JobNotFound extends OrchestratorError {
  constructor(jobId: string) {
    super("JOB_NOT_FOUND", `no job ${JSON.stringify(jobId)} at this firm`);
  }
}

export class StepNotFound extends OrchestratorError {
  constructor(ref: string) {
    super("STEP_NOT_FOUND", `no step ${JSON.stringify(ref)} on this job`);
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
      `this firm has no published workflow template ${JSON.stringify(key)}, so a job using it ` +
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
      `the workflow version ${JSON.stringify(versionId)} this job is pinned to does not read ` +
        `as a workflow template. The job is deliberately NOT moved onto the current version: ` +
        `a job that silently changed process is the thing pinning exists to prevent.`,
    );
  }
}

export class StepNotWaiting extends OrchestratorError {
  constructor(stepKey: string, status: string) {
    super(
      "STEP_NOT_WAITING",
      `step ${JSON.stringify(stepKey)} is ${JSON.stringify(status)}, not waiting for anybody. ` +
        `Only a blocked step can be completed by hand — a second completion would overwrite ` +
        `who did it and when.`,
    );
  }
}

export class StepNotAPersons extends OrchestratorError {
  constructor(stepKey: string, executor: string) {
    super(
      "STEP_NOT_A_PERSONS",
      `step ${JSON.stringify(stepKey)} is ${JSON.stringify(executor)} work, so it is not a ` +
        `person's to complete. If it should be, change the step's executor on the template — ` +
        `that is one field, and every job started after it picks the change up.`,
    );
  }
}
