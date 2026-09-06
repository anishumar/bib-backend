// Sentinel errors — the closed vocabulary of ways an assignment operation
// fails. They live in the domain so the meaning is owned here; the api layer
// maps them to HTTP status codes (domainerr.ts). Match with `instanceof`, never
// a string search.
//
// Every code below has a case in `api/domainerr.ts`, and it is a COMPILE error
// if one does not — that switch ends `default: return unmapped(err.code)` and
// `unmapped` takes `never`. G3.3 shipped `StaffGradeError` with no entry there
// and every refusal answered 500 instead of 400/404/409; unit tests were
// perfectly happy, because they assert on the thrown sentinel and only a real
// HTTP request ever sees a status code.

import { longDay } from "../day";

export class ClientAssignmentError extends Error {
  constructor(
    readonly code: ClientAssignmentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type ClientAssignmentErrorCode =
  | "INVALID_ASSIGNMENT_ROLE"
  | "INVALID_ASSIGNMENT_DATES"
  | "AXIS_REQUIRED_FOR_SPOC"
  | "AXIS_NOT_ALLOWED_FOR_KEY_MANAGER"
  | "ASSIGNMENT_AXIS_NOT_FOUND"
  | "ASSIGNMENT_AXIS_RETIRED"
  | "ASSIGNMENT_CLIENT_NOT_FOUND"
  | "ASSIGNMENT_CLIENT_ARCHIVED"
  | "ASSIGNMENT_HOLDER_NOT_STAFF"
  | "ASSIGNMENT_NOT_FOUND"
  | "ASSIGNMENT_ALREADY_ENDED"
  | "ASSIGNMENT_DUPLICATE"
  | "ASSIGNMENT_PREDATES_INCUMBENT";

export class InvalidAssignmentRole extends ClientAssignmentError {
  constructor(role: string, valid: readonly string[]) {
    super(
      "INVALID_ASSIGNMENT_ROLE",
      `${JSON.stringify(role)} is not a way of owning a client. Valid: ` +
        `${valid.map((r) => JSON.stringify(r)).join(", ")} — "key_manager" owns the ` +
        `relationship (pricing, renewals, escalation) and there is one at a time; "spoc" is ` +
        `the day-to-day contact for one Dept or delivery team, and a client commonly has ` +
        `several.`,
    );
  }
}

export class InvalidAssignmentDates extends ClientAssignmentError {
  constructor(validFrom: string, validTo: string | null) {
    super(
      "INVALID_ASSIGNMENT_DATES",
      `${JSON.stringify(validFrom)} → ${validTo === null ? "open" : JSON.stringify(validTo)} ` +
        `is not a valid period. Both dates are ISO YYYY-MM-DD, and the end is the FIRST DAY ` +
        `NOT IN FORCE — so it must be strictly after the start. Ending on the day it began ` +
        `would be an assignment that was in force on no day at all.`,
    );
  }
}

export class AxisRequiredForSpoc extends ClientAssignmentError {
  constructor() {
    super(
      "AXIS_REQUIRED_FOR_SPOC",
      `A SPOC is the contact for a particular part of the work, so it must name one of the ` +
        `firm's Depts or delivery teams. A contact for everything is the Key Manager — ` +
        `assign that role instead. Without this rule a SPOC with no axis would quietly ` +
        `become a second key manager under another name.`,
    );
  }
}

export class AxisNotAllowedForKeyManager extends ClientAssignmentError {
  constructor() {
    super(
      "AXIS_NOT_ALLOWED_FOR_KEY_MANAGER",
      `The Key Manager owns the whole client relationship, not one Dept of it, so this role ` +
        `takes no Dept or delivery team. If the firm means "the contact for TRC", that is a ` +
        `SPOC.`,
    );
  }
}

export class AssignmentAxisNotFound extends ClientAssignmentError {
  constructor(axisId: string) {
    super(
      "ASSIGNMENT_AXIS_NOT_FOUND",
      `No Dept or delivery team ${JSON.stringify(axisId)} at this firm. The firm's own two ` +
        `lists are maintained on the firm-structure screen; a SPOC can only be assigned to a ` +
        `row that is on one of them.`,
    );
  }
}

export class AssignmentAxisRetired extends ClientAssignmentError {
  constructor(code: string) {
    // Not silent, for `AxisNotAssignable`'s reason: a Dept the firm retired
    // still has clients whose SPOC was assigned under it, and those rows stay
    // valid and readable — but assigning a NEW one there is almost always a
    // stale picker, and allowing it would spread a Dept the firm has stopped
    // using.
    super(
      "ASSIGNMENT_AXIS_RETIRED",
      `${JSON.stringify(code)} is a Dept or delivery team this firm no longer uses, so ` +
        `nobody new may be made its SPOC. Assignments already made under it keep it and ` +
        `still read. Reactivate it on the firm-structure screen if the firm is using it ` +
        `again.`,
    );
  }
}

export class AssignmentClientNotFound extends ClientAssignmentError {
  constructor(clientPartyId: string) {
    super(
      "ASSIGNMENT_CLIENT_NOT_FOUND",
      `No party ${JSON.stringify(clientPartyId)} at this firm`,
    );
  }
}

export class AssignmentClientArchived extends ClientAssignmentError {
  constructor(displayName: string) {
    // Archiving means "keep this out of the pickers and lists" (G0.3), and
    // putting somebody in charge of a client the firm has put away is the same
    // kind of mistake as filing new work under a retired Dept. Existing rows
    // are untouched and still read: who owned an archived client is exactly the
    // sort of question asked about one.
    super(
      "ASSIGNMENT_CLIENT_ARCHIVED",
      `${JSON.stringify(displayName)} is archived, so nobody new can be put in charge of ` +
        `it. Assignments it already has are kept and still read — unarchive the client ` +
        `first if the firm is working with them again.`,
    );
  }
}

export class AssignmentHolderNotStaff extends ClientAssignmentError {
  constructor(userId: string) {
    // The foreign key points at `tenancy.user_account`, which is GLOBAL — one
    // login, many firms — so the database would happily accept a stranger. Only
    // the roster knows who works HERE, which is why this refusal is the
    // service's and not a constraint. `reports_to_user_id` has the same shape
    // and the same reason.
    super(
      "ASSIGNMENT_HOLDER_NOT_STAFF",
      `User ${JSON.stringify(userId)} is not an active member of staff at this firm, so ` +
        `they cannot be given a client. A login is global in this product and belongs to no ` +
        `firm on its own; the roster is what says who works here.`,
    );
  }
}

export class AssignmentNotFound extends ClientAssignmentError {
  constructor(assignmentId: string) {
    super(
      "ASSIGNMENT_NOT_FOUND",
      `No client assignment ${JSON.stringify(assignmentId)} at this firm`,
    );
  }
}

export class AssignmentAlreadyEnded extends ClientAssignmentError {
  constructor(validTo: string) {
    super(
      "ASSIGNMENT_ALREADY_ENDED",
      `This assignment already ended on ${longDay(validTo)} and is history now. History is not ` +
        `corrected by writing over it — if the end date is wrong, that is a correction ` +
        `somebody has to make deliberately, and if the person is back, assign them again ` +
        `from the day they returned.`,
    );
  }
}

export class AssignmentDuplicate extends ClientAssignmentError {
  constructor(role: string, from: string) {
    // De-duplication, not policy. The same Dept may have two SPOCs; it may not
    // have the same one twice, which is a double-click or a re-import rather
    // than anything the firm meant.
    super(
      "ASSIGNMENT_DUPLICATE",
      `This person has been the ${role === "key_manager" ? "Key Manager" : "SPOC"} for this ` +
        `client since ${longDay(from)} and still is, so assigning them again would be the same fact ` +
        `recorded twice. To move the date, end that assignment and make a new one.`,
    );
  }
}

export class AssignmentPredatesIncumbent extends ClientAssignmentError {
  constructor(from: string) {
    // The handover closes the outgoing row AT the new row's start date, and a
    // half-open range must be non-empty — so a Key Manager cannot start before
    // the one they are replacing did. Refused with the date rather than
    // surfaced as a constraint violation, because the fix is obvious once you
    // are told which date is in the way.
    super(
      "ASSIGNMENT_PREDATES_INCUMBENT",
      `This client's current Key Manager took over on ${longDay(from)}, so a new one cannot start ` +
        `on or before that date — the handover would have to close a period that never ` +
        `opened. Record the change from ${longDay(from)} or later, or correct the earlier ` +
        `assignment first.`,
    );
  }
}
