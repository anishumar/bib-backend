// A task raised by hand files a filing (audit 2026-10-03, CA#36): the SQL the
// link rests on, against a real database.
//
//   1. Linking writes the task into `obligation_instance.work_item_id`, the
//      column the calendar's own raised task uses, and only where it is empty.
//   2. Unlinking takes it off only while the filing is not filed, and only
//      for the task that is on it.
//   3. The calendar read the task page offers from finds the company's open
//      filings, and a linked filing is read back by its own day.
//
// Run with:  npx vitest run --config vitest.integration.config.ts tests/obligation/task-link.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresObligationInstanceRepository } from "../../src/infrastructure/postgres/obligation-instance-repository";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });
const instances = new PostgresObligationInstanceRepository(app);

const stamp = Date.now().toString(36);

let tenant: string;
let entity: string;
let pending: string;
let filed: string;
let rule: string;
let taskA: string;
let taskB: string;

async function filing(periodStart: string, label: string, target: string): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_instance
      (tenant_id, template_id, entity_party_id, period_start, period_end, period_label,
       statutory_due_on, internal_target_on, state_id)
    VALUES (${tenant}, ${rule}, ${entity}, ${periodStart}::date,
            (${periodStart}::date + INTERVAL '1 month - 1 day')::date, ${label},
            ${target}::date, ${target}::date, ${pending})
    RETURNING id
  `;
  if (!row) throw new Error("no filing");
  return row.id;
}

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency, time_zone)
    VALUES (${`task-link-${stamp}`}, 'Task Link QA', 'INR', 'Asia/Kolkata') RETURNING id
  `;
  if (!t) throw new Error("no firm");
  tenant = t.id;
  // A complete task and filing vocabulary: calendar.integration.test.ts checks
  // every firm in the database has one.
  const states = await owner<{ code: string; id: string }[]>`
    INSERT INTO delivery.work_item_state (tenant_id, code, name, is_initial, is_terminal, is_success, sort_order)
    VALUES (${tenant}, 'not_started', 'Not Started', true, false, false, 10),
           (${tenant}, 'completed', 'Completed', false, true, true, 90)
    RETURNING code, id
  `;
  const [pend] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_state (tenant_id, code, name, is_initial, sort_order)
    VALUES (${tenant}, 'pending', 'Pending', true, 10) RETURNING id
  `;
  const [fil] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_state (tenant_id, code, name, is_terminal, is_filed, sort_order)
    VALUES (${tenant}, 'filed', 'Filed', true, true, 90) RETURNING id
  `;
  const [p] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_priority (tenant_id, code, name, rank, is_default, is_statutory_default)
    VALUES (${tenant}, 'medium', 'Medium', 3, true, true) RETURNING id
  `;
  const [e] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenant}, 'organization', 'Deccan Agro Foods Pvt Ltd') RETURNING id
  `;
  const [r] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_template
      (tenant_id, jurisdiction, name, recurrence, fiscal_year_start_month,
       due_rule, due_month_offset, due_day_of_month, rule_pack)
    VALUES (${tenant}, 'IN', 'GSTR-3B', 'monthly', 4, 'day_of_month', 1, 20, ${`link@${stamp}`})
    RETURNING id
  `;
  const notStarted = states.find((s) => s.code === "not_started")?.id;
  if (!pend || !fil || !p || !e || !r || notStarted === undefined) throw new Error("fixture rows missing");
  pending = pend.id;
  filed = fil.id;
  entity = e.id;
  rule = r.id;
  const task = async (title: string): Promise<string> => {
    const id = randomUUID();
    await owner`
      INSERT INTO delivery.work_item (id, tenant_id, client_party_id, title, state_id, priority_id, is_client_visible)
      VALUES (${id}, ${tenant}, ${entity}, ${title}, ${notStarted}, ${p.id}, false)
    `;
    return id;
  };
  taskA = await task("File GSTR-3B for September");
  taskB = await task("Another task");
});

afterAll(async () => {
  await owner.end();
  await app.end();
});

describe("the task-to-filing link, in SQL (CA#36)", () => {
  it("attaches only where the filing has no task, and detaches only the task on it while unfiled", async () => {
    const sep = await filing("2026-09-01", "Sep 2026", "2026-10-20");

    expect(await instances.attachWorkItem(tenant, sep, taskA)).toBe(true);
    expect(await instances.attachWorkItem(tenant, sep, taskB)).toBe(false);
    expect((await instances.findByWorkItem(tenant, taskA))?.id).toBe(sep);

    expect(await instances.detachWorkItem(tenant, sep, taskB)).toBe(false);
    expect(await instances.detachWorkItem(tenant, sep, taskA)).toBe(true);
    expect(await instances.findByWorkItem(tenant, taskA)).toBeNull();

    // Filed by the task: it stays on.
    expect(await instances.attachWorkItem(tenant, sep, taskA)).toBe(true);
    expect(await instances.markFiled(tenant, sep, "2026-10-03", filed)).toBe(true);
    expect(await instances.detachWorkItem(tenant, sep, taskA)).toBe(false);
  });

  it("offers the company's open filings with no task, and reads a linked one back by its own day", async () => {
    const oct = await filing("2026-10-01", "Oct 2026", "2026-11-20");
    const open = await instances.calendar(tenant, { entityPartyId: entity, includeSettled: false, limit: 500 });
    expect(open.filter((r) => r.workItemId === null).map((r) => r.id)).toContain(oct);

    await instances.attachWorkItem(tenant, oct, taskB);
    const [linked] = (
      await instances.calendar(tenant, {
        entityPartyId: entity,
        from: "2026-11-20",
        to: "2026-11-20",
        includeSettled: true,
      })
    ).filter((r) => r.id === oct);
    expect(linked).toMatchObject({ name: "GSTR-3B", periodLabel: "Oct 2026", workItemId: taskB });
  });
});
