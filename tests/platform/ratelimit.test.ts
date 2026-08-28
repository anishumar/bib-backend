// The limiter's own behaviour. Every assertion here is about a property the
// login path depends on, so a change that quietly weakens one shows up as a
// failing name rather than as a slow leak.
import { FakeClock } from "../../src/testfakes/clock";
import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter } from "../../src/platform/ratelimit";

function limiter(clock = new FakeClock()): { rl: InMemoryRateLimiter; clock: FakeClock } {
  return { rl: new InMemoryRateLimiter(clock), clock };
}

describe("InMemoryRateLimiter", () => {
  it("allows up to the limit and refuses the next", async () => {
    const { rl } = limiter();
    for (let i = 0; i < 3; i += 1) {
      expect((await rl.check("k", 3, 60)).allowed).toBe(true);
    }
    expect((await rl.check("k", 3, 60)).allowed).toBe(false);
  });

  it("counts keys separately", async () => {
    const { rl } = limiter();
    await rl.check("a", 1, 60);
    expect((await rl.check("a", 1, 60)).allowed).toBe(false);
    expect((await rl.check("b", 1, 60)).allowed).toBe(true);
  });

  it("slides — the window follows the attempts, it does not reset on the hour", async () => {
    // A fixed window lets an attacker spend the whole allowance at 0:59 and
    // again at 1:01, which is double the intended rate at the worst moment.
    const { rl, clock } = limiter();
    await rl.check("k", 2, 60); // t=0
    clock.advanceMinutes(0.5); // t=30s
    await rl.check("k", 2, 60);
    expect((await rl.check("k", 2, 60)).allowed).toBe(false);

    clock.advanceMinutes(0.6); // t=66s — the first attempt has aged out, the second has not
    expect((await rl.check("k", 2, 60)).allowed).toBe(true);
    expect((await rl.check("k", 2, 60)).allowed).toBe(false);
  });

  it("says how long to wait, and the wait is real", async () => {
    const { rl, clock } = limiter();
    await rl.check("k", 1, 60);
    const denied = await rl.check("k", 1, 60);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);

    clock.advanceMinutes(denied.retryAfterSeconds / 60);
    expect((await rl.check("k", 1, 60)).allowed).toBe(true);
  });

  it("does not let a blocked client wait out the window by retrying", async () => {
    // Being refused must not extend the window, or a client that keeps trying
    // is punished more than one that waits — and worse, a client that keeps
    // trying could never recover.
    const { rl, clock } = limiter();
    await rl.check("k", 1, 60);
    for (let i = 0; i < 5; i += 1) {
      clock.advanceMinutes(0.1);
      expect((await rl.check("k", 1, 60)).allowed).toBe(false);
    }
    clock.advanceMinutes(1);
    expect((await rl.check("k", 1, 60)).allowed).toBe(true);
  });

  it("forgets a key on reset", async () => {
    const { rl } = limiter();
    await rl.check("k", 1, 60);
    expect((await rl.check("k", 1, 60)).allowed).toBe(false);
    await rl.reset("k");
    expect((await rl.check("k", 1, 60)).allowed).toBe(true);
  });

  it("caps how many keys it tracks — a limiter must not be exhaustible", async () => {
    // Keyed on client address, this map is filled by exactly the traffic it
    // exists to limit. Unbounded, it is a memory DoS of its own.
    const rl = new InMemoryRateLimiter(new FakeClock(), 100);
    for (let i = 0; i < 500; i += 1) {
      await rl.check(`client-${String(i)}`, 5, 60);
    }
    expect(rl.size()).toBeLessThanOrEqual(100);
  });

  it("does not evict a client that is actively being limited", async () => {
    // Eviction forgives attempts, so evicting under pressure would hand the
    // attacker a reset. The client being refused stays tracked.
    const rl = new InMemoryRateLimiter(new FakeClock(), 10);
    await rl.check("attacker", 1, 60);
    expect((await rl.check("attacker", 1, 60)).allowed).toBe(false);

    for (let i = 0; i < 50; i += 1) await rl.check(`other-${String(i)}`, 5, 60);

    expect((await rl.check("attacker", 1, 60)).allowed).toBe(false);
  });
});
