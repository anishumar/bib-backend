// The seams the chaser needs. Interfaces owned by this use case, stated in its
// vocabulary; the Postgres adapter implements them.
//
// ── EVERY PORT HERE IS A READ EXCEPT THE CHASE ITSELF ────────────────────
//
// T4.5's service is careful to say that it *never acts* and that this is
// enforced by what does not exist rather than by a check. The same applies here
// and matters more, because the output of this sweep is aimed at a CLIENT: there
// is no seam through which it could close an ask, move a task, or send anything
// anywhere. The one write is the row saying a reminder was raised.
import type { ChaseCandidate, ChaseRung, ChaseToSend } from "../../domain/chaser/model";

/** YYYY-MM-DD. Never a `Date`: a `date` column read as a UTC instant names the
 *  day before west of Greenwich, which on a three-day rung is a whole rung. */
export type IsoDate = string;

/** Every firm, for the outer loop. A worker holds no session, so the tenant list
 *  is the only thing above RLS in this module. */
export interface ChaserTenantDirectory {
  activeTenantIds(): Promise<readonly string[]>;
}

/**
 * The firm's own published ladder, or NOTHING.
 *
 * Null and an empty ladder are the same answer here and both mean "chase
 * nobody", which is the shipped state: a firm that has published no `chaser`
 * entry has never agreed to a cadence, and one this product invented lands on
 * the client.
 */
export interface ChaserLadderSource {
  ladderFor(tenantId: string): Promise<readonly ChaseRung[]>;
}

/**
 * The open asks and the clients that must not be chased, read TOGETHER.
 *
 * One method and one transaction, because the two answers have to be about the
 * same instant: a freeze set while the sweep is running must either stop this
 * pass or not, never stop half of it. It is also why `frozenClients` is a
 * separate field rather than a filter already applied — the report counts them,
 * and a number that only ever existed as a SQL predicate cannot be logged.
 */
export interface ChaseCandidateSource {
  openAsks(
    tenantId: string,
    asOf: IsoDate,
    /** The firm's zone, so "how many days has this been open" is counted on the
     *  firm's own calendar rather than the database server's. */
    timeZone: string,
  ): Promise<{
    readonly candidates: readonly ChaseCandidate[];
    readonly frozenClients: readonly string[];
  }>;
}

/**
 * The one write.
 *
 * Returns the rows it actually created. AT-LEAST-ONCE: pg-boss redelivers, a
 * worker restarts mid-pass, and the ask is still open tomorrow — so the insert
 * conflicts on `client_ask_chase_once` and the caller learns which rungs were
 * genuinely new. The ledger event is written only for those, which is what keeps
 * *"we reminded you four times"* a true sentence.
 */
export interface ChaseRepository {
  record(
    tenantId: string,
    chases: readonly ChaseToSend[],
  ): Promise<readonly ChaseToSend[]>;
}

/** What one freeze looks like when the firm reads it back. Names, not ids — the
 *  rule this codebase has learnt six times. */
export interface ClientFreezeRecord {
  readonly id: string;
  readonly clientPartyId: string;
  readonly clientName: string;
  readonly validFrom: IsoDate;
  /** The FIRST DAY NOT IN FORCE. Null while it is still on. */
  readonly validTo: IsoDate | null;
  readonly reason: string;
  readonly setByName: string | null;
  readonly liftedByName: string | null;
  readonly createdAt: string;
}

export interface NewFreeze {
  readonly id: string;
  readonly tenantId: string;
  readonly clientPartyId: string;
  readonly validFrom: IsoDate;
  readonly validTo: IsoDate | null;
  readonly reason: string;
  readonly setBy: string;
}

/** The firm's write surface for a freeze. */
export interface ClientFreezeRepository {
  /** Null when there is no such client at this firm — the one refusal this
   *  write can make that is not the exclusion constraint's. */
  set(freeze: NewFreeze): Promise<ClientFreezeRecord | null>;

  /** Every freeze this client has ever had, newest first. The whole history,
   *  because "was this client being chased in March" is the question, and a
   *  list of only the current one answers it with silence. */
  listForClient(tenantId: string, clientPartyId: string): Promise<readonly ClientFreezeRecord[]>;

  findById(tenantId: string, freezeId: string): Promise<ClientFreezeRecord | null>;

  /** Close it, on the given day. Null when it was already lifted — the WHERE
   *  carries `valid_to IS NULL`, so a double-click writes nothing rather than
   *  moving the day chasing resumed. */
  lift(input: {
    readonly tenantId: string;
    readonly freezeId: string;
    readonly on: IsoDate;
    readonly liftedBy: string;
  }): Promise<ClientFreezeRecord | null>;
}

/**
 * The firm's own timezone — which calendar DAY or MONTH an instant belongs to.
 *
 * Declared here as well as in `usecase/portallibrary/ports.ts`, because ports
 * live beside the use case that needs them; ONE adapter satisfies both, which
 * is what stops the chaser counting days in one zone while the digest cuts
 * months in another.
 *
 * NOT how an instant is rendered — that is the reader's own zone (T6.9), and
 * the two rules point in opposite directions.
 */
export interface FirmTimeZone {
  timeZoneFor(tenantId: string): Promise<string>;
}
