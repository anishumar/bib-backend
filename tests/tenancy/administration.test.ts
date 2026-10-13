// Firm administration — the half of tenancy that did not exist until now.
//
// Everything in service.test.ts is PROVISIONING: the platform creating firms
// with no end user behind it. This is a firm running itself — a partner with a
// session deciding who works there and what they may do.
//
// The property being restored is in the last block: a firm can stop somebody's
// access. `is_active` and its grant have existed since migration 0001, and
// `resolveSession` has re-read the membership on every request since T1.7 so
// revocation lands on the NEXT one — for a switch nothing could flip.
import { describe, expect, it } from "vitest";
import { TenancyService } from "../../src/usecase/tenancy/service";
import { NoAxesDefined } from "../../src/testfakes/serviceaxis";
import { ConfigService } from "../../src/usecase/config/service";
import { makeFakes } from "../../src/testfakes/tenancy";
import {
  FeesAreStaffOnly,
  LastAdministrator,
  MembershipExists,
  MembershipNotFound,
  RoleNotDefined,
  DefaultSignatoryCannotRetire,
  InvalidSignatoryTitle,
  SignatoryAlreadyListed,
  SignatoryNotAMember,
  SignatoryNotFound,
  SignatoryRetired,
  SignatureNotDrawable,
} from "../../src/domain/tenancy/errors";

const ACTOR = { type: "human" as const, id: "00000000-0000-4000-8000-0000000000e1" };

/** A firm with one partner — the smallest state a real firm is ever in, since
 *  createTenant seeds the roles and somebody has to be able to administer it. */
async function firm() {
  const f = makeFakes();
  const service = new TenancyService(f);
  const tenant = await service.createTenant({ name: "Harbour Point", slug: "harbour-point", reportingCurrency: "INR" });
  const owner = await service.ensureUser("partner@harbour.example", "Anita Rao");
  const ownerMembership = await service.addMember({
    tenantId: tenant.id,
    userId: owner.id,
    audience: "STAFF",
    role: "partner",
    commercialVisibility: true,
  });
  // The registry the firm's roles live in, for tests that publish a new one.
  const config = new ConfigService({
    registry: f.config,
    holders: f.memberships,
    axes: new NoAxesDefined(),
    ids: f.ids,
    events: f.events,
  });
  return { service, f, tenant, owner, ownerMembership, config };
}

describe("the roster", () => {
  it("shows people, not user ids", async () => {
    const { service, tenant } = await firm();
    const [row] = await service.listMembers(tenant.id);
    expect(row?.email).toBe("partner@harbour.example");
    expect(row?.displayName).toBe("Anita Rao");
    expect(row?.membership.role).toBe("partner");
  });

  it("includes people whose access was revoked", async () => {
    // An admin needs to see who was removed, and be able to put them back.
    const { service, tenant } = await firm();
    const second = await service.inviteMember(
      { tenantId: tenant.id, email: "leaver@harbour.example", audience: "STAFF", role: "associate", commercialVisibility: false },
      ACTOR,
    );
    await service.setMemberActive(
      { tenantId: tenant.id, membershipId: second.id, isActive: false },
      ACTOR,
    );
    const roster = await service.listMembers(tenant.id);
    expect(roster).toHaveLength(2);
    expect(roster.find((r) => r.membership.id === second.id)?.membership.isActive).toBe(false);
  });

  it("falls back to the email when nobody has named the account", async () => {
    const { service, tenant } = await firm();
    await service.inviteMember(
      { tenantId: tenant.id, email: "nameless@harbour.example", audience: "STAFF", role: "associate", commercialVisibility: false },
      ACTOR,
    );
    const row = (await service.listMembers(tenant.id)).find(
      (r) => r.email === "nameless@harbour.example",
    );
    expect(row?.displayName).toBeNull();
  });
});

