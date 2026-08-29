// Client ownership, proven where the claims actually have to hold: the database
// (G3.2).
//
// Four properties, and not one of them can be tested with a fake — a fake
// agrees with the service by construction, and every rule below is one a
// script, an import or a psql session has to obey as well:
//
//   1. RLS isolates a firm's assignments.
//   2. The COMPOSITE foreign keys refuse a cross-tenant client and a
//      cross-tenant Dept. This is the failure RLS does not catch and the reason
//      CLAUDE.md insists on `(id, tenant_id)`: a foreign-key check runs as a
//      system operation the row policies do not filter.
//   3. The EXCLUSION constraints compare ranges as ranges. A partial unique
//      index over open rows would let two CLOSED key-manager rows overlap in
//      March, and then "who was the Key Manager in March" answers with two
//      names — the acceptance criterion, failed, by a constraint that looked
//      like it covered this.
//   4. And the one that is NOT constrained, deliberately: a Dept may have two
//      SPOCs at once. That is a decision (Shrestha, 2026-08-30) and it is
//      tested so a later "tidy-up" cannot quietly add the constraint back.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });

const stamp = Date.now().toString(36);
const slugA = `assign-test-a-${stamp}`;
const slugB = `assign-test-b-${stamp}`;

interface Ids {
  tenantA: string;
  tenantB: string;
  clientA: string;
  clientB: string;
  deptA: string;
  deptB: string;
  anita: string;
  bhavna: string;
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

