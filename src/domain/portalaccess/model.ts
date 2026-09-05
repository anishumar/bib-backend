// The portal-access domain (G3.4, gate 4) — which of the firm's clients one
// client-portal login may read. Pure nouns and pure rules; imports nothing
// internal and nothing beyond the standard library (enforced by the arch test).
//
// ── IT IS A GRANT, NOT A DERIVATION, AND THAT IS THE WHOLE MODULE ──────────
//
// `core.party_relationship` already knows that a company belongs to a group and
// that a person is a director of one. Reading portal access out of that graph
// is one join, and it is the mistake this module exists to refuse: the screen
// that writes relationships is the CRM screen, so somebody recording "Cobalt is
// part of the Kaveri group" would silently hand a Cobalt contact the group's
// filings — reviewed by nobody, because a CRM edit is not reviewed as an
// access-control change.
//
// So access is a ROW somebody wrote, per company, with a date, a granter and an
// audit event. A contact who should see four companies has four rows, and
// whether a group's contact SHOULD see all four is a fact about the ENGAGEMENT
// that the firm has never been asked (G0.1: four companies file four sets of
// returns).
//
// ── AND IT IS AGAINST A MEMBERSHIP, NOT AN ACCOUNT ────────────────────────
//
// Identity is above tenant (ADR-02): the same human may hold a portal login at
// two firms, and what they may see at each is a separate decision taken by a
// separate firm. Keying on the user account would let one firm's grant be read
// as another's.

/** One login's permission to read one client's records, for one stretch of
 *  time. */
export interface PortalAccess {
  readonly id: string;
  readonly tenantId: string;
  readonly membershipId: string;
  /** The CLIENT, never one of its companies. Per-entity work hangs off the
   *  client; a grant that named an entity would leave the client's own invoices
   *  unreachable. */
  readonly clientPartyId: string;
  /** ISO YYYY-MM-DD. */
  readonly validFrom: string;
  /** Half-open: the FIRST DAY NOT IN FORCE. Null while the grant stands. */
  readonly validTo: string | null;
  readonly grantedBy: string;
}

/**
 * A grant with the names a screen needs, so nothing is looked up per row.
 *
 * The person is `displayName ?? email` at the screen and BOTH are carried, for
 * the reason this codebase has now learnt seven times: `display_name` is
 * nullable and genuinely empty at real firms, so a name alone collapses "we
 * hold no name for this person" into "there is no person". The email is the
 * discriminator.
 */
export interface PortalAccessRecord {
  readonly access: PortalAccess;
  readonly clientName: string;
  readonly contactDisplayName: string | null;
  readonly contactEmail: string;
  /**
   * Have they ever set a password — i.e. has the invitation been ACCEPTED.
   *
   * On the record and not derived on a screen, because nothing a screen holds
   * could derive it. It is the fact that decides whether "send the invitation
   * again" is an action worth offering at all: a contact who has accepted has
   * no invitation left, and re-issuing one would be the firm resetting its own
   * client's password (`InvitationAlreadyAccepted`). Without it, that route's
   * refusal is the only way to find out, which means offering a button whose
   * commonest outcome is an error.
   */
  readonly contactAccepted: boolean;
  readonly grantedByDisplayName: string | null;
  readonly grantedByEmail: string | null;
}

/**
 * What one portal session may read today — the value `withPortal` takes.
 *
 * A list, and an EMPTY list is a real answer that must reach the database as
 * one: every portal login is in that state between being invited and being
 * granted anything. The resolver's own note says why conflating it with "no
 * scope was resolved" is the one silent mistake available here.
 */
export interface PortalScope {
  readonly membershipId: string;
  readonly clientPartyIds: readonly string[];
}

/**
 * Is this grant in force on this day?
 *
 * Half-open, `[validFrom, validTo)` — `validTo` is the FIRST DAY NOT IN FORCE,
 * the same convention as `client_assignment`, `party_relationship`,
 * `party_identifier` and the obligation rule window. Two date conventions in one
 * schema is an off-by-one waiting for a handover, and here it would mean a CFO
 * who left on the 1st could still read the books on the 1st.
 *
 * String comparison, deliberately: these are `YYYY-MM-DD` calendar days and not
 * instants, and constructing a `Date` to compare them is how a day is lost
 * either side of midnight UTC.
 */
export function isInForceOn(access: PortalAccess, on: string): boolean {
  if (on < access.validFrom) return false;
  return access.validTo === null || on < access.validTo;
}

/**
 * The scope a set of grants adds up to on one day.
 *
 * De-duplicated, because two grants over the same client — an old one closed
 * and a new one opened on the same day, which is exactly what a re-grant looks
 * like — must not put the id in the list twice: the list becomes a SQL `= ANY`
 * and a duplicate is noise in a value that is read on every portal request.
 */
export function scopeOn(
  membershipId: string,
  grants: readonly PortalAccess[],
  on: string,
): PortalScope {
  const ids = new Set<string>();
  for (const grant of grants) {
    if (isInForceOn(grant, on)) ids.add(grant.clientPartyId);
  }
  return { membershipId, clientPartyIds: [...ids] };
}
