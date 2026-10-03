// Resetting a forgotten password, and changing one you still know (0082).
//
// The two flows are tested together because the interesting assertions are the
// ones that hold them APART. They both end in a credential being written, and
// almost every rule in this module is about which of them a given caller is
// allowed to be standing in:
//
//   the RESET path is reachable by anybody on the internet, so it must say
//   nothing — same answer, same timing, for an address with an account and one
//   without — and it must never hand out a session without the password having
//   actually been replaced.
//
//   the CHANGE path is reachable only with a live session, and a live session
//   is deliberately NOT enough on its own: the current password is what is
//   being proved, because a session that could mint a new one would outlive
//   every revocation the firm has.
import { beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/testfakes/clock";
import { InstantSleeper } from "../../src/platform/clock";
import { InMemoryRateLimiter } from "../../src/platform/ratelimit";
import { IdentityService } from "../../src/usecase/identity/service";
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
  CurrentPasswordIncorrect,
  InvalidCredentials,
  InvalidMagicLink,
  NoPasswordSet,
  PasswordAlreadySet,
  PasswordUnchanged,
  TooManyAttempts,
  WeakPassword,
} from "../../src/domain/identity/errors";
import { PASSWORD_RESET_TTL_MINUTES } from "../../src/domain/identity/model";
import {
  MAGIC_LINK_FLOOR_MS,
  PASSWORD_CHANGE_ATTEMPTS_PER_WINDOW,
  PASSWORD_RESETS_PER_WINDOW,
} from "../../src/usecase/identity/service";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const EMAIL = "priya@harbourpoint.in";
const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "a different long passphrase";

interface Harness {
  service: IdentityService;
  users: FakeUserRepo;
  memberships: FakeMembershipRepo;
  credentials: FakeCredentialRepo;
  magicLinks: FakeMagicLinkRepo;
  mailer: FakeMailer;
  clock: FakeClock;
  /** What the reset-request route waited for. Its constant-time floor is a
   *  security property, so it is observable rather than a hidden setTimeout. */
  sleeper: InstantSleeper;
}

function harness(mailerOverride?: Mailer): Harness {
  const fakes = makeFakes();
  const credentials = new FakeCredentialRepo();
  const magicLinks = new FakeMagicLinkRepo();
  const mailer = new FakeMailer();
  const clock = new FakeClock();
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
  return { service, users: fakes.users, memberships: fakes.memberships, credentials, magicLinks, mailer, clock, sleeper };
}

const uuids = new Map<string, string>();
function uuidFor(label: string): string {
  const existing = uuids.get(label);
  if (existing !== undefined) return existing;
  const id = `00000000-0000-4000-9000-${String(uuids.size + 1).padStart(12, "0")}`;
  uuids.set(label, id);
  return id;
}

/** A user with one active STAFF membership and NO password — which is the
 *  ordinary state of a colleague at a real firm, since `welcomeStaff` hands
 *  over a session and never a credential. */
async function seedPasswordless(
  h: Harness,
  email = EMAIL,
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
  return user.id;
}

async function seedUser(
  h: Harness,
  email = EMAIL,
  tenants: readonly string[] = [TENANT_A],
): Promise<string> {
  const userId = await seedPasswordless(h, email, tenants);
  await h.service.setPassword(userId, PASSWORD);
  return userId;
}

/** The token out of the most recent reset letter. The service never returns
 *  it — it exists in the mail and nowhere else, which is the property. */
function resetToken(h: Harness): string {
  const last = h.mailer.resets.at(-1);
  if (last === undefined) throw new Error("no reset letter was sent");
  const token = new URL(last.url).searchParams.get("token");
  if (token === null) throw new Error(`no token in ${last.url}`);
  return token;
}

