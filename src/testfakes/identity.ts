// In-memory fakes for the identity ports.
//
// The controllable clock used to live here, because sessions and magic links
// were the first things in the product defined entirely by time. It now lives in
// testfakes/clock.ts: by the time the scheduler needed one there were two
// classes with the same name and subtly different APIs, and a test importing the
// wrong one would have compiled.
//
// FakeUserRepo and FakeMembershipRepo (testfakes/tenancy) already satisfy
// identity's UserDirectory and MembershipDirectory, which is interface
// segregation working as intended: identity asked for a narrow read, and the
// existing fakes provide it unchanged.
import type { Clock } from "../platform/clock";
import type { MagicLink, MagicLinkPurpose, Session } from "../domain/identity/model";
import type {
  CredentialRepository,
  Mailer,
  MagicLinkRepository,
  NewMagicLink,
  NewSession,
  PasswordHasher,
  SessionRepository,
  StaffWelcomeExtras,
  TokenFactory,
} from "../usecase/identity/ports";

/**
 * A hasher that reverses nothing and hides nothing: `hashed:<password>`.
 *
 * Deliberately not scrypt — a unit suite that ran the real KDF would spend
 * seconds proving arithmetic node already tests. The real hasher's own
 * behaviour (round-trip, rejection of malformed input) is covered separately.
 */
export class FakePasswordHasher implements PasswordHasher {
  hash(plain: string): Promise<string> {
    return Promise.resolve(`hashed:${plain}`);
  }
  verify(plain: string, encoded: string): Promise<boolean> {
    return Promise.resolve(encoded === `hashed:${plain}`);
  }
  dummyHash(): string {
    return "hashed: never matches";
  }
}

/** Predictable tokens, so a test can hold the value the "user" received. */
export class FakeTokenFactory implements TokenFactory {
  private n = 0;
  readonly issued: string[] = [];
  newToken(): string {
    this.n += 1;
    const token = `token-${String(this.n)}`;
    this.issued.push(token);
    return token;
  }
  hash(token: string): string {
    return `sha:${token}`;
  }
}

export class FakeCredentialRepo implements CredentialRepository {
  readonly rows = new Map<string, string>();
  findByUserId(userId: string): Promise<{ passwordHash: string } | null> {
    const hash = this.rows.get(userId);
    return Promise.resolve(hash === undefined ? null : { passwordHash: hash });
  }
  upsert(userId: string, passwordHash: string): Promise<void> {
    this.rows.set(userId, passwordHash);
    return Promise.resolve();
  }
}

export class FakeSessionRepo implements SessionRepository {
  readonly rows: Session[] = [];
  private readonly hashes = new Map<string, string>(); // tokenHash to sessionId

  /**
   * THE SAME CLOCK THE SERVICE HOLDS, when a test gives it one.
   *
   * It used to stamp `issuedAt` from the real `Date`, which was harmless while
   * nothing read it — and stopped being harmless the moment sessions grew an
   * IDLE clock. A row stamped "now" and read against a fake clock set to
   * January produces a negative idle time, so every idle assertion would have
   * passed whatever the code did.
   */
  constructor(private readonly clock: Clock = { now: () => new Date() }) {}

  create(s: NewSession): Promise<Session> {
    const at = this.clock.now().toISOString();
    const row: Session = {
      id: s.id,
      userId: s.userId,
      activeTenantId: s.activeTenantId,
      activeAudience: s.activeAudience,
      issuedAt: at,
      expiresAt: s.expiresAt,
      revokedAt: null,
      // A brand-new session was, by definition, just used.
      lastSeenAt: at,
    };
    this.rows.push(row);
    this.hashes.set(s.tokenHash, s.id);
    return Promise.resolve(row);
  }

  findByTokenHash(tokenHash: string): Promise<Session | null> {
    const id = this.hashes.get(tokenHash);
    return Promise.resolve(this.rows.find((r) => r.id === id) ?? null);
  }

  setActiveContext(
    sessionId: string,
    tenantId: string,
    audience: NonNullable<Session["activeAudience"]>,
  ): Promise<Session> {
    const i = this.rows.findIndex((r) => r.id === sessionId && r.revokedAt === null);
    const current = this.rows[i];
    if (current === undefined) {
      return Promise.reject(new Error(`session ${sessionId} is unknown or revoked`));
    }
    const next: Session = { ...current, activeTenantId: tenantId, activeAudience: audience };
    this.rows[i] = next;
    return Promise.resolve(next);
  }

