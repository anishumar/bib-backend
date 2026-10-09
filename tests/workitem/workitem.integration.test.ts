// Work items (T3.1), proven in the database, where scripts, imports and psql must obey too:
//   1. RLS isolates a firm's work, vocabulary and reviews.
//   2. COMPOSITE FKs refuse a cross-tenant client, state and priority (an FK check bypasses RLS).
//   3. The trigger reads the state's FLAGS, not its code, so a rename keeps it working (0050).
//   4. `submitted_by` is DERIVED and FROZEN, or maker != checker is no control.
//   5. ONE work item per engagement and ONE open review per item: partial unique indexes,
//      because every trigger into this table is at-least-once.
//   6. A TICKED checklist line cannot be deleted; `work_item` cannot be deleted at all.
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { PostgresClientAssignmentRepository } from "../../src/infrastructure/postgres/client-assignment-repository";

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

/** The firm's own vocabulary, resolved once per firm (the rows 0050 seeds). */
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
  // Two firms: with one, an RLS bug looks exactly like a working system.
  const [a] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${slugA}, 'Harbour Point', 'INR') RETURNING id
  `;
  const [b] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.tenant (slug, name, reporting_currency)
    VALUES (${slugB}, 'Northfield Advisory', 'INR') RETURNING id
  `;
  if (!a || !b) throw new Error("could not create the two test firms");

  // A raw tenant row gets no vocabulary (`createTenant` seeds it through a port, and 0050's
  // backfill reached only firms that existed then), so the rows are written here.
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
  await owner`DELETE FROM crm.client_assignment WHERE tenant_id IN ${owner(t)}`;
  await owner`DELETE FROM tenancy.service_axis WHERE tenant_id IN ${owner(t)}`;
  await owner`DELETE FROM delivery.work_item_state WHERE tenant_id IN ${owner(t)}`;
  await owner`DELETE FROM delivery.work_item_priority WHERE tenant_id IN ${owner(t)}`;
  await owner`DELETE FROM core.party WHERE tenant_id IN ${owner(t)}`;
  await owner`DELETE FROM tenancy.membership WHERE tenant_id IN ${owner(t)}`;
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

/** The single row a query must have returned; a `?.id` threaded into the next query would be
 *  `string | undefined`, a silent `NULL` if postgres.js accepted it. */
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
    // What RLS does NOT catch: the FK check bypasses row policies, so an id-only key would leak.
    await expect(
      raise(ids.tenantA, vocabA, { clientPartyId: ids.clientB }),
    ).rejects.toThrow(/work_item_client_tenant_fkey|foreign key/i);
  });

  it("REFUSES a work item in another firm's state", async () => {
    // Else firm A's filing could sit in firm B's "Blocked". A BEFORE INSERT trigger runs ahead
    // of constraint validation, so `enforce_work_item_state_facts` (lookup scoped to
    // `(id, tenant_id)`) refuses before the composite FK does.
    await expect(raise(ids.tenantA, vocabA, { stateId: vocabB.notStarted })).rejects.toThrow(
      /does not belong to firm/i,
    );
  });

  it("still has the COMPOSITE key underneath, for every write a trigger never sees", async () => {
    // The trigger is the message; this is the wall. Asked of the catalogue: no write path
    // skips the trigger to provoke it.
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
    // A trigger, not a CHECK: a CHECK cannot see `is_blocked` in another table.
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

    // Leaving a block must CLEAR the pair, or "whose delay is it" becomes unanswerable.
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
    // A rule keyed on `code = 'blocked'` would silently switch off here.
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

    // Reopened work must clear it.
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
  it("may sit on an unassigned row, and since 0311 beside a name too", async () => {
    // The owner rule (2026-09-27) routes work with no SPOC to the Key Manager or signing
    // partner, and the note says it is theirs to hand out; 0311 dropped 0051's CHECK so the
    // router can write both. A hand move clears it (`setAssignee` writes NULL).
    const id = await raise(ids.tenantA, vocabA);
    await asTenant(ids.tenantA, async (tx) => {
      await tx`
        UPDATE delivery.work_item SET assignment_note = 'No SPOC for FRC' WHERE id = ${id}
      `;
    });
    await asTenant(ids.tenantA, async (tx) => {
      await tx`
        UPDATE delivery.work_item SET assignee_user_id = ${ids.priya} WHERE id = ${id}
      `;
    });
    const [row] = await owner<{ assignee_user_id: string | null; assignment_note: string | null }[]>`
      SELECT assignee_user_id, assignment_note FROM delivery.work_item WHERE id = ${id}
    `;
    expect(row).toEqual({ assignee_user_id: ids.priya, assignment_note: "No SPOC for FRC" });
  });
});