  const [ca] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${a.id}, 'organization', 'Acme Holdings') RETURNING id
  `;
  const [cb] = await owner<{ id: string }[]>`
    INSERT INTO core.party (tenant_id, kind, display_name)
    VALUES (${b.id}, 'organization', 'Northfield Client') RETURNING id
  `;
  if (!ca || !cb) throw new Error("could not create the two test clients");

  const [da] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.service_axis (tenant_id, axis, code, name)
    VALUES (${a.id}, 'dept', 'FRC', 'FRC') RETURNING id
  `;
  const [db] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.service_axis (tenant_id, axis, code, name)
    VALUES (${b.id}, 'dept', 'FRC', 'FRC') RETURNING id
  `;
  if (!da || !db) throw new Error("could not create the two test Depts");

  const [u1] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`assign-anita-${stamp}@harbour.example`}, 'Anita Rao') RETURNING id
  `;
  const [u2] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`assign-bhavna-${stamp}@harbour.example`}, 'Bhavna Shah') RETURNING id
  `;
  if (!u1 || !u2) throw new Error("could not create the test accounts");

  ids = {
    tenantA: a.id,
    tenantB: b.id,
    clientA: ca.id,
    clientB: cb.id,
    deptA: da.id,
    deptB: db.id,
    anita: u1.id,
    bhavna: u2.id,
  };
});

afterAll(async () => {
  await owner`DELETE FROM crm.client_assignment WHERE tenant_id IN (${ids.tenantA}, ${ids.tenantB})`;
  await owner`DELETE FROM tenancy.service_axis WHERE tenant_id IN (${ids.tenantA}, ${ids.tenantB})`;
  await owner`DELETE FROM core.party WHERE tenant_id IN (${ids.tenantA}, ${ids.tenantB})`;
  await owner`DELETE FROM tenancy.user_account WHERE id IN (${ids.anita}, ${ids.bhavna})`;
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

/** Insert one assignment as the firm, returning its id. */
function assign(
  tenantId: string,
  row: {
    clientPartyId: string;
    role: "key_manager" | "spoc";
    axisId: string | null;
    userId: string;
    validFrom: string;
    validTo?: string | null;
  },
): Promise<string> {
  return asTenant(tenantId, async (tx) => {
    const [created] = await tx<{ id: string }[]>`
      INSERT INTO crm.client_assignment
        (tenant_id, client_party_id, role, axis_id, user_id, valid_from, valid_to)
      VALUES (${tenantId}, ${row.clientPartyId}, ${row.role}, ${row.axisId}, ${row.userId},
              ${row.validFrom}::date, ${row.validTo ?? null}::date)
      RETURNING id
    `;
    if (!created) throw new Error("insert returned no row");
    return created.id;
  });
}

/** Everything already recorded for a client, cleared between the cases that
 *  need an empty slate. Owner role, because the point is the next INSERT and
 *  not this DELETE — and `bib_app` holds no DELETE grant anyway, which is
 *  itself the product rule. */
async function clear(): Promise<void> {
  await owner`DELETE FROM crm.client_assignment WHERE tenant_id IN (${ids.tenantA}, ${ids.tenantB})`;
}

describe("the tenant wall around an account team", () => {
  it("shows a firm only its own assignments", async () => {
    await clear();
    await assign(ids.tenantA, {
      clientPartyId: ids.clientA,
      role: "key_manager",
      axisId: null,
      userId: ids.anita,
      validFrom: "2026-01-01",
    });
    await assign(ids.tenantB, {
      clientPartyId: ids.clientB,
      role: "key_manager",
      axisId: null,
      userId: ids.bhavna,
      validFrom: "2026-01-01",
    });

    const rows = await asTenant(ids.tenantA, (tx) =>
      tx<{ client_party_id: string }[]>`SELECT client_party_id FROM crm.client_assignment`,
    );
    expect(rows.map((r) => r.client_party_id)).toEqual([ids.clientA]);
  });

  it("refuses to write an assignment into another firm", async () => {
    await expect(
      asTenant(ids.tenantA, (tx) =>
        tx`
          INSERT INTO crm.client_assignment
            (tenant_id, client_party_id, role, axis_id, user_id, valid_from)
          VALUES (${ids.tenantB}, ${ids.clientB}, 'key_manager', NULL, ${ids.anita},
                  '2026-01-01'::date)
        `,
      ),
    ).rejects.toMatchObject({ code: "42501" }); // insufficient_privilege (WITH CHECK)
  });
});

describe("the composite keys — the failure RLS does not catch", () => {
  // Every row policy is satisfied in both of these: the row really is firm A's,
  // so WITH CHECK passes, and the foreign-key check runs as a system operation
  // RLS does not filter. Only `(fk, tenant_id)` referencing `(id, tenant_id)`
  // refuses them.

  it("refuses an assignment against another firm's client", async () => {
    await expect(
      asTenant(ids.tenantA, (tx) =>
        tx`
          INSERT INTO crm.client_assignment
            (tenant_id, client_party_id, role, axis_id, user_id, valid_from)
          VALUES (${ids.tenantA}, ${ids.clientB}, 'key_manager', NULL, ${ids.anita},
                  '2026-01-01'::date)
        `,
      ),
    ).rejects.toMatchObject({ code: "23503" }); // foreign_key_violation
  });

  it("refuses a SPOC on another firm's Dept", async () => {
    // The subtler of the two: one firm's client, one firm's person, and
    // another firm's Dept. Without the composite key this row would exist,
    // leak nothing, and quietly file a client's contact under a department
    // that firm never had.
    await expect(
      asTenant(ids.tenantA, (tx) =>
        tx`
          INSERT INTO crm.client_assignment
            (tenant_id, client_party_id, role, axis_id, user_id, valid_from)
          VALUES (${ids.tenantA}, ${ids.clientA}, 'spoc', ${ids.deptB}, ${ids.anita},
                  '2026-01-01'::date)
        `,
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});

describe("one Key Manager at a time — and history stays unambiguous", () => {
  it("accepts a contiguous handover: closed on the day the next one opens", async () => {
    await clear();
    const first = await assign(ids.tenantA, {
      clientPartyId: ids.clientA,
      role: "key_manager",
      axisId: null,
      userId: ids.anita,
      validFrom: "2026-01-01",
      validTo: "2026-04-01",
    });
    const second = await assign(ids.tenantA, {
      clientPartyId: ids.clientA,
      role: "key_manager",
      axisId: null,
      userId: ids.bhavna,
      validFrom: "2026-04-01",
    });
    expect(first).not.toBe(second);

    // Half-open in the database as well as in the domain: exactly one person on
    // the changeover day.
    const [row] = await asTenant(ids.tenantA, (tx) =>
      tx<{ user_id: string }[]>`
        SELECT user_id FROM crm.client_assignment
        WHERE client_party_id = ${ids.clientA} AND role = 'key_manager'
          AND valid_from <= '2026-04-01'::date
          AND (valid_to IS NULL OR valid_to > '2026-04-01'::date)
      `,
    );
    expect(row?.user_id).toBe(ids.bhavna);
  });

  it("refuses two OPEN key managers", async () => {
    await clear();
    await assign(ids.tenantA, {
      clientPartyId: ids.clientA,
      role: "key_manager",
      axisId: null,
      userId: ids.anita,
      validFrom: "2026-01-01",
    });
    await expect(
      assign(ids.tenantA, {
        clientPartyId: ids.clientA,
        role: "key_manager",
        axisId: null,
        userId: ids.bhavna,
        validFrom: "2026-04-01",
      }),
    ).rejects.toMatchObject({ code: "23P01" }); // exclusion_violation
  });

  // THE test for the exclusion constraint, and the one a partial unique index
  // over open rows would have gone green on while the history stayed ambiguous.
  it("refuses two CLOSED key managers that overlap in March", async () => {
    await clear();
    await assign(ids.tenantA, {
      clientPartyId: ids.clientA,
      role: "key_manager",
      axisId: null,
      userId: ids.anita,
      validFrom: "2026-01-01",
      validTo: "2026-06-01",
    });
    await expect(
      assign(ids.tenantA, {
        clientPartyId: ids.clientA,
        role: "key_manager",
        axisId: null,
        userId: ids.bhavna,
        validFrom: "2026-03-01",
        validTo: "2026-05-01",
      }),
    ).rejects.toMatchObject({ code: "23P01" });
  });

  it("accepts two key managers whose periods only touch", async () => {
    await clear();
    await assign(ids.tenantA, {
      clientPartyId: ids.clientA,
      role: "key_manager",
      axisId: null,
      userId: ids.anita,
      validFrom: "2026-01-01",
      validTo: "2026-04-01",
    });
    // 2026-04-01 is the first day NOT in force above, so this is the first day
    // in force here. Adjacent, not overlapping — which an INCLUSIVE upper bound
    // would have called a clash.
    await expect(
      assign(ids.tenantA, {
        clientPartyId: ids.clientA,
        role: "key_manager",
        axisId: null,
        userId: ids.bhavna,
        validFrom: "2026-04-01",
        validTo: "2026-07-01",
      }),
    ).resolves.toBeTypeOf("string");
  });

  it("lets two firms each have their own Key Manager for their own client", async () => {
    await clear();
    await assign(ids.tenantA, {
      clientPartyId: ids.clientA,
      role: "key_manager",
      axisId: null,
      userId: ids.anita,
      validFrom: "2026-01-01",
    });
    await expect(
      assign(ids.tenantB, {
        clientPartyId: ids.clientB,
        role: "key_manager",
        axisId: null,
        userId: ids.bhavna,
        validFrom: "2026-01-01",
      }),
    ).resolves.toBeTypeOf("string");
  });
});

describe("a Dept MAY have more than one SPOC — the constraint that is deliberately absent", () => {
  it("accepts two different people as SPOC for the same Dept at the same time", async () => {
    // Shrestha's instruction, 2026-08-30, against the board's own acceptance
    // line. Leave cover, a joint SPOC on a group, a fortnight's parallel
    // handover — all real, and a "one per Dept" constraint makes every one of
    // them unrecordable. This test exists so a later tidy-up cannot add it back
    // without somebody deciding to.
    await clear();
    await assign(ids.tenantA, {
      clientPartyId: ids.clientA,
      role: "spoc",
      axisId: ids.deptA,
      userId: ids.anita,
      validFrom: "2026-01-01",
    });
    await expect(
      assign(ids.tenantA, {
        clientPartyId: ids.clientA,
        role: "spoc",
        axisId: ids.deptA,
        userId: ids.bhavna,
        validFrom: "2026-01-01",
      }),
    ).resolves.toBeTypeOf("string");
  });

  it("still refuses the SAME person twice on one Dept — a duplicate, not a second SPOC", async () => {
    await clear();
    await assign(ids.tenantA, {
      clientPartyId: ids.clientA,
      role: "spoc",
      axisId: ids.deptA,
      userId: ids.anita,
      validFrom: "2026-01-01",
    });
    await expect(
      assign(ids.tenantA, {
        clientPartyId: ids.clientA,
        role: "spoc",
        axisId: ids.deptA,
        userId: ids.anita,
        validFrom: "2026-03-01",
      }),
    ).rejects.toMatchObject({ code: "23P01" });
  });

  it("lets the same person be SPOC again after their first spell ended", async () => {
    await clear();
    await assign(ids.tenantA, {
      clientPartyId: ids.clientA,
      role: "spoc",
      axisId: ids.deptA,
      userId: ids.anita,
      validFrom: "2026-01-01",
      validTo: "2026-04-01",
    });
    await expect(
      assign(ids.tenantA, {
        clientPartyId: ids.clientA,
        role: "spoc",
        axisId: ids.deptA,
        userId: ids.anita,
        validFrom: "2026-09-01",
      }),
    ).resolves.toBeTypeOf("string");
  });
});

describe("the shape rules hold against the OWNER role too", () => {
  // The role migrations and backfills run as. A rule enforced only in the
  // service is bypassed by the next script somebody writes.

  it("refuses a SPOC with no Dept — it would be a second key manager under another name", async () => {
    await expect(
      owner`
        INSERT INTO crm.client_assignment
          (tenant_id, client_party_id, role, axis_id, user_id, valid_from)
        VALUES (${ids.tenantA}, ${ids.clientA}, 'spoc', NULL, ${ids.anita}, '2026-01-01'::date)
      `,
    ).rejects.toMatchObject({ code: "23514" }); // check_violation
  });

  it("refuses a Key Manager carrying a Dept", async () => {
    await expect(
      owner`
        INSERT INTO crm.client_assignment
          (tenant_id, client_party_id, role, axis_id, user_id, valid_from)
        VALUES (${ids.tenantA}, ${ids.clientA}, 'key_manager', ${ids.deptA}, ${ids.anita},
                '2026-01-01'::date)
      `,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses a role the product does not have", async () => {
    await expect(
      owner`
        INSERT INTO crm.client_assignment
          (tenant_id, client_party_id, role, axis_id, user_id, valid_from)
        VALUES (${ids.tenantA}, ${ids.clientA}, 'account_manager', NULL, ${ids.anita},
                '2026-01-01'::date)
      `,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses a period that is in force on no day at all", async () => {
    await expect(
      owner`
        INSERT INTO crm.client_assignment
          (tenant_id, client_party_id, role, axis_id, user_id, valid_from, valid_to)
        VALUES (${ids.tenantA}, ${ids.clientA}, 'key_manager', NULL, ${ids.anita},
                '2026-01-01'::date, '2026-01-01'::date)
      `,
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("nothing is ever deleted", () => {
  it("gives the app role no DELETE on the table", async () => {
    // The product rule, enforced as a missing GRANT rather than remembered: an
    // assignment is ENDED, never removed, because the row is what says who held
    // the client before.
    const [row] = await owner<{ can: boolean }[]>`
      SELECT has_table_privilege('bib_app', 'crm.client_assignment', 'DELETE') AS can
    `;
    expect(row?.can).toBe(false);
  });
});
