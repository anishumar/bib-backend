import { describe, expect, it } from "vitest";
import { TenancyService } from "../../src/usecase/tenancy/service";
import { makeFakes } from "../../src/testfakes/tenancy";
import {
  EmailTaken,
  InvalidAudience,
  InvalidSlug,
  SlugTaken,
  TenantNotFound,
  UserNotFound,
} from "../../src/domain/tenancy/errors";

function svc() {
  const f = makeFakes();
  return { service: new TenancyService(f), f };
}

describe("createTenant", () => {
  it("creates a tenant with a valid slug", async () => {
    const { service } = svc();
    const t = await service.createTenant({ name: "Harbour Point", slug: "harbour-point" });
    expect(t.slug).toBe("harbour-point");
    expect(t.status).toBe("active");
  });

  it.each([["Bad Slug"], ["-leading"], ["a"], ["UPPER"]])(
    "rejects invalid slug %j",
    async (slug) => {
      const { service } = svc();
      await expect(service.createTenant({ name: "X", slug })).rejects.toBeInstanceOf(InvalidSlug);
    },
  );

  it("rejects a duplicate slug", async () => {
    const { service } = svc();
    await service.createTenant({ name: "One", slug: "acme" });
    await expect(service.createTenant({ name: "Two", slug: "acme" })).rejects.toBeInstanceOf(
      SlugTaken,
    );
  });

  it("gives the new firm its own role definitions, in the same call", async () => {
    // Gate 3 reads the firm's own role rows and has no built-in table to fall
    // back on (T2.5). A tenant created without them is a tenant nobody can sign
    // in to, so provisioning does it here rather than in a separate step that
    // could be skipped.
    const { service, f } = svc();
    const t = await service.createTenant({ name: "Harbour Point", slug: "harbour-point" });

    expect(await f.config.knownRoles(t.id)).toEqual([
      "associate",
      "client_contact",
      "manager",
      "partner",
    ]);
    // Usable immediately: somebody signing in as a partner can actually do
    // something, including edit the configuration they were just given.
    expect(await f.config.permissionsFor(t.id, "partner")).toContain("tenant:admin");
  });

  it("records the seeding as one fact, after the tenant's own creation", async () => {
    // One event for four roles: eight rows for something that is really one
    // fact would bury the events a person actually caused. And it comes second,
    // because the tenant has to exist before its configuration can.
    const { service, f } = svc();
    await service.createTenant({ name: "Harbour Point", slug: "harbour-point" });
    expect(f.events.verbs()).toEqual(["tenant.created", "config_registry.seeded"]);
  });
});

describe("ensureUser (link, never duplicate — ADR-02)", () => {
  it("creates a new global user", async () => {
    const { service } = svc();
    const u = await service.ensureUser("priya@example.com");
    expect(u.email).toBe("priya@example.com");
  });

  it("returns the SAME user for the same email, case-insensitively", async () => {
    const { service } = svc();
    const first = await service.ensureUser("Priya@Example.com");
    const second = await service.ensureUser("priya@example.com");
    expect(second.id).toBe(first.id);
  });
});

describe("registerUser (fresh identity expected)", () => {
  it("throws when the email is already taken", async () => {
    const { service } = svc();
    await service.registerUser("dup@example.com");
    await expect(service.registerUser("dup@example.com")).rejects.toBeInstanceOf(EmailTaken);
  });
});

describe("addMember", () => {
  async function seeded() {
    const { service, f } = svc();
    const tenant = await service.createTenant({ name: "Acme", slug: "acme" });
    const user = await service.ensureUser("staff@acme.com");
    return { service, f, tenantId: tenant.id, userId: user.id };
  }

  it("grants access with a valid audience", async () => {
    const { service, tenantId, userId } = await seeded();
    const m = await service.addMember({
      tenantId,
      userId,
      audience: "STAFF",
      role: "partner",
      commercialVisibility: true,
    });
    expect(m.audience).toBe("STAFF");
    expect(m.commercialVisibility).toBe(true);
  });

  it("rejects an unknown audience", async () => {
    const { service, tenantId, userId } = await seeded();
    await expect(
      service.addMember({ tenantId, userId, audience: "ADMIN", role: "x", commercialVisibility: false }),
    ).rejects.toBeInstanceOf(InvalidAudience);
  });

  it("rejects an unknown tenant", async () => {
    const { service, userId } = await seeded();
    await expect(
      service.addMember({ tenantId: "missing", userId, audience: "STAFF", role: "x", commercialVisibility: false }),
    ).rejects.toBeInstanceOf(TenantNotFound);
  });

  it("rejects an unknown user", async () => {
    const { service, tenantId } = await seeded();
    await expect(
      service.addMember({ tenantId, userId: "missing", audience: "STAFF", role: "x", commercialVisibility: false }),
    ).rejects.toBeInstanceOf(UserNotFound);
  });
});

describe("resolveAccess (org-switcher)", () => {
  it("returns a user's active memberships across tenants", async () => {
    const { service } = svc();
    const a = await service.createTenant({ name: "A", slug: "firm-a" });
    const b = await service.createTenant({ name: "B", slug: "firm-b" });
    const user = await service.ensureUser("consultant@example.com");
    await service.addMember({ tenantId: a.id, userId: user.id, audience: "STAFF", role: "member", commercialVisibility: false });
    await service.addMember({ tenantId: b.id, userId: user.id, audience: "CLIENT_PORTAL", role: "contact", commercialVisibility: false });

    const access = await service.resolveAccess(user.id);
    expect(access).toHaveLength(2);
    expect(access.map((m) => m.tenantId).sort()).toEqual([a.id, b.id].sort());
  });
});

describe("the audit trail", () => {
  it("records a tenant's own creation as the first row in its timeline", async () => {
    const { service, f } = svc();
    const tenant = await service.createTenant({ name: "Harbour Point", slug: "harbour-point" });
    const [event] = f.events.recorded;
    expect(event?.verb).toBe("tenant.created");
    expect(event?.tenantId).toBe(tenant.id);
    expect(event?.objectId).toBe(tenant.id);
    // Platform provisioning has no end user behind it, so it names the system
    // rather than inventing a human.
    expect(event?.actorType).toBe("system");
    expect(event?.actorId).toBeNull();
  });

  it("records a membership grant without the user's email", async () => {
    const { service, f } = svc();
    const tenant = await service.createTenant({ name: "Harbour Point", slug: "harbour-point" });
    const user = await service.ensureUser("priya@harbourpoint.in");
    const membership = await service.addMember({
      tenantId: tenant.id,
      userId: user.id,
      audience: "STAFF",
      role: "partner",
      commercialVisibility: true,
    });

    const granted = f.events.recorded.find((e) => e.verb === "membership.granted");
    expect(granted?.objectId).toBe(membership.id);
    // The user id, never the address: an email is personal data and this log
    // cannot be erased. Role and audience are the firm's own configuration.
    expect(granted?.payload).toEqual({
      userId: user.id,
      audience: "STAFF",
      role: "partner",
      commercialVisibility: true,
    });
    expect(JSON.stringify(f.events.recorded)).not.toContain("priya@harbourpoint.in");
  });

  it("does not record the creation of a global user — it belongs to no tenant", async () => {
    const { service, f } = svc();
    await service.ensureUser("priya@harbourpoint.in");
    // Every event is tenant-scoped and a global identity has no tenant. The
    // fact a firm cares about is membership.granted, which does.
    expect(f.events.recorded).toHaveLength(0);
  });
});
