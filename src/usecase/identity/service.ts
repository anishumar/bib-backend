// The identity use case — sign in, prove a session, switch org, sign out.
//
// Two themes run through it and explain most of the code that is not obvious:
//
//   1. FAILURES ARE INDISTINGUISHABLE FROM OUTSIDE. An unknown email costs the
//      same time as a known one and returns the same error; requesting a magic
//      link for an address with no account succeeds silently. A firm's client
//      list is confidential, and a login endpoint that says "no such user" is a
//      free membership oracle for anyone who can send requests.
//
//   2. A SESSION IS SERVER-SIDE AND REVOCABLE. Every check ends in
//      isUsableSession(), so revoking a row ends access on the next request —
//      the behaviour a firm expects the afternoon it dismisses someone.
import type { IdGen } from "../../platform/ids";
import type { Clock } from "../../platform/clock";
import type { Principal } from "../../platform/callctx";
import type { Membership, UserAccount } from "../../domain/tenancy/model";
import { normalizeEmail } from "../../domain/tenancy/model";
import type { Session } from "../../domain/identity/model";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  isAcceptablePassword,
  isUsableMagicLink,
  isUsableSession,
  magicLinkExpiryFrom,
  sessionExpiryFrom,
} from "../../domain/identity/model";
import {
  InvalidCredentials,
  InvalidMagicLink,
  NoActiveMembership,
  NotAMember,
  UserDisabled,
  WeakPassword,
} from "../../domain/identity/errors";
import type {
  CredentialRepository,
  Mailer,
  MagicLinkRepository,
  MembershipDirectory,
  PasswordHasher,
  SessionRepository,
  TokenFactory,
  UserDirectory,
} from "./ports";

export interface Deps {
  readonly users: UserDirectory;
  readonly memberships: MembershipDirectory;
  readonly credentials: CredentialRepository;
  readonly sessions: SessionRepository;
  readonly magicLinks: MagicLinkRepository;
  readonly passwords: PasswordHasher;
  readonly tokens: TokenFactory;
  readonly mailer: Mailer;
  readonly ids: IdGen;
  readonly clock: Clock;
  /** Where a magic link sends the user — the frontend's redemption page. From
   *  config, injected: this layer never reads the environment. */
  readonly magicLinkBaseUrl: string;
}

/** What a successful sign-in yields. The token is returned exactly once, here;
 *  it is never stored and never readable again. */
export interface SignInResult {
  /** The bearer token to put in the session cookie. */
  readonly token: string;
  readonly session: Session;
  readonly principal: Principal;
  /** The org switcher's data: if this holds more than one entry, the session
   *  has no active tenant yet and the client must call switchTenant. */
  readonly memberships: readonly Membership[];
}

export class IdentityService {
  constructor(private readonly deps: Deps) {}

  /**
   * Set or replace a user's password.
   *
   * Every existing session of that user is revoked. A password change is what
   * someone does after "I think my laptop was stolen", and a change that leaves
   * the thief's session alive answers the wrong question.
   */
  async setPassword(userId: string, password: string): Promise<void> {
    if (!isAcceptablePassword(password)) {
      throw new WeakPassword(MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH);
    }
    const hash = await this.deps.passwords.hash(password);
    await this.deps.credentials.upsert(userId, hash);
    await this.deps.sessions.revokeAllForUser(userId, this.deps.clock.now().toISOString());
  }

  /** Sign in with email + password. */
  async login(email: string, password: string): Promise<SignInResult> {
    const normalized = normalizeEmail(email);
    const user = await this.deps.users.findByEmail(normalized);

    // The unknown-email path still pays for a hash comparison, so response time
    // does not distinguish "no account" from "wrong password".
    const stored = user ? await this.deps.credentials.findByUserId(user.id) : null;
    const encoded = stored?.passwordHash ?? this.deps.passwords.dummyHash();
    const ok = await this.deps.passwords.verify(password, encoded);
    if (!user || !stored || !ok) throw new InvalidCredentials();

    // Only past a correct password do we say anything more specific. These two
    // are worth naming — a disabled user or one with no membership needs to
    // know why, and by this point the caller has already proved who they are.
    if (user.status !== "active") throw new UserDisabled(normalized);
    return this.openSession(user);
  }

