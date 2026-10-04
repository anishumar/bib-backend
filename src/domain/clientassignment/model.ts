// The client-assignment domain (G3.2) — who at the firm owns a client, and who
// the client talks to day to day. Pure nouns and pure rules; imports nothing
// internal and nothing beyond the standard library (enforced by the arch test).
//
// ── THE TWO ROLES SIT AT DIFFERENT LEVELS ──────────────────────────────────
//
// **Key Manager** — one per client, at a time. Owns the relationship: pricing,
// renewals, escalation. Covers no particular part of the work, which is why it
// carries no axis.
//
// **SPOC** — the day-to-day contact for one part of the work. The firm's own
// words: *"each client will defacto have two SPOC, one from TRC and one from
// FRC"*. A client buying RAA work as well has three. That is why an assignment
// is a ROW and not a pair of columns on the client: a pair fixes the count at
// two and the firm already has clients with three.
//
// A SPOC is a COORDINATION point, not the person doing the work — a job carries
// its own assignee, and this says who the client rings.
//
// ── AND A SPOC'S AXIS IS EITHER OF THE FIRM'S TWO LISTS ────────────────────
//
// G3.2's board line says Dept. This module says `axisId`, pointing at whichever
// row of `tenancy.service_axis` the firm chose — Dept or delivery team — for
// 0043's reason: neither layer is universal, and a firm with delivery teams and
// no Depts would otherwise have nowhere to put a SPOC. At 10x Global it is a
// picker set to their Depts and the behaviour is exactly what the board asked
// for. Migration 0049 carries the whole argument.
//
// ── AND THERE IS NO "ONE SPOC PER AXIS" RULE ───────────────────────────────
//
// Deliberately, on Shrestha's instruction (2026-08-30): in general a Dept may
// have more than one — leave cover, a joint SPOC on a large group, a handover
// run in parallel for a fortnight. So `spocsOn` returns a LIST, every reader
// takes a list, and "who was the SPOC in March" is allowed to answer with two
// when the firm really had two.

import { isCalendarDay } from "../day";

/** What somebody was given. The ENGINE's vocabulary — the same at every firm,
 *  and a CHECK in the schema, the way `service_axis.axis` and
 *  `config.entry.kind` are. What a firm owns is who holds them. */
export type AssignmentRole = "key_manager" | "spoc";

export const ASSIGNMENT_ROLES: readonly AssignmentRole[] = ["key_manager", "spoc"];

export function isAssignmentRole(v: string): v is AssignmentRole {
  return (ASSIGNMENT_ROLES as readonly string[]).includes(v);
}

/** One person holding one role over one client, for one stretch of time. */
export interface ClientAssignment {
  readonly id: string;
  readonly tenantId: string;
  /** The CLIENT, not one of its companies. A group with four entities has one
   *  Key Manager and one set of SPOCs; per-entity work is `crm.engagement`. */
  readonly clientPartyId: string;
  readonly role: AssignmentRole;
  /** The Dept or delivery team a SPOC covers. Always null for a Key Manager,
   *  who covers the relationship rather than a part of it. */
  readonly axisId: string | null;
  readonly userId: string;
  /** ISO YYYY-MM-DD. */
  readonly validFrom: string;
  /**
   * The FIRST DAY NOT IN FORCE, or null while it still is.
   *
   * Half-open, `[validFrom, validTo)`, matching `core.party_relationship` and
   * `core.party_identifier` — every effective-dated thing in this product. The
   * demo used an inclusive bound and copying it would have shown TWO SPOCs on
   * the changeover day, which is the exact ambiguity this table exists to
   * remove.
   */
  readonly validTo: string | null;
}

/**
 * Who holds it, as a list has to render them.
 *
 * The read model carries NAMES, not just the `userId` the aggregate has — this
 * codebase's rule, learnt five times over (`MemberRecord`, `LeadRecord`,
 * `ProposalRecord`, party 360's relationships, the ledger's actor). A screen
 * that had to fetch a person per row to render the account team is the mistake.
 */
export interface AssignmentHolder {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string | null;
  /**
   * Whether this person is STILL active staff at the firm, today.
   *
   * Not a property of the assignment — a property of the holder, read at the
   * moment the row is rendered. An assignment survives the person leaving,
   * deliberately: closing every row when somebody is deactivated would destroy
   * the record of who owned the client, which is what this table exists for.
   * The consequence is a live assignment pointing at somebody who has gone,
   * which no foreign key can catch — `tenancy.user_account` is GLOBAL, so the
   * key is satisfied by a login that no longer works HERE.
   *
   * False on a row that is itself long closed simply means the person has since
   * left; only a row still IN FORCE is a client nobody is actually covering.
   * `staleAssignments` is the predicate that says so.
   */
  readonly isActiveStaff: boolean;
}

/** The Dept or team as a row shows it — the firm's own words, not a uuid. A
 *  projection of the service-axis aggregate, named in this module's vocabulary
 *  so neither domain imports the other. */
export interface AssignmentAxis {
  readonly id: string;
  readonly axis: string;
  readonly code: string;
  readonly name: string;
  /** Whether the firm still files new work here. A retired axis still shows —
   *  the assignment really was made under it. */
  readonly isActive: boolean;
}

/** One row of the account team, resolved. */
export interface ClientAssignmentRecord {
  readonly assignment: ClientAssignment;
  readonly holder: AssignmentHolder;
  /** Null for a Key Manager. Never null for a SPOC — the schema forbids it. */
  readonly axis: AssignmentAxis | null;
}

/** A client on somebody's book, as the "my clients" list renders it. */
export interface OwnedClient {
  readonly clientPartyId: string;
  readonly displayName: string;
  readonly archivedAt: string | null;
  /** Every role this person holds over this client, today. A partner is
   *  commonly the Key Manager AND a Dept's SPOC on the same client, and a list
   *  that showed the client twice would be reporting a bigger book than it is. */
  readonly roles: readonly AssignmentRole[];
}

