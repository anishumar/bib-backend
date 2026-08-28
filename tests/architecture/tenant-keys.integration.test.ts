// THE TENANT WALL, as a property of the schema rather than a list of tables.
//
// A foreign-key check runs as a system operation that RLS does not filter. So a
// reference from one tenant-scoped table to another, made by id ALONE, lets one
// firm's row hang off another firm's object: both constraints pass, and the RLS
// WITH CHECK passes too, because the row really does belong to the firm making
// it. Nothing leaks — RLS still hides each firm's rows from the other — but the
// wall is supposed to make that unrepresentable rather than merely invisible.
//
// This test does not enumerate the tables. It asks the CATALOGUE the same
// question the sweep asked, so a table added next month is covered the moment it
// exists — the same reason tests/api/auth-coverage.test.ts enumerates the router
// rather than a list somebody maintains. 0006 fixed config, 0007 fixed crm.lead,
// 0011 covered proposals, 0015 swept core; this is what keeps the set closed.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";
import { withTenant } from "../../src/db/tenant";

const cfg = load();
const app = postgres(cfg.db.appUrl, { max: 2 });
const owner = postgres(cfg.db.ownerUrl, { max: 2 });

const stamp = Date.now().toString(36);

afterAll(async () => {
  await Promise.all([app.end({ timeout: 5 }), owner.end({ timeout: 5 })]);
});

/** Every schema that holds tenant-scoped business data. A new one belongs here
 *  the day it is created — which is the only maintenance this test needs. */
const SCHEMAS = ["core", "crm", "config", "tenancy", "ledger"];

describe("every tenant-scoped reference carries its tenant", () => {
  it("finds no foreign key that points at a tenant-scoped table by id alone", async () => {
    const offenders = await owner<{ table: string; constraint: string; def: string }[]>`
      WITH tenant_scoped AS (
        SELECT c.oid, c.relname, n.nspname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a
          ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0
        WHERE c.relkind = 'r' AND n.nspname = ANY(${SCHEMAS})
      )
      SELECT s.nspname || '.' || s.relname AS table,
             con.conname                   AS constraint,
             pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
      JOIN tenant_scoped s   ON s.oid = con.conrelid
      JOIN tenant_scoped tgt ON tgt.oid = con.confrelid
      WHERE con.contype = 'f'
        AND NOT (
          SELECT 'tenant_id' = ANY(ARRAY(
            SELECT a.attname
            FROM unnest(con.conkey) k
            JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k
          ))
        )
      ORDER BY 1, 2
    `;

    // The message is the fix, not just the failure: whoever sees this needs to
    // know the shape of the constraint they are missing.
    expect(
      offenders.map((o) => `${o.table}.${o.constraint}: ${o.def}`),
      "each of these lets one firm's row point at another firm's object. Add a composite " +
        "key on the target — UNIQUE (id, tenant_id) — and reference (fk_id, tenant_id). " +
        "See migration 0015.",
    ).toEqual([]);
  });
});

