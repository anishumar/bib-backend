// Inviting a client's own person into the portal (T6.5).
//
// ── WHY THIS IS ONE ACT AND NOT THREE ──────────────────────────────────────
//
// "Let Meera at Cobalt Foods into the portal" is one decision a partner takes,
// and it is three writes: an account, a CLIENT_PORTAL membership, and gate 4's
// grant — plus the letter that makes any of it usable. Left as three calls on a
// screen, the halfway states are all bad and all silent:
//
//   · membership, no grant  → she signs in to a portal that shows nothing, with
//     no way to tell whether that is the product or the firm.
//   · membership, no letter → an account nobody can reach, and the firm
//     believes it has invited somebody.
//   · grant, no membership  → unreachable; there is no login to hold it.
//
// So this is the one method, and the ORDER below is the safe one.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────
//
// **It grants ONE client.** The whole of G3.4 rests on access being granted per
// company and never derived, so a contact who should see four of a group's
// companies is invited once and granted three more times, deliberately, on the
// screen where each is a visible decision.
//
// **It does not set a password.** The firm never holds its client's password —
// that is the point of the link, and it is why `invitePortalContact` returns
// only an expiry.
//
// **It does not resend.** A second invite to somebody who already has a
// membership is refused by `inviteMember`, and re-inviting is a different act
// with a different question behind it ("did they lose the link, or has somebody
// else taken over the account?"). It belongs on its own route when a screen
// needs it.
import type { Actor } from "../../domain/ledger/model";
import type {
  PortalContactAccess,
  PortalContactIdentity,
  PortalContactMemberships,
  PortalFirmDirectory,
} from "./ports";

interface Deps {
  readonly identity: PortalContactIdentity;
  readonly memberships: PortalContactMemberships;
  readonly access: PortalContactAccess;
  readonly firms: PortalFirmDirectory;
}

export interface InvitePortalContactInput {
  readonly tenantId: string;
  readonly email: string;
  readonly displayName?: string | undefined;
  /** The ONE company this contact may read. Required: an invite with no grant
   *  is a login that opens onto nothing, which is the halfway state this method
   *  exists to make impossible. */
  readonly clientPartyId: string;
  /** The firm's own word for what a client contact is. Defaults to the seeded
   *  `client_contact` role, which carries no permissions at all — a portal
   *  session is told it may do nothing, because gate 2 admits it only to
   *  `PORTAL_PATHS` and none of those needs one. */
  readonly role?: string | undefined;
  /** The CALLER's calendar day for the grant's start — the browser's, not the
   *  server's, which is a day behind a firm in India every morning. */
  readonly validFrom?: string | undefined;
  readonly invitedBy: string;
}

export interface PortalInvitation {
  readonly membershipId: string;
  readonly userId: string;
  readonly grantId: string;
  /** When the link stops working. The token itself is never returned — see the
   *  port. */
  readonly expiresAt: string;
}

export class PortalInviteService {
  constructor(private readonly deps: Deps) {}

  /**
   * Invite one of a client's own people, and let them read that one client.
   *
   * THE ORDER IS THE DESIGN. Membership first, because it is the write that
   * refuses a duplicate and there is no point mailing anybody until it holds.
   * The grant second, so that by the time a link exists the account it belongs
   * to can already see something. The letter LAST, because it is the only step
   * that reaches outside this system: everything before it can be retried, and
   * a mail that has gone cannot be recalled.
   *
   * The failure that remains is a mail that does not send after the membership
   * and grant are written, and it is the survivable one — the contact exists,
   * the firm can see them on the screen, and re-inviting is a decision somebody
   * takes with the facts in front of them. The reverse order would mail a link
   * into a firm that then failed to create the membership behind it.
   */
  async invite(input: InvitePortalContactInput, actor: Actor): Promise<PortalInvitation> {
    const membership = await this.deps.memberships.inviteMember(
      {
        tenantId: input.tenantId,
        email: input.email,
        displayName: input.displayName,
        audience: "CLIENT_PORTAL",
        role: input.role ?? "client_contact",
        // Never, and it is not an oversight: the fee axis governs whether one of
        // the FIRM's people sees the firm's money. A client's own invoices are
        // theirs, and are decided by gate 4, not by this flag.
        commercialVisibility: false,
      },
      actor,
    );

    const grant = await this.deps.access.grant(
      {
        tenantId: input.tenantId,
        membershipId: membership.id,
        clientPartyId: input.clientPartyId,
        validFrom: input.validFrom,
        grantedBy: input.invitedBy,
      },
      actor,
    );

    // The letter has to name the firm or it reads as phishing: it arrives
    // unasked, from an address the reader has no reason to expect. Null when
    // the tenant row does not resolve — a broken state the mailer renders as
    // best it can rather than refusing to send.
    const names = await this.deps.firms.tenantNames([input.tenantId]);
    const expiresAt = await this.deps.identity.invitePortalContact(
      membership.userId,
      names.get(input.tenantId) ?? null,
    );

    return {
      membershipId: membership.id,
      userId: membership.userId,
      grantId: grant.id,
      expiresAt,
    };
  }
}
