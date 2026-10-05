// The ports this use case needs — and every one of them is satisfied by a
// service that already exists. Nothing here is a new capability; the task is to
// make three existing acts into ONE act, because "invite this client's CFO" is
// one decision and half of it landing is worse than none.
//
// They are declared in THIS use case's vocabulary rather than imported from the
// three services, so no use case imports another — the arrangement
// `usecase/lead` has with `PartyService` through `ProspectDirectory`.
import type { Actor } from "../../domain/ledger/model";
import type { ClientSender } from "../../domain/mail/model";

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
  invitePortalContact(
    userId: string,
    firmName: string | null,
    timeZone?: string | null,
    sender?: ClientSender | null,
  ): Promise<string>;

  /**
   * Send that same letter AGAIN, to the address already on the account.
   *
   * Takes no address, and that absence is the design: see
   * `IdentityService.resendPortalInvite`. It refuses an account that has
   * already set a password — at that point there is no invitation left to
   * re-send, only a password to reset, which is not a thing a firm may do to
   * its own client.
   */
  resendPortalInvite(
    userId: string,
    firmName: string | null,
    timeZone?: string | null,
    sender?: ClientSender | null,
  ): Promise<{ readonly expiresAt: string; readonly supersededLinks: number }>;
}

/**
 * Who the invitation is from (Q059): the client's Key Manager, by name, with
 * a reply reaching them. Satisfied by `PostgresClientSenders`. Null: nobody in
 * that seat, and the letter is from the firm as before.
 */
export interface PortalInviteSenders {
  senderForClient(tenantId: string, clientPartyId: string): Promise<ClientSender | null>;
  /** For a letter sent again: the first client the contact may see today. */
  senderForContact(tenantId: string, membershipId: string): Promise<ClientSender | null>;
}

/** The membership. Satisfied by `TenancyService`. */
export interface PortalContactMemberships {
  findMembership(tenantId: string, membershipId: string): Promise<PortalContactRow | null>;

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

/**
 * The contact being written to, as this use case needs to see them.
 *
 * A read the invite path never needed — it CREATES the membership and holds it
 * in hand. Re-sending starts from an id off a screen, so everything the letter
 * depends on has to be looked up and checked: that the row is this firm's, that
 * it is a client login and not a colleague's, and that it still works.
 *
 * Structurally what `usecase/portalaccess`'s `PortalMembershipDirectory`
 * returns, plus the `userId` the letter is actually addressed by, and declared
 * here in this use case's own words so neither imports the other. Satisfied by
 * `TenancyService`.
 */
export interface PortalContactRow {
  readonly id: string;
  readonly userId: string;
  readonly audience: string;
  readonly isActive: boolean;
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

  /** The rest of the client's group, one grant per company (Q064). */
  grantGroupOf(
    input: {
      readonly tenantId: string;
      readonly membershipId: string;
      readonly clientPartyId: string;
      readonly validFrom?: string | undefined;
      readonly grantedBy: string;
    },
    actor: Actor,
  ): Promise<{ readonly granted: readonly { readonly id: string; readonly clientPartyId: string; readonly clientName: string }[] }>;
}

/** The firm's zone, so the letter's expiry reads on its clock (CA#50).
 *  Satisfied by `PostgresFirmTimeZone`. */
export interface PortalFirmTimeZone {
  timeZoneFor(tenantId: string): Promise<string>;
}

/** What the firm is CALLED, for the letter. Satisfied by `TenancyService`. */
export interface PortalFirmDirectory {
  tenantNames(ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
}