describe("and the database actually refuses a crossed row", () => {
  // The catalogue check above proves the constraints EXIST. These prove they
  // bite, on the two that matter most in practice.
  it("refuses an identifier attached to another firm's party", async () => {
    // The worst of the six: identifiers are what lead capture deduplicates on,
    // so a crossed row would make one firm's capture resolve to another firm's
    // party — a leak with no RLS violation anywhere in it.
    const [a] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.tenant (slug, name, reporting_currency)
      VALUES (${`fk-test-a-${stamp}`}, 'FK Test A', 'INR') RETURNING id
    `;
    const [b] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.tenant (slug, name, reporting_currency)
      VALUES (${`fk-test-b-${stamp}`}, 'FK Test B', 'INR') RETURNING id
    `;
    if (!a || !b) throw new Error("could not create the test tenants");

    const [theirs] = await owner<{ id: string }[]>`
      INSERT INTO core.party (tenant_id, kind, display_name)
      VALUES (${b.id}, 'organization', 'Somebody Else Ltd') RETURNING id
    `;
    if (!theirs) throw new Error("could not create the other firm's party");

    // Firm A, holding firm B's party id, under A's own RLS context.
    const err = await withTenant(app, a.id, (db) =>
      db`
        INSERT INTO core.party_identifier
          (tenant_id, party_id, type, value, valid_from)
        VALUES (${a.id}, ${theirs.id}, 'pan', 'AAACL9999X', '2026-01-01')
      `,
    ).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23503"); // foreign_key_violation
  });

  it("refuses a relationship whose other end is another firm's party", async () => {
    const [a] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.tenant (slug, name, reporting_currency)
      VALUES (${`fk-test-c-${stamp}`}, 'FK Test C', 'INR') RETURNING id
    `;
    const [b] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.tenant (slug, name, reporting_currency)
      VALUES (${`fk-test-d-${stamp}`}, 'FK Test D', 'INR') RETURNING id
    `;
    if (!a || !b) throw new Error("could not create the test tenants");

    const [mine] = await owner<{ id: string }[]>`
      INSERT INTO core.party (tenant_id, kind, display_name)
      VALUES (${a.id}, 'person', 'A Director') RETURNING id
    `;
    const [theirs] = await owner<{ id: string }[]>`
      INSERT INTO core.party (tenant_id, kind, display_name)
      VALUES (${b.id}, 'organization', 'Their Company Ltd') RETURNING id
    `;
    if (!mine || !theirs) throw new Error("could not create the parties");

    // BOTH ends are constrained, so the crossed one is refused whichever way
    // round it is written.
    const outward = await withTenant(app, a.id, (db) =>
      db`
        INSERT INTO core.party_relationship
          (tenant_id, from_party_id, to_party_id, type, valid_from)
        VALUES (${a.id}, ${mine.id}, ${theirs.id}, 'director_of', '2026-01-01')
      `,
    ).catch((e: unknown) => e);
    expect((outward as { code?: string }).code).toBe("23503");

    const inward = await withTenant(app, a.id, (db) =>
      db`
        INSERT INTO core.party_relationship
          (tenant_id, from_party_id, to_party_id, type, valid_from)
        VALUES (${a.id}, ${theirs.id}, ${mine.id}, 'director_of', '2026-01-01')
      `,
    ).catch((e: unknown) => e);
    expect((inward as { code?: string }).code).toBe("23503");
  });

  it("still allows the ordinary case, so the constraint is not simply refusing everything", async () => {
    // Worth asserting: a constraint that refuses valid data would pass every
    // test above and break the product.
    const [t] = await owner<{ id: string }[]>`
      INSERT INTO tenancy.tenant (slug, name, reporting_currency)
      VALUES (${`fk-test-ok-${stamp}`}, 'FK Test OK', 'INR') RETURNING id
    `;
    if (!t) throw new Error("could not create the test tenant");

    await withTenant(app, t.id, async (db) => {
      const [org] = await db<{ id: string }[]>`
        INSERT INTO core.party (tenant_id, kind, display_name)
        VALUES (${t.id}, 'organization', 'Ordinary Ltd') RETURNING id
      `;
      const [person] = await db<{ id: string }[]>`
        INSERT INTO core.party (tenant_id, kind, display_name)
        VALUES (${t.id}, 'person', 'Ordinary Director') RETURNING id
      `;
      if (!org || !person) throw new Error("could not create the parties");

      await db`
        INSERT INTO core.organization (party_id, tenant_id, legal_name)
        VALUES (${org.id}, ${t.id}, 'Ordinary Limited')
      `;
      await db`
        INSERT INTO core.legal_entity (party_id, tenant_id, jurisdiction, entity_type)
        VALUES (${org.id}, ${t.id}, 'IN', 'private_limited')
      `;
      await db`
        INSERT INTO core.party_identifier (tenant_id, party_id, type, value, valid_from)
        VALUES (${t.id}, ${org.id}, 'pan', 'AAACO1234P', '2026-01-01')
      `;
      await db`
        INSERT INTO core.party_relationship
          (tenant_id, from_party_id, to_party_id, type, valid_from)
        VALUES (${t.id}, ${person.id}, ${org.id}, 'director_of', '2026-01-01')
      `;
    });

    const [count] = await owner<{ n: string }[]>`
      SELECT count(*) AS n FROM core.party_relationship WHERE tenant_id = ${t.id}
    `;
    expect(Number(count?.n)).toBe(1);
  });
});
