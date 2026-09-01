// THE STATUS HOME'S OWN WALL (T6.5, migration 0062) — and it TRIES.
//
// `gate4.integration.test.ts` proved 0059's policy on `delivery.work_item`. This
// is the same discipline applied to what T6.5 added: the filings table, and the
// flag that decides which of a client's tasks the client may read. Both are
// RESTRICTIVE policies, both are checked here by asking for the row that must
// not come back — by id, with the correct firm — rather than by asking for the
// caller's own rows and being pleased when they arrive.
//
// ── HOW THIS FILE WAS CHECKED, WHICH IS THE POINT OF IT ───────────────────
//
// Every assertion below was watched go RED with its policy dropped and green
// with it back:
//
//   BEGIN; DROP POLICY obligation_instance_portal_scope ON delivery.obligation_instance;
//   -- run this file: the two filings tests fail, the rest pass
//   ROLLBACK;
//
//   BEGIN; DROP POLICY work_item_portal_visible ON delivery.work_item;
//   -- run this file: the internal-task test fails, the rest pass
//   ROLLBACK;
//
// A test that passes with the wall removed proves only that the rows exist.
//
// Run with:  npm run test:integration
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withPortal, withTenant } from "../../src/db/tenant";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const stamp = String(Date.now());
let tenantId = "";
/** Two clients of ONE firm — gate 1 is not what is under test here. */
let mine = "";
let theirs = "";
/** A company of `mine` that nobody granted. It is the case the entity-scoped
 *  filing policy exists to decide, and the answer is that its filings are NOT
 *  readable: a grant names a party, and this table names the entity. */
let mySubsidiary = "";
let visibleItem = "";
let internalItem = "";
let myFiling = "";
let subsidiaryFiling = "";
let theirFiling = "";

beforeAll(async () => {
  const [tenant] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`portal-reads-${stamp}`}, 'Portal Reads Test', 'INR') RETURNING id
  `;
  if (!tenant) throw new Error("could not create the test tenant");
  tenantId = tenant.id;

  const party = async (name: string): Promise<string> => {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO core.party (tenant_id, kind, display_name)
      VALUES (${tenantId}, 'organization', ${name}) RETURNING id
    `;
    if (!row) throw new Error(`could not create ${name}`);
    return row.id;
  };
  mine = await party(`Mine ${stamp}`);
  theirs = await party(`Theirs ${stamp}`);
  mySubsidiary = await party(`My subsidiary ${stamp}`);

  const [state] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_state (tenant_id, code, name, is_initial, sort_order)
    VALUES (${tenantId}, 'open', 'Open', true, 10) RETURNING id
  `;
  const [priority] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_priority (tenant_id, code, name, rank)
    VALUES (${tenantId}, 'normal', 'Normal', 3) RETURNING id
  `;
  if (!state || !priority) throw new Error("could not seed the work vocabulary");

  const item = async (client: string, title: string, clientVisible: boolean): Promise<string> => {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO delivery.work_item
        (tenant_id, client_party_id, title, state_id, priority_id, is_client_visible)
      VALUES (${tenantId}, ${client}, ${title}, ${state.id}, ${priority.id}, ${clientVisible})
      RETURNING id
    `;
    if (!row) throw new Error(`could not create ${title}`);
    return row.id;
  };
  visibleItem = await item(mine, "Their own filing, shared", true);
  internalItem = await item(mine, "Write-off discussion — internal", false);

  // The compliance calendar's own rows. A template and a state are the firm's
  // vocabulary; the instances are what the generator writes.
  const [template] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_template
      (tenant_id, jurisdiction, name, recurrence, fiscal_year_start_month,
       due_rule, due_month_offset, due_day_of_month, rule_pack)
    VALUES (${tenantId}, 'IN', 'GSTR-3B', 'monthly', 4, 'day_of_month', 1, 20, 'test')
    RETURNING id
  `;
  const [obState] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_state (tenant_id, code, name, is_initial, sort_order)
    VALUES (${tenantId}, 'pending', 'Pending', true, 10) RETURNING id
  `;
  if (!template || !obState) throw new Error("could not seed the calendar vocabulary");

  const instance = async (entity: string, periodStart: string): Promise<string> => {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO delivery.obligation_instance
        (tenant_id, template_id, entity_party_id, period_start, period_end, period_label,
         statutory_due_on, internal_target_on, state_id)
      VALUES (${tenantId}, ${template.id}, ${entity}, ${periodStart}, ${periodStart},
              'Test period', '2099-01-20', '2099-01-13', ${obState.id})
      RETURNING id
    `;
    if (!row) throw new Error(`could not create an instance for ${entity}`);
    return row.id;
  };
  myFiling = await instance(mine, "2099-01-01");
  subsidiaryFiling = await instance(mySubsidiary, "2099-01-02");
  theirFiling = await instance(theirs, "2099-01-03");
});

