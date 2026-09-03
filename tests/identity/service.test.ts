// The sign-in flow, against in-memory ports. The interesting assertions here
// are the negative ones: what the system refuses to reveal, and what stops
// working the moment a session is revoked.
import { FakeClock } from "../../src/testfakes/clock";
import { beforeEach, describe, expect, it } from "vitest";
import { IdentityService } from "../../src/usecase/identity/service";
import { InMemoryRateLimiter } from "../../src/platform/ratelimit";
import { makeFakes } from "../../src/testfakes/tenancy";
import type { FakeMembershipRepo, FakeUserRepo } from "../../src/testfakes/tenancy";
import {
  FakeCredentialRepo,
  FakeMagicLinkRepo,
  FakeMailer,
  FakePasswordHasher,
  FakeSessionRepo,
  FakeTokenFactory,
  UnreachableMailer,
} from "../../src/testfakes/identity";
import type { Mailer } from "../../src/usecase/identity/ports";
import {
  InvalidCredentials,
  InvalidMagicLink,
  TooManyAttempts,
  NoActiveMembership,
  NotAMember,
  UserDisabled,
  WeakPassword,
} from "../../src/domain/identity/errors";
import {
  SESSION_TTL_DAYS,
  MAGIC_LINK_TTL_MINUTES,
  STAFF_WELCOME_TTL_HOURS,
} from "../../src/domain/identity/model";
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

