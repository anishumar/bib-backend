// cmd/migrate — applies pending migrations/*.up.sql in order and exits. Meant to
// run as a one-shot job (locally by hand, in prod as a pre-deploy job), never as
// a long-lived process.
//
// Two responsibilities the SQL files cannot own:
//   1. Ensure the cluster-level roles (bib_owner, bib_app) exist with the right
//      attributes — bib_app is NOBYPASSRLS, the tenant wall depends on it — and
//      set bib_app's password from config (a secret, so not in a committed file).
//   2. Track applied versions in tenancy.schema_migrations, pinned to a schema
//      so it never collides on a shared cluster.
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { load } from "../config/config";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "migrations");

async function main(): Promise<void> {
  const cfg = load();
  const sql = postgres(cfg.db.ownerUrl, { max: 1 });

  try {
    console.log("\nMigrating bib-backend\n");
    await ensureRoles(sql, cfg.db.appPassword);
    console.log("  roles      ✓  bib_owner, bib_app (NOBYPASSRLS)");

    await sql`CREATE SCHEMA IF NOT EXISTS tenancy AUTHORIZATION bib_owner`;
    await sql`
      CREATE TABLE IF NOT EXISTS tenancy.schema_migrations (
        version    text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    const applied = new Set(
      (await sql<{ version: string }[]>`SELECT version FROM tenancy.schema_migrations`).map(
        (r) => r.version,
      ),
    );

    const ups = (await readdir(migrationsDir))
      .filter((f) => f.endsWith(".up.sql"))
      .sort();

    let ran = 0;
    for (const file of ups) {
      const version = file.replace(/\.up\.sql$/, "");
      if (applied.has(version)) continue;
      const ddl = await readFile(join(migrationsDir, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(ddl);
        await tx`INSERT INTO tenancy.schema_migrations (version) VALUES (${version})`;
      });
      console.log(`  applied    ✓  ${version}`);
      ran += 1;
    }
    if (ran === 0) console.log("  applied    ·  nothing pending");
    console.log("\nDone.\n");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Roles are cluster-level and need a secret, so they are ensured here rather
 *  than in a committed SQL file. Idempotent. */
async function ensureRoles(sql: postgres.Sql, appPassword: string): Promise<void> {
  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bib_owner') THEN
        CREATE ROLE bib_owner NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bib_app') THEN
        CREATE ROLE bib_app LOGIN;
      END IF;
    END $$;
  `);
  // NOBYPASSRLS is the load-bearing attribute — assert it every run.
  await sql.unsafe(
    `ALTER ROLE bib_app WITH LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${appPassword.replace(/'/g, "''")}'`,
  );
  await sql.unsafe(`GRANT bib_owner TO CURRENT_USER`);
}

main().catch((err: unknown) => {
  console.error("\nMigration failed:\n", err);
  process.exitCode = 1;
});
