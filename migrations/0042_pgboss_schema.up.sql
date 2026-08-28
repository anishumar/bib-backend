-- 0042 · the queue's namespace, so the worker does not need CREATE on the database
--
-- pg-boss keeps its queue in Postgres and migrates its own tables — that is why
-- it is worth using, and it is a real exception to `migrations/README.md`'s rule
-- that migrations own the schema. The exception is accepted (see
-- `infrastructure/pgboss/boss-queue.ts`) but it is NOT accepted at any price:
-- creating a schema needs CREATE on the DATABASE, and granting that to bib_app
-- would let the application role create objects anywhere it liked.
--
-- So the boundary moves one level down, and this migration is where it is drawn:
--
--   WE own the namespace. It is created here, by the migration runner, exactly
--   as `tenancy`, `core`, `crm` and `delivery` are.
--   pg-boss owns what is INSIDE it. bib_app gets CREATE on this schema and on no
--   other, so the worker can let pg-boss install and upgrade its own tables
--   without being able to create a table anywhere that matters.
--
-- The failure this fixes is loud rather than subtle — the worker refuses to
-- start with `permission denied` (42501) on its first tick — but it happens at
-- deploy time in a process nobody is watching, which is the worst moment for a
-- privilege to be missing.
--
-- 0041 already applied when this was found, and an applied migration is
-- immutable, so this is the fix-forward the rule prescribes rather than an edit
-- to the previous number.

CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION bib_owner;
REVOKE ALL ON SCHEMA pgboss FROM PUBLIC;

-- USAGE to reach it, CREATE to install and upgrade inside it. Scoped to this one
-- schema: bib_app still cannot create so much as a temporary table in `tenancy`,
-- `core`, `crm`, `delivery` or `ledger`.
GRANT USAGE, CREATE ON SCHEMA pgboss TO bib_app;

-- The queue's own rows are worked by bib_app, and pg-boss deletes completed jobs
-- as part of its maintenance — so unlike every table we own, DELETE belongs here.
-- Nothing in this schema is a business fact: it is delivery attempts, and an
-- attempt that has been archived is meant to go.
ALTER DEFAULT PRIVILEGES FOR ROLE bib_app IN SCHEMA pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bib_app;
