// Restating a calendar that already exists, proven against the real database
// (T6.4).
//
// ── WHY THIS FILE HAD TO BE WRITTEN, AND WHY THE UNIT TESTS DO NOT COVER IT ─
//
// `listUnstarted` and `restate` are the two statements that make the rules
// screen more than a form. A partner supplies the formula for one of the
// forty-seven rules that ship without one, or corrects one of the ten that have
// one, and these move the filings already sitting on the calendar. The unit
// tests run against `FakeObligationInstanceRepository`, which agrees with the
// service by construction and executes no SQL whatever.
//
// That is not a theoretical gap. The multi-row INSERT four hundred lines above
// `restate` carries a comment about a DOUBLE CAST — `::text::jsonb` — added
// because postgres.js re-encodes a string parameter as JSON and a plain
// `::jsonb` produced a jsonb STRING rather than an array. Every sweep died on
// it, and it was found by RUNNING the worker, because the unit tests used a
// fake and the integration test inserted rows by hand. `restate` uses the same
// construction. So it is executed here, for real, or the same bug ships again.
//
// Three things are proven, and each is a claim the fake cannot make:
//
//   1. `listUnstarted` returns the DAY stored, not the day the process's zone
//      makes of a UTC midnight — the mistake `day.ts` exists to name.
//   2. `restate` writes both dates for a batch in one statement.
//   3. Its WHERE clause holds even when handed an id it should refuse: a row
//      picked up between the read and the write is NOT moved. This is the guard
//      the fake also implements — which is exactly why it proves nothing there.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresObligationInstanceRepository } from "../../src/infrastructure/postgres/obligation-instance-repository";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });

const instances = new PostgresObligationInstanceRepository(app);

const stamp = Date.now().toString(36);
const slug = `restate-test-${stamp}`;

interface Ids {
  tenant: string;
  entity: string;
  state: string;
  rule: string;
  workItemState: string;
  workItemPriority: string;
}
let ids: Ids;

/** Three months, all at the 20th of the following month — the shipped GSTR-3B
 *  formula, and the one a partner is most likely to be correcting. */
const PERIODS = [
  { start: "2026-08-01", end: "2026-08-31", label: "Aug 2026", due: "2026-09-20" },
  { start: "2026-09-01", end: "2026-09-30", label: "Sep 2026", due: "2026-10-20" },
  { start: "2026-10-01", end: "2026-10-31", label: "Oct 2026", due: "2026-11-20" },
] as const;

beforeAll(async () => {
  const [t] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${slug}, 'Harbour Point', 'INR') RETURNING id
  `;
  if (!t) throw new Error("could not create the test firm");

  const [e] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${t.id}, 'organization', 'Kaveri Foods Pvt Ltd') RETURNING id
  `;
  const [s] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_state (tenant_id, code, name, is_initial)
    VALUES (${t.id}, 'pending', 'Pending', true) RETURNING id
  `;
  const [r] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_template
      (tenant_id, jurisdiction, name, recurrence, fiscal_year_start_month,
       due_rule, due_month_offset, due_day_of_month, rule_pack)
    VALUES (${t.id}, 'IN', 'GSTR-3B', 'monthly', 4, 'day_of_month', 1, 20, 'gst-in@2026.07')
    RETURNING id
  `;
  if (!e || !s || !r) throw new Error("could not seed the test firm");

  // A work item state, so one filing can be given a task and become the row
  // this must refuse to move.
  const [ws] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_state (tenant_id, code, name, is_initial)
    VALUES (${t.id}, 'open', 'Open', true) RETURNING id
  `;
  const [wp] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_priority (tenant_id, code, name, rank, is_default)
    VALUES (${t.id}, 'normal', 'Normal', 50, true) RETURNING id
  `;
  if (!ws || !wp) throw new Error("could not seed the work item vocabulary");

  ids = {
    tenant: t.id,
    entity: e.id,
    state: s.id,
    rule: r.id,
    workItemState: ws.id,
    workItemPriority: wp.id,
  };

  for (const p of PERIODS) {
    await owner`
      INSERT INTO delivery.obligation_instance
        (tenant_id, template_id, entity_party_id, period_start, period_end, period_label,
         statutory_due_on, internal_target_on, state_id)
      VALUES (${t.id}, ${r.id}, ${e.id}, ${p.start}::date, ${p.end}::date, ${p.label},
              ${p.due}::date, ${p.due}::date, ${s.id})
    `;
  }
});

