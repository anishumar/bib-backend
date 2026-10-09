// Client assignment (G3.2): who at the firm owns a client, and who the client talks to.
// Key Manager: one per client at a time; owns the relationship (pricing, renewals,
// escalation), so it carries no axis. SPOC: the day-to-day contact for one part of the work,
// a coordination point, not the assignee. The firm: "each client will defacto have two SPOC,
// one from TRC and one from FRC"; an RAA client has three, so an assignment is a ROW.
// A SPOC's `axisId` is any `tenancy.service_axis` row, Dept or delivery team (0043; 0049 has
// the argument): a firm with teams and no Depts still needs SPOCs. 10x Global uses Depts.
// No "one SPOC per axis" rule (Shrestha, 2026-08-30): leave cover, joint SPOCs and parallel
// handovers are real, so `spocsOn` returns a LIST and "who was the SPOC in March" may be two.

import { isCalendarDay } from "../day";

/** The engine's vocabulary, the same at every firm and a schema CHECK (like
 *  `service_axis.axis`, `config.entry.kind`). The firm owns who holds them. */
export type AssignmentRole = "key_manager" | "spoc";

export const ASSIGNMENT_ROLES: readonly AssignmentRole[] = ["key_manager", "spoc"];

export function isAssignmentRole(v: string): v is AssignmentRole {
  return (ASSIGNMENT_ROLES as readonly string[]).includes(v);
}

/** One person holding one role over one client, for one stretch of time. */
export interface ClientAssignment {
  readonly id: string;
  readonly tenantId: string;
  /** The CLIENT, not one of its companies: a group has one account team; per-entity work
   *  is `crm.engagement`. */
  readonly clientPartyId: string;
  readonly role: AssignmentRole;
  /** The Dept or team a SPOC covers. Always null for a Key Manager. */
  readonly axisId: string | null;
  readonly userId: string;
  /** ISO YYYY-MM-DD. */
  readonly validFrom: string;
  /**
   * The FIRST DAY NOT IN FORCE, or null while open. Half-open `[validFrom, validTo)`, like
   * `core.party_relationship` and `core.party_identifier`; the demo's inclusive bound showed
   * TWO SPOCs on the changeover day.
   */
  readonly validTo: string | null;
}

/** Who holds it, with names, so a list never fetches a person per row. */
export interface AssignmentHolder {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string | null;
  /**
   * Whether the holder is still active staff here, read at render time. An assignment
   * deliberately survives the person leaving (it is the record of who owned the client), and
   * no FK catches it: `tenancy.user_account` is GLOBAL. Only a row still IN FORCE with this
   * false is an uncovered client; see `staleAssignments`.
   */
  readonly isActiveStaff: boolean;
}

/** The Dept or team as a row shows it. A projection of the service-axis aggregate, so
 *  neither domain imports the other. */
export interface AssignmentAxis {
  readonly id: string;
  readonly axis: string;
  readonly code: string;
  readonly name: string;
  /** False once retired. A retired axis still shows: the assignment was made under it. */
  readonly isActive: boolean;
}

/** One row of the account team, resolved. */
export interface ClientAssignmentRecord {
  readonly assignment: ClientAssignment;
  readonly holder: AssignmentHolder;
  /** Null for a Key Manager. Never null for a SPOC (the schema forbids it). */
  readonly axis: AssignmentAxis | null;
}

/** A client on somebody's book, as the "my clients" list renders it. */
export interface OwnedClient {
  readonly clientPartyId: string;
  readonly displayName: string;
  readonly archivedAt: string | null;
  /** Every role this person holds over the client today. A partner is often Key Manager AND
   *  a SPOC; listing the client twice would inflate the book. */
  readonly roles: readonly AssignmentRole[];
}

// Pure rules

/**
 * A real ISO day, YYYY-MM-DD. Duplicated from `domain/party/model.ts` because sibling domains
 * may not import each other (as `normalizeAxisCode` vs `domain/config`); a test keeps them equal.
 */
export function isIsoDate(s: string): boolean {
  // A day that EXISTS, not just the shape (audit 2026-10-03, B43): 2026-13-45 reached
  // Postgres as an unmapped 22008, a 500.
  return isCalendarDay(s);
}

