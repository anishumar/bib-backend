// Adding a colleague, and TELLING them (T7.2).
//
// ── WHAT THIS FILE IS ACTUALLY GUARDING ────────────────────────────────────
//
// The obvious assertion — "a letter went" — is the least interesting one here,
// because the mistake this use case exists to avoid is the OTHER kind: sending
// a letter to somebody who should not get one.
//
// `PortalInviteService` calls the same `inviteMember`, with `audience:
// "CLIENT_PORTAL"`, and then sends its OWN letter. Had the welcome been added
// inside the shared membership write — which is the smaller diff, and the
// wrong one — every client contact invited to a portal would receive two
// emails: one welcoming them to a staff product they cannot use, and one
// inviting them to the portal. So the negative case below is the reason this
// use case exists at all, and it is asserted first.
import { describe, expect, it } from "vitest";
import { StaffInviteService } from "../../src/usecase/staffinvite/service";
import type { AddMemberInput } from "../../src/usecase/staffinvite/service";
import type { Actor } from "../../src/domain/ledger/model";
import type { Audience, Membership } from "../../src/domain/tenancy/model";

const TENANT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const ACTOR: Actor = { type: "human", id: USER };

function membership(audience: Audience): Membership {
  return {
    id: "33333333-3333-3333-3333-333333333333",
    tenantId: TENANT,
    userId: USER,
    audience,
    role: audience === "STAFF" ? "manager" : "client_contact",
    commercialVisibility: false,
    gradeId: null,
    reportsToUserId: null,
    isActive: true,
  };
}

/** Records what it was asked to do, and can be told to refuse. */
class Recorder {
  readonly invited: AddMemberInput[] = [];
  readonly welcomed: { userId: string; firmName: string | null; timeZone?: string | null }[] = [];
  /** Set to make the relay refuse — the mail-is-down case. */
  relayDown = false;
  /** Set to make the tenant row not resolve. */
  firmKnown = true;
  /** Set to make the membership write fail, so the ORDER can be proven. */
  membershipFails = false;

  inviteMember(input: AddMemberInput, _actor: Actor): Promise<Membership> {
    if (this.membershipFails) return Promise.reject(new Error("duplicate membership"));
    this.invited.push(input);
    return Promise.resolve(membership(input.audience as Audience));
  }

  welcomeStaff(
    userId: string,
    firmName: string | null,
    timeZone?: string | null,
  ): Promise<{ expiresAt: string | null; sent: boolean }> {
    this.welcomed.push({ userId, firmName, ...(timeZone === undefined || timeZone === null ? {} : { timeZone }) });
    return Promise.resolve(
      this.relayDown
        ? { expiresAt: "2026-09-06T09:00:00.000Z", sent: false }
        : { expiresAt: "2026-09-06T09:00:00.000Z", sent: true },
    );
  }

  tenantNames(ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const names = new Map<string, string>();
    if (this.firmKnown) for (const id of ids) names.set(id, "10x Global");
    return Promise.resolve(names);
  }
}

function subject(r: Recorder): StaffInviteService {
  return new StaffInviteService({ identity: r, memberships: r, firms: r });
}

function input(audience: Audience): AddMemberInput {
  return {
    tenantId: TENANT,
    email: "priya@10xglobal.in",
    audience,
    role: audience === "STAFF" ? "manager" : "client_contact",
  };
}

describe("a CLIENT_PORTAL membership made here gets NO letter", () => {
  it("is silent, because this route grants no portal access", async () => {
    // THE REGRESSION THIS FILE EXISTS FOR. A membership made on the staff route
    // carries no gate-4 grant, so the portal it opens onto shows nothing at
    // all — and `PortalInviteService`, which is the right door, sends its own
    // letter after granting. A welcome here is either an announcement of an
    // empty portal or a second email for the same person.
    const r = new Recorder();
    const added = await subject(r).add(input("CLIENT_PORTAL"), ACTOR);

    expect(r.invited).toHaveLength(1);
    expect(r.welcomed).toEqual([]);
    expect(added.invitationSent).toBe(false);
    expect(added.invitationExpiresAt).toBeNull();
    // And the membership is still returned — not writing is not refusing.
    expect(added.membership.audience).toBe("CLIENT_PORTAL");
  });
});

describe("a STAFF membership is written to", () => {
  it("sends, names the firm, and reports the expiry", async () => {
    const r = new Recorder();
    const added = await subject(r).add(input("STAFF"), ACTOR);

    expect(r.welcomed).toEqual([{ userId: USER, firmName: "10x Global" }]);
    expect(added.invitationSent).toBe(true);
    expect(added.invitationExpiresAt).toBe("2026-09-06T09:00:00.000Z");
  });

  it("writes to the person the membership resolved to, not to the typed address", async () => {
    // ADR-02: an email that already has an account LINKS to that person. The
    // letter must follow the account, or a second person with a similar address
    // gets a link into somebody else's firm.
    const r = new Recorder();
    await subject(r).add(input("STAFF"), ACTOR);
    expect(r.welcomed[0]?.userId).toBe(USER);
  });

  it("still sends when the firm's name does not resolve", async () => {
    // The letter degrades its wording rather than not going: a colleague left
    // unwritten-to is the exact failure this change exists to end.
    const r = new Recorder();
    r.firmKnown = false;
    const added = await subject(r).add(input("STAFF"), ACTOR);

    expect(r.welcomed).toEqual([{ userId: USER, firmName: null }]);
    expect(added.invitationSent).toBe(true);
  });
});

describe("a refused relay does not undo the membership", () => {
  it("reports the failure and keeps the member", async () => {
    // Throwing would be worse than useless here: the membership is already
    // written by the time the letter is attempted, so a 500 would leave a
    // member created, an admin believing the add failed, and a retry refused as
    // a duplicate. The screen is told instead.
    const r = new Recorder();
    r.relayDown = true;
    const added = await subject(r).add(input("STAFF"), ACTOR);

    expect(added.membership.id).toBe("33333333-3333-3333-3333-333333333333");
    expect(added.invitationSent).toBe(false);
    // The attempt happened — otherwise this passes on code that never tried.
    expect(r.welcomed).toHaveLength(1);
  });
});

describe("the order is the design", () => {
  it("does not write to anybody when the membership is refused", async () => {
    // The reverse order would mail a colleague about a firm that then failed to
    // admit them, and a mail that has gone cannot be recalled. `inviteMember`
    // is also what refuses a DUPLICATE, so this is the everyday path: adding
    // somebody twice must not send them a second link.
    const r = new Recorder();
    r.membershipFails = true;

    await expect(subject(r).add(input("STAFF"), ACTOR)).rejects.toThrow("duplicate membership");
    expect(r.welcomed).toEqual([]);
  });
});

describe("the welcome letter's clock (audit 2026-10-03, CA#50)", () => {
  it("is the firm's: its zone goes to the letter with its name", async () => {
    const r = new Recorder();
    const service = new StaffInviteService({
      identity: r,
      memberships: r,
      firms: r,
      timeZones: { timeZoneFor: () => Promise.resolve("Asia/Kolkata") },
    });
    await service.add(input("STAFF"), ACTOR);
    expect(r.welcomed).toEqual([expect.objectContaining({ firmName: "10x Global", timeZone: "Asia/Kolkata" })]);
  });
});
