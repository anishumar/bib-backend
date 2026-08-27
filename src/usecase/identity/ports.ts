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
}

// ── Notifications ────────────────────────────────────────────────────────────

export interface Mailer {
  /** Sends the sign-in link. The use case decides WHAT is sent and to whom; the
   *  adapter decides how it looks and which vendor carries it. */
  sendMagicLink(to: string, url: string, expiresAt: string): Promise<void>;
}
