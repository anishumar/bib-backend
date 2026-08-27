// Rate limiting as a port, with an in-process implementation.
//
// It is a platform primitive like Clock and IdGen because both edges need it:
// the HTTP layer limits by client address, and the identity use case limits by
// ACCOUNT. Those defend different things and neither substitutes for the other
// — an attacker with a botnet defeats per-IP limits, and an attacker hammering
// one address from one machine defeats per-account limits.
//
// The interface is async so a Redis adapter drops in unchanged. That matters
// sooner than it looks: see the honest limitation on InMemoryRateLimiter.
import type { Clock } from "./clock";

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** How long the caller should wait. Zero when allowed. */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  /**
   * Count one attempt against `key` and say whether it may proceed.
   *
   * Counting happens on the CHECK, not on the failure, so a caller cannot
   * dodge the limit by succeeding — and the login path in particular must not
   * only count failures, or an attacker learns which guesses were right from
   * whether the counter moved.
   */
  check(key: string, limit: number, windowSeconds: number): Promise<RateLimitDecision>;
  /** Forget a key. Used after a successful login, so one person fat-fingering
   *  their password three times is not then locked out by their own success. */
  reset(key: string): Promise<void>;
}

/**
 * A sliding-window limiter held in this process's memory.
 *
 * HONEST LIMITATION: the state is per-process. Behind N pods the effective
 * limit is N times what is configured, because each pod counts separately.
 * That is a real weakening and it is acceptable at one pod, which is where this
 * service is today. The moment there are several, this is replaced by a Redis
 * adapter behind the same interface — that is the whole reason it is a port.
 *
 * Sliding window rather than fixed: a fixed window lets an attacker send the
 * full allowance at 0:59 and again at 1:01, which is twice the intended rate at
 * exactly the moment it matters.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, Entry>();

  /**
   * A cap on tracked keys, because a limiter keyed on client address is itself
   * an unbounded map that an attacker fills — a rate limiter that can be
   * exhausted by the traffic it is meant to limit is not one.
   */
  constructor(
    private readonly clock: Clock,
    private readonly maxKeys = 50_000,
  ) {}

  check(key: string, limit: number, windowSeconds: number): Promise<RateLimitDecision> {
    const now = this.clock.now().getTime();
    const cutoff = now - windowSeconds * 1000;
    const recent = (this.hits.get(key)?.at ?? []).filter((t) => t > cutoff);

    if (recent.length >= limit) {
      // Refusing must not extend the window. The attempt is NOT recorded, so a
      // client that keeps retrying recovers at the same moment as one that
      // waits — otherwise a blocked client could never get back in.
      const oldest = recent[0] ?? now;
      const blockedUntil = oldest + windowSeconds * 1000;
      this.hits.set(key, { at: recent, windowSeconds, blockedUntil });
      const retryAfterSeconds = Math.max(1, Math.ceil((blockedUntil - now) / 1000));
      return Promise.resolve({ allowed: false, retryAfterSeconds });
    }

    recent.push(now);
    this.hits.set(key, { at: recent, windowSeconds, blockedUntil: 0 });
    this.evictIfNeeded(now);
    return Promise.resolve({ allowed: true, retryAfterSeconds: 0 });
  }

  reset(key: string): Promise<void> {
    this.hits.delete(key);
    return Promise.resolve();
  }

  /**
   * Eviction, in three passes, and the ORDER is the security property.
   *
   * Dropping a key FORGIVES its attempts. So a naive least-recently-used policy
   * hands an attacker the bypass: flood the limiter with junk keys until your
   * own blocked entry is evicted, then start over with a full budget. A test
   * found exactly that in the first version of this file, and the fix after it
   * (evict fewest-hits first) was still wrong — a blocked attacker ties with
   * every quiet client at one hit, and lost the tie by being oldest.
   *
   * What actually distinguishes them is whether the key is being held back
   * RIGHT NOW, so that is what is stored and what eviction respects:
   *
   *   1. dead entries      — every attempt already outside its own window;
   *                          nothing to forgive, free to drop.
   *   2. live, not blocked — a client with budget left. Forgiving it changes
   *                          nothing an attacker can use. Fewest hits first.
   *   3. blocked entries   — only if the first two passes did not free enough,
   *                          and then the ones closest to expiring anyway.
   *
   * Reaching pass 3 is the one bypass that remains, and it is expensive: an
   * attacker must fill every one of maxKeys slots with OTHER blocked clients,
   * each of which costs a full budget of attempts, spent through a limiter that
   * is throttling them the whole time.
   */
  private evictIfNeeded(now: number): void {
    if (this.hits.size <= this.maxKeys) return;

    for (const [key, entry] of this.hits) {
      const alive = entry.at.some((t) => t > now - entry.windowSeconds * 1000);
      if (!alive) this.hits.delete(key);
    }
    if (this.hits.size <= this.maxKeys) return;

    const live = [...this.hits.entries()];
    const unblocked = live
      .filter(([, e]) => e.blockedUntil <= now)
      .sort((a, b) => a[1].at.length - b[1].at.length);
    const blocked = live
      .filter(([, e]) => e.blockedUntil > now)
      .sort((a, b) => a[1].blockedUntil - b[1].blockedUntil);

    for (const [key] of [...unblocked, ...blocked]) {
      if (this.hits.size <= this.maxKeys) return;
      this.hits.delete(key);
    }
  }

  /** Tracked key count — for tests and a future metric. */
  size(): number {
    return this.hits.size;
  }
}

interface Entry {
  /** Attempt timestamps, oldest first. */
  readonly at: number[];
  /** Kept per key so eviction can tell a dead entry from a live one without
   *  knowing which limit the next caller will ask for. */
  readonly windowSeconds: number;
  /** When this key stops being refused; 0 if it is not currently blocked. The
   *  signal eviction uses to avoid forgiving the client it is holding back. */
  readonly blockedUntil: number;
}
