// Postgres adapters for credentials, sessions and magic links.
//
// All three tables are GLOBAL (migration 0004): identity is above tenant, and
// the session is the row that RESOLVES the tenant, so it cannot itself be
// filtered by one. They therefore run on the app pool directly, exactly like
// user_account — no withTenant, and no RLS to apply. The tenant wall engages
// one step later, when the resolved principal scopes the request.
//
// Timestamps arrive as Date and leave as ISO 8601 strings: that translation is
// this file's job, so the domain compares strings and never meets a Date.
import type { Db } from "../../db/pool";
import type { MagicLink, MagicLinkPurpose, Session } from "../../domain/identity/model";
import type { Audience } from "../../domain/tenancy/model";
import type {
  CredentialRepository,
  MagicLinkRepository,
  NewMagicLink,
  NewSession,
  SessionRepository,
} from "../../usecase/identity/ports";

interface SessionRow {
  id: string;
  user_id: string;
  active_tenant_id: string | null;
  active_audience: Audience | null;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_seen_at: Date;
}

function toSession(r: SessionRow): Session {
  return {
    id: r.id,
    userId: r.user_id,
    activeTenantId: r.active_tenant_id,
    activeAudience: r.active_audience,
    issuedAt: r.issued_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    revokedAt: r.revoked_at === null ? null : r.revoked_at.toISOString(),
    lastSeenAt: r.last_seen_at.toISOString(),
  };
}

interface MagicLinkRow {
  id: string;
  user_id: string;
  purpose: MagicLinkPurpose;
  expires_at: Date;
  consumed_at: Date | null;
}

function toMagicLink(r: MagicLinkRow): MagicLink {
  return {
    id: r.id,
    userId: r.user_id,
    purpose: r.purpose,
    expiresAt: r.expires_at.toISOString(),
    consumedAt: r.consumed_at === null ? null : r.consumed_at.toISOString(),
  };
}

export class PostgresCredentialRepository implements CredentialRepository {
  constructor(private readonly app: Db) {}

  async findByUserId(userId: string): Promise<{ passwordHash: string } | null> {
    const [row] = await this.app<{ password_hash: string }[]>`
      SELECT password_hash FROM tenancy.credential WHERE user_id = ${userId}
    `;
    return row ? { passwordHash: row.password_hash } : null;
  }

  async upsert(userId: string, passwordHash: string): Promise<void> {
    await this.app`
      INSERT INTO tenancy.credential (user_id, password_hash)
      VALUES (${userId}, ${passwordHash})
      ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash
    `;
  }
}

