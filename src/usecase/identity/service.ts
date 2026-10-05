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
import type { Clock, Sleeper } from "../../platform/clock";
import type { RateLimiter } from "../../platform/ratelimit";
import type { Principal } from "../../platform/callctx";
import type { Membership, UserAccount } from "../../domain/tenancy/model";
import type { EventSink } from "../ledger/ports";
import { normalizeEmail } from "../../domain/tenancy/model";
import type { Session } from "../../domain/identity/model";
import type { ClientSender } from "../../domain/mail/model";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  isAcceptablePassword,
  isUsableForSession,
  isUsableMagicLink,
  isUsableSession,
  shouldTouch,
  magicLinkExpiryFrom,
  passwordResetExpiryFrom,
  portalInviteExpiryFrom,
  sessionExpiryFrom,
  staffWelcomeExpiryFrom,
} from "../../domain/identity/model";
import {
  CurrentPasswordIncorrect,
  InvalidCredentials,
  InvalidMagicLink,
  InvitationAlreadyAccepted,
  NoPasswordSet,
  PasswordAlreadySet,
  PasswordUnchanged,
  retryIn,
  SessionInvalid,
  TooManyAttempts,
  NoActiveMembership,
  NotAMember,
  UserDisabled,
  UserNotFound,
  WeakPassword,
} from "../../domain/identity/errors";
import type {
  CredentialRepository,
  Mailer,
  MagicLinkRepository,
  MembershipDirectory,
  PasswordHasher,
  SessionRepository,
  TenantStanding,
  TokenFactory,
  UserDirectory,
} from "./ports";

/**
 * Per-account budgets. Ten password attempts an hour is generous for a person
 * who has forgotten which passphrase they used and hopeless for a machine
 * working through a list. Three sign-in emails an hour is more than anyone
 * needs and stops the endpoint being used to flood an inbox.
 *
 * -- AND WHY THERE ARE NOW TWO LOGIN BUDGETS --------------------------------
 *
 * There was one, keyed on the account and spent before the password was
 * checked. It did stop a botnet grinding one person's password -- and it also
 * meant anyone who knew an email address could lock its owner out for an hour
 * with ten deliberately wrong guesses, with no CAPTCHA, no back-off and no way
 * to end it but waiting. A control a stranger can aim at a named person is a
 * denial of service wearing a security control's clothes.
 *
 * The fix is to spend the tight budget PER CALLER. A guesser gets ten tries an
 * hour at an account and then their own address is refused; the account's owner
 * is untouched, because their address has its own ten. Everything the old
 * budget defended is still defended, and the weapon points back at the person
 * holding it.
 *
 * That leaves the distributed case -- a thousand addresses, ten guesses each --
 * which is what the second budget below is for.
 */
export const LOGIN_ATTEMPTS_PER_WINDOW = 10;
export const LOGIN_WINDOW_SECONDS = 3600;

/**
 * The whole-account budget, across every caller.
 *
 * Fifty an hour is far past anything a person does and far under what a botnet
 * needs. It exists because the per-caller budget above is, by construction, per
 * caller: a thousand hosts each spending ten would otherwise be a thousand
 * times the intended rate against one account.
 *
 * Crucially it decides only what a WRONG password costs. It is read after the
 * verification, never before, so it cannot refuse somebody who typed the right
 * thing -- which is what stops it becoming the lockout weapon the tight budget
 * used to be.
 */
export const LOGIN_ACCOUNT_ATTEMPTS_PER_WINDOW = 50;


/**
 * How long `POST /auth/magic-link` takes, whoever asked and whether or not the
 * address has an account.
 *
 * -- THE ORACLE THIS CLOSES --------------------------------------------------
 *
 * Everything in `requestMagicLink` is careful to say nothing: unknown address,
 * inactive account and rate-limited caller all return quietly and the route
 * answers 202 to all of them. The one thing it could not hide was how long it
 * took. A known address generates a token, hashes it, INSERTs a row and hands a
 * letter to the mailer; an unknown one returns after a single SELECT. Measured
 * against the logging mailer that was 7-8 ms versus 14-22 ms — enough to
 * enumerate a firm's client list with a stopwatch, and a real SMTP relay widens
 * the gap to hundreds of milliseconds.
 *
 * The login route already pays a dummy hash for exactly this reason. This is
 * the same idea, expressed as a floor rather than as fake work, because the
 * work here is a network send and there is no cheap imitation of one.
 *
 * 400 ms is comfortably above the slow path's own cost, so the padding is what
 * dominates and the remaining variance is noise. It is a cost paid only by this
 * one route, which nobody calls in a loop.
 */
export const MAGIC_LINK_FLOOR_MS = 400;
export const MAGIC_LINKS_PER_WINDOW = 3;
export const MAGIC_LINK_WINDOW_SECONDS = 3600;

