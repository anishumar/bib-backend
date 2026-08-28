// T2.5's acceptance, proven against real Postgres: a published configuration
// version is FROZEN, exactly one version of a thing is in force at a time, and
// a pin still resolves after the version it names has been superseded.
//
// A fake can show that our code never edits a published row. Only the database
// can show that editing one is impossible — which is the property jobs in
// flight actually depend on, because the threat is not this repository, it is
// the psql session at 2 a.m. and the migration written in a hurry.
//
// Run with:  npm run test:integration   (needs a migrated local database)
//
// NOTE ON CLEANUP: this test leaves its rows behind. Published versions cannot
// be deleted, for any role — that is the point being proven, not an oversight.
// The tenants it creates are uniquely named per run.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withTenant } from "../../src/db/tenant";
import { PostgresConfigRepository } from "../../src/infrastructure/postgres/config-repository";
import { PostgresMembershipRepository } from "../../src/infrastructure/postgres/membership-repository";
import { ConfigService } from "../../src/usecase/config/service";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { LedgerService } from "../../src/usecase/ledger/service";
import { systemIds } from "../../src/platform/ids";
import { DEFAULT_ROLES } from "../../src/domain/authz/model";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const registry = new PostgresConfigRepository(app);
const service = new ConfigService({
  registry,
  // Real memberships: the lockout guard's second half asks who actually holds a
  // role, and a stub answering "nobody" would silently skip it.
  holders: new PostgresMembershipRepository(app),
  ids: systemIds,
  events: new LedgerService({ events: new PostgresEventStore(app), ids: systemIds }),
});

const stamp = String(Date.now());
let tenantA = "";
let tenantB = "";
/** The version pinned before anything superseded it. */
let pinnedVersionId = "";
let publishedVersionId = "";

const SERVICE_V1 = {
  name: "GST monthly filing",
  description: "GSTR-1 and GSTR-3B",
  category: "indirect-tax",
  jurisdictions: ["IN"],
  billingBasis: "fixed",
};

beforeAll(async () => {
  const [a] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`config-test-a-${stamp}`}, 'Config Test A', 'INR') RETURNING id
  `;
  const [b] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`config-test-b-${stamp}`}, 'Config Test B', 'INR') RETURNING id
  `;
  if (!a || !b) throw new Error("could not create the test tenants");
  tenantA = a.id;
  tenantB = b.id;

  // These tenants were inserted straight into the table, so they arrive without
  // the roles createTenant would have given them — seed them the way it does.
  await service.seedDefaultRoles(tenantA, SYSTEM_ACTOR);
  await service.seedDefaultRoles(tenantB, SYSTEM_ACTOR);

  const { draft } = await service.define(
    { tenantId: tenantA, kind: "service", key: "gst-filing", body: SERVICE_V1 },
    SYSTEM_ACTOR,
  );
  pinnedVersionId = draft.id;
  await service.publish(
    { tenantId: tenantA, kind: "service", key: "gst-filing", version: 1 },
    SYSTEM_ACTOR,
  );

  await service.addVersion(
    {
      tenantId: tenantA,
      kind: "service",
      key: "gst-filing",
      body: { ...SERVICE_V1, name: "GST monthly filing (2026 scope)" },
    }
    );
  const published = await service.publish(
    { tenantId: tenantA, kind: "service", key: "gst-filing", version: 2 },
    SYSTEM_ACTOR,
  );
  publishedVersionId = published.id;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

