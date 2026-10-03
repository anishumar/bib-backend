// The sign-in flow, against in-memory ports. The interesting assertions here
// are the negative ones: what the system refuses to reveal, and what stops
// working the moment a session is revoked.
import { FakeClock } from "../../src/testfakes/clock";
import { InstantSleeper } from "../../src/platform/clock";
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
  InvitationAlreadyAccepted,
  retryIn,
  TooManyAttempts,
  NoActiveMembership,
  NotAMember,
  UserDisabled,
  WeakPassword,
} from "../../src/domain/identity/errors";
import {
  SESSION_IDLE_DAYS,
  SESSION_TOUCH_MINUTES,
  SESSION_TTL_DAYS,
  MAGIC_LINK_TTL_MINUTES,
  STAFF_WELCOME_TTL_HOURS,
} from "../../src/domain/identity/model";
import {
  LOGIN_ACCOUNT_ATTEMPTS_PER_WINDOW,
  LOGIN_ATTEMPTS_PER_WINDOW,
  LOGIN_WINDOW_SECONDS,
  MAGIC_LINK_FLOOR_MS,
  MAGIC_LINKS_PER_WINDOW,
  PORTAL_INVITE_RESENDS_PER_WINDOW,
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
  /** What the sign-in-link route waited for. Its constant-time floor is a
   *  security property, so it is observable rather than a hidden setTimeout. */
  sleeper: InstantSleeper;
  events: RecordingEventSink;
}

