// Sending a client contact their portal invitation AGAIN (T7.0b).
//
// ── WHAT THIS FILE IS GUARDING ─────────────────────────────────────────────
//
// "The letter went" is the least interesting assertion here. This route mails a
// CREDENTIAL to somebody outside the firm on a staff member's say-so, so what
// the tests are for is the three ways it must refuse to do that — a membership
// belonging to another firm, a colleague's login, and a contact the firm has
// already shut out — plus the one thing that can never become a parameter: the
// address.
//
// The last of those cannot be asserted by passing a bad value, because there is
// no field to pass it in. It is asserted the only way an absence can be: the
// service is handed a membership whose `userId` is known, and what reaches
// identity is proved to be THAT user and nothing the caller chose.
import { describe, expect, it } from "vitest";
import { PortalInviteService } from "../../src/usecase/portalinvite/service";
import type { PortalContactRow } from "../../src/usecase/portalinvite/ports";
import { PortalInviteError } from "../../src/domain/portalinvite/errors";
import { RecordingEventSink } from "../../src/testfakes/ledger";
import type { Actor } from "../../src/domain/ledger/model";

const TENANT = "11111111-1111-1111-1111-111111111111";
const MEMBERSHIP = "33333333-3333-3333-3333-333333333333";
const CONTACT_USER = "44444444-4444-4444-4444-444444444444";
const ACTOR: Actor = { type: "human", id: "22222222-2222-2222-2222-222222222222" };

const contact = (over: Partial<PortalContactRow> = {}): PortalContactRow => ({
  id: MEMBERSHIP,
  userId: CONTACT_USER,
  audience: "CLIENT_PORTAL",
  isActive: true,
  ...over,
});

class Recorder {
  row: PortalContactRow | null = contact();
  firmKnown = true;
  supersededLinks = 0;
  /** Set to make the relay refuse, so "the event is written after the send" is
   *  provable rather than asserted by reading the code. */
  relayDown = false;
  readonly resent: { userId: string; firmName: string | null }[] = [];

  findMembership(_t: string, _m: string): Promise<PortalContactRow | null> {
    return Promise.resolve(this.row);
  }
  // Neither is reached by `resend`, and both are present because each port is
  // one interface. They throw rather than resolve: a `resend` that fell through
  // to the FIRST invitation would create a membership and a grant, and a stub
  // that quietly answered would let that pass.
  inviteMember(): Promise<{ id: string; userId: string }> {
    return Promise.reject(new Error("resend must not create a membership"));
  }
  invitePortalContact(): Promise<string> {
    return Promise.reject(new Error("resend must go through resendPortalInvite"));
  }
  grantGroupOf(): Promise<{ readonly granted: readonly never[] }> {
    return Promise.resolve({ granted: [] });
  }

  grant(): Promise<{ id: string }> {
    return Promise.resolve({ id: "g" });
  }
  tenantNames(ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const names = new Map<string, string>();
    if (this.firmKnown) for (const id of ids) names.set(id, "10x Global");
    return Promise.resolve(names);
  }
  resendPortalInvite(
    userId: string,
    firmName: string | null,
  ): Promise<{ expiresAt: string; supersededLinks: number }> {
    this.resent.push({ userId, firmName });
    if (this.relayDown) return Promise.reject(new Error("relay refused the recipient"));
    return Promise.resolve({
      expiresAt: "2026-09-10T09:00:00.000Z",
      supersededLinks: this.supersededLinks,
    });
  }
}

function subject(r: Recorder): { service: PortalInviteService; events: RecordingEventSink } {
  const events = new RecordingEventSink();
  return {
    service: new PortalInviteService({
      identity: r,
      memberships: r,
      access: r,
      firms: r,
      events,
    }),
    events,
  };
}

const call = (s: PortalInviteService) =>
  s.resend({ tenantId: TENANT, membershipId: MEMBERSHIP }, ACTOR);

describe("PortalInviteService.resend", () => {
  it("refuses a membership this firm does not hold, and writes to nobody", async () => {
    const r = new Recorder();
    r.row = null;
    const { service, events } = subject(r);

    await expect(call(service)).rejects.toMatchObject({ code: "PORTAL_CONTACT_NOT_FOUND" });
    expect(r.resent).toEqual([]);
    expect(events.recorded).toEqual([]);
  });

  it("refuses a STAFF login — the letter it sends is the one a CLIENT sets a password on", async () => {
    const r = new Recorder();
    r.row = contact({ audience: "STAFF" });
    const { service } = subject(r);

    await expect(call(service)).rejects.toMatchObject({
      code: "PORTAL_CONTACT_NOT_A_CLIENT_LOGIN",
    });
    expect(r.resent).toEqual([]);
  });

  it("refuses a revoked contact rather than mailing somebody the firm has shut out", async () => {
    const r = new Recorder();
    r.row = contact({ isActive: false });
    const { service } = subject(r);

    await expect(call(service)).rejects.toMatchObject({ code: "PORTAL_CONTACT_INACTIVE" });
    expect(r.resent).toEqual([]);
  });

  it("all three refusals are one family, so the api layer maps them in one place", async () => {
    for (const row of [null, contact({ audience: "STAFF" }), contact({ isActive: false })]) {
      const r = new Recorder();
      r.row = row;
      const { service } = subject(r);
      await expect(call(service)).rejects.toBeInstanceOf(PortalInviteError);
    }
  });

  it("writes to the ACCOUNT's own user, which is the only address there is", async () => {
    const r = new Recorder();
    const { service } = subject(r);

    const out = await call(service);

    expect(r.resent).toEqual([{ userId: CONTACT_USER, firmName: "10x Global" }]);
    expect(out).toEqual({
      membershipId: MEMBERSHIP,
      userId: CONTACT_USER,
      expiresAt: "2026-09-10T09:00:00.000Z",
    });
  });

  it("names the firm, because an unasked-for letter with a link in it reads as phishing", async () => {
    const r = new Recorder();
    const { service } = subject(r);
    await call(service);
    expect(r.resent[0]?.firmName).toBe("10x Global");
  });

  it("still sends when the tenant row does not resolve — a nameless letter beats none", async () => {
    const r = new Recorder();
    r.firmKnown = false;
    const { service } = subject(r);

    await call(service);

    expect(r.resent).toEqual([{ userId: CONTACT_USER, firmName: null }]);
  });

  it("records it, with how many live invitations it superseded and NO address", async () => {
    const r = new Recorder();
    r.supersededLinks = 2;
    const { service, events } = subject(r);

    await call(service);

    expect(events.verbs()).toEqual(["portal_invitation.resent"]);
    const [event] = events.recorded;
    expect(event?.objectType).toBe("membership");
    expect(event?.objectId).toBe(MEMBERSHIP);
    expect(event?.actorId).toBe(ACTOR.id);
    expect(event?.payload).toEqual({ supersededLinks: 2 });
    // The address is personal data and the ledger cannot be erased. Asserted on
    // the serialised payload so a nested one could not slip past.
    expect(JSON.stringify(event?.payload)).not.toMatch(/@/);
  });

  it("records NOTHING when the relay refuses — the event must not claim a letter went", async () => {
    const r = new Recorder();
    r.relayDown = true;
    const { service, events } = subject(r);

    await expect(call(service)).rejects.toThrow(/relay refused/);
    expect(events.recorded).toEqual([]);
  });
});
