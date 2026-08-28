// Sentinel errors — the closed vocabulary of ways lead capture and pipeline
// movement fail. Owned here in the domain; the api layer maps them to HTTP
// status codes (domainerr.ts). Match with `instanceof`, never by string.

export class LeadError extends Error {
  constructor(
    readonly code: LeadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type LeadErrorCode =
  | "INVALID_SOURCE"
  | "INVALID_STAGE"
  | "NO_CONTACT_DETAIL"
  | "AMBIGUOUS_MATCH"
  | "LEAD_NOT_FOUND"
  | "LEAD_CLOSED"
  | "SAME_STAGE"
  | "OWNER_NOT_STAFF";

export class InvalidSource extends LeadError {
  constructor(source: string, valid: readonly string[]) {
    super(
      "INVALID_SOURCE",
      `${JSON.stringify(source)} is not a lead source this product records. Valid: ${valid.join(", ")}.`,
    );
  }
}

export class InvalidStage extends LeadError {
  constructor(stage: string, valid: readonly string[]) {
    super(
      "INVALID_STAGE",
      `${JSON.stringify(stage)} is not a pipeline stage. Valid: ${valid.join(", ")}. ` +
        `Stages are fixed in this release; a firm's own pipeline vocabulary arrives with the ` +
        `pipeline screen.`,
    );
  }
}

export class NoContactDetail extends LeadError {
  constructor(dedupTypes: readonly string[]) {
    super(
      "NO_CONTACT_DETAIL",
      `a lead needs at least one contact identifier (${dedupTypes.join(", ")}). Two reasons, and ` +
        `both matter: nobody can follow up a prospect there is no way to reach, and without one ` +
        `every capture creates a new party — so the same company arrives three times and the ` +
        `duplicate check silently never fires.`,
    );
  }
}

export class AmbiguousMatch extends LeadError {
  constructor(partyIds: readonly string[]) {
    super(
      "AMBIGUOUS_MATCH",
      `these contact details already belong to ${String(partyIds.length)} different parties ` +
        `(${partyIds.join(", ")}), so there is no single prospect to attach this lead to. ` +
        `That means the firm's records already hold the same counterparty twice — merging those ` +
        `parties is a decision with consequences for everything attached to them, so it is not ` +
        `made here on a guess. Resolve the duplicate, then capture the lead.`,
    );
  }
}

export class LeadNotFound extends LeadError {
  constructor(leadId: string) {
    super("LEAD_NOT_FOUND", `no lead ${JSON.stringify(leadId)} in this firm`);
  }
}

export class LeadClosed extends LeadError {
  constructor(leadId: string, stage: string) {
    super(
      "LEAD_CLOSED",
      `lead ${JSON.stringify(leadId)} is ${stage} and finished. A prospect who comes back is a ` +
        `NEW opportunity — capture one, so the two show up as two in the conversion rate rather ` +
        `than one that took nine months.`,
    );
  }
}

export class SameStage extends LeadError {
  constructor(stage: string) {
    super(
      "SAME_STAGE",
      `this lead is already ${stage}. Recording a move that did not happen would put a step in ` +
        `its timeline that nobody took.`,
    );
  }
}

export class OwnerNotStaff extends LeadError {
  constructor(userId: string) {
    super(
      "OWNER_NOT_STAFF",
      `user ${JSON.stringify(userId)} is not active staff at this firm, so a lead cannot be ` +
        `assigned to them. An owner who cannot sign in is an opportunity nobody is working.`,
    );
  }
}