  /**
   * Email a single-use sign-in link.
   *
   * Always resolves, whether or not the address has an account. The caller
   * learns nothing; the person who owns the inbox learns everything.
   */
  async requestMagicLink(email: string): Promise<void> {
    const normalized = normalizeEmail(email);
    const user = await this.deps.users.findByEmail(normalized);
    if (!user || user.status !== "active") return;

    const now = this.deps.clock.now();
    const token = this.deps.tokens.newToken();
    const expiresAt = magicLinkExpiryFrom(now);
    await this.deps.magicLinks.create({
      id: this.deps.ids.newId(),
      userId: user.id,
      tokenHash: this.deps.tokens.hash(token),
      purpose: "login",
      expiresAt,
    });
    await this.deps.mailer.sendMagicLink(
      user.email,
      `${this.deps.magicLinkBaseUrl}/auth/magic-link?token=${encodeURIComponent(token)}`,
      expiresAt,
    );
  }

  /** Redeem a magic link for a session. Single use, enforced by the repository's
   *  conditional update — two simultaneous clicks cannot both open a session. */
  async redeemMagicLink(token: string): Promise<SignInResult> {
    const link = await this.deps.magicLinks.findByTokenHash(this.deps.tokens.hash(token));
    if (!link || !isUsableMagicLink(link, this.deps.clock.now())) throw new InvalidMagicLink();

    const won = await this.deps.magicLinks.consume(link.id, this.deps.clock.now().toISOString());
    if (!won) throw new InvalidMagicLink();

    const user = await this.deps.users.findById(link.userId);
    if (!user || user.status !== "active") throw new InvalidMagicLink();
    return this.openSession(user);
  }

  /**
   * Turn a bearer token into a principal, or null.
   *
   * This runs on every authenticated request. It returns null rather than
   * throwing, because "not signed in" is an ordinary state of the world and the
   * edge decides what to do about it.
   */
  async resolveSession(token: string): Promise<Principal | null> {
    const session = await this.deps.sessions.findByTokenHash(this.deps.tokens.hash(token));
    if (!session || !isUsableSession(session, this.deps.clock.now())) return null;
    return toPrincipal(session);
  }

  /** The org switch: point an existing session at another of the user's tenants.
   *  The membership is re-checked here, so a revoked membership cannot be
   *  switched into even with a valid session. */
  async switchTenant(sessionId: string, userId: string, tenantId: string): Promise<Principal> {
    const membership = (await this.deps.memberships.listByUser(userId)).find(
      (m) => m.isActive && m.tenantId === tenantId,
    );
    if (!membership) throw new NotAMember(tenantId);
    const session = await this.deps.sessions.setActiveContext(
      sessionId,
      tenantId,
      membership.audience,
    );
    return toPrincipal(session);
  }

  /** Sign out. Idempotent: an unknown or already-revoked token is a no-op, so a
   *  double-clicked logout button is not an error. */
  async logout(token: string): Promise<void> {
    const session = await this.deps.sessions.findByTokenHash(this.deps.tokens.hash(token));
    if (!session || session.revokedAt !== null) return;
    await this.deps.sessions.revoke(session.id, this.deps.clock.now().toISOString());
  }

  /** Ends every session a user holds — the "log me out everywhere" control, and
   *  what an administrator reaches for when someone leaves the firm. */
  async revokeAllSessions(userId: string): Promise<number> {
    return this.deps.sessions.revokeAllForUser(userId, this.deps.clock.now().toISOString());
  }

  /**
   * Open a session for an authenticated user.
   *
   * The active tenant is chosen here when there is exactly one active
   * membership — the common case, and it saves the client a round trip. With
   * several, the session starts with no tenant and the org switcher picks: a
   * partner who belongs to two firms must SAY which one they are acting as,
   * because every downstream gate keys on that answer.
   */
  private async openSession(user: UserAccount): Promise<SignInResult> {
    const memberships = (await this.deps.memberships.listByUser(user.id)).filter((m) => m.isActive);
    if (memberships.length === 0) throw new NoActiveMembership(user.email);

    const only = memberships.length === 1 ? memberships[0] : undefined;
    const now = this.deps.clock.now();
    const token = this.deps.tokens.newToken();
    const session = await this.deps.sessions.create({
      id: this.deps.ids.newId(),
      userId: user.id,
      tokenHash: this.deps.tokens.hash(token),
      activeTenantId: only?.tenantId ?? null,
      activeAudience: only?.audience ?? null,
      expiresAt: sessionExpiryFrom(now),
    });
    return { token, session, principal: toPrincipal(session), memberships };
  }
}

/** The session row, as the rest of the system sees it. Assigning the domain's
 *  Audience to the platform's is what keeps those two unions identical — the
 *  compiler fails here if they ever drift. */
function toPrincipal(session: Session): Principal {
  return {
    userId: session.userId,
    sessionId: session.id,
    tenantId: session.activeTenantId,
    audience: session.activeAudience,
  };
}
