// T1.2's acceptance, proven against real Postgres: the audit ledger cannot be
// changed. A fake can assert that our code never calls UPDATE; only the
// database can assert that UPDATE is impossible — which is the property the
// product actually needs, because the threat is not our repository, it is a
// psql session at 2 a.m.
//
// Run with:  npm run test:integration   (needs a migrated local database)
// It is excluded from `npm test` by vitest.config.ts, which keeps the fast path
// service-free.
//
// NOTE ON CLEANUP: this test leaves its rows behind. It cannot do otherwise —
// deleting them is exactly what the table forbids, for every role. That is the
// point, not an oversight; the tenant it creates is uniquely named per run.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withTenant } from "../../src/db/tenant";
import { assertLedgerAppendOnly } from "../../src/db/boot-check";
import { PostgresEventStore } from "../../src/infrastructure/postgres/event-repository";
import { LedgerService } from "../../src/usecase/ledger/service";
import { systemIds } from "../../src/platform/ids";
import { SYSTEM_ACTOR } from "../../src/domain/ledger/model";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });
const ledger = new LedgerService({ events: new PostgresEventStore(app), ids: systemIds });

const stamp = String(Date.now());
let tenantA = "";
let tenantB = "";
let objectId = "";
let eventId = "";

beforeAll(async () => {
  const [a] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name)
    VALUES (${`ledger-test-a-${stamp}`}, 'Ledger Test A') RETURNING id
  `;
  const [b] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name)
    VALUES (${`ledger-test-b-${stamp}`}, 'Ledger Test B') RETURNING id
  `;
  if (!a || !b) throw new Error("could not create the test tenants");
  tenantA = a.id;
  tenantB = b.id;

  const recorded = await ledger.recordEvent({
    tenantId: tenantA,
    verb: "tenant.created",
    objectId: tenantA,
    actor: SYSTEM_ACTOR,
    payload: { slug: `ledger-test-a-${stamp}` },
  });
  eventId = recorded.id;
  objectId = tenantA;
});

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

describe("the app role cannot mutate the ledger", () => {
  it("holds SELECT and INSERT but not UPDATE or DELETE", async () => {
    const [p] = await app<
      { can_select: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean }[]
    >`
      SELECT has_table_privilege('ledger.event', 'SELECT') AS can_select,
             has_table_privilege('ledger.event', 'INSERT') AS can_insert,
             has_table_privilege('ledger.event', 'UPDATE') AS can_update,
             has_table_privilege('ledger.event', 'DELETE') AS can_delete
    `;
    expect(p).toBeDefined();
    expect(p?.can_select).toBe(true);
    expect(p?.can_insert).toBe(true);
    expect(p?.can_update).toBe(false);
    expect(p?.can_delete).toBe(false);
  });

  it("is refused when it tries to rewrite an event", async () => {
    // The catch goes AROUND withTenant: a refused statement aborts the whole
    // transaction, so the rejection surfaces from begin(), not from the query.
    const err = await withTenant(app, tenantA, (db) =>
      db`UPDATE ledger.event SET verb = 'party.created' WHERE id = ${eventId}`,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("42501"); // insufficient_privilege
  });

  it("is refused when it tries to delete an event", async () => {
    const err = await withTenant(app, tenantA, (db) =>
      db`DELETE FROM ledger.event WHERE id = ${eventId}`,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("42501");
  });

  it("the boot check agrees — the process would refuse to serve otherwise", async () => {
    await expect(assertLedgerAppendOnly(app)).resolves.toBeUndefined();
  });
});

describe("not even the owner can rewrite history", () => {
  // Grants stop the application. The trigger stops everyone else — including the
  // owner role a migration runs as, and the superuser session of whoever is
  // debugging production.
  it("rejects an UPDATE by the owner role", async () => {
    const err = await owner`
      UPDATE ledger.event SET payload = '{"tampered":true}' WHERE id = ${eventId}
    `.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23001"); // restrict_violation, from the trigger
    expect((err as Error).message).toContain("append-only");
  });

  it("rejects a DELETE by the owner role", async () => {
    const err = await owner`DELETE FROM ledger.event WHERE id = ${eventId}`.catch(
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe("23001");
  });

  it("rejects a TRUNCATE by the owner role — the row trigger's blind spot", async () => {
    const err = await owner`TRUNCATE ledger.event`.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23001");
  });

  it("left the event exactly as written", async () => {
    const [row] = await owner<{ verb: string; payload: Record<string, unknown> }[]>`
      SELECT verb, payload FROM ledger.event WHERE id = ${eventId}
    `;
    expect(row?.verb).toBe("tenant.created");
    expect(row?.payload).toEqual({ slug: `ledger-test-a-${stamp}` });
  });
});

describe("the tenant wall covers the audit trail", () => {
  it("one firm's events are invisible to another", async () => {
    const mine = await ledger.forObject(tenantA, "tenant", objectId);
    expect(mine.length).toBeGreaterThan(0);

    const theirs = await ledger.forObject(tenantB, "tenant", objectId);
    expect(theirs).toEqual([]);

    const theirTimeline = await ledger.recent(tenantB);
    expect(theirTimeline).toEqual([]);
  });

  it("an insert cannot be addressed to another tenant", async () => {
    const err = await withTenant(app, tenantB, (db) =>
      db`
        INSERT INTO ledger.event (id, tenant_id, actor_type, verb, object_type, object_id)
        VALUES (gen_random_uuid(), ${tenantA}, 'system', 'tenant.created', 'tenant', ${tenantA})
      `,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("42501"); // RLS WITH CHECK violation
  });
});

describe("idempotency survives a replay", () => {
  it("the same key re-lands on the same row instead of double-recording", async () => {
    const input = {
      tenantId: tenantA,
      verb: "payment.recorded",
      objectId: tenantA,
      actor: SYSTEM_ACTOR,
      idempotencyKey: `${tenantA}:test-callback:${stamp}`,
    } as const;

    const first = await ledger.recordEvent(input);
    const replay = await ledger.recordEvent(input);
    expect(replay.id).toBe(first.id);
    expect(replay.recordedAt).toBe(first.recordedAt);

    const [count] = await withTenant(app, tenantA, async (db) => {
      return db<{ n: string }[]>`
        SELECT count(*)::text AS n FROM ledger.event WHERE id = ${first.id}
      `;
    });
    expect(count?.n).toBe("1");
  });
});
