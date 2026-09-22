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
  // NOBYPASSRLS is the load-bearing attribute — checked every run, but READ
  // rather than written, and that distinction is what lets this run on managed
  // Postgres at all.
  //
  // This statement used to say `NOBYPASSRLS NOSUPERUSER`. PostgreSQL refuses
  // both from anyone who does not already hold the attribute being set — and it
  // refuses them even when the caller CREATED the role moments earlier and holds
  // ADMIN OPTION on it, because the check is on the attribute, not on the role:
  //
  //   Only roles with the SUPERUSER attribute may change the SUPERUSER attribute.
  //   Only roles with the BYPASSRLS attribute may change the BYPASSRLS attribute.
  //
  // On a local cluster nobody noticed, because there the migrator is a real
  // superuser. Cloud SQL has no real superuser to offer — its default user is a
  // member of `cloudsqlsuperuser`, which carries CREATEROLE and CREATEDB and
  // neither of these — so the first statement of the first deploy would have
  // failed and no migration would ever have been applied.
  //
  // Nothing is given up. `CREATE ROLE` without the keywords already produces a
  // role with rolsuper = false and rolbypassrls = false, so the attributes are
  // right the moment the role exists; the ALTER only ever RE-stated them. What
  // it genuinely guarded against was somebody granting them later, and a read
  // catches that just as well — while also catching it on a cluster where we
  // could never have written it. `assertTenantWall` makes the same check again
  // at every boot of the API and the worker.
  await sql.unsafe(
    `ALTER ROLE bib_app WITH LOGIN NOCREATEDB NOCREATEROLE PASSWORD '${appPassword.replace(/'/g, "''")}'`,
  );
  const [attributes] = await sql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
    SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'bib_app'
  `;
  if (attributes === undefined) {
    throw new Error(
      "bib_app does not exist immediately after it was created. Something else is altering roles " +
        "on this cluster while the migration runs.",
    );
  }
  if (attributes.rolsuper || attributes.rolbypassrls) {
    const held = [
      attributes.rolsuper ? "SUPERUSER" : null,
      attributes.rolbypassrls ? "BYPASSRLS" : null,
    ]
      .filter((v): v is string => v !== null)
      .join(" and ");
    throw new Error(
      `bib_app holds ${held}, and the tenant wall depends on it holding neither: a role that ` +
        `bypasses row-level security reads every firm's data through every policy in this ` +
        `database. Revoke with: ALTER ROLE bib_app WITH NOSUPERUSER NOBYPASSRLS; (a superuser ` +
        `must run it — on Cloud SQL, that means support, so prefer dropping and recreating the role).`,
    );
  }
  // BOTH roles, and bib_app is not optional on managed Postgres.
  //
  // 0042 ends with `ALTER DEFAULT PRIVILEGES FOR ROLE bib_app IN SCHEMA pgboss`,
  // and PostgreSQL allows that only to a member of bib_app. A superuser is a
  // member of everything implicitly, so on a developer's cluster this grant was
  // invisible — the migration simply worked. The migrator on Cloud SQL is not a
  // superuser, so without this line 0042 fails with
  // "permission denied to change default privileges" after 0001-0041 have
  // already been applied, which is the worst place to stop: a half-migrated
  // database that the next run cannot repair on its own.
  await sql.unsafe(`GRANT bib_owner TO CURRENT_USER`);
  await sql.unsafe(`GRANT bib_app TO CURRENT_USER`);
}

main().catch((err: unknown) => {
  console.error("\nMigration failed:\n", err);
  process.exitCode = 1;
});