/**
 * Re-invitations to one CONTACT, per hour.
 *
 * Keyed on the account being written to and not on the member of the firm
 * pressing the button, because the cost of getting this wrong lands on somebody
 * outside the firm: without a limit, this route mails an unbounded stream of
 * letters to a client an attacker — or a stuck retry loop, or an impatient
 * partner — chooses. Three is more than a lost link ever needs.
 *
 * Unlike `requestMagicLink`'s budget this one is REPORTED, as a 429. That one
 * returns quietly because answering differently would confirm the address has
 * an account; here the caller is a member of the firm looking at a contact they
 * already named, so there is nothing to be quiet about, and silence would look
 * exactly like the send failing.
 */
export const PORTAL_INVITE_RESENDS_PER_WINDOW = 3;
export const PORTAL_INVITE_RESEND_WINDOW_SECONDS = 3600;

/**
 * Forgotten-password links to one ADDRESS, per hour.
 *
 * The same three-an-hour `requestMagicLink` gets, and for the same reason: the
 * cost of an unlimited one lands on somebody who did not ask for it, because
 * anybody on the internet can type any address into this form. And like that
 * one it is REFUSED QUIETLY — the route answers 202 whatever happened, so a 429
 * would be the one response that confirmed the address has an account.
 *
 * Three is generous for the real case. Issuing a link spends every live one, so
 * pressing the button again is what somebody does when the first letter has not
 * arrived yet, and the second and third are the ones that go when it turns out
 * to be slow rather than lost.
 */
export const PASSWORD_RESETS_PER_WINDOW = 3;
export const PASSWORD_RESET_WINDOW_SECONDS = 3600;

/**
 * Attempts at the CURRENT password on the change route, per account, per hour.
 *
 * ── WHAT IT IS ACTUALLY DEFENDING ─────────────────────────────────────────
 *
 * Not the account — the caller is already inside it, and holding the session is
 * enough to do everything the session can do. It is defending the PASSWORD as a
 * string, which is a different asset: people reuse them, so a session lifted
 * from a shared machine that could be made to confirm "is it `Monsoon2026`?"
 * fifty thousand times would be an offline cracking rig with a network hop in
 * it, aimed at the person's bank rather than at this product.
 *
 * Ten an hour leaves that worthless and is far past what a person who is
 * *changing* a password they just typed on the way in will ever need. Cleared
 * on success, like the login budgets, so somebody who fumbles it twice and then
 * gets it right is not left throttled.
 *
 * Keyed on the ACCOUNT and not on the caller, which is the opposite of
 * `login`'s tight budget — and the lockout worry that shaped that one does not
 * arise here, because a stranger cannot reach this route at all. Getting to it
 * requires a live session for the very account being throttled.
 */
export const PASSWORD_CHANGE_ATTEMPTS_PER_WINDOW = 10;
export const PASSWORD_CHANGE_WINDOW_SECONDS = 3600;

export interface Deps {
  readonly users: UserDirectory;
  readonly memberships: MembershipDirectory;
  /** Whether the firm a session points at is still open. See `TenantStanding`:
   *  the column had no reader, so suspending a firm did nothing at all. */
  readonly tenants: TenantStanding;
  readonly credentials: CredentialRepository;
  readonly sessions: SessionRepository;
  readonly magicLinks: MagicLinkRepository;
  readonly passwords: PasswordHasher;
  readonly tokens: TokenFactory;
  readonly mailer: Mailer;
  readonly ids: IdGen;
  readonly clock: Clock;
  /**
   * How this service waits. Only `requestMagicLink` uses it, to hold its
   * answer for a constant time — see `MAGIC_LINK_FLOOR_MS`.
   *
   * Optional so that every existing harness keeps working; absent means no
   * floor, which is right for a unit test and wrong for a server, and the
   * composition root supplies the real one.
   */
  readonly sleeper?: Sleeper;
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
/**
 * What came of sending a portal invitation again.
 *
 * `supersededLinks` is not decoration: it is how many still-live password
 * setters this issue spent, and it is the number the ledger event carries. Zero
 * is the ordinary answer when the first link has already expired — which is the
 * commonest reason anybody presses the button — and anything above one means
 * the contact had been re-invited before and had not acted.
 */
export interface ResentInvitation {
  readonly expiresAt: string;
  readonly supersededLinks: number;
}

export interface StaffWelcome {
  readonly expiresAt: string | null;
  readonly sent: boolean;
}

/**
 * The password page a portal invitation opens, with the firm's NAME beside the
 * token (CA#55). That page has no session to ask whose invitation it is, and a
 * page that only says "Choose a password" is the one thing in the invitation
 * that does not name the firm. The name is display only: the token is what
 * authorises, so a link whose name was edited carries a token that is good for
 * nothing, and the page caps what it shows.
 */
function inviteUrl(base: string, token: string, firmName: string | null): string {
  const firm = firmName === null || firmName.trim() === "" ? "" : `&firm=${encodeURIComponent(firmName.trim())}`;
  return `${base}/portal/accept-invite?token=${encodeURIComponent(token)}${firm}`;
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
    // Asked BEFORE the hash, not because of the cost but because of the answer.
    // Without it the credential insert's foreign key failed, nothing mapped
    // that, and a provisioning caller who mistyped a uuid was told "internal
    // error" — sending them to look for a fault in this service instead of at
    // the id they sent. The only caller that reaches this with an unknown id
    // holds `identity.grant`, so naming the miss tells them nothing they could
    // not already find out.
    const user = await this.deps.users.findById(userId);
    if (!user) throw new UserNotFound(userId);
    const hash = await this.deps.passwords.hash(password);
    await this.deps.credentials.upsert(userId, hash);
    await this.deps.sessions.revokeAllForUser(userId, this.deps.clock.now().toISOString());
  }

