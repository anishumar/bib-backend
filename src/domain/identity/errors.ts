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
  | "PASSWORD_UNCHANGED"
  | "NO_PASSWORD_SET"
  | "CURRENT_PASSWORD_INCORRECT"
  | "PASSWORD_ALREADY_SET"
  | "USER_NOT_FOUND";

export class InvalidCredentials extends IdentityError {
  constructor() {
    super("INVALID_CREDENTIALS", "Email or password is incorrect");
  }
}

export class InvalidMagicLink extends IdentityError {
  constructor() {
    // "This link", not "this sign-in link": the same refusal answers the sign-in,
    // invitation and password-reset routes, and naming the wrong kind of link on
    // the reset page sent somebody looking for a sign-in problem they did not
    // have. Found by walking it. Still one sentence for every cause, so it says
    // nothing about which addresses have accounts.
    super("INVALID_MAGIC_LINK", "This link is not valid, has expired, or has been used");
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
    message = `Too many sign-in attempts for this account. Try again in ${retryIn(retryAfterSeconds)}.`,
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
/**
 * The CURRENT password typed on "Change your password" is not this account's.
 *
 * Its own sentence (audit 2026-10-03, F26). It used to be `InvalidCredentials`,
 * whose "Email or password is incorrect" belongs to the sign-in page: this form
 * has no email box, and the reader went looking for one. Nothing here needs to
 * be vague: the caller is signed in and already knows which account it is.
 */
export class CurrentPasswordIncorrect extends IdentityError {
  constructor() {
    super(
      "CURRENT_PASSWORD_INCORRECT",
      "That is not your current password. Check it and try again.",
    );
  }
}

/**
 * A welcome link was asked to set a FIRST password on an account that has one
 * (CA#38). Accounts are global, so a welcome to a second firm can reach
 * somebody who already signs in with a password, and the welcome must never
 * replace it. The link is NOT spent: it still signs them in.
 */
export class PasswordAlreadySet extends IdentityError {
  constructor() {
    super(
      "PASSWORD_ALREADY_SET",
      "You already have a password. Sign in with it, or continue without changing it.",
    );
  }
}

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

/**
 * The "new" password is the one already on the account.
 *
 * ── WHY THIS IS REFUSED ON THE CHANGE ROUTE AND NOT ON THE RESET ──────────
 *
 * They are two different sentences from the person typing.
 *
 *   `changePassword` is somebody who KNOWS their password — they have just
 *   typed it into the field above — saying they want a different one. The
 *   commonest reason anybody does that is that they think somebody else has
 *   seen it. Accepting the same string back would answer that with a green
 *   tick and change nothing, and the person would walk away believing they had
 *   rotated a credential they had not. That is worse than the refusal.
 *
 *   `resetPassword` is somebody who does NOT know it — that is the whole
 *   premise of holding a reset link — and asking them for something other than
 *   the value they cannot see is a riddle. So the reset path accepts any
 *   acceptable password, including, unknowably to both sides, the old one.
 *
 * It leaks nothing in either direction: the change route's caller has already
 * proved they hold the current password, and the reset route never asks.
 */
export class PasswordUnchanged extends IdentityError {
  constructor() {
    super(
      "PASSWORD_UNCHANGED",
      `That is the password already on this account, so nothing would change. ` +
        `Pick a different one — if you are changing it because somebody may have seen it, ` +
        `re-setting the same value leaves them exactly where they were.`,
    );
  }
}

/**
 * There is no current password to check, so this route cannot be the one that
 * sets the first.
 *
 * ── WHY A SIGNED-IN PERSON IS SENT TO THEIR INBOX FOR THIS ────────────────
 *
 * Most colleagues at a firm have never had a password: `welcomeStaff` hands
 * over a session and nothing else, and they have signed in with emailed links
 * ever since. So "set a password for the first time" is the COMMON case here,
 * not an edge, and the obvious thing to do — let a signed-in caller set one
 * without proving anything — is the one thing that must not happen.
 *
 * A session is a bearer credential. Today, somebody holding a stolen one loses
 * everything the moment it is revoked, which is the property server-side
 * sessions exist for. Letting that session MINT a password would turn a
 * fortnight's stolen cookie into permanent ownership of the account, surviving
 * every revocation the firm has — and the person it was taken from would never
 * have a password of their own to notice had changed.
 *
 * So the first password is set through the emailed link, where reading the
 * mailbox is the thing being proved, and `changePassword` stays what its name
 * says: a swap, by somebody who can produce the old one.
 */
export class NoPasswordSet extends IdentityError {
  constructor() {
    super(
      "NO_PASSWORD_SET",
      `This account has no password yet, so there is none to change. Ask the sign-in page ` +
        `to email you a link — setting the first one that way proves you can read the ` +
        `mailbox, which is the only thing standing in for the password you do not have.`,
    );
  }
}
