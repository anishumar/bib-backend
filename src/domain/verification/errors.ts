// Sentinel errors — the closed vocabulary of ways a verification operation
// fails. They live in the domain so the meaning is owned here; the api layer
// maps them to HTTP status codes (domainerr.ts). Match with `instanceof`, never
// string search.

import { INELIGIBILITY_MESSAGES, type IneligibilityReason } from "./model";

export class VerificationError extends Error {
  constructor(
    readonly code: VerificationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type VerificationErrorCode =
  | "NOT_ELIGIBLE_TO_CHECK"
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_ALREADY_DECIDED"
  | "CHECK_ALREADY_OPEN"
  | "STEP_NOT_CHECKABLE"
  | "REJECTION_NEEDS_A_REASON"
  | "REPORTS_TO_CYCLE"
  | "REPORTS_TO_NOT_A_COLLEAGUE";

/**
 * The refusal this whole task exists to produce.
 *
 * It carries the REASON, because "you cannot check this" with nothing after it
 * is how a person concludes the button is broken and asks somebody to do it
 * from the database. The prose is the domain's (`INELIGIBILITY_MESSAGES`) so
 * the screen and the API say the same thing.
 */
export class NotEligibleToCheck extends VerificationError {
  constructor(readonly reason: IneligibilityReason) {
    super("NOT_ELIGIBLE_TO_CHECK", INELIGIBILITY_MESSAGES[reason]);
  }
}

export class ApprovalNotFound extends VerificationError {
  constructor(ref: string) {
    super("APPROVAL_NOT_FOUND", `No check ${JSON.stringify(ref)} at this firm`);
  }
}

export class ApprovalAlreadyDecided extends VerificationError {
  constructor(ref: string, decision: string) {
    // Not silent, and not last-write-wins. Two people can be looking at the same
    // queue; the second must be told the first answered rather than quietly
    // overwriting a decision that is part of the audit record.
    super(
      "APPROVAL_ALREADY_DECIDED",
      `Check ${JSON.stringify(ref)} was already ${decision} by somebody else. Their decision ` +
        `stands — reload the queue to see it.`,
    );
  }
}

export class CheckAlreadyOpen extends VerificationError {
  constructor(stepKey: string) {
    super(
      "CHECK_ALREADY_OPEN",
      `Step ${JSON.stringify(stepKey)} is already waiting to be checked. One open check per ` +
        `step, so that two people cannot each approve the other's.`,
    );
  }
}

export class StepNotCheckable extends VerificationError {
  constructor(stepKey: string, status: string) {
    super(
      "STEP_NOT_CHECKABLE",
      `Step ${JSON.stringify(stepKey)} is ${JSON.stringify(status)}, and only a step somebody ` +
        `has finished can be checked. There is nothing to look at until the work is done.`,
    );
  }
}

export class RejectionNeedsAReason extends VerificationError {
  constructor() {
    super(
      "REJECTION_NEEDS_A_REASON",
      `Sending work back needs a note saying what is wrong with it. That note is the only ` +
        `thing that ever explains why rework happened — approving needs none, this does.`,
    );
  }
}

export class ReportsToCycle extends VerificationError {
  constructor(names: readonly string[]) {
    super(
      "REPORTS_TO_CYCLE",
      `This would make the reporting line a loop — ${names.join(" reports to ")} — and then ` +
        `nobody in it has a manager who could check their work.`,
    );
  }
}

export class ReportsToNotAColleague extends VerificationError {
  constructor(userId: string) {
    super(
      "REPORTS_TO_NOT_A_COLLEAGUE",
      `${JSON.stringify(userId)} is not an active member of staff at this firm, so nobody can ` +
        `report to them. Identity is global in this product but a reporting line is not.`,
    );
  }
}