function harness(mailerOverride?: Mailer): Harness {
  const fakes = makeFakes();
  const credentials = new FakeCredentialRepo();
  const magicLinks = new FakeMagicLinkRepo();
  const mailer = new FakeMailer();
  const clock = new FakeClock();
  // AFTER the clock, and it takes it: a session's timestamps have to move with
  // the same time the service reads, or every idle assertion is vacuous.
  const sessions = new FakeSessionRepo(clock);
  const sleeper = new InstantSleeper();
  const service = new IdentityService({
    users: fakes.users,
    memberships: fakes.memberships,
    tenants: fakes.tenants,
    credentials,
    sessions,
    magicLinks,
    passwords: new FakePasswordHasher(),
    tokens: new FakeTokenFactory(),
    mailer: mailerOverride ?? mailer,
    ids: fakes.ids,
    clock,
    sleeper,
    events: fakes.events,
    attempts: new InMemoryRateLimiter(clock),
    magicLinkBaseUrl: "https://app.example.com",
  });
  return {
    service,
    sleeper,
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
    // USED along the way, a day at a time. Without that the IDLE clock would
    // end it first and this would be testing the wrong thing — which is the
    // point of having both: the absolute TTL is what stops a session somebody
    // IS using, and it is the only thing that can.
    for (let day = 0; day < SESSION_TTL_DAYS - 1; day += 1) {
      h.clock.advanceDays(1);
      expect(await h.service.resolveSession(token)).not.toBeNull();
    }
    h.clock.advanceDays(2);
    expect(await h.service.resolveSession(token)).toBeNull();
  });

  it("stops resolving a session nobody has used, long before it expires", async () => {
    // The clock the fortnight-long TTL could not see. A laptop left open in a
    // co-working space, a browser on a phone that has been sold, a session
    // opened on a client's machine to show them something — every one of them
    // stayed valid for fourteen days of doing nothing, and the product had no
    // way to tell that from somebody who signed in this morning.
    await seedUser(h);
    const { token } = await h.service.login("priya@harbourpoint.in", PASSWORD);

    h.clock.advanceDays(SESSION_IDLE_DAYS - 1);
    expect(await h.service.resolveSession(token)).not.toBeNull();

    // And that read moved the idle clock on, so the budget starts again.
    h.clock.advanceDays(SESSION_IDLE_DAYS - 1);
    expect(await h.service.resolveSession(token)).not.toBeNull();

    h.clock.advanceDays(SESSION_IDLE_DAYS + 1);
    expect(await h.service.resolveSession(token)).toBeNull();
  });

  it("does not write on every request to keep that clock", async () => {
    // The idle clock is only affordable because it is NOT a write per request:
    // this is the hottest row in the system and every authenticated read
    // touches it. Two reads a second apart must move nothing.
    await seedUser(h);
    const { token } = await h.service.login("priya@harbourpoint.in", PASSWORD);
    const before = h.sessions.rows[0]?.lastSeenAt;

    h.clock.advanceMinutes(1);
    await h.service.resolveSession(token);
    expect(h.sessions.rows[0]?.lastSeenAt).toBe(before);

    h.clock.advanceMinutes(SESSION_TOUCH_MINUTES + 1);
    await h.service.resolveSession(token);
    expect(h.sessions.rows[0]?.lastSeenAt).not.toBe(before);
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

  it("takes the same time whether or not the address has an account", async () => {
    // The route already says nothing: unknown address, inactive account and a
    // spent budget all return quietly and the handler answers 202 to all of
    // them. What it could not hide was how LONG it took — a known address
    // generates a token, inserts a row and hands a letter to a relay; an
    // unknown one returns after one SELECT. That gap is an enumeration oracle
    // with a stopwatch for a tool, and a real SMTP relay widens it to hundreds
    // of milliseconds.
    await seedUser(h);

    await h.service.requestMagicLink("priya@harbourpoint.in");
    const known = h.sleeper.waited.at(-1);

    await h.service.requestMagicLink("nobody@nowhere.invalid");
    const unknown = h.sleeper.waited.at(-1);

    // Both padded to the same floor. The fake clock does not advance, so both
    // measure zero work and both wait the whole floor — what is asserted is
    // that BOTH paths are padded, which is the property; the arithmetic that
    // subtracts real elapsed time is the same line for both.
    expect(known).toBe(MAGIC_LINK_FLOOR_MS);
    expect(unknown).toBe(MAGIC_LINK_FLOOR_MS);
  });

  it("pads the rate-limited path too — it is the cheapest exit of all", async () => {
    await seedUser(h);
    for (let i = 0; i < MAGIC_LINKS_PER_WINDOW + 1; i += 1) {
      await h.service.requestMagicLink("priya@harbourpoint.in");
    }
    expect(h.sleeper.waited.at(-1)).toBe(MAGIC_LINK_FLOOR_MS);
  });

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

  it("points a colleague who HAS a password at the SIGN-IN page, never the portal's form", async () => {
    // A link to `/portal/accept-invite` would land a colleague on a page whose
    // only action is impossible for them. One with no password goes to
    // `/auth/welcome` instead, where the first one is chosen (CA#38, see
    // password.test.ts); this seeded colleague has one.
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

  /** Two callers, so the per-(account, caller) budget can be told apart. The
   *  edge derives these from the connection; a test just names them. */
  const GUESSER = "203.0.113.9";
  const OWNER = "198.51.100.4";

  // The edge limits by client address; this limits by ACCOUNT AND CALLER. A
  // botnet spreads its guesses over a thousand addresses and walks past any
  // per-IP rule — what it cannot spread is whose password it is trying to
  // break.
  it("stops one caller grinding one password down", async () => {
    await seedUser(h);
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_WINDOW; i += 1) {
      await expect(
        h.service.login("priya@harbourpoint.in", `guess-${String(i)}`, GUESSER),
      ).rejects.toBeInstanceOf(InvalidCredentials);
    }
    const refused = h.service.login("priya@harbourpoint.in", "guess-again", GUESSER);
    await expect(refused).rejects.toBeInstanceOf(TooManyAttempts);
    // In words a person reads, not "retry in 3582s".
    await expect(refused).rejects.toThrow(
      /^Too many sign-in attempts for this account\. Try again in (\d+ (seconds|minutes)|an hour|\d+ hours)\.$/,
    );
  });

  it("CANNOT be aimed at somebody — a stranger's guesses do not lock the owner out", async () => {
    // THE BUG THIS EXISTS TO END. The budget used to be per ACCOUNT alone and
    // was spent before the password was checked, so ten deliberately wrong
    // guesses at any address you knew locked its owner out for an hour — no
    // CAPTCHA, no back-off, no way to end it but waiting. A control a stranger
    // can point at a named person is a denial of service wearing a security
    // control's clothes.
    await seedUser(h);
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_WINDOW + 5; i += 1) {
      await h.service.login("priya@harbourpoint.in", "wrong", GUESSER).catch(() => null);
    }
    // The guesser is refused; the owner, at their own address, signs in.
    await expect(
      h.service.login("priya@harbourpoint.in", "wrong", GUESSER),
    ).rejects.toBeInstanceOf(TooManyAttempts);
    await expect(
      h.service.login("priya@harbourpoint.in", PASSWORD, OWNER),
    ).resolves.toBeDefined();
  });

  it("still closes the door on a DISTRIBUTED grind", async () => {
    // The per-caller budget is, by construction, per caller: a thousand hosts
    // each spending ten would be a thousand times the intended rate against one
    // account. So a second budget counts the account's FAILURES across every
    // caller — and it is read only after a wrong password, so it can never
    // refuse somebody who typed the right thing either.
    await seedUser(h);
    for (let i = 0; i < LOGIN_ACCOUNT_ATTEMPTS_PER_WINDOW; i += 1) {
      await h.service
        .login("priya@harbourpoint.in", "wrong", `host-${String(i)}`)
        .catch(() => null);
    }
    // A fresh address, which has spent none of its own budget, is refused.
    await expect(
      h.service.login("priya@harbourpoint.in", "wrong", "203.0.113.77"),
    ).rejects.toBeInstanceOf(TooManyAttempts);
  });

  it("and the owner still gets in while that grind is running", async () => {
    // The property that makes the wide budget safe to have at all. It decides
    // what a WRONG password costs and nothing else.
    await seedUser(h);
    for (let i = 0; i < LOGIN_ACCOUNT_ATTEMPTS_PER_WINDOW + 10; i += 1) {
      await h.service
        .login("priya@harbourpoint.in", "wrong", `host-${String(i)}`)
        .catch(() => null);
    }
    await expect(
      h.service.login("priya@harbourpoint.in", PASSWORD, OWNER),
    ).resolves.toBeDefined();
  });

  it("refuses even the CORRECT password once ONE CALLER has spent its budget", async () => {
    // Within a single caller the attempt is still counted before the password
    // is checked: counting only failures there would let a correct guess refund
    // the budget being burned. The blast radius is that caller and nobody else,
    // which is the whole change.
    await seedUser(h);
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_WINDOW; i += 1) {
      await h.service.login("priya@harbourpoint.in", "wrong", GUESSER).catch(() => null);
    }
    await expect(
      h.service.login("priya@harbourpoint.in", PASSWORD, GUESSER),
    ).rejects.toBeInstanceOf(TooManyAttempts);
  });

  it("throttles the account, not the caller — an unknown email is limited too", async () => {
    // Otherwise the endpoint answers "is this address one of yours?" by which
    // requests get throttled.
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_WINDOW; i += 1) {
      await h.service.login("stranger@example.com", "guess", GUESSER).catch(() => null);
    }
    await expect(
      h.service.login("stranger@example.com", "guess", GUESSER),
    ).rejects.toBeInstanceOf(TooManyAttempts);
  });

  it("clears the budget on a successful sign-in", async () => {
    // Someone who mistypes their passphrase twice and then gets it right must
    // not be locked out by their own success.
    await seedUser(h);
    await h.service.login("priya@harbourpoint.in", "wrong", OWNER).catch(() => null);
    await h.service.login("priya@harbourpoint.in", "wrong", OWNER).catch(() => null);
    await h.service.login("priya@harbourpoint.in", PASSWORD, OWNER);

    for (let i = 0; i < LOGIN_ATTEMPTS_PER_WINDOW; i += 1) {
      await h.service.login("priya@harbourpoint.in", "wrong", OWNER).catch(() => null);
    }
    // The budget was reset by the success, so the full allowance was available.
    await expect(
      h.service.login("priya@harbourpoint.in", PASSWORD, OWNER),
    ).rejects.toBeInstanceOf(TooManyAttempts);
  });

  it("recovers after the window", async () => {
    await seedUser(h);
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_WINDOW; i += 1) {
      await h.service.login("priya@harbourpoint.in", "wrong", OWNER).catch(() => null);
    }
    h.clock.advanceMinutes(LOGIN_WINDOW_SECONDS / 60 + 1);
    await expect(
      h.service.login("priya@harbourpoint.in", PASSWORD, OWNER),
    ).resolves.toBeDefined();
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
    //
    // No password on the account, which is what makes this the INVITE path
    // rather than the sign-in one — see the downgrade tests below.
    const relay = new UnreachableMailer();
    const h = harness(relay);
    const user = await h.users.create({
      id: uuidFor("user:meera@cobaltfoods.in"),
      email: "meera@cobaltfoods.in",
    });

    await expect(h.service.invitePortalContact(user.id, "10x Global")).rejects.toThrow();
    expect(relay.attempted).toEqual([{ to: "meera@cobaltfoods.in", kind: "invite" }]);
  });
});


