// The identity adapters against real Postgres. Three things only the database
// can settle:
//
//   1. Nothing usable is stored. The columns hold digests, not credentials.
//   2. A magic link is single-use under CONCURRENCY — the fake mimics the
//      conditional UPDATE, but only Postgres can prove two simultaneous clicks
//      do not both open a session.
//   3. The paired-context CHECK holds: a session cannot carry a tenant without
//      an audience.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { FakeClock } from "../../src/testfakes/clock";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { IdentityService } from "../../src/usecase/identity/service";
import {
  PostgresCredentialRepository,
  PostgresMagicLinkRepository,
  PostgresSessionRepository,
} from "../../src/infrastructure/postgres/identity-repository";
import { PostgresUserRepository } from "../../src/infrastructure/postgres/user-repository";
import { PostgresMembershipRepository } from "../../src/infrastructure/postgres/membership-repository";
import { ScryptPasswordHasher } from "../../src/infrastructure/crypto/scrypt-hasher";
import { RandomTokenFactory } from "../../src/infrastructure/crypto/random-tokens";
import { FakeMailer } from "../../src/testfakes/identity";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { LedgerService } from "../../src/usecase/ledger/service";
import { systemIds } from "../../src/platform/ids";
import { InMemoryRateLimiter } from "../../src/platform/ratelimit";
import { InvalidMagicLink } from "../../src/domain/identity/errors";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 4 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const tokens = new RandomTokenFactory();
const mailer = new FakeMailer();
const clock = new FakeClock(new Date());
const magicLinks = new PostgresMagicLinkRepository(app);
const sessions = new PostgresSessionRepository(app);

const identity = new IdentityService({
  users: new PostgresUserRepository(app),
  memberships: new PostgresMembershipRepository(app),
  credentials: new PostgresCredentialRepository(app),
  sessions,
  magicLinks,
  passwords: new ScryptPasswordHasher(),
  tokens,
  mailer,
  ids: systemIds,
  clock,
  events: new LedgerService({ events: new PostgresEventStore(app), ids: systemIds }),
  attempts: new InMemoryRateLimiter(clock),
  magicLinkBaseUrl: "https://app.example.test",
});

const stamp = String(Date.now());
const email = `identity-test-${stamp}@example.test`;
const PASSWORD = "correct horse battery staple";
let tenantId = "";
let userId = "";

beforeAll(async () => {
  const [tenant] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`identity-test-${stamp}`}, 'Identity Test', 'INR') RETURNING id
  `;
  const [user] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email) VALUES (${email}) RETURNING id
  `;
  if (!tenant || !user) throw new Error("could not seed the test tenant and user");
  tenantId = tenant.id;
  userId = user.id;

  await owner`
    INSERT INTO tenancy.membership (tenant_id, user_id, audience, role, commercial_visibility)
    VALUES (${tenantId}, ${userId}, 'STAFF', 'partner', true)
  `;
  await identity.setPassword(userId, PASSWORD);
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

describe("nothing usable is stored", () => {
  it("keeps the password as a self-describing scrypt hash, not the password", async () => {
    const [row] = await owner<{ password_hash: string }[]>`
      SELECT password_hash FROM tenancy.credential WHERE user_id = ${userId}
    `;
    expect(row?.password_hash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$/);
    expect(row?.password_hash).not.toContain(PASSWORD);
  });

  it("keeps only the digest of a session token, never the token", async () => {
    const { token } = await identity.login(email, PASSWORD);
    const [row] = await owner<{ token_hash: string }[]>`
      SELECT token_hash FROM tenancy.session WHERE token_hash = ${tokens.hash(token)}
    `;
    expect(row).toBeDefined();
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);

    // The stored value is not the token: presenting it does not authenticate.
    const [byRawToken] = await owner<{ id: string }[]>`
      SELECT id FROM tenancy.session WHERE token_hash = ${token}
    `;
    expect(byRawToken).toBeUndefined();
    expect(await identity.resolveSession(tokens.hash(token))).toBeNull();
  });
});

describe("sessions round-trip through Postgres", () => {
  it("resolves, switches tenant, and dies on revocation", async () => {
    const { token, principal } = await identity.login(email, PASSWORD);
    expect(principal.tenantId).toBe(tenantId); // one membership, auto-selected

    const resolved = await identity.resolveSession(token);
    expect(resolved?.sessionId).toBe(principal.sessionId);

    const switched = await identity.switchTenant(principal.sessionId, userId, tenantId);
    expect(switched.audience).toBe("STAFF");

    await identity.logout(token);
    expect(await identity.resolveSession(token)).toBeNull();
  });

  it("refuses a half-resolved context — a tenant with no audience", async () => {
    // The CHECK constraint, not the application, is what makes this impossible:
    // the four gates cannot reason about a session that has a tenant but no
    // audience, so the row may not exist in that state.
    const err = await owner`
      INSERT INTO tenancy.session (user_id, token_hash, active_tenant_id, expires_at)
      VALUES (${userId}, ${`half-${stamp}`}, ${tenantId}, now() + interval '1 day')
    `.catch((e: unknown) => e);
    expect((err as { constraint_name?: string }).constraint_name).toBe(
      "session_context_paired_chk",
    );
  });

  it("revokes every session of a user at once", async () => {
    await identity.login(email, PASSWORD);
    await identity.login(email, PASSWORD);
    expect(await identity.revokeAllSessions(userId)).toBeGreaterThanOrEqual(2);
    expect(await identity.revokeAllSessions(userId)).toBe(0);
  });
});

describe("a magic link is single-use under concurrency", () => {
  it("lets exactly one of two simultaneous redemptions win", async () => {
    await identity.requestMagicLink(email);
    const sent = mailer.sent.at(-1);
    if (!sent) throw new Error("no magic link was sent");
    const token = new URL(sent.url).searchParams.get("token");
    if (token === null) throw new Error("no token in the emailed url");

    // Both start before either finishes. The conditional UPDATE in the adapter
    // is what decides — a read-then-write in the service would let both pass.
    const [a, b] = await Promise.all([
      identity.redeemMagicLink(token).catch((e: unknown) => e),
      identity.redeemMagicLink(token).catch((e: unknown) => e),
    ]);

    const outcomes = [a, b];
    expect(outcomes.filter((o) => o instanceof InvalidMagicLink)).toHaveLength(1);
    expect(outcomes.filter((o) => !(o instanceof Error))).toHaveLength(1);

    const [row] = await owner<{ consumed_at: Date | null }[]>`
      SELECT consumed_at FROM tenancy.magic_link WHERE token_hash = ${tokens.hash(token)}
    `;
    expect(row?.consumed_at).not.toBeNull();
  });
});
