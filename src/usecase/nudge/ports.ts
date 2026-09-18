// The seams the proactive nudge needs. Interfaces owned by this use case,
// stated in its vocabulary; the Postgres adapters implement them.
//
// ── EVERY PORT HERE IS A READ EXCEPT THE NUDGE ITSELF ────────────────────
//
// T4.5's service says it *never acts* and that this is enforced by what does not
// exist rather than by a check; T4.4's says the same and adds that it matters
// more when the output is aimed at a client. Both apply here and there is a
// third reason: this sweep runs over the COMPLIANCE CALENDAR, and a seam through
// which it could touch an obligation would be a machine moving a statutory
// filing at 2am. There is no such seam. The one write is the row saying a client
// was told.
//
// ── AND THERE IS DELIBERATELY NO FREEZE PORT ─────────────────────────────
//
// `ChaseCandidateSource` returns `frozenClients` beside its candidates. This one
// has no equivalent and that is the decision, not an oversight: `crm.client_freeze`
// stops the chaser and does not reach this ladder (0067 states both halves of
// why — the date is the law's, and a freeze is keyed on `client_party_id` while
// an obligation carries `entity_party_id`). A port that took freezes and ignored
// them would be worse than none.
import type { NudgeCandidate, NudgeRung, NudgeToSend } from "../../domain/nudge/model";

/** YYYY-MM-DD. Never a `Date`, for the reason `NudgeCandidate.daysUntil`
 *  gives. */
export type IsoDate = string;

/** Every firm, for the outer loop. A worker holds no session, so the tenant list
 *  is the only thing above RLS in this module. */
export interface NudgeTenantDirectory {
  activeTenantIds(): Promise<readonly string[]>;
}

/**
 * The firm's own published ladder, or NOTHING.
 *
 * Null and an empty ladder are the same answer and both mean "nudge nobody",
 * which is the shipped state. Third time this product states that rule
 * (dunning, escalation, chaser) and it does not get weaker for being ordinary: a
 * reminder cadence this product invented is one the firm never agreed to, and
 * the person who feels it is the client.
 */
export interface NudgeLadderSource {
  ladderFor(tenantId: string): Promise<readonly NudgeRung[]>;
}

/**
 * The filings coming up, with the rungs already told about each.
 *
 * `horizonDays` comes from the LADDER and is passed in rather than assumed here,
 * so a firm that adds a 30-day rung gets rows for it. A hard-coded window would
 * produce a rung that is due and a query that never offers the row — a silent
 * nothing, which is the worst failure this sweep can have.
 */
export interface NudgeCandidateSource {
  upcomingFilings(
    tenantId: string,
    asOf: IsoDate,
    horizonDays: number,
  ): Promise<readonly NudgeCandidate[]>;
}

/**
 * The one write.
 *
 * Returns the rows it actually created. AT-LEAST-ONCE: pg-boss redelivers, a
 * worker restarts mid-pass, and the filing is still due tomorrow — so the insert
 * conflicts on `obligation_nudge_once` and the caller learns which rungs were
 * genuinely new. The ledger event is written only for those.
 */
export interface NudgeRepository {
  record(tenantId: string, nudges: readonly NudgeToSend[]): Promise<readonly NudgeToSend[]>;
}

/**
 * Which calendar this firm's days are cut on (0071).
 *
 * A sweep has no caller to send its day, and the server's UTC day is
 * yesterday in India until 05:30 — a T-X task raised five and a half hours
 * late, a rung fired a day late. "Today" for a firm's own sweep is the day in
 * the firm's zone, the same answer the per-period spawn and the chaser give.
 * Structural: satisfied by `PostgresFirmTimeZone` and `FakeFirmTimeZone`.
 */
export interface FirmTimeZone {
  timeZoneFor(tenantId: string): Promise<string>;
}