  revoke(sessionId: string, at: string): Promise<void> {
    const i = this.rows.findIndex((r) => r.id === sessionId);
    const current = this.rows[i];
    if (current !== undefined && current.revokedAt === null) {
      this.rows[i] = { ...current, revokedAt: at };
    }
    return Promise.resolve();
  }

  revokeAllForUser(userId: string, at: string): Promise<number> {
    let n = 0;
    this.rows.forEach((row, i) => {
      if (row.userId === userId && row.revokedAt === null) {
        this.rows[i] = { ...row, revokedAt: at };
        n += 1;
      }
    });
    return Promise.resolve(n);
  }

  touch(sessionId: string, at: string): Promise<void> {
    const i = this.rows.findIndex((r) => r.id === sessionId && r.revokedAt === null);
    const current = this.rows[i];
    if (current !== undefined) this.rows[i] = { ...current, lastSeenAt: at };
    return Promise.resolve();
  }

  purgeExpired(before: string): Promise<{ sessions: number; magicLinks: number }> {
    const cutoff = Date.parse(before);
    const dead = (r: Session): boolean =>
      Date.parse(r.expiresAt) < cutoff ||
      (r.revokedAt !== null && Date.parse(r.revokedAt) < cutoff) ||
      Date.parse(r.lastSeenAt) < cutoff;
    const removed = this.rows.filter(dead);
    for (const row of removed) this.rows.splice(this.rows.indexOf(row), 1);
    // The fake owns only sessions; the real adapter sweeps both tables in one
    // call and the magic-link half has no fake to sweep.
    return Promise.resolve({ sessions: removed.length, magicLinks: 0 });
  }
}

export class FakeMagicLinkRepo implements MagicLinkRepository {
  readonly rows: MagicLink[] = [];
  private readonly hashes = new Map<string, string>();

  create(m: NewMagicLink): Promise<MagicLink> {
    const row: MagicLink = {
      id: m.id,
      userId: m.userId,
      purpose: m.purpose,
      expiresAt: m.expiresAt,
      consumedAt: null,
    };
    this.rows.push(row);
    this.hashes.set(m.tokenHash, m.id);
    return Promise.resolve(row);
  }

  findByTokenHash(tokenHash: string): Promise<MagicLink | null> {
    const id = this.hashes.get(tokenHash);
    return Promise.resolve(this.rows.find((r) => r.id === id) ?? null);
  }

  /** Mirrors the adapter's conditional UPDATE: the first caller wins. */
  consume(id: string, at: string): Promise<boolean> {
    const i = this.rows.findIndex((r) => r.id === id);
    const current = this.rows[i];
    if (current === undefined || current.consumedAt !== null) return Promise.resolve(false);
    this.rows[i] = { ...current, consumedAt: at };
    return Promise.resolve(true);
  }

  /**
   * Mirrors the adapter, INCLUDING the expiry predicate.
   *
   * A fake that spent expired links too would let a test assert a superseded
   * count the real query never returns — and that count is what the resend's
   * ledger event carries.
   */
  consumeUnusedFor(userId: string, purpose: MagicLinkPurpose, at: string): Promise<number> {
    let n = 0;
    this.rows.forEach((row, i) => {
      if (row.userId !== userId || row.purpose !== purpose) return;
      if (row.consumedAt !== null) return;
      if (Date.parse(row.expiresAt) <= Date.parse(at)) return;
      this.rows[i] = { ...row, consumedAt: at };
      n += 1;
    });
    return Promise.resolve(n);
  }
}

/** Captures what would have been emailed, so a test can read the link. */
export class FakeMailer implements Mailer {
  readonly sent: { to: string; url: string; expiresAt: string }[] = [];
  /** Kept apart from `sent` on purpose: a test asserting that an INVITE went out
   *  must not pass because a sign-in link did. */
  readonly invites: { to: string; url: string; expiresAt: string; firmName: string | null }[] = [];
  /** And a third, for the same reason: a test asserting a colleague was
   *  WELCOMED must not pass on a portal invite that happens to have gone out. */
  readonly welcomes: {
    to: string;
    url: string;
    expiresAt: string;
    firmName: string | null;
    addedBy: string | null;
    choosePassword: boolean;
  }[] = [];
  /** And a fourth. This one is the whole assertion for the invite downgrade: a
   *  contact who already has a password must be sent a SIGN-IN link, and a test
   *  that could not tell it apart from an invitation would pass on the bug. */
  readonly portalWelcomes: {
    to: string;
    url: string;
    expiresAt: string;
    firmName: string | null;
  }[] = [];