describe("the colleagues picker", () => {
  it("names active staff and never carries an email", async () => {
    const { service, tenant } = await firm();
    const leaver = await service.inviteMember(
      { tenantId: tenant.id, email: "leaver@harbour.example", audience: "STAFF", role: "associate", commercialVisibility: false },
      ACTOR,
    );
    await service.setMemberActive({ tenantId: tenant.id, membershipId: leaver.id, isActive: false }, ACTOR);
    await service.inviteMember(
      { tenantId: tenant.id, email: "cfo@client.example", audience: "CLIENT_PORTAL", role: "client_contact", commercialVisibility: false },
      ACTOR,
    );

    const picker = await service.listColleagues(tenant.id);
    // The partner, and neither the person let go nor the client contact.
    expect(picker.map((p) => p.displayName)).toEqual(["Anita Rao"]);
    expect(picker[0]?.role).toBe("partner");
    // The roster's email is the reason it is tenant:admin; the picker must not
    // reintroduce it under a wider permission.
    expect(JSON.stringify(picker)).not.toContain("@");
  });
});

describe("giving somebody access", () => {
  it("creates the account and the membership, and records the grant", async () => {
    const { service, f, tenant } = await firm();
    const before = f.events.recorded.length;
    const membership = await service.inviteMember(
      { tenantId: tenant.id, email: "rahul@harbour.example", audience: "STAFF", role: "associate", commercialVisibility: false, displayName: "Rahul Iyer" },
      ACTOR,
    );
    expect(membership.role).toBe("associate");
    expect(f.events.recorded.slice(before).map((e) => e.verb)).toEqual(["membership.granted"]);
    expect(f.users.rows.find((u) => u.email === "rahul@harbour.example")?.displayName).toBe(
      "Rahul Iyer",
    );
  });

  it("links an email that already has an account rather than duplicating it", async () => {
    // ADR-02: one human, one login, however many firms.
    const { service, f, tenant } = await firm();
    const other = await service.ensureUser("consultant@elsewhere.example", "Priya Menon");
    await service.inviteMember(
      { tenantId: tenant.id, email: "consultant@elsewhere.example", audience: "STAFF", role: "associate", commercialVisibility: false },
      ACTOR,
    );
    expect(f.users.rows.filter((u) => u.email === "consultant@elsewhere.example")).toHaveLength(1);
    const row = (await service.listMembers(tenant.id)).find(
      (r) => r.membership.userId === other.id,
    );
    expect(row).toBeDefined();
  });

  it("does not rename somebody because a second firm invited them", async () => {
    const { service, f, tenant } = await firm();
    await service.ensureUser("consultant@elsewhere.example", "Priya Menon");
    await service.inviteMember(
      { tenantId: tenant.id, email: "consultant@elsewhere.example", audience: "STAFF", role: "associate", commercialVisibility: false, displayName: "P. M." },
      ACTOR,
    );
    expect(f.users.rows.find((u) => u.email === "consultant@elsewhere.example")?.displayName).toBe(
      "Priya Menon",
    );
  });

  it("refuses a role the firm has not published", async () => {
    // Otherwise the person signs in, carries nothing, and the firm reads it as
    // the product being broken.
    const { service, tenant } = await firm();
    const err = await service
      .inviteMember(
        { tenantId: tenant.id, email: "x@harbour.example", audience: "STAFF", role: "rainmaker", commercialVisibility: false },
        ACTOR,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoleNotDefined);
    expect((err as Error).message).toContain("partner");
  });

  it("refuses to re-add somebody who is already here", async () => {
    // "Add" must not double as "reinstate": that should be a decision, not a
    // side effect.
    const { service, tenant } = await firm();
    const input = { tenantId: tenant.id, email: "rahul@harbour.example", audience: "STAFF" as const, role: "associate", commercialVisibility: false };
    await service.inviteMember(input, ACTOR);
    await expect(service.inviteMember(input, ACTOR)).rejects.toBeInstanceOf(MembershipExists);
  });

  it("can grant CLIENT_PORTAL access, which is how a client contact gets in", async () => {
    const { service, tenant } = await firm();
    const membership = await service.inviteMember(
      { tenantId: tenant.id, email: "ceo@lakeview.example", audience: "CLIENT_PORTAL", role: "client_contact", commercialVisibility: false },
      ACTOR,
    );
    expect(membership.audience).toBe("CLIENT_PORTAL");
  });

  it("lets a firm assign a role it invented itself", async () => {
    // The thing T2.5 made possible and nothing could use: define "rm", publish
    // it, give it to somebody.
    const { service, tenant, config } = await firm();
    await config.define(
      { tenantId: tenant.id, kind: "role", key: "rm", body: { label: "Relationship manager", permissions: ["party:read"] } },
      ACTOR,
    );
    await config.publish({ tenantId: tenant.id, kind: "role", key: "rm", version: 1 }, ACTOR);

    const membership = await service.inviteMember(
      { tenantId: tenant.id, email: "rm@harbour.example", audience: "STAFF", role: "rm", commercialVisibility: false },
      ACTOR,
    );
    expect(membership.role).toBe("rm");
  });
});

