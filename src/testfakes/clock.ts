// The clock every module's fakes share.
//
// It lives in its own file for the same reason `ids.ts` does: it belongs to no
// single module. It started in `testfakes/identity.ts` because sessions were the
// first thing defined by time, and by the time the scheduler needed one there
// were two — same name, same job, subtly different API, and a test importing the
// wrong one would have compiled.
import type { Clock } from "../platform/clock";

/** A clock a test drives. Starts at a fixed instant so nothing is flaky. */
export class FakeClock implements Clock {
  constructor(private current = new Date("2026-01-01T09:00:00Z")) {}
  now(): Date {
    return this.current;
  }
  /** Jump to an exact instant. What a scheduler test wants: the question is
   *  usually "what happens ON the due date", not "what happens 43 days later". */
  set(instant: string | Date): void {
    this.current = instant instanceof Date ? instant : new Date(instant);
  }
  advanceMinutes(minutes: number): void {
    this.current = new Date(this.current.getTime() + minutes * 60 * 1000);
  }
  advanceDays(days: number): void {
    this.advanceMinutes(days * 24 * 60);
  }
}
