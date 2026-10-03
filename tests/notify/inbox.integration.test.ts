// The notification inbox, proven where its claims have to hold: the database
// (0323).
//
// Two firms, two colleagues in the first, one in the second. What has to be
// true, and what a fake cannot show because a fake agrees with the service by
// construction:
//
//   1. ONE PERSON'S BELL. Through the adapter, a colleague lists, counts and
//      marks only their own rows; another colleague's id and another firm's id
//      both answer "not found".
//   2. THE SECOND WALL HOLDS ON ITS OWN. Inside `withRecipient`, a query with
//      NO recipient filter still sees only the caller's rows — the restrictive
//      policy, not the WHERE clause. And `withTenant` (the worker's scope) sees
//      the whole firm, which is what the fan-out needs.
//   3. THE COUNT is unread AND unresolved, and capped.
//   4. PAGING by the millisecond the client was handed: rows inside one
//      millisecond are neither skipped nor repeated.
//   5. RETENTION without a DELETE grant: `bib_app` cannot delete a row, and
//      `notify.prune` deletes only this firm's read-or-resolved rows older than
//      30 days, and nothing with no firm in scope.
//   6. UPDATE is two columns. Nothing rewrites who a row was for.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withRecipient, withTenant } from "../../src/db/tenant";
import type { Db } from "../../src/db/pool";
import { PostgresNotificationInbox, PostgresNotificationSettings } from "../../src/infrastructure/postgres/notification-repository";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });
const appDb = app as unknown as Db;

const stamp = Date.now().toString(36);
const slugA = `nt-test-a-${stamp}`;
const slugB = `nt-test-b-${stamp}`;

let tenantA = "";
let tenantB = "";
let asha = "";
let bilal = "";
let chen = "";
let workItemA = "";

const inbox = new PostgresNotificationInbox(appDb);
const settings = new PostgresNotificationSettings(appDb);

async function user(email: string, name: string): Promise<string> {
  const [u] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name) VALUES (${email}, ${name}) RETURNING id
  `;
  if (!u) throw new Error("no user");
  return u.id;
}

async function tenant(slug: string, name: string): Promise<string> {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency) VALUES (${slug}, ${name}, 'INR') RETURNING id
  `;
  if (!t) throw new Error("no tenant");
  return t.id;
}

/** A notification as the worker writes it: bib_app, the firm in scope, no recipient. */
async function notify(
  tenantId: string,
  recipient: string,
  key: string,
  extra: { createdAt?: string; readAt?: string; resolvedAt?: string; sourceType?: string; sourceId?: string } = {},
): Promise<string> {
  return withTenant(appDb, tenantId, async (db) => {
    const [row] = await db<{ id: string }[]>`
      INSERT INTO notify.notification
        (tenant_id, recipient_user_id, category, source_type, source_id, payload, dedupe_key,
         created_at, read_at, resolved_at)
      VALUES (${tenantId}, ${recipient}, 'task_assigned', ${extra.sourceType ?? "work_item"},
              ${extra.sourceId ?? workItemA}, ${db.json({ how: "manual" })}, ${key},
              COALESCE(${extra.createdAt ?? null}::timestamptz, now()),
              ${extra.readAt ?? null}::timestamptz, ${extra.resolvedAt ?? null}::timestamptz)
      RETURNING id
    `;
    if (!row) throw new Error("no row");
    return row.id;
  });
}

