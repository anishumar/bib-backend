// Identity errors. InvalidCredentials covers "no such email" and "wrong password"; InvalidMagicLink
// covers unknown, expired and used. Precise errors would make login an oracle for which addresses
// have accounts (a firm's client list). The precise reason is logged server-side.
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
    // "This link", not "this sign-in link": one refusal serves sign-in, invitation and reset, and
    // naming the wrong kind misled readers. Still one sentence for every cause (no enumeration).
    super("INVALID_MAGIC_LINK", "This link is not valid, has expired, or has been used");
  }
}

export class SessionInvalid extends IdentityError {
  constructor() {
    super("SESSION_INVALID", "The session is unknown, expired, or revoked: sign in again");
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
 * A per-account budget is spent (429). The sentence is a parameter: one code covers several acts, and
 * "too many sign-in attempts" shown to a partner re-sending a client invite named the wrong act and
 * the wrong account. The default is the sign-in sentence.
 */
export class TooManyAttempts extends IdentityError {
  constructor(
    readonly retryAfterSeconds: number,
    message = `Too many sign-in attempts for this account. Try again in ${retryIn(retryAfterSeconds)}.`,
  ) {
    super("TOO_MANY_ATTEMPTS", message);
  }
}

/** A wait as a person says it, rounded UP: "59 minutes" for 59m42s sends them back to the same refusal. */
export function retryIn(seconds: number): string {
  if (seconds < 90) return `${String(Math.max(1, Math.ceil(seconds)))} seconds`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${String(minutes)} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "an hour" : `${String(hours)} hours`;
}

/**
 * The invite was used: this account HAS a password. Re-issuing would be the firm resetting its client's
 * password, which the invite flow exists to prevent (the firm never holds it, `PortalInviteService`).
 * The contact can still get a magic link from the sign-in page; the message says so.
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

/** Wrong CURRENT password on "Change your password" (audit 2026-10-03, F26). Not `InvalidCredentials`:
 *  its "Email or password" wording sent readers looking for an email box; the caller is signed in. */
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

/**
 * No such account, said out loud ONLY on /internal: the caller holds `identity.grant`, which can set
 * anyone's password, so this is no enumeration oracle. Unmapped, the credential upsert's FK failure
 * answered 500 to the provisioning system for its own typo.
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
        `Length is the only rule: a long passphrase beats a short one with symbols.`,
    );
  }
}

/**
 * The new password equals the current one. Refused on change, not on reset: a changer knows it and
 * usually suspects it was seen, so accepting the same value is a false rotation. A resetter cannot see
 * the old one, so reset accepts any acceptable password. Leaks nothing either way.
 */
export class PasswordUnchanged extends IdentityError {
  constructor() {
    super(
      "PASSWORD_UNCHANGED",
      `That is the password already on this account, so nothing would change. ` +
        `Pick a different one: if you are changing it because somebody may have seen it, ` +
        `re-setting the same value leaves them exactly where they were.`,
    );
  }
}

/**
 * No current password, so this route cannot set the first (common: `welcomeStaff` hands over only a
 * session). A session must never MINT a password: a stolen cookie would become permanent ownership that
 * survives every revocation. The first password comes via the emailed link, which proves the mailbox;
 * `changePassword` stays a swap by someone who can produce the old one.
 */
export class NoPasswordSet extends IdentityError {
  constructor() {
    super(
      "NO_PASSWORD_SET",
      `This account has no password yet, so there is none to change. Ask the sign-in page ` +
        `to email you a link: setting the first one that way proves you can read the ` +
        `mailbox, which is the only thing standing in for the password you do not have.`,
    );
  }
}
