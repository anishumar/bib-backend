// The seams identity needs. Note what is a port and what is not: the POLICY
// (how long a session lives, what makes a password acceptable) is domain, and
// the MECHANISM (how bytes are hashed, how randomness is drawn, how an email
// leaves the building) is a port — because each of those is a platform
// decision we expect to change without the login flow noticing.
import type { Membership, UserAccount } from "../../domain/tenancy/model";
import type { MagicLink, MagicLinkPurpose, Session } from "../../domain/identity/model";

// ── Directory: the narrow slice of tenancy identity needs ────────────────────
// Stated as its own interfaces rather than importing tenancy's ports: this use
// case reads users and memberships and never creates them, and a port should
// describe what its owner needs, not what its implementer happens to offer.
// The existing tenancy adapters satisfy these as they stand.

export interface UserDirectory {
  findByEmail(email: string): Promise<UserAccount | null>;
  findById(id: string): Promise<UserAccount | null>;
}

export interface MembershipDirectory {
  /** Every membership of a user, across tenants — read under the identity RLS
   *  context, never a tenant bypass. */
  listByUser(userId: string): Promise<Membership[]>;
}

/**
 * Whether a FIRM is still open for business.
 *
 * `tenancy.tenant.status` has existed since 0001 and, until now, had no reader
 * anywhere: suspending a firm changed a string in a row and nothing else, so a
 * suspended firm kept working exactly as before. That is worse than not having
 * the column — an operator suspends a tenant, sees the status change, and
 * believes something happened.
 *
 * Declared in identity's own words because this is the module that decides
 * whether a request has a tenant context at all; the tenancy repository
 * satisfies it. `tenancy.tenant` is GLOBAL and carries no RLS, so this is a
 * primary-key read on a small table and costs a fraction of a millisecond.
 */
export interface TenantStanding {
  /** False when the firm is suspended, and when it does not exist at all —
   *  which are different facts with the same consequence here. */
  isOpen(tenantId: string): Promise<boolean>;
}

// ── Credentials ──────────────────────────────────────────────────────────────

export interface CredentialRepository {
  findByUserId(userId: string): Promise<{ readonly passwordHash: string } | null>;
  /** Sets or replaces the user's password hash. */
  upsert(userId: string, passwordHash: string): Promise<void>;
}

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  /** Constant-time where the algorithm allows it. Never throws on a malformed
   *  stored hash — it returns false, so a corrupt row denies access rather than
   *  crashing the login route. */
  verify(plain: string, encoded: string): Promise<boolean>;
  /**
   * A syntactically valid hash that matches nothing.
   *
   * The login path verifies against this when the email is unknown, so an
   * unknown address costs the same milliseconds as a known one. Without it the
   * endpoint answers "does this person bank with you?" by response time alone.
   */
  dummyHash(): string;
}

// ── Tokens ───────────────────────────────────────────────────────────────────

export interface TokenFactory {
  /** A fresh, high-entropy, url-safe bearer token. This value is handed to the
   *  client and never stored. */
  newToken(): string;
  /** The digest actually stored, so a database dump yields nothing usable. */
  hash(token: string): string;
}

// ── Sessions and magic links ─────────────────────────────────────────────────

export interface NewSession {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly activeTenantId: string | null;
  readonly activeAudience: Session["activeAudience"];
  readonly expiresAt: string;
}

export interface SessionRepository {
  create(s: NewSession): Promise<Session>;
  findByTokenHash(tokenHash: string): Promise<Session | null>;
  /** The org switch. Both values move together — the paired CHECK enforces it. */
  setActiveContext(
    sessionId: string,
    tenantId: string,
    audience: NonNullable<Session["activeAudience"]>,
  ): Promise<Session>;
  /** Revocation is an UPDATE, not a DELETE: the fact that a session existed and
   *  when it ended is itself worth keeping. */
  revoke(sessionId: string, at: string): Promise<void>;
  /** Every session of one user — a password change, or "log me out everywhere". */
  revokeAllForUser(userId: string, at: string): Promise<number>;
  /**
   * Record that this session was just used — the IDLE clock's write.
   *
   * Called only when the stored value is already stale (`shouldTouch`), so this
   * is one write per session per few minutes rather than one per request. It
   * returns nothing and its failure is not the caller's problem: a touch that
   * does not land costs the session a few minutes of its idle budget, and
   * failing the REQUEST over it would turn a bookkeeping write into an outage.
   */
  touch(sessionId: string, at: string): Promise<void>;
  /**
   * Delete sessions and links that are already dead — expired, revoked or
   * spent, and old enough that nobody is going to ask about them.
   *
   * The one place in this schema with a DELETE grant, and migration 0075 says
   * why: these rows are CREDENTIALS, not records. The trail of who signed in and
   * when is `ledger.event`, which has no DELETE grant and never will.
   *
   * Returns how many of each went, so the sweep can say what it did.
   */
  purgeExpired(before: string): Promise<{ readonly sessions: number; readonly magicLinks: number }>;
}

export interface NewMagicLink {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly purpose: MagicLinkPurpose;
  readonly expiresAt: string;
}

