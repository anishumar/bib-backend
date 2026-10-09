// Inviting a client's own person into the portal (T6.5). One act, three writes: a CLIENT_PORTAL
// membership, gate 4's grant, then the letter. As separate calls each halfway state is silent
// (membership without grant shows an empty portal; without letter, an unreachable account).
// Grants ONE client by default: G3.4 rests on access granted per company, never derived (Q064
// adds an explicit group option). Never sets a password; the firm never holds it. A second
// invite is refused by `inviteMember`; `resend` is its own act, always to the same address.
// Moving access to a different mailbox is deliberately not built.
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

/** Spelled once: a typo would silently mail a colleague a client's set-password letter. */
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
  /** For `resend`, which writes no row and would otherwise mail a credential with no trace. `invite`'s writes emit their own. */
  readonly events: EventSink;
}

export interface ResendPortalInviteInput {
  readonly tenantId: string;
  /** The membership, never an email: the address comes off the account and cannot be changed here. */
  readonly membershipId: string;
  // No `resentBy`: this writes no row; who did it is the event's actor.
}

export interface ResentPortalInvitation {
  readonly membershipId: string;
  readonly userId: string;
  /** When the new link stops working. The token is never returned. */
  readonly expiresAt: string;
}

export interface InvitePortalContactInput {
  readonly tenantId: string;
  readonly email: string;
  readonly displayName?: string | undefined;
  /** The one company this contact may read. Required: a login with no grant opens onto nothing. */
  readonly clientPartyId: string;
  /** Defaults to the seeded `client_contact` role, which has no permissions: gate 2 admits a portal session only to `PORTAL_PATHS`, which need none. */
  readonly role?: string | undefined;
  /** The caller's calendar day for the grant's start; the server's UTC day is a day behind India each morning. */
  readonly validFrom?: string | undefined;
  readonly invitedBy: string;
  /** Also grant the rest of the client's group, one grant per company (Q064).
   *  Absent or false: this one company, as before. */
  readonly alsoGroup?: boolean | undefined;
}

export interface PortalInvitation {
  readonly membershipId: string;
  readonly userId: string;
  readonly grantId: string;
  /** The group's other companies granted in the same act (Q064). */
  readonly alsoGranted: readonly { readonly clientPartyId: string; readonly clientName: string }[];
  /** When the link stops working. The token is never returned (see the port). */
  readonly expiresAt: string;
}

export class PortalInviteService {
  constructor(private readonly deps: Deps) {}

  /**
   * Invite one of a client's own people and let them read that one client.
   * Order is the design: membership first (refuses a duplicate), grant second (the link opens
   * onto something), letter LAST (the only step that cannot be recalled). A failed send leaves
   * a visible, survivable contact; the reverse order could mail a link to no membership.
   */
  async invite(input: InvitePortalContactInput, actor: Actor): Promise<PortalInvitation> {
    const membership = await this.deps.memberships.inviteMember(
      {
        tenantId: input.tenantId,
        email: input.email,
        displayName: input.displayName,
        audience: "CLIENT_PORTAL",
        role: input.role ?? "client_contact",
        // Deliberately false: the fee axis is for firm staff; a client's invoices are gate 4's.
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
    // The group (Q064), one grant per company, before the letter goes.
    const group =
      input.alsoGroup === true
        ? await this.deps.access.grantGroupOf(
            {
              tenantId: input.tenantId,
              membershipId: membership.id,
              clientPartyId: input.clientPartyId,
              validFrom: input.validFrom,
              grantedBy: input.invitedBy,
            },
            actor,
          )
        : { granted: [] };

    // The letter names the firm or it reads as phishing. Null if the tenant does not resolve; the mailer still sends.
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
      alsoGranted: group.granted.map((g) => ({ clientPartyId: g.clientPartyId, clientName: g.clientName })),
      expiresAt,
    };
  }

  /**
   * Send a client contact their invitation again. With a real relay a first letter can fail
   * (bounce, typo, quota) and leave the contact granted but uninvitable; staff can use sign-in,
   * a client who never set a password cannot. Same address always: changing it here would let
   * any firm login move a client's portal access to its own mailbox.
   * Checks in order: this firm's row (tenant wall in code too), a CLIENT_PORTAL login, still
   * active. "Already accepted" is identity's check. The event is written AFTER the send, so a
   * refused relay never leaves a record saying it went.
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

    // Names the firm, as `invite` does, or it reads as phishing.
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
      // No address or name: the membership id resolves to an erasable row (EVENT-CONTRACT.md 3.4).
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
