// Work items, proven where the claims actually have to hold: the database
// (T3.1).
//
// Six properties, and not one of them can be tested with a fake — a fake agrees
// with the service by construction, and every rule below is one a script, an
// import or a psql session has to obey as well:
//
//   1. RLS isolates a firm's work, its vocabulary and its reviews.
//   2. The COMPOSITE foreign keys refuse a cross-tenant client, state and
//      priority. This is the failure RLS does not catch and the reason
//      CLAUDE.md insists on `(id, tenant_id)`: a foreign-key check runs as a
//      system operation the row policies do not filter.
//   3. The TRIGGER reads the state's FLAGS, not its code. A blocked state
//      demands a reason; a terminal one demands a completion time; and both
//      keep working after the firm renames the state, which is the entire
//      promise migration 0050 makes.
//   4. `submitted_by` is DERIVED and FROZEN. That is what makes maker !=
//      checker worth anything: a maker the writer could set is not a control.
//   5. ONE work item per engagement, and ONE open review per work item —
//      partial unique indexes, because every trigger into this table is
//      at-least-once.
//   6. A TICKED checklist line cannot be deleted, and `work_item` cannot be
//      deleted at all.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });

const stamp = Date.now().toString(36);
const slugA = `work-test-a-${stamp}`;
const slugB = `work-test-b-${stamp}`;

interface Ids {
  tenantA: string;
  tenantB: string;
  clientA: string;
  clientB: string;
  priya: string;
  anand: string;
}
let ids: Ids;

/** The firm's own vocabulary, resolved once per firm — the rows migration 0050
 *  backfilled, which is also what a brand-new firm gets. */
interface Vocab {
  notStarted: string;
  inProgress: string;
  blocked: string;
  completed: string;
  medium: string;
}
let vocabA: Vocab;
let vocabB: Vocab;

async function vocabularyOf(tenantId: string): Promise<Vocab> {
  const states = await owner<{ code: string; id: string }[]>`
    SELECT code, id FROM delivery.work_item_state WHERE tenant_id = ${tenantId}
  `;
  const priorities = await owner<{ code: string; id: string }[]>`
    SELECT code, id FROM delivery.work_item_priority WHERE tenant_id = ${tenantId}
  `;
  const byCode = new Map([...states, ...priorities].map((r) => [r.code, r.id]));
  const need = (code: string): string => {
    const id = byCode.get(code);
    if (id === undefined) {
      throw new Error(
        `firm ${tenantId} has no "${code}" row. Migration 0050 seeds every tenant, so this ` +
          `means the backfill did not reach a firm created by this test.`,
      );
    }
    return id;
  };
  return {
    notStarted: need("not_started"),
    inProgress: need("in_progress"),
    blocked: need("blocked"),
    completed: need("completed"),
    medium: need("medium"),
  };
}

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

  // The vocabulary is NOT seeded by this insert — `createTenant` does that
  // through a port, and this test writes the tenant row directly. Migration
  // 0050's backfill only reached the firms that existed when it ran. So the
  // rows are written here, from the same eight the product seeds, which also
  // makes the vocabulary explicit in a file that asserts against its flags.
  for (const t of [a.id, b.id]) {
    await owner`
      INSERT INTO delivery.work_item_state
        (tenant_id, code, name, is_initial, is_terminal, is_blocked, sort_order)
      VALUES
        (${t}, 'not_started', 'Not Started', true,  false, false, 10),
        (${t}, 'in_progress', 'In Progress', false, false, false, 20),
        (${t}, 'blocked',     'Blocked',     false, false, true,  60),
        (${t}, 'completed',   'Completed',   false, true,  false, 70)
      ON CONFLICT (tenant_id, code) DO NOTHING
    `;
    await owner`
      INSERT INTO delivery.work_item_priority
        (tenant_id, code, name, rank, is_default, is_statutory_default)
      VALUES (${t}, 'medium', 'Medium', 3, true, false)
      ON CONFLICT (tenant_id, code) DO NOTHING
    `;
  }

  const [ca] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${a.id}, 'organization', 'Kaveri Foods Group') RETURNING id
  `;
  const [cb] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${b.id}, 'organization', 'Northfield Client') RETURNING id
  `;
  if (!ca || !cb) throw new Error("could not create the two test clients");

  const [u1] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`work-priya-${stamp}@harbour.example`}, 'Priya Nair') RETURNING id
  `;
  const [u2] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`work-anand-${stamp}@harbour.example`}, 'Anand Rao') RETURNING id
  `;
  if (!u1 || !u2) throw new Error("could not create the test accounts");

  ids = {
    tenantA: a.id,
    tenantB: b.id,
    clientA: ca.id,
    clientB: cb.id,
    priya: u1.id,
    anand: u2.id,
  };
  vocabA = await vocabularyOf(a.id);
  vocabB = await vocabularyOf(b.id);
});