export interface MagicLinkRepository {
  create(m: NewMagicLink): Promise<MagicLink>;
  findByTokenHash(tokenHash: string): Promise<MagicLink | null>;
  /**
   * Marks the link used and reports whether THIS call was the one that did it.
   * False means someone else consumed it first: the check and the write are one
   * conditional UPDATE, so two simultaneous clicks cannot both open a session.
   */
  consume(id: string, at: string): Promise<boolean>;

  /**
   * Spend every unused, unexpired link of one purpose for one user, and say how
   * many were spent.
   *
   * ── WHY ISSUING A LINK MUST KILL THE ONES BEFORE IT ─────────────────────
   *
   * An `invite` link is redeemed by SETTING A PASSWORD. One still live after
   * the contact has set theirs is therefore a password reset sitting in an
   * inbox for a week (`PORTAL_INVITE_TTL_DAYS`), and the resend route is what makes
   * several of them exist at once. Superseding is the standard shape for a
   * re-issued invitation and it is what makes the route safe to offer at all.
   *
   * Marked CONSUMED rather than deleted, for the same reason `revoke` on a
   * session is an update: that a link was issued and when it stopped being
   * usable is itself worth keeping, and `bib_app` holds no DELETE grant here.
   */
  consumeUnusedFor(userId: string, purpose: MagicLinkPurpose, at: string): Promise<number>;
}

// ── Notifications ────────────────────────────────────────────────────────────

export interface Mailer {
  /** Sends the sign-in link. The use case decides WHAT is sent and to whom; the
   *  adapter decides how it looks and which vendor carries it. */
  sendMagicLink(to: string, url: string, expiresAt: string): Promise<void>;

  /**
   * Sends a client contact their invitation to the portal.
   *
   * A SEPARATE method rather than a flag on the one above, because the two
   * letters say different things to different people: one is "here is the link
   * you just asked for", the other arrives unasked, from a firm the reader may
   * not be expecting mail from, and has to name that firm or it reads as
   * phishing. `firmName` exists for exactly that sentence.
   */
  sendPortalInvite(
    to: string,
    url: string,
    expiresAt: string,
    firmName: string | null,
  ): Promise<void>;

  /**
   * Sends a new colleague the letter that tells them the account exists.
   *
   * A THIRD letter, for the same reason the second one is not a flag on the
   * first: this one is pushed at somebody who did not ask, like the portal
   * invite, and so it has to name the firm or it reads as phishing — but it
   * goes to a COLLEAGUE, not a client, and what it hands over is a session
   * rather than a password form. Neither of the other two says the right thing.
   *
   * `firmName` is nullable for the same reason as above: a tenant row that does
   * not resolve degrades the wording rather than trapping somebody outside.
   */
  sendStaffWelcome(
    to: string,
    url: string,
    expiresAt: string,
    firmName: string | null,
  ): Promise<void>;

  /**
   * Sends a client contact who ALREADY HAS A LOGIN their way into the portal.
   *
   * A FOURTH letter, and the reason it exists is a security bug rather than a
   * wording preference. Accounts in this product are global (ADR-02): one
   * person, one login, however many firms they deal with. So a firm can invite
   * somebody who is already staff somewhere else, or already a client contact
   * at another firm — and the ordinary invitation is a link on which a password
   * is CHOSEN, which would have overwritten the password they already had and
   * signed them out of everything.
   *
   * This letter carries a single-use SIGN-IN link instead. Same firm-naming,
   * same expiry, same "if you were not expecting this" paragraph — the only
   * difference is that it hands over a session rather than a password form,
   * because the reader already has a password and it is none of this firm's
   * business.
   */
  sendPortalWelcome(
    to: string,
    url: string,
    expiresAt: string,
    firmName: string | null,
  ): Promise<void>;

  /**
   * Sends somebody the link that replaces a password they have forgotten.
   *
   * ── WHY IT IS A FIFTH METHOD AND NOT `sendMagicLink` WITH ANOTHER URL ────
   *
   * Because the letter has to say what the link DOES, and these two do opposite
   * things. A sign-in link's letter closes with *"if you did not ask for this,
   * nothing has happened and you can ignore this message"* — true, and exactly
   * the wrong thing to tell somebody holding a link that REPLACES their
   * credential. A reader who has been sent an unrequested reset needs to know
   * that the password still works until the link is used, and that ignoring the
   * letter is what keeps it that way.
   *
   * ── AND WHY IT TAKES NO `firmName` WHEN THREE OF ITS NEIGHBOURS DO ───────
   *
   * The other three arrive UNASKED, from a firm the reader may not be expecting
   * mail from, so naming that firm is what stops them reading as phishing. This
   * one is pulled: somebody typed their address into a form seconds ago and is
   * watching for it. And the account is GLOBAL (ADR-02) — one login, however
   * many firms — so there is no single firm this letter could honestly name,
   * and picking one of them would tell the reader something false about which
   * password they are resetting.
   */
  sendPasswordReset(to: string, url: string, expiresAt: string): Promise<void>;
}
