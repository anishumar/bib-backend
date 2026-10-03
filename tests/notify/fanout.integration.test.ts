// The notification writers, against a real database (0323).
//
// What has to hold, and what only Postgres can show:
//
//   1. THE FIRST RUN starts the cursor and replays nothing.
//   2. AT-LEAST-ONCE WITHOUT DUPLICATES. A second run re-reads the overlap
//      window and writes nothing new.
//   3. NOBODY IS TOLD ABOUT THEIR OWN ACT, and a bell switched off stays quiet.
//   4. RESOLVING IS CAUSAL. A task finished, then given out again: re-reading
//      the old "finished" in the overlap must not close the NEW notification.
//   5. A PERMISSION AUDIENCE reaches exactly the roles that carry it.
//   6. ONE FIRM'S EVENTS NEVER REACH ANOTHER FIRM'S STAFF.
//   7. ADVANCE REMINDERS: one row per stage per person however often the sweep
//      runs, and resolved when the advance stops being pending.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import type { Db } from "../../src/db/pool";
import { systemClock } from "../../src/platform/clock";
import { PostgresNotificationOutbox, PostgresNotifyDirectory } from "../../src/infrastructure/postgres/notification-outbox";
import { PostgresNotificationSettings } from "../../src/infrastructure/postgres/notification-repository";
import { AdvanceReminders, NotificationFanout } from "../../src/usecase/notify/fanout";
import type { AdvanceOnDesk } from "../../src/usecase/billing/advance";
import type { Permission } from "../../src/domain/authz/model";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });
const appDb = app as unknown as Db;

const stamp = Date.now().toString(36);
let tenantA = "";
let tenantB = "";
let asha = ""; // partner in A: holds tenant:admin
let bilal = ""; // associate in A
let chen = ""; // partner in B
let workItem = "";

/** Roles by name, so the test does not depend on a firm's seeded config. */
const permissions = {
  permissionsFor(_t: string, role: string): Promise<readonly Permission[]> {
    return Promise.resolve(role === "partner" ? (["tenant:admin", "obligation:resolve"] as Permission[]) : []);
  },
  roleFor(): Promise<null> {
    return Promise.resolve(null);
  },
  knownRoles(): Promise<readonly string[]> {
    return Promise.resolve(["partner", "associate"]);
  },
} as unknown as ConstructorParameters<typeof NotificationFanout>[0]["permissions"];

const outbox = new PostgresNotificationOutbox(appDb);
const directory = new PostgresNotifyDirectory(appDb);
const settings = new PostgresNotificationSettings(appDb);
const fanout = new NotificationFanout({
  outbox,
  directory,
  checkers: { workItemCheckers: () => Promise.resolve([]), stepCheckers: () => Promise.resolve([]) },
  permissions,
  settings,
  clock: systemClock,
});

async function user(name: string): Promise<string> {
  const [u] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name) VALUES (${`${name}-${stamp}@nt.test`}, ${name}) RETURNING id
  `;
  if (!u) throw new Error("no user");
  return u.id;
}

async function firm(slug: string): Promise<string> {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency) VALUES (${slug}, ${slug}, 'INR') RETURNING id
  `;
  if (!t) throw new Error("no tenant");
  return t.id;
}

async function member(tenantId: string, userId: string, role: string): Promise<void> {
  await owner`
    INSERT INTO tenancy.membership (tenant_id, user_id, audience, role, is_active)
    VALUES (${tenantId}, ${userId}, 'STAFF', ${role}, true)
  `;
}

/** An event as a producer writes it. `recorded_at` is now(), after the cursor. */
async function event(
  tenantId: string,
  verb: string,
  objectType: string,
  objectId: string,
  actor: string | null,
  payload: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  await owner`
    INSERT INTO ledger.event (id, tenant_id, actor_type, actor_id, verb, object_type, object_id, payload)
    VALUES (${id}, ${tenantId}, ${actor === null ? "system" : "human"}, ${actor}, ${verb}, ${objectType},
            ${objectId}, ${owner.json(payload as Record<string, never>)})
  `;
  return id;
}

