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
  /**
   * When this session was last used, to within `SESSION_TOUCH_MINUTES`.
   *
   * The IDLE clock. `expiresAt` is the ABSOLUTE one and answers a different
   * question — how long one sign-in may last at most — and a session ends on
   * whichever of the two comes first.
   */
  readonly lastSeenAt: string;
}

/**
 * Which door a link opens, and it is READ — see `isUsableMagicLink`.
 *
 *   `login`   pulled by the account holder, lives minutes, opens a session.
 *   `welcome` pushed to a new colleague, lives days, opens a session (0072).
 *   `invite`  the client portal's; redeems ONLY by setting a password, and
 *             never opens a session on its own.
 *   `reset`   the forgotten-password link (0082); pulled like `login`, lives
 *             half an hour, and redeems ONLY by replacing the password. A
 *             session comes out of THAT, never out of the link by itself.
 */
export type MagicLinkPurpose = "login" | "invite" | "welcome" | "reset";

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

/**
 * How long a session may sit UNUSED before it stops working.
 *
 * ── WHY FOURTEEN DAYS WAS NOT ENOUGH ON ITS OWN ────────────────────────────
 *
 * `SESSION_TTL_DAYS` measures from the moment somebody signed in, so it says
 * nothing about whether anybody has touched the session since. A laptop left
 * open in a co-working space, a browser on a phone that has been sold, a
 * session opened on a client's machine to show them something — every one of
 * those stayed valid for a fortnight of doing nothing, and the product could
 * not tell them apart from somebody who signed in this morning.
 *
 * ── AND WHY SEVEN DAYS ─────────────────────────────────────────────────────
 *
 * This is a workspace people are in every working day, so the number wants to
 * be long enough that a holiday, a long weekend or a week on a client site does
 * not sign the whole firm out, and short enough that a machine nobody is using
 * stops being a way in. A week clears the weekend twice over.
 *
 * It cannot be longer than the absolute TTL and there is no point making it
 * equal to it — that would be the same clock written twice.
 */
export const SESSION_IDLE_DAYS = 7;

/**
 * How stale the recorded `lastSeenAt` may get before it is written again.
 *
 * The idle clock needs the session touched on use, and touching it on EVERY
 * request would turn every authenticated read into a write on the hottest row
 * in the system. Five minutes buys almost all of the accuracy for a fraction of
 * the writes: the recorded value is never worse than five minutes stale, which
 * is nothing against a seven-day timeout.
 */
export const SESSION_TOUCH_MINUTES = 5;

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
  if (Date.parse(session.expiresAt) <= now.getTime()) return false;
  // The IDLE clock, and it is checked in the same function as the absolute one
  // deliberately: every caller that asks "is this session good" gets both
  // answers, and there is no path that could acquire one and miss the other.
  return !hasGoneIdle(session, now);
}

/** Whether a session has sat unused past `SESSION_IDLE_DAYS`. */
export function hasGoneIdle(session: Session, now: Date): boolean {
  const idleMs = now.getTime() - Date.parse(session.lastSeenAt);
  return idleMs > SESSION_IDLE_DAYS * 24 * 60 * 60 * 1000;
}

/** Whether the recorded `lastSeenAt` is stale enough to be worth a write. See
 *  `SESSION_TOUCH_MINUTES`: the point is NOT to write on every request. */
export function shouldTouch(session: Session, now: Date): boolean {
  return now.getTime() - Date.parse(session.lastSeenAt) > SESSION_TOUCH_MINUTES * 60 * 1000;
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

/**
 * The purposes that redeem straight into a session.
 *
 * Named as a set rather than left as an `||` at the call site, because the
 * question "which links can open a session without a password?" is the security
 * property of this whole module and it should be answerable by reading one
 * line. `invite` is deliberately absent: redeeming it without setting a password
 * would leave a portal contact with no way back in once it was spent, which is
 * the bug the `purpose` column was first read to prevent.
 *
 * `reset` (0082) is absent for the mirror-image reason, and it is the sharper
 * of the two. Whoever holds a reset link has proved only that they can read a
 * mailbox, and the act that link authorises is REPLACING the credential. A
 * reset spent at the sign-in route would hand out a session while leaving the
 * forgotten password exactly as it was — the person is in, has not fixed
 * anything, and meets the same wall tomorrow. The session they get comes out of
 * the password being set, never out of the link on its own.
 */
export const SESSION_OPENING_PURPOSES: readonly MagicLinkPurpose[] = ["login", "welcome"];

/** Is this link still good for opening a session? */
export function isUsableForSession(link: MagicLink, now: Date): boolean {
  return SESSION_OPENING_PURPOSES.some((purpose) => isUsableMagicLink(link, now, purpose));
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

/**
 * How long a colleague's welcome link stands.
 *
 * Hours rather than the sign-in link's minutes, and hours rather than the
 * portal invite's week, because the three links are handed over in three
 * different situations:
 *
 *   a sign-in link is PULLED — somebody pressed a button ten seconds ago and is
 *   watching their inbox, so fifteen minutes is generous.
 *
 *   a welcome letter is PUSHED at somebody who did not ask, and who may be
 *   added on a Friday evening and read it on Monday morning. Seventy-two hours
 *   covers that and not much more.
 *
 *   a portal invite gets a full week because a CLIENT whose link expired has to
 *   go back to the firm and ask a human — the friction that flow exists to
 *   remove.
 *
 * Staff are the case that can afford to be strict, and it is worth saying why:
 * an expired welcome link is NOT a dead end for them. The login page issues a
 * fresh one to any active account on demand, so the worst outcome is one extra
 * step, taken by somebody who already knows the product exists — which is
 * exactly what the welcome letter told them.
 */
export const STAFF_WELCOME_TTL_HOURS = 72;

export function staffWelcomeExpiryFrom(now: Date, ttlHours = STAFF_WELCOME_TTL_HOURS): string {
  return new Date(now.getTime() + ttlHours * 60 * 60 * 1000).toISOString();
}

/**
 * How long a forgotten-password link stands.
 *
 * ── WHY IT IS NEARER THE SIGN-IN LINK THAN THE INVITATION ─────────────────
 *
 * Both of the other password-setting links in this product are PUSHED, and
 * that is what buys them their long lives: a portal invitation gets a week
 * because a client who lets it expire has to go back to the firm and ask a
 * human, and a colleague's welcome gets 72 hours because it may be read on
 * Monday. A reset is PULLED. Somebody typed their address into a form and is
 * watching their inbox for it, exactly like `MAGIC_LINK_TTL_MINUTES`.
 *
 * ── AND WHY IT IS STILL TWICE THE SIGN-IN LINK'S FIFTEEN MINUTES ──────────
 *
 * Because of what is on the other end of it. A sign-in link is clicked and
 * finished; this one opens a form where a person has to CHOOSE something, and
 * the ones who choose well open a password manager, generate, save, and come
 * back. Fifteen minutes is enough to click a link and not always enough to do
 * that, and an expiry that lands mid-decision sends somebody round the whole
 * loop again — which is how people end up picking something they can type
 * quickly instead.
 *
 * Half an hour, and not more: this is a bearer credential sitting in an inbox
 * that replaces a password, so the window it is stealable in is the thing being
 * bought down. Issuing a new one spends every live one
 * (`consumeUnusedFor`), so the cost of an expired link is one button.
 */
export const PASSWORD_RESET_TTL_MINUTES = 30;

export function passwordResetExpiryFrom(
  now: Date,
  ttlMinutes = PASSWORD_RESET_TTL_MINUTES,
): string {
  return new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString();
}
