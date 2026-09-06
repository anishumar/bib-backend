// Sentinel errors for identity. Two of them are shaped by a security rule
// rather than by tidiness, and that is the interesting part of this file:
//
//   InvalidCredentials covers BOTH "no such email" and "wrong password", and
//   InvalidMagicLink covers unknown, expired and already-used. Splitting them
//   into precise errors would turn the login endpoint into an oracle that
//   confirms which email addresses have accounts here — which, for a firm's
//   client list, is itself the leak.
//
// The precise reason is still knowable: it is logged server-side, where the
// person reading it is us and not an attacker.
export class IdentityError extends Error {
  constructor(
    readonly code: IdentityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type IdentityErrorCode =
  | "INVALID_CREDENTIALS"
  | "INVALID_MAGIC_LINK"
  | "SESSION_INVALID"
  | "NO_ACTIVE_MEMBERSHIP"
  | "NOT_A_MEMBER"
  | "USER_DISABLED"
  | "WEAK_PASSWORD"
  | "TOO_MANY_ATTEMPTS"
  | "INVITATION_ALREADY_ACCEPTED"
  | "USER_NOT_FOUND";

export class InvalidCredentials extends IdentityError {
  constructor() {
    super("INVALID_CREDENTIALS", "Email or password is incorrect");
  }
}

export class InvalidMagicLink extends IdentityError {
  constructor() {
    super("INVALID_MAGIC_LINK", "This sign-in link is not valid, has expired, or has been used");
  }
}

export class SessionInvalid extends IdentityError {
  constructor() {
    super("SESSION_INVALID", "The session is unknown, expired, or revoked — sign in again");
  }
}

export class NoActiveMembership extends IdentityError {
  constructor(email: string) {
    super(
      "NO_ACTIVE_MEMBERSHIP",
      `${JSON.stringify(email)} authenticated but belongs to no active tenant. ` +
        `Grant a membership (POST /internal/v1/memberships) before they can sign in.`,
    );
  }
}

export class NotAMember extends IdentityError {
  constructor(tenantId: string) {
    super(
      "NOT_A_MEMBER",
      `This user holds no active membership in tenant ${JSON.stringify(tenantId)}, ` +
        `so the session cannot switch to it`,
    );
  }
}

export class UserDisabled extends IdentityError {
  constructor(email: string) {
    super("USER_DISABLED", `The account for ${JSON.stringify(email)} is disabled`);
  }
}

/**
 * A per-account budget is spent.
 *
 * ── THE SENTENCE IS A PARAMETER, AND THAT IS NOT TIDINESS ─────────────────
 *
 * One code (429) covers several different acts, and for two tasks the wording
 * covered only the first of them. Walking the product found a partner pressing
 * "Send it again" on a client contact and being told *"too many sign-in
 * attempts for this account"* — nobody had attempted to sign in, and the only
 * account named was somebody else's. A refusal that describes the wrong act is
 * worse than a bare 429, because the reader goes looking for the wrong cause.
 *
 * The default is the sign-in sentence, so nothing about that path changed.
 */
export class TooManyAttempts extends IdentityError {
  constructor(
    readonly retryAfterSeconds: number,
    message = `too many sign-in attempts for this account; retry in ${String(retryAfterSeconds)}s`,
  ) {
    super("TOO_MANY_ATTEMPTS", message);
  }
}

/**
 * How long to wait, as somebody at a screen would say it.
 *
 * `3582s` is a number a machine produced. A person reads a wait in minutes,
 * and rounds UP — telling somebody to come back in 59 minutes when the window
 * closes in 59 minutes and 42 seconds sends them back to the same refusal.
 */
export function retryIn(seconds: number): string {
  if (seconds < 90) return `${String(Math.max(1, Math.ceil(seconds)))} seconds`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${String(minutes)} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "an hour" : `${String(hours)} hours`;
}

/**
 * The invitation was already used: this account HAS a password.
 *
 * ── AND IT IS A REFUSAL, NOT A CONVENIENCE ────────────────────────────────
 *
 * A portal invite link is redeemed by SETTING a password, so re-issuing one to
 * somebody who already has theirs is not "sending the invitation again". It is
 * the firm resetting its client's password — a different act with a different
 * risk, and one a firm should never be able to perform on a person outside it.
 * The whole point of the invite flow is that the firm never holds a client's
 * password (`PortalInviteService`), and a resend that quietly worked here would
 * hand it back.
 *
 * The contact is not stuck: the sign-in page issues a magic link to any active
 * account, which is the door somebody who has forgotten their password already
 * has. The message says so, because the person reading it is at a screen
 * deciding what to do next.
 */
export class InvitationAlreadyAccepted extends IdentityError {
  constructor() {
    super(
      "INVITATION_ALREADY_ACCEPTED",
      `This contact has already set a password, so there is no invitation left to re-send. ` +
        `Re-issuing one would let the firm reset its own client's password, which is exactly ` +
        `what the invite flow exists to prevent. If they cannot get in, they ask the sign-in ` +
        `page to email them a link.`,
    );
  }
}

/**
 * There is no such account — said out loud, and ONLY where saying it is safe.
 *
 * -- WHY THIS IS NOT THE ENUMERATION ORACLE THE REST OF THIS FILE AVOIDS ----
 *
 * Every public path in this module is careful never to distinguish "no such
 * user" from "wrong password", because a login endpoint that tells them apart
 * hands an anonymous caller the firm's client list one address at a time. That
 * argument is about ANONYMOUS callers on the /api/v1 surface.
 *
 * This one is raised on /internal, where the caller has already presented a
 * provisioning key carrying `identity.grant` — a capability that lets them set
 * anybody's password, which is strictly more than knowing whether an id exists.
 * There is nothing left to protect, and the alternative is what was happening:
 * the credential upsert's foreign key failed, nothing mapped it, and the
 * provisioning system got a 500 saying "internal error" for its own typo.
 */
export class UserNotFound extends IdentityError {
  constructor(userId: string) {
    super("USER_NOT_FOUND", `No user ${userId}`);
  }
}

export class WeakPassword extends IdentityError {
  constructor(min: number, max: number) {
    super(
      "WEAK_PASSWORD",
      `Password must be between ${String(min)} and ${String(max)} characters. ` +
        `Length is the only rule — a long passphrase beats a short one with symbols.`,
    );
  }
}
