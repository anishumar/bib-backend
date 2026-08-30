// The compliance calendar, proven where its claims actually have to hold: the
// database (T3.2).
//
// Six properties, and not one of them can be tested with a fake — a fake agrees
// with the service by construction, and every rule below is one a script, an
// import, an agent or a psql session has to obey as well:
//
//   1. RLS isolates a firm's rules and its calendar.
//   2. The COMPOSITE foreign keys refuse a cross-tenant template, entity and
//      state. This is the failure RLS does NOT catch and the reason CLAUDE.md
//      insists on `(id, tenant_id)`: a foreign-key check runs as a system
//      operation the row policies do not filter.
//   3. THE RE-RUN KEY. `UNIQUE (tenant, template, entity, period_start)` is what
//      makes the generator safe to run every night forever, and the service's
//      idempotency is worth exactly as much as this constraint.
//   4. `obligation_due_rule_chk` — a rule either computes completely or says why
//      it cannot, and the third state (half a formula, or neither) is
//      unrepresentable rather than merely refused by the service.
//   5. T–X can never land after T. The domain clamps it; this proves the
//      database refuses to store it if the clamp is ever removed.
//   6. NOTHING can be deleted. `bib_app` holds no DELETE grant on any of the
//      four tables — retiring a rule is a flag, and withdrawing an exception is
//      a flag, because both are WHY a filing was due on the day it was.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });

const stamp = Date.now().toString(36);
const slugA = `oblig-test-a-${stamp}`;
const slugB = `oblig-test-b-${stamp}`;

interface Ids {
  tenantA: string;
  tenantB: string;
  entityA: string;
  entityB: string;
  stateA: string;
  stateB: string;
  ruleA: string;
}
let ids: Ids;

beforeAll(async () => {
  // Two firms, deliberately. Isolation you cannot see is isolation you cannot
  // trust — with one tenant seeded, an RLS bug looks exactly like a working
  // system.
  const [a] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${slugA}, 'Harbour Point', 'INR') RETURNING id
  `;
  const [b] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${slugB}, 'Northfield Advisory', 'INR') RETURNING id
  `;
  if (!a || !b) throw new Error("could not create the two test firms");

  const [ea] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${a.id}, 'organization', 'Kaveri Foods Pvt Ltd') RETURNING id
  `;
  const [eb] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${b.id}, 'organization', 'Northfield Client Pvt Ltd') RETURNING id
  `;
  if (!ea || !eb) throw new Error("could not create the two test entities");

  const [sa] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_state (tenant_id, code, name, is_initial)
    VALUES (${a.id}, 'pending', 'Pending', true) RETURNING id
  `;
  const [sb] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_state (tenant_id, code, name, is_initial)
    VALUES (${b.id}, 'pending', 'Pending', true) RETURNING id
  `;
  if (!sa || !sb) throw new Error("could not create the two test states");

  const [ra] = await owner<{ id: string }[]>`
    INSERT INTO delivery.obligation_template
      (tenant_id, jurisdiction, name, recurrence, fiscal_year_start_month,
       due_rule, due_month_offset, due_day_of_month, rule_pack)
    VALUES (${a.id}, 'IN', 'GSTR-3B', 'monthly', 4, 'day_of_month', 1, 20, 'gst-in@2026.07')
    RETURNING id
  `;
  if (!ra) throw new Error("could not create the test rule");

  ids = {
    tenantA: a.id,
    tenantB: b.id,
    entityA: ea.id,
    entityB: eb.id,
    stateA: sa.id,
    stateB: sb.id,
    ruleA: ra.id,
  };
});

