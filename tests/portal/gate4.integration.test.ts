// GATE 4 — a client-portal session sees its OWN companies and nothing else.
//
// The acceptance line on G3.4 is "a portal login cannot read another client's
// anything, proven by a test that TRIES", and that word is the whole design of
// this file. A test that asks for its own data and gets it proves nothing about
// a wall; it is the request for somebody ELSE's row that has to come back empty.
//
// It runs against real Postgres for `immutability.integration.test.ts`' reason:
// a fake can assert that our code passes a filter, only the database can assert
// that the row is unreachable WITHOUT one. The threat is not the repository we
// wrote — it is the portal read somebody adds next month and forgets to filter,
// and the whole point of putting gate 4 in RLS is that such a read returns
// nothing rather than another client's filings with a 200.
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
/** Two clients of the SAME firm. The tenant wall is not what is being tested
 *  here — gate 1 already holds it, and a second firm's rows would be refused by
 *  a policy that has nothing to do with gate 4. Two clients inside one firm is
 *  precisely the case gates 1–3 all allow through. */
let mine = "";
let theirs = "";
let myItem = "";
let theirItem = "";

beforeAll(async () => {
  const [tenant] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${`portal-gate4-${stamp}`}, 'Portal Gate 4 Test', 'INR') RETURNING id
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

  // The firm's own vocabulary, because a work item cannot exist without a state
  // and a priority — they are rows, not enums (0050).
  const [state] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_state (tenant_id, code, name, is_initial, sort_order)
    VALUES (${tenantId}, 'open', 'Open', true, 10) RETURNING id
  `;
  const [priority] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_priority (tenant_id, code, name, rank)
    VALUES (${tenantId}, 'normal', 'Normal', 3) RETURNING id
  `;
  if (!state || !priority) throw new Error("could not seed the vocabulary");

  const item = async (client: string, title: string): Promise<string> => {
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO delivery.work_item (tenant_id, client_party_id, title, state_id, priority_id)
      VALUES (${tenantId}, ${client}, ${title}, ${state.id}, ${priority.id}) RETURNING id
    `;
    if (!row) throw new Error(`could not create ${title}`);
    return row.id;
  };
  myItem = await item(mine, "My own filing");
  theirItem = await item(theirs, "Somebody else's filing");
});

afterAll(async () => {
  await owner`DELETE FROM delivery.work_item WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.work_item_state WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM delivery.work_item_priority WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM core.party WHERE tenant_id = ${tenantId}`;
  await owner`DELETE FROM tenancy.tenant WHERE id = ${tenantId}`;
  await app.end();
  await owner.end();
});

describe("gate 4 — record scope", () => {
  it("a STAFF session is untouched: both clients' work is readable", async () => {
    // The restrictive policy must cost a staff request nothing. If this ever
    // fails, gate 4 has narrowed the staff workspace — the opposite mistake,
    // and the one that would be blamed on everything else first.
    const rows = await withTenant(app, tenantId, async (db) => {
      return db<{ id: string }[]>`SELECT id FROM delivery.work_item WHERE tenant_id = ${tenantId}`;
    });
    expect(rows.map((r) => r.id).sort()).toEqual([myItem, theirItem].sort());
  });

  it("a PORTAL session sees only the company it was granted", async () => {
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ id: string }[]>`SELECT id FROM delivery.work_item WHERE tenant_id = ${tenantId}`;
    });
    expect(rows.map((r) => r.id)).toEqual([myItem]);
  });

  it("AND IT TRIES: asking for the other client's row BY ID returns nothing", async () => {
    // The test that matters. The row exists, the id is correct, the firm is
    // right, and the query names it directly — the shape a portal read written
    // without a filter would produce. It comes back empty because the wall is
    // under the query rather than in it.
    const rows = await withPortal(app, tenantId, [mine], async (db) => {
      return db<{ id: string }[]>`SELECT id FROM delivery.work_item WHERE id = ${theirItem}`;
    });
    expect(rows).toHaveLength(0);
  });

  it("a portal session with NO grants sees nothing at all", async () => {
    // Not an edge case — it is every portal login between being invited and
    // being granted anything, and it is the case where "unset" and "empty" must
    // not be the same value. An empty list that fell back to the staff branch
    // would hand a brand-new portal contact the whole firm.
    const rows = await withPortal(app, tenantId, [], async (db) => {
      return db<{ id: string }[]>`SELECT id FROM delivery.work_item WHERE tenant_id = ${tenantId}`;
    });
    expect(rows).toHaveLength(0);
  });

  it("a portal session cannot WRITE another client's work either", async () => {
    // The restrictive policy carries WITH CHECK as well as USING, so the gate is
    // not read-only. A portal write path does not exist yet and this is why it
    // will not need one built into it.
    await expect(
      withPortal(app, tenantId, [mine], async (db) => {
        return db`
          INSERT INTO delivery.work_item (tenant_id, client_party_id, title, state_id, priority_id)
          SELECT ${tenantId}, ${theirs}, 'smuggled', state_id, priority_id
          FROM delivery.work_item WHERE id = ${myItem}
        `;
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it("the scope does not leak to the next request on the same connection", async () => {
    // SET LOCAL semantics, and the reason this file uses a pool of 2: a GUC that
    // survived the transaction would make the NEXT staff request on that
    // connection a portal request, which is a leak that only ever shows under
    // load. Run the portal query first, then the staff one, and the staff one
    // must see both rows again.
    await withPortal(app, tenantId, [mine], async (db) => {
      return db`SELECT 1 FROM delivery.work_item WHERE tenant_id = ${tenantId}`;
    });
    const rows = await withTenant(app, tenantId, async (db) => {
      return db<{ id: string }[]>`SELECT id FROM delivery.work_item WHERE tenant_id = ${tenantId}`;
    });
    expect(rows).toHaveLength(2);
  });
});
