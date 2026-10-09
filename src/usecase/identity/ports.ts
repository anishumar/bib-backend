// Identity's seams. POLICY (session life, password rules) is domain; MECHANISM (hashing, randomness,
// sending mail) is a port, since each is a platform choice that may change under the login flow.
import type { Membership, UserAccount } from "../../domain/tenancy/model";
import type { MagicLink, MagicLinkPurpose, Session } from "../../domain/identity/model";
import type { ClientSender } from "../../domain/mail/model";

// Directory: the narrow slice of tenancy identity reads (never creates); tenancy's adapters satisfy it.

export interface UserDirectory {
  findByEmail(email: string): Promise<UserAccount | null>;
  findById(id: string): Promise<UserAccount | null>;
}

export interface MembershipDirectory {
  /** Every membership of a user across tenants, read under the identity RLS context, never a bypass. */
  listByUser(userId: string): Promise<Membership[]>;
}

/**
 * Whether a FIRM is still open. `tenancy.tenant.status` (0001) had no reader, so a suspended firm kept
 * working while the operator believed it was stopped. `tenancy.tenant` is GLOBAL (no RLS): a cheap PK read.
 */
export interface TenantStanding {
  /** False when the firm is suspended or does not exist: different facts, same consequence here. */
  isOpen(tenantId: string): Promise<boolean>;
}

export interface CredentialRepository {
  findByUserId(userId: string): Promise<{ readonly passwordHash: string } | null>;
  /** Sets or replaces the user's password hash. */
  upsert(userId: string, passwordHash: string): Promise<void>;
}

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  /** Constant-time where possible. Never throws on a malformed stored hash: returns false, so a corrupt
   *  row denies access rather than crashing login. */
  verify(plain: string, encoded: string): Promise<boolean>;
  /** A valid hash that matches nothing. Login verifies against it for an unknown email, so response time
   *  does not reveal whether the address has an account. */
  dummyHash(): string;
}

export interface TokenFactory {
  /** A fresh, high-entropy, url-safe bearer token, handed to the client and never stored. */
  newToken(): string;
  /** The digest actually stored, so a database dump yields nothing usable. */
  hash(token: string): string;
}

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
  /** An UPDATE, not a DELETE: that the session existed and when it ended is worth keeping. */
  revoke(sessionId: string, at: string): Promise<void>;
  /** Every session of one user — a password change, or "log me out everywhere". */
  revokeAllForUser(userId: string, at: string): Promise<number>;
  /**
   * The IDLE clock's write, called only when stale (`shouldTouch`), so one write per few minutes.
   * Its failure is not the caller's: a lost touch costs minutes of idle budget; failing the request
   * would turn bookkeeping into an outage.
   */
  touch(sessionId: string, at: string): Promise<void>;
  /**
   * Delete dead sessions and links (expired, revoked or spent, and old). The schema's one DELETE grant
   * (0075): these rows are CREDENTIALS, not records; the sign-in trail is `ledger.event`. Returns counts.
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
  /** Marks the link used; true only if THIS call did it. One conditional UPDATE, so two simultaneous
   *  clicks cannot both open a session. */
  consume(id: string, at: string): Promise<boolean>;

  /**
   * Spend every unused, unexpired link of one purpose for one user; returns how many. An `invite` still
   * live after a password is set is a week-long password reset in an inbox (`PORTAL_INVITE_TTL_DAYS`),
   * and resend creates several, so issuing must supersede. Marked CONSUMED, not deleted: the history is
   * worth keeping and `bib_app` holds no DELETE grant here.
   */
  consumeUnusedFor(userId: string, purpose: MagicLinkPurpose, at: string): Promise<number>;
}

export interface Mailer {
  /** The sign-in link. The use case decides what and to whom; the adapter, the look and vendor. */
  sendMagicLink(to: string, url: string, expiresAt: string): Promise<void>;

  /**
   * A client contact's portal invitation. Its own method: it arrives unasked from a firm the reader may
   * not expect, so it must name the firm (`firmName`) or it reads as phishing.
   */
  sendPortalInvite(
    to: string,
    url: string,
    expiresAt: string,
    firmName: string | null,
    /** The firm's zone, so the expiry reads on the firm's clock (CA#50). Absent or null: UTC, named. */
    timeZone?: string | null,
    /** The client's Key Manager (Q059): letter from them by name, replies reach them, their address is
     *  the From when the firm listed its domain. Absent or null: from the firm. */
    sender?: ClientSender | null,
  ): Promise<void>;

  /**
   * A new colleague's welcome. Pushed unasked like the portal invite, so it names the firm, but it goes
   * to a COLLEAGUE and hands over a session, not a password form. `firmName` null (tenant row did not
   * resolve) degrades the wording rather than locking somebody out.
   */
  sendStaffWelcome(
    to: string,
    url: string,
    expiresAt: string,
    firmName: string | null,
    timeZone?: string | null,
    extra?: StaffWelcomeExtras,
  ): Promise<void>;

  /**
   * A portal way-in for a contact who ALREADY HAS A LOGIN. Accounts are global (ADR-02), so the ordinary
   * invite (a password is CHOSEN) would overwrite their existing password and sign them out everywhere.
   * This carries a single-use SIGN-IN link instead; same firm-naming, expiry and "not expecting this" text.
   */
  sendPortalWelcome(
    to: string,
    url: string,
    expiresAt: string,
    firmName: string | null,
    timeZone?: string | null,
    /** As on the invitation (Q059). */
    sender?: ClientSender | null,
  ): Promise<void>;

  /**
   * The forgotten-password link. Not `sendMagicLink`: the letter must say the password still works until
   * the link is used and that ignoring it keeps it so (a sign-in letter's "nothing has happened" is wrong
   * here). No `firmName`: it is pulled, not unasked, and the account is GLOBAL (ADR-02), so no single
   * firm could honestly be named.
   */
  sendPasswordReset(to: string, url: string, expiresAt: string): Promise<void>;
}

/** What else the staff welcome says (audit 2026-10-03). */
export interface StaffWelcomeExtras {
  /** Who added them, so the letter names a person (CA#50). Null when they have no name yet. */
  readonly addedBy?: string | null | undefined;
  /** No password yet: the link opens the first-password page (CA#38). False: it only signs them in. */
  readonly choosePassword?: boolean | undefined;
}