  /**
   * Sign in with email + password.
   *
   * Throttled PER ACCOUNT AND PER CALLER, which is a different defence from the
   * edge's per-address limit and does not replace it. The edge asks "is this
   * address making too many requests"; this asks "is this address making too
   * many attempts at THIS account", which is the question a credential-stuffing
   * run answers wrongly while staying under every per-address limit.
   *
   * See the budgets above for why there are two and why neither can be aimed at
   * a person by a stranger. In short:
   *
   *   the TIGHT budget is per (account, caller) and is spent BEFORE the password
   *   is checked, so a guesser pays for their guesses whether or not they are
   *   right -- and pays out of their own bucket, never the owner's;
   *
   *   the WIDE budget is per account across every caller and is consulted only
   *   AFTER a wrong password, so it closes the door on a distributed grind and
   *   can never refuse somebody who typed the right thing.
   *
   * `caller` is the rate limiter's key for where the request came from, handed
   * down from the edge because that is the only layer that knows whether a
   * forwarded header may be believed. An absent caller collapses to one shared
   * bucket, which fails closed.
   */
  async login(email: string, password: string, caller?: string | null): Promise<SignInResult> {
    const normalized = normalizeEmail(email);
    const perCaller = `login:${normalized}:${caller ?? "unknown-client"}`;
    const perAccount = `login:${normalized}`;

    const budget = await this.deps.attempts.check(
      perCaller,
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
    if (!user || !stored || !ok) {
      // The wide budget is spent HERE, on the failure, and read in the same
      // breath. Spending it on every attempt would make it the lockout weapon
      // the tight one used to be; spending it only on failures means the worst
      // an attacker achieves is to make their own wrong guesses answer 429
      // rather than 401.
      const account = await this.deps.attempts.check(
        perAccount,
        LOGIN_ACCOUNT_ATTEMPTS_PER_WINDOW,
        LOGIN_WINDOW_SECONDS,
      );
      if (!account.allowed) throw new TooManyAttempts(account.retryAfterSeconds);
      throw new InvalidCredentials();
    }

    // Only past a correct password do we say anything more specific. These two
    // are worth naming — a disabled user or one with no membership needs to
    // know why, and by this point the caller has already proved who they are.
    if (user.status !== "active") throw new UserDisabled(normalized);
    // Cleared on success, so one person mistyping their password three times is
    // not then locked out by finally getting it right. BOTH buckets: somebody
    // who has just proved they own the account is the best evidence there is
    // that the failures before it were theirs.
    await this.deps.attempts.reset(perCaller);
    await this.deps.attempts.reset(perAccount);
    return this.openSession(user);
  }

  /**
   * Email a single-use sign-in link.
   *
   * Always resolves, whether or not the address has an account. The caller
   * learns nothing; the person who owns the inbox learns everything.
   */
  async requestMagicLink(email: string): Promise<void> {
    // Every `return` below is an early one that says nothing — and used to say
    // it FASTER than the path that does the work, which is an enumeration
    // oracle built out of a stopwatch. The whole body is wrapped so that every
    // exit, including a thrown one, is held to the same floor.
    const startedAt = this.deps.clock.now().getTime();
    try {
      await this.issueMagicLink(email);
    } finally {
      const spent = this.deps.clock.now().getTime() - startedAt;
      if (spent < MAGIC_LINK_FLOOR_MS) {
        await this.deps.sleeper?.sleep(MAGIC_LINK_FLOOR_MS - spent);
      }
    }
  }

  private async issueMagicLink(email: string): Promise<void> {
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
   * Email somebody the link that replaces a password they have forgotten.
   *
   * ── WHY THE PRODUCT NEEDED THIS AND DID NOT HAVE IT (0082) ──────────────
   *
   * Nothing in this product could write a credential except
   * `PUT /internal/v1/users/{userId}/password`, behind the platform key. So a
   * client contact who forgot the password they chose on their invitation was
   * finished: the invite link is spent, `resendPortalInvite` refuses them once a
   * credential exists — deliberately, because re-issuing it would be the firm
   * resetting its own client's password — and the sign-in link gets them in
   * without fixing anything, so they meet the same wall next time. And a
   * colleague, who usually has no password at all, had no way to set a first
   * one.
   *
   * ── IT IS `requestMagicLink`, LINE FOR LINE, AND THAT IS DELIBERATE ──────
   *
   * Same silence, same per-address budget, same constant-time floor, same
   * swallowed send. Everything that endpoint does to avoid telling an anonymous
   * caller whether an address has an account applies here unchanged — this one
   * is reachable by exactly the same strangers, and a firm's client list is
   * exactly as confidential. The one thing it adds is `consumeUnusedFor`: a
   * reset link REPLACES a credential, so two live ones are two password setters
   * in one inbox and the second is the one nobody remembers is there.
   *
   * ── AND IT DOES NOT CHECK WHETHER A PASSWORD EXISTS ─────────────────────
   *
   * On purpose, twice over. Refusing an account that has none would be the
   * enumeration oracle again, in a subtler dress — "which of your staff have
   * passwords" is not a question this route may answer. And setting a FIRST
   * password is a thing people legitimately want to do here: most colleagues
   * have never had one, and this is the flow `NoPasswordSet` sends them to.
   */
  async requestPasswordReset(email: string): Promise<void> {
    // The same wrapper `requestMagicLink` has, for the same reason: every exit
    // below says nothing, and an exit that says nothing FASTER is an
    // enumeration oracle built out of a stopwatch.
    const startedAt = this.deps.clock.now().getTime();
    try {
      await this.issuePasswordReset(email);
    } finally {
      const spent = this.deps.clock.now().getTime() - startedAt;
      if (spent < MAGIC_LINK_FLOOR_MS) {
        await this.deps.sleeper?.sleep(MAGIC_LINK_FLOOR_MS - spent);
      }
    }
  }

  private async issuePasswordReset(email: string): Promise<void> {
    const normalized = normalizeEmail(email);

    // Quietly, never as a 429 — see PASSWORD_RESETS_PER_WINDOW. A distinct
    // answer here would tell the caller the address exists, which is the one
    // thing the whole method is arranged not to do.
    const budget = await this.deps.attempts.check(
      `password-reset:${normalized}`,
      PASSWORD_RESETS_PER_WINDOW,
      PASSWORD_RESET_WINDOW_SECONDS,
    );
    if (!budget.allowed) return;

    const user = await this.deps.users.findByEmail(normalized);
    if (!user || user.status !== "active") return;

    const now = this.deps.clock.now();
    // THE LIVE ONES DIE FIRST. `resendPortalInvite`'s argument applies with
    // more force here, because this button is pressed by the person themselves
    // and is pressed repeatedly: without this, somebody who asks three times in
    // five minutes leaves three thirty-minute password setters in a mailbox,
    // and the two they did not use are the ones that matter — they are still
    // live after the one they did use has put things right.
    await this.deps.magicLinks.consumeUnusedFor(user.id, "reset", now.toISOString());

    const token = this.deps.tokens.newToken();
    const expiresAt = passwordResetExpiryFrom(now);
    await this.deps.magicLinks.create({
      id: this.deps.ids.newId(),
      userId: user.id,
      tokenHash: this.deps.tokens.hash(token),
      purpose: "reset",
      expiresAt,
    });
    try {
      await this.deps.mailer.sendPasswordReset(
        user.email,
        `${this.deps.magicLinkBaseUrl}/auth/reset-password?token=${encodeURIComponent(token)}`,
        expiresAt,
      );
    } catch {
      // Deliberately empty, and it is the same security decision as
      // `issueMagicLink`'s: a thrown send would answer 202 for an address with
      // no account and 500 for one with an account whose letter would not go.
      // The adapter has already shouted about the underlying failure.
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
  async invitePortalContact(
    userId: string,
    firmName: string | null,
    timeZone?: string | null,
    sender?: ClientSender | null,
  ): Promise<string> {
    const user = await this.deps.users.findById(userId);
    // The caller has just created or found this account, so a miss here is a
    // race or a deactivated login rather than a typo — and the invite must not
    // be mailed either way. `InvalidMagicLink` is the family's word for "this
    // link cannot come to exist"; there is no `UserNotFound` and inventing one
    // would need a case in `domainerr.ts` to avoid answering 500.
    if (!user || user.status !== "active") throw new InvalidMagicLink();

    // ── WHOSE PASSWORD IS THIS, ANYWAY ───────────────────────────────────────
    //
    // Identity is ABOVE tenant (ADR-02): one account per person, shared by
    // every firm they deal with. So the address a partner types into "invite
    // this client's CFO" may already belong to somebody — a colleague at
    // another firm on this product, or a contact another firm invited last
    // year. The ordinary invitation is a link on which a password is CHOSEN,
    // and `acceptPortalInvite` sets it through `setPassword`, which upserts the
    // one credential row and revokes every session that account holds.
    //
    // Which means, before this branch: any firm could send an invitation to any
    // address, and the moment the recipient opened it — a perfectly ordinary
    // thing to do with a letter that names a firm you actually work with —
    // their password everywhere was replaced and every session they held died.
    // No confirmation, no notice, no trace outside this firm's ledger.
    //
    // The resend path already refused this case (`InvitationAlreadyAccepted`);
    // the first-invite path never looked. It looks now, and it DOWNGRADES
    // rather than refusing: refusing would mean a firm simply cannot give
    // portal access to somebody who has an account, which is a real client
    // whose CFO happens to work with two firms. A single-use sign-in link gets
    // them in and leaves their credential alone.
    const existing = await this.deps.credentials.findByUserId(user.id);

    const token = this.deps.tokens.newToken();
    const expiresAt = portalInviteExpiryFrom(this.deps.clock.now());
    await this.deps.magicLinks.create({
      id: this.deps.ids.newId(),
      userId: user.id,
      // `welcome`, not `invite`: this one opens a SESSION and must never be
      // redeemable at the password-setting page. The purpose is what
      // `redeemMagicLink` and `acceptPortalInvite` each check, so the two
      // letters cannot be interchanged by anyone holding either link.
      purpose: existing ? "welcome" : "invite",
      tokenHash: this.deps.tokens.hash(token),
      expiresAt,
    });
    if (existing) {
      await this.deps.mailer.sendPortalWelcome(
        user.email,
        `${this.deps.magicLinkBaseUrl}/auth/magic-link?token=${encodeURIComponent(token)}`,
        expiresAt,
        firmName,
        timeZone,
        sender ?? null,
      );
      return expiresAt;
    }
    await this.deps.mailer.sendPortalInvite(
      user.email,
      inviteUrl(this.deps.magicLinkBaseUrl, token, firmName),
      expiresAt,
      firmName,
      timeZone,
      sender ?? null,
    );
    return expiresAt;
  }

  /**
   * Send the portal invitation AGAIN — same person, same address.
   *
   * ── WHY THE ADDRESS IS NOT AN ARGUMENT ──────────────────────────────────
   *
   * It comes off the account, and there is no parameter that could change it.
   * That is the whole security design of this route. "Re-invite this contact"
   * has two questions behind it — did they lose the link, or has somebody else
   * taken over that mailbox — and only the first one is answered here. The
   * second is a new door: it would let anybody holding a firm login move a
   * client's portal access to an address of their choosing, which wants its own
   * act, its own ledger event and probably an approval. Guessing it into this
   * method would have shipped that door with no decision behind it.
   *
   * ── THE THREE REFUSALS, AND WHY EACH IS A REFUSAL AND NOT A NO-OP ───────
   *
   * A missing or deactivated account answers as `invitePortalContact` does —
   * there is nobody to write to, and the caller has just picked them off a
   * screen, so this is a race rather than a typo.
   *
   * An account that already has a PASSWORD is refused loudly. See
   * `InvitationAlreadyAccepted`: re-issuing an invite to somebody who has set
   * their password is the firm resetting its client's password, and this
   * product's invite flow exists precisely so the firm never holds it.
   *
   * And the budget is spent on the CHECK, before anything is written, so a
   * caller cannot walk around it by whatever happens next.
   *
   * ── AND THE OLD LINKS DIE ───────────────────────────────────────────────
   *
   * `consumeUnusedFor` first, so that at most one live invitation exists per
   * contact at any moment. Before the resend route there was exactly one by
   * construction; a route that issues a second without spending the first would
   * quietly turn "one link in one inbox" into a growing pile of password
   * setters, all valid for seventy-two hours.
   *
   * A failed send THROWS, exactly as the first invitation does, and for the
   * same reason: a client has no other door and a member of the firm is
   * watching a screen that must not say the letter went when it did not.
   */
  async resendPortalInvite(
    userId: string,
    firmName: string | null,
    timeZone?: string | null,
    sender?: ClientSender | null,
  ): Promise<ResentInvitation> {
    const budget = await this.deps.attempts.check(
      `portal-invite:${userId}`,
      PORTAL_INVITE_RESENDS_PER_WINDOW,
      PORTAL_INVITE_RESEND_WINDOW_SECONDS,
    );
    if (!budget.allowed) {
      // NOT the default sentence. This is the one place in the product that
      // mails a credential to somebody outside the firm, and the refusal is
      // read by a member of the firm looking at that contact — being told
      // "too many sign-in attempts for this account" sends them looking for a
      // login problem that does not exist. Found by walking the screen.
      throw new TooManyAttempts(
        budget.retryAfterSeconds,
        `this contact has already been sent ${String(PORTAL_INVITE_RESENDS_PER_WINDOW)} ` +
          `invitations in the last hour, so the next one will not go for about ` +
          `${retryIn(budget.retryAfterSeconds)}. The limit is per contact rather than per ` +
          `sender, because the cost of getting this wrong lands on their inbox. If none of ` +
          `them arrived, the address on the account is probably wrong, and changing it is ` +
          `not something this route can do.`,
      );
    }

    const user = await this.deps.users.findById(userId);
    if (!user || user.status !== "active") throw new InvalidMagicLink();

    const credential = await this.deps.credentials.findByUserId(userId);
    if (credential) throw new InvitationAlreadyAccepted();

    const now = this.deps.clock.now();
    const supersededLinks = await this.deps.magicLinks.consumeUnusedFor(
      userId,
      "invite",
      now.toISOString(),
    );

    const token = this.deps.tokens.newToken();
    const expiresAt = portalInviteExpiryFrom(now);
    await this.deps.magicLinks.create({
      id: this.deps.ids.newId(),
      userId: user.id,
      tokenHash: this.deps.tokens.hash(token),
      purpose: "invite",
      expiresAt,
    });
    await this.deps.mailer.sendPortalInvite(
      user.email,
      inviteUrl(this.deps.magicLinkBaseUrl, token, firmName),
      expiresAt,
      firmName,
      timeZone,
      sender ?? null,
    );
    return { expiresAt, supersededLinks };
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
  async welcomeStaff(
    userId: string,
    firmName: string | null,
    timeZone?: string | null,
    /** The colleague who added them, named in the letter (CA#50). */
    addedByUserId?: string | null,
  ): Promise<StaffWelcome> {
    const user = await this.deps.users.findById(userId);
    // The caller has just created or found this account, so a miss is a race or
    // a deactivated login rather than a typo — and either way there is nobody to
    // write to. Not an error: the membership stands, and the admin is told the
    // letter did not go.
    if (!user || user.status !== "active") return { expiresAt: null, sent: false };

    // ── THE FIRST PASSWORD IS CHOSEN ON THIS LINK (CA#38) ──────────────────
    //
    // An account with no password is sent to the page that chooses one, and
    // `redeemWelcome` sets it on the same link that signs them in: holding the
    // link is the proof of the mailbox, exactly as on a reset. An account that
    // already has one (a second firm's welcome; identity is global) is sent to
    // the sign-in page, and nothing about its password changes.
    const choosePassword = (await this.deps.credentials.findByUserId(user.id)) === null;
    const adder =
      addedByUserId === undefined || addedByUserId === null
        ? null
        : await this.deps.users.findById(addedByUserId);

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
        `${this.deps.magicLinkBaseUrl}/auth/${choosePassword ? "welcome" : "magic-link"}?token=${encodeURIComponent(token)}`,
        expiresAt,
        firmName,
        timeZone,
        { addedBy: adder?.displayName ?? null, choosePassword },
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
   * Redeem a colleague's WELCOME link by choosing their first password, and
   * sign in, in one call (CA#38).
   *
   * `acceptPortalInvite`'s shape, for its reasons: the link is checked for
   * strength before it is spent, so a password typed too short can be typed
   * again on the same link. Only a `welcome` link, and only for an account
   * with NO password: the welcome must never REPLACE one (accounts are global,
   * and a second firm's welcome reaches people who already sign in), so that
   * case is refused WITHOUT spending the link, which still signs them in at
   * `redeemMagicLink` ("continue without changing it").
   *
   * Skipping the password is `redeemMagicLink` on the same link. Sign-in links
   * stay a way in for every account, so a colleague who skips is not stuck.
   */
  async redeemWelcome(token: string, password: string): Promise<SignInResult> {
    const link = await this.deps.magicLinks.findByTokenHash(this.deps.tokens.hash(token));
    if (!link || !isUsableMagicLink(link, this.deps.clock.now(), "welcome")) {
      throw new InvalidMagicLink();
    }
    const user = await this.deps.users.findById(link.userId);
    if (!user || user.status !== "active") throw new InvalidMagicLink();

    if ((await this.deps.credentials.findByUserId(user.id)) !== null) {
      throw new PasswordAlreadySet();
    }
    if (!isAcceptablePassword(password)) {
      throw new WeakPassword(MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH);
    }
    const won = await this.deps.magicLinks.consume(link.id, this.deps.clock.now().toISOString());
    if (!won) throw new InvalidMagicLink();

    await this.setPassword(user.id, password);
    return this.openSession(user);
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

  /**
   * Redeem a forgotten-password link: replace the password, and sign in.
   *
   * ── IT IS `acceptPortalInvite`, AND THE SHAPE IS THE ARGUMENT ────────────
   *
   * One call, because the two halves must not be separable — the same reason
   * given there. A route that only set the password would leave somebody
   * holding a spent token and a login screen, and a route that only signed them
   * in is `redeemMagicLink`, which is precisely the flow that leaves the
   * forgotten password in place. The link is CHECKED for strength before it is
   * spent, so a password typed too short can be typed again on the same link.
   *
   * ── AND EVERY SESSION THEY HOLD ENDS ────────────────────────────────────
   *
   * `setPassword` revokes them all, which is not a side effect here but the
   * point. The commonest honest reason to reset a password is a suspicion that
   * somebody else has it, and a reset that leaves the other person's session
   * open answers the wrong question. The session this returns is a NEW one,
   * issued after the revocation, so the person doing the reset stays signed in
   * and everybody else is out.
   */
  async resetPassword(token: string, password: string): Promise<SignInResult> {
    const link = await this.deps.magicLinks.findByTokenHash(this.deps.tokens.hash(token));
    // "reset" by name, so a sign-in link, a welcome and a portal invitation are
    // all simply unusable here — and unknown, expired, spent and wrong-purpose
    // are one indistinguishable answer, which is what stops this route being
    // asked which addresses have accounts.
    if (!link || !isUsableMagicLink(link, this.deps.clock.now(), "reset")) {
      throw new InvalidMagicLink();
    }
    const user = await this.deps.users.findById(link.userId);
    if (!user || user.status !== "active") throw new InvalidMagicLink();

    if (!isAcceptablePassword(password)) {
      throw new WeakPassword(MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH);
    }
    const won = await this.deps.magicLinks.consume(link.id, this.deps.clock.now().toISOString());
    if (!won) throw new InvalidMagicLink();

    // NOT refused when it matches the old password, and `PasswordUnchanged`
    // says why: the person holding this link is the one who does not know what
    // the old one was, so asking them for something different would be a
    // riddle. The change route, whose caller has just typed the old one, does
    // refuse it.
    await this.setPassword(user.id, password);
    return this.openSession(user);
  }

  /**
   * Change the password of the person making the request.
   *
   * ── THE CURRENT PASSWORD IS REQUIRED, AND A SESSION IS NOT ENOUGH ────────
   *
   * The caller is already authenticated, so this check is not about who they
   * are. It is about what a stolen session may BECOME. Sessions in this product
   * are server-side precisely so that revoking one ends access on the next
   * request; a session that could mint a new password would survive every
   * revocation the firm has, and the person it was taken from — who at most
   * firms has no password of their own — would have nothing to notice had
   * changed. So the old password is the thing being proved, and an account with
   * none is sent to the emailed link instead (`NoPasswordSet`), where reading
   * the mailbox is what stands in for it.
   *
   * ── AND A NEW SESSION COMES BACK, POINTED AT THE SAME FIRM ───────────────
   *
   * `setPassword` revokes every session including this one, which is right —
   * the whole point of changing a password is that anything else holding the
   * old one stops. But it would also sign the person out of the tab they are
   * standing in, one click after they were told it worked. So a fresh session
   * is opened and pointed back at the firm they were already acting as, and the
   * handler puts the new token in the cookie. The token ROTATES as a
   * consequence, which is the behaviour anybody would want here anyway.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    /** The firm the caller was acting as, so the new session lands back in it
     *  rather than on the org switcher. Null when they had not chosen one. */
    activeTenantId: string | null,
  ): Promise<SignInResult> {
    const bucket = `password-change:${userId}`;
    const budget = await this.deps.attempts.check(
      bucket,
      PASSWORD_CHANGE_ATTEMPTS_PER_WINDOW,
      PASSWORD_CHANGE_WINDOW_SECONDS,
    );
    if (!budget.allowed) {
      // About THIS act. The default sentence is the sign-in page's, and
      // nobody here was signing in.
      throw new TooManyAttempts(
        budget.retryAfterSeconds,
        `Too many tries at your current password. Try again in ${retryIn(budget.retryAfterSeconds)}.`,
      );
    }

    const user = await this.deps.users.findById(userId);
    // Unreachable through the guard, which resolved a session for this id a
    // moment ago — but a deactivated account with a live session is a real
    // state, and "sign in again" is the honest thing to tell it rather than a
    // 500 from a credential write against a user who is no longer there.
    if (!user || user.status !== "active") throw new SessionInvalid();

    const stored = await this.deps.credentials.findByUserId(userId);
    if (!stored) throw new NoPasswordSet();

    // Spent before anything is written and read on the failure, like login's
    // budgets. `InvalidCredentials` rather than a sentence of its own: the
    // caller knows perfectly well which field they got wrong, and the family's
    // one word for "that is not the password" is already this.
    if (!(await this.deps.passwords.verify(currentPassword, stored.passwordHash))) {
      // Its own sentence (F26): the sign-in page's "Email or password is
      // incorrect" sent people looking for an email box this form has not got.
      throw new CurrentPasswordIncorrect();
    }
    if (!isAcceptablePassword(newPassword)) {
      throw new WeakPassword(MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH);
    }
    if (await this.deps.passwords.verify(newPassword, stored.passwordHash)) {
      throw new PasswordUnchanged();
    }

    await this.setPassword(userId, newPassword);
    // Somebody who has just produced their own password is the best evidence
    // there is that the failures before it were theirs — the same reasoning
    // `login` clears its buckets on.
    await this.deps.attempts.reset(bucket);
    return this.reopenSession(user, activeTenantId);
  }

  /**
   * Does this account have a password at all?
   *
   * Read by `/auth/me` so the account screen can offer the form that will work.
   * Most colleagues have never had one — `welcomeStaff` hands over a session and
   * nothing else — so a screen that assumed otherwise would show every one of
   * them a change form whose only possible outcome is `NoPasswordSet`, which is
   * the product discovering its own state from a refusal.
   *
   * It is a boolean and never the hash, the algorithm, or when it was set: the
   * question a screen has is yes-or-no, and the rest is nobody's business
   * including this layer's.
   */
  async hasPassword(userId: string): Promise<boolean> {
    return (await this.deps.credentials.findByUserId(userId)) !== null;
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
    const now = this.deps.clock.now();
    const session = await this.deps.sessions.findByTokenHash(this.deps.tokens.hash(token));
    if (!session || !isUsableSession(session, now)) return null;

    // ── THE IDLE CLOCK'S ONE WRITE ────────────────────────────────────────
    //
    // `isUsableSession` has just READ `lastSeenAt`; this is what keeps it
    // meaning something. Not on every request — see `SESSION_TOUCH_MINUTES`:
    // that would make every authenticated read a write on the hottest row in
    // the system to buy accuracy nobody needs against a seven-day timeout.
    //
    // Not awaited on the critical path's behalf either: a touch that fails
    // costs this session a few minutes of its idle budget, and failing the
    // REQUEST over a bookkeeping write would turn a slow disk into an outage.
    if (shouldTouch(session, now)) {
      await this.deps.sessions.touch(session.id, now.toISOString()).catch(() => undefined);
    }

    // ── THE ACCOUNT, re-checked on every request ──────────────────────────
    //
    // `user_account.status` was read at login and at magic-link redemption and
    // NOWHERE ELSE, so disabling an account left every session it already held
    // working for up to a fortnight. That is the same hole the membership
    // re-check below was written to close, one level up: a control that only
    // acts on the paths which OPEN a session misses the one every request
    // takes. Disabling an account is what somebody reaches for when a laptop is
    // stolen, and "it takes effect next time they sign in" is the wrong answer
    // to that.
    const user = await this.deps.users.findById(session.userId);
    if (!user || user.status !== "active") return null;

    if (session.activeTenantId === null) return toPrincipal(session, undefined);

    // ── AND THE FIRM ──────────────────────────────────────────────────────
    //
    // Same argument, for `tenancy.tenant.status`. A suspended firm keeps its
    // session alive but loses its tenant context, which lands the person on the
    // org switcher rather than a login screen — the same treatment a revoked
    // membership gets below, and for the same reason: somebody who works at two
    // firms should still reach the other one.
    if (!(await this.deps.tenants.isOpen(session.activeTenantId))) {
      return {
        userId: session.userId,
        sessionId: session.id,
        tenantId: null,
        audience: null,
        role: null,
        commercialVisibility: null,
      };
    }

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
    // A suspended firm answers the same way as one you do not belong to. The
    // alternative — a distinct refusal — would tell every member of every firm
    // on the platform when one of them is suspended, which is the firm's
    // business and not the switcher's.
    if (!(await this.deps.tenants.isOpen(tenantId))) throw new NotAMember(tenantId);
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

  /**
   * Open a session and put it back where the last one was.
   *
   * `openSession` chooses a tenant only when there is exactly one, which is
   * right for a sign-in: somebody who belongs to two firms must SAY which one
   * they are acting as. It is wrong for a password change, where they already
   * said — an hour ago, on the org switcher — and being asked again in the
   * middle of an unrelated task reads as having been signed out.
   *
   * Every refusal `switchTenant` makes is made again here rather than trusted,
   * because the old session's tenant is a claim about the past: the membership
   * is re-read (`openSession` has already filtered to the active ones) and the
   * firm is re-checked for suspension. A tenant that no longer passes is simply
   * not restored, and the caller lands on the org switcher — which is the
   * correct place for somebody whose firm has gone away underneath them.
   */
  private async reopenSession(
    user: UserAccount,
    preferredTenantId: string | null,
  ): Promise<SignInResult> {
    const opened = await this.openSession(user);
    // Nothing to restore, or it already landed there by itself — the single
    // membership case, which is most people.
    if (preferredTenantId === null || opened.principal.tenantId !== null) return opened;

    const membership = opened.memberships.find((m) => m.tenantId === preferredTenantId);
    if (!membership) return opened;
    if (!(await this.deps.tenants.isOpen(preferredTenantId))) return opened;

    const session = await this.deps.sessions.setActiveContext(
      opened.session.id,
      preferredTenantId,
      membership.audience,
    );
    await this.recordSessionStarted(preferredTenantId, user.id);
    return { ...opened, session, principal: toPrincipal(session, membership) };
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
