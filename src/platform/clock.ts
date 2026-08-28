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
