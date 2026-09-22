-- 0000 · Cloud SQL bootstrap — run ONCE, by hand, before the first migrate job
--
-- This is NOT a migration. It is deliberately outside `migrations/` and outside
-- `tenancy.schema_migrations`, because it does the things `cmd/migrate` cannot do
-- on a managed cluster and it has to have happened before migrate opens its first
-- connection. Numbered 0000 so it reads as "before 0001" and sorts that way; the
-- migrator never looks in this directory.
--
-- WHY A FILE EXISTS HERE AT ALL, when `migrations/README.md` says roles are
-- ensured in code: on a cluster with a superuser, `ensureRoles` in
-- `src/cmd/migrate.ts` does the whole job, and this file is unnecessary. Cloud SQL
-- has no superuser — the default user is a member of `cloudsqlsuperuser` and holds
-- CREATEROLE, CREATEDB and LOGIN and nothing else
-- (https://docs.cloud.google.com/sql/docs/postgres/users: "It does not have the
-- SUPERUSER or REPLICATION attributes", and "customers cannot create or have
-- access to users with superuser attributes"). Two statements the migrator issues
-- need privileges that cluster cannot hand out, and this file is where the gap is
-- closed for everything that CAN be closed here.
--
-- WHAT THIS FILE CANNOT FIX, said first so nobody runs it and expects a green
-- migrate: `ensureRoles` issues
--
--     ALTER ROLE bib_app WITH LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB
--                             NOCREATEROLE PASSWORD '…'
--
-- and PostgreSQL refuses the NOSUPERUSER clause from a non-superuser and the
-- NOBYPASSRLS clause from any caller that does not itself hold BYPASSRLS. Both
-- guards test whether the CLAUSE WAS WRITTEN, not what it asked for, so asking for
-- the attribute's own default value is refused exactly as asking for its opposite
-- would be (PG17 src/backend/commands/user.c, AlterRole: `if (!superuser() &&
-- dissuper)` at line 762 and `if (dbypassRLS && !has_bypassrls_privilege(
-- currentUserId))` at line 812 — both operands are DefElem POINTERS). No grant
-- issued from this file changes that, because no role in a Cloud SQL instance
-- holds either attribute to lend. `docs/deploy/database.md` carries the two-line
-- change to `src/cmd/migrate.ts` that fixes it, and the whole point of the change
-- is that it ASSERTS the two attributes rather than setting them — which is
-- strictly as strong, because NOBYPASSRLS is the CREATE ROLE default and a cluster
-- with no superuser has nobody who could ever grant BYPASSRLS away from it.
--
-- HOW TO RUN IT, and the one thing to get right:
--
--     psql "postgres://bib_migrator:PASSWORD@PRIVATE_IP:5432/bib?sslmode=require" \
--          -v ON_ERROR_STOP=1 -f infra/sql/0000_cloudsql_bootstrap.sql
--
-- Connect as THE IDENTITY THE MIGRATE JOB WILL USE. Every grant below is written
-- to `current_user`, because a grant made to the wrong login is the failure that
-- looks like success: the script prints no errors, and the migrate job fails on
-- `SET ROLE bib_owner` in migration 0001 with nothing saying why. The last block
-- of this file prints who it granted to, so the mistake is visible on the terminal
-- rather than a week later.
--
-- Idempotent: safe to run again, on an instance at any stage of its life.

\echo 'bib · Cloud SQL bootstrap'

-- ── 0. Refuse to run against the wrong cluster or the wrong login ─────────────
--
-- `cloudsqlsuperuser` is the role that owns a Cloud SQL database and is the only
-- route to CREATE EXTENSION on that platform
-- (https://docs.cloud.google.com/sql/docs/postgres/extensions: "extensions can
-- only be created by users that are part of the cloudsqlsuperuser role"). Four
-- extensions are created by migrations 0001, 0002 and 0049, each of them BEFORE
-- that file's `SET ROLE bib_owner` line, so they run as whoever connected — which
-- means the migrate identity needs this membership and `bib_owner` deliberately
-- does not have it.
--
-- The test is skipped where the role does not exist, so this file still runs
-- against an ordinary PostgreSQL cluster. That is not a courtesy: it is how the
-- file gets exercised anywhere other than the one production instance it was
-- written for, and an untested bootstrap is a bootstrap that fails on the morning
-- it matters.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudsqlsuperuser')
     AND NOT pg_has_role(current_user, 'cloudsqlsuperuser', 'USAGE') THEN
    RAISE EXCEPTION
      'cloudsql bootstrap: connected as %, which is not a member of cloudsqlsuperuser. '
      'On Cloud SQL that membership is what supplies CREATE EXTENSION (migrations 0001, '
      '0002 and 0049 need pgcrypto, citext, pg_trgm and btree_gist) and ownership of this '
      'database. Reconnect as the built-in Cloud SQL user the migrate job runs as — the '
      'one BIB_DATABASE_URL names — and run this file again.',
      current_user;
  END IF;
END $$;

-- ── 1. The two cluster roles, exactly as ensureRoles would create them ────────
--
-- Same names, same attributes, same order as `ensureRoles` in
-- `src/cmd/migrate.ts`, so that after this file runs the migrator finds both roles
-- present and its own CREATE block does nothing. They are duplicated here rather
-- than left to the migrator because the grants in section 2 have to be made by the
-- role that CREATED them: a CREATEROLE user is admin of the roles it creates and
-- of no others, so a role created by somebody else is a role this identity cannot
-- grant itself.
--
-- `bib_owner` is NOLOGIN and stays that way. It owns every table in the database
-- and NO table uses FORCE ROW LEVEL SECURITY, so a session that could authenticate
-- as `bib_owner` would read every firm's rows with the tenant wall standing and
-- doing nothing. It is reached only by `SET ROLE`, from a session that already
-- had to get in some other way.
--
-- `bib_app` is created with NO PASSWORD, which is why it cannot yet connect. The
-- password is a secret and therefore belongs in config, not in a committed file;
-- migrate sets it on every run from the password it parses out of
-- BIB_APP_DATABASE_URL. Run order is bootstrap → migrate → deploy, and the first
-- arrow is where `bib_app` becomes usable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bib_owner') THEN
    CREATE ROLE bib_owner NOLOGIN;
    RAISE NOTICE 'created role bib_owner (NOLOGIN)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bib_app') THEN
    CREATE ROLE bib_app LOGIN;
    RAISE NOTICE 'created role bib_app (LOGIN, no password until migrate runs)';
  END IF;
END $$;

-- ── 2. Two grants, for two different statements ──────────────────────────────
--
-- Neither of these is free on a managed cluster, and that is the whole reason this
-- section exists. When a NON-SUPERUSER creates a role, PostgreSQL grants the
-- creator ADMIN OPTION on it and withholds INHERIT and SET (PG17
-- src/backend/commands/user.c, CreateRole: `poptself.admin = true; poptself.inherit
-- = false; poptself.set = false;`, under the comment "If the current user isn't a
-- superuser, make them an admin of the new role"). Admin lets you administer the
-- role. It does not let you BE it, and it does not lend you its privileges.
--
--   * `bib_owner` needs SET, because `SET ROLE bib_owner` opens the DDL block of
--     very nearly every migration in this repo. Migration 0001 says so in its own
--     header: "Applied by cmd/migrate as a role that can SET ROLE bib_owner
--     (superuser locally; a migration_runner member of bib_owner in prod)."
--   * `bib_app` needs INHERIT, because migration 0042 ends with `ALTER DEFAULT
--     PRIVILEGES FOR ROLE bib_app IN SCHEMA pgboss`, and that statement asks for
--     that role's PRIVILEGES and not merely admin of it (PG17
--     src/backend/catalog/aclchk.c:1145 `if (!has_privs_of_role(GetUserId(),
--     iacls.roleid))`). Locally this passes only because the local migrate runs as
--     a superuser and a superuser has everyone's privileges.
--
-- `ensureRoles` grants the first of the two and not the second, which is a real
-- bug on any cluster with no superuser and is reported alongside this file. Both
-- grants are made here, so a fresh instance comes up whether or not that change
-- has landed yet — but a SECOND instance created by somebody who skipped this file
-- would still fail on 0042, which is why the one-line fix in `ensureRoles` is the
-- better answer and this is the belt to its braces.
--
-- Written as an unconditional GRANT rather than a conditional one: re-granting
-- with the same options is a no-op, while "grant it only if pg_has_role says no"
-- would silently leave a membership that carries USAGE and not SET at whatever it
-- already was.
DO $$
BEGIN
  EXECUTE format('GRANT bib_owner TO %I WITH ADMIN TRUE, INHERIT TRUE, SET TRUE', current_user);
  EXECUTE format('GRANT bib_app   TO %I WITH ADMIN TRUE, INHERIT TRUE, SET TRUE', current_user);
EXCEPTION WHEN insufficient_privilege THEN
  -- RAISE understands only %, so the role name is quoted with quote_ident here
  -- rather than with a %I the way the EXECUTEs above do.
  RAISE EXCEPTION
    'cloudsql bootstrap: % cannot grant itself bib_owner and bib_app. That happens when the '
    'roles already exist and were created by a DIFFERENT login, because a CREATEROLE user is '
    'admin only of the roles it created itself. Either connect as the login that created them '
    'and re-run, or have that login run: GRANT bib_owner, bib_app TO % WITH ADMIN TRUE, '
    'INHERIT TRUE, SET TRUE;',
    current_user, quote_ident(current_user);
END $$;

-- ── 3. The attribute the tenant wall rests on, ASSERTED ──────────────────────
--
-- The whole product's isolation reduces to `bib_app` not being able to step over a
-- row policy, and `src/db/boot-check.ts` refuses to start either process when it
-- can. This is the same question asked from the database side, before a container
-- has ever been launched — which is worth having, because this is a
-- production-only deployment and there is no staging box on which to discover the
-- answer.
--
-- It ASSERTS rather than sets, for the reason in the header: Cloud SQL cannot run
-- the ALTER that would set it. That costs nothing, because NOBYPASSRLS and
-- NOSUPERUSER are what CREATE ROLE produces
-- (https://www.postgresql.org/docs/17/sql-createrole.html: "NOBYPASSRLS is the
-- default. Only superuser roles or roles with BYPASSRLS can specify BYPASSRLS"),
-- and there is nobody in a Cloud SQL instance who could move them afterwards.
--
-- CREATEROLE and CREATEDB are checked too, and they are the ones that catch the
-- mistake this deployment is most likely to make: creating `bib_app` through the
-- Cloud SQL Admin API or a `google_sql_user` resource in Terraform. A built-in
-- Cloud SQL user is granted `cloudsqlsuperuser` automatically, and that carries
-- exactly the two attributes `ensureRoles` means to strip. Neither boot check
-- would notice — they read `rolbypassrls` and table privileges, and both would
-- still be right.
DO $$
DECLARE
  app record;
  wrong text[] := ARRAY[]::text[];
BEGIN
  SELECT rolbypassrls, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin
    INTO app FROM pg_roles WHERE rolname = 'bib_app';

  -- Section 1 creates it, so this can only be somebody running the sections out
  -- of order. A missing role reads as a passing assertion otherwise, because
  -- every field of an unfound record is NULL and NULL is not true.
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'cloudsql bootstrap: bib_app is missing from pg_roles. Run this file from the top — '
      'section 1 creates it — rather than one block at a time.';
  END IF;

  IF app.rolbypassrls   THEN wrong := wrong || 'BYPASSRLS';  END IF;
  IF app.rolsuper       THEN wrong := wrong || 'SUPERUSER';  END IF;
  IF app.rolcreaterole  THEN wrong := wrong || 'CREATEROLE'; END IF;
  IF app.rolcreatedb    THEN wrong := wrong || 'CREATEDB';   END IF;

  IF array_length(wrong, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'cloudsql bootstrap: bib_app holds %. It must hold LOGIN and nothing else. BYPASSRLS or '
      'SUPERUSER makes row-level security decorative and lets every firm read every other; '
      'CREATEROLE or CREATEDB means this role was created as a Cloud SQL built-in user, which '
      'is granted cloudsqlsuperuser automatically. bib_app is created by SQL — by this file or '
      'by cmd/migrate — and never as a google_sql_user. On a cluster with a superuser the fix '
      'is ALTER ROLE bib_app NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB; on Cloud SQL, '
      'where no superuser exists to run that, drop the role and let this file recreate it.',
      array_to_string(wrong, ' and ');
  END IF;

  IF NOT app.rolcanlogin THEN
    RAISE EXCEPTION
      'cloudsql bootstrap: bib_app cannot log in. Both services authenticate as it. '
      'Run: ALTER ROLE bib_app LOGIN;';
  END IF;
END $$;

-- The other half of the same trap, and the one no boot check in this product asks
-- about. A `bib_app` created correctly by SQL and then ALSO registered through the
-- Admin API — which is an easy thing to do while trying to set its password from
-- Terraform — picks up `cloudsqlsuperuser` membership without picking up a single
-- role ATTRIBUTE, so section 3 passes and the wall is gone anyway: membership of
-- the database owner is read access to every table with the policies bypassed
-- altogether, because a table's OWNER is not subject to its own row policies.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudsqlsuperuser')
     AND pg_has_role('bib_app', 'cloudsqlsuperuser', 'USAGE') THEN
    RAISE EXCEPTION
      'cloudsql bootstrap: bib_app is a member of cloudsqlsuperuser. That role owns this '
      'database and every schema created through the Admin API, and a table owner is exempt '
      'from its own row policies — so the tenant wall would stand and admit everybody. It is '
      'granted automatically to any user created through the Cloud SQL Admin API or a '
      'google_sql_user resource. Run: REVOKE cloudsqlsuperuser FROM bib_app; and delete the '
      'Cloud SQL user entry, leaving the SQL role this file created.';
  END IF;
END $$;

-- ── 4. The migration ledger, owned by bib_owner rather than by a login ────────
--
-- `cmd/migrate` creates `tenancy.schema_migrations` OUTSIDE any `SET ROLE
-- bib_owner`, so on an ordinary run that table ends up owned by whichever login
-- happened to migrate first. Every other object in this database is owned by
-- `bib_owner` because `migrations/README.md` requires it — "so every table is
-- owned by the owner role, not by whoever ran the migration" — and this one table
-- escapes the rule by being created in TypeScript rather than in a migration file.
--
-- Locally that is invisible. Here it would pin the record of what has been applied
-- to one named Cloud SQL user, so rotating the migrate identity, or ever running
-- the job as a second one, would leave a table nobody can ALTER. Creating it ahead
-- of migrate — same columns, same types, same constraint — means migrate's `CREATE
-- TABLE IF NOT EXISTS` finds it and does nothing.
--
-- The schema is created as `current_user` and the table as `bib_owner`, and that
-- split is not tidiness: CREATE on a DATABASE is an owner privilege, which the
-- migrate identity holds through `cloudsqlsuperuser` and `bib_owner` does not hold
-- at all. Migrations 0001 and 0042 are written the same way round for the same
-- reason — `CREATE SCHEMA … AUTHORIZATION bib_owner` first, `SET ROLE bib_owner`
-- after.
CREATE SCHEMA IF NOT EXISTS tenancy AUTHORIZATION bib_owner;

SET ROLE bib_owner;
CREATE TABLE IF NOT EXISTS tenancy.schema_migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
RESET ROLE;

-- ── 5. Close the doors PostgreSQL leaves open on a new database ──────────────
--
-- A freshly created database grants CONNECT and TEMPORARY to PUBLIC, which means
-- every role in the cluster — including any Cloud SQL user somebody adds from the
-- console next year to "have a look" — can open a session against it. This is a
-- multi-tenant database whose isolation is a row policy on a role, so the set of
-- roles that can reach it at all is worth keeping to the two that must.
--
-- CONNECT is then granted back to `bib_app` explicitly, and to nobody else.
-- `bib_owner` is NOLOGIN and never connects; the migrate identity reaches the
-- database through its `cloudsqlsuperuser` ownership, not through PUBLIC.
-- TEMPORARY is deliberately NOT granted back: nothing in this product creates a
-- temporary table, pg-boss included, and a privilege nobody uses is one nobody has
-- to reason about.
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO bib_app', current_database());
END $$;

-- PostgreSQL 15 stopped granting PUBLIC the right to create objects in `public`,
-- so on the version this deployment pins (17) the REVOKE below has nothing to do.
-- It is written anyway, because "nothing to do" is a fact about a version rather
-- than about this database, and the cost of stating it is one statement that
-- succeeds. What it prevents is real: CREATE on a schema every role can reach is
-- how an application role that must not create objects anywhere — see migration
-- 0042, which grants `bib_app` CREATE on the `pgboss` schema and on no other —
-- quietly gets somewhere to put them.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- ── 6. Say what happened, and to whom ────────────────────────────────────────
--
-- The grants in section 2 are the part of this file that can be right and useless
-- at the same time, by landing on a login that is not the one the migrate job
-- authenticates as. Printing the name is what turns that from a silent
-- misconfiguration into a line somebody reads before running the next command.
DO $$
DECLARE
  who text := current_user;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE 'bootstrap complete on database %', current_database();
  RAISE NOTICE '  roles       bib_owner (NOLOGIN, owns every object)';
  RAISE NOTICE '              bib_app   (LOGIN, no password until migrate runs)';
  RAISE NOTICE '  granted to  % — this MUST be the role BIB_DATABASE_URL names', who;
  RAISE NOTICE '  ledger      tenancy.schema_migrations, owned by bib_owner';
  RAISE NOTICE '';
  RAISE NOTICE 'next: run the migrate job, then infra/sql/verify_wall.sql as bib_app,';
  RAISE NOTICE 'then deploy the server and the worker. docs/deploy/database.md has the';
  RAISE NOTICE 'whole order and what each step proves.';
  RAISE NOTICE '';
END $$;