describe("changing what a member may do", () => {
  it("records the change, naming what it was before", async () => {
    const { service, f, tenant } = await firm();
    const member = await service.inviteMember(
      { tenantId: tenant.id, email: "rahul@harbour.example", audience: "STAFF", role: "associate", commercialVisibility: false },
      ACTOR,
    );
    const updated = await service.changeMemberRole(
      { tenantId: tenant.id, membershipId: member.id, role: "manager" },
      ACTOR,
    );
    expect(updated.role).toBe("manager");

    const last = f.events.recorded.at(-1);
    expect(last?.verb).toBe("membership.role_changed");
    expect(last?.payload["from"]).toBe("associate");
    expect(last?.payload["to"]).toBe("manager");
    expect(last?.actorId).toBe(ACTOR.id);
  });

  it("records nothing when the role does not change", async () => {
    const { service, f, tenant, ownerMembership } = await firm();
    const before = f.events.recorded.length;
    await service.changeMemberRole(
      { tenantId: tenant.id, membershipId: ownerMembership.id, role: "partner" },
      ACTOR,
    );
    expect(f.events.recorded).toHaveLength(before);
  });

  it("refuses a role the firm has not published", async () => {
    const { service, tenant, ownerMembership } = await firm();
    await expect(
      service.changeMemberRole(
        { tenantId: tenant.id, membershipId: ownerMembership.id, role: "rainmaker" },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(RoleNotDefined);
  });

  it("refuses a membership that is not this firm's", async () => {
    const { service, tenant } = await firm();
    await expect(
      service.changeMemberRole(
        { tenantId: tenant.id, membershipId: "00000000-0000-4000-8000-00000000dead", role: "manager" },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(MembershipNotFound);
  });
});

describe("showing a member fees (QA 2026-10-13)", () => {
  it("promoting somebody leaves their fees hidden, and the fee switch shows them", async () => {
    const { service, f, tenant } = await firm();
    const member = await service.inviteMember(
      { tenantId: tenant.id, email: "kunal@harbour.example", audience: "STAFF", role: "associate", commercialVisibility: false },
      ACTOR,
    );
    const promoted = await service.changeMemberRole(
      { tenantId: tenant.id, membershipId: member.id, role: "partner" },
      ACTOR,
    );
    expect(promoted.commercialVisibility).toBe(false);

    const shown = await service.setMemberFees(
      { tenantId: tenant.id, membershipId: member.id, commercialVisibility: true },
      ACTOR,
    );
    expect(shown.commercialVisibility).toBe(true);
    expect(shown.role).toBe("partner");
    const last = f.events.recorded.at(-1);
    expect(last?.verb).toBe("membership.fees_visibility_changed");
    expect(last?.payload).toEqual({ userId: member.userId, from: false, to: true });
    expect(JSON.stringify(last?.payload)).not.toContain("@");
  });

  it("records nothing when the setting does not change", async () => {
    const { service, f, tenant, ownerMembership } = await firm();
    const before = f.events.recorded.length;
    await service.setMemberFees(
      { tenantId: tenant.id, membershipId: ownerMembership.id, commercialVisibility: true },
      ACTOR,
    );
    expect(f.events.recorded).toHaveLength(before);
  });

  it("refuses a client contact, and a membership that is not this firm's", async () => {
    const { service, tenant } = await firm();
    const contact = await service.inviteMember(
      { tenantId: tenant.id, email: "cfo@client.example", audience: "CLIENT_PORTAL", role: "client_contact", commercialVisibility: false },
      ACTOR,
    );
    await expect(
      service.setMemberFees({ tenantId: tenant.id, membershipId: contact.id, commercialVisibility: true }, ACTOR),
    ).rejects.toBeInstanceOf(FeesAreStaffOnly);
    await expect(
      service.setMemberFees(
        { tenantId: tenant.id, membershipId: "00000000-0000-4000-8000-00000000dead", commercialVisibility: true },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(MembershipNotFound);
  });
});

describe("the firm cannot lose its last administrator", () => {
  it("refuses to demote the only person who can administer it", async () => {
    // Unrecoverable from inside the product: administering is what changes
    // roles, so nobody could change it back.
    const { service, tenant, ownerMembership } = await firm();
    const err = await service
      .changeMemberRole(
        { tenantId: tenant.id, membershipId: ownerMembership.id, role: "manager" },
        ACTOR,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LastAdministrator);
    expect((err as Error).message).toContain("tenant:admin");
  });

  it("refuses to revoke their access either", async () => {
    // Same unrecoverable state, reached the other way.
    const { service, tenant, ownerMembership } = await firm();
    await expect(
      service.setMemberActive(
        { tenantId: tenant.id, membershipId: ownerMembership.id, isActive: false },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(LastAdministrator);
  });

  it("allows both once somebody else can administer the firm", async () => {
    const { service, tenant, ownerMembership } = await firm();
    await service.inviteMember(
      { tenantId: tenant.id, email: "second@harbour.example", audience: "STAFF", role: "partner", commercialVisibility: true },
      ACTOR,
    );
    await expect(
      service.changeMemberRole(
        { tenantId: tenant.id, membershipId: ownerMembership.id, role: "manager" },
        ACTOR,
      ),
    ).resolves.toBeDefined();
  });

  it("counts only ACTIVE administrators", async () => {
    // A deactivated partner is not somebody who can put the firm right.
    const { service, tenant, ownerMembership } = await firm();
    const second = await service.inviteMember(
      { tenantId: tenant.id, email: "second@harbour.example", audience: "STAFF", role: "partner", commercialVisibility: true },
      ACTOR,
    );
    await service.setMemberActive(
      { tenantId: tenant.id, membershipId: second.id, isActive: false },
      ACTOR,
    );
    await expect(
      service.setMemberActive(
        { tenantId: tenant.id, membershipId: ownerMembership.id, isActive: false },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(LastAdministrator);
  });
});

describe("revoking and restoring access", () => {
  async function withColleague() {
    const f = await firm();
    const member = await f.service.inviteMember(
      { tenantId: f.tenant.id, email: "rahul@harbour.example", audience: "STAFF", role: "associate", commercialVisibility: false },
      ACTOR,
    );
    return { ...f, member };
  }

  it("revokes, and says so in the ledger", async () => {
    const { service, f, tenant, member } = await withColleague();
    const revoked = await service.setMemberActive(
      { tenantId: tenant.id, membershipId: member.id, isActive: false },
      ACTOR,
    );
    expect(revoked.isActive).toBe(false);
    expect(f.events.recorded.at(-1)?.verb).toBe("membership.revoked");
  });

  it("restores, and says that differently", async () => {
    const { service, f, tenant, member } = await withColleague();
    await service.setMemberActive({ tenantId: tenant.id, membershipId: member.id, isActive: false }, ACTOR);
    const restored = await service.setMemberActive(
      { tenantId: tenant.id, membershipId: member.id, isActive: true },
      ACTOR,
    );
    expect(restored.isActive).toBe(true);
    expect(f.events.recorded.at(-1)?.verb).toBe("membership.restored");
  });

  it("records nothing when the state does not change", async () => {
    const { service, f, tenant, member } = await withColleague();
    const before = f.events.recorded.length;
    await service.setMemberActive({ tenantId: tenant.id, membershipId: member.id, isActive: true }, ACTOR);
    expect(f.events.recorded).toHaveLength(before);
  });

  it("names the person by id, never by email", async () => {
    // The ledger cannot be erased; an email address in it could not be taken
    // out on request. The membership row it points at can.
    const { service, f, tenant, member } = await withColleague();
    await service.setMemberActive({ tenantId: tenant.id, membershipId: member.id, isActive: false }, ACTOR);
    const dump = JSON.stringify(f.events.recorded);
    expect(dump).not.toContain("rahul@harbour.example");
    expect(f.events.recorded.at(-1)?.payload["userId"]).toBe(member.userId);
  });
});

// ── Who binds the firm (G1.4) ──────────────────────────────────────────────
//
// "Unki ek hi signature rahegi" — one signatory for the whole firm, whichever
// of its entities issues the document. A ROW rather than a hardcode, so a
// successor is an UPDATE and it is still true for the second tenant on the
// installation.

describe("the firm's standing signatory", () => {
  it("is nobody until somebody says otherwise", async () => {
    // A new firm has named no signatory, and that is a state it operates in
    // perfectly well — its letters simply go out with no signature block.
    const { service, tenant } = await firm();
    expect(await service.firmSignatory(tenant.id)).toBeNull();
  });

  it("names a person and the capacity they sign in", async () => {
    const { service, tenant, owner } = await firm();
    const named = await service.setFirmSignatory(
      { tenantId: tenant.id, userId: owner.id, title: "Director" },
      ACTOR,
    );
    expect(named).toMatchObject({ userId: owner.id, displayName: "Anita Rao", title: "Director" });
    expect(await service.firmSignatory(tenant.id)).toEqual(named);
  });

  it("records the decision, without the person's name or address", async () => {
    // The id and the CAPACITY are machine facts about the firm's own
    // configuration. The name and the email are personal data, and this log
    // cannot be erased.
    const { service, f, tenant, owner } = await firm();
    await service.setFirmSignatory(
      { tenantId: tenant.id, userId: owner.id, title: "Director" },
      ACTOR,
    );
    const event = f.events.recorded.find((e) => e.verb === "firm_signatory.set");
    expect(event?.objectId).toBe(tenant.id);
    expect(event?.actorId).toBe(ACTOR.id);
    expect(event?.payload).toEqual({ userId: owner.id, title: "Director" });
  });

  it("refuses somebody who does not work here", async () => {
    // `tenancy.user_account` is GLOBAL, so the foreign key would happily accept
    // a login at another firm. Authority to bind is the strongest thing anybody
    // holds in this product and the one requirement worth stating is that they
    // work here.
    const { service, tenant } = await firm();
    const stranger = await service.ensureUser("someone@elsewhere.example");
    await expect(
      service.setFirmSignatory(
        { tenantId: tenant.id, userId: stranger.id, title: "Director" },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(SignatoryNotAMember);
  });

  it("refuses somebody whose access was revoked", async () => {
    // Somebody who used to work here cannot bind the firm today.
    const { service, tenant } = await firm();
    const second = await service.inviteMember(
      {
        tenantId: tenant.id,
        email: "manager@harbour.example",
        audience: "STAFF",
        role: "partner",
        commercialVisibility: true,
      },
      ACTOR,
    );
    await service.setMemberActive(
      { tenantId: tenant.id, membershipId: second.id, isActive: false },
      ACTOR,
    );
    await expect(
      service.setFirmSignatory(
        { tenantId: tenant.id, userId: second.userId, title: "Director" },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(SignatoryNotAMember);
  });

  it("refuses a client-portal member", async () => {
    // A CLIENT_PORTAL membership is a client of the firm, not a person who can
    // commit it to anything.
    const { service, tenant } = await firm();
    const client = await service.inviteMember(
      {
        tenantId: tenant.id,
        email: "contact@acme.example",
        audience: "CLIENT_PORTAL",
        role: "partner",
        commercialVisibility: false,
      },
      ACTOR,
    );
    await expect(
      service.setFirmSignatory(
        { tenantId: tenant.id, userId: client.userId, title: "Director" },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(SignatoryNotAMember);
  });

  it("lets a successor take over, which is the whole reason it is a row", async () => {
    const { service, tenant, owner } = await firm();
    await service.setFirmSignatory(
      { tenantId: tenant.id, userId: owner.id, title: "Director" },
      ACTOR,
    );
    const successor = await service.inviteMember(
      {
        tenantId: tenant.id,
        email: "successor@harbour.example",
        audience: "STAFF",
        role: "partner",
        commercialVisibility: true,
      },
      ACTOR,
    );
    await service.setFirmSignatory(
      { tenantId: tenant.id, userId: successor.userId, title: "Managing Partner" },
      ACTOR,
    );
    expect((await service.firmSignatory(tenant.id))?.userId).toBe(successor.userId);
  });
});

// ── The list of signatories (0343, Q005) ────────────────────────────────────
//
// "pls add option to add signatories and then the drop down at the time of
// finalizing EL to select who will sign that particular EL" (Ashish, 30 Sep
// 2026). Firm-wide; the default stays on the tenant row.

describe("the list of signatories", () => {
  async function withColleague() {
    const base = await firm();
    const colleague = await base.service.inviteMember(
      {
        tenantId: base.tenant.id,
        email: "partner2@harbour.example",
        audience: "STAFF",
        role: "partner",
        commercialVisibility: true,
      },
      ACTOR,
    );
    return { ...base, colleague };
  }

  it("puts the firm's first signatory on the list AS its default", async () => {
    // A list with entries and no default would still send letters with a
    // blank block, so the first one is the default whatever was asked.
    const { service, tenant, owner } = await firm();
    const added = await service.addSignatory({ tenantId: tenant.id, userId: owner.id, title: "Director" }, ACTOR);
    expect(added.isDefault).toBe(true);
    expect(await service.firmSignatory(tenant.id)).toMatchObject({ userId: owner.id, signatoryId: added.id });
  });

  it("adds a second signatory without moving the default", async () => {
    const { service, tenant, owner, colleague } = await withColleague();
    await service.addSignatory({ tenantId: tenant.id, userId: owner.id, title: "Director" }, ACTOR);
    const second = await service.addSignatory(
      { tenantId: tenant.id, userId: colleague.userId, title: "Partner" },
      ACTOR,
    );
    expect(second.isDefault).toBe(false);
    expect((await service.firmSignatory(tenant.id))?.userId).toBe(owner.id);
    const list = await service.listSignatories(tenant.id);
    expect(list.map((s) => [s.title, s.isDefault])).toEqual([
      ["Director", true],
      ["Partner", false],
    ]);
  });

  it("lists one person once", async () => {
    const { service, tenant, owner } = await firm();
    await service.addSignatory({ tenantId: tenant.id, userId: owner.id, title: "Director" }, ACTOR);
    await expect(
      service.addSignatory({ tenantId: tenant.id, userId: owner.id, title: "Partner" }, ACTOR),
    ).rejects.toBeInstanceOf(SignatoryAlreadyListed);
  });

  it("refuses a blank title and somebody who does not work here", async () => {
    const { service, tenant, owner } = await firm();
    await expect(
      service.addSignatory({ tenantId: tenant.id, userId: owner.id, title: "  " }, ACTOR),
    ).rejects.toBeInstanceOf(InvalidSignatoryTitle);
    const stranger = await service.ensureUser("someone@elsewhere.example");
    await expect(
      service.addSignatory({ tenantId: tenant.id, userId: stranger.id, title: "Director" }, ACTOR),
    ).rejects.toBeInstanceOf(SignatoryNotAMember);
  });

  it("moves the default, and renaming the default's title moves the tenant's copy", async () => {
    const { service, tenant, owner, colleague } = await withColleague();
    await service.addSignatory({ tenantId: tenant.id, userId: owner.id, title: "Director" }, ACTOR);
    const second = await service.addSignatory(
      { tenantId: tenant.id, userId: colleague.userId, title: "Partner" },
      ACTOR,
    );
    await service.makeDefaultSignatory(tenant.id, second.id, ACTOR);
    await service.changeSignatory({ tenantId: tenant.id, signatoryId: second.id, title: "Managing Partner" }, ACTOR);
    expect(await service.firmSignatory(tenant.id)).toMatchObject({
      userId: colleague.userId,
      title: "Managing Partner",
    });
  });

  it("never retires the default, and a retired signatory cannot become it", async () => {
    const { service, tenant, owner, colleague } = await withColleague();
    const first = await service.addSignatory({ tenantId: tenant.id, userId: owner.id, title: "Director" }, ACTOR);
    const second = await service.addSignatory(
      { tenantId: tenant.id, userId: colleague.userId, title: "Partner" },
      ACTOR,
    );
    await expect(service.setSignatoryActive(tenant.id, first.id, false, ACTOR)).rejects.toBeInstanceOf(
      DefaultSignatoryCannotRetire,
    );
    const retired = await service.setSignatoryActive(tenant.id, second.id, false, ACTOR);
    expect(retired.isActive).toBe(false);
    await expect(service.makeDefaultSignatory(tenant.id, second.id, ACTOR)).rejects.toBeInstanceOf(
      SignatoryRetired,
    );
    expect((await service.setSignatoryActive(tenant.id, second.id, true, ACTOR)).isActive).toBe(true);
  });

  it("takes a PNG or JPEG as a signature, and nothing else", async () => {
    const { service, f, tenant, owner } = await firm();
    const s = await service.addSignatory({ tenantId: tenant.id, userId: owner.id, title: "Director" }, ACTOR);
    f.signatories.versions.set("00000000-0000-4000-8000-0000000000a1", "image/png");
    f.signatories.versions.set("00000000-0000-4000-8000-0000000000a2", "application/pdf");
    const withImage = await service.changeSignatory(
      { tenantId: tenant.id, signatoryId: s.id, signatureVersionId: "00000000-0000-4000-8000-0000000000a1" },
      ACTOR,
    );
    expect(withImage.signatureVersionId).toBe("00000000-0000-4000-8000-0000000000a1");
    await expect(
      service.changeSignatory(
        { tenantId: tenant.id, signatoryId: s.id, signatureVersionId: "00000000-0000-4000-8000-0000000000a2" },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(SignatureNotDrawable);
    await expect(
      service.changeSignatory(
        { tenantId: tenant.id, signatoryId: s.id, signatureVersionId: "00000000-0000-4000-8000-0000000000a3" },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(SignatoryNotFound);
  });

  it("records each change by user id and capacity, never by name", async () => {
    const { service, f, tenant, owner, colleague } = await withColleague();
    await service.addSignatory({ tenantId: tenant.id, userId: owner.id, title: "Director" }, ACTOR);
    const second = await service.addSignatory(
      { tenantId: tenant.id, userId: colleague.userId, title: "Partner" },
      ACTOR,
    );
    await service.setSignatoryActive(tenant.id, second.id, false, ACTOR);
    const ours = f.events.recorded.filter((e) => e.verb.startsWith("firm_signatory."));
    expect(ours.map((e) => e.verb)).toEqual([
      "firm_signatory.added",
      "firm_signatory.set",
      "firm_signatory.added",
      "firm_signatory.retired",
    ]);
    for (const e of ours) {
      expect(JSON.stringify(e.payload)).not.toContain("Anita");
      expect(JSON.stringify(e.payload)).not.toContain("@");
    }
  });
});
