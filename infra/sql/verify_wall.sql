-- verify_wall · the boot checks, asked from psql instead of from a container
--
-- `src/db/boot-check.ts` runs two assertions before either process serves a
-- request — `assertTenantWall` and `assertLedgerAppendOnly` — and a process that
-- fails one refuses to start. This file asks the same questions of the same
-- database as the same role, with no Node, no image and no revision involved.
--
-- WHY THAT IS WORTH A FILE. This deployment is production only: one environment,
-- BIB_ENVIRONMENT=production, and therefore the whole boot gate in
-- `src/config/validate.ts` live from the very first deploy. There is no staging
-- box on which to find out that migrate ran as the wrong role, or that a
-- `google_sql_user` quietly handed `bib_app` the database owner's privileges. The
-- alternative to this file is deploying a revision and reading a crash loop, which
-- answers the same question an hour later and with a worse error message.
--
-- HOW TO RUN IT — as bib_app, with the URL the services will use:
--
--     psql "$BIB_APP_DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/sql/verify_wall.sql
--
-- Run it after the migrate job and before the first deploy. It writes nothing, so
-- it is also the right thing to run against a database somebody is worried about.
--
-- THE MESSAGES ARE THE BOOT CHECK'S OWN, DELIBERATELY. Where a sentence here reads
-- like `boot-check.ts`, it is because it was copied from it: two descriptions of
-- one wall that are free to drift are two descriptions that will, and the one
-- somebody reads at 3am would be whichever happens to be wrong. Adding an
-- assertion to `boot-check.ts` means adding it here.

\echo 'bib · tenant wall and ledger verification'

-- ── 0. Ask as the right role ─────────────────────────────────────────────────
--
-- Every assertion below is about `current_user`, exactly as the boot check's are —
-- it reads `rolbypassrls … WHERE rolname = current_user` and calls
-- `has_table_privilege` with no role argument. Run as the migrate identity instead
-- and the file reports on a role that is a member of `bib_owner`, which owns
-- `ledger.event` and is therefore allowed to UPDATE it. That is a correct answer
-- to a question nobody asked, and it looks exactly like the wall being broken.
DO $$
BEGIN
  IF current_user <> 'bib_app' THEN
    RAISE EXCEPTION
      'verify_wall: connected as %, not bib_app. This file checks the role the API and the '
      'worker actually serve with, so it has to BE that role. Reconnect with '
      'BIB_APP_DATABASE_URL — the same string the two Cloud Run services read — and run it '
      'again.',
      current_user;
  END IF;
END $$;

-- ── 1. assertTenantWall, first half: the role cannot step over a policy ──────
--
-- BYPASSRLS is the attribute the entire product's isolation rests on. Note what is
-- being asked: whether the attribute IS right, never an attempt to make it right.
-- That is not a limitation of psql — it is the only thing a managed cluster can
-- do, because PostgreSQL refuses a NOBYPASSRLS clause from any caller that does
-- not itself hold BYPASSRLS, and Cloud SQL has nobody who does. It also loses
-- nothing: NOBYPASSRLS is the CREATE ROLE default, only a superuser or an existing
-- BYPASSRLS holder can grant it away, and this cluster has neither.
DO $$
DECLARE
  bypass boolean;
BEGIN
  SELECT rolbypassrls INTO bypass FROM pg_roles WHERE rolname = current_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verify_wall: could not read current role from pg_roles';
  END IF;
  IF bypass THEN
    RAISE EXCEPTION
      'verify_wall: the app role ''%'' has BYPASSRLS. It MUST be NOBYPASSRLS or RLS is '
      'decorative and every tenant can read every other. On a cluster with a superuser: '
      'ALTER ROLE % NOBYPASSRLS; on Cloud SQL, where no superuser exists to run that, drop '
      'the role and let infra/sql/0000_cloudsql_bootstrap.sql recreate it.',
      current_user, current_user;
  END IF;
  RAISE NOTICE '  role         ok  % is NOBYPASSRLS', current_user;
END $$;

-- ── 2. assertTenantWall, second half: the policy can fire ────────────────────
--
-- `tenancy.membership` is the join every scoped read passes through, and migration
-- 0001 enables row-level security on it. Read out of `pg_class` by name rather
-- than through `'tenancy.membership'::regclass`, because the cast RAISES on a
-- database with no such table and the message it raises is about a type
-- conversion. "Run migrations first" is the answer somebody needs there, and it is
-- only sayable if the absence comes back as no rows.
DO $$
DECLARE
  enabled boolean;
BEGIN
  SELECT c.relrowsecurity INTO enabled
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'tenancy' AND c.relname = 'membership';
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'verify_wall: tenancy.membership is missing — run the migrate job first. If it has run, '
      'check that it reported applying 0001_tenancy rather than failing on ensureRoles.';
  END IF;
  IF NOT enabled THEN
    RAISE EXCEPTION
      'verify_wall: row-level security is NOT enabled on tenancy.membership. The isolation '
      'policy cannot fire. Re-apply migration 0001.';
  END IF;
  RAISE NOTICE '  tenant wall  ok  RLS enabled on tenancy.membership';
END $$;

-- ── 3. assertLedgerAppendOnly, first half: the audit trail is tenant-scoped ──
DO $$
DECLARE
  enabled boolean;