afterAll(async () => {
  await owner`DELETE FROM delivery.obligation_instance WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.obligation_template WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.obligation_state WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.work_item WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.work_item_state WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.work_item_priority WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM core.party WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM tenancy.tenant WHERE id = ${tenantId}`;
  await app.end();
  await owner.end();
});

describe("what a portal session may read of the compliance calendar", () => {
  it("a STAFF session is untouched: all three companies' filings are readable", async () => {
    // The first thing to check whenever a restrictive policy lands. If this
    // fails, gate 4 has narrowed the staff workspace — the opposite mistake, and
    // the one that gets blamed on everything else first.
    const rows = await withTenant(app, tenantId, async (db) => {
      return db<{ id: string }[]>`
        SELECT id FROM delivery.obligation_instance WHERE tenant_id = ${tenantId}
      `;
    });
    expect(rows).toHaveLength(3);
  });

  it("AND IT TRIES: another client's filing, asked for BY ID, comes back empty", async () => {
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ id: string }[]>`
        SELECT id FROM delivery.obligation_instance WHERE id = ${theirFiling}
      `;
    });
    expect(rows).toHaveLength(0);
  });

  it("A GRANT NAMES A PARTY, so an ungranted company of the same client is refused", async () => {
    // The decision this policy records, and it is the one worth stating: this
    // table names the ENTITY (0053: "Whose obligation it is. The ENTITY, never
    // the client"), so a contact granted the client sees the client's own
    // filings and not its subsidiary's. Reaching the subsidiary would mean
    // joining `crm.engagement` — a nullable join, and the derivation 0059
    // refused. A contact who should see both gets two grants.
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ id: string }[]>`
        SELECT id FROM delivery.obligation_instance WHERE tenant_id = ${tenantId}
      `;
    });
    expect(rows.map((r) => r.id)).toEqual([myFiling]);

    // ...and two grants is all it takes, which is what makes the strictness
    // workable rather than a dead end.
    const both = await withPortal(app, tenantId, [mine, mySubsidiary], async (db) => {
      return db<{ id: string }[]>`
        SELECT id FROM delivery.obligation_instance WHERE tenant_id = ${tenantId} ORDER BY period_start
      `;
    });
    expect(both.map((r) => r.id)).toEqual([myFiling, subsidiaryFiling]);
  });

  it("a portal session with NO grants sees no filings at all", async () => {
    const rows = await withPortal(app, tenantId, [], async (db) => {
      return db<{ id: string }[]>`
        SELECT id FROM delivery.obligation_instance WHERE tenant_id = ${tenantId}
      `;
    });
    expect(rows).toHaveLength(0);
  });

  it("and cannot write one either", async () => {
    // There is no portal write path and this is why one will not have to be
    // built with the rule inside it. WITH CHECK, not only USING.
    await expect(
      withPortal(app, tenantId, [mine], async (db) => {
        return db`
          INSERT INTO delivery.obligation_instance
            (tenant_id, template_id, entity_party_id, period_start, period_end, period_label,
             statutory_due_on, internal_target_on, state_id)
          SELECT tenant_id, template_id, ${theirs}, '2099-02-01', '2099-02-01', 'smuggled',
                 statutory_due_on, internal_target_on, state_id
          FROM delivery.obligation_instance WHERE id = ${myFiling}
        `;
      }),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe("the firm decides which of a client's tasks the client reads", () => {
  it("`is_client_visible` had a writer and no reader from 0051 until now", async () => {
    // The column carries the client's own words — "Clients would be able to see
    // their tasks" — and 0051 said its reader would be the portal. This is that
    // reader, and it is in the POLICY rather than in the query: a portal read
    // that forgets the filter would otherwise return an internal review note
    // with a 200 and nothing anywhere would say so.
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ id: string }[]>`
        SELECT id FROM delivery.work_item WHERE tenant_id = ${tenantId}
      `;
    });
    expect(rows.map((r) => r.id)).toEqual([visibleItem]);
  });

  it("AND IT TRIES: the internal task, asked for BY ID, comes back empty", async () => {
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ id: string }[]>`SELECT id FROM delivery.work_item WHERE id = ${internalItem}`;
    });
    expect(rows).toHaveLength(0);
  });

  it("a STAFF session still sees both — the flag is about the CLIENT's view", async () => {
    const rows = await withTenant(app, tenantId, async (db) => {
      return db<{ id: string }[]>`
        SELECT id FROM delivery.work_item WHERE tenant_id = ${tenantId}
      `;
    });
    expect(rows.map((r) => r.id).sort()).toEqual([visibleItem, internalItem].sort());
  });
});
