// The seams setup readiness (V2.6) needs, owned by this use case.
import type { ReadinessFacts } from "../../domain/readiness/model";

/**
 * Everything the eight lines are computed from, read for one firm on one day.
 *
 * ONE port with one method, deliberately: the facts cross eight tables in six
 * modules, and asking each module's own port would be eight round trips and
 * eight places a "what counts as an active client" could drift apart. The
 * adapter reads them in one transaction, so every line describes the same
 * moment.
 */
export interface ReadinessFactSource {
  /** `day` is the FIRM's calendar day: which assignments and portal grants
   *  are in force is read on it. */
  factsFor(tenantId: string, day: string): Promise<Omit<ReadinessFacts, "day">>;
}

/** The firm's timezone, so "today" is the firm's day (T6.14). */
export interface FirmTimeZone {
  timeZoneFor(tenantId: string): Promise<string>;
}
