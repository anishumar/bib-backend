// The chaser (T4.4) — T4.5's escalation ladder aimed OUTWARD, and the one thing
// that stops it. Pure: stdlib only, no imports from anywhere internal.
//
// ── WHAT IT IS FOR, IN ONE SENTENCE ────────────────────────────────────────
//
// T6.6 built the row that says WE ARE WAITING ON YOU, and nothing sends a second
// one. At a real firm that gap IS the job: somebody opens a spreadsheet on
// Monday, works out who has not replied, and types the same sentence again.
//
// ── INWARD AND OUTWARD ARE THE SAME MECHANISM AND DIFFERENT FACTS ────────
//
// T4.5's ladder tells a colleague the firm's own work has gone quiet. This tells
// a CLIENT they have not answered. The shape is deliberately borrowed — rungs
// keyed by name, a threshold in days, the threshold copied onto the row when it
// fires, at-least-once, and NOTHING SET BY DEFAULT — and the tables are
// deliberately separate (0065 states why).
//
// ── NOTHING BY DEFAULT, AND THIS LADDER FEELS IT MORE THAN T4.5's ────────
//
// A firm that has published no `chaser` ladder chases nobody. That rule is
// sharper here than on the inward ladder: an escalation nobody asked for lands
// on a colleague, and a chase nobody asked for lands on the CLIENT, who reads it
// as the firm's opinion of them.
//
// ── AND NOTHING LEAVES THE BUILDING YET ─────────────────────────────────
//
// There is no transport (P10 is Phase 7), so a chase RAISES a reminder and the
// client's own action centre shows it. That is the board's own hard limit — *it
// never contacts anybody outside a channel the firm configured* — met by there
// being no channel at all rather than by a check somebody could remove.

/** One rung of the ladder, as the sweep reads it. Mirrors `ChaserRung` in the
 *  config registry, which is where a firm writes it. */
export interface ChaseRung {
  readonly key: string;
  readonly afterDays: number;
  readonly label: string;
}

/** An ask the sweep is considering. Everything it needs and nothing else — no
 *  prompt, because the sweep never renders one and the ledger may not carry it. */
export interface ChaseCandidate {
  readonly askId: string;
  readonly clientPartyId: string;
  readonly workItemId: string;
  /** How many days ago it was raised, in the CALLER's calendar. Computed by the
   *  database on the day the sweep was asked about, never from a `Date` built
   *  here — a `date` column read as a UTC instant names the day before west of
   *  Greenwich, which on a threshold of 3 is a whole rung early. */
  readonly daysOpen: number;
  /** Rungs already climbed on this ask, by key. At-least-once is enforced by a
   *  unique index; this is what stops the sweep trying. */
  readonly chasedRungs: readonly string[];
}

/** One reminder to write. */
export interface ChaseToSend {
  readonly askId: string;
  readonly clientPartyId: string;
  readonly workItemId: string;
  readonly rungKey: string;
  readonly afterDays: number;
  readonly daysOpen: number;
}

/** What one tenant's sweep did. `frozen` is the number nobody would think to log
 *  and the one somebody has to be able to explain: clients deliberately not
 *  chased, which is the difference between a quiet week and a broken sweep. */
export interface ChaseSweepReport {
  readonly tenantId: string;
  readonly sent: number;
  readonly alreadySent: number;
  readonly frozen: number;
  readonly failure?: string;
}

// ── Pure rules ───────────────────────────────────────────────────────────────

/**
 * Which rungs are DUE on one ask, given the ladder.
 *
 * EVERY due rung, not only the next one — the dunning sweep's rule and the
 * escalation sweep's after it. A week of downtime must not need seven sweeps to
 * catch up, because the run that finally happens is the one a partner is looking
 * at.
 *
 * A rung already climbed is skipped rather than re-sent. The unique index makes
 * a duplicate unwritable anyway; this is what keeps the LEDGER honest, because
 * the event is written only when a row was actually created.
 */
export function dueRungs(
  candidate: ChaseCandidate,
  ladder: readonly ChaseRung[],
): readonly ChaseToSend[] {
  const already = new Set(candidate.chasedRungs);
  return ladder
    .filter((rung) => candidate.daysOpen >= rung.afterDays && !already.has(rung.key))
    .map((rung) => ({
      askId: candidate.askId,
      clientPartyId: candidate.clientPartyId,
      workItemId: candidate.workItemId,
      rungKey: rung.key,
      afterDays: rung.afterDays,
      daysOpen: candidate.daysOpen,
    }));
}

/**
 * Whether this client may be chased at all today.
 *
 * ── THE ACCEPTANCE LINE'S OTHER HALF, AND IT DID NOT EXIST ──────────────
 *
 * *"stops on escalation freeze"* — and nothing in this product had a freeze:
 * not a table, not a column, not a config kind. 0065 built it, on the CLIENT and
 * effective-dated, because the board's own sentence is about a client in a
 * dispute rather than about one task.
 *
 * IT IS CHECKED HERE AND ALSO IN THE QUERY'S SCOPE, and neither is redundant:
 * the repository asks the database which clients are frozen TODAY in the same
 * transaction as the candidates, and this function is what the sweep branches
 * on. A freeze that only existed as a SQL predicate could not be counted, and
 * `frozen` in the report is the number that explains a quiet week.
 */
export function mayChase(clientPartyId: string, frozenClients: ReadonlySet<string>): boolean {
  return !frozenClients.has(clientPartyId);
}

/**
 * Half-open, `[validFrom, validTo)` — `validTo` is the FIRST DAY NOT IN FORCE.
 *
 * The same convention as `crm.portal_access`, `crm.client_assignment`,
 * `core.party_relationship` and `core.party_identifier`. Two date conventions in
 * one schema is an off-by-one waiting for a handover, and on this one the
 * off-by-one is a client being chased on the day a partner froze them.
 */
export function freezeInForceOn(
  validFrom: string,
  validTo: string | null,
  day: string,
): boolean {
  if (day < validFrom) return false;
  return validTo === null || day < validTo;
}
