// An in-memory ReadinessFactSource: whatever facts a test sets, read back.
// The joins are the adapter's; `tests/readiness/readiness.integration.test.ts`
// proves those against a real database.
import type { ReadinessFacts } from "../domain/readiness/model";
import type { ReadinessFactSource } from "../usecase/readiness/ports";

/** A firm that has set up nothing: the shape a new tenant starts in. */
export function emptyFacts(): Omit<ReadinessFacts, "day"> {
  return {
    // A new firm: itself as its only company, unregistered; the founding
    // partner alone; UTC, the zone nobody chose; no terms.
    companies: [{ partyId: "00000000-0000-4000-8000-00000000f00d", name: "New firm", country: null, hasAddress: false }],
    timeZone: "UTC",
    activeStaff: 1,
    publishedTerms: 0,
    clientCompanies: [],
    activeClients: [],
    reportingLinePolicies: [],
    staffWithoutManager: [],
    ladders: { escalation: false, chaser: false, nudge: false },
    missedFromOn: null,
    fiscalYearStartMonth: null,
    generatingRules: 0,
    linkedUnconfirmedRules: [],
    services: [],
    requestRouting: "none",
  };
}

export class FakeReadinessFacts implements ReadinessFactSource {
  facts: Omit<ReadinessFacts, "day"> = emptyFacts();
  /** The day each read was asked on, so a test can see the firm's day used. */
  readonly askedOn: string[] = [];

  factsFor(_tenantId: string, day: string): Promise<Omit<ReadinessFacts, "day">> {
    this.askedOn.push(day);
    return Promise.resolve(this.facts);
  }
}
