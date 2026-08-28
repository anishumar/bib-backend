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
  members: readonly Pick<Membership, "role" | "isActive">[],
  adminRoles: ReadonlySet<string>,
): boolean {
  return members.some((m) => m.isActive && adminRoles.has(m.role));
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
