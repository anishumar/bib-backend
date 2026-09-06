// The tenancy domain — nouns and pure rules only. Imports nothing internal and
// nothing beyond the standard library (enforced by the arch test). It would
// exist unchanged if there were no database and no HTTP.
//
// Identity lives above tenant: a UserAccount is global; a Membership is the
// join that grants a user access to one tenant, in one audience, with one role.
import type { CurrencyCode } from "../money/model";

/** Which surface a membership grants access to. A product invariant, closed
 *  set — not the firm's to redefine (unlike role). */
export type Audience = "STAFF" | "CLIENT_PORTAL";

export const AUDIENCES: readonly Audience[] = ["STAFF", "CLIENT_PORTAL"];

export function isAudience(v: string): v is Audience {
  return (AUDIENCES as readonly string[]).includes(v);
}

export interface Tenant {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: "active" | "suspended";
  /**
   * What this firm's books are denominated in — the currency its pipeline,
   * targets and revenue read in, whatever it happened to quote a client.
   *
   * Set at creation and never changed. Every FX rate the product stores is
   * struck against this code, so changing it later does not restate history, it
   * silently invalidates it: the numbers stay, the meaning moves, and nothing
   * errors. That is why it is a column here rather than a row in the
   * configuration registry, which is for the things a firm DOES change.
   */
  readonly reportingCurrency: CurrencyCode;
  /**
   * Who signs this firm's engagement letters, and in what capacity — "unki ek
   * hi signature rahegi".
   *
   * ONE signatory for the whole firm, whichever of its entities issues the
   * document. A ROW rather than a hardcode, so a successor is an UPDATE and it
   * is still true for the second tenant on the installation. Each letter
   * SNAPSHOTS it when it goes out, so naming a successor never restates who
   * signed a letter last year.
   *
   * Both fields or neither (`tenant_firm_signatory_is_whole_chk`, 0022): a name
   * with no capacity cannot be printed under "Yours sincerely", and a capacity
   * with no name is nobody. Null on both is a firm that has not named one yet,
   * which is a state it operates in perfectly well — the block does not print.
   *
   * Unlike `reportingCurrency` this is freely changeable, because changing it
   * restates nothing: the letters keep what they were sent with.
   */
  readonly firmSignatoryUserId: string | null;
  readonly firmSignatoryTitle: string | null;
}

export interface UserAccount {
  readonly id: string;
  readonly email: string;
  /** What a colleague calls them. Null for an account nobody has named yet —
   *  a roster falls back to the email rather than inventing one. It lives on the
   *  ACCOUNT, not the membership: identity is above tenant, so the same human at
   *  two firms is one person with one name. */
  readonly displayName: string | null;
  readonly status: "active" | "disabled";
}

export interface Membership {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly audience: Audience;
  /** The firm's own vocabulary (e.g. "partner", "rm"), resolved against config
   *  elsewhere. Free text here on purpose. */
  readonly role: string;
  /** The orthogonal fee-visibility axis — NOT a role. Delivery staff see the
   *  work but not the money. */
  readonly commercialVisibility: boolean;
  /**
   * Which rung of the firm's own hierarchy this person is on — a THIRD axis,
   * independent of role and of fee visibility (G3.3).
   *
   * The role says what they may reach; the grade says how senior they are, and
   * it is what the firm's review rule compares: "Manager or above is fine."
   *
   * Null is a real and common state, not a gap to be filled in later. A
   * client-portal membership has no grade and never will, and the firm has
   * several real designations its own hierarchy has never ranked — an ungraded
   * person is visibly ungraded, which is the honest answer. A plausible
   * invented rank would be indistinguishable from a real one, and this is the
   * value that decides who may sign off a statutory filing.
   */
  readonly gradeId: string | null;
  /**
   * Who this person reports to, as a `user_account` id (T2.9, migration 0048).
   *
   * A FOURTH axis and it grants nothing either — it exists because one of the
   * two review rules the firm gave is a reporting line, not a rank: "manager
   * means engagement manager". Without this column that rule cannot even be
   * offered on the screen, because nothing else in this schema records a staff
   * reporting relationship. `core.party_relationship` is between PARTIES, and a
   * member of staff is a `user_account` plus this row, never a party.
   *
   * Null for a partner, for every portal contact, and for everybody at a firm
   * that has not filled it in — which is every firm the day 0048 applies. A
   * `reporting_line` policy then matches nobody, and the screen says exactly
   * that rather than silently approving nothing.
   *
   * NOT effective-dated, and that is a stated limit. The firm's staff sheet
   * carries birth dates and no joining dates, and nothing records when a
   * reporting line STARTED, so "who was my manager in March" has no honest
   * answer here — better than an effective-dated table whose every row begins
   * on the day of the import and answers it confidently and wrongly.
   */
  readonly reportsToUserId: string | null;
  readonly isActive: boolean;
}