/**
 * In force on `onDate`? Half-open: `validTo` is the first day NOT in force. Dates stay ISO
 * strings (they compare lexicographically; a handover is a calendar fact, not a UTC instant).
 * Same shape as the party domain's `isInForceOn` on purpose.
 */
export function isInForceOn(
  a: Pick<ClientAssignment, "validFrom" | "validTo">,
  onDate: string,
): boolean {
  if (onDate < a.validFrom) return false;
  return a.validTo === null || onDate < a.validTo;
}

/** Mirrors the DB CHECK: a real `validFrom` and, when closed, a real `validTo` strictly after
 *  it (half-open, so an equal pair is in force on no day). */
export function isValidDateRange(validFrom: string, validTo: string | null): boolean {
  if (!isIsoDate(validFrom)) return false;
  if (validTo === null) return true;
  return isIsoDate(validTo) && validTo > validFrom;
}

/** Do two half-open ranges share a day? The exclusion constraints' predicate, so the
 *  service can refuse in words. */
export function overlaps(
  a: Pick<ClientAssignment, "validFrom" | "validTo">,
  b: Pick<ClientAssignment, "validFrom" | "validTo">,
): boolean {
  const aEndsBefore = a.validTo !== null && a.validTo <= b.validFrom;
  const bEndsBefore = b.validTo !== null && b.validTo <= a.validFrom;
  return !aEndsBefore && !bEndsBefore;
}

/** The account team on one day: a filter over every row already in hand (a client has a
 *  handful), not a query per date. */
export function accountTeamOn(
  rows: readonly ClientAssignmentRecord[],
  onDate: string,
): readonly ClientAssignmentRecord[] {
  return rows.filter((r) => isInForceOn(r.assignment, onDate));
}

/** The Key Manager on a day, or null. `client_assignment_one_key_manager` makes it singular;
 *  this returns the first match rather than throwing on data the schema forbids. */
export function keyManagerOn(
  rows: readonly ClientAssignmentRecord[],
  onDate: string,
): ClientAssignmentRecord | null {
  return (
    accountTeamOn(rows, onDate).find((r) => r.assignment.role === "key_manager") ?? null
  );
}

/** The SPOCs on a day, optionally for one axis. Always a list: see the file header. */
export function spocsOn(
  rows: readonly ClientAssignmentRecord[],
  onDate: string,
  axisId?: string,
): readonly ClientAssignmentRecord[] {
  return accountTeamOn(rows, onDate).filter(
    (r) =>
      r.assignment.role === "spoc" &&
      (axisId === undefined || r.assignment.axisId === axisId),
  );
}

/**
 * Rows in force on `onDate` whose holder is no longer staff: escalation goes to an empty desk.
 * Nothing else notices, since a handover closes an assignment and deactivating a membership
 * does not. Closed rows are excluded: a former SPOC leaving is normal.
 */
export function staleAssignments(
  rows: readonly ClientAssignmentRecord[],
  onDate: string,
): readonly ClientAssignmentRecord[] {
  return accountTeamOn(rows, onDate).filter((r) => !r.holder.isActiveStaff);
}

/**
 * Reading order: Key Manager first, then SPOCs by `axis.code` (stable; the caller resolves
 * `sortOrder` into it), open before closed, newest first, then holder name so rows never swap
 * between loads (as `axisOrder` and `ladderOrder`).
 */
export function accountTeamOrder(
  rows: readonly ClientAssignmentRecord[],
): readonly ClientAssignmentRecord[] {
  const rank = (r: ClientAssignmentRecord): number => (r.assignment.role === "key_manager" ? 0 : 1);
  const label = (r: ClientAssignmentRecord): string =>
    r.holder.displayName ?? r.holder.email;
  return [...rows].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.axis?.code ?? "").localeCompare(b.axis?.code ?? "") ||
      Number(a.assignment.validTo !== null) - Number(b.assignment.validTo !== null) ||
      b.assignment.validFrom.localeCompare(a.assignment.validFrom) ||
      label(a).localeCompare(label(b)),
  );
}