export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly app: Db) {}

  async create(s: NewSession): Promise<Session> {
    const [row] = await this.app<SessionRow[]>`
      INSERT INTO tenancy.session
        (id, user_id, token_hash, active_tenant_id, active_audience, expires_at)
      VALUES
        (${s.id}, ${s.userId}, ${s.tokenHash}, ${s.activeTenantId}, ${s.activeAudience},
         ${s.expiresAt}::timestamptz)
      RETURNING id, user_id, active_tenant_id, active_audience, issued_at, expires_at, revoked_at,
                last_seen_at
    `;
    if (!row) throw new Error("session insert returned no row");
    return toSession(row);
  }

  async findByTokenHash(tokenHash: string): Promise<Session | null> {
    const [row] = await this.app<SessionRow[]>`
      SELECT id, user_id, active_tenant_id, active_audience, issued_at, expires_at, revoked_at,
             last_seen_at
      FROM tenancy.session WHERE token_hash = ${tokenHash}
    `;
    return row ? toSession(row) : null;
  }

  async setActiveContext(
    sessionId: string,
    tenantId: string,
    audience: NonNullable<Session["activeAudience"]>,
  ): Promise<Session> {
    const [row] = await this.app<SessionRow[]>`
      UPDATE tenancy.session
      SET active_tenant_id = ${tenantId}, active_audience = ${audience}
      WHERE id = ${sessionId} AND revoked_at IS NULL
      RETURNING id, user_id, active_tenant_id, active_audience, issued_at, expires_at, revoked_at,
                last_seen_at
    `;
    if (!row) {
      throw new Error(
        `session ${sessionId} could not switch tenant: it is unknown or already revoked`,
      );
    }
    return toSession(row);
  }

  /** Revocation is a conditional UPDATE, so revoking twice does not move the
   *  timestamp — the moment access ended stays true. */
  async revoke(sessionId: string, at: string): Promise<void> {
    await this.app`
      UPDATE tenancy.session SET revoked_at = ${at}::timestamptz
      WHERE id = ${sessionId} AND revoked_at IS NULL
    `;
  }

  async revokeAllForUser(userId: string, at: string): Promise<number> {
    const rows = await this.app<{ id: string }[]>`
      UPDATE tenancy.session SET revoked_at = ${at}::timestamptz
      WHERE user_id = ${userId} AND revoked_at IS NULL
      RETURNING id
    `;
    return rows.length;
  }

  /** The idle clock's write. `revoked_at IS NULL` so a touch cannot resuscitate
   *  a session somebody has just ended from another tab. */
  async touch(sessionId: string, at: string): Promise<void> {
    await this.app`
      UPDATE tenancy.session SET last_seen_at = ${at}::timestamptz
      WHERE id = ${sessionId} AND revoked_at IS NULL
    `;
  }

  /**
   * The sweep. See the port, and migration 0075 for why DELETE is right here.
   *
   * `before` is a cut-off, not "now": a row is removed once it has been dead
   * for long enough that nobody is going to ask about it, so that an operator
   * looking into "why was I signed out an hour ago" still finds the row.
   *
   * The three conditions are three different kinds of dead and all of them are
   * spent keys: past its absolute expiry, revoked, or idle beyond its budget.
   */
  async purgeExpired(
    before: string,
  ): Promise<{ readonly sessions: number; readonly magicLinks: number }> {
    const sessions = await this.app<{ id: string }[]>`
      DELETE FROM tenancy.session
       WHERE expires_at < ${before}::timestamptz
          OR revoked_at < ${before}::timestamptz
          OR last_seen_at < ${before}::timestamptz
      RETURNING id
    `;
    const links = await this.app<{ id: string }[]>`
      DELETE FROM tenancy.magic_link
       WHERE expires_at < ${before}::timestamptz
          OR consumed_at < ${before}::timestamptz
      RETURNING id
    `;
    return { sessions: sessions.length, magicLinks: links.length };
  }
}

export class PostgresMagicLinkRepository implements MagicLinkRepository {
  constructor(private readonly app: Db) {}

  async create(m: NewMagicLink): Promise<MagicLink> {
    const [row] = await this.app<MagicLinkRow[]>`
      INSERT INTO tenancy.magic_link (id, user_id, token_hash, purpose, expires_at)
      VALUES (${m.id}, ${m.userId}, ${m.tokenHash}, ${m.purpose}, ${m.expiresAt}::timestamptz)
      RETURNING id, user_id, purpose, expires_at, consumed_at
    `;
    if (!row) throw new Error("magic_link insert returned no row");
    return toMagicLink(row);
  }

  async findByTokenHash(tokenHash: string): Promise<MagicLink | null> {
    const [row] = await this.app<MagicLinkRow[]>`
      SELECT id, user_id, purpose, expires_at, consumed_at
      FROM tenancy.magic_link WHERE token_hash = ${tokenHash}
    `;
    return row ? toMagicLink(row) : null;
  }

  /**
   * Single use, enforced by the database rather than by a read-then-write in
   * the service. `AND consumed_at IS NULL` makes the check and the claim one
   * statement, so of two simultaneous clicks on the same emailed link exactly
   * one gets a row back and opens a session.
   */
  async consume(id: string, at: string): Promise<boolean> {
    const rows = await this.app<{ id: string }[]>`
      UPDATE tenancy.magic_link SET consumed_at = ${at}::timestamptz
      WHERE id = ${id} AND consumed_at IS NULL
      RETURNING id
    `;
    return rows.length === 1;
  }

  /**
   * `expires_at > now()` is in the predicate on purpose: an already-expired
   * link needs no superseding, and leaving its `consumed_at` null keeps the
   * count honest — the caller reports how many LIVE links this issue replaced,
   * which is the number worth recording on the ledger event.
   */
  async consumeUnusedFor(userId: string, purpose: MagicLinkPurpose, at: string): Promise<number> {
    const rows = await this.app<{ id: string }[]>`
      UPDATE tenancy.magic_link SET consumed_at = ${at}::timestamptz
      WHERE user_id = ${userId}
        AND purpose = ${purpose}
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING id
    `;
    return rows.length;
  }
}