describe("a published version is frozen", () => {
  it("refuses an edit to its body by the app role", async () => {
    const err = await withTenant(app, tenantA, (db) =>
      db`UPDATE config.version SET body = '{"name":"tampered"}' WHERE id = ${publishedVersionId}`,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23001"); // restrict_violation, from the trigger
    expect((err as Error).message).toContain("frozen");
  });

  it("refuses an edit by the OWNER role too — grants alone would not", async () => {
    // The trigger binds every role. A grant stops the application; this stops
    // the migration and the debugging session.
    const err = await owner`
      UPDATE config.version SET body = '{"name":"tampered"}' WHERE id = ${publishedVersionId}
    `.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23001");
  });

  it("refuses to delete it, because something may be pinned to it", async () => {
    const err = await owner`DELETE FROM config.version WHERE id = ${pinnedVersionId}`.catch(
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe("23001");
    expect((err as Error).message).toContain("pinned");
  });

  it("refuses a TRUNCATE — the row trigger's blind spot", async () => {
    // TWO independent defences, and which one fires has changed once already.
    // A row trigger never sees a TRUNCATE, so 0005 added a statement-level one
    // (23001, restrict_violation). Since 0011 gave config.version a composite
    // key for crm.proposal_line to reference, Postgres refuses the TRUNCATE
    // earlier still, for being referenced by a foreign key (0A000).
    //
    // The property under test is "a TRUNCATE cannot empty this table", not
    // which guard says so — but both are asserted by name rather than by a
    // bare "it threw", because a DIFFERENT error here (a permission fault, a
    // syntax slip) would pass a laxer test while proving nothing.
    const err = await owner`TRUNCATE config.version`.catch((e: unknown) => e);
    expect(["23001", "0A000"]).toContain((err as { code?: string }).code);
  });

  it("refuses to move an archived version back into force", async () => {
    // Archiving is final. Re-publishing an old version is a NEW version with
    // the old body, so the history stays a history.
    const err = await owner`
      UPDATE config.version SET status = 'published' WHERE id = ${pinnedVersionId}
    `.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23001");
  });

  it("still allows a DRAFT to be edited — that is what a draft is for", async () => {
    const draft = await service.addVersion(
      {
        tenantId: tenantA,
        kind: "service",
        key: "gst-filing",
        body: { ...SERVICE_V1, name: "still being written" },
      }
    );
    await expect(
      withTenant(app, tenantA, (db) =>
        db`UPDATE config.version SET body = '{"name":"edited","billingBasis":"fixed"}' WHERE id = ${draft.id}`,
      ),
    ).resolves.toBeDefined();
  });

  it("left the pinned version exactly as it was published", async () => {
    const [row] = await owner<{ body: Record<string, unknown>; status: string }[]>`
      SELECT body, status FROM config.version WHERE id = ${pinnedVersionId}
    `;
    expect(row?.status).toBe("archived");
    expect(row?.body["name"]).toBe("GST monthly filing");
  });
});

describe("exactly one version is in force", () => {
  it("the database refuses a second published version of the same thing", async () => {
    // The partial unique index. Without it, "the published version of the
    // partner role" is a question with two answers and gate 3 picks one.
    const [entry] = await owner<{ id: string }[]>`
      SELECT id FROM config.entry WHERE tenant_id = ${tenantA} AND kind = 'service' AND key = 'gst-filing'
    `;
    const err = await owner`
      INSERT INTO config.version (tenant_id, entry_id, version, status, body, published_at)
      VALUES (${tenantA}, ${entry?.id ?? ""}, 99, 'published', '{"name":"x"}', now())
    `.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23505"); // unique_violation
  });

  it("publishing archived what it replaced, in the same breath", async () => {
    const { versions } = await service.describe(tenantA, "service", "gst-filing");
    expect(versions.filter((v) => v.status === "published")).toHaveLength(1);
    expect(versions.find((v) => v.id === pinnedVersionId)?.status).toBe("archived");
  });
});

describe("a pin outlives what it points at", () => {
  it("resolves the archived version, with the body it had when it was in force", async () => {
    // The promise the whole table pair exists to make: a job that started three
    // weeks ago reads what it started on, not what the firm published since.
    const pinned = await service.readPinned(tenantA, pinnedVersionId);
    expect(pinned.status).toBe("archived");
    expect(pinned.body["name"]).toBe("GST monthly filing");

    const [live] = await service.list(tenantA, "service");
    expect(live?.published?.body["name"]).toBe("GST monthly filing (2026 scope)");
  });
});

describe("the tenant wall covers configuration", () => {
  it("one firm's catalogue is invisible to another", async () => {
    expect((await service.list(tenantA, "service")).length).toBeGreaterThan(0);
    expect(await service.list(tenantB, "service")).toEqual([]);
  });

  it("does not resolve another firm's pin", async () => {
    expect(await registry.findVersionById(tenantB, pinnedVersionId)).toBeNull();
  });

  it("an insert cannot be addressed to another tenant", async () => {
    const err = await withTenant(app, tenantB, (db) =>
      db`
        INSERT INTO config.entry (tenant_id, kind, key)
        VALUES (${tenantA}, 'service', ${`smuggled-${stamp}`})
      `,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("42501"); // RLS WITH CHECK violation
  });

  it("a version cannot attach to another firm's entry", async () => {
    // Foreign-key checks run as a system operation that RLS does not filter, so
    // before migration 0006 an admin holding another firm's entry id could
    // hang their own version off it: entry_id -> B, tenant_id -> A, and every
    // constraint passed. The composite key makes the pair itself invalid.
    const [entry] = await owner<{ id: string }[]>`
      SELECT id FROM config.entry
      WHERE tenant_id = ${tenantA} AND kind = 'service' AND key = 'gst-filing'
    `;
    const err = await withTenant(app, tenantB, (db) =>
      db`
        INSERT INTO config.version (tenant_id, entry_id, version, body)
        VALUES (${tenantB}, ${entry?.id ?? ""}, 500, '{"name":"smuggled"}')
      `,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23503"); // foreign_key_violation
  });

  it("answers gate 3 from the calling firm's own roles", async () => {
    // Both tenants define `partner`; each must get its own answer, and a role
    // one firm invents must not exist at the other.
    expect(await registry.permissionsFor(tenantA, "partner")).toEqual(
      [...(DEFAULT_ROLES["partner"]?.permissions ?? [])],
    );

    await service.define(
      {
        tenantId: tenantA,
        kind: "role",
        key: "rm",
        body: { label: "Relationship manager", permissions: ["party:read"] },
      },
      SYSTEM_ACTOR,
    );
    await service.publish(
      { tenantId: tenantA, kind: "role", key: "rm", version: 1 },
      SYSTEM_ACTOR,
    );

    expect(await registry.knownRoles(tenantA)).toContain("rm");
    expect(await registry.knownRoles(tenantB)).not.toContain("rm");
    expect(await registry.permissionsFor(tenantB, "rm")).toEqual([]);
  });
});

describe("the app role can work the registry but not break it", () => {
  it("holds SELECT, INSERT and UPDATE, and no DELETE", async () => {
    // UPDATE is needed — drafts are edited and publishing moves a status. What
    // stops a published row changing is the trigger, not the grant, which is
    // why both exist.
    const [p] = await app<
      { can_select: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean }[]
    >`
      SELECT has_table_privilege('config.version', 'SELECT') AS can_select,
             has_table_privilege('config.version', 'INSERT') AS can_insert,
             has_table_privilege('config.version', 'UPDATE') AS can_update,
             has_table_privilege('config.version', 'DELETE') AS can_delete
    `;
    expect(p?.can_select).toBe(true);
    expect(p?.can_insert).toBe(true);
    expect(p?.can_update).toBe(true);
    expect(p?.can_delete).toBe(false);
  });
});
