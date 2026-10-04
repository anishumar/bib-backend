// The ports this use case needs. As with `usecase/portalinvite` next door,
// every one is already satisfied by a service that exists, and every one is
// declared in THIS use case's vocabulary rather than imported from the service
// that implements it — so no use case imports another.
import type { Actor } from "../../domain/ledger/model";
import type { Membership } from "../../domain/tenancy/model";

/** The letter. Satisfied by `IdentityService`. */
export interface StaffWelcomeIdentity {
  /**
   * Write to a new colleague and hand them the way in.
   *
   * Returns the OUTCOME rather than throwing on a failed send, and never the
   * token: the caller is a route answering an administrator, and an
   * administrator who can read a colleague's link can sign in as them. The link
   * exists in the mail and nowhere else — the same rule as the portal invite,
   * for the same reason.
   */
  welcomeStaff(
    userId: string,
    firmName: string | null,
    /** The firm's zone, for the expiry in the letter (CA#50). */
    timeZone?: string | null,
    /** Who is adding them, named in the letter (CA#50). Null for a system
     *  actor (provisioning), which has no name to give. */
    addedByUserId?: string | null,
  ): Promise<{ readonly expiresAt: string | null; readonly sent: boolean }>;
}

/** The firm's zone, so the letter's expiry reads on its clock (CA#50).
 *  Satisfied by `PostgresFirmTimeZone`. */
export interface StaffFirmTimeZone {
  timeZoneFor(tenantId: string): Promise<string>;
}

/** The membership. Satisfied by `TenancyService`. */
export interface StaffMemberships {
  inviteMember(
    input: {
      readonly tenantId: string;
      readonly email: string;
      readonly displayName?: string | undefined;
      readonly audience: string;
      readonly role: string;
      readonly commercialVisibility?: boolean | undefined;
    },
    actor: Actor,
  ): Promise<Membership>;
}

/** What the firm is CALLED, for the letter. Satisfied by `TenancyService`. */
export interface StaffFirmDirectory {
  tenantNames(ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
}