afterAll(async () => {
  const t = [ids.tenantA, ids.tenantB];
  await owner`DELETE FROM delivery.work_item_approval WHERE tenant_id IN ${owner(t)}`;
  await owner`DELETE FROM delivery.work_item_dependency WHERE tenant_id IN ${owner(t)}`;
  await owner`DELETE FROM delivery.checklist_item WHERE tenant_id IN ${owner(t)}`;
  await owner`DELETE FROM delivery.work_item WHERE tenant_id IN ${owner(t)}`;
  await owner`DELETE FROM delivery.work_item_state WHERE tenant_id IN ${owner(t)}`;
  await owner`DELETE FROM delivery.work_item_priority WHERE tenant_id IN ${owner(t)}`;
  await owner`DELETE FROM core.party WHERE tenant_id IN ${owner(t)}`;
  await owner`DELETE FROM tenancy.user_account WHERE id IN ${owner([ids.priya, ids.anand])}`;
  await owner`DELETE FROM tenancy.tenant WHERE slug IN ${owner([slugA, slugB])}`;
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

/** The single row a query must have returned. `[row] = await …` is typed as
 *  possibly-undefined, and threading `?.id` back into the NEXT query then makes
 *  the parameter `string | undefined` — which postgres.js will not accept and
 *  which would be a silent `NULL` if it did. */
function one<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`expected a ${what} and got none`);
  return row;
}

interface NewRow {
  clientPartyId?: string;
  stateId?: string;
  priorityId?: string;
  title?: string;
  engagementId?: string | null;
  assigneeUserId?: string | null;
}

/** Insert one work item as the firm, returning its id. */
function raise(tenantId: string, v: Vocab, row: NewRow = {}): Promise<string> {
  const client = row.clientPartyId ?? (tenantId === ids.tenantA ? ids.clientA : ids.clientB);
  return asTenant(tenantId, async (tx) => {
    const [created] = await tx<{ id: string }[]>`
      INSERT INTO delivery.work_item
        (tenant_id, client_party_id, title, state_id, priority_id, assignee_user_id)
      VALUES (${tenantId}, ${client}, ${row.title ?? "GST filing"},
              ${row.stateId ?? v.notStarted}, ${row.priorityId ?? v.medium},
              ${row.assigneeUserId ?? null})
      RETURNING id
    `;
    if (!created) throw new Error("insert returned no row");
    return created.id;
  });
}