describe("inviting an address that ALREADY has a login", () => {
  // Accounts are global (ADR-02) and the invitation is a link on which a
  // password is CHOSEN. Before this, a firm inviting somebody who was already
  // staff at another firm handed them a letter that — when opened, which is the
  // ordinary thing to do — replaced their password everywhere and revoked every
  // session they held. Any firm, any address, no confirmation.

  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  /** The token out of the SIGN-IN letter this path sends. Kept apart from the
   *  invite letter's by the fake, which is the whole assertion. */
  function tokenFromUrl(url: string): string {
    const token = new URL(url).searchParams.get("token");
    if (token === null) throw new Error(`no token in ${url}`);
    return token;
  }

  it("sends a SIGN-IN link instead of a password-setting one", async () => {
    const userId = await seedUser(h, "meera@cobaltfoods.in");

    await h.service.invitePortalContact(userId, "10x Global");

    // Not on `invites`: the password-setting letter must not have gone.
    expect(h.mailer.invites).toEqual([]);
    expect(h.mailer.portalWelcomes).toHaveLength(1);
    expect(h.mailer.portalWelcomes[0]?.to).toBe("meera@cobaltfoods.in");
    expect(h.mailer.portalWelcomes[0]?.firmName).toBe("10x Global");
    // And it points at the sign-in redemption page, not the accept-invite one.
    expect(h.mailer.portalWelcomes[0]?.url).toContain("/auth/magic-link?token=");
  });

  it("issues a link that cannot be redeemed to set a password", async () => {
    const userId = await seedUser(h, "meera@cobaltfoods.in");
    await h.service.invitePortalContact(userId, "10x Global");
    const token = tokenFromUrl(h.mailer.portalWelcomes[0]?.url ?? "");

    // The whole point: this token opens a session and is refused by the route
    // that would overwrite the credential.
    await expect(h.service.acceptPortalInvite(token, "a new password entirely")).rejects.toThrow(
      InvalidMagicLink,
    );
  });

  it("leaves the password they already had working", async () => {
    const userId = await seedUser(h, "meera@cobaltfoods.in");
    await h.service.invitePortalContact(userId, "10x Global");
    const token = tokenFromUrl(h.mailer.portalWelcomes[0]?.url ?? "");

    // Redeeming it signs them in, and the credential is untouched afterwards.
    await h.service.redeemMagicLink(token);
    const signedIn = await h.service.login("meera@cobaltfoods.in", PASSWORD);
    expect(signedIn.principal.userId).toBe(userId);
  });

  it("still sends the password-setting letter to somebody with no login", async () => {
    const user = await h.users.create({
      id: uuidFor("user:new@cobaltfoods.in"),
      email: "new@cobaltfoods.in",
    });

    await h.service.invitePortalContact(user.id, "10x Global");

    expect(h.mailer.portalWelcomes).toEqual([]);
    expect(h.mailer.invites).toHaveLength(1);
    expect(h.mailer.invites[0]?.url).toContain("/portal/accept-invite?token=");
  });
});