// ── Pure rules ────────────────────────────────────────────────────────────

/** A tenant slug is url-safe, lowercase, 2–40 chars. Pure predicate; no I/O. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/.test(slug);
}

/** Emails are compared case-insensitively; normalise before storage/lookup. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The active memberships a user may switch between — the org-switcher's data. */
export function activeMemberships(all: readonly Membership[]): readonly Membership[] {
  return all.filter((m) => m.isActive);
}

/**
 * Whether a firm still has somebody who can administer it.
 *
 * The roster and the role registry are two routes to the same unrecoverable
 * state. The registry already refuses to publish a role set where no role
 * carries `tenant:admin`; this is the other direction — a firm where the
 * permission exists on paper but no active member holds a role that has it.
 * Either way nobody can change configuration, including changing it back, and
 * the only fix is a database session.
 *
 * Pure, and asked about the roster the firm WOULD have after the change, so the
 * same predicate serves a role change and a deactivation.
 */
export function hasActiveAdministrator(
  members: readonly Pick<Membership, "role" | "isActive" | "audience">[],
  adminRoles: ReadonlySet<string>,
): boolean {
  // STAFF, and the audience is not a detail. A CLIENT_PORTAL membership is a
  // login on the other side of the wall: gate 2 admits it only to PORTAL_PATHS,
  // and none of those can administer anything. Counting one as an administrator
  // meant this guard could be satisfied by somebody who structurally cannot
  // reach a single administration route — the firm passes the check and is
  // stranded exactly as completely as if the check had never run.
  return members.some((m) => m.isActive && m.audience === "STAFF" && adminRoles.has(m.role));
}

/** The roster as it would be after one membership changes — the input to the
 *  check above. Returns a new array; the caller's roster is untouched. */
export function rosterAfter<T extends { readonly id: string }>(
  members: readonly T[],
  membershipId: string,
  change: (m: T) => T,
): readonly T[] {
  return members.map((m) => (m.id === membershipId ? change(m) : m));
}

// ── THE FIRM'S OWN TIMEZONE (0071) ──────────────────────────────────────────
//
// It answers ONE question and it is worth stating narrowly, because the wrong
// reading of it undoes T6.9: *which calendar DAY or MONTH does this instant
// belong to, for this firm?* The monthly digest asks it, and so does the
// chaser's day arithmetic.
//
// It is NOT how an instant is rendered. A moment shown to a person is shown in
// the READER's own zone — "2 September 2026" is the day it happened where they
// are — and that is settled and unaffected. A PERIOD is the opposite: a digest
// is a statement by the firm about a month, so it needs ONE boundary or the
// partner and the client open the same September and see different documents.

/** The zone every firm has until it chooses — and exactly what the product did
 *  before 0071, since every environment it has run in is UTC. */
export const DEFAULT_TIME_ZONE = "UTC";

/**
 * Is this a zone this runtime knows, and a NAME rather than an offset?
 *
 * The FRIENDLY half of the check. `tenancy.assert_known_time_zone` (0071) is
 * the real one — a trigger, so an import or a psql session meets it too — and
 * it asks `pg_timezone_names`, the list `AT TIME ZONE` will actually accept.
 * This exists so a person setting the value gets a sentence instead of a
 * database exception.
 *
 * ── THE TWO LISTS DIFFER, AND THE OBVIOUS API IS THE WRONG ONE ────────────
 *
 * `Intl.supportedValuesOf("timeZone")` looks like the right source and is not.
 * Measured against this database rather than assumed:
 *
 *   · it omits `UTC` and `Asia/Kolkata`, both of which Postgres accepts — so
 *     validating against it would refuse this product's own DEFAULT and the
 *     one zone its first customer actually uses;
 *   · it canonicalises `Asia/Kolkata` to `Asia/Calcutta`, which Postgres does
 *     NOT know — so it would also recommend a value the write then rejects.
 *
 * Constructing a formatter is the check that matches: everything Postgres
 * accepts, it accepts.
 *
 * ── AND AN OFFSET IS REFUSED ON PURPOSE, NOT AS AN ACCIDENT ───────────────
 *
 * `Intl` takes `+05:30`; `pg_timezone_names` does not. Rather than let that
 * one class through to a database exception, it is refused here WITH a reason
 * that is also the product's: an offset cannot express daylight saving, so a
 * firm on `+01:00` would cut its months an hour wrong for half the year. A
 * zone is a place, and a place is what knows its own rules.
 */
export function isTimeZone(value: string): boolean {
  const name = value.trim();
  if (name === "") return false;
  // `+05:30`, `-08:00`, `GMT+5` — an offset wearing a zone's clothes.
  if (/^[+-]/.test(name) || /^(?:GMT|UTC)[+-]/i.test(name)) return false;
  try {
    // An unknown zone throws RangeError; that is the whole check.
    new Intl.DateTimeFormat("en-GB", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}