afterAll(async () => {
  await owner`DELETE FROM delivery.obligation_instance WHERE tenant_id = ${ids.tenant}`;
  await owner`DELETE FROM delivery.work_item WHERE tenant_id = ${ids.tenant}`;
  await owner`DELETE FROM delivery.obligation_template WHERE tenant_id = ${ids.tenant}`;
  await owner`DELETE FROM delivery.work_item_state WHERE tenant_id = ${ids.tenant}`;
  await owner`DELETE FROM delivery.work_item_priority WHERE tenant_id = ${ids.tenant}`;
  await owner`DELETE FROM delivery.obligation_state WHERE tenant_id = ${ids.tenant}`;
  await owner`DELETE FROM core.party WHERE tenant_id = ${ids.tenant}`;
  await owner`DELETE FROM tenancy.tenant WHERE slug = ${slug}`;
  await Promise.all([owner.end(), app.end()]);
});

describe("reading the filings a rule edit may move", () => {
  it("returns the DAY stored, in whatever zone this process runs in", async () => {
    // The mistake `day.ts` exists to name: a `date` column arrives at UTC
    // midnight, and reading it with the local getters is a day early west of
    // Greenwich. These queries cast to `::text` and never build a `Date` at
    // all, which is the pattern that cannot get it wrong.
    const rows = await instances.listUnstarted(ids.tenant, ids.rule);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.periodStart)).toEqual(["2026-08-01", "2026-09-01", "2026-10-01"]);
    expect(rows.map((r) => r.statutoryDueOn)).toEqual([
      "2026-09-20",
      "2026-10-20",
      "2026-11-20",
    ]);
    expect(rows[0]?.periodLabel).toBe("Aug 2026");
  });
});

describe("writing the new dates back", () => {
  it("moves a batch in ONE statement, both dates, and says how many", async () => {
    // The statement whose sibling four hundred lines above needed a double cast
    // to run at all. Executed for real here, which is the only place that can
    // be established.
    const before = await instances.listUnstarted(ids.tenant, ids.rule);
    const moved = before.map((r) => ({
      id: r.id,
      // The 11th rather than the 20th — a formula correction, not a lead time.
      statutoryDueOn: r.statutoryDueOn.replace(/-20$/, "-11"),
      internalTargetOn: r.statutoryDueOn.replace(/-20$/, "-08"),
    }));

    expect(await instances.restate(ids.tenant, moved)).toBe(3);

    const after = await instances.listUnstarted(ids.tenant, ids.rule);
    expect(after.map((r) => r.statutoryDueOn)).toEqual([
      "2026-09-11",
      "2026-10-11",
      "2026-11-11",
    ]);
    expect(after.map((r) => r.internalTargetOn)).toEqual([
      "2026-09-08",
      "2026-10-08",
      "2026-11-08",
    ]);
  });

  it("does NOTHING for an empty batch, without going to the database", async () => {
    expect(await instances.restate(ids.tenant, [])).toBe(0);
  });

  it("REFUSES a filing somebody picked up between the read and the write", async () => {
    // The guard that makes the returned count honest. `listUnstarted` is a
    // snapshot; by the time the UPDATE runs, somebody may have started one of
    // these, and a rule edit must not move a date out from under them. The
    // WHERE clause repeats the test rather than trusting the ids handed in.
    const rows = await instances.listUnstarted(ids.tenant, ids.rule);
    const taken = rows[0];
    if (!taken) throw new Error("expected three un-started filings");

    const [wi] = await owner<{ id: string }[]>`
      INSERT INTO delivery.work_item
        (tenant_id, client_party_id, title, state_id, priority_id, due_on)
      VALUES (${ids.tenant}, ${ids.entity}, 'File GSTR-3B — Aug 2026', ${ids.workItemState},
              ${ids.workItemPriority}, '2026-09-11'::date)
      RETURNING id
    `;
    if (!wi) throw new Error("could not raise a task");
    await owner`
      UPDATE delivery.obligation_instance SET work_item_id = ${wi.id} WHERE id = ${taken.id}
    `;

    // The whole batch is offered, the started one included — which is exactly
    // what a stale snapshot would do.
    const offered = rows.map((r) => ({
      id: r.id,
      statutoryDueOn: "2027-01-01",
      internalTargetOn: "2027-01-01",
    }));
    expect(await instances.restate(ids.tenant, offered)).toBe(2);

    const [held] = await owner<{ statutory_due_on: string }[]>`
      SELECT statutory_due_on::text FROM delivery.obligation_instance WHERE id = ${taken.id}
    `;
    expect(held?.statutory_due_on).toBe(taken.statutoryDueOn);

    // And it has left the un-started list altogether, which is what makes the
    // service's `locked` count the difference between two queries.
    const remaining = await instances.listUnstarted(ids.tenant, ids.rule);
    expect(remaining).toHaveLength(2);
    expect(await instances.countFor(ids.tenant, ids.rule)).toBe(3);
  });
});
