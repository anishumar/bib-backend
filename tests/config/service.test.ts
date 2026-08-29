// The configuration registry (T2.5), at the use-case level: the versioning
// spine, the two kinds riding on it, and the rule that stops a firm locking
// itself out of its own configuration.
//
// The database half — the freeze trigger, the one-published-version index, RLS,
// and a pin still resolving after its version was archived — is proven against
// real Postgres in registry.integration.test.ts. A fake can show our code never
// edits a published row; only the database can show that editing one is
// impossible.
import { describe, expect, it } from "vitest";
import { ConfigService } from "../../src/usecase/config/service";
import { makeConfigFakes } from "../../src/testfakes/config";
import type { FakeRoleHolders } from "../../src/testfakes/config";
import type { FakeConfigRepo } from "../../src/testfakes/config";
import type { RecordingEventSink } from "../../src/testfakes/ledger";
import { DEFAULT_ROLES } from "../../src/domain/authz/model";
import { CONFIG_KINDS, configRef, isValidKey } from "../../src/domain/config/model";
import { KIND_VALUES } from "../../src/api/handler/config";
import {
  EntryExists,
  EntryNotFound,
  InvalidBody,
  InvalidKey,
  InvalidKind,
  VersionNotDraft,
  VersionNotFound,
  NoOneWouldAdminister,
  WouldLockOutAdministration,
} from "../../src/domain/config/errors";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000a2";
const ACTOR = { type: "human" as const, id: "00000000-0000-4000-8000-0000000000b1" };

function setup(): {
  service: ConfigService;
  registry: FakeConfigRepo;
  holders: FakeRoleHolders;
  events: RecordingEventSink;
} {
  const fakes = makeConfigFakes();
  return {
    service: new ConfigService(fakes),
    registry: fakes.registry,
    holders: fakes.holders,
    events: fakes.events as RecordingEventSink,
  };
}

const GST_FILING = {
  name: "GST monthly filing",
  description: "GSTR-1 and GSTR-3B for one registration",
  category: "indirect-tax",
  jurisdictions: ["IN"],
  billingBasis: "fixed" as const,
};

/** A firm with its roles already in place — the state createTenant leaves every
 *  real tenant in, so anything not testing provisioning starts here. */
async function seeded(): Promise<ReturnType<typeof setup>> {
  const s = setup();
  await s.service.seedDefaultRoles(TENANT);
  return s;
}