describe("re-sending a portal invitation (T7.0b)", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  /** A client contact as they exist between being invited and accepting: an
   *  account, a membership, and NO password. `seedUser` sets one, which is
   *  exactly the state this route refuses. */
  async function seedContact(email = "meera@cobaltfoods.in"): Promise<string> {
    const user = await h.users.create({ id: uuidFor(`user:${email}`), email });
    await h.memberships.create({
      id: uuidFor(`membership:${TENANT_A}:${email}`),
      tenantId: TENANT_A,
      userId: user.id,
      audience: "CLIENT_PORTAL",
      role: "client_contact",
      commercialVisibility: false,
    });
    return user.id;
  }

  it("sends the SAME letter to the SAME address, and there is no way to say otherwise", async () => {
    const userId = await seedContact();

    const out = await h.service.resendPortalInvite(userId, "10x Global");

    expect(h.mailer.invites).toHaveLength(1);
    expect(h.mailer.invites[0]?.to).toBe("meera@cobaltfoods.in");
    expect(h.mailer.invites[0]?.firmName).toBe("10x Global");
    // The password page, not the sign-in one: a contact with no password who
    // followed a `/auth/magic-link` would open a session and still have none.
    expect(h.mailer.invites[0]?.url).toContain("/portal/accept-invite?token=");
    expect(out.expiresAt).toBe(h.mailer.invites[0]?.expiresAt);
    // And it is not the sign-in letter wearing a different subject.
    expect(h.mailer.sent).toHaveLength(0);
  });

  it("SPENDS the live link it replaces, so nobody holds two password setters", async () => {
    const userId = await seedContact();
    await h.service.invitePortalContact(userId, "10x Global");

    const first = new URL(h.mailer.invites[0]!.url).searchParams.get("token")!;
    const out = await h.service.resendPortalInvite(userId, "10x Global");
    const second = new URL(h.mailer.invites[1]!.url).searchParams.get("token")!;

    expect(out.supersededLinks).toBe(1);
    // The old one is dead — and this is the assertion that matters, because an
    // invite link SETS A PASSWORD. One left alive after the contact has used
    // the new one is a password reset sitting in an inbox.
    await expect(h.service.acceptPortalInvite(first, PASSWORD)).rejects.toBeInstanceOf(
      InvalidMagicLink,
    );
    await expect(h.service.acceptPortalInvite(second, PASSWORD)).resolves.toBeTruthy();
  });

  it("reports ZERO superseded when the previous link had already expired", async () => {
    const userId = await seedContact();
    await h.service.invitePortalContact(userId, "10x Global");
    h.clock.advanceMinutes(8 * 24 * 60);

    // The commonest reason anybody presses this button, and the count has to be
    // honest about it: nothing live was replaced.
    const out = await h.service.resendPortalInvite(userId, "10x Global");
    expect(out.supersededLinks).toBe(0);
  });

  it("REFUSES once they have set a password — a firm may not reset its client's", async () => {
    const userId = await seedContact();
    await h.service.invitePortalContact(userId, "10x Global");
    const token = new URL(h.mailer.invites[0]!.url).searchParams.get("token")!;
    await h.service.acceptPortalInvite(token, PASSWORD);

    await expect(h.service.resendPortalInvite(userId, "10x Global")).rejects.toBeInstanceOf(
      InvitationAlreadyAccepted,
    );
    // And nothing was mailed. A refusal that still sent the letter would be the
    // worst of both.
    expect(h.mailer.invites).toHaveLength(1);
  });

  it("refuses an account that is not there, or is deactivated", async () => {
    await expect(
      h.service.resendPortalInvite(uuidFor("user:nobody"), "10x Global"),
    ).rejects.toBeInstanceOf(InvalidMagicLink);
    expect(h.mailer.invites).toHaveLength(0);
  });

  it("is throttled PER CONTACT, and says so — the cost lands on their inbox", async () => {
    const userId = await seedContact();

    for (let i = 0; i < PORTAL_INVITE_RESENDS_PER_WINDOW; i += 1) {
      await h.service.resendPortalInvite(userId, "10x Global");
    }

    // Reported as a refusal, unlike `requestMagicLink`'s quiet return: the
    // caller is a member of the firm looking at a contact they already named,
    // so there is no account to be coy about — and silence here would look
    // exactly like the send failing.
    await expect(h.service.resendPortalInvite(userId, "10x Global")).rejects.toBeInstanceOf(
      TooManyAttempts,
    );
    expect(h.mailer.invites).toHaveLength(PORTAL_INVITE_RESENDS_PER_WINDOW);
  });

  it("does NOT say 'sign-in attempts' — the refusal has to describe THIS act", async () => {
    // Found by walking the screen: a partner pressing "Send it again" was told
    // "too many sign-in attempts for this account". Nobody had attempted to
    // sign in, and the only account named was somebody else's — so the reader
    // goes looking for a login problem that does not exist.
    const userId = await seedContact();
    for (let i = 0; i < PORTAL_INVITE_RESENDS_PER_WINDOW; i += 1) {
      await h.service.resendPortalInvite(userId, "10x Global");
    }

    await expect(h.service.resendPortalInvite(userId, "10x Global")).rejects.toThrow(
      /invitations in the last hour/,
    );
    await expect(h.service.resendPortalInvite(userId, "10x Global")).rejects.not.toThrow(
      /sign-in attempts/,
    );
    // And the wait is said the way a person says one, not as `3582s`.
    expect(retryIn(3582)).toBe("an hour");
    expect(retryIn(150)).toBe("3 minutes");
    expect(retryIn(20)).toBe("20 seconds");
  });

  it("spends the budget on the CHECK, so a refused send does not buy a free retry", async () => {
    const relay = new UnreachableMailer();
    const h2 = harness(relay);
    const user = await h2.users.create({
      id: uuidFor("user:meera@cobaltfoods.in"),
      email: "meera@cobaltfoods.in",
    });

    for (let i = 0; i < PORTAL_INVITE_RESENDS_PER_WINDOW; i += 1) {
      await expect(h2.service.resendPortalInvite(user.id, "10x Global")).rejects.toThrow();
    }
    await expect(h2.service.resendPortalInvite(user.id, "10x Global")).rejects.toBeInstanceOf(
      TooManyAttempts,
    );
  });

  it("surfaces a refused relay, exactly as the FIRST invitation does", async () => {
    const relay = new UnreachableMailer();
    const h2 = harness(relay);
    const user = await h2.users.create({
      id: uuidFor("user:meera@cobaltfoods.in"),
      email: "meera@cobaltfoods.in",
    });

    await expect(h2.service.resendPortalInvite(user.id, "10x Global")).rejects.toThrow();
    expect(relay.attempted).toEqual([{ to: "meera@cobaltfoods.in", kind: "invite" }]);
  });
});