async function rows(tenantId: string) {
  return owner<{ recipient_user_id: string; category: string; resolved_at: string | null; source_id: string; actor_user_id: string | null; event_id: string | null }[]>`
    SELECT recipient_user_id, category, resolved_at::text, source_id, actor_user_id, event_id
    FROM notify.notification WHERE tenant_id = ${tenantId} ORDER BY created_at
  `;
}

beforeAll(async () => {
  tenantA = await firm(`nt-fan-a-${stamp}`);
  tenantB = await firm(`nt-fan-b-${stamp}`);
  asha = await user("asha");
  bilal = await user("bilal");
  chen = await user("chen");
  await member(tenantA, asha, "partner");
  await member(tenantA, bilal, "associate");
  await member(tenantB, chen, "partner");

  const [client] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name) VALUES (${tenantA}, 'organization', 'Kaveri Foods') RETURNING id
  `;
  const [state] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_state (tenant_id, code, name, is_initial, sort_order)
    VALUES (${tenantA}, 'pending', 'Pending', true, 10) RETURNING id
  `;
  await owner`
    INSERT INTO delivery.work_item_state (tenant_id, code, name, is_terminal, is_success, sort_order)
    VALUES (${tenantA}, 'completed', 'Completed', true, true, 90)
  `;
  const [priority] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_priority (tenant_id, code, name, rank, is_default)
    VALUES (${tenantA}, 'normal', 'Normal', 20, true) RETURNING id
  `;
  if (!client || !state || !priority) throw new Error("could not seed");
  const [item] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item (tenant_id, client_party_id, title, state_id, priority_id, assignee_user_id)
    VALUES (${tenantA}, ${client.id}, 'TDS return Q2', ${state.id}, ${priority.id}, ${asha}) RETURNING id
  `;
  if (!item) throw new Error("no item");
  workItem = item.id;
});

afterAll(async () => {
  const both = [tenantA, tenantB];
  await owner`DELETE FROM notify.notification WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM notify.fanout_cursor WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM notify.user_preference WHERE tenant_id IN ${owner(both)}`;
  // The ledger is append-only for every role, by trigger: the test events stay,
  // in two throwaway firms, the same as every other ledger integration test.
  await owner`DELETE FROM delivery.work_item WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM delivery.work_item_state WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM delivery.work_item_priority WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM core.party WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM tenancy.membership WHERE tenant_id IN ${owner(both)}`;
  await owner.end();
  await app.end();
});

