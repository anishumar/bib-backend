// The seniority ladder, proven where the claims actually have to hold: the
// database (G3.3).
//
// Three properties, and none of them can be tested with a fake, because a fake
// is exactly the thing that agrees with the service by construction:
//
//   1. RLS isolates a firm's ladder. A fake filters by tenantId because it was
//      written to; Postgres has to be told, and this proves it was.
//   2. The COMPOSITE foreign key refuses a cross-tenant assignment. This is the
//      failure RLS does not catch and the reason CLAUDE.md insists on
//      `(id, tenant_id)`: a foreign-key check runs as a system operation the row
//      policies do not filter, so an id-only reference would let one firm's
//      membership hang off another firm's rung — with every policy satisfied.
//   3. `rank > 0` and the per-firm unique code hold against the OWNER role too,
//      which is what a migration or a psql session runs as. A rule that lives
//      only in the service is bypassed by the next backfill somebody writes.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });
const app = postgres(cfg.db.appUrl, { max: 2 });

const stamp = Date.now().toString(36);
const slugA = `grade-test-a-${stamp}`;
const slugB = `grade-test-b-${stamp}`;

interface Ids {
  tenantA: string;
  tenantB: string;
  gradeA: string;
  gradeB: string;
  membershipA: string;
  userId: string;
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

  const [ga] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.staff_grade (tenant_id, code, name, rank)
    VALUES (${a.id}, 'manager', 'Manager', 7) RETURNING id
  `;
  const [gb] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.staff_grade (tenant_id, code, name, rank)
    VALUES (${b.id}, 'manager', 'Manager', 7) RETURNING id
  `;
  if (!ga || !gb) throw new Error("could not create the two test ladders");