describe("idempotency, structurally", () => {
  it("allows ONE work item per engagement, and any number with none", async () => {
    // The spawn path is at-least-once; a duplicate would be a second task for the same work.
    const [engagement] = await owner<{ id: string }[]>`
      SELECT gen_random_uuid() AS id
    `;
    if (!engagement) throw new Error("no uuid");

    // The FK needs a real engagement, so prove the other half: rows sharing a NULL engagement.
    await raise(ids.tenantA, vocabA, { title: "ad hoc one" });
    await raise(ids.tenantA, vocabA, { title: "ad hoc two" });
    const adHoc = await asTenant(ids.tenantA, async (tx) => {
      return tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM delivery.work_item WHERE engagement_id IS NULL
      `;
    });
    expect(Number(adHoc[0]?.n)).toBeGreaterThanOrEqual(2);

    // The index from the catalogue (provoking it needs a signed letter): partial unique on
    // (tenant_id, engagement_id, job_id), per JOB since 0300 (a monthly engagement has one job
    // and umbrella task per month), NULLS NOT DISTINCT so a null job is no wildcard.
    const [idx] = await owner<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'delivery' AND indexname = 'idx_work_item_one_per_engagement'
    `;
    expect(idx?.indexdef).toMatch(/UNIQUE/);
    expect(idx?.indexdef).toMatch(/tenant_id, engagement_id, job_id/);
    expect(idx?.indexdef).toMatch(/NULLS NOT DISTINCT/);
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
    // The attack: name someone else as maker, then approve it yourself. The BEFORE INSERT
    // trigger reads the assignee and discards what was sent.
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
    // As `bib_owner`: a service rule is one a script, import or AI agent walks past.
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
    // The one row a firm may delete, so a mistyped checklist can be fixed; a TICK is a record.
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

describe("two SPOCs on one Dept take turns (2026-09-25)", () => {
  // Proves `SpocDirectory.spocsFor`'s `routed` count (this client's tasks per desk) on the real
  // table; unit tests prove the rule over it.
  it("counts what each desk already holds for the client, longest-standing first", async () => {
    const [dept] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.service_axis (tenant_id, axis, code, name)
      VALUES (${ids.tenantA}, 'dept', 'FRC', 'Financial Reporting') RETURNING id
    `;
    if (!dept) throw new Error("no dept");
    await asTenant(ids.tenantA, async (tx) => {
      await tx`
        INSERT INTO crm.client_assignment
          (tenant_id, client_party_id, role, axis_id, user_id, valid_from)
        VALUES (${ids.tenantA}, ${ids.clientA}, 'spoc', ${dept.id}, ${ids.priya}, '2026-01-01'),
               (${ids.tenantA}, ${ids.clientA}, 'spoc', ${dept.id}, ${ids.anand}, '2026-03-01')
      `;
    });
    // Active staff: since 2026-09-27 the SPOC read skips anyone who is not.
    await owner`
      INSERT INTO tenancy.membership (tenant_id, user_id, audience, role)
      VALUES (${ids.tenantA}, ${ids.priya}, 'STAFF', 'associate'),
             (${ids.tenantA}, ${ids.anand}, 'STAFF', 'associate')
    `;
    const directory = new PostgresClientAssignmentRepository(app);
    // Earlier cases put tasks on Priya's desk, so assert the DELTA.
    const before = await directory.spocsFor(ids.tenantA, ids.clientA, dept.id, "2026-09-25");
    const was = new Map(before.map((s) => [s.userId, s.routed]));

    // Two of this client's on Priya; one of ANOTHER client's on Anand, which must not count.
    await raise(ids.tenantA, vocabA, { assigneeUserId: ids.priya });
    await raise(ids.tenantA, vocabA, { assigneeUserId: ids.priya });
    await raise(ids.tenantB, vocabB, { assigneeUserId: ids.anand });

    const spocs = await directory.spocsFor(ids.tenantA, ids.clientA, dept.id, "2026-09-25");
    expect(spocs.map((s) => s.userId)).toEqual([ids.priya, ids.anand]);
    expect(spocs[0]?.routed).toBe((was.get(ids.priya) ?? 0) + 2);
    expect(spocs[1]?.routed).toBe(was.get(ids.anand) ?? 0);
  });
});