BEGIN
  SELECT c.relrowsecurity INTO enabled
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'ledger' AND c.relname = 'event';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verify_wall: ledger.event is missing — run the migrate job first';
  END IF;
  IF NOT enabled THEN
    RAISE EXCEPTION
      'verify_wall: row-level security is NOT enabled on ledger.event. One tenant''s audit '
      'trail would be readable by another. Re-apply migration 0003.';
  END IF;
  RAISE NOTICE '  ledger       ok  RLS enabled on ledger.event';
END $$;

-- ── 4. assertLedgerAppendOnly, second half: history cannot be rewritten ──────
--
-- Migration 0003 grants `bib_app` SELECT and INSERT on `ledger.event` and nothing
-- else, and its default privileges withhold the rest so a table added to that
-- schema later is append-only without anybody remembering. Nothing in Cloud SQL
-- adds table privileges to a role, so this is a check on what the migrations did
-- rather than on what the platform might have done — which is exactly why it is
-- worth running after a migrate that reported success: a partially applied 0003 is
-- a database that would come up with an editable audit trail.
DO $$
DECLARE
  g record;
  verbs text[] := ARRAY[]::text[];
  missing text[] := ARRAY[]::text[];
BEGIN
  SELECT has_table_privilege('ledger.event', 'SELECT') AS can_select,
         has_table_privilege('ledger.event', 'INSERT') AS can_insert,
         has_table_privilege('ledger.event', 'UPDATE') AS can_update,
         has_table_privilege('ledger.event', 'DELETE') AS can_delete
    INTO g;

  IF g.can_update THEN verbs := verbs || 'UPDATE'; END IF;
  IF g.can_delete THEN verbs := verbs || 'DELETE'; END IF;
  IF array_length(verbs, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'verify_wall: the app role ''%'' holds % on ledger.event. The audit trail must be '
      'append-only — a correction is a new event, never an edit. Run: REVOKE UPDATE, DELETE '
      'ON ledger.event FROM %;',
      current_user, array_to_string(verbs, ' and '), current_user;
  END IF;

  IF NOT g.can_select THEN missing := missing || 'SELECT'; END IF;
  IF NOT g.can_insert THEN missing := missing || 'INSERT'; END IF;
  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'verify_wall: the app role ''%'' is missing % on ledger.event, so events cannot be '
      'recorded. Run: GRANT SELECT, INSERT ON ledger.event TO %;',
      current_user, array_to_string(missing, ' and '), current_user;
  END IF;
  RAISE NOTICE '  ledger       ok  SELECT + INSERT, no UPDATE, no DELETE';
END $$;

-- ── 5. What the boot checks do NOT ask, and Cloud SQL makes worth asking ─────
--
-- The two assertions above read a role ATTRIBUTE and a set of table privileges,
-- and both would be perfectly satisfied by a `bib_app` that is a member of
-- `cloudsqlsuperuser`. That membership is granted automatically to any user
-- created through the Cloud SQL Admin API or a `google_sql_user` resource
-- (https://docs.cloud.google.com/sql/docs/postgres/users), it carries no role
-- attribute the boot check looks at, and it makes the role a member of the
-- database owner — which reaches every table as its OWNER, and a table's owner is
-- not subject to its own row policies. `bib_app` is created by SQL and only by
-- SQL; this is the check that says so out loud.
--
-- CREATEROLE and CREATEDB are asked about for the same reason from the other side:
-- they are the two attributes `ensureRoles` means to strip and the two a
-- Cloud SQL built-in user arrives holding, so finding them set is the fingerprint
-- of the same mistake.
DO $$
DECLARE
  app record;
  wrong text[] := ARRAY[]::text[];
BEGIN
  SELECT rolsuper, rolcreaterole, rolcreatedb INTO app
    FROM pg_roles WHERE rolname = current_user;

  IF app.rolsuper      THEN wrong := wrong || 'SUPERUSER';  END IF;
  IF app.rolcreaterole THEN wrong := wrong || 'CREATEROLE'; END IF;
  IF app.rolcreatedb   THEN wrong := wrong || 'CREATEDB';   END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudsqlsuperuser')
     AND pg_has_role(current_user, 'cloudsqlsuperuser', 'USAGE') THEN
    wrong := wrong || 'membership of cloudsqlsuperuser';
  END IF;

  IF array_length(wrong, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'verify_wall: the app role ''%'' holds %. The two boot checks in src/db/boot-check.ts '
      'would pass anyway — they read rolbypassrls and table privileges — and the tenant wall '
      'would still be open, because membership of cloudsqlsuperuser reaches every table as '
      'its owner and an owner is exempt from its own row policies. This is what creating '
      'bib_app as a Cloud SQL user looks like. It must be created by SQL: see '
      'infra/sql/0000_cloudsql_bootstrap.sql and docs/deploy/database.md.',
      current_user, array_to_string(wrong, ', ');
  END IF;
  RAISE NOTICE '  privileges   ok  no SUPERUSER, CREATEROLE, CREATEDB or cloudsqlsuperuser';
END $$;

\echo ''
\echo 'wall verified. Nothing was written. The API and the worker will pass the same'
\echo 'assertions at boot; deploying is now the only thing left.'
\echo ''
