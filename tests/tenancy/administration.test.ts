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
import { ConfigService } from "../../src/usecase/config/service";
import { makeFakes } from "../../src/testfakes/tenancy";
import {
  LastAdministrator,
  MembershipExists,
  MembershipNotFound,
  RoleNotDefined,
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