  const [u] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.user_account (email, display_name)
    VALUES (${`grade-test-${stamp}@harbour.example`}, 'Anita Rao') RETURNING id
  `;
  if (!u) throw new Error("could not create the test account");

  const [m] = await owner<{ id: string }[]>`
    INSERT INTO tenancy.membership (tenant_id, user_id, audience, role)
    VALUES (${a.id}, ${u.id}, 'STAFF', 'partner') RETURNING id
  `;
  if (!m) throw new Error("could not create the test membership");

  ids = {
    tenantA: a.id,
    tenantB: b.id,
    gradeA: ga.id,
    gradeB: gb.id,
    membershipA: m.id,
    userId: u.id,
  };
});

afterAll(async () => {
  // Newest-first, because the membership references the grade.
  await owner`DELETE FROM tenancy.membership WHERE tenant_id IN (${ids.tenantA}, ${ids.tenantB})`;
  await owner`DELETE FROM tenancy.staff_grade WHERE tenant_id IN (${ids.tenantA}, ${ids.tenantB})`;
  await owner`DELETE FROM tenancy.user_account WHERE id = ${ids.userId}`;
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

describe("the tenant wall around a ladder", () => {
  it("shows a firm only its own rungs", async () => {
    const rows = await asTenant(ids.tenantA, (tx) =>
      tx<{ id: string }[]>`SELECT id FROM tenancy.staff_grade`,
    );
    expect(rows.map((r) => r.id)).toEqual([ids.gradeA]);
  });

  it("hides another firm's rung even when its id is known", async () => {
    // The interesting direction: firm A holds B's grade id and asks for it by
    // primary key. RLS answers zero rows rather than refusing, which is what
    // makes "not found" and "not yours" the same answer to a caller.
    const rows = await asTenant(ids.tenantA, (tx) =>
      tx<{ id: string }[]>`SELECT id FROM tenancy.staff_grade WHERE id = ${ids.gradeB}`,
    );
    expect(rows).toHaveLength(0);
  });

  it("refuses to write a rung into another firm's ladder", async () => {
    await expect(
      asTenant(ids.tenantA, (tx) =>
        tx`
          INSERT INTO tenancy.staff_grade (tenant_id, code, name, rank)
          VALUES (${ids.tenantB}, 'smuggled', 'Smuggled', 1)
        `,
      ),
    ).rejects.toMatchObject({ code: "42501" }); // insufficient_privilege (WITH CHECK)
  });
});

describe("the composite key — the failure RLS does not catch", () => {
  it("refuses to hang a membership off another firm's rung", async () => {
    // THE test for this migration. Every policy is satisfied here: the row
    // being written really is firm A's, so the WITH CHECK passes, and the
    // foreign-key check runs as a system operation RLS does not filter. Only
    // `(grade_id, tenant_id)` referencing `(id, tenant_id)` refuses it.
    //
    // If this ever goes green with an id-only key, the wall has a hole that
    // leaks nothing and is still wrong: one firm's person, on another firm's
    // ladder, with the review threshold reading a rank the firm never set.
    await expect(
      asTenant(ids.tenantA, (tx) =>
        tx`UPDATE tenancy.membership SET grade_id = ${ids.gradeB} WHERE id = ${ids.membershipA}`,
      ),
    ).rejects.toMatchObject({ code: "23503" }); // foreign_key_violation
  });

  it("accepts the firm's own rung", async () => {
    const rows = await asTenant(ids.tenantA, (tx) =>
      tx<{ grade_id: string }[]>`
        UPDATE tenancy.membership SET grade_id = ${ids.gradeA}
        WHERE id = ${ids.membershipA} RETURNING grade_id
      `,
    );
    expect(rows[0]?.grade_id).toBe(ids.gradeA);
  });

  it("lets a person be taken off the ladder", async () => {
    // Null is a real state the column has to hold, not merely a default.
    const rows = await asTenant(ids.tenantA, (tx) =>
      tx<{ grade_id: string | null }[]>`
        UPDATE tenancy.membership SET grade_id = NULL
        WHERE id = ${ids.membershipA} RETURNING grade_id
      `,
    );
    expect(rows[0]?.grade_id).toBeNull();
  });
});

describe("the constraints hold against the OWNER role too", () => {
  // The role migrations and backfills run as. A rule enforced only in the
  // service is bypassed by the next script somebody writes.

  it("refuses a rank of zero or below", async () => {
    for (const rank of [0, -1]) {
      await expect(
        owner`
          INSERT INTO tenancy.staff_grade (tenant_id, code, name, rank)
          VALUES (${ids.tenantA}, ${`bad-${String(rank)}`}, 'Bad', ${rank})
        `,
      ).rejects.toMatchObject({ code: "23514" }); // check_violation
    }
  });

  it("refuses a second rung with the same code at one firm", async () => {
    // An ambiguous `manager` would make "Manager or above" resolve to whichever
    // row the query returned first.
    await expect(
      owner`
        INSERT INTO tenancy.staff_grade (tenant_id, code, name, rank)
        VALUES (${ids.tenantA}, 'manager', 'Manager (duplicate)', 7)
      `,
    ).rejects.toMatchObject({ code: "23505" }); // unique_violation
  });

  it("lets two DIFFERENT firms each have a rung coded `manager`", async () => {
    // Already true from the fixture, and stated as a test because the unique
    // constraint is scoped per firm on purpose: a firm renaming its Manager
    // must not collide with anybody else's.
    const rows = await owner<{ count: string }[]>`
      SELECT count(*)::text AS count FROM tenancy.staff_grade
      WHERE code = 'manager' AND tenant_id IN (${ids.tenantA}, ${ids.tenantB})
    `;
    expect(rows[0]?.count).toBe("2");
  });

  it("allows two rungs at one firm to share a rank", async () => {
    // Deliberately permitted: nothing compares WITHIN a rung, so requiring
    // uniqueness would turn inserting a rung into a renumbering of the ladder.
    const [row] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.staff_grade (tenant_id, code, name, rank)
      VALUES (${ids.tenantA}, 'head', 'Head', 7) RETURNING id
    `;
    expect(row?.id).toBeDefined();
  });
});

describe("retiring a rung is not deleting it", () => {
  it("gives the app no way to DELETE a grade at all", async () => {
    // The grant is SELECT, INSERT, UPDATE — never DELETE. A rung somebody held
    // is part of why they could approve something, so removing one is not an
    // operation the product offers, and that is enforced by the grant rather
    // than by every future caller remembering.
    const rows = await owner<{ privilege_type: string }[]>`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = 'tenancy' AND table_name = 'staff_grade' AND grantee = 'bib_app'
    `;
    const held = rows.map((r) => r.privilege_type).sort();
    expect(held).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });
});
