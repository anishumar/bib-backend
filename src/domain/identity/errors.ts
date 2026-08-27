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
  | "WEAK_PASSWORD";

export class InvalidCredentials extends IdentityError {
  constructor() {
    super("INVALID_CREDENTIALS", "email or password is incorrect");
  }
}

export class InvalidMagicLink extends IdentityError {
  constructor() {
    super("INVALID_MAGIC_LINK", "this sign-in link is not valid, has expired, or has been used");
  }
}

export class SessionInvalid extends IdentityError {
  constructor() {
    super("SESSION_INVALID", "the session is unknown, expired, or revoked — sign in again");
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
      `this user holds no active membership in tenant ${JSON.stringify(tenantId)}, ` +
        `so the session cannot switch to it`,
    );
  }
}

export class UserDisabled extends IdentityError {
  constructor(email: string) {
    super("USER_DISABLED", `the account for ${JSON.stringify(email)} is disabled`);
  }
}

export class WeakPassword extends IdentityError {
  constructor(min: number, max: number) {
    super(
      "WEAK_PASSWORD",
      `password must be between ${String(min)} and ${String(max)} characters. ` +
        `Length is the only rule — a long passphrase beats a short one with symbols.`,
    );
  }
}
