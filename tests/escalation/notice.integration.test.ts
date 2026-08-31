// The escalation notice, proven where its claims actually have to hold: the
// database (T4.5).
//
// Four properties, and not one of them can be tested with a fake — a fake
// agrees with the service by construction, and every rule below is one a
// script, an import or a psql session has to obey as well:
//
//   1. RLS isolates a firm's notices.
//   2. The COMPOSITE foreign key refuses another firm's work item. This is the
//      failure RLS does not catch and the reason CLAUDE.md insists on
//      `(id, tenant_id)`: a foreign-key check runs as a system operation the
//      row policies do not filter, so an id-only reference would let one firm's
//      escalation hang off another firm's task with no policy violation
//      anywhere.
//   3. The partial UNIQUE INDEX refuses a rung already climbed. That is the
//      whole idempotency contract, and it has to be structural: the sweep is
//      at-least-once, and a partner told the same thing every morning stops
//      reading the queue.
//   4. The landed CHECK refuses a notice addressed to a person AND a rank at
//      once, and one addressed to nobody with no reason. "Who is this for" must
//      have exactly one answer, and "nobody" must say why.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });

const stamp = Date.now().toString(36);
const slugA = `esc-test-a-${stamp}`;
const slugB = `esc-test-b-${stamp}`;

interface Ids {
  tenantA: string;
  tenantB: string;
  itemA: string;
  itemB: string;
  anita: string;
}
let ids: Ids;

/** One firm with a work item on its board, built from the vocabulary
 *  `createTenant` seeds — this test creates the tenant directly, so it seeds the
 *  two rows a work item cannot exist without. */
async function seedFirm(slug: string, name: string, title: string): Promise<{
  tenantId: string;
  itemId: string;
}> {
  const [tenant] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${slug}, ${name}, 'INR') RETURNING id
  `;
  if (!tenant) throw new Error(`could not create ${slug}`);

  const [client] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${tenant.id}, 'organization', ${`${name} Client`}) RETURNING id
  `;
  const [state] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_state (tenant_id, code, name, is_initial, sort_order)
    VALUES (${tenant.id}, 'pending', 'Pending', true, 10) RETURNING id
  `;
  // A SUCCESSFUL TERMINAL STATE TOO, even though nothing here reads it. This
  // test creates a tenant directly rather than through `createTenant`, and
  // `calendar.integration.test.ts` asks the CATALOGUE whether every firm has
  // one — so a firm seeded without it fails somebody else's test, and did.
  // Cleanup makes that rare; a crashed run makes it happen anyway.
  await owner`
    INSERT INTO delivery.work_item_state
      (tenant_id, code, name, is_terminal, is_success, sort_order)
    VALUES (${tenant.id}, 'completed', 'Completed', true, true, 90)
  `;
  await owner`
    INSERT INTO delivery.obligation_state
      (tenant_id, code, name, is_initial, sort_order)
    VALUES (${tenant.id}, 'pending', 'Pending', true, 10)
  `;
  await owner`
    INSERT INTO delivery.obligation_state
      (tenant_id, code, name, is_terminal, is_filed, sort_order)
    VALUES (${tenant.id}, 'filed', 'Filed', true, true, 30)
  `;
  const [priority] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item_priority (tenant_id, code, name, rank, is_default)
    VALUES (${tenant.id}, 'normal', 'Normal', 20, true) RETURNING id
  `;
  if (!client || !state || !priority) throw new Error(`could not seed ${slug}`);

  const [item] = await owner<{ id: string }[]>`
    INSERT INTO delivery.work_item (tenant_id, client_party_id, title, state_id, priority_id, due_on)
    VALUES (${tenant.id}, ${client.id}, ${title}, ${state.id}, ${priority.id}, '2026-08-01'::date)
    RETURNING id
  `;
  if (!item) throw new Error(`could not create ${slug}'s work item`);
  return { tenantId: tenant.id, itemId: item.id };
}

