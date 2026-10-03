import type { LeadDeletionBlock } from "./model";
import { countryCodeProblem } from "../country";

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
  | "OWNER_NOT_STAFF"
  | "LOST_REASON_REQUIRED"
  | "LOST_REASON_NOT_APPLICABLE"
  | "BLANK_TITLE"
  | "INVALID_LEAD_JURISDICTION"
  | "INVALID_ESTIMATED_VALUE"
  | "INVALID_LEAD_CONTACT"
  | "PARTY_ARCHIVED"
  | "CLIENT_IS_OWN_COMPANY"
  | "NOT_CALLERS_TODAY"
  | "LEAD_DELETED"
  | "LEAD_CONVERTED"
  | "CLOSED_LEAD_NEEDS_ADMIN"
  | "LEAD_HAS_PROPOSALS";

/**
 * The contact person named at capture cannot be recorded as given (CA#20): a
 * contact is somebody AT a company, in one of the roles a letter may be
 * addressed to, and has a name.
 */
export class InvalidLeadContact extends LeadError {
  constructor(problem: "for_person" | "no_name" | "role", given?: string) {
    super(
      "INVALID_LEAD_CONTACT",
      problem === "for_person"
        ? "A contact person is for a company. For a person, their own email and phone are theirs: leave the contact out."
        : problem === "no_name"
          ? "Give the contact person's name, or leave the contact out."
          : `${JSON.stringify(given ?? "")} is not a contact's role. Choose director, authorised signatory, employee or shareholder.`,
    );
  }
}

/** `asOf` is the caller's TODAY, not a date to choose (see `isCallersToday`). */
export class LeadNotCallersToday extends LeadError {
  constructor(given: string, firmDay: string) {
    super(
      "NOT_CALLERS_TODAY",
      `The day sent as asOf, ${JSON.stringify(given)}, cannot be today where you are: the firm's ` +
        `day is ${firmDay}, and anywhere in the world today is that day or the one either side.`,
    );
  }
}

/** The contact details on this capture belong to a client the firm archived
 *  (0305). Refused rather than quietly restored: putting a client away was a
 *  decision, and a web enquiry must not undo it unseen. */
export class LeadPartyArchived extends LeadError {
  constructor(displayName: string) {
    super(
      "PARTY_ARCHIVED",
      `${displayName} is archived, so a new lead cannot be opened for them. If the firm is ` +
        `working with them again, restore them from their client page first: restoring is its ` +
        `own step, so that putting a client away is never undone without somebody seeing it.`,
    );
  }
}

/** The contact details on this capture are one of the firm's OWN companies'
 *  (0313): usually the firm's phone or email typed as the prospect's. A lead
 *  would make the firm its own prospect, so nothing is written. */
export class LeadMatchesOwnCompany extends LeadError {
  constructor(displayName: string) {
    super(
      "CLIENT_IS_OWN_COMPANY",
      `These contact details belong to ${displayName}, one of your own companies, so a lead ` +
        `cannot be opened for it. Check the phone, email and PAN, and enter the prospect's own.`,
    );
  }
}

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
      `A lead needs at least one contact identifier (${dedupTypes.join(", ")}). Two reasons, and ` +
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
      // In words (CA#39): it listed the parties' ids, which mean nothing to
      // the person at the form.
      `These details are already recorded on ${String(partyIds.length)} different clients or ` +
        `contacts, so this lead cannot be attached to just one. Check the client list for the ` +
        `same client entered twice, then capture the lead again.`,
    );
  }
}

export class LeadNotFound extends LeadError {
  constructor(leadId: string) {
    super("LEAD_NOT_FOUND", `No lead ${JSON.stringify(leadId)} in this firm`);
  }
}

export class LeadClosed extends LeadError {
  constructor(leadId: string, stage: string) {
    super(
      "LEAD_CLOSED",
      `Lead ${JSON.stringify(leadId)} is ${stage} and finished. A prospect who comes back is a ` +
        `NEW opportunity — capture one, so the two show up as two in the conversion rate rather ` +
        `than one that took nine months.`,
    );
  }
}

export class SameStage extends LeadError {
  constructor(stage: string) {
    super(
      "SAME_STAGE",
      `This lead is already ${stage}. Recording a move that did not happen would put a step in ` +
        `its timeline that nobody took.`,
    );
  }
}

export class OwnerNotStaff extends LeadError {
  constructor(userId: string) {
    super(
      "OWNER_NOT_STAFF",
      `User ${JSON.stringify(userId)} is not active staff at this firm, so a lead cannot be ` +
        `assigned to them. An owner who cannot sign in is an opportunity nobody is working.`,
    );
  }
}