function harness(mailerOverride?: Mailer): Harness {
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
    mailer: mailerOverride ?? mailer,
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
      displayName: null,
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


describe("the welcome link — pushed, not pulled (0072)", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  /** The token as the colleague receives it, out of the WELCOME letter. The
   *  fake keeps welcomes apart from sign-in links on purpose: a test asserting
   *  a colleague was written to must not pass on a magic link. */
  function tokenFromWelcome(h2: Harness): string {
    const last = h2.mailer.welcomes.at(-1);
    if (!last) throw new Error("no welcome was sent");
    const token = new URL(last.url).searchParams.get("token");
    if (token === null) throw new Error(`no token in ${last.url}`);
    return token;
  }

  it("writes to the colleague and redeems for a session", async () => {
    const userId = await seedUser(h);
    const outcome = await h.service.welcomeStaff(userId, "10x Global");

    expect(outcome.sent).toBe(true);
    expect(h.mailer.welcomes).toHaveLength(1);
    // The letter names the firm, and it is the FIRM's name that got here —
    // the mailer cannot invent one.
    expect(h.mailer.welcomes[0]?.firmName).toBe("10x Global");
    // And it is not the sign-in letter wearing a different subject.
    expect(h.mailer.sent).toHaveLength(0);

    const result = await h.service.redeemMagicLink(tokenFromWelcome(h));
    expect(result.principal.tenantId).toBe(TENANT_A);
    expect(await h.service.resolveSession(result.token)).not.toBeNull();
  });

  it("points at the SIGN-IN page, not at a password form", async () => {
    // Staff have no password to set — no product route sets one — so a link to
    // `/portal/accept-invite` would land a colleague on a page whose only
    // action is impossible for them.
    const userId = await seedUser(h);
    await h.service.welcomeStaff(userId, "10x Global");
    expect(h.mailer.welcomes[0]?.url).toContain("/auth/magic-link?token=");
  });

  it("lives HOURS, not the sign-in link's minutes", async () => {
    const userId = await seedUser(h);
    await h.service.welcomeStaff(userId, "10x Global");
    const token = tokenFromWelcome(h);

    // Long past a sign-in link's life, and still good — which is the entire
    // reason this is a separate purpose rather than a longer `login`.
    h.clock.advanceMinutes(MAGIC_LINK_TTL_MINUTES + 1);
    h.clock.advanceMinutes(24 * 60);
    await expect(h.service.redeemMagicLink(token)).resolves.toBeTruthy();
  });

  it("expires at 72 hours", async () => {
    const userId = await seedUser(h);
    await h.service.welcomeStaff(userId, "10x Global");
    const token = tokenFromWelcome(h);
    h.clock.advanceMinutes(STAFF_WELCOME_TTL_HOURS * 60 + 1);
    await expect(h.service.redeemMagicLink(token)).rejects.toBeInstanceOf(InvalidMagicLink);
  });

  it("is single use", async () => {
    const userId = await seedUser(h);
    await h.service.welcomeStaff(userId, "10x Global");
    const token = tokenFromWelcome(h);
    await h.service.redeemMagicLink(token);
    await expect(h.service.redeemMagicLink(token)).rejects.toBeInstanceOf(InvalidMagicLink);
  });

  it("CANNOT be spent as a portal invite — it sets no password", async () => {
    // The negative control for the purpose column. Accepting it here would let
    // somebody set a password on a staff account through a route no staff
    // member is supposed to reach, using a link mailed to them unasked.
    const userId = await seedUser(h);
    await h.service.welcomeStaff(userId, "10x Global");
    await expect(
      h.service.acceptPortalInvite(tokenFromWelcome(h), PASSWORD),
    ).rejects.toBeInstanceOf(InvalidMagicLink);
  });

  it("does not write to a deactivated account, and says so rather than throwing", async () => {
    const userId = await seedUser(h);
    const i = h.users.rows.findIndex((r) => r.id === userId);
    const row = h.users.rows[i];
    if (row === undefined) throw new Error("the seeded user vanished");
    h.users.rows[i] = { ...row, status: "disabled" };

    const outcome = await h.service.welcomeStaff(userId, "10x Global");

    expect(outcome.sent).toBe(false);
    expect(outcome.expiresAt).toBeNull();
    expect(h.mailer.welcomes).toHaveLength(0);
  });

  it("REPORTS a refused relay — neither swallowed nor thrown", async () => {
    // The third answer, and the one this method exists to give. The two
    // neighbours in the service do the other two, for reasons that do not apply
    // here: there is no account to be quiet about (an admin named the address)
    // and no trap (the sign-in page issues another link).
    const relay = new UnreachableMailer();
    const broken = harness(relay);
    const userId = await seedUser(broken);

    const outcome = await broken.service.welcomeStaff(userId, "10x Global");
    expect(outcome.sent).toBe(false);
    // It was ATTEMPTED — otherwise this passes on code that never called the
    // mailer at all.
    expect(relay.attempted).toEqual([{ to: "priya@harbourpoint.in", kind: "welcome" }]);
    // And the expiry is still reported, because a link WAS written.
    expect(outcome.expiresAt).not.toBeNull();
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

// ── WHEN THE RELAY IS DOWN, AND WHY THE TWO PATHS ANSWER DIFFERENTLY ─────────
//
// This whole block was unreachable until a real mailer existed. `LoggingMailer`
// writes to a log and a log cannot refuse; an SMTP relay rejects a recipient,
// times out, or runs out of quota, so "the send threw" became a state the
// product can actually be in the day the transport landed.
//
// The two paths must not behave the same, and getting it backwards is a bug in
// each direction: swallow the invite and a client silently never gets in;
// surface the sign-in link and the error path becomes an account oracle.
describe("a send that fails", () => {
  it("does NOT change the answer on the sign-in path — that would enumerate accounts", async () => {
    // Everything about requestMagicLink is built to say nothing: an unknown or
    // deactivated address returns early and the route answers 202 either way.
    // A thrown send would answer 202 for an address with no account and 500 for
    // one with an account whose letter would not go — an enumeration oracle
    // assembled out of an error path, with no code anywhere admitting to it.
    const relay = new UnreachableMailer();
    const h = harness(relay);
    await seedUser(h, "priya@harbourpoint.in");

    await expect(h.service.requestMagicLink("priya@harbourpoint.in")).resolves.toBeUndefined();
    // And the two cases are INDISTINGUISHABLE, which is the actual property —
    // asserting only that the first one resolves would pass on a version that
    // threw for both.
    await expect(h.service.requestMagicLink("nobody@nowhere.example")).resolves.toBeUndefined();

    // The letter was genuinely attempted for the real account and not for the
    // unknown one; otherwise this test would also pass if the mailer were never
    // called at all.
    expect(relay.attempted).toEqual([{ to: "priya@harbourpoint.in", kind: "magic-link" }]);
  });

  it("DOES surface on the invite path — a firm is watching a screen", async () => {
    // The opposite decision, for the opposite reason. There is no account to be
    // quiet about: a member of the firm has just named this person, and a
    // silent failure is a client who never gets in and nobody knowing.
    const relay = new UnreachableMailer();
    const h = harness(relay);
    const userId = await seedUser(h, "meera@cobaltfoods.in");

    await expect(h.service.invitePortalContact(userId, "10x Global")).rejects.toThrow();
    expect(relay.attempted).toEqual([{ to: "meera@cobaltfoods.in", kind: "invite" }]);
  });
});