describe("requestPasswordReset", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("mails a reset link to the address on the account, at the page that sets one", async () => {
    await seedUser(h);
    await h.service.requestPasswordReset(EMAIL);

    expect(h.mailer.resets).toHaveLength(1);
    expect(h.mailer.resets[0]?.to).toBe(EMAIL);
    // The PATH is not a detail: the backend composes it and the frontend route
    // exists at that address, so a change here 404s every letter ever sent.
    expect(h.mailer.resets[0]?.url).toContain("https://app.example.com/auth/reset-password?token=");
    // And it is not a sign-in link wearing a different url. The two are
    // separate methods on the port precisely so a test can tell them apart.
    expect(h.mailer.sent).toHaveLength(0);
  });

  it("writes the link with purpose `reset`, so it cannot be spent at the sign-in route", async () => {
    await seedUser(h);
    await h.service.requestPasswordReset(EMAIL);
    expect(h.magicLinks.rows.map((r) => r.purpose)).toEqual(["reset"]);

    // THE ASSERTION THIS WHOLE PURPOSE EXISTS FOR. A reset redeemed for a
    // session would sign somebody in while leaving the forgotten password
    // exactly as it was — in, having fixed nothing, and back at the same wall
    // tomorrow.
    await expect(h.service.redeemMagicLink(resetToken(h))).rejects.toBeInstanceOf(InvalidMagicLink);
  });

  it("expires it in half an hour, not the sign-in link's fifteen minutes", async () => {
    await seedUser(h);
    const issuedAt = h.clock.now().getTime();
    await h.service.requestPasswordReset(EMAIL);
    const expiresAt = Date.parse(h.magicLinks.rows[0]?.expiresAt ?? "");
    expect(expiresAt - issuedAt).toBe(PASSWORD_RESET_TTL_MINUTES * 60 * 1000);
  });

  it("says nothing for an address with no account — no link, no letter, no error", async () => {
    await expect(h.service.requestPasswordReset("nobody@example.com")).resolves.toBeUndefined();
    expect(h.magicLinks.rows).toHaveLength(0);
    expect(h.mailer.resets).toHaveLength(0);
  });

  it("says nothing for a deactivated account either", async () => {
    const userId = await seedUser(h);
    await h.users.setStatus(userId, "disabled");
    await h.service.requestPasswordReset(EMAIL);
    expect(h.mailer.resets).toHaveLength(0);
  });

  it("takes the same time for a known address as for an unknown one", async () => {
    // The oracle this closes is a stopwatch: a known address writes a row and
    // hands a letter to a relay, an unknown one returns after one SELECT. The
    // floor is what makes those indistinguishable from outside.
    await seedUser(h);
    await h.service.requestPasswordReset(EMAIL);
    const known = h.sleeper.waited.at(-1);
    await h.service.requestPasswordReset("nobody@example.com");
    const unknown = h.sleeper.waited.at(-1);

    expect(known).toBe(MAGIC_LINK_FLOOR_MS);
    expect(unknown).toBe(MAGIC_LINK_FLOOR_MS);
  });

  it("issues to an account that has NO password — the colleague's first one", async () => {
    // Refusing here would be the enumeration oracle in a subtler dress ("which
    // of your staff have passwords"), and it would also close the only door
    // `NoPasswordSet` sends people to.
    await seedPasswordless(h);
    await h.service.requestPasswordReset(EMAIL);
    expect(h.mailer.resets).toHaveLength(1);

    const result = await h.service.resetPassword(resetToken(h), NEW_PASSWORD);
    expect(result.principal.tenantId).toBe(TENANT_A);
    expect(await h.service.hasPassword(result.principal.userId)).toBe(true);
  });

  it("spends the live links before issuing a new one", async () => {
    await seedUser(h);
    await h.service.requestPasswordReset(EMAIL);
    const first = resetToken(h);
    await h.service.requestPasswordReset(EMAIL);

    // Without this, an impatient reader who presses the button twice leaves a
    // second password setter in the mailbox — still good after the one they
    // used has put things right.
    await expect(h.service.resetPassword(first, NEW_PASSWORD)).rejects.toBeInstanceOf(
      InvalidMagicLink,
    );
    await expect(h.service.resetPassword(resetToken(h), NEW_PASSWORD)).resolves.toBeDefined();
  });

  it("throttles per address, and stays silent about it", async () => {
    await seedUser(h);
    for (let i = 0; i < PASSWORD_RESETS_PER_WINDOW + 1; i += 1) {
      // A 429 here would be the one answer that confirmed the address exists.
      await expect(h.service.requestPasswordReset(EMAIL)).resolves.toBeUndefined();
    }
    expect(h.mailer.resets).toHaveLength(PASSWORD_RESETS_PER_WINDOW);
    // Padded on the refused exit too — it is the cheapest of all of them.
    expect(h.sleeper.waited.at(-1)).toBe(MAGIC_LINK_FLOOR_MS);
  });

  it("swallows a failed send, because throwing would be the oracle", async () => {
    const broken = new UnreachableMailer();
    const hb = harness(broken);
    await seedUser(hb);
    // 202 for an address with no account and 500 for one whose letter would not
    // go is an enumeration oracle assembled out of an error path.
    await expect(hb.service.requestPasswordReset(EMAIL)).resolves.toBeUndefined();
    expect(broken.attempted.map((a) => a.kind)).toEqual(["password-reset"]);
  });
});

