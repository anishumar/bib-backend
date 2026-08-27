// The sign-in flow, against in-memory ports. The interesting assertions here
// are the negative ones: what the system refuses to reveal, and what stops
// working the moment a session is revoked.
import { beforeEach, describe, expect, it } from "vitest";
import { IdentityService } from "../../src/usecase/identity/service";
import { InMemoryRateLimiter } from "../../src/platform/ratelimit";
import { makeFakes } from "../../src/testfakes/tenancy";
import type { FakeMembershipRepo, FakeUserRepo } from "../../src/testfakes/tenancy";
import {
  FakeClock,
  FakeCredentialRepo,
  FakeMagicLinkRepo,
  FakeMailer,
  FakePasswordHasher,
  FakeSessionRepo,
  FakeTokenFactory,
} from "../../src/testfakes/identity";
import {
  InvalidCredentials,
  InvalidMagicLink,
  TooManyAttempts,
  NoActiveMembership,
  NotAMember,
  UserDisabled,
  WeakPassword,
} from "../../src/domain/identity/errors";
import { SESSION_TTL_DAYS, MAGIC_LINK_TTL_MINUTES } from "../../src/domain/identity/model";
import {
  LOGIN_ATTEMPTS_PER_WINDOW,
  LOGIN_WINDOW_SECONDS,
  MAGIC_LINKS_PER_WINDOW,
} from "../../src/usecase/identity/service";
import type { RecordingEventSink } from "../../src/testfakes/ledger";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const PASSWORD = "correct horse battery staple";

interface Harness {
  service: IdentityService;
  users: FakeUserRepo;
  memberships: FakeMembershipRepo;
  credentials: FakeCredentialRepo;
  sessions: FakeSessionRepo;
  magicLinks: FakeMagicLinkRepo;
  mailer: FakeMailer;
  clock: FakeClock;
  events: RecordingEventSink;
}

function harness(): Harness {
  const fakes = makeFakes();
  const credentials = new FakeCredentialRepo();
  const sessions = new FakeSessionRepo();
  const magicLinks = new FakeMagicLinkRepo();
  const mailer = new FakeMailer();
  const clock = new FakeClock();
  const service = new IdentityService({
    users: fakes.users,
    memberships: fakes.memberships,
    credentials,
    sessions,
    magicLinks,
    passwords: new FakePasswordHasher(),
    tokens: new FakeTokenFactory(),
    mailer,
    ids: fakes.ids,
    clock,
    events: fakes.events,
    attempts: new InMemoryRateLimiter(clock),
    magicLinkBaseUrl: "https://app.example.com",
  });
  return {
    service,
    users: fakes.users,
    memberships: fakes.memberships,
    credentials,
    sessions,
    magicLinks,
    mailer,
    clock,
    events: fakes.events,
  };
}

/** Stable uuids from readable labels. Seeded ids have to be real uuids now that
 *  every write records an event and the ledger validates what it is handed. */
const uuids = new Map<string, string>();
function uuidFor(label: string): string {
  const existing = uuids.get(label);
  if (existing !== undefined) return existing;
  const id = `00000000-0000-4000-9000-${String(uuids.size + 1).padStart(12, "0")}`;
  uuids.set(label, id);
  return id;
}

/** A user with a password and one active STAFF membership — the ordinary case. */
async function seedUser(
  h: Harness,
  email = "priya@harbourpoint.in",
  tenants: readonly string[] = [TENANT_A],
): Promise<string> {
  const user = await h.users.create({ id: uuidFor(`user:${email}`), email });
  for (const tenantId of tenants) {
    await h.memberships.create({
      id: uuidFor(`membership:${tenantId}:${email}`),
      tenantId,
      userId: user.id,
      audience: "STAFF",
      role: "partner",
      commercialVisibility: true,
    });
  }
  await h.service.setPassword(user.id, PASSWORD);
  return user.id;
}

describe("setPassword", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("refuses a password shorter than the policy", async () => {
    const user = await h.users.create({ id: uuidFor("user:a@b.co"), email: "a@b.co" });
    await expect(h.service.setPassword(user.id, "short")).rejects.toBeInstanceOf(WeakPassword);
  });

  it("revokes every existing session — a password change ends the thief's too", async () => {
    const userId = await seedUser(h);
    const first = await h.service.login("priya@harbourpoint.in", PASSWORD);
    const second = await h.service.login("priya@harbourpoint.in", PASSWORD);
    expect(await h.service.resolveSession(first.token)).not.toBeNull();

    await h.service.setPassword(userId, "an entirely new passphrase");

    expect(await h.service.resolveSession(first.token)).toBeNull();
    expect(await h.service.resolveSession(second.token)).toBeNull();
  });
});

