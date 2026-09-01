// The proactive nudge (T6.7) — the ladder that counts DOWN to a date the law
// set. Pure: stdlib only, no imports from anywhere internal.
//
// ── IT IS NOT THE CHASER, AND THE DIFFERENCE IS NOT THE SIGN ──────────────
//
// T4.4 built the outward ladder and stopped at half its board line, deliberately
// and with the reason written down: *"a filing approaching its statutory date
// asks the client for NOTHING until the firm raises an ask about it"*. That
// sentence is the whole specification of this file.
//
//   a CHASE  is about an open `client_ask`. The firm wants something back, the
//            count of reminders is evidence when a filing goes late, and a
//            client already in a dispute must not be chased at all.
//   a NUDGE  is about an `obligation_instance`. It wants nothing back, it names
//            a date the LAW set, and it goes out whether or not the firm and
//            the client are arguing about a fee.
//
// Same mechanism — rungs keyed by name, a threshold in days, the threshold
// copied onto the row when it fires, at-least-once, nothing set by default — and
// deliberately different tables, a different config kind, and a ladder that runs
// the other way. Migration 0067 carries the rest of the argument.
//
// ── THE ONE DATE THIS PRODUCT LETS OUT OF THE BUILDING ────────────────────
//
// The portal's standing rule is that NO DUE DATE THIS PRODUCT INVENTED reaches a
// client: `internal_target_on` never leaves, and a work item answers with the
// day it opened rather than a turnaround time nobody promised. A statutory date
// is the exception and always has been (T6.5) — it is the LAW's, the client is
// already subject to it, and they can read it on the government's own portal.
// This ladder exists because "you could have looked it up" is not what a firm
// says to a client who missed a return.
//
// ── AND NOTHING LEAVES THE BUILDING YET ──────────────────────────────────
//
// There is no transport (P10 is Phase 7), so a nudge is RAISED and the client's
// own filings list shows it. Same limit the chaser met the same way: by there
// being no channel at all rather than by a check somebody could remove.

/** One rung of the ladder, as the sweep reads it. Mirrors `NudgeRung` in the
 *  config registry, which is where a firm writes it. */
export interface NudgeRung {
  readonly key: string;
  /** Days BEFORE the statutory date. */
  readonly beforeDays: number;
  readonly label: string;
}

/** A filing the sweep is considering. Everything it needs and nothing else — no
 *  template name, because the sweep never renders one and the ledger may not
 *  carry a client's business in its payload. */
export interface NudgeCandidate {
  readonly obligationId: string;
  readonly entityPartyId: string;
  /** YYYY-MM-DD, the statutory date. */
  readonly dueOn: string;
  /**
   * How many days are left, in the CALLER's calendar, computed by the DATABASE
   * on the day the sweep was asked about.
   *
   * Never from a `Date` built here: a `date` column read as a UTC instant names
   * the day before west of Greenwich, and on a one-day rung that is the whole
   * rung. This is the arithmetic that cost T6.5 a 500 on its first real request
   * and T4.4 a paragraph in its own notes.
   */
  readonly daysUntil: number;
  /** Rungs already told, by key. At-least-once is enforced by a unique index;
   *  this is what stops the sweep trying. */
  readonly nudgedRungs: readonly string[];
}

/** One nudge to write. */
export interface NudgeToSend {
  readonly obligationId: string;
  readonly entityPartyId: string;
  readonly rungKey: string;
  readonly beforeDays: number;
  readonly daysUntil: number;
  readonly dueOn: string;
}

/** What one tenant's sweep did. No `frozen` here and that is not an omission:
 *  a freeze stops the CHASER and does not reach this ladder (0067). */
export interface NudgeSweepReport {
  readonly tenantId: string;
  readonly sent: number;
  readonly alreadySent: number;
  readonly failure?: string;
}

// ── Pure rules ───────────────────────────────────────────────────────────────

/**
 * Which rungs are DUE on one filing, given the ladder.
 *
 * ── EVERY DUE RUNG, AND HERE THAT IS LOUDER THAN ELSEWHERE ──────────────
 *
 * The dunning sweep's rule, the escalation sweep's, and the chaser's: a week of
 * downtime must not need seven sweeps to catch up. On THIS ladder it means a
 * firm whose worker was down from T–8 to T–2 sends the 7-day, the 3-day and the
 * 1-day rung in one pass, and that is right — the client is told, once, about
 * every stage they missed hearing about, rather than being told nothing because
 * the machine was asleep when each moment passed.
 *
 * `daysUntil <= beforeDays` is the test, and it is `<=` rather than `===` for
 * exactly that reason. `===` would make a missed sweep a permanently missed
 * rung, silently.
 */
export function dueRungs(
  candidate: NudgeCandidate,
  ladder: readonly NudgeRung[],
): readonly NudgeToSend[] {
  const already = new Set(candidate.nudgedRungs);
  return ladder
    .filter((rung) => candidate.daysUntil <= rung.beforeDays && !already.has(rung.key))
    .map((rung) => ({
      obligationId: candidate.obligationId,
      entityPartyId: candidate.entityPartyId,
      rungKey: rung.key,
      beforeDays: rung.beforeDays,
      daysUntil: candidate.daysUntil,
      dueOn: candidate.dueOn,
    }));
}

/**
 * The furthest-out rung on a ladder — how far ahead the sweep has to look.
 *
 * The candidate query needs a window, and taking it from the LADDER rather than
 * hard-coding one is what keeps the two from disagreeing: a firm that adds a
 * 30-day rung would otherwise get a rung that is due and a query that never
 * offers it the row, which is a silent nothing rather than an error.
 *
 * Zero on an empty ladder, and the sweep returns before the query in that case
 * anyway — a firm that has published no ladder nudges nobody.
 */
export function horizonDays(ladder: readonly NudgeRung[]): number {
  return ladder.reduce((widest, rung) => (rung.beforeDays > widest ? rung.beforeDays : widest), 0);
}
