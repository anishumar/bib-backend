// B30 and B38 (audit 2026-10-03), against the live catalogue.
//
// B30: `bib_app`, the role every request runs as, could INSERT and UPDATE
// `tenancy.schema_migrations` (0001's blanket grant on the tenancy schema
// caught the migrator's own bookkeeping table). A request that could write
// there could mark a migration applied that never ran, or un-mark one so it
// runs twice. Nothing reads or writes it as bib_app: the migrator connects as
// the table's owner. Security audit F-06-1.
//
// B38: `tenancy.administrator_survives()` is SECURITY DEFINER (it counts the
// firm's administrators as its owner) and ran with the CALLER's search_path.
// Every name in it is schema-qualified, so the risk was low; a definer
// function pins its search_path all the same, so an object a caller can
// create can never stand in for a built-in it calls.
//
// Run with:  npm run test:integration   (needs a migrated local database)
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { load } from "../../src/config/config";

const cfg = load();
const owner = postgres(cfg.db.ownerUrl, { max: 1 });

afterAll(async () => {
  await owner.end({ timeout: 5 });
});

describe("0336: the request role cannot rewrite migration history (B30)", () => {
  it("holds no privilege on tenancy.schema_migrations", async () => {
    const [row] = await owner<{ ins: boolean; upd: boolean; del: boolean; sel: boolean; trunc: boolean }[]>`
      SELECT has_table_privilege('bib_app', 'tenancy.schema_migrations', 'INSERT')   AS ins,
             has_table_privilege('bib_app', 'tenancy.schema_migrations', 'UPDATE')   AS upd,
             has_table_privilege('bib_app', 'tenancy.schema_migrations', 'DELETE')   AS del,
             has_table_privilege('bib_app', 'tenancy.schema_migrations', 'SELECT')   AS sel,
             has_table_privilege('bib_app', 'tenancy.schema_migrations', 'TRUNCATE') AS trunc
    `;
    expect(row).toEqual({ ins: false, upd: false, del: false, sel: false, trunc: false });
  });

  it("is refused a write as the request role", async () => {
    const app = postgres(cfg.db.appUrl, { max: 1 });
    try {
      await expect(app`UPDATE tenancy.schema_migrations SET version = version WHERE false`).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await app.end({ timeout: 5 });
    }
  });

  it("leaves the migrator's own reads and writes alone", async () => {
    const [row] = await owner<{ n: number }[]>`SELECT count(*)::int AS n FROM tenancy.schema_migrations`;
    expect(row?.n).toBeGreaterThan(100);
  });
});

describe("0336: the one SECURITY DEFINER function pins its search_path (B38)", () => {
  it("runs administrator_survives() with a fixed search_path", async () => {
    const rows = await owner<{ proname: string; prosecdef: boolean; proconfig: string[] | null }[]>`
      SELECT p.proname, p.prosecdef, p.proconfig
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'tenancy' AND p.proname = 'administrator_survives'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.prosecdef).toBe(true);
    expect(rows[0]?.proconfig).toEqual(["search_path=pg_catalog, pg_temp"]);
  });

  it("is still the only SECURITY DEFINER function in the product's schemas, and every one pins its path", async () => {
    const rows = await owner<{ name: string; config: string[] | null }[]>`
      SELECT n.nspname || '.' || p.proname AS name, p.proconfig AS config
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.prosecdef
         AND n.nspname IN ('tenancy', 'core', 'crm', 'config', 'delivery', 'ledger', 'files')
    `;
    for (const r of rows) {
      expect(r.config?.some((c) => c.startsWith("search_path=")), r.name).toBe(true);
    }
  });
});