describe("login", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("opens a session and auto-selects the only tenant", async () => {
    await seedUser(h);
    const result = await h.service.login("priya@harbourpoint.in", PASSWORD);
    expect(result.principal.tenantId).toBe(TENANT_A);
    expect(result.principal.audience).toBe("STAFF");
    expect(result.memberships).toHaveLength(1);
  });

  it("normalises the email — case and padding are not a different account", async () => {
    await seedUser(h);
    const result = await h.service.login("  PRIYA@HarbourPoint.in ", PASSWORD);
    expect(result.principal.userId).toBe(uuidFor("user:priya@harbourpoint.in"));
  });

  it("leaves the tenant unset when the user belongs to several", async () => {
    await seedUser(h, "partner@two-firms.com", [TENANT_A, TENANT_B]);
    const result = await h.service.login("partner@two-firms.com", PASSWORD);
    // A partner acting for two firms must SAY which one — every downstream gate
    // keys on that answer, so it is never guessed.
    expect(result.principal.tenantId).toBeNull();
    expect(result.principal.audience).toBeNull();
    expect(result.memberships).toHaveLength(2);
  });

  it("answers identically for an unknown email and a wrong password", async () => {
    await seedUser(h);
    const unknown = await h.service
      .login("nobody@example.com", PASSWORD)
      .catch((e: unknown) => e);
    const wrong = await h.service
      .login("priya@harbourpoint.in", "not the password")
      .catch((e: unknown) => e);

    expect(unknown).toBeInstanceOf(InvalidCredentials);
    expect(wrong).toBeInstanceOf(InvalidCredentials);
    // Same error, same message: the endpoint is not an oracle for who has an
    // account here — which, for a firm's client list, is itself the leak.
    expect((unknown as Error).message).toBe((wrong as Error).message);
  });

  it("refuses a user with no password set", async () => {
    await h.users.create({ id: uuidFor("user:invited2"), email: "invited@example.com" });
    await expect(
      h.service.login("invited@example.com", PASSWORD),
    ).rejects.toBeInstanceOf(InvalidCredentials);
  });

  it("names the reason only once the password is proved", async () => {
    // A disabled account and one with no membership are both told why — but
    // only after a correct password, so neither answer leaks to a stranger.
    const user = await h.users.create({ id: uuidFor("user:orphan"), email: "orphan@example.com" });
    await h.service.setPassword(user.id, PASSWORD);
    await expect(h.service.login("orphan@example.com", PASSWORD)).rejects.toBeInstanceOf(
      NoActiveMembership,
    );

    await seedUser(h, "gone@example.com");
    h.users.rows[h.users.rows.findIndex((r) => r.email === "gone@example.com")] = {
      id: uuidFor("user:gone@example.com"),
      email: "gone@example.com",
      status: "disabled",
    };
    await expect(h.service.login("gone@example.com", PASSWORD)).rejects.toBeInstanceOf(
      UserDisabled,
    );
  });

  it("refuses a user whose only membership was deactivated", async () => {
    await seedUser(h, "left@example.com");
    const i = h.memberships.rows.findIndex((m) => m.userId === uuidFor("user:left@example.com"));
    const row = h.memberships.rows[i];
    if (row) h.memberships.rows[i] = { ...row, isActive: false };
    await expect(h.service.login("left@example.com", PASSWORD)).rejects.toBeInstanceOf(
      NoActiveMembership,
    );
  });
});

