// Time as a port. `now()` is I/O in every sense that matters: it is
// non-deterministic, it changes between two lines of code, and a test that
// cannot control it must either sleep or assert nothing.
//
// Sessions and magic links are defined entirely by time — issued, expires,
// consumed — so the use case takes the clock as a dependency and a test can
// advance it a fortnight in a microsecond.
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/**
 * Waiting, as a port — for the same reason `now()` is one.
 *
 * There is exactly one thing in this product that deliberately spends time:
 * the constant-time floor on the sign-in-link route, which exists so that the
 * DURATION of a response stops telling an anonymous caller whether an address
 * has an account. A real `setTimeout` in a unit test would make the suite pay
 * that floor on every case, so the wait is injected and the fake returns at
 * once — the floor's arithmetic is still exercised, only the sleeping is not.
 */
export interface Sleeper {
  sleep(ms: number): Promise<void>;
}

export const systemSleeper: Sleeper = {
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/** For tests: records what would have been waited for, and waits for none of
 *  it. A test that wants to assert the floor exists reads `waited`. */
export class InstantSleeper implements Sleeper {
  readonly waited: number[] = [];
  sleep(ms: number): Promise<void> {
    this.waited.push(ms);
    return Promise.resolve();
  }
}
