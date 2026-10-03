// Sentinel errors — the closed vocabulary of ways a portal grant fails. They
// live in the domain so the meaning is owned here; the api layer maps them to
// HTTP status codes (domainerr.ts). Match with `instanceof`, never a string
// search.
//
// Every code below has a case in `api/domainerr.ts`, and it is a COMPILE error
// if one does not — that switch ends `default: return unmapped(err.code)` and
// `unmapped` takes `never`. `StaffGradeError` shipped without an entry and
// every one of its refusals answered 500; unit tests were perfectly happy,
// because they assert on the thrown sentinel and only a real HTTP request ever
// sees a status code.

import { longDay } from "../day";

export class PortalAccessError extends Error {
  constructor(
    readonly code: PortalAccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type PortalAccessErrorCode =
  | "INVALID_PORTAL_DATES"
  | "PORTAL_MEMBERSHIP_NOT_FOUND"
  | "PORTAL_MEMBERSHIP_NOT_A_CLIENT_LOGIN"
  | "PORTAL_MEMBERSHIP_INACTIVE"
  | "PORTAL_CLIENT_NOT_FOUND"
  | "PORTAL_CLIENT_ARCHIVED"
  | "PORTAL_GRANT_NOT_FOUND"
  | "PORTAL_GRANT_ALREADY_ENDED"
  | "PORTAL_GRANT_DUPLICATE";

export class InvalidPortalDates extends PortalAccessError {
  constructor(validFrom: string, validTo: string | null) {
    super(
      "INVALID_PORTAL_DATES",
      `The dates ${JSON.stringify(validFrom)} and ${JSON.stringify(validTo)} do not ` +
        `describe a grant. validTo is the FIRST DAY NOT IN FORCE: granting needs it LATER ` +
        `than validFrom, because a grant in force on no day reads as "granted" and lets ` +
        `nobody in. Ending is different: the same day is allowed there, and is how access ` +
        `is removed the moment somebody decides to remove it.`,
    );
  }
}

export class PortalMembershipNotFound extends PortalAccessError {
  constructor(membershipId: string) {
    super(
      "PORTAL_MEMBERSHIP_NOT_FOUND",
      `No membership ${JSON.stringify(membershipId)} at this firm. A grant is against a ` +
        `MEMBERSHIP and not an account: the same person may hold a portal login at two firms, ` +
        `and what they may see at each is this firm's decision alone.`,
    );
  }
}

export class PortalMembershipNotAClientLogin extends PortalAccessError {
  constructor(membershipId: string, audience: string) {
    super(
      "PORTAL_MEMBERSHIP_NOT_A_CLIENT_LOGIN",
      `Membership ${JSON.stringify(membershipId)} is a ${audience} login, and portal access ` +
        `is only meaningful for a CLIENT_PORTAL one. A colleague already reaches the firm's ` +
        `whole book through the staff workspace; granting them a client here would record a ` +
        `permission that governs nothing and read as though it did.`,
    );
  }
}

export class PortalMembershipInactive extends PortalAccessError {
  constructor(membershipId: string) {
    super(
      "PORTAL_MEMBERSHIP_INACTIVE",
      `Membership ${JSON.stringify(membershipId)} has been revoked, so there is nothing to ` +
        `grant access to. Restore the membership on the roster first: granting a client to a ` +
        `revoked login would leave the firm believing somebody has access that no session can ` +
        `ever use.`,
    );
  }
}

export class PortalClientNotFound extends PortalAccessError {
  constructor(clientPartyId: string) {
    super(
      "PORTAL_CLIENT_NOT_FOUND",
      `No party ${JSON.stringify(clientPartyId)} at this firm to grant access to.`,
    );
  }
}

export class PortalClientArchived extends PortalAccessError {
  constructor(displayName: string) {
    super(
      "PORTAL_CLIENT_ARCHIVED",
      `${displayName} has been archived, so it is not a client to give anybody access to. ` +
        `Archiving is how a firm puts a client away; existing grants keep working and are ` +
        `still readable, and this refuses only a NEW one.`,
    );
  }
}

export class PortalGrantNotFound extends PortalAccessError {
  constructor(grantId: string) {
    super("PORTAL_GRANT_NOT_FOUND", `No portal grant ${JSON.stringify(grantId)} at this firm.`);
  }
}

export class PortalGrantAlreadyEnded extends PortalAccessError {
  constructor(grantId: string, validTo: string) {
    super(
      "PORTAL_GRANT_ALREADY_ENDED",
      `Portal grant ${JSON.stringify(grantId)} already stopped being in force on ${longDay(validTo)}. ` +
        `A grant is closed once and never re-closed: moving that date would rewrite who could ` +
        `see this client in March, which is the question this table exists to answer.`,
    );
  }
}

export class PortalGrantDuplicate extends PortalAccessError {
  constructor(clientName: string) {
    super(
      "PORTAL_GRANT_DUPLICATE",
      `This login already has access to ${clientName} over those days. Granting it twice ` +
        `would make "who could see this client" answer with the same person twice: end the ` +
        `existing grant first if you mean to change the dates.`,
    );
  }
}
