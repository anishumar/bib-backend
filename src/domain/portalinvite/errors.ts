// Sentinel errors — the closed vocabulary of ways RE-inviting a client's contact
// fails. They live in the domain so the meaning is owned here; the api layer
// maps them to HTTP status codes (domainerr.ts). Match with `instanceof`, never
// a string search.
//
// Every code below has a case in `api/domainerr.ts`, and it is a COMPILE error
// if one does not — that switch ends `default: return unmapped(err.code)` and
// `unmapped` takes `never`.
//
// ── WHY THIS FAMILY EXISTS AT ALL, BESIDE `PortalAccessError` ──────────────
//
// Three of these describe the same three states that family already names —
// no such membership, not a client login, revoked — and they are deliberately
// NOT reused. Those messages are written about a GRANT ("granting a client to a
// revoked login would leave the firm believing somebody has access"), and this
// route grants nothing. It re-sends a letter. What the reader has to be told is
// different in each case, and an error's message is the whole of what a person
// standing at the screen gets.

export class PortalInviteError extends Error {
  constructor(
    readonly code: PortalInviteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type PortalInviteErrorCode =
  | "PORTAL_CONTACT_NOT_FOUND"
  | "PORTAL_CONTACT_NOT_A_CLIENT_LOGIN"
  | "PORTAL_CONTACT_INACTIVE";

export class PortalContactNotFound extends PortalInviteError {
  constructor(membershipId: string) {
    super(
      "PORTAL_CONTACT_NOT_FOUND",
      `no membership ${JSON.stringify(membershipId)} at this firm to write to. An invitation ` +
        `is re-sent to a MEMBERSHIP and not to an account: the same person may hold a portal ` +
        `login at two firms, and each firm may only write to its own.`,
    );
  }
}

export class PortalContactNotAClientLogin extends PortalInviteError {
  constructor(membershipId: string, audience: string) {
    super(
      "PORTAL_CONTACT_NOT_A_CLIENT_LOGIN",
      `membership ${JSON.stringify(membershipId)} is a ${audience} login, and this route ` +
        `re-sends the CLIENT PORTAL invitation — the letter on which a password is chosen. A ` +
        `colleague is sent a different letter, and does not need one: the sign-in page issues ` +
        `them a fresh link on request.`,
    );
  }
}

export class PortalContactInactive extends PortalInviteError {
  constructor(membershipId: string) {
    super(
      "PORTAL_CONTACT_INACTIVE",
      `membership ${JSON.stringify(membershipId)} has been revoked, so there is nobody to ` +
        `write to. Restore it on the client's contacts list first — re-inviting a revoked ` +
        `login would mail somebody the firm has shut out a link that cannot open anything.`,
    );
  }
}