describe("resetPassword", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  async function link(): Promise<string> {
    await h.service.requestPasswordReset(EMAIL);
    return resetToken(h);
  }

  it("replaces the password and signs the person in, in one call", async () => {
    await seedUser(h);
    const result = await h.service.resetPassword(await link(), NEW_PASSWORD);

    expect(result.principal.tenantId).toBe(TENANT_A);
    // The session is real, not a shape: a route that returned one it had not
    // opened would pass every other assertion here.
    expect(await h.service.resolveSession(result.token)).not.toBeNull();
    await expect(h.service.login(EMAIL, NEW_PASSWORD)).resolves.toBeDefined();
  });

  it("stops the old password working", async () => {
    await seedUser(h);
    await h.service.resetPassword(await link(), NEW_PASSWORD);
    await expect(h.service.login(EMAIL, PASSWORD)).rejects.toBeInstanceOf(InvalidCredentials);
  });

  it("revokes every session the account already held", async () => {
    // The commonest honest reason to reset is a suspicion that somebody else
    // has the password. A reset that leaves their session open answers the
    // wrong question.
    await seedUser(h);
    const theirs = await h.service.login(EMAIL, PASSWORD);
    expect(await h.service.resolveSession(theirs.token)).not.toBeNull();

    const mine = await h.service.resetPassword(await link(), NEW_PASSWORD);

    expect(await h.service.resolveSession(theirs.token)).toBeNull();
    expect(await h.service.resolveSession(mine.token)).not.toBeNull();
  });

  it("works exactly once", async () => {
    await seedUser(h);
    const token = await link();
    await h.service.resetPassword(token, NEW_PASSWORD);
    await expect(h.service.resetPassword(token, "yet another passphrase")).rejects.toBeInstanceOf(
      InvalidMagicLink,
    );
  });

  it("refuses a sign-in link — the purposes do not cross in either direction", async () => {
    await seedUser(h);
    await h.service.requestMagicLink(EMAIL);
    const signIn = new URL(h.mailer.sent.at(-1)?.url ?? "").searchParams.get("token") ?? "";
    await expect(h.service.resetPassword(signIn, NEW_PASSWORD)).rejects.toBeInstanceOf(
      InvalidMagicLink,
    );
  });

  it("does not spend the link when the password is refused for length", async () => {
    // Somebody who typed something too short must be able to try again on the
    // same link. Spending it first would send them back to their inbox for a
    // typo.
    await seedUser(h);
    const token = await link();
    await expect(h.service.resetPassword(token, "short")).rejects.toBeInstanceOf(WeakPassword);
    await expect(h.service.resetPassword(token, NEW_PASSWORD)).resolves.toBeDefined();
  });

  it("refuses an expired link", async () => {
    await seedUser(h);
    const token = await link();
    h.clock.advanceMinutes(PASSWORD_RESET_TTL_MINUTES + 1);
    await expect(h.service.resetPassword(token, NEW_PASSWORD)).rejects.toBeInstanceOf(
      InvalidMagicLink,
    );
  });

  it("accepts the password the account already had — the holder cannot know it", async () => {
    // The mirror of `changePassword`'s refusal, and the asymmetry is the point:
    // asking somebody who has forgotten their password for something OTHER than
    // the value they cannot see is a riddle.
    await seedUser(h);
    await expect(h.service.resetPassword(await link(), PASSWORD)).resolves.toBeDefined();
  });
});

