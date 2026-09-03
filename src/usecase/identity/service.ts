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
import type { RateLimiter } from "../../platform/ratelimit";
import type { Principal } from "../../platform/callctx";
import type { Membership, UserAccount } from "../../domain/tenancy/model";
import type { EventSink } from "../ledger/ports";
import { normalizeEmail } from "../../domain/tenancy/model";
import type { Session } from "../../domain/identity/model";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  isAcceptablePassword,
  isUsableForSession,
  isUsableMagicLink,
  isUsableSession,
  magicLinkExpiryFrom,
  portalInviteExpiryFrom,
  sessionExpiryFrom,
  staffWelcomeExpiryFrom,
} from "../../domain/identity/model";
import {
  InvalidCredentials,
  InvalidMagicLink,
  TooManyAttempts,
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

/**
 * Per-account budgets. Ten password attempts an hour is generous for a person
 * who has forgotten which passphrase they used and hopeless for a machine
 * working through a list. Three sign-in emails an hour is more than anyone
 * needs and stops the endpoint being used to flood an inbox.
 */
export const LOGIN_ATTEMPTS_PER_WINDOW = 10;
export const LOGIN_WINDOW_SECONDS = 3600;
export const MAGIC_LINKS_PER_WINDOW = 3;
export const MAGIC_LINK_WINDOW_SECONDS = 3600;

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
  readonly events: EventSink;
  /** Keyed on the ACCOUNT, not the caller — see the note on login(). */
  readonly attempts: RateLimiter;
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

/**
 * What came of writing to a new colleague.
 *
 * `sent: false` is a real, ordinary outcome and not an error — see
 * `welcomeStaff` for why this is returned rather than thrown. The two fields
 * are separate because they answer different questions: `sent` decides what the
 * admin's screen says NOW, and `expiresAt` is when the link in the letter stops
 * working, which is only meaningful if one went. It is null when no link was
 * written at all.
 */
export interface StaffWelcome {
  readonly expiresAt: string | null;
  readonly sent: boolean;
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

  /**
   * Sign in with email + password.
   *
   * Throttled PER ACCOUNT, which is a different defence from the edge's
   * per-address limit and does not replace it. A botnet spreads its guesses
   * across a thousand addresses and sails past any per-IP rule; what it cannot
   * spread is the account it is trying to break into.
   *
   * The attempt is counted before the password is checked, not after a failure.
   * Counting only failures would tell an attacker which guesses were right by
   * whether the counter moved, and would let a correct guess reset the budget
   * they are burning.
   */
  async login(email: string, password: string): Promise<SignInResult> {
    const normalized = normalizeEmail(email);

    const budget = await this.deps.attempts.check(
      `login:${normalized}`,
      LOGIN_ATTEMPTS_PER_WINDOW,
      LOGIN_WINDOW_SECONDS,
    );
    if (!budget.allowed) throw new TooManyAttempts(budget.retryAfterSeconds);

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
    // Cleared on success, so one person mistyping their password three times is
    // not then locked out by finally getting it right.
    await this.deps.attempts.reset(`login:${normalized}`);
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

    // Throttled per address, because the cost here lands on someone who did not
    // ask for it: without a limit this endpoint mails an unbounded stream of
    // sign-in links to a person an attacker chooses. It returns quietly rather
    // than raising — the caller already learns nothing from this route, and a
    // 429 here would tell them the address exists.
    const budget = await this.deps.attempts.check(
      `magic-link:${normalized}`,
      MAGIC_LINKS_PER_WINDOW,
      MAGIC_LINK_WINDOW_SECONDS,
    );
    if (!budget.allowed) return;

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
    // ── THE SEND MUST NOT CHANGE THE ANSWER ─────────────────────────────────
    //
    // Everything above this line is careful to tell the caller nothing: an
    // unknown or deactivated account returns early and the route answers 202
    // either way, so submitting an address here reveals nothing about whether
    // it has a login. A THROWN send undoes all of it — the route would answer
    // 202 for an address with no account and 500 for one with an account whose
    // letter would not go, which is an enumeration oracle built out of an error
    // path. It was invisible while `LoggingMailer` was the only mailer,
    // because writing to a log cannot fail; a real relay rejects a recipient,
    // times out, or runs out of quota.
    //
    // So it is swallowed HERE and shouted about in the ADAPTER, which is the
    // only layer that knows a send failed and the only one that may hold a
    // logger. The user is told to check their email and no email arrives — which
    // is bad, and is strictly better than the alternative, and is a fault an
    // operator can see in the log within seconds.
    //
    // `invitePortalContact` below does the OPPOSITE, deliberately: there a
    // member of the firm is watching a screen, there is no account to be quiet
    // about, and a silent failure would be a client who never gets in.
    try {
      await this.deps.mailer.sendMagicLink(
        user.email,
        `${this.deps.magicLinkBaseUrl}/auth/magic-link?token=${encodeURIComponent(token)}`,
        expiresAt,
      );
    } catch {
      // Deliberately empty. See above: the adapter has already logged it.
    }
  }

  /**
   * Invite somebody to set a password — the portal contact's way in.
   *
   * The SAME single-use, hashed, expiring link the sign-in flow uses, with a
   * different purpose and a longer life, pointed at the page where a password
   * is chosen. It is deliberately not a sign-in link: redeeming this one
   * without setting a password is refused, because a contact who never sets one
   * has no way back in after it is consumed.
   *
   * Unlike `requestMagicLink` this DOES tell the caller what happened — a
   * member of the firm is inviting a person they already named, so there is no
   * account to confirm the existence of and nothing to be quiet about.
   */
  async invitePortalContact(userId: string, firmName: string | null): Promise<string> {
    const user = await this.deps.users.findById(userId);
    // The caller has just created or found this account, so a miss here is a
    // race or a deactivated login rather than a typo — and the invite must not
    // be mailed either way. `InvalidMagicLink` is the family's word for "this
    // link cannot come to exist"; there is no `UserNotFound` and inventing one
    // would need a case in `domainerr.ts` to avoid answering 500.
    if (!user || user.status !== "active") throw new InvalidMagicLink();

    const token = this.deps.tokens.newToken();
    const expiresAt = portalInviteExpiryFrom(this.deps.clock.now());
    await this.deps.magicLinks.create({
      id: this.deps.ids.newId(),
      userId: user.id,
      tokenHash: this.deps.tokens.hash(token),
      purpose: "invite",
      expiresAt,
    });
    await this.deps.mailer.sendPortalInvite(
      user.email,
      `${this.deps.magicLinkBaseUrl}/portal/accept-invite?token=${encodeURIComponent(token)}`,
      expiresAt,
      firmName,
    );
    return expiresAt;
  }

  /**
   * Tell a new colleague their account exists, and hand them the way in.
   *
   * ── WHY THIS IS NOT `requestMagicLink` WITH A DIFFERENT SUBJECT ──────────
   *
   * Everything about the two differs except the mechanism. A sign-in link is
   * PULLED by somebody at their keyboard and lives fifteen minutes; this one is
   * PUSHED at somebody who has not heard of the product and may read it on
   * Monday, so it lives seventy-two hours and carries its own purpose (0072) so
   * that widening one does not widen the other. And the letter has to name the
   * firm, because an unasked-for email with a sign-in link in it is, feature for
   * feature, a phishing message.
   *
   * ── AND WHY A FAILED SEND IS REPORTED RATHER THAN THROWN ─────────────────
   *
   * The two neighbours in this file do the two opposite things, and this one is
   * a third case that deserves its own answer rather than either of theirs.
   *
   *   `requestMagicLink` SWALLOWS, because throwing would build an account
   *   enumeration oracle out of an error path.
   *
   *   `invitePortalContact` THROWS, because a client whose invite silently
   *   failed has no other door and nobody watching for them.
   *
   * A colleague has a door. The login page issues a fresh link to any active
   * account, which is exactly what the firm did before this existed. So a
   * failed send here is neither a secret nor a trap — it is a fact the admin
   * standing at the screen should be told, so it is RETURNED. Throwing would be
   * actively worse: the membership is already written by the time this runs, so
   * a 500 would leave a member created, an admin believing the add failed, and
   * a retry refused as a duplicate.
   *
   * The adapter has already shouted about the underlying failure; this decides
   * only what the screen says.
   */
  async welcomeStaff(userId: string, firmName: string | null): Promise<StaffWelcome> {
    const user = await this.deps.users.findById(userId);
    // The caller has just created or found this account, so a miss is a race or
    // a deactivated login rather than a typo — and either way there is nobody to
    // write to. Not an error: the membership stands, and the admin is told the
    // letter did not go.
    if (!user || user.status !== "active") return { expiresAt: null, sent: false };

    const token = this.deps.tokens.newToken();
    const expiresAt = staffWelcomeExpiryFrom(this.deps.clock.now());
    await this.deps.magicLinks.create({
      id: this.deps.ids.newId(),
      userId: user.id,
      tokenHash: this.deps.tokens.hash(token),
      purpose: "welcome",
      expiresAt,
    });
    try {
      await this.deps.mailer.sendStaffWelcome(
        user.email,
        `${this.deps.magicLinkBaseUrl}/auth/magic-link?token=${encodeURIComponent(token)}`,
        expiresAt,
        firmName,
      );
    } catch {
      // Deliberately empty, and REPORTED rather than hidden — see above. The
      // link row stays: it is unreachable, single-use and expiring, and
      // deleting it would be a second write that can itself fail on a path
      // whose whole point is that it does not throw.
      return { expiresAt, sent: false };
    }
    return { expiresAt, sent: true };
  }

  /**
   * Accept an invitation: set the password, and sign in.
   *
   * ONE call, because the two halves must not be separable. A route that only
   * set the password would leave the contact holding a consumed token and a
   * login screen; a route that only signed them in is the magic link again and
   * leaves them with no password at all. The link is consumed FIRST, so a
   * refused password does not spend it twice — and a weak one is refused by
   * `setPassword` before anything is written.
   */
  async acceptPortalInvite(token: string, password: string): Promise<SignInResult> {
    const link = await this.deps.magicLinks.findByTokenHash(this.deps.tokens.hash(token));
    if (!link || !isUsableMagicLink(link, this.deps.clock.now(), "invite")) {
      throw new InvalidMagicLink();
    }
    const user = await this.deps.users.findById(link.userId);
    if (!user || user.status !== "active") throw new InvalidMagicLink();

    // Strength is checked BEFORE the link is spent: a contact who typed
    // something too short must be able to try again with the same email.
    if (!isAcceptablePassword(password)) {
      throw new WeakPassword(MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH);
    }
    const won = await this.deps.magicLinks.consume(link.id, this.deps.clock.now().toISOString());
    if (!won) throw new InvalidMagicLink();

    await this.setPassword(user.id, password);
    return this.openSession(user);
  }

  /** Redeem a magic link for a session. Single use, enforced by the repository's
   *  conditional update — two simultaneous clicks cannot both open a session.
   *  A session-opening link only — `login` or a colleague's `welcome` (0072).
   *  An INVITE is redeemed by setting a password and is refused here, because
   *  spending one without setting a password leaves a portal contact with no
   *  way back in. That is the whole reason `purpose` is read at all. */
  async redeemMagicLink(token: string): Promise<SignInResult> {
    const link = await this.deps.magicLinks.findByTokenHash(this.deps.tokens.hash(token));
    if (!link || !isUsableForSession(link, this.deps.clock.now())) {
      throw new InvalidMagicLink();
    }

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
   *
   * THE MEMBERSHIP IS RE-CHECKED HERE, not just at login and switch. Without
   * this, deactivating someone's membership left their existing session working
   * in that firm until it expired — up to a fortnight of access for someone the
   * firm dismissed this morning, which is the exact scenario server-side
   * sessions exist to prevent. Checking only on the paths that CHANGE the
   * tenant misses the one everybody actually uses.
   *
   * A lost membership strips the tenant rather than killing the session: a
   * person removed from one firm may still work at another, and should land on
   * the org switcher rather than a login screen.
   *
   * The cost is one indexed lookup by user_id per authenticated request, on top
   * of the session lookup. That is the price of revocation taking effect on the
   * next request instead of at expiry, and it is worth paying.
   */
  async resolveSession(token: string): Promise<Principal | null> {
    const session = await this.deps.sessions.findByTokenHash(this.deps.tokens.hash(token));
    if (!session || !isUsableSession(session, this.deps.clock.now())) return null;
    if (session.activeTenantId === null) return toPrincipal(session, undefined);

    // The membership is read for the revocation check above; the role and fee
    // flag ride out of that same read, so gate 3 costs nothing extra.
    const active = (await this.deps.memberships.listByUser(session.userId)).find(
      (m) => m.isActive && m.tenantId === session.activeTenantId,
    );
    if (active) return toPrincipal(session, active);
    return {
      userId: session.userId,
      sessionId: session.id,
      tenantId: null,
      audience: null,
      role: null,
      commercialVisibility: null,
    };
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
    await this.recordSessionStarted(tenantId, userId);
    return toPrincipal(session, membership);
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
  /** One place writes session.started, so the payload cannot drift between the
   *  login path and the org switch. No email, no address, no user agent — the
   *  user id, and the row it points at stays erasable. */
  private async recordSessionStarted(tenantId: string, userId: string): Promise<void> {
    await this.deps.events.recordEvent({
      tenantId,
      verb: "session.started",
      objectId: userId,
      actor: { type: "human", id: userId },
    });
  }

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
    // Recorded only if a tenant was resolved. Every event is tenant-scoped, and
    // a session that has not chosen an org belongs to no firm's timeline yet —
    // switchTenant records it the moment one is chosen. So the question each
    // firm can answer is the one it cares about: when did this person's session
    // become active HERE.
    if (only) await this.recordSessionStarted(only.tenantId, user.id);
    return { token, session, principal: toPrincipal(session, only), memberships };
  }
}

/**
 * The session row plus the membership it is acting under, as the rest of the
 * system sees it.
 *
 * Assigning the domain's Audience to the platform's is what keeps those two
 * unions identical — the compiler fails here if they ever drift.
 *
 * `membership` is undefined only when the session has not chosen an org, in
 * which case there is no role to carry and every gated route refuses on the
 * tenant check first.
 */
function toPrincipal(session: Session, membership: Membership | undefined): Principal {
  return {
    userId: session.userId,
    sessionId: session.id,
    tenantId: session.activeTenantId,
    audience: session.activeAudience,
    role: membership?.role ?? null,
    commercialVisibility: membership?.commercialVisibility ?? null,
  };
}
