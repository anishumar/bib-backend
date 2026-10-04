// Notes on a task and the maker's note on a review (0330, audit 2026-10-03,
// CA#30), proven where the claims have to hold: the database.
//
//   1. A note goes in and comes back with its author's NAME, oldest first.
//   2. APPEND-ONLY: the request role can neither edit nor delete one.
//   3. RLS keeps one firm's notes out of another's read, and the COMPOSITE
//      foreign key refuses a note naming another firm's task.
//   4. A blank note is refused by the wall as well as by the service.
//   5. The maker's note rides on the review row, through the adapters.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/workitem/notes.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresWorkItemRepository } from "../../src/infrastructure/postgres/work-item-repository";
import { PostgresWorkItemApprovalRepository } from "../../src/infrastructure/postgres/work-item-approval-repository";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });
const items = new PostgresWorkItemRepository(app);
const approvals = new PostgresWorkItemApprovalRepository(app);

const stamp = Date.now().toString(36);

interface Firm {
  id: string;
  client: string;
  notStarted: string;
  medium: string;
  task: string;
}
let a: Firm;
let b: Firm;
let priya: string;

async function firm(slug: string): Promise<Firm> {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, time_zone)
    VALUES (${slug}, ${slug}, 'INR', 'Asia/Kolkata') RETURNING id
  `;
  if (!t) throw new Error("no firm");
  // A complete task and filing vocabulary: calendar.integration.test.ts checks
  // every firm in the database has one.
  const states = await owner<{ code: string; id: string }[]>`
    INSERT INTO delivery.work_item_state (tenant_id, code, name, is_initial, is_terminal, is_success, sort_order)
    VALUES (${t.id}, 'not_started', 'Not Started', true, false, false, 10),
           (${t.id}, 'completed', 'Completed', false, true, true, 90)
    RETURNING code, id
  `;
  await owner`
    INSERT INTO delivery.obligation_state (tenant_id, code, name, is_initial, sort_order)
    VALUES (${t.id}, 'pending', 'Pending', true, 10)
  `;
  await owner`
    INSERT INTO delivery.obligation_state (tenant_id, code, name, is_terminal, is_filed, sort_order)
    VALUES (${t.id}, 'filed', 'Filed', true, true, 90)
  `;
  const [p] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_priority (tenant_id, code, name, rank, is_default, is_statutory_default)
    VALUES (${t.id}, 'medium', 'Medium', 3, true, true) RETURNING id
  `;
  const [c] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${t.id}, 'organization', 'Deccan Agro Foods Pvt Ltd') RETURNING id
  `;
  const notStarted = states.find((s) => s.code === "not_started")?.id;
  if (!p || !c || notStarted === undefined) throw new Error("fixture rows missing");
  const task = randomUUID();
  await owner`
    INSERT INTO delivery.work_item
      (id, tenant_id, client_party_id, title, state_id, priority_id, assignee_user_id, is_client_visible)
    VALUES (${task}, ${t.id}, ${c.id}, 'File GSTR-3B for September', ${notStarted}, ${p.id}, ${priya}, false)
  `;
  return { id: t.id, client: c.id, notStarted, medium: p.id, task };
}

beforeAll(async () => {
  const [u] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`notes-sneha-${stamp}@notes.test`}, 'Sneha Patil') RETURNING id
  `;
  if (!u) throw new Error("no user");
  priya = u.id;
  a = await firm(`notes-a-${stamp}`);
  b = await firm(`notes-b-${stamp}`);
});

afterAll(async () => {
  await owner.end();
  await app.end();
});

async function asTenant<T>(tenantId: string, run: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return app.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return run(tx);
  }) as Promise<T>;
}

describe("notes on a task (0330, CA#30)", () => {
  it("go in and come back with the author's name, oldest first", async () => {
    await items.addNote({
      id: randomUUID(),
      tenantId: a.id,
      workItemId: a.task,
      authorUserId: priya,
      body: "Challan shared with the client",
      createdAt: "2026-10-03T05:00:00.000Z",
    });
    const second = await items.addNote({
      id: randomUUID(),
      tenantId: a.id,
      workItemId: a.task,
      authorUserId: priya,
      body: "Client paid, acknowledgement attached",
      createdAt: "2026-10-03T06:00:00.000Z",
    });
    expect(second).toMatchObject({ authorName: "Sneha Patil", createdAt: "2026-10-03T06:00:00.000Z" });

    const notes = await items.listNotes(a.id, a.task);
    expect(notes.map((n) => n.body)).toEqual([
      "Challan shared with the client",
      "Client paid, acknowledgement attached",
    ]);
  });

  it("cannot be edited or deleted by the request role", async () => {
    await expect(
      asTenant(a.id, (tx) => tx`UPDATE delivery.work_item_note SET body = 'rewritten' WHERE work_item_id = ${a.task}`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asTenant(a.id, (tx) => tx`DELETE FROM delivery.work_item_note WHERE work_item_id = ${a.task}`),
    ).rejects.toThrow(/permission denied/);
  });

  it("are another firm's to read only under that firm, and cannot hang off another firm's task", async () => {
    expect(await items.listNotes(b.id, a.task)).toEqual([]);
    await expect(
      asTenant(b.id, (tx) => tx`
        INSERT INTO delivery.work_item_note (tenant_id, work_item_id, author_user_id, body)
        VALUES (${b.id}, ${a.task}, ${priya}, 'cross-firm')
      `),
    ).rejects.toThrow(/work_item_note_work_item_tenant_fkey/);
  });

  it("are refused blank by the wall, whatever the whitespace", async () => {
    await expect(
      asTenant(a.id, (tx) => tx`
        INSERT INTO delivery.work_item_note (tenant_id, work_item_id, author_user_id, body)
        VALUES (${a.id}, ${a.task}, ${priya}, ${" \n\t"})
      `),
    ).rejects.toThrow(/work_item_note_body_is_text/);
  });
});

describe("the maker's note on a review (0330, CA#30)", () => {
  it("is kept on the review it opened and read back with the history", async () => {
    const opened = await approvals.openIfAbsent({
      id: randomUUID(),
      tenantId: b.id,
      workItemId: b.task,
      policyVersionId: null,
      policyKey: null,
      requestNote: "Two purchase bills added late, see sheet 2",
    });
    expect(opened?.requestNote).toBe("Two purchase bills added late, see sheet 2");
    const history = await approvals.listForWorkItem(b.id, b.task);
    expect(history[0]?.approval.requestNote).toBe("Two purchase bills added late, see sheet 2");
  });
});