describe("the outbox", () => {
  it("starts the cursor on the first run and replays nothing", async () => {
    // An event from BEFORE the firm's first run.
    await event(tenantA, "work_item.assigned", "work_item", workItem, bilal, { userId: asha });
    expect(await fanout.runForTenant(tenantA)).toMatchObject({ events: 0, created: 0 });
    expect(await fanout.runForTenant(tenantB)).toMatchObject({ events: 0, created: 0 });
    expect(await rows(tenantA)).toEqual([]);
  });

  it("tells the new holder once, however often it runs, and nobody in another firm", async () => {
    const e = await event(tenantA, "work_item.assigned", "work_item", workItem, bilal, { userId: asha });
    const first = await fanout.runForTenant(tenantA);
    expect(first.created).toBe(1);
    const again = await fanout.runForTenant(tenantA);
    expect(again.created).toBe(0);
    expect(again.events).toBeGreaterThan(0); // the overlap WAS re-read

    const mine = (await rows(tenantA)).filter((r) => r.event_id === e);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ recipient_user_id: asha, category: "task_assigned", actor_user_id: bilal });
    expect(await rows(tenantB)).toEqual([]);
  });

  it("never tells somebody about their own act", async () => {
    const e = await event(tenantA, "work_item.assigned", "work_item", workItem, asha, { userId: asha });
    await fanout.runForTenant(tenantA);
    expect((await rows(tenantA)).filter((r) => r.event_id === e)).toEqual([]);
  });

  it("resolves causally: re-reading an old 'finished' leaves the next round open", async () => {
    await event(tenantA, "work_item.completed", "work_item", workItem, asha, {});
    await fanout.runForTenant(tenantA);
    const after = await rows(tenantA);
    expect(after.filter((r) => r.category === "task_assigned").every((r) => r.resolved_at !== null)).toBe(true);

    // Reopened and handed to Asha again.
    const next = await event(tenantA, "work_item.assigned", "work_item", workItem, bilal, { userId: asha });
    await fanout.runForTenant(tenantA);
    // The "completed" is still inside the overlap and is read again here.
    await fanout.runForTenant(tenantA);
    const round2 = (await rows(tenantA)).find((r) => r.event_id === next);
    expect(round2).toBeDefined();
    expect(round2?.resolved_at).toBeNull();
  });

  it("stays quiet for a person whose bell is off for that category", async () => {
    await settings.setUserPreferences(tenantA, asha, [{ category: "task_assigned", channel: "in_app", enabled: false }]);
    const e = await event(tenantA, "work_item.assigned", "work_item", workItem, bilal, { userId: asha });
    await fanout.runForTenant(tenantA);
    expect((await rows(tenantA)).filter((r) => r.event_id === e)).toEqual([]);
    await settings.setUserPreferences(tenantA, asha, [{ category: "task_assigned", channel: "in_app", enabled: true }]);
  });

  it("reaches exactly the roles holding a permission", async () => {
    const invoiceId = randomUUID();
    const e = await event(tenantA, "dunning.escalated", "invoice", invoiceId, null, { awaitingApproval: true, step: "d30" });
    await fanout.runForTenant(tenantA);
    const told = (await rows(tenantA)).filter((r) => r.event_id === e);
    expect(told.map((r) => r.recipient_user_id)).toEqual([asha]);
    expect(told[0]?.category).toBe("dunning_decision");
  });

  it("reads a relationship from the firm's own tables", async () => {
    expect(await directory.workItemAssignee(tenantA, workItem)).toBe(asha);
    expect(await directory.workItemAssignee(tenantB, workItem)).toBeNull();
    const staff = await directory.activeStaff(tenantA);
    expect(staff.map((s) => s.userId).sort()).toEqual([asha, bilal].sort());
  });
});

describe("advance reminders", () => {
  const dueId = randomUUID();
  let current: AdvanceOnDesk[] = [];
  const reminders = new AdvanceReminders({
    outbox,
    advances: { list: () => Promise.resolve({ today: "2026-10-03", advances: current }) },
    directory,
    permissions,
    settings,
  });

  function advance(stage: string, overdue: boolean, escalated: boolean, pending = true): AdvanceOnDesk {
    return {
      id: dueId,
      stage,
      amount: "50000.00",
      currency: "INR",
      balance: null,
      invoice: null,
      reminder: { pending, overdue, escalated, pendingSince: null, daysPending: null, overdueOn: null },
      people: { spocs: [], keyManager: { userId: bilal, displayName: null, email: "" }, partner: null },
    } as unknown as AdvanceOnDesk;
  }

  it("writes one row per stage per person, however often it runs", async () => {
    current = [advance("on_draft", true, false)];
    const first = await reminders.runForTenant(tenantA);
    // Bilal chases it as Key Manager; Asha as an admin, because a draft waits for an admin.
    expect(first.created).toBe(2);
    expect((await reminders.runForTenant(tenantA)).created).toBe(0);
  });

  it("resolves a stage the advance has left, and adds the new one", async () => {
    current = [advance("on_draft", true, true)];
    const r = await reminders.runForTenant(tenantA);
    expect(r.resolved).toBe(0);
    expect(r.created).toBe(1); // escalated: Asha (admin); no partner
    current = [];
    const done = await reminders.runForTenant(tenantA);
    expect(done.resolved).toBe(3);
    const open = await owner`
      SELECT 1 FROM notify.notification
      WHERE tenant_id = ${tenantA} AND category = 'advance_reminder' AND resolved_at IS NULL
    `;
    expect(open).toHaveLength(0);
  });
});
