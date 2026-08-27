// The tenancy domain — nouns and pure rules only. Imports nothing internal and
// nothing beyond the standard library (enforced by the arch test). It would
// exist unchanged if there were no database and no HTTP.
//
// Identity lives above tenant: a UserAccount is global; a Membership is the
// join that grants a user access to one tenant, in one audience, with one role.

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
}

export interface UserAccount {
  readonly id: string;
  readonly email: string;
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
