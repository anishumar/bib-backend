// Sentinel errors for the scheduler. The api layer maps them to HTTP status
// codes (domainerr.ts) — though most of this module is reached by a worker
// rather than a request, and a worker's job is to log and retry, not to answer.

export class SchedulerError extends Error {
  constructor(
    readonly code: SchedulerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type SchedulerErrorCode = "JOB_NOT_FOUND" | "INVALID_TRANSITION" | "INVALID_RECURRENCE";

export class JobNotFound extends SchedulerError {
  constructor(ref: string) {
    super("JOB_NOT_FOUND", `No job ${JSON.stringify(ref)} at this firm`);
  }
}

export class InvalidTransition extends SchedulerError {
  constructor(from: string, to: string) {
    // A job that has finished is finished. The orchestrator will be the second
    // writer here, and a redelivered queue message must not restart work that
    // already completed — that is a duplicate filing, not a retry.
    super(
      "INVALID_TRANSITION",
      `A job cannot go from ${JSON.stringify(from)} to ${JSON.stringify(to)}. ` +
        `Terminal states are final: a job that is done or cancelled stays that way, and work ` +
        `that must happen again is a NEW job with its own cause.`,
    );
  }
}

export class InvalidRecurrence extends SchedulerError {
  constructor(value: string, valid: readonly string[]) {
    super(
      "INVALID_RECURRENCE",
      `${JSON.stringify(value)} is not a recurrence this engine knows. Valid: ${valid.join(", ")}. ` +
        `There is deliberately no cron expression — a formula in a data row is one nothing can ` +
        `query, and a genuinely new cadence should arrive as a named field.`,
    );
  }
}
