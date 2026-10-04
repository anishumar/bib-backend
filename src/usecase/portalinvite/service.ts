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
// **It does not resend, and `resend` below is why that stayed true.** A second
// INVITE to somebody who already has a membership is still refused by
// `inviteMember` — re-inviting is a different act, on its own route, and the
// question behind it ("did they lose the link, or has somebody else taken over
// the account?") is answered one way only: the same address, always. Moving a
// contact's portal access to a different mailbox is a third act again, and is
// deliberately not built.
import type { Actor } from "../../domain/ledger/model";
import type { EventSink } from "../ledger/ports";
import {
  PortalContactInactive,
  PortalContactNotAClientLogin,
  PortalContactNotFound,
} from "../../domain/portalinvite/errors";
import type {
  PortalContactAccess,
  PortalContactIdentity,
  PortalContactMemberships,
  PortalFirmDirectory,
  PortalFirmTimeZone,
  PortalInviteSenders,
} from "./ports";

/** The audience a portal invitation is for, spelled once. A typo in the one
 *  comparison below would let a colleague be mailed the letter on which a
 *  CLIENT chooses a password, and nothing would fail. */
const CLIENT_PORTAL = "CLIENT_PORTAL";

interface Deps {
  readonly identity: PortalContactIdentity;
  readonly memberships: PortalContactMemberships;
  readonly access: PortalContactAccess;
  readonly firms: PortalFirmDirectory;
  /** Who the letter is from (Q059). Absent: from the firm, as before. */
  readonly senders?: PortalInviteSenders;
  /** Optional: without it the letter says UTC, as before (CA#50). */
  readonly timeZones?: PortalFirmTimeZone;
  /** `invite` records nothing of its own — the three writes under it each emit
   *  their own event. `resend` writes nothing, so without this it would be the
   *  only act in the product that mails a credential outside the firm and
   *  leaves no trace at all. */
  readonly events: EventSink;
}

export interface ResendPortalInviteInput {
  readonly tenantId: string;
  /** The MEMBERSHIP, never an email. The address is read off the account and
   *  there is no parameter that could change it — see the service method. */
  readonly membershipId: string;
  // No `resentBy`. `invite` carries one because the GRANT it writes records a
  // granter in its own row; this writes no row, and who did it is the ledger
  // event's actor. A second field holding the same id would be a second place
  // for it to be wrong.
}

export interface ResentPortalInvitation {
  readonly membershipId: string;
  readonly userId: string;
  /** When the new link stops working. The token is never returned, for the same
   *  reason it is never returned by `invite`. */
  readonly expiresAt: string;
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
      await this.firmZone(input.tenantId),
      (await this.deps.senders?.senderForClient(input.tenantId, input.clientPartyId)) ?? null,
    );

    return {
      membershipId: membership.id,
      userId: membership.userId,
      grantId: grant.id,
      expiresAt,
    };
  }

  /**
   * Send a client contact their invitation again.
   *
   * ── THE HOLE THIS CLOSES, AND WHY IT ONLY BECAME REAL RECENTLY ──────────
   *
   * `inviteMember` refuses a second invite to somebody who already holds a
   * membership, which cost nothing while a letter could not fail: the only
   * mailer wrote to a log. With a relay it fails — a bounce, a typo, a quota,
   * a mailbox full on the day — and the contact is then created, granted, and
   * permanently uninvitable. Staff have another door (the sign-in page issues
   * anyone a fresh link); a client contact who has never set a password has
   * none at all, which is why this is the client's route and not a general one.
   *
   * ── SAME ADDRESS, AND THAT IS THE WHOLE ANSWER ──────────────────────────
   *
   * The input carries a membership id and nothing else that could reach the
   * letter. The address comes off the account. Allowing it to be CHANGED here
   * would mean anybody holding a firm login could move a client's portal access
   * to a mailbox of their choosing — a new door, wanting its own event and
   * probably an approval, and not a thing to arrive as a side effect of a
   * button called "Send it again".
   *
   * ── THREE CHECKS, AND THE ORDER IS THE POINT ───────────────────────────
   *
   * This firm's row · a CLIENT_PORTAL login · still active. The first is the
   * tenant wall stated in code as well as in RLS; the second stops a colleague
   * being mailed the letter on which a client sets a password; the third stops
   * the firm writing to somebody it has already shut out. The fourth check —
   * has this person already accepted — belongs to identity, because the
   * password is identity's fact and nothing here can see it.
   *
   * The event is written AFTER the send, deliberately. Everything before the
   * letter can be retried; the letter cannot be recalled, and an event saying
   * an invitation went out when the relay refused it would be the one record of
   * this act, wrong.
   */
  async resend(input: ResendPortalInviteInput, actor: Actor): Promise<ResentPortalInvitation> {
    const membership = await this.deps.memberships.findMembership(
      input.tenantId,
      input.membershipId,
    );
    if (!membership) throw new PortalContactNotFound(input.membershipId);
    if (membership.audience !== CLIENT_PORTAL) {
      throw new PortalContactNotAClientLogin(input.membershipId, membership.audience);
    }
    if (!membership.isActive) throw new PortalContactInactive(input.membershipId);

    // Named for the same reason the first letter names it: this one also
    // arrives unasked, with a link in it, and an email that does not say which
    // firm it is from is a phishing message feature for feature.
    const names = await this.deps.firms.tenantNames([input.tenantId]);
    const sent = await this.deps.identity.resendPortalInvite(
      membership.userId,
      names.get(input.tenantId) ?? null,
      await this.firmZone(input.tenantId),
      (await this.deps.senders?.senderForContact(input.tenantId, membership.id)) ?? null,
    );

    await this.deps.events.recordEvent({
      tenantId: input.tenantId,
      actor,
      verb: "portal_invitation.resent",
      objectId: membership.id,
      // No address and no name. WHO was written to is the membership id, which
      // resolves to an ordinary erasable row — see EVENT-CONTRACT.md 3.4. WHO
      // sent it is the actor, which every event already carries, so putting
      // `resentBy` here as well would be the same fact recorded twice.
      payload: { supersededLinks: sent.supersededLinks },
    });

    return {
      membershipId: membership.id,
      userId: membership.userId,
      expiresAt: sent.expiresAt,
    };
  }

  /** The firm's zone for the letter's expiry, or null for UTC (CA#50). */
  private async firmZone(tenantId: string): Promise<string | null> {
    return this.deps.timeZones === undefined ? null : this.deps.timeZones.timeZoneFor(tenantId);
  }
}