afterAll(async () => {
  await owner`DELETE FROM delivery.obligation_instance WHERE tenant_id IN (${ids.tenantA}, ${ids.tenantB})`;
  await owner`DELETE FROM delivery.obligation_template_exception WHERE tenant_id IN (${ids.tenantA}, ${ids.tenantB})`;
  await owner`DELETE FROM delivery.obligation_template WHERE tenant_id IN (${ids.tenantA}, ${ids.tenantB})`;
  await owner`DELETE FROM delivery.work_item_state WHERE tenant_id IN (${ids.tenantA}, ${ids.tenantB})`;
  await owner`DELETE FROM delivery.obligation_state WHERE tenant_id IN (${ids.tenantA}, ${ids.tenantB})`;
  await owner`DELETE FROM core.party WHERE tenant_id IN (${ids.tenantA}, ${ids.tenantB})`;
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

function insertInstance(
  tenantId: string,
  row: {
    templateId: string;
    entityPartyId: string;
    stateId: string;
    periodStart: string;
    periodEnd: string;
    statutoryDueOn: string;
    internalTargetOn: string;
  },
): Promise<{ id: string }[]> {
  return asTenant(tenantId, (tx) => tx<{ id: string }[]>`
    INSERT INTO delivery.obligation_instance
      (tenant_id, template_id, entity_party_id, period_start, period_end, period_label,
       statutory_due_on, internal_target_on, state_id)
    VALUES
      (${tenantId}, ${row.templateId}, ${row.entityPartyId}, ${row.periodStart}::date,
       ${row.periodEnd}::date, 'Aug 2026', ${row.statutoryDueOn}::date,
       ${row.internalTargetOn}::date, ${row.stateId})
    RETURNING id
  `);
}

const august = {
  periodStart: "2026-08-01",
  periodEnd: "2026-08-31",
  statutoryDueOn: "2026-09-20",
  internalTargetOn: "2026-09-20",
};

describe("the tenant wall", () => {
  it("shows a firm only its own rules", async () => {
    const mine = await asTenant(ids.tenantA, (tx) => tx`
      SELECT id FROM delivery.obligation_template
    `);
    const theirs = await asTenant(ids.tenantB, (tx) => tx`
      SELECT id FROM delivery.obligation_template
    `);
    expect(mine.map((r) => (r as { id: string }).id)).toContain(ids.ruleA);
    expect(theirs.map((r) => (r as { id: string }).id)).not.toContain(ids.ruleA);
  });

  it("shows a firm only its own calendar", async () => {
    await insertInstance(ids.tenantA, { templateId: ids.ruleA, entityPartyId: ids.entityA, stateId: ids.stateA, ...august });
    const theirs = await asTenant(ids.tenantB, (tx) => tx`
      SELECT id FROM delivery.obligation_instance
    `);
    expect(theirs).toHaveLength(0);
  });

  it("REFUSES an obligation against another firm's rule", async () => {
    // The failure RLS does not catch. A foreign-key check runs as a system
    // operation the row policies do not filter, so an id-only reference would
    // let firm B's calendar hang off firm A's rule with no policy violation
    // anywhere — it leaks nothing and the wall is still supposed to forbid it.
    await expect(
      insertInstance(ids.tenantB, {
        templateId: ids.ruleA,
        entityPartyId: ids.entityB,
        stateId: ids.stateB,
        ...august,
      }),
    ).rejects.toThrow(/obligation_instance_template_tenant_fkey|violates foreign key/);
  });

  it("REFUSES an obligation against another firm's entity", async () => {
    await expect(
      insertInstance(ids.tenantA, {
        templateId: ids.ruleA,
        entityPartyId: ids.entityB,
        stateId: ids.stateA,
        ...august,
      }),
    ).rejects.toThrow(/obligation_instance_entity_tenant_fkey|violates foreign key/);
  });

  it("REFUSES an obligation in another firm's state", async () => {
    await expect(
      insertInstance(ids.tenantA, {
        templateId: ids.ruleA,
        entityPartyId: ids.entityA,
        stateId: ids.stateB,
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        statutoryDueOn: "2026-11-20",
        internalTargetOn: "2026-11-20",
      }),
    ).rejects.toThrow(/obligation_instance_state_tenant_fkey|violates foreign key/);
  });
});

describe("the re-run key — what makes the generator safe to run forever", () => {
  it("refuses a second row for the same rule, entity and period", async () => {
    // The service's idempotency is worth exactly as much as this constraint:
    // the sweep can run concurrently with itself after a redelivery, and only
    // the database can arbitrate that correctly.
    const row = {
      templateId: ids.ruleA,
      entityPartyId: ids.entityA,
      stateId: ids.stateA,
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
      statutoryDueOn: "2026-12-20",
      internalTargetOn: "2026-12-20",
    };
    await insertInstance(ids.tenantA, row);
    await expect(insertInstance(ids.tenantA, row)).rejects.toThrow(
      /obligation_instance_key|duplicate key/,
    );
  });

  it("allows the SAME period for a different entity", async () => {
    // A client with four companies owes four sets of filings. The key is keyed
    // on the ENTITY for exactly this reason.
    const [second] = await owner<{ id: string }[]>`
      INSERT INTO core.party (tenant_id, kind, display_name)
      VALUES (${ids.tenantA}, 'organization', 'Kaveri Exports Pvt Ltd') RETURNING id
    `;
    if (!second) throw new Error("could not create the second entity");
    await expect(
      insertInstance(ids.tenantA, {
        templateId: ids.ruleA,
        entityPartyId: second.id,
        stateId: ids.stateA,
        periodStart: "2026-11-01",
        periodEnd: "2026-11-30",
        statutoryDueOn: "2026-12-20",
        internalTargetOn: "2026-12-20",
      }),
    ).resolves.toHaveLength(1);
  });
});

describe("a rule either computes completely or says why it cannot", () => {
  function insertRule(cols: string, values: (string | number | null)[]): Promise<unknown> {
    return asTenant(ids.tenantA, (tx) =>
      tx.unsafe(
        `INSERT INTO delivery.obligation_template
           (tenant_id, jurisdiction, name, recurrence, fiscal_year_start_month, rule_pack, ${cols})
         VALUES ($1, 'IN', $2, 'monthly', 4, 'chk@1', ${values
           .map((_, i) => `$${String(i + 3)}`)
           .join(", ")})`,
        [ids.tenantA, `chk-${stamp}-${Math.random().toString(36).slice(2, 8)}`, ...values],
      ),
    );
  }

  it("refuses HALF a day_of_month rule", async () => {
    // A half-stated rule produces no date, and a rule that produces no date
    // silently produces no calendar — which is the failure this whole module is
    // designed to make impossible.
    await expect(insertRule("due_rule, due_month_offset", ["day_of_month", 1])).rejects.toThrow(
      /obligation_due_rule_chk/,
    );
  });

  it("refuses a rule with neither a formula nor a reason", async () => {
    await expect(insertRule("due_rule", [null])).rejects.toThrow(/obligation_due_rule_chk/);
  });

  it("refuses a rule carrying BOTH a formula and an unresolved reason", async () => {
    await expect(
      insertRule("due_rule, due_month_offset, due_day_of_month, unresolved_reason", [
        "day_of_month",
        1,
        7,
        "we are not sure",
      ]),
    ).rejects.toThrow(/obligation_due_rule_chk/);
  });

  it("accepts a rule that honestly says it cannot compute a date", async () => {
    // The forty-six in the shipped pack. This is a first-class state, not a
    // degraded one.
    await expect(
      insertRule("due_rule, unresolved_reason", [null, "Depends on the AGM date."]),
    ).resolves.toBeDefined();
  });
});

describe("T–X can never land after T", () => {
  it("refuses an internal target later than the statutory date", async () => {
    // The domain clamps it. This is what refuses to store it if the clamp is
    // ever removed — an internal target after the legal one reads on the screen
    // as slack that does not exist.
    await expect(
      insertInstance(ids.tenantA, {
        templateId: ids.ruleA,
        entityPartyId: ids.entityA,
        stateId: ids.stateA,
        periodStart: "2026-12-01",
        periodEnd: "2026-12-31",
        statutoryDueOn: "2027-01-20",
        internalTargetOn: "2027-01-25",
      }),
    ).rejects.toThrow(/obligation_instance_target_chk/);
  });

  it("refuses a period that ends before it starts", async () => {
    await expect(
      insertInstance(ids.tenantA, {
        templateId: ids.ruleA,
        entityPartyId: ids.entityA,
        stateId: ids.stateA,
        periodStart: "2027-02-28",
        periodEnd: "2027-02-01",
        statutoryDueOn: "2027-03-20",
        internalTargetOn: "2027-03-20",
      }),
    ).rejects.toThrow(/obligation_instance_period_chk/);
  });
});

describe("nothing here can be deleted", () => {
  const tables = [
    "obligation_template",
    "obligation_template_exception",
    "obligation_state",
    "obligation_instance",
  ];

  for (const table of tables) {
    it(`refuses a DELETE on ${table}`, async () => {
      // Not a trigger — a MISSING GRANT. A trigger is a rule the table carries;
      // a grant the role does not hold is one an import, a script or an agent
      // walks past the first and not the second. Retiring is `is_active`, and
      // withdrawing an exception is `is_active`, because both are WHY a filing
      // was due on the day it was.
      await expect(
        asTenant(ids.tenantA, (tx) => tx.unsafe(`DELETE FROM delivery.${table}`)),
      ).rejects.toThrow(/permission denied/);
    });
  }
});

describe("one live exception per period month, and a withdrawn one does not block it", () => {
  it("refuses a second LIVE exception for March", async () => {
    // Two rows claiming March would make the due date depend on row order,
    // which is not a rule at all.
    const add = (note: string) =>
      asTenant(ids.tenantA, (tx) => tx`
        INSERT INTO delivery.obligation_template_exception
          (tenant_id, template_id, period_end_month, due_rule, due_month_offset,
           due_day_of_month, note)
        VALUES (${ids.tenantA}, ${ids.ruleA}, 3, 'day_of_month', 1, 30, ${note})
        RETURNING id
      `);
    await add("March is due 30 April by statute");
    await expect(add("a second claim on March")).rejects.toThrow(
      /idx_obligation_exception_key|duplicate key/,
    );
  });

  it("lets a WITHDRAWN March exception be replaced", async () => {
    // Which is exactly why the uniqueness is partial (`WHERE is_active`) rather
    // than a table constraint: a firm that withdraws a carve-out and later
    // writes a corrected one must not be blocked by the row it kept for the
    // record.
    await asTenant(ids.tenantA, (tx) => tx`
      UPDATE delivery.obligation_template_exception SET is_active = false
      WHERE template_id = ${ids.ruleA} AND period_end_month = 3
    `);
    await expect(
      asTenant(ids.tenantA, (tx) => tx`
        INSERT INTO delivery.obligation_template_exception
          (tenant_id, template_id, period_end_month, due_rule, due_month_offset,
           due_day_of_month, note)
        VALUES (${ids.tenantA}, ${ids.ruleA}, 3, 'day_of_month', 1, 30,
                'corrected, after the firm confirmed it')
        RETURNING id
      `),
    ).resolves.toHaveLength(1);

    // And BOTH rows survive — the withdrawn one is the record of what the rule
    // said in between.
    const all = await asTenant(ids.tenantA, (tx) => tx<{ n: string }[]>`
      SELECT count(*)::text AS n FROM delivery.obligation_template_exception
      WHERE template_id = ${ids.ruleA} AND period_end_month = 3
    `);
    expect(Number(all[0]?.n)).toBe(2);
  });
});

describe("at most one starting state per firm", () => {
  it("refuses a second", async () => {
    // Postgres can enforce AT MOST one and cannot enforce AT LEAST one, which
    // is why the seed guarantees the floor and this index guarantees the
    // ceiling. Two would make "what state is a new filing in" a coin toss.
    await expect(
      asTenant(ids.tenantA, (tx) => tx`
        INSERT INTO delivery.obligation_state (tenant_id, code, name, is_initial)
        VALUES (${ids.tenantA}, 'fresh', 'Fresh', true)
      `),
    ).rejects.toThrow(/idx_obligation_state_one_initial|duplicate key/);
  });

  it("refuses a state that is both terminal and needs a decision", async () => {
    // A state cannot be over AND waiting on somebody. `missed` needs a decision
    // and is therefore NOT terminal, which is the entire point of T3.3.
    await expect(
      asTenant(ids.tenantA, (tx) => tx`
        INSERT INTO delivery.obligation_state
          (tenant_id, code, name, is_terminal, needs_decision)
        VALUES (${ids.tenantA}, 'both', 'Both', true, true)
      `),
    ).rejects.toThrow(/obligation_state_terminal_chk/);
  });
});

// ── 0054: what "finished" means, on both sides of the join ─────────────────
//
// The two flags that close T3.2's open half, and every one of these is a rule a
// psql session, an import or an agent has to obey too. The service tests prove
// the BEHAVIOUR over fakes; these prove that nothing can put the database into
// a state where the behaviour is undefined.

describe("where a finished filing lands", () => {
  it("allows exactly one filed state per firm, and refuses a second", async () => {
    await asTenant(ids.tenantA, (tx) => tx`
      INSERT INTO delivery.obligation_state (tenant_id, code, name, is_terminal, is_filed)
      VALUES (${ids.tenantA}, 'filed', 'Filed', true, true)
    `);
    // With two, "where does a completed filing go" is a coin toss — and the
    // answer decides whether the calendar shows a return as done.
    await expect(
      asTenant(ids.tenantA, (tx) => tx`
        INSERT INTO delivery.obligation_state (tenant_id, code, name, is_terminal, is_filed)
        VALUES (${ids.tenantA}, 'submitted', 'Submitted', true, true)
      `),
    ).rejects.toThrow(/idx_obligation_state_one_filed|duplicate key/);
  });

  it("is per FIRM, so another firm may still have its own", async () => {
    // The index is partial on `(tenant_id) WHERE is_filed`. A global one would
    // let the first firm to mark a state stop every other firm from having one.
    await expect(
      asTenant(ids.tenantB, (tx) => tx`
        INSERT INTO delivery.obligation_state (tenant_id, code, name, is_terminal, is_filed)
        VALUES (${ids.tenantB}, 'filed', 'Filed', true, true)
      `),
    ).resolves.toBeDefined();
  });

  it("refuses a filed state that is not terminal", async () => {
    // A filing that landed somewhere still running would be neither finished
    // nor open, and `canStillBeMissed` would keep saying yes about work that is
    // already done.
    await expect(
      asTenant(ids.tenantA, (tx) => tx`
        INSERT INTO delivery.obligation_state (tenant_id, code, name, is_terminal, is_filed)
        VALUES (${ids.tenantA}, 'halfway', 'Halfway', false, true)
      `),
    ).rejects.toThrow(/obligation_state_filed_chk/);
  });
});

describe("a cancelled task is not a completed one", () => {
  it("refuses a work item state that claims success without being terminal", async () => {
    // The flag only means anything about work that has stopped. Ticked on a
    // running state it would file an obligation for work still in progress.
    await expect(
      asTenant(ids.tenantA, (tx) => tx`
        INSERT INTO delivery.work_item_state (tenant_id, code, name, is_terminal, is_success)
        VALUES (${ids.tenantA}, 'running_ok', 'Running OK', false, true)
      `),
    ).rejects.toThrow(/work_item_state_success_chk/);
  });

  it("lets a firm mark one terminal state a success and another not", async () => {
    // Which is the whole shape 0050 shipped and 0054 made readable: Completed
    // and Cancelled are both terminal, and only one of them is work the firm
    // finished. No index caps this one — a firm may legitimately have several
    // ways of finishing and several ways of giving up.
    const rows = await asTenant(ids.tenantA, (tx) => tx<{ code: string }[]>`
      INSERT INTO delivery.work_item_state (tenant_id, code, name, is_terminal, is_success)
      VALUES (${ids.tenantA}, 'filed_ok', 'Filed', true, true),
             (${ids.tenantA}, 'abandoned', 'Abandoned', true, false)
      RETURNING code
    `);
    expect(rows).toHaveLength(2);
  });
});

describe("every firm that already existed was brought forward", () => {
  it("gives each one a filed state and a successful terminal work state", async () => {
    // 0054's backfill, checked against the CATALOGUE rather than a list, the
    // way `tenant-keys.integration.test.ts` does — a firm created before this
    // migration whose flags were never set would have a completed task and an
    // obligation the calendar shows as open forever, silently.
    //
    // THIS FILE'S OWN TWO FIRMS ARE EXCLUDED, and that exclusion is what makes
    // the assertion mean anything. They are created by `beforeAll`, long after
    // the migration ran, so the backfill never saw them — and the describes
    // above go on to give them a filed state by hand. Without the exclusion
    // this passes because of the test that ran before it, which is a green
    // build proving nothing.
    const gaps = await owner<{ slug: string }[]>`
      SELECT t.slug FROM tenancy.tenant t
      WHERE t.slug NOT IN (${slugA}, ${slugB})
        AND EXISTS (SELECT 1 FROM delivery.obligation_state s WHERE s.tenant_id = t.id)
        AND NOT EXISTS (
          SELECT 1 FROM delivery.obligation_state s WHERE s.tenant_id = t.id AND s.is_filed
        )
    `;
    expect(gaps.map((g) => g.slug)).toEqual([]);

    const workGaps = await owner<{ slug: string }[]>`
      SELECT t.slug FROM tenancy.tenant t
      WHERE t.slug NOT IN (${slugA}, ${slugB})
        AND EXISTS (SELECT 1 FROM delivery.work_item_state s WHERE s.tenant_id = t.id)
        AND NOT EXISTS (
          SELECT 1 FROM delivery.work_item_state s
          WHERE s.tenant_id = t.id AND s.is_terminal AND s.is_success
        )
    `;
    expect(workGaps.map((g) => g.slug)).toEqual([]);

    // And it is not vacuous: there ARE firms in this database that predate the
    // migration. An assertion over an empty set is one that cannot fail.
    const [seeded] = await owner<{ n: string }[]>`
      SELECT count(*)::text AS n FROM tenancy.tenant t
      WHERE t.slug NOT IN (${slugA}, ${slugB})
        AND EXISTS (SELECT 1 FROM delivery.obligation_state s WHERE s.tenant_id = t.id)
    `;
    expect(Number(seeded?.n ?? 0)).toBeGreaterThan(0);
  });
});
