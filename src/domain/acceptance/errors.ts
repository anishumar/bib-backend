// Sentinel errors for a recorded acceptance (0317). The api layer maps them
// (domainerr.ts). Match with `instanceof`, never by string.

export class AcceptanceError extends Error {
  constructor(
    readonly code: AcceptanceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type AcceptanceErrorCode =
  | "ACCEPTANCE_INVALID"
  | "ACCEPTANCE_NEEDS_EVIDENCE"
  | "EVIDENCE_NOT_FILED_HERE"
  | "ACCEPT_THROUGH_RECORD";

/** A field of the statement is malformed or impossible. */
export class AcceptanceInvalid extends AcceptanceError {
  constructor(
    readonly field: string,
    why: string,
  ) {
    super("ACCEPTANCE_INVALID", `Cannot record this acceptance: ${why}.`);
  }
}

/** A letter recorded as accepted must carry the client's own email or letter. */
export class AcceptanceNeedsEvidence extends AcceptanceError {
  constructor() {
    super(
      "ACCEPTANCE_NEEDS_EVIDENCE",
      "An engagement letter is the contract, so recording the client's acceptance needs their " +
        "email or letter saying yes. Attach it, then record the acceptance.",
    );
  }
}

/** The evidence named is not a file filed against this proposal or letter. */
export class EvidenceNotFiledHere extends AcceptanceError {
  constructor(documentId: string) {
    super(
      "EVIDENCE_NOT_FILED_HERE",
      `The evidence ${documentId} is not a file attached to this document. Attach the client's ` +
        "email to it first, then record the acceptance.",
    );
  }
}

/**
 * `/decision` no longer accepts a proposal: an acceptance the client gave
 * outside the link is recorded, with how and when, by somebody who holds
 * `acceptance:record` (0317). Declining is unchanged.
 */
export class AcceptThroughRecord extends AcceptanceError {
  constructor() {
    super(
      "ACCEPT_THROUGH_RECORD",
      "A client's acceptance is recorded with how and when they said yes: use Record " +
        "acceptance. Only somebody allowed to record acceptances (a partner, by default) can.",
    );
  }
}