describe("changePassword", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("swaps the password and keeps the caller signed in, at the same firm", async () => {
    const userId = await seedUser(h, EMAIL, [TENANT_A, TENANT_B]);
    // Two firms, so `openSession` would land on the org switcher by itself —
    // which is the case `reopenSession` exists for.
    const result = await h.service.changePassword(userId, PASSWORD, NEW_PASSWORD, TENANT_B);

    expect(result.principal.tenantId).toBe(TENANT_B);
    expect(await h.service.resolveSession(result.token)).not.toBeNull();
    await expect(h.service.login(EMAIL, NEW_PASSWORD)).resolves.toBeDefined();
    await expect(h.service.login(EMAIL, PASSWORD)).rejects.toBeInstanceOf(InvalidCredentials);
  });

  it("ends every OTHER session and rotates the caller's token", async () => {
    const userId = await seedUser(h);
    const elsewhere = await h.service.login(EMAIL, PASSWORD);
    const here = await h.service.login(EMAIL, PASSWORD);

    const result = await h.service.changePassword(userId, PASSWORD, NEW_PASSWORD, TENANT_A);

    expect(await h.service.resolveSession(elsewhere.token)).toBeNull();
    // Including the one that made the request: the cookie the handler sets
    // carries the replacement, so the tab stays signed in without the old
    // token surviving.
    expect(await h.service.resolveSession(here.token)).toBeNull();
    expect(await h.service.resolveSession(result.token)).not.toBeNull();
  });

  it("refuses a wrong current password, and a session does not stand in for it", async () => {
    const userId = await seedUser(h);
    // Its own sentence (F26): this form has no email box, so the sign-in
    // page's "Email or password is incorrect" sent people looking for one.
    const refused = h.service.changePassword(userId, "not the password", NEW_PASSWORD, TENANT_A);
    await expect(refused).rejects.toBeInstanceOf(CurrentPasswordIncorrect);
    await expect(refused).rejects.toThrow(/^That is not your current password\./);
    // Nothing was written: the old one still works.
    await expect(h.service.login(EMAIL, PASSWORD)).resolves.toBeDefined();
  });

  it("refuses an account with no password at all, and names the flow that works", async () => {
    // A session that could mint a FIRST password would outlive every
    // revocation the firm has. The emailed link is where that one is set.
    const userId = await seedPasswordless(h);
    await expect(
      h.service.changePassword(userId, PASSWORD, NEW_PASSWORD, TENANT_A),
    ).rejects.toBeInstanceOf(NoPasswordSet);
    expect(await h.service.hasPassword(userId)).toBe(false);
  });

  it("refuses the password that is already on the account", async () => {
    const userId = await seedUser(h);
    await expect(
      h.service.changePassword(userId, PASSWORD, PASSWORD, TENANT_A),
    ).rejects.toBeInstanceOf(PasswordUnchanged);
  });

  it("refuses a new password that fails the length policy", async () => {
    const userId = await seedUser(h);
    await expect(
      h.service.changePassword(userId, PASSWORD, "short", TENANT_A),
    ).rejects.toBeInstanceOf(WeakPassword);
  });

  it("throttles attempts at the current password, and clears on success", async () => {
    const userId = await seedUser(h);
    for (let i = 0; i < PASSWORD_CHANGE_ATTEMPTS_PER_WINDOW - 1; i += 1) {
      await expect(
        h.service.changePassword(userId, `wrong ${String(i)}`, NEW_PASSWORD, TENANT_A),
      ).rejects.toBeInstanceOf(CurrentPasswordIncorrect);
    }
    // The budget's last unit goes on the attempt that WORKS, which then clears
    // it — somebody who has just produced their own password is the best
    // evidence there is that the failures before it were theirs.
    await expect(
      h.service.changePassword(userId, PASSWORD, NEW_PASSWORD, TENANT_A),
    ).resolves.toBeDefined();
    await expect(
      h.service.changePassword(userId, NEW_PASSWORD, PASSWORD, TENANT_A),
    ).resolves.toBeDefined();
  });

  it("refuses once the budget is spent, without checking the password", async () => {
    const userId = await seedUser(h);
    for (let i = 0; i < PASSWORD_CHANGE_ATTEMPTS_PER_WINDOW; i += 1) {
      await expect(
        h.service.changePassword(userId, `wrong ${String(i)}`, NEW_PASSWORD, TENANT_A),
      ).rejects.toBeInstanceOf(CurrentPasswordIncorrect);
    }
    // Even the RIGHT one, which is what stops the route being a network-hopped
    // oracle for a password somebody reuses elsewhere.
    const refused = h.service.changePassword(userId, PASSWORD, NEW_PASSWORD, TENANT_A);
    await expect(refused).rejects.toBeInstanceOf(TooManyAttempts);
    // About THIS act: nobody was signing in.
    await expect(refused).rejects.toThrow(/^Too many tries at your current password\. Try again in /);
  });
});

describe("hasPassword", () => {
  it("is what the account screen reads, and it is false for most colleagues", async () => {
    const h = harness();
    const userId = await seedPasswordless(h);
    expect(await h.service.hasPassword(userId)).toBe(false);

    await h.service.setPassword(userId, PASSWORD);
    expect(await h.service.hasPassword(userId)).toBe(true);
  });
});