describe("the tenant wall", () => {
  it("shows a firm only its own work", async () => {
    await raise(ids.tenantA, vocabA, { title: "Harbour's filing" });
    await raise(ids.tenantB, vocabB, { title: "Northfield's filing" });

    const seenByA = await asTenant(ids.tenantA, async (tx) => {
      return tx<{ title: string }[]>`SELECT title FROM delivery.work_item`;
    });
    expect(seenByA.map((r) => r.title)).toContain("Harbour's filing");
    expect(seenByA.map((r) => r.title)).not.toContain("Northfield's filing");
  });

  it("shows a firm only its own vocabulary", async () => {
    const seenByA = await asTenant(ids.tenantA, async (tx) => {
      return tx<{ id: string }[]>`SELECT id FROM delivery.work_item_state`;
    });
    expect(seenByA.map((r) => r.id)).toContain(vocabA.notStarted);
    expect(seenByA.map((r) => r.id)).not.toContain(vocabB.notStarted);
  });

  it("REFUSES a work item hung off another firm's client", async () => {
    // The failure RLS does NOT catch, and the whole reason for the composite
    // key: the foreign-key check runs as a system operation the row policies do
    // not filter, so an id-only reference would be accepted with every policy
    // satisfied and would leak silently.
    await expect(
      raise(ids.tenantA, vocabA, { clientPartyId: ids.clientB }),
    ).rejects.toThrow(/work_item_client_tenant_fkey|foreign key/i);
  });

  it("REFUSES a work item in another firm's state", async () => {
    // The one that decides whether the vocabulary is really the firm's: without
    // it, firm A's filing could sit in firm B's "Blocked", and renaming that
    // state at B would change what A's board says.
    //
    // WHICH DEFENCE FIRES FIRST WAS A REAL FINDING, and the migration's comment
    // was wrong until this test ran. A BEFORE INSERT trigger runs AHEAD of
    // constraint validation, so `enforce_work_item_state_facts` gets there
    // before the composite foreign key does — its lookup is scoped to
    // `(id, tenant_id)`, finds nothing, and says so in a sentence. Both are
    // real; the trigger is simply the outer one.
    await expect(raise(ids.tenantA, vocabA, { stateId: vocabB.notStarted })).rejects.toThrow(
      /does not belong to firm/i,
    );
  });

  it("still has the COMPOSITE key underneath, for every write a trigger never sees", async () => {
    // The trigger above is the message; this is the wall. Asked of the
    // catalogue rather than provoked, because provoking it means finding a
    // write path that skips the trigger — and there deliberately is not one.
    const keys = await owner<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'delivery.work_item'::regclass AND contype = 'f'
    `;
    expect(keys.map((k) => k.conname)).toEqual(
      expect.arrayContaining([
        "work_item_client_tenant_fkey",
        "work_item_state_tenant_fkey",
        "work_item_priority_tenant_fkey",
        "work_item_job_tenant_fkey",
        "work_item_engagement_tenant_fkey",
      ]),
    );
  });

  it("REFUSES a work item on another firm's priority", async () => {
    await expect(raise(ids.tenantA, vocabA, { priorityId: vocabB.medium })).rejects.toThrow(
      /work_item_priority_tenant_fkey|foreign key/i,
    );
  });
});

describe("the trigger reads the state's FLAGS, never its code", () => {
  it("refuses a blocked state with no reason", async () => {
    // The capture-or-lose pair. It cannot be a CHECK, because a CHECK cannot
    // see `is_blocked` in another table — which is the price of the vocabulary
    // being rows, paid here.
    await expect(raise(ids.tenantA, vocabA, { stateId: vocabA.blocked })).rejects.toThrow(
      /owes a reason/i,
    );
  });

  it("refuses a blocked state whose reason is only whitespace", async () => {
    const id = await raise(ids.tenantA, vocabA);
    await expect(
      asTenant(ids.tenantA, async (tx) => {
        await tx`
          UPDATE delivery.work_item
          SET state_id = ${vocabA.blocked}, blocked_reason = '   ', blocked_at = now()
          WHERE id = ${id}
        `;
      }),
    ).rejects.toThrow(/owes a reason/i);
  });

  it("accepts one WITH a reason, and refuses the reason once it leaves", async () => {
    const id = await raise(ids.tenantA, vocabA);
    await asTenant(ids.tenantA, async (tx) => {
      await tx`
        UPDATE delivery.work_item
        SET state_id = ${vocabA.blocked},
            blocked_reason = 'Client has not sent the bank statements',
            blocked_at = now()
        WHERE id = ${id}
      `;
    });

    // Leaving a block CLEARS the pair. A stale sentence sitting on running work
    // is exactly what makes "are our delays ours or the client's" unanswerable.
    await expect(
      asTenant(ids.tenantA, async (tx) => {
        await tx`UPDATE delivery.work_item SET state_id = ${vocabA.inProgress} WHERE id = ${id}`;
      }),
    ).rejects.toThrow(/cannot carry a block reason/i);

    await asTenant(ids.tenantA, async (tx) => {
      await tx`
        UPDATE delivery.work_item
        SET state_id = ${vocabA.inProgress}, blocked_reason = NULL, blocked_at = NULL
        WHERE id = ${id}
      `;
    });
  });

  it("KEEPS WORKING after the firm renames the state — the whole promise of 0050", async () => {
    // A rule keyed on `code = 'blocked'` would have switched itself off here,
    // silently, and nobody would ever be asked why work was stuck again.
    await owner`
      UPDATE delivery.work_item_state SET name = 'Stuck'
      WHERE id = ${vocabA.blocked}
    `;
    await expect(raise(ids.tenantA, vocabA, { stateId: vocabA.blocked })).rejects.toThrow(
      /Stuck/,
    );
    await owner`
      UPDATE delivery.work_item_state SET name = 'Blocked' WHERE id = ${vocabA.blocked}
    `;
  });

  it("demands a completion time on a terminal state, and refuses one anywhere else", async () => {
    await expect(raise(ids.tenantA, vocabA, { stateId: vocabA.completed })).rejects.toThrow(
      /finish time/i,
    );

    const id = await raise(ids.tenantA, vocabA);
    await asTenant(ids.tenantA, async (tx) => {
      await tx`
        UPDATE delivery.work_item SET state_id = ${vocabA.completed}, completed_at = now()
        WHERE id = ${id}
      `;
    });

    // And CLEARS it on the way back. Reopened work is not finished work.
    await expect(
      asTenant(ids.tenantA, async (tx) => {
        await tx`UPDATE delivery.work_item SET state_id = ${vocabA.inProgress} WHERE id = ${id}`;
      }),
    ).rejects.toThrow(/cannot carry a completion time/i);
  });
});

describe("what the firm may and may not do to its own vocabulary", () => {
  it("allows AT MOST ONE starting state", async () => {
    await expect(
      owner`
        UPDATE delivery.work_item_state SET is_initial = true WHERE id = ${vocabA.inProgress}
      `,
    ).rejects.toThrow(/idx_work_item_state_one_initial|duplicate key/i);
  });

  it("refuses a state that is both terminal and blocked", async () => {
    await expect(
      owner`
        UPDATE delivery.work_item_state SET is_blocked = true WHERE id = ${vocabA.completed}
      `,
    ).rejects.toThrow(/terminal_is_not_blocked|violates check/i);
  });

  it("refuses retiring the starting state at the DATABASE, not only in the service", async () => {
    await expect(
      owner`
        UPDATE delivery.work_item_state SET is_active = false WHERE id = ${vocabA.notStarted}
      `,
    ).rejects.toThrow(/initial_is_active|violates check/i);
  });
});

describe("the assignment note", () => {
  it("may sit on an unassigned row and not on an assigned one", async () => {
    // The difference between "not got to yet" and "the router found two SPOCs
    // and would not guess" — and a stale sentence beside a name would be worse
    // than no sentence at all.
    const id = await raise(ids.tenantA, vocabA);
    await asTenant(ids.tenantA, async (tx) => {
      await tx`
        UPDATE delivery.work_item SET assignment_note = 'FRC has 2 SPOCs' WHERE id = ${id}
      `;
    });
    await expect(
      asTenant(ids.tenantA, async (tx) => {
        await tx`
          UPDATE delivery.work_item SET assignee_user_id = ${ids.priya} WHERE id = ${id}
        `;
      }),
    ).rejects.toThrow(/note_only_when_unassigned|violates check/i);
  });
});

describe("idempotency, structurally", () => {
  it("allows ONE work item per engagement, and any number with none", async () => {
    // The spawn path is at-least-once — a redelivered message, a restarted
    // worker — and a second work item is a second task on somebody's desk for
    // work already being done.
    const [engagement] = await owner<{ id: string }[]>`
      SELECT gen_random_uuid() AS id
    `;
    if (!engagement) throw new Error("no uuid");

    // A real engagement is needed for the FK, so this proves the index against
    // a pair of rows that share a NULL engagement instead — which is the other
    // half of the rule and the half a naive UNIQUE would break.
    await raise(ids.tenantA, vocabA, { title: "ad hoc one" });
    await raise(ids.tenantA, vocabA, { title: "ad hoc two" });
    const adHoc = await asTenant(ids.tenantA, async (tx) => {
      return tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM delivery.work_item WHERE engagement_id IS NULL
      `;
    });
    expect(Number(adHoc[0]?.n)).toBeGreaterThanOrEqual(2);

    // And the index itself, asked of the catalogue: a partial unique index on
    // (tenant_id, engagement_id). Asserting on the definition rather than
    // provoking it, because provoking it needs a whole signed letter — and the
    // property worth protecting is that the index EXISTS and is partial, which
    // is exactly what a later "tidy-up" would get wrong.
    const [idx] = await owner<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'delivery' AND indexname = 'idx_work_item_one_per_engagement'
    `;
    expect(idx?.indexdef).toMatch(/UNIQUE/);
    expect(idx?.indexdef).toMatch(/tenant_id, engagement_id/);
    expect(idx?.indexdef).toMatch(/WHERE \(engagement_id IS NOT NULL\)/);
  });

  it("allows ONE open review per work item", async () => {
    const id = await raise(ids.tenantA, vocabA, { assigneeUserId: ids.priya });
    await asTenant(ids.tenantA, async (tx) => {
      await tx`
        INSERT INTO delivery.work_item_approval (tenant_id, work_item_id)
        VALUES (${ids.tenantA}, ${id})
      `;
    });
    await expect(
      asTenant(ids.tenantA, async (tx) => {
        await tx`
          INSERT INTO delivery.work_item_approval (tenant_id, work_item_id)
          VALUES (${ids.tenantA}, ${id})
        `;
      }),
    ).rejects.toThrow(/idx_work_item_approval_one_open|duplicate key/i);
  });
});

describe("maker != checker, and the derivation that makes it worth anything", () => {
  it("DERIVES the maker from the item's assignee — the writer cannot supply one", async () => {
    const id = await raise(ids.tenantA, vocabA, { assigneeUserId: ids.priya });
    const [row] = await asTenant(ids.tenantA, async (tx) => {
      return tx<{ submitted_by: string | null }[]>`
        INSERT INTO delivery.work_item_approval (tenant_id, work_item_id)
        VALUES (${ids.tenantA}, ${id})
        RETURNING submitted_by
      `;
    });
    expect(row?.submitted_by).toBe(ids.priya);
  });

  it("OVERWRITES a maker the writer tries to supply", async () => {
    // The attack the trigger exists for: name somebody else as the maker and
    // approve it yourself. The BEFORE INSERT trigger reads the assignee and
    // discards whatever was sent.
    const id = await raise(ids.tenantA, vocabA, { assigneeUserId: ids.priya });
    const [row] = await asTenant(ids.tenantA, async (tx) => {
      return tx<{ submitted_by: string | null }[]>`
        INSERT INTO delivery.work_item_approval (tenant_id, work_item_id, submitted_by)
        VALUES (${ids.tenantA}, ${id}, ${ids.anand})
        RETURNING submitted_by
      `;
    });
    expect(row?.submitted_by).toBe(ids.priya);
  });

  it("FREEZES it — a rule whose left-hand side can be edited is not a rule", async () => {
    const id = await raise(ids.tenantA, vocabA, { assigneeUserId: ids.priya });
    const approval = one(
      await asTenant(ids.tenantA, async (tx) => {
        return tx<{ id: string }[]>`
          INSERT INTO delivery.work_item_approval (tenant_id, work_item_id)
          VALUES (${ids.tenantA}, ${id}) RETURNING id
        `;
      }),
      "review",
    );
    await expect(
      asTenant(ids.tenantA, async (tx) => {
        await tx`
          UPDATE delivery.work_item_approval SET submitted_by = ${ids.anand}
          WHERE id = ${approval.id}
        `;
      }),
    ).rejects.toThrow(/cannot change who made the work/i);
  });

  it("refuses the maker as the checker — as the OWNER role, not only through the app", async () => {
    // The point of proving it here: a rule that lives in a service is one a
    // script, an import or an AI agent walks straight past. This runs as
    // `bib_owner`, which has every privilege the application does not.
    const id = await raise(ids.tenantA, vocabA, { assigneeUserId: ids.priya });
    const approval = one(
      await owner<{ id: string }[]>`
        INSERT INTO delivery.work_item_approval (tenant_id, work_item_id)
        VALUES (${ids.tenantA}, ${id}) RETURNING id
      `,
      "review",
    );
    await expect(
      owner`
        UPDATE delivery.work_item_approval
        SET decision = 'approved', decided_by = ${ids.priya}, decided_at = now()
        WHERE id = ${approval.id}
      `,
    ).rejects.toThrow(/maker_is_not_checker|violates check/i);
  });

  it("refuses a rejection with no note", async () => {
    const id = await raise(ids.tenantA, vocabA, { assigneeUserId: ids.priya });
    const approval = one(
      await owner<{ id: string }[]>`
        INSERT INTO delivery.work_item_approval (tenant_id, work_item_id)
        VALUES (${ids.tenantA}, ${id}) RETURNING id
      `,
      "review",
    );
    await expect(
      owner`
        UPDATE delivery.work_item_approval
        SET decision = 'rejected', decided_by = ${ids.anand}, decided_at = now()
        WHERE id = ${approval.id}
      `,
    ).rejects.toThrow(/rejection_says_why|violates check/i);
  });
});

describe("what may be removed, and what may not", () => {
  it("refuses to DELETE a work item at all — bib_app holds no grant", async () => {
    // A work item is the record that work was owed; cancelling is a state.
    const id = await raise(ids.tenantA, vocabA);
    await expect(
      asTenant(ids.tenantA, async (tx) => {
        await tx`DELETE FROM delivery.work_item WHERE id = ${id}`;
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("allows removing an UNTICKED checklist line and refuses a ticked one", async () => {
    // The one place in this schema a firm may remove its own row, because a
    // firm that cannot fix a mistyped checklist will keep the checklist in
    // Excel. A TICK is a record that somebody did something, and it lives
    // nowhere else.
    const id = await raise(ids.tenantA, vocabA);
    const line = one(
      await asTenant(ids.tenantA, async (tx) => {
        return tx<{ id: string }[]>`
          INSERT INTO delivery.checklist_item (tenant_id, work_item_id, label)
          VALUES (${ids.tenantA}, ${id}, 'Reconcile') RETURNING id
        `;
      }),
      "checklist line",
    );

    await asTenant(ids.tenantA, async (tx) => {
      await tx`
        UPDATE delivery.checklist_item
        SET done_at = now(), done_by_user_id = ${ids.priya}
        WHERE id = ${line.id}
      `;
    });
    await expect(
      asTenant(ids.tenantA, async (tx) => {
        await tx`DELETE FROM delivery.checklist_item WHERE id = ${line.id}`;
      }),
    ).rejects.toThrow(/is ticked and cannot be deleted/i);

    await asTenant(ids.tenantA, async (tx) => {
      await tx`
        UPDATE delivery.checklist_item SET done_at = NULL, done_by_user_id = NULL
        WHERE id = ${line.id}
      `;
      await tx`DELETE FROM delivery.checklist_item WHERE id = ${line.id}`;
    });
  });

  it("refuses a tick with nobody behind it", async () => {
    const id = await raise(ids.tenantA, vocabA);
    await expect(
      asTenant(ids.tenantA, async (tx) => {
        await tx`
          INSERT INTO delivery.checklist_item (tenant_id, work_item_id, label, done_at)
          VALUES (${ids.tenantA}, ${id}, 'Reconcile', now())
        `;
      }),
    ).rejects.toThrow(/tick_names_somebody|violates check/i);
  });

  it("refuses a work item that waits on itself", async () => {
    const id = await raise(ids.tenantA, vocabA);
    await expect(
      asTenant(ids.tenantA, async (tx) => {
        await tx`
          INSERT INTO delivery.work_item_dependency
            (tenant_id, work_item_id, depends_on_work_item_id)
          VALUES (${ids.tenantA}, ${id}, ${id})
        `;
      }),
    ).rejects.toThrow(/not_itself|violates check/i);
  });

  it("refuses a dependency on another firm's work item", async () => {
    const mine = await raise(ids.tenantA, vocabA);
    const theirs = await raise(ids.tenantB, vocabB);
    await expect(
      asTenant(ids.tenantA, async (tx) => {
        await tx`
          INSERT INTO delivery.work_item_dependency
            (tenant_id, work_item_id, depends_on_work_item_id)
          VALUES (${ids.tenantA}, ${mine}, ${theirs})
        `;
      }),
    ).rejects.toThrow(/blocker_tenant_fkey|foreign key/i);
  });
});