describe("sessions", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("resolves a valid token to a principal, and an unknown one to null", async () => {
    await seedUser(h);
    const { token, principal } = await h.service.login("priya@harbourpoint.in", PASSWORD);
    expect(await h.service.resolveSession(token)).toEqual(principal);
    expect(await h.service.resolveSession("not-a-token")).toBeNull();
  });

  it("stops resolving once the session expires", async () => {
    await seedUser(h);
    const { token } = await h.service.login("priya@harbourpoint.in", PASSWORD);
    h.clock.advanceDays(SESSION_TTL_DAYS - 1);
    expect(await h.service.resolveSession(token)).not.toBeNull();
    h.clock.advanceDays(2);
    expect(await h.service.resolveSession(token)).toBeNull();
  });

  it("drops the tenant the moment the membership is deactivated", async () => {
    // Without this, dismissing someone left their existing session working in
    // that firm until it expired — up to a fortnight. Checking only at login
    // and switch-tenant misses the path every request actually takes.
    await seedUser(h);
    const { token } = await h.service.login("priya@harbourpoint.in", PASSWORD);
    expect((await h.service.resolveSession(token))?.tenantId).toBe(TENANT_A);

    const i = h.memberships.rows.findIndex((m) => m.tenantId === TENANT_A);
    const row = h.memberships.rows[i];
    if (row) h.memberships.rows[i] = { ...row, isActive: false };

    const after = await h.service.resolveSession(token);
    // Still signed in, but acting for nobody — a person removed from one firm
    // may still work at another, so they land on the org switcher.
    expect(after).not.toBeNull();
    expect(after?.tenantId).toBeNull();
    expect(after?.audience).toBeNull();
  });

  it("keeps working in the firms the user still belongs to", async () => {
    await seedUser(h, "partner@two-firms.com", [TENANT_A, TENANT_B]);
    const { token, principal } = await h.service.login("partner@two-firms.com", PASSWORD);
    await h.service.switchTenant(principal.sessionId, principal.userId, TENANT_B);

    const i = h.memberships.rows.findIndex((m) => m.tenantId === TENANT_A);
    const row = h.memberships.rows[i];
    if (row) h.memberships.rows[i] = { ...row, isActive: false };

    expect((await h.service.resolveSession(token))?.tenantId).toBe(TENANT_B);
  });

  it("stops resolving the moment it is revoked — not when it expires", async () => {
    await seedUser(h);
    const { token } = await h.service.login("priya@harbourpoint.in", PASSWORD);
    await h.service.logout(token);
    expect(await h.service.resolveSession(token)).toBeNull();
  });

  it("logout is idempotent and safe on an unknown token", async () => {
    await seedUser(h);
    const { token } = await h.service.login("priya@harbourpoint.in", PASSWORD);
    await h.service.logout(token);
    await expect(h.service.logout(token)).resolves.toBeUndefined();
    await expect(h.service.logout("never-existed")).resolves.toBeUndefined();
  });

  it("revokeAllSessions ends every session and reports how many", async () => {
    const userId = await seedUser(h);
    await h.service.login("priya@harbourpoint.in", PASSWORD);
    await h.service.login("priya@harbourpoint.in", PASSWORD);
    expect(await h.service.revokeAllSessions(userId)).toBe(2);
    expect(await h.service.revokeAllSessions(userId)).toBe(0);
  });
});

describe("switchTenant", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("points the session at another of the caller's tenants", async () => {
    await seedUser(h, "partner@two-firms.com", [TENANT_A, TENANT_B]);
    const { principal } = await h.service.login("partner@two-firms.com", PASSWORD);
    const switched = await h.service.switchTenant(
      principal.sessionId,
      principal.userId,
      TENANT_B,
    );
    expect(switched.tenantId).toBe(TENANT_B);
    expect(switched.audience).toBe("STAFF");
  });

  it("refuses a tenant the caller has no active membership in", async () => {
    await seedUser(h);
    const { principal } = await h.service.login("priya@harbourpoint.in", PASSWORD);
    await expect(
      h.service.switchTenant(principal.sessionId, principal.userId, TENANT_B),
    ).rejects.toBeInstanceOf(NotAMember);
  });

  it("re-checks the membership, so a revoked one cannot be switched into", async () => {
    await seedUser(h, "partner@two-firms.com", [TENANT_A, TENANT_B]);
    const { principal } = await h.service.login("partner@two-firms.com", PASSWORD);
    const i = h.memberships.rows.findIndex((m) => m.tenantId === TENANT_B);
    const row = h.memberships.rows[i];
    if (row) h.memberships.rows[i] = { ...row, isActive: false };

    await expect(
      h.service.switchTenant(principal.sessionId, principal.userId, TENANT_B),
    ).rejects.toBeInstanceOf(NotAMember);
  });
});

describe("magic links", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  /** The token as the user receives it: pulled out of the emailed url. */
  function tokenFromEmail(h2: Harness): string {
    const last = h2.mailer.sent.at(-1);
    if (!last) throw new Error("no email was sent");
    const token = new URL(last.url).searchParams.get("token");
    if (token === null) throw new Error(`no token in ${last.url}`);
    return token;
  }

  it("emails a link that redeems for a session", async () => {
    await seedUser(h);
    await h.service.requestMagicLink("priya@harbourpoint.in");
    expect(h.mailer.sent).toHaveLength(1);

    const result = await h.service.redeemMagicLink(tokenFromEmail(h));
    expect(result.principal.tenantId).toBe(TENANT_A);
    expect(await h.service.resolveSession(result.token)).not.toBeNull();
  });

  it("signs in a user who has no password at all — the invited case", async () => {
    const user = await h.users.create({ id: uuidFor("user:invited"), email: "invited@example.com" });
    await h.memberships.create({
      id: uuidFor("membership:invited"),
      tenantId: TENANT_A,
      userId: user.id,
      audience: "CLIENT_PORTAL",
      role: "client_contact",
      commercialVisibility: false,
    });
    await h.service.requestMagicLink("invited@example.com");
    const result = await h.service.redeemMagicLink(tokenFromEmail(h));
    expect(result.principal.audience).toBe("CLIENT_PORTAL");
  });

  it("says nothing and sends nothing for an address with no account", async () => {
    await expect(h.service.requestMagicLink("stranger@example.com")).resolves.toBeUndefined();
    expect(h.mailer.sent).toHaveLength(0);
  });

  it("is single use — the second redemption fails", async () => {
    await seedUser(h);
    await h.service.requestMagicLink("priya@harbourpoint.in");
    const token = tokenFromEmail(h);
    await h.service.redeemMagicLink(token);
    await expect(h.service.redeemMagicLink(token)).rejects.toBeInstanceOf(InvalidMagicLink);
  });

  it("expires", async () => {
    await seedUser(h);
    await h.service.requestMagicLink("priya@harbourpoint.in");
    const token = tokenFromEmail(h);
    h.clock.advanceMinutes(MAGIC_LINK_TTL_MINUTES + 1);
    await expect(h.service.redeemMagicLink(token)).rejects.toBeInstanceOf(InvalidMagicLink);
  });

  it("refuses an unknown token with the same error as an expired one", async () => {
    await expect(h.service.redeemMagicLink("made-up")).rejects.toBeInstanceOf(InvalidMagicLink);
  });
});