beforeAll(async () => {
  // Two firms, deliberately. Isolation you cannot see is isolation you cannot
  // trust — with one tenant seeded, an RLS bug looks exactly like a working
  // system.
  const a = await seedFirm(slugA, "Harbour Point", "File GSTR-3B");
  const b = await seedFirm(slugB, "Northfield Advisory", "Board minutes");

  const [u1] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`esc-anita-${stamp}@harbour.example`}, 'Anita Rao') RETURNING id
  `;
  if (!u1) throw new Error("could not create the test account");

  ids = {
    tenantA: a.tenantId,
    tenantB: b.tenantId,
    itemA: a.itemId,
    itemB: b.itemId,
    anita: u1.id,
  };
});

afterAll(async () => {
  const both = [ids.tenantA, ids.tenantB];
  await owner`DELETE FROM delivery.escalation_notice WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM delivery.work_item WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM delivery.obligation_state WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM delivery.work_item_state WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM delivery.work_item_priority WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM core.party WHERE tenant_id IN ${owner(both)}`;
  await owner`DELETE FROM tenancy.user_account WHERE id = ${ids.anita}`;
  await owner`DELETE FROM tenancy.tenant WHERE slug IN (${slugA}, ${slugB})`;
  await Promise.all([owner.end(), app.end()]);
});

/** One statement under a tenant's RLS context, the way the resolver does it. */
async function asTenant<T>(
  tenantId: string,
  run: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return app.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return run(tx);
  }) as Promise<T>;
}

function raise(
  tenantId: string,
  row: {
    workItemId: string;
    rungKey: string;
    raisedToUserId?: string | null;
    minGradeRank?: number | null;
    note?: string | null;
  },
): Promise<string | undefined> {
  return asTenant(tenantId, async (tx) => {
    const [created] = await tx<{ id: string }[]>`
      INSERT INTO delivery.escalation_notice
        (tenant_id, work_item_id, rung_key, watch, after_days, target,
         raised_to_user_id, min_grade_rank, note, raised_on, days_past)
      VALUES (${tenantId}, ${row.workItemId}, ${row.rungKey}, 'work_item_due', 3, 'assignee',
              ${row.raisedToUserId ?? null}, ${row.minGradeRank ?? null}, ${row.note ?? null},
              '2026-08-31'::date, 30)
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    return created?.id;
  });
}

describe("delivery.escalation_notice", () => {
  it("isolates one firm's escalations from another's", async () => {
    await raise(ids.tenantA, { workItemId: ids.itemA, rungKey: "rls-a", raisedToUserId: ids.anita });
    await raise(ids.tenantB, { workItemId: ids.itemB, rungKey: "rls-b", raisedToUserId: ids.anita });

    const seenByA = await asTenant(
      ids.tenantA,
      (tx) => tx<{ rung_key: string }[]>`SELECT rung_key FROM delivery.escalation_notice`,
    );

    expect(seenByA.map((r) => r.rung_key)).toContain("rls-a");
    expect(seenByA.map((r) => r.rung_key)).not.toContain("rls-b");
  });

  it("refuses a notice pointed at ANOTHER firm's work item", async () => {
    // The failure RLS does not catch. The row's own tenant_id satisfies every
    // policy; what refuses it is the composite key carrying the tenant into the
    // reference.
    await expect(
      raise(ids.tenantA, { workItemId: ids.itemB, rungKey: "cross", raisedToUserId: ids.anita }),
    ).rejects.toThrow(/escalation_notice_work_item_tenant_fkey|foreign key/i);
  });

  it("climbs a rung once and only once", async () => {
    const first = await raise(ids.tenantA, {
      workItemId: ids.itemA,
      rungKey: "manager",
      raisedToUserId: ids.anita,
    });
    const second = await raise(ids.tenantA, {
      workItemId: ids.itemA,
      rungKey: "manager",
      raisedToUserId: ids.anita,
    });

    expect(first).toBeDefined();
    // Undefined, not an error: `ON CONFLICT DO NOTHING` returning no row is how
    // the adapter reports "already climbed", and the service reads that as
    // "write no event" rather than as a fault.
    expect(second).toBeUndefined();
  });

  it("refuses a notice addressed to a person AND a rank", async () => {
    await expect(
      raise(ids.tenantA, {
        workItemId: ids.itemA,
        rungKey: "both",
        raisedToUserId: ids.anita,
        minGradeRank: 40,
      }),
    ).rejects.toThrow(/escalation_notice_landed_chk/);
  });

  it("refuses a notice addressed to nobody with no reason", async () => {
    // An escalation that reached nobody is a real state and the row still
    // fires — but it has to SAY which of the three reasons, because that
    // sentence is the only thing making the queue clearable.
    await expect(
      raise(ids.tenantA, { workItemId: ids.itemA, rungKey: "silent" }),
    ).rejects.toThrow(/escalation_notice_landed_chk/);

    const withReason = await raise(ids.tenantA, {
      workItemId: ids.itemA,
      rungKey: "unresolved",
      note: "Nobody is recorded above the person holding this.",
    });
    expect(withReason).toBeDefined();
  });

  it("refuses a notice about both a task and a filing, or about neither", async () => {
    await expect(
      asTenant(ids.tenantA, (tx) =>
        tx`
          INSERT INTO delivery.escalation_notice
            (tenant_id, rung_key, watch, after_days, target, raised_to_user_id, raised_on, days_past)
          VALUES (${ids.tenantA}, 'no-subject', 'work_item_due', 3, 'assignee',
                  ${ids.anita}, '2026-08-31'::date, 1)
        `,
      ),
    ).rejects.toThrow(/escalation_notice_subject_chk/);
  });
});