export class LostReasonRequired extends LeadError {
  constructor(stage: string) {
    super(
      "LOST_REASON_REQUIRED",
      `Closing a lead as ${stage} needs a reason, in your own words. It is the one fact that is ` +
        `obvious today and unrecoverable in a month, and it is what makes "${stage} — why?" a ` +
        `question the pipeline can answer at all. Free text on purpose: a dropdown of five ` +
        `reasons produces five reasons, and the useful one is always the sixth.`,
    );
  }
}

export class LostReasonNotApplicable extends LeadError {
  constructor(stage: string, valid: readonly string[]) {
    super(
      "LOST_REASON_NOT_APPLICABLE",
      `A lead moving to ${JSON.stringify(stage)} carries no lost reason — only ${valid.join(" and ")} ` +
        `do. A won deal in particular has nothing to explain, and a column that accepted a reason ` +
        `on it would collect notes nothing ever reads.`,
    );
  }
}

export class BlankTitle extends LeadError {
  constructor() {
    super(
      "BLANK_TITLE",
      `A lead needs a title with something in it. Whitespace satisfies NOT NULL and renders as ` +
        `the blank row the field exists to prevent — name the opportunity, not the client, ` +
        `because the list already shows the client beside it.`,
    );
  }
}

/**
 * Refused rather than dropped.
 *
 * A caller sending "India" or "in" would otherwise get a lead with no
 * jurisdiction, the rotation instead of the UK desk rule, and no clue why — a
 * silent fallback that looks exactly like the ordinary unknown-country case.
 */
export class InvalidLeadJurisdiction extends LeadError {
  constructor(given: string) {
    super(
      "INVALID_LEAD_JURISDICTION",
      // In words (F04). Leaving the country out stays a real answer.
      countryCodeProblem(given),
    );
  }
}

export class InvalidEstimatedValue extends LeadError {
  constructor(given: string) {
    super(
      "INVALID_ESTIMATED_VALUE",
      `${JSON.stringify(given)} is not an amount. Give a plain number with at most two decimal ` +
        `places and no commas or currency sign ("500000" or "125000.50"), or leave it out. ` +
        `An unknown value is a real answer.`,
    );
  }
}

// ── Deleting a lead entered by mistake (0086) ────────────────────────────────

/** A deleted lead is final. Every change to one lands here, and so does a
 *  second delete. */
export class LeadDeleted extends LeadError {
  constructor() {
    // No date in the sentence: a day cut from an instant here would be
    // Greenwich's, and the page shows `deletedAt` in the reader's own zone.
    super(
      "LEAD_DELETED",
      `This lead was deleted as entered by mistake, and a deleted lead is final: nothing about ` +
        `it changes again. If the prospect is real after all, capture a new lead.`,
    );
  }
}

export class ConvertedLeadNotDeletable extends LeadError {
  constructor() {
    super(
      "LEAD_CONVERTED",
      `This lead was converted, and a won deal is the record of a win rather than a mistake, ` +
        `so it cannot be deleted.`,
    );
  }
}

/** A refusal about WHO, not about the lead — so 403, like maker != checker. */
export class ClosedLeadNeedsAdmin extends LeadError {
  constructor(stage: string) {
    super(
      "CLOSED_LEAD_NEEDS_ADMIN",
      `This lead is already closed as ${stage}, so it is counted in the pipeline's numbers, and ` +
        `only a firm administrator can take it out of them. If it was entered by mistake, ask an ` +
        `administrator to delete it.`,
    );
  }
}

export class LeadHasProposals extends LeadError {
  constructor(readonly refs: readonly string[]) {
    super(
      "LEAD_HAS_PROPOSALS",
      (refs.length === 1
        ? `Proposal ${refs.join("")} was drafted from this lead, `
        : `Proposals ${refs.join(", ")} were drafted from this lead, `) +
        `so it cannot be deleted while ${refs.length === 1 ? "that proposal stands" : "they stand"}. ` +
        `If ${refs.length === 1 ? "it was" : "they were"} a mistake too, delete ` +
        `${refs.length === 1 ? "it" : "them"} first, from the proposal's own page; if the prospect ` +
        `is real, close the lead instead.`,
    );
  }
}

/**
 * The refusal a block means — ONE sentence for both places a person meets it:
 * the DELETE that is refused, and the lead's page, which shows it beside where
 * the button would be so nobody has to press it to find out.
 */
export function leadDeletionRefusal(block: LeadDeletionBlock): LeadError {
  switch (block.kind) {
    case "deleted":
      return new LeadDeleted();
    case "converted":
      return new ConvertedLeadNotDeletable();
    case "closed":
      return new ClosedLeadNeedsAdmin(block.stage);
    case "proposals":
      return new LeadHasProposals(block.refs);
  }
}