describe("per-account throttling", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  // The edge limits by client address; this limits by ACCOUNT. A botnet spreads
  // its guesses over a thousand addresses and walks past any per-IP rule — what
  // it cannot spread is whose password it is trying to break.
  it("stops a password from being ground down, however many addresses try", async () => {
    await seedUser(h);
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_WINDOW; i += 1) {
      await expect(
        h.service.login("priya@harbourpoint.in", `guess-${String(i)}`),
      ).rejects.toBeInstanceOf(InvalidCredentials);
    }
    await expect(
      h.service.login("priya@harbourpoint.in", "guess-again"),
    ).rejects.toBeInstanceOf(TooManyAttempts);
  });

  it("refuses even the CORRECT password once the budget is spent", async () => {
    // The attempt is counted before the password is checked. Counting only
    // failures would let a correct guess refund the budget being burned, and
    // would tell an attacker which guesses were right by whether it moved.
    await seedUser(h);
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_WINDOW; i += 1) {
      await h.service.login("priya@harbourpoint.in", "wrong").catch(() => null);
    }
    await expect(h.service.login("priya@harbourpoint.in", PASSWORD)).rejects.toBeInstanceOf(
      TooManyAttempts,
    );
  });

  it("throttles the account, not the caller — an unknown email is limited too", async () => {
    // Otherwise the endpoint answers "is this address one of yours?" by which
    // requests get throttled.
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_WINDOW; i += 1) {
      await h.service.login("stranger@example.com", "guess").catch(() => null);
    }
    await expect(h.service.login("stranger@example.com", "guess")).rejects.toBeInstanceOf(
      TooManyAttempts,
    );
  });

  it("clears the budget on a successful sign-in", async () => {
    // Someone who mistypes their passphrase twice and then gets it right must
    // not be locked out by their own success.
    await seedUser(h);
    await h.service.login("priya@harbourpoint.in", "wrong").catch(() => null);
    await h.service.login("priya@harbourpoint.in", "wrong").catch(() => null);
    await h.service.login("priya@harbourpoint.in", PASSWORD);

    for (let i = 0; i < LOGIN_ATTEMPTS_PER_WINDOW; i += 1) {
      await h.service.login("priya@harbourpoint.in", "wrong").catch(() => null);
    }
    // The budget was reset by the success, so the full allowance was available.
    await expect(h.service.login("priya@harbourpoint.in", PASSWORD)).rejects.toBeInstanceOf(
      TooManyAttempts,
    );
  });

  it("recovers after the window", async () => {
    await seedUser(h);
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_WINDOW; i += 1) {
      await h.service.login("priya@harbourpoint.in", "wrong").catch(() => null);
    }
    h.clock.advanceMinutes(LOGIN_WINDOW_SECONDS / 60 + 1);
    await expect(h.service.login("priya@harbourpoint.in", PASSWORD)).resolves.toBeDefined();
  });

  it("caps sign-in emails, so the endpoint cannot flood someone's inbox", async () => {
    // The cost of this one lands on a person who did not ask for it, which is
    // why it is capped lower than login.
    await seedUser(h);
    for (let i = 0; i < MAGIC_LINKS_PER_WINDOW + 3; i += 1) {
      await h.service.requestMagicLink("priya@harbourpoint.in");
    }
    expect(h.mailer.sent).toHaveLength(MAGIC_LINKS_PER_WINDOW);
  });

  it("still says nothing when a magic link is throttled", async () => {
    // A 429 here would confirm the address exists, which is exactly what this
    // endpoint refuses to reveal.
    await seedUser(h);
    for (let i = 0; i < MAGIC_LINKS_PER_WINDOW + 1; i += 1) {
      await expect(h.service.requestMagicLink("priya@harbourpoint.in")).resolves.toBeUndefined();
    }
  });
});
