// Adding a colleague, and TELLING them (T7.2).
//
// ── THE GAP ────────────────────────────────────────────────────────────────
//
// `TenancyService.inviteMember` creates the account and the membership and
// stops there. Nothing left the building. The route's own description said so —
// *"No email is sent — they sign in with a magic link"* — and the People screen
// repeated it under the button, which is honest and is still a product that
// only works if somebody remembers to send a separate message by hand. A firm
// that adds five people on a Monday has five colleagues who do not know.
//
// ── WHY IT IS A SECOND USE CASE AND NOT A LINE INSIDE inviteMember ─────────
//
// Because `PortalInviteService` CALLS `inviteMember`, with `audience:
// "CLIENT_PORTAL"`, and then sends its own letter. A welcome letter buried
// inside the membership write would mail every client contact twice: once
// welcoming them to a staff product they cannot use, once inviting them to the
// portal. The two letters say different things to different people and the
// decision of which to send belongs to whoever knows WHY the membership is
// being created — which is here, and there, and not in the shared write.
//
// So the arrangement mirrors its neighbour exactly: one act made of existing
// parts, ports declared in this use case's own words, satisfied structurally.
//
// ── AND WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────
//
// **It does not resend.** A second add for somebody who already has a
// membership is refused by `inviteMember` before any letter is considered.
// Re-sending a welcome is a different act with a different question behind it
// ("did they lose it, or has somebody else taken the mailbox?") and belongs on
// its own route — the same open item the portal invite has.
//
// **It does not fail when the letter does not go.** See `welcomeStaff`: the
// membership is already written, a colleague has the login page as a way in
// regardless, and an administrator is watching a screen that can be told.
import type { Actor } from "../../domain/ledger/model";
import type { Audience, Membership } from "../../domain/tenancy/model";
import type { StaffFirmDirectory, StaffMemberships, StaffWelcomeIdentity } from "./ports";

/**
 * The firm's own people, as the domain spells it.
 *
 * Typed rather than written inline, because the port takes an audience as a
 * `string` — it has to, the route does — and a typo in this one comparison
 * would not fail anything. It would simply mean no colleague is ever written
 * to, silently, which is the exact state this file was built to end.
 */
const FIRM_STAFF: Audience = "STAFF";

interface Deps {
  readonly identity: StaffWelcomeIdentity;
  readonly memberships: StaffMemberships;
  readonly firms: StaffFirmDirectory;
}

export interface AddMemberInput {
  readonly tenantId: string;
  readonly email: string;
  readonly displayName?: string | undefined;
  readonly audience: string;
  readonly role: string;
  readonly commercialVisibility?: boolean | undefined;
}

export interface AddedMember {
  readonly membership: Membership;
  /** Whether a letter actually went. False is ordinary, not an error — the
   *  membership stands either way and the screen says which happened. */
  readonly invitationSent: boolean;
  /** When the link in that letter stops working. Null when none was sent. */
  readonly invitationExpiresAt: string | null;
}

export class StaffInviteService {
  constructor(private readonly deps: Deps) {}

  /**
   * Give somebody access to this firm, and write to them.
   *
   * THE ORDER IS THE DESIGN, and it is the same order as the portal invite's.
   * The membership first, because it is the write that refuses a duplicate and
   * there is no point mailing anybody until it holds. The letter LAST, because
   * it is the only step that reaches outside this system and a mail that has
   * gone cannot be recalled. The reverse would write to a colleague about a
   * firm that then failed to admit them.
   */
  async add(input: AddMemberInput, actor: Actor): Promise<AddedMember> {
    const membership = await this.deps.memberships.inviteMember(input, actor);

    // ── ONLY THE FIRM'S OWN PEOPLE ──────────────────────────────────────────
    //
    // A CLIENT_PORTAL membership can be created on this route, and it gets no
    // letter, deliberately. Made here it carries no gate-4 grant, so the portal
    // it opens onto shows nothing at all — writing to somebody to announce that
    // would be worse than the silence this file exists to end.
    // `PortalInviteService` is the door for a client, and it grants and writes
    // in one act precisely so that halfway state cannot be reached.
    if (input.audience !== FIRM_STAFF) {
      return { membership, invitationSent: false, invitationExpiresAt: null };
    }

    // The letter names the firm or it reads as phishing — it arrives unasked,
    // with a sign-in link in it. Null when the tenant row does not resolve, and
    // the mailer degrades the wording rather than refusing to send: a colleague
    // left unwritten-to is the failure this whole change is about.
    const names = await this.deps.firms.tenantNames([input.tenantId]);
    const welcome = await this.deps.identity.welcomeStaff(
      membership.userId,
      names.get(input.tenantId) ?? null,
    );

    return {
      membership,
      invitationSent: welcome.sent,
      invitationExpiresAt: welcome.expiresAt,
    };
  }
}
