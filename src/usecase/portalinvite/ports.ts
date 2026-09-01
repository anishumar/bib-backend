// The ports this use case needs — and every one of them is satisfied by a
// service that already exists. Nothing here is a new capability; the task is to
// make three existing acts into ONE act, because "invite this client's CFO" is
// one decision and half of it landing is worse than none.
//
// They are declared in THIS use case's vocabulary rather than imported from the
// three services, so no use case imports another — the arrangement
// `usecase/lead` has with `PartyService` through `ProspectDirectory`.
import type { Actor } from "../../domain/ledger/model";

/** The account and the letter. Satisfied by `IdentityService`. */
export interface PortalContactIdentity {
  /**
   * Mail the single-use link on which a password is chosen, and say when it
   * stops working.
   *
   * Returns the EXPIRY and never the token: the caller is a route that answers
   * a member of the firm, and a firm that can read its client's invite link can
   * sign in as that client. The link exists in the mail and nowhere else.
   */
  invitePortalContact(userId: string, firmName: string | null): Promise<string>;
}

/** The membership. Satisfied by `TenancyService`. */
export interface PortalContactMemberships {
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
  ): Promise<{ readonly id: string; readonly userId: string }>;
}

/** Gate 4's grant. Satisfied by `PortalAccessService`. */
export interface PortalContactAccess {
  grant(
    input: {
      readonly tenantId: string;
      readonly membershipId: string;
      readonly clientPartyId: string;
      readonly validFrom?: string | undefined;
      readonly grantedBy: string;
    },
    actor: Actor,
  ): Promise<{ readonly id: string }>;
}

/** What the firm is CALLED, for the letter. Satisfied by `TenancyService`. */
export interface PortalFirmDirectory {
  tenantNames(ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
}