beforeAll(async () => {
  tenantA = await tenant(slugA, "Notify Test A");
  tenantB = await tenant(slugB, "Notify Test B");
  asha = await user(`asha-${stamp}@nt.test`, "Asha");
  bilal = await user(`bilal-${stamp}@nt.test`, "Bilal");
  chen = await user(`chen-${stamp}@nt.test`, "Chen");

  // One task in firm A, so the list's joined names have something to name.
  const [client] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenantA}, 'organization', 'Kaveri Foods') RETURNING id
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
    VALUES (${tenantA}, ${client.id}, 'GST return for September', ${state.id}, ${priority.id}, ${asha})
    RETURNING id
  `;
  if (!item) throw new Error("no item");
  workItemA = item.id;
});

afterAll(async () => {
  const both = [tenantA, tenantB];
  await owner`DELETE FROM notify.notification WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM notify.firm_default WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM notify.user_preference WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM delivery.work_item WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM delivery.work_item_state WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM delivery.work_item_priority WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM core.party WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM tenancy.user_account WHERE id IN ${owner([asha, bilal, chen])}`;
  await owner`DELETE FROM tenancy.tenant WHERE id IN ${owner(both)}`;
  await owner.end();
  await app.end();
});

const NO_FILTER = { unreadOnly: false, category: null, before: null, limit: 50 } as const;

describe("one person's bell", () => {
  it("lists only the caller's own rows, with the task and client named", async () => {
    const mine = await notify(tenantA, asha, `own-${stamp}`);
    const colleagues = await notify(tenantA, bilal, `other-${stamp}`);
    const otherFirms = await notify(tenantB, chen, `firm-b-${stamp}`);

    const rows = await inbox.list(tenantA, asha, NO_FILTER);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(colleagues);
    expect(ids).not.toContain(otherFirms);
    const row = rows.find((r) => r.id === mine);
    expect(row?.subjectLabel).toBe("GST return for September");
    expect(row?.clientName).toBe("Kaveri Foods");
    // An ISO instant every browser accepts, never `::text`.
    expect(row?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("answers not found for a colleague's row and for another firm's", async () => {
    const bilals = await notify(tenantA, bilal, `bilal-mark-${stamp}`);
    const chens = await notify(tenantB, chen, `chen-mark-${stamp}`);

    expect(await inbox.markRead(tenantA, asha, bilals)).toBeNull();
    // The other firm's row, asked for from firm A and from firm B as Asha.
    expect(await inbox.markRead(tenantA, asha, chens)).toBeNull();
    expect(await inbox.markRead(tenantB, asha, chens)).toBeNull();

    // And nothing moved.
    const [b] = await owner<{ read_at: string | null }[]>`SELECT read_at FROM notify.notification WHERE id = ${bilals}`;
    const [c] = await owner<{ read_at: string | null }[]>`SELECT read_at FROM notify.notification WHERE id = ${chens}`;
    expect(b?.read_at).toBeNull();
    expect(c?.read_at).toBeNull();

    // Bilal can mark his own, twice, and the second answers with the first time.
    const first = await inbox.markRead(tenantA, bilal, bilals);
    const again = await inbox.markRead(tenantA, bilal, bilals);
    expect(first?.readAt).toBeTruthy();
    expect(again?.readAt).toBe(first?.readAt);
  });
});

describe("the second wall holds on its own", () => {
  it("withRecipient hides other people's rows from a query with no recipient filter", async () => {
    await notify(tenantA, bilal, `wall-${stamp}`);
    const seen = await withRecipient(appDb, tenantA, asha, async (db) =>
      db<{ recipient_user_id: string }[]>`SELECT recipient_user_id FROM notify.notification`,
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.recipient_user_id === asha)).toBe(true);

    // An UPDATE with no recipient filter reaches only the caller's rows.
    const touched = await withRecipient(appDb, tenantA, asha, async (db) =>
      db<{ recipient_user_id: string }[]>`
        UPDATE notify.notification SET read_at = read_at RETURNING recipient_user_id
      `,
    );
    expect(touched.every((r) => r.recipient_user_id === asha)).toBe(true);
  });

  it("withTenant (the worker's scope) sees the whole firm and no other", async () => {
    const seen = await withTenant(appDb, tenantA, async (db) =>
      db<{ recipient_user_id: string; tenant_id: string }[]>`
        SELECT recipient_user_id, tenant_id FROM notify.notification
      `,
    );
    const people = new Set(seen.map((r) => r.recipient_user_id));
    expect(people.has(asha)).toBe(true);
    expect(people.has(bilal)).toBe(true);
    expect(seen.every((r) => r.tenant_id === tenantA)).toBe(true);
  });

  it("a recipient set to somebody else's firm sees nothing of this one", async () => {
    const seen = await withRecipient(appDb, tenantB, asha, async (db) =>
      db<{ id: string }[]>`SELECT id FROM notify.notification`,
    );
    expect(seen).toEqual([]);
  });
});

describe("the count", () => {
  it("counts unread and unresolved only, and stops at the cap", async () => {
    const before = await inbox.unreadCount(tenantA, chen, 100);
    expect(before).toBe(0);
    await notify(tenantA, chen, `c1-${stamp}`);
    await notify(tenantA, chen, `c2-${stamp}`);
    await notify(tenantA, chen, `c3-${stamp}`, { readAt: new Date().toISOString() });
    await notify(tenantA, chen, `c4-${stamp}`, { resolvedAt: new Date().toISOString() });
    expect(await inbox.unreadCount(tenantA, chen, 100)).toBe(2);
    expect(await inbox.unreadCount(tenantA, chen, 1)).toBe(1);

    const unread = await inbox.list(tenantA, chen, { ...NO_FILTER, unreadOnly: true });
    expect(unread).toHaveLength(2);
  });

  it("refuses a second row for the same fact (the dedupe key)", async () => {
    await notify(tenantA, asha, `dup-${stamp}`);
    await expect(notify(tenantA, asha, `dup-${stamp}`)).rejects.toThrow(/duplicate key/);
    // Another person may have the same key: it is per recipient.
    await notify(tenantA, bilal, `dup-${stamp}`);
  });
});

describe("paging and marking by the millisecond", () => {
  it("neither skips nor repeats rows inside one millisecond", async () => {
    const at = "2026-10-01T09:00:00.123456Z";
    const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push(await notify(tenantB, chen, `ms-${String(i)}-${stamp}`, { createdAt: at }));

    const seen: string[] = [];
    let before: { createdAt: string; id: string } | null = null;
    for (let page = 0; page < 10; page += 1) {
      const rows = await inbox.list(tenantB, chen, { ...NO_FILTER, before, limit: 2 });
      seen.push(...rows.map((r) => r.id));
      const last = rows.at(-1);
      if (rows.length < 2 || last === undefined) break;
      before = { createdAt: last.createdAt, id: last.id };
    }
    for (const id of ids) expect(seen.filter((s) => s === id)).toHaveLength(1);
  });

  it("mark all read up to an instant leaves anything newer unread", async () => {
    const old = await notify(tenantB, chen, `upto-old-${stamp}`, { createdAt: "2026-10-02T08:00:00.500900Z" });
    const fresh = await notify(tenantB, chen, `upto-new-${stamp}`, { createdAt: "2026-10-02T08:00:01.000000Z" });
    // The client was handed `.500Z` for the old row and marks up to it.
    const marked = await inbox.markAllRead(tenantB, chen, "2026-10-02T08:00:00.500Z");
    expect(marked).toBeGreaterThan(0);
    const rows = await owner<{ id: string; read_at: string | null }[]>`
      SELECT id, read_at FROM notify.notification WHERE id IN ${owner([old, fresh])}
    `;
    expect(rows.find((r) => r.id === old)?.read_at).not.toBeNull();
    expect(rows.find((r) => r.id === fresh)?.read_at).toBeNull();
  });
});

describe("retention without a DELETE grant", () => {
  it("bib_app cannot delete a notification", async () => {
    await expect(
      withTenant(appDb, tenantA, async (db) => db`DELETE FROM notify.notification`),
    ).rejects.toThrow(/permission denied/);
  });

  it("prune deletes only this firm's read or resolved rows older than 30 days", async () => {
    const long = "2026-07-01T00:00:00Z";
    const readOld = await notify(tenantA, asha, `p-read-${stamp}`, { createdAt: long, readAt: long });
    const resolvedOld = await notify(tenantA, asha, `p-res-${stamp}`, { createdAt: long, resolvedAt: long });
    const unreadOld = await notify(tenantA, asha, `p-unread-${stamp}`, { createdAt: long });
    const readNew = await notify(tenantA, asha, `p-new-${stamp}`, { readAt: new Date().toISOString() });
    const otherFirm = await notify(tenantB, chen, `p-b-${stamp}`, { createdAt: long, readAt: long });

    // No firm in scope: nothing.
    const [none] = await app<{ n: number }[]>`SELECT notify.prune(now()) AS n`;
    expect(none?.n).toBe(0);

    // A caller asking for "everything up to now" still keeps the last 30 days.
    const n = await withTenant(appDb, tenantA, async (db) => {
      const [r] = await db<{ n: number }[]>`SELECT notify.prune(now()) AS n`;
      return r?.n ?? 0;
    });
    expect(n).toBe(2);

    const left = await owner<{ id: string }[]>`
      SELECT id FROM notify.notification WHERE id IN ${owner([readOld, resolvedOld, unreadOld, readNew, otherFirm])}
    `;
    expect(left.map((r) => r.id).sort()).toEqual([unreadOld, readNew, otherFirm].sort());
  });
});

describe("what an UPDATE may touch", () => {
  it("refuses to move a notification to another person", async () => {
    await expect(
      withTenant(appDb, tenantA, async (db) =>
        db`UPDATE notify.notification SET recipient_user_id = ${bilal} WHERE recipient_user_id = ${asha}`,
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("settings", () => {
  it("records only what moved, against the product default when the firm never set it", async () => {
    // escalation by email is ON by default: setting it on changes nothing.
    const same = await settings.setFirmDefaults(tenantA, asha, [
      { category: "escalation", channel: "email", enabled: true },
    ]);
    expect(same).toEqual([]);
    const moved = await settings.setFirmDefaults(tenantA, asha, [
      { category: "escalation", channel: "email", enabled: false },
      { category: "lead_assigned", channel: "email", enabled: true },
    ]);
    expect(moved).toEqual([
      { category: "escalation", channel: "email", from: true, to: false },
      { category: "lead_assigned", channel: "email", from: null, to: true },
    ]);
    expect(await settings.firmDefaults(tenantB)).toEqual([]);

    await settings.setUserPreferences(tenantA, bilal, [{ category: "lead_assigned", channel: "email", enabled: false }]);
    expect(await settings.userPreferences(tenantA, bilal)).toEqual([
      { category: "lead_assigned", channel: "email", enabled: false },
    ]);
    expect(await settings.userPreferences(tenantA, asha)).toEqual([]);
  });
});