  sendMagicLink(to: string, url: string, expiresAt: string): Promise<void> {
    this.sent.push({ to, url, expiresAt });
    return Promise.resolve();
  }

  sendPortalInvite(
    to: string,
    url: string,
    expiresAt: string,
    firmName: string | null,
  ): Promise<void> {
    this.invites.push({ to, url, expiresAt, firmName });
    return Promise.resolve();
  }

  sendStaffWelcome(
    to: string,
    url: string,
    expiresAt: string,
    firmName: string | null,
    _timeZone?: string | null,
    extra?: StaffWelcomeExtras,
  ): Promise<void> {
    this.welcomes.push({
      to,
      url,
      expiresAt,
      firmName,
      addedBy: extra?.addedBy ?? null,
      choosePassword: extra?.choosePassword === true,
    });
    return Promise.resolve();
  }

  sendPortalWelcome(
    to: string,
    url: string,
    expiresAt: string,
    firmName: string | null,
  ): Promise<void> {
    this.portalWelcomes.push({ to, url, expiresAt, firmName });
    return Promise.resolve();
  }

  /** And a fifth. Kept apart from `sent` for the reason the others are: a reset
   *  and a sign-in link go to the same address with the same shape, and a test
   *  that could not tell them apart would pass on the one bug that matters
   *  here — a reset link issued as a `login` one, which opens a session and
   *  leaves the forgotten password exactly where it was. */
  readonly resets: { to: string; url: string; expiresAt: string }[] = [];

  sendPasswordReset(to: string, url: string, expiresAt: string): Promise<void> {
    this.resets.push({ to, url, expiresAt });
    return Promise.resolve();
  }
}

/**
 * A mailer whose relay is down — every send rejects.
 *
 * It exists for ONE property, and it is a security property rather than an
 * error-handling one: `requestMagicLink` must answer identically whether or not
 * an account exists, and a thrown send would make the ERROR PATH the thing that
 * tells them apart (202 for an unknown address, 500 for a real one). That was
 * unreachable while `LoggingMailer` was the only mailer, because writing to a
 * log cannot fail. A real relay rejects a recipient, times out, or runs out of
 * quota, so it is reachable now and it is tested.
 *
 * `invitePortalContact` must do the OPPOSITE and let the failure out — there is
 * no account to be quiet about and somebody at the firm is watching a screen.
 */
export class UnreachableMailer implements Mailer {
  /** What was ATTEMPTED. A test that asserts a failure must still be able to
   *  prove the letter was tried, or it cannot tell "the relay refused" from
   *  "the code never called the mailer". */
  readonly attempted: {
    to: string;
    kind: "magic-link" | "invite" | "welcome" | "portal-welcome" | "password-reset";
  }[] = [];

  sendPasswordReset(to: string): Promise<void> {
    this.attempted.push({ to, kind: "password-reset" });
    return Promise.reject(new Error("smtp: connection refused"));
  }

  sendMagicLink(to: string): Promise<void> {
    this.attempted.push({ to, kind: "magic-link" });
    return Promise.reject(new Error("smtp: connection refused"));
  }

  sendPortalWelcome(to: string): Promise<void> {
    this.attempted.push({ to, kind: "portal-welcome" });
    return Promise.reject(new Error("smtp: connection refused"));
  }

  sendPortalInvite(to: string): Promise<void> {
    this.attempted.push({ to, kind: "invite" });
    return Promise.reject(new Error("smtp: connection refused"));
  }

  /** `welcomeStaff` does a THIRD thing with a failure — neither swallow nor
   *  throw, but report it — and this is what proves the difference. */
  sendStaffWelcome(to: string): Promise<void> {
    this.attempted.push({ to, kind: "welcome" });
    return Promise.reject(new Error("smtp: connection refused"));
  }
}
