// The identity domain — credentials, sessions and magic links as nouns plus the
// pure rules that decide whether one is usable. Stdlib only: no crypto, no
// database, no notion of a cookie. Hashing and random-token generation are
// ports (usecase/identity/ports.ts) because they are I/O-shaped and platform
// specific; the POLICY about them lives here.
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
}

export type MagicLinkPurpose = "login" | "invite";

export interface MagicLink {
  readonly id: string;
  readonly userId: string;
  readonly purpose: MagicLinkPurpose;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
}

// ── Policy ───────────────────────────────────────────────────────────────────

/**
 * How long a session lives. Fourteen days is the reference implementation's
 * figure and is a deliberate balance: long enough that staff are not re-typing
 * a password every morning, short enough that a forgotten laptop stops working
 * inside a fortnight. Revocation, not expiry, is the answer to "we let someone
 * go this morning" — which is why sessions are server-side.
 */
export const SESSION_TTL_DAYS = 14;

/** A magic link is a bearer credential sitting in an inbox, so it is short.
 *  Fifteen minutes is enough to switch to an email client and click. */
export const MAGIC_LINK_TTL_MINUTES = 15;

/**
 * Minimum password length, and no composition rules — this follows NIST
 * SP 800-63B rather than the older "one uppercase, one symbol" folklore, which
 * measurably pushes people toward `Passw0rd!` and a sticky note. Length is the
 * property that resists guessing.
 *
 * The maximum exists for a different reason: every candidate password is run
 * through a deliberately slow hash, so an unbounded one is a way to make the
 * server do unbounded work.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

export function isAcceptablePassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH;
}

// ── Pure rules ───────────────────────────────────────────────────────────────

/** A session is usable when it has not been revoked and has not expired.
 *  Everything that asks "is this request authenticated" ends here. */
export function isUsableSession(session: Session, now: Date): boolean {
  if (session.revokedAt !== null) return false;
  return Date.parse(session.expiresAt) > now.getTime();
}

/** A magic link is usable exactly once, and only before it expires. */
/**
 * Is this link still good FOR THIS PURPOSE?
 *
 * `purpose` has been a CHECKed column since 0004 (`login` | `invite`) and
 * nothing read it until the portal invite existed — the "registered thing with
 * no reader" shape this codebase keeps finding, and here it had teeth: an
 * INVITE link redeemed at the sign-in route would have opened a session without
 * the password ever being set, which is the one step an invite exists to make
 * happen. The caller now says which kind it is holding and a link of the other
 * kind is simply not usable.
 */
export function isUsableMagicLink(link: MagicLink, now: Date, purpose: MagicLinkPurpose): boolean {
  if (link.purpose !== purpose) return false;
  if (link.consumedAt !== null) return false;
  return Date.parse(link.expiresAt) > now.getTime();
}

/** How long a portal invite stands. Days rather than the sign-in link's
 *  minutes: a client contact reads their email when they read it, and an invite
 *  that expired before they opened it sends them back to the firm — which is
 *  the friction this whole flow exists to remove. Still single-use, still
 *  hashed at rest, and a fresh invite invalidates nothing but itself. */
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