// ── Pure rules ────────────────────────────────────────────────────────────

/**
 * A well-formed ISO date, YYYY-MM-DD.
 *
 * Duplicated from `domain/party/model.ts` rather than imported, and the arch
 * wall requires it: `domain/party` and `domain/clientassignment` are siblings
 * and neither may import the other. `normalizeAxisCode` carries the same
 * duplication against `domain/config` for the same reason. The agreement
 * between them is held by a test, not by a shared import.
 */
export function isIsoDate(s: string): boolean {
  // A day that EXISTS, not just the shape (audit 2026-10-03, B43): 2026-13-45
  // passed the shape and reached Postgres as an unmapped 22008, a 500.
  return isCalendarDay(s);
}

/**
 * Was this in force on `onDate`? HALF-OPEN — `validTo` is the first day NOT in
 * force.
 *
 * ISO YYYY-MM-DD strings compare lexicographically, which is why dates are
 * carried as strings throughout rather than as `Date`: a UTC instant moves a
 * date boundary by a day for anybody east or west of it, and a handover is a
 * calendar fact in the firm's own office, not an instant.
 *
 * This is deliberately the same shape as `isInForceOn` in the party domain.
 * Two notions of "in force" in one product is an off-by-one waiting for the day
 * somebody hands a client over.
 */
export function isInForceOn(
  a: Pick<ClientAssignment, "validFrom" | "validTo">,
  onDate: string,
): boolean {
  if (onDate < a.validFrom) return false;
  return a.validTo === null || onDate < a.validTo;
}

/** A range is valid if `validFrom` is a well-formed ISO date and, when closed,
 *  `validTo` is a well-formed ISO date strictly after it. Mirrors the DB CHECK
 *  — half-open, so an equal pair is in force on no day at all. */
export function isValidDateRange(validFrom: string, validTo: string | null): boolean {
  if (!isIsoDate(validFrom)) return false;
  if (validTo === null) return true;
  return isIsoDate(validTo) && validTo > validFrom;
}

/** Do two half-open ranges share a day? The predicate the database's exclusion
 *  constraints make in SQL, available here so the service can refuse in a
 *  sentence rather than surface a constraint violation. */
export function overlaps(
  a: Pick<ClientAssignment, "validFrom" | "validTo">,
  b: Pick<ClientAssignment, "validFrom" | "validTo">,
): boolean {
  const aEndsBefore = a.validTo !== null && a.validTo <= b.validFrom;
  const bEndsBefore = b.validTo !== null && b.validTo <= a.validFrom;
  return !aEndsBefore && !bEndsBefore;
}

/**
 * The account team as it stood on one day.
 *
 * The whole of the "who was the SPOC in March" answer: the caller reads every
 * row a client ever had and this picks the ones in force. Deliberately a filter
 * over rows already in hand rather than a query per date — a client has a
 * handful of these over its whole life, and a screen with a date box would
 * otherwise round-trip on every keystroke.
 */
export function accountTeamOn(
  rows: readonly ClientAssignmentRecord[],
  onDate: string,
): readonly ClientAssignmentRecord[] {
  return rows.filter((r) => isInForceOn(r.assignment, onDate));
}

/**
 * The Key Manager on a day, or null.
 *
 * Singular, and the database is what makes it true: `client_assignment_one_key_manager`
 * excludes overlapping key-manager ranges per client, so at most one can be in
 * force. This returns the first match rather than asserting, because a domain
 * function that throws on data the schema forbids is a crash where a screen
 * wanted a name.
 */
export function keyManagerOn(
  rows: readonly ClientAssignmentRecord[],
  onDate: string,
): ClientAssignmentRecord | null {
  return (
    accountTeamOn(rows, onDate).find((r) => r.assignment.role === "key_manager") ?? null
  );
}

/**
 * The SPOCs on a day, optionally for one axis.
 *
 * A LIST, always — see the note at the top of this file. A firm running a
 * fortnight's parallel handover genuinely has two, and the honest answer to
 * "who was the SPOC in March" is then both names.
 */
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
 * The account team rows in force on `onDate` whose holder has since left.
 *
 * The client still has a Key Manager or a SPOC on paper, and the person named
 * is no longer staff — so escalation goes to a desk nobody sits at and the
 * client rings somebody who cannot answer. Nothing in the product notices this
 * on its own: an assignment is closed by a HANDOVER, and deactivating a
 * membership is a different act on a different screen that has no reason to
 * know which clients that person held.
 *
 * A filter over rows already in hand, for the same reason `accountTeamOn` is:
 * the caller has the whole history, and this is a question about a handful of
 * them. Closed rows are excluded — a former SPOC who has left is the ordinary
 * end of a working life, not a fault.
 */
export function staleAssignments(
  rows: readonly ClientAssignmentRecord[],
  onDate: string,
): readonly ClientAssignmentRecord[] {
  return accountTeamOn(rows, onDate).filter((r) => !r.holder.isActiveStaff);
}

/**
 * The order an account team reads in.
 *
 * Key Manager first — it is the answer to "who owns this client", and a screen
 * that buried it under six SPOCs would be answering a different question. Then
 * SPOCs by their axis's own order (`sortOrder` is resolved by the caller into
 * `axis.code`, which is stable), then by holder name so two SPOCs on one Dept
 * do not swap places between two loads. A list that reorders itself looks
 * broken even when it is not — `axisOrder` and `ladderOrder` make the same
 * argument.
 *
 * Then OPEN before CLOSED, and newest first within each: the historic rows are
 * below the live ones, which is the order the screen asks its question in.
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
