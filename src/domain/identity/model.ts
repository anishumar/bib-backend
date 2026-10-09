// Identity domain: credentials, sessions and magic links plus the pure rules on their use.
// Stdlib only; hashing and token generation are ports (usecase/identity/ports.ts), the policy is here.
import type { Audience } from "../tenancy/model";

export interface Session {
  readonly id: string;
  readonly userId: string;
  /** The tenant this session is acting under; null until an org is chosen. */
  readonly activeTenantId: string | null;
  readonly activeAudience: Audience | null;
  /** ISO 8601 with offset. */
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  /** Last use, to within `SESSION_TOUCH_MINUTES`: the IDLE clock. `expiresAt` is the ABSOLUTE cap
   *  on one sign-in; the session ends on whichever comes first. */
  readonly lastSeenAt: string;
}

/**
 * Which door a link opens; checked by `isUsableMagicLink`.
 *   `login`   pulled by the account holder, lives minutes, opens a session.
 *   `welcome` pushed to a new colleague, lives days, opens a session (0072).
 *   `invite`  client portal; redeems ONLY by setting a password, never opens a session alone.
 *   `reset`   forgotten password (0082); pulled, lives 30 min, redeems ONLY by replacing the
 *             password. The session comes from that, never from the link alone.
 */
export type MagicLinkPurpose = "login" | "invite" | "welcome" | "reset";

export interface MagicLink {
  readonly id: string;
  readonly userId: string;
  readonly purpose: MagicLinkPurpose;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
}

/** Absolute session life: no daily password re-typing, yet a forgotten laptop stops within a fortnight.
 *  "We let someone go this morning" is answered by revocation, which is why sessions are server-side. */
export const SESSION_TTL_DAYS = 14;

/**
 * How long a session may sit UNUSED. The absolute TTL counts from sign-in, so a laptop left open
 * or a sold phone stayed valid for a fortnight of doing nothing. A week survives a holiday, a long
 * weekend or a week on a client site. Must stay below the TTL; equal would be one clock twice.
 */
export const SESSION_IDLE_DAYS = 7;

/** How stale `lastSeenAt` may get before it is rewritten. Touching on EVERY request would make every
 *  authenticated read a write on the hottest row; five minutes is nothing against a seven-day timeout. */
export const SESSION_TOUCH_MINUTES = 5;

/** A magic link is a bearer credential in an inbox: 15 minutes, enough to switch to email and click. */
export const MAGIC_LINK_TTL_MINUTES = 15;

/**
 * Length only, no composition rules (NIST SP 800-63B; composition rules push people to `Passw0rd!`).
 * The maximum exists because every candidate runs through a slow hash: unbounded input, unbounded work.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

export function isAcceptablePassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH;
}

/** Not revoked, not expired, not idle. Every "is this request authenticated" ends here. */
export function isUsableSession(session: Session, now: Date): boolean {
  if (session.revokedAt !== null) return false;
  if (Date.parse(session.expiresAt) <= now.getTime()) return false;
  // Idle checked beside absolute expiry so no caller can get one answer without the other.
  return !hasGoneIdle(session, now);
}

/** Whether a session has sat unused past `SESSION_IDLE_DAYS`. */
export function hasGoneIdle(session: Session, now: Date): boolean {
  const idleMs = now.getTime() - Date.parse(session.lastSeenAt);
  return idleMs > SESSION_IDLE_DAYS * 24 * 60 * 60 * 1000;
}

/** Whether `lastSeenAt` is stale enough to write; see `SESSION_TOUCH_MINUTES`. */
export function shouldTouch(session: Session, now: Date): boolean {
  return now.getTime() - Date.parse(session.lastSeenAt) > SESSION_TOUCH_MINUTES * 60 * 1000;
}

/**
 * Usable exactly once, before expiry, and only FOR THIS PURPOSE. `purpose` (CHECKed since 0004)
 * went unread until the portal invite: an invite redeemed at sign-in would have opened a session
 * without the password ever being set.
 */
export function isUsableMagicLink(link: MagicLink, now: Date, purpose: MagicLinkPurpose): boolean {
  if (link.purpose !== purpose) return false;
  if (link.consumedAt !== null) return false;
  return Date.parse(link.expiresAt) > now.getTime();
}

/**
 * The purposes that redeem straight into a session: this module's security property in one line.
 * `invite` is absent: a portal contact would have no password and no way back once it was spent.
 * `reset` (0082) is absent: holding it proves only mailbox access, and spending it at sign-in would
 * open a session while leaving the forgotten password unfixed. Its session comes from setting one.
 */
export const SESSION_OPENING_PURPOSES: readonly MagicLinkPurpose[] = ["login", "welcome"];

/** Is this link still good for opening a session? */
export function isUsableForSession(link: MagicLink, now: Date): boolean {
  return SESSION_OPENING_PURPOSES.some((purpose) => isUsableMagicLink(link, now, purpose));
}

/** Portal invite life: days, because a client reads email when they do and an expired invite sends them
 *  back to the firm. Still single-use, hashed at rest; a fresh invite invalidates nothing but itself. */
export const PORTAL_INVITE_TTL_DAYS = 7;

export function portalInviteExpiryFrom(now: Date, ttlDays = PORTAL_INVITE_TTL_DAYS): string {
  return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
}

export function sessionExpiryFrom(now: Date, ttlDays = SESSION_TTL_DAYS): string {
  return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
}

export function magicLinkExpiryFrom(now: Date, ttlMinutes = MAGIC_LINK_TTL_MINUTES): string {
  return new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString();
}

/**
 * Colleague's welcome link life. A sign-in link is PULLED (15 min); a welcome is PUSHED and may be
 * sent Friday evening and read Monday (72 h); a portal invite gets a week because a client must ask
 * a human for another. Staff can be strict: the login page issues a fresh link to any active account.
 */
export const STAFF_WELCOME_TTL_HOURS = 72;

export function staffWelcomeExpiryFrom(now: Date, ttlHours = STAFF_WELCOME_TTL_HOURS): string {
  return new Date(now.getTime() + ttlHours * 60 * 60 * 1000).toISOString();
}

/**
 * Reset link life. PULLED like `MAGIC_LINK_TTL_MINUTES`, but doubled: the form asks the person to
 * CHOOSE (open a password manager, generate, save), and expiring mid-decision pushes them to something
 * quick to type. No longer: it is a bearer credential that replaces a password. Issuing a new one
 * spends every live one (`consumeUnusedFor`).
 */
export const PASSWORD_RESET_TTL_MINUTES = 30;

export function passwordResetExpiryFrom(
  now: Date,
  ttlMinutes = PASSWORD_RESET_TTL_MINUTES,
): string {
  return new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString();
}