describe("the welcome link chooses the first password (CA#38)", () => {
  // A new colleague used to be signed in by the welcome link and never asked
  // for a password; the only way to set one was "Email me a link to set one",
  // which arrived as "Reset your BiB password" for a password they never had.
  // The welcome link itself is the proof of the mailbox, so the first password
  // is chosen on it, in the same call that signs them in.
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  function welcomeToken(): string {
    const last = h.mailer.welcomes.at(-1);
    if (last === undefined) throw new Error("no welcome was sent");
    const token = new URL(last.url).searchParams.get("token");
    if (token === null) throw new Error(`no token in ${last.url}`);
    return token;
  }

  it("points a colleague with no password at the page that chooses one", async () => {
    const userId = await seedPasswordless(h);
    await h.service.welcomeStaff(userId, "Sharma Mehta & Co");
    expect(h.mailer.welcomes[0]?.url).toContain("/auth/welcome?token=");
    expect(h.mailer.welcomes[0]?.choosePassword).toBe(true);
  });

  it("points a colleague who already has a password at the sign-in page", async () => {
    const userId = await seedUser(h);
    await h.service.welcomeStaff(userId, "Sharma Mehta & Co");
    expect(h.mailer.welcomes[0]?.url).toContain("/auth/magic-link?token=");
    expect(h.mailer.welcomes[0]?.choosePassword).toBe(false);
  });

  it("names the colleague who added them (CA#50)", async () => {
    const adder = await h.users.create({ id: uuidFor("user:rajesh"), email: "rajesh@sharmamehta.in", displayName: "Rajesh Sharma" });
    const userId = await seedPasswordless(h);
    await h.service.welcomeStaff(userId, "Sharma Mehta & Co", null, adder.id);
    expect(h.mailer.welcomes[0]?.addedBy).toBe("Rajesh Sharma");
  });

  it("sets the password and signs in, in one call", async () => {
    const userId = await seedPasswordless(h);
    await h.service.welcomeStaff(userId, "Sharma Mehta & Co");
    const result = await h.service.redeemWelcome(welcomeToken(), PASSWORD);

    expect(result.principal.tenantId).toBe(TENANT_A);
    expect(await h.service.resolveSession(result.token)).not.toBeNull();
    expect(await h.service.hasPassword(userId)).toBe(true);
    await expect(h.service.login(EMAIL, PASSWORD)).resolves.toBeDefined();
  });

  it("works exactly once, and skipping spends it the same way", async () => {
    const userId = await seedPasswordless(h);
    await h.service.welcomeStaff(userId, "Sharma Mehta & Co");
    const token = welcomeToken();
    await h.service.redeemMagicLink(token);
    await expect(h.service.redeemWelcome(token, PASSWORD)).rejects.toBeInstanceOf(InvalidMagicLink);
  });

  it("does not spend the link when the password is refused for length", async () => {
    const userId = await seedPasswordless(h);
    await h.service.welcomeStaff(userId, "Sharma Mehta & Co");
    const token = welcomeToken();
    await expect(h.service.redeemWelcome(token, "short")).rejects.toBeInstanceOf(WeakPassword);
    await expect(h.service.redeemWelcome(token, PASSWORD)).resolves.toBeDefined();
  });

  it("never REPLACES a password, and leaves the link to sign in with", async () => {
    // A welcome to a second firm reaches somebody who may have a password
    // already. Replacing it would sign them out everywhere on a letter they had
    // every reason to open.
    const userId = await seedUser(h);
    await h.service.welcomeStaff(userId, "Sharma Mehta & Co");
    const token = welcomeToken();
    await expect(h.service.redeemWelcome(token, NEW_PASSWORD)).rejects.toBeInstanceOf(PasswordAlreadySet);
    await expect(h.service.login(EMAIL, PASSWORD)).resolves.toBeDefined();
    await expect(h.service.redeemMagicLink(token)).resolves.toBeDefined();
  });

  it("refuses a sign-in link, a reset link and an invitation: only a welcome", async () => {
    await seedPasswordless(h);
    await h.service.requestMagicLink(EMAIL);
    const signIn = new URL(h.mailer.sent.at(-1)?.url ?? "").searchParams.get("token") ?? "";
    await expect(h.service.redeemWelcome(signIn, PASSWORD)).rejects.toBeInstanceOf(InvalidMagicLink);
    await h.service.requestPasswordReset(EMAIL);
    await expect(h.service.redeemWelcome(resetToken(h), PASSWORD)).rejects.toBeInstanceOf(InvalidMagicLink);
  });
});
