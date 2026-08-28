// In-memory fakes for the identity ports, plus a controllable clock — the whole
// point of taking time as a dependency is that a test can jump a fortnight
// forward without sleeping.
//
// FakeUserRepo and FakeMembershipRepo (testfakes/tenancy) already satisfy
// identity's UserDirectory and MembershipDirectory, which is interface
// segregation working as intended: identity asked for a narrow read, and the
// existing fakes provide it unchanged.
import type { Clock } from "../platform/clock";
import type { MagicLink, Session } from "../domain/identity/model";
import type {
  CredentialRepository,
  Mailer,
  MagicLinkRepository,
  NewMagicLink,
  NewSession,
  PasswordHasher,
  SessionRepository,
  TokenFactory,
} from "../usecase/identity/ports";

/** A clock a test drives. Starts at a fixed instant so nothing is flaky. */
export class FakeClock implements Clock {
  constructor(private current = new Date("2026-01-01T09:00:00Z")) {}
  now(): Date {
    return this.current;
  }
  advanceMinutes(minutes: number): void {
    this.current = new Date(this.current.getTime() + minutes * 60 * 1000);
  }
  advanceDays(days: number): void {
    this.advanceMinutes(days * 24 * 60);
  }
}

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

  create(s: NewSession): Promise<Session> {
    const row: Session = {
      id: s.id,
      userId: s.userId,
      activeTenantId: s.activeTenantId,
      activeAudience: s.activeAudience,
      issuedAt: new Date().toISOString(),
      expiresAt: s.expiresAt,
      revokedAt: null,
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
}

/** Captures what would have been emailed, so a test can read the link. */
export class FakeMailer implements Mailer {
  readonly sent: { to: string; url: string; expiresAt: string }[] = [];
  sendMagicLink(to: string, url: string, expiresAt: string): Promise<void> {
    this.sent.push({ to, url, expiresAt });
    return Promise.resolve();
  }
}
