// The ports this use case needs from the world — the seams. Interfaces are
// owned by the use case that needs them (never a shared top-level ports
// package), stated in our vocabulary. Adapters in infrastructure/ implement
// them.
import type { Actor } from "../../domain/ledger/model";
import type {
  AssignmentRole,
  ClientAssignment,
  ClientAssignmentRecord,
  OwnedClient,
} from "../../domain/clientassignment/model";

export interface NewClientAssignment {
  readonly id: string;
  readonly tenantId: string;
  readonly clientPartyId: string;
  readonly role: AssignmentRole;
  /** Null for a key manager; a `tenancy.service_axis` id for a SPOC. Validated
   *  by the service; the adapter stores it as given. */
  readonly axisId: string | null;
  readonly userId: string;
  readonly validFrom: string;
}

/**
 * The outgoing row a handover closes, and the day it stops being in force.
 *
 * Half-open, so this date is the incoming row's `validFrom` — the two periods
 * are contiguous with no gap and no overlap.
 */
export interface HandoverClose {
  readonly assignmentId: string;
  readonly validTo: string;
}

export interface ClientAssignmentRepository {
  /**
   * EVERY assignment this client has ever had, live and historic, with the
   * holder and the axis resolved.
   *
   * Not filtered by date, deliberately. "Who was the SPOC in March" is a filter
   * over rows already in hand (`accountTeamOn`), and a screen with a date box
   * would otherwise round-trip on every keystroke. A client accumulates a
   * handful of these over its whole life, so there is nothing to page.
   */
  listForClient(
    tenantId: string,
    clientPartyId: string,
  ): Promise<readonly ClientAssignmentRecord[]>;

  findById(tenantId: string, assignmentId: string): Promise<ClientAssignment | null>;

  /**
   * The assignments for one client and one role that are NOT already over by
   * `onDate` — in force on it, or starting after it and still open.
   *
   * The date is passed rather than read from the database's `CURRENT_DATE`, and
   * that is not a detail. A server in UTC and a firm in India disagree about
   * what day it is for five and a half hours every morning, so a SQL
   * `CURRENT_DATE` would let a duplicate past the service's check and leave the
   * exclusion constraint to refuse it as an unexplained 500. One notion of the
   * day, chosen by the caller, all the way through.
   *
   * Newest first, which is what makes `open[0]` the incumbent.
   */
  listOpenForClient(
    tenantId: string,
    clientPartyId: string,
    role: AssignmentRole,
    onDate: string,
  ): Promise<readonly ClientAssignment[]>;

  /**
   * Record an assignment — and, when this is a handover, close the outgoing row
   * IN THE SAME TRANSACTION.
   *
   * The two halves cannot be two calls, and the ordering is why. The database
   * excludes overlapping key-manager periods, so the incoming row cannot be
   * inserted until the outgoing one is closed — and if the insert then fails on
   * its own, a separate call has already left the client with nobody in charge
   * and no record of what went wrong. `AssignmentStrategy.assign` makes the same
   * argument from the other direction: a decision applied outside the
   * transaction it was taken in is not a decision.
   */
  create(row: NewClientAssignment, handover: HandoverClose | null): Promise<ClientAssignment>;

  /** Close an open assignment. Never a delete, and never an edit of who held
   *  it: overwriting the holder destroys the only record of who it WAS, which
   *  is the question this table exists to answer. */
  end(tenantId: string, assignmentId: string, validTo: string): Promise<ClientAssignment>;

  /**
   * One person's book — the clients they hold an assignment over TODAY.
   *
   * One row per CLIENT with the roles collected onto it, not one row per
   * assignment: a partner is commonly the Key Manager and a Dept's SPOC on the
   * same client, and a list that showed it twice would report a bigger book
   * than the person has.
   */
  listForUser(tenantId: string, userId: string, onDate: string): Promise<readonly OwnedClient[]>;
}

/**
 * Who at the firm may be given a client.
 *
 * Narrow on purpose — the same port `usecase/lead` declares, in the same words,
 * satisfied by the same membership adapter. This use case does not want to know
 * what a membership is, only whether the proposed holder actually works here.
 *
 * It exists because the foreign key cannot answer it: `tenancy.user_account` is
 * GLOBAL (one login, many firms), so the database would accept a stranger with
 * every policy satisfied.
 */
export interface StaffDirectory {
  isActiveStaff(tenantId: string, userId: string): Promise<boolean>;
}

/** The client, as this use case needs to see it: enough to refuse a party that
 *  is not there and one the firm has put away. Structurally what
 *  `PartyRepository.findParty` returns, declared here so neither use case
 *  imports the other. */
export interface ClientPartyRow {
  readonly id: string;
  readonly displayName: string;
  readonly archivedAt: string | null;
}

export interface ClientDirectory {
  findParty(tenantId: string, partyId: string): Promise<ClientPartyRow | null>;
}

/** A Dept or delivery team as this use case needs to see it — enough to refuse
 *  one that is not the firm's and one it has retired. */
export interface AssignableAxisRow {
  readonly id: string;
  readonly axis: string;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
}

/**
 * The firm's own two lists, asked one row at a time.
 *
 * A THIRD port over `tenancy.service_axis`, beside the service-axis use case's
 * own repository and the config registry's `AxisDirectory` — one adapter, three
 * seams, the arrangement `PostgresConfigRepository` and the staff-grade
 * repository already have. Two adapters over one table eventually disagree
 * about which Depts a firm has, and here that would mean a SPOC assigned to a
 * Dept the picker never offered.
 */
export interface AssignableAxisDirectory {
  findById(tenantId: string, axisId: string): Promise<AssignableAxisRow | null>;
}

/**
 * What the catch-up moved, per person it moved work to (T6.17). Ids and
 * counts; the screen names the people from the roster it already holds.
 */
export interface CaughtUpWork {
  readonly moves: readonly {
    readonly userId: string;
    readonly tasks: number;
    readonly steps: number;
  }[];
}

/**
 * THE CATCH-UP (T6.17, Shrestha 2026-09-27): naming somebody on a client's
 * account team moves the work the engine already created for that client and
 * could only put on a fallback desk (the Key Manager's or the signing
 * partner's, to hand out) or on nobody's. The work item use case owns what
 * moves and how; this use case only says WHEN, because naming the team is its
 * act. Declared here and satisfied in `setup/` with the work item service's
 * own method, so neither use case imports the other.
 */
export interface ClientWorkCatchUp {
  catchUp(tenantId: string, clientPartyId: string, actor: Actor): Promise<CaughtUpWork>;
}