describe("defining a configured thing", () => {
  it("creates the entry with a first DRAFT, not something already in force", async () => {
    // "A new service is a config row" — the acceptance. Defining it and putting
    // it in front of clients are separate decisions.
    const { service } = setup();
    const { entry, draft } = await service.define(
      { tenantId: TENANT, kind: "service", key: "gst-filing", body: GST_FILING },
      ACTOR,
    );
    expect(entry.kind).toBe("service");
    expect(entry.key).toBe("gst-filing");
    expect(draft.version).toBe(1);
    expect(draft.status).toBe("draft");
    expect(draft.publishedAt).toBeNull();
  });

  it("does not appear as published until it is", async () => {
    const { service } = setup();
    await service.define(
      { tenantId: TENANT, kind: "service", key: "gst-filing", body: GST_FILING },
      ACTOR,
    );
    const [listed] = await service.list(TENANT, "service");
    // Listed, so a half-finished catalogue row does not look like one that was
    // never created — but with nothing published.
    expect(listed?.entry.key).toBe("gst-filing");
    expect(listed?.published).toBeNull();
  });

  it("records who defined it", async () => {
    const { service, events } = setup();
    await service.define(
      { tenantId: TENANT, kind: "service", key: "gst-filing", body: GST_FILING },
      ACTOR,
    );
    expect(events.verbs()).toContain("config_entry.created");
  });

  it("refuses a second entry with the same key", async () => {
    const { service } = setup();
    const input = { tenantId: TENANT, kind: "service", key: "gst-filing", body: GST_FILING };
    await service.define(input, ACTOR);
    await expect(service.define(input, ACTOR)).rejects.toBeInstanceOf(EntryExists);
  });

  it("lets two firms use the same key", async () => {
    // The whole point of a per-firm registry: 'gst-filing' at one firm is not
    // 'gst-filing' at another.
    const { service } = setup();
    const input = { kind: "service", key: "gst-filing", body: GST_FILING };
    await service.define({ ...input, tenantId: TENANT }, ACTOR);
    await expect(
      service.define({ ...input, tenantId: OTHER_TENANT }, ACTOR),
    ).resolves.toBeDefined();
  });

  it("refuses a kind the product has no validator for", async () => {
    // A kind without a body validator would accept anything, so adding one is a
    // code change — not something a caller can invent over HTTP.
    //
    // `rule_pack` is the next kind the board actually plans (T4.3), and it is
    // used here for the same reason `workflow_template` was until T2.7 built it:
    // it is a name somebody might plausibly send, which is what makes the
    // refusal worth asserting.
    await expect(
      setup().service.define(
        { tenantId: TENANT, kind: "rule_pack", key: "x", body: {} },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(InvalidKind);
  });

  it("refuses a key that is a title rather than a handle", async () => {
    await expect(
      setup().service.define(
        { tenantId: TENANT, kind: "service", key: "GST Filing", body: GST_FILING },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(InvalidKey);
  });
});

describe("body validation, per kind", () => {
  it("names the field and the valid set rather than saying invalid", async () => {
    const err = await setup()
      .service.define(
        {
          tenantId: TENANT,
          kind: "service",
          key: "gst-filing",
          body: { ...GST_FILING, billingBasis: "monthly" },
        },
        ACTOR,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidBody);
    expect((err as Error).message).toContain("billingBasis");
    expect((err as Error).message).toContain("retainer");
    expect((err as Error).message).toContain('"monthly"');
  });

  it("rejects a misspelt field instead of storing it and doing nothing", async () => {
    // The failure this prevents: `permission` for `permissions` saves happily
    // and grants nothing. A config change that appears to work and does not is
    // the worst outcome available here.
    const err = await setup()
      .service.define(
        {
          tenantId: TENANT,
          kind: "role",
          key: "reviewer",
          body: { label: "Reviewer", permission: ["party:read"] },
        },
        ACTOR,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidBody);
    expect((err as Error).message).toContain('"permission"');
  });

  it("rejects a permission the product does not check", async () => {
    // A permission nothing checks would be a lie on a screen.
    const err = await setup()
      .service.define(
        {
          tenantId: TENANT,
          kind: "role",
          key: "reviewer",
          body: { label: "Reviewer", permissions: ["invoice:approve"] },
        },
        ACTOR,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidBody);
    expect((err as Error).message).toContain("invoice:approve");
    expect((err as Error).message).toContain("party:read");
  });

  it("accepts a service with a list price, and one without", async () => {
    // Optional is the whole point: an hourly or retainer service often has no
    // list price until an engagement is scoped, and a firm that has not set one
    // must be able to say so. Null means "we quote it"; it never means zero.
    const { service } = setup();
    await expect(
      service.define(
        {
          tenantId: TENANT,
          kind: "service",
          key: "gst-filing",
          body: { ...GST_FILING, listPrice: { amount: "25000.00", currency: "INR" } },
        },
        ACTOR,
      ),
    ).resolves.toBeDefined();
    await expect(
      service.define(
        {
          tenantId: TENANT,
          kind: "service",
          key: "advisory",
          body: { name: "Advisory", billingBasis: "hourly", listPrice: null },
        },
        ACTOR,
      ),
    ).resolves.toBeDefined();
  });

  it("refuses an amount given as a number, and says why", async () => {
    // A float cannot hold 1499.50 exactly. The error is invisible in one line
    // and material in a total, so the string is not a formality.
    const err = await setup()
      .service.define(
        {
          tenantId: TENANT,
          kind: "service",
          key: "gst-filing",
          body: { ...GST_FILING, listPrice: { amount: 1499.5, currency: "INR" } },
        },
        ACTOR,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidBody);
    expect((err as Error).message).toContain("listPrice.amount");
    expect((err as Error).message).toContain("float");
  });

  it.each([
    [{ amount: "25000" }, "currency"],
    [{ currency: "INR" }, "amount"],
    [{ amount: "-500", currency: "INR" }, "amount"],
    [{ amount: "25000.000005", currency: "INR" }, "amount"],
    [{ amount: "25000", currency: "rupees" }, "currency"],
    [{ amount: "25000", currency: "INR", vat: "18" }, "vat"],
  ])("refuses the half-stated price %j", async (listPrice, field) => {
    // An amount with no currency is a number nobody can act on; a currency with
    // no amount says nothing at all. Neither is a price.
    const err = await setup()
      .service.define(
        { tenantId: TENANT, kind: "service", key: "gst-filing", body: { ...GST_FILING, listPrice } },
        ACTOR,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidBody);
    expect((err as Error).message).toContain(field);
  });

  it("accepts a service with only the fields a catalogue row needs", async () => {
    await expect(
      setup().service.define(
        {
          tenantId: TENANT,
          kind: "service",
          key: "advisory",
          body: { name: "Advisory", billingBasis: "hourly" },
        },
        ACTOR,
      ),
    ).resolves.toBeDefined();
  });
});

describe("versioning and publishing", () => {
  it("numbers versions per entry and publishes the one asked for", async () => {
    const { service } = setup();
    await service.define(
      { tenantId: TENANT, kind: "service", key: "gst-filing", body: GST_FILING },
      ACTOR,
    );
    const second = await service.addVersion(
      {
        tenantId: TENANT,
        kind: "service",
        key: "gst-filing",
        body: { ...GST_FILING, name: "GST monthly filing (revised)" },
      }
    );
    expect(second.version).toBe(2);

    const published = await service.publish(
      { tenantId: TENANT, kind: "service", key: "gst-filing", version: 2 },
      ACTOR,
    );
    expect(published.status).toBe("published");
    expect(published.publishedAt).not.toBeNull();
  });

  it("leaves what is in force alone while a new version is drafted", async () => {
    const { service } = setup();
    await service.define(
      { tenantId: TENANT, kind: "service", key: "gst-filing", body: GST_FILING },
      ACTOR,
    );
    await service.publish(
      { tenantId: TENANT, kind: "service", key: "gst-filing", version: 1 },
      ACTOR,
    );
    await service.addVersion(
      { tenantId: TENANT, kind: "service", key: "gst-filing", body: { ...GST_FILING, name: "v2" } }
    );
    const [listed] = await service.list(TENANT, "service");
    expect(listed?.published?.version).toBe(1);
  });

  it("archives the version it replaces, so exactly one is in force", async () => {
    const { service } = setup();
    await service.define(
      { tenantId: TENANT, kind: "service", key: "gst-filing", body: GST_FILING },
      ACTOR,
    );
    await service.publish(
      { tenantId: TENANT, kind: "service", key: "gst-filing", version: 1 },
      ACTOR,
    );
    await service.addVersion(
      { tenantId: TENANT, kind: "service", key: "gst-filing", body: { ...GST_FILING, name: "v2" } }
    );
    await service.publish(
      { tenantId: TENANT, kind: "service", key: "gst-filing", version: 2 },
      ACTOR,
    );

    const { versions } = await service.describe(TENANT, "service", "gst-filing");
    expect(versions.filter((v) => v.status === "published")).toHaveLength(1);
    expect(versions.find((v) => v.version === 1)?.status).toBe("archived");
    expect(versions.find((v) => v.version === 1)?.archivedAt).not.toBeNull();
  });

  it("records the publish and the archive, both naming the actor", async () => {
    const { service, events } = setup();
    await service.define(
      { tenantId: TENANT, kind: "service", key: "gst-filing", body: GST_FILING },
      ACTOR,
    );
    await service.publish(
      { tenantId: TENANT, kind: "service", key: "gst-filing", version: 1 },
      ACTOR,
    );
    await service.addVersion(
      { tenantId: TENANT, kind: "service", key: "gst-filing", body: { ...GST_FILING, name: "v2" } }
    );
    await service.publish(
      { tenantId: TENANT, kind: "service", key: "gst-filing", version: 2 },
      ACTOR,
    );

    expect(events.verbs()).toContain("config_version.published");
    expect(events.verbs()).toContain("config_version.archived");
    for (const e of events.recorded) {
      expect(e.actorId).toBe(ACTOR.id);
    }
  });

  it("does not record a draft — the log holds what took effect", async () => {
    const { service, events } = setup();
    await service.define(
      { tenantId: TENANT, kind: "service", key: "gst-filing", body: GST_FILING },
      ACTOR,
    );
    const before = events.recorded.length;
    await service.addVersion(
      { tenantId: TENANT, kind: "service", key: "gst-filing", body: { ...GST_FILING, name: "v2" } }
    );
    expect(events.recorded).toHaveLength(before);
  });

  it("refuses to publish something that is already published", async () => {
    const { service } = setup();
    await service.define(
      { tenantId: TENANT, kind: "service", key: "gst-filing", body: GST_FILING },
      ACTOR,
    );
    const target = { tenantId: TENANT, kind: "service", key: "gst-filing", version: 1 };
    await service.publish(target, ACTOR);
    await expect(service.publish(target, ACTOR)).rejects.toBeInstanceOf(VersionNotDraft);
  });

  it("refuses a version that does not exist, naming what was asked for", async () => {
    const { service } = setup();
    await service.define(
      { tenantId: TENANT, kind: "service", key: "gst-filing", body: GST_FILING },
      ACTOR,
    );
    const err = await service
      .publish({ tenantId: TENANT, kind: "service", key: "gst-filing", version: 9 }, ACTOR)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VersionNotFound);
    expect((err as Error).message).toContain(configRef("service", "gst-filing", 9));
  });

  it("refuses an entry this firm does not have", async () => {
    await expect(
      setup().service.describe(TENANT, "service", "nothing-like-it"),
    ).rejects.toBeInstanceOf(EntryNotFound);
  });
});

describe("pinning — the promise the whole spine exists to make", () => {
  it("resolves a pinned version after it has been superseded and archived", async () => {
    // A job that started three weeks ago reads what it started on. Editing a
    // workflow must never rewrite work already walking it.
    const { service } = setup();
    const { draft } = await service.define(
      { tenantId: TENANT, kind: "service", key: "gst-filing", body: GST_FILING },
      ACTOR,
    );
    const pin = draft.id;
    await service.publish(
      { tenantId: TENANT, kind: "service", key: "gst-filing", version: 1 },
      ACTOR,
    );
    await service.addVersion(
      {
        tenantId: TENANT,
        kind: "service",
        key: "gst-filing",
        body: { ...GST_FILING, name: "Completely different" },
      }
    );
    await service.publish(
      { tenantId: TENANT, kind: "service", key: "gst-filing", version: 2 },
      ACTOR,
    );

    const pinned = await service.readPinned(TENANT, pin);
    expect(pinned.status).toBe("archived");
    expect(pinned.body["name"]).toBe("GST monthly filing");
    // And the live read has moved on, which is the other half of the point.
    const [listed] = await service.list(TENANT, "service");
    expect(listed?.published?.body["name"]).toBe("Completely different");
  });

  it("does not resolve another firm's pin", async () => {
    const { service } = setup();
    const { draft } = await service.define(
      { tenantId: TENANT, kind: "service", key: "gst-filing", body: GST_FILING },
      ACTOR,
    );
    await expect(service.readPinned(OTHER_TENANT, draft.id)).rejects.toBeInstanceOf(
      VersionNotFound,
    );
  });
});

describe("roles as configuration", () => {
  it("gives a new firm the product's four roles, published", async () => {
    const { service, registry, events } = await seeded();
    const roles = await service.list(TENANT, "role");
    expect(roles.map((r) => r.entry.key).sort()).toEqual(Object.keys(DEFAULT_ROLES).sort());
    for (const role of roles) {
      expect(role.published, `${role.entry.key} must be in force`).not.toBeNull();
    }
    // Gate 3 can answer immediately, which is what makes the firm usable.
    expect(await registry.permissionsFor(TENANT, "partner")).toContain("tenant:admin");
    expect(await registry.knownRoles(TENANT)).toContain("associate");
    // One event for the lot, not two per role — eight rows for a single fact
    // would bury what a person actually did.
    expect(events.verbs().filter((v) => v === "config_registry.seeded")).toHaveLength(1);
    expect(events.verbs()).not.toContain("config_entry.created");
  });

  it("lets a firm add a role in its own vocabulary", async () => {
    // The thing that was impossible before T2.5: "rm" carried nothing and said
    // so, and there was no way to make it carry anything.
    const { service, registry } = await seeded();
    await service.define(
      {
        tenantId: TENANT,
        kind: "role",
        key: "rm",
        body: { label: "Relationship manager", permissions: ["party:read", "config:read"] },
      },
      ACTOR,
    );
    await service.publish({ tenantId: TENANT, kind: "role", key: "rm", version: 1 }, ACTOR);
    expect(await registry.permissionsFor(TENANT, "rm")).toEqual(["party:read", "config:read"]);
    expect(await registry.knownRoles(TENANT)).toContain("rm");
  });

  it("takes a permission away the moment the new version is published", async () => {
    // Not merged with any built-in defaults — a firm that removes a permission
    // has removed it. That is why nothing falls back to DEFAULT_ROLES at read
    // time.
    const { service, registry } = await seeded();
    expect(await registry.permissionsFor(TENANT, "manager")).toContain("ledger:read");
    await service.addVersion(
      {
        tenantId: TENANT,
        kind: "role",
        key: "manager",
        body: { label: "Manager", permissions: ["party:read", "party:write"] },
      }
    );
    await service.publish({ tenantId: TENANT, kind: "role", key: "manager", version: 2 }, ACTOR);
    expect(await registry.permissionsFor(TENANT, "manager")).not.toContain("ledger:read");
  });

  it("a drafted role is not yet a role", async () => {
    // Listing an unpublished role among the known ones would tell someone
    // locked out to use a name that will not work.
    const { service, registry } = await seeded();
    await service.define(
      { tenantId: TENANT, kind: "role", key: "rm", body: { label: "RM", permissions: [] } },
      ACTOR,
    );
    expect(await registry.knownRoles(TENANT)).not.toContain("rm");
  });
});

describe("the firm cannot lock itself out of its own configuration", () => {
  it("refuses a publish that leaves no role able to administer", async () => {
    // Unrecoverable through the product: config writes need tenant:admin, so
    // there would be no way to put it back.
    const { service } = await seeded();
    await service.addVersion(
      {
        tenantId: TENANT,
        kind: "role",
        key: "partner",
        body: { label: "Partner", permissions: ["party:read", "party:write", "ledger:read"] },
      }
    );
    const err = await service
      .publish({ tenantId: TENANT, kind: "role", key: "partner", version: 2 }, ACTOR)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WouldLockOutAdministration);
    expect((err as Error).message).toContain("tenant:admin");
  });

  it("allows it once another role carries the permission", async () => {
    // The check is against the whole role set the firm would have AFTER the
    // change, not against the role being edited.
    const { service, registry } = await seeded();
    await service.define(
      {
        tenantId: TENANT,
        kind: "role",
        key: "office-admin",
        body: { label: "Office administrator", permissions: ["tenant:admin", "config:read"] },
      },
      ACTOR,
    );
    await service.publish(
      { tenantId: TENANT, kind: "role", key: "office-admin", version: 1 },
      ACTOR,
    );
    await service.addVersion(
      {
        tenantId: TENANT,
        kind: "role",
        key: "partner",
        body: { label: "Partner", permissions: ["party:read", "party:write", "ledger:read"] },
      }
    );
    await expect(
      service.publish({ tenantId: TENANT, kind: "role", key: "partner", version: 2 }, ACTOR),
    ).resolves.toBeDefined();
    expect(await registry.permissionsFor(TENANT, "partner")).not.toContain("tenant:admin");
    expect(await registry.permissionsFor(TENANT, "office-admin")).toContain("tenant:admin");
  });

  it("refuses to move the permission onto a role nobody holds", async () => {
    // The half the registry cannot see on its own. `office-admin` carries
    // tenant:admin, so the first check passes — but if nobody at the firm is an
    // office-admin, publishing partner without it strands them just as
    // completely, and neither guard would have fired before this one existed.
    const { service, holders } = await seeded();
    holders.hold(TENANT, "partner");

    await service.define(
      {
        tenantId: TENANT,
        kind: "role",
        key: "office-admin",
        body: { label: "Office administrator", permissions: ["tenant:admin", "config:read"] },
      },
      ACTOR,
    );
    await service.publish(
      { tenantId: TENANT, kind: "role", key: "office-admin", version: 1 },
      ACTOR,
    );
    await service.addVersion({
      tenantId: TENANT,
      kind: "role",
      key: "partner",
      body: { label: "Partner", permissions: ["party:read", "party:write", "ledger:read"] },
    });

    const err = await service
      .publish({ tenantId: TENANT, kind: "role", key: "partner", version: 2 }, ACTOR)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoOneWouldAdminister);
    expect((err as Error).message).toContain("office-admin");
  });

  it("allows it once somebody actually holds that role", async () => {
    const { service, holders } = await seeded();
    holders.hold(TENANT, "partner").hold(TENANT, "office-admin");

    await service.define(
      {
        tenantId: TENANT,
        kind: "role",
        key: "office-admin",
        body: { label: "Office administrator", permissions: ["tenant:admin"] },
      },
      ACTOR,
    );
    await service.publish(
      { tenantId: TENANT, kind: "role", key: "office-admin", version: 1 },
      ACTOR,
    );
    await service.addVersion({
      tenantId: TENANT,
      kind: "role",
      key: "partner",
      body: { label: "Partner", permissions: ["party:read"] },
    });
    await expect(
      service.publish({ tenantId: TENANT, kind: "role", key: "partner", version: 2 }, ACTOR),
    ).resolves.toBeDefined();
  });

  it("skips the holder check for a firm with no members", async () => {
    // How every tenant looks while it is being provisioned: roles exist, nobody
    // has one yet. There is nobody to strand, and refusing here would make a
    // brand-new firm unconfigurable.
    const { service } = await seeded();
    await service.define(
      {
        tenantId: TENANT,
        kind: "role",
        key: "office-admin",
        body: { label: "Office administrator", permissions: ["tenant:admin"] },
      },
      ACTOR,
    );
    await service.publish(
      { tenantId: TENANT, kind: "role", key: "office-admin", version: 1 },
      ACTOR,
    );
    await service.addVersion({
      tenantId: TENANT,
      kind: "role",
      key: "partner",
      body: { label: "Partner", permissions: ["party:read"] },
    });
    await expect(
      service.publish({ tenantId: TENANT, kind: "role", key: "partner", version: 2 }, ACTOR),
    ).resolves.toBeDefined();
  });

  it("does not apply the rule to services", async () => {
    // It is a rule about who may administer the firm, not about configuration
    // in general.
    const { service } = await seeded();
    await expect(
      service
        .define(
          { tenantId: TENANT, kind: "service", key: "gst-filing", body: GST_FILING },
          ACTOR,
        )
        .then(() =>
          service.publish(
            { tenantId: TENANT, kind: "service", key: "gst-filing", version: 1 },
            ACTOR,
          ),
        ),
    ).resolves.toBeDefined();
  });
});

describe("keys and kinds", () => {
  it("accepts handles and refuses titles", () => {
    expect(isValidKey("gst-filing")).toBe(true);
    expect(isValidKey("roc_annual")).toBe(true);
    expect(isValidKey("partner")).toBe(true);
    expect(isValidKey("GST Filing")).toBe(false);
    expect(isValidKey("gst--filing")).toBe(false);
    expect(isValidKey("-gst")).toBe(false);
    expect(isValidKey("gst-")).toBe(false);
    expect(isValidKey("")).toBe(false);
    expect(isValidKey(`a${"b".repeat(64)}`)).toBe(false);
  });

  it("names a pinned version the way the build plan writes rule packs", () => {
    expect(configRef("service", "gst-filing", 7)).toBe("service:gst-filing@7");
  });

  it("offers every kind the domain has on the wire", () => {
    // The DTO enum is a separate list from CONFIG_KINDS (zod needs a literal
    // tuple). `satisfies` stops it naming a kind that does not exist; this
    // stops it from silently missing one, which would 400 a valid request.
    expect([...KIND_VALUES].sort()).toEqual([...CONFIG_KINDS].sort());
  });
});
