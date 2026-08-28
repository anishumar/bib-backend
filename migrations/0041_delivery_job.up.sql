-- 0041 · the job — a unit of delivery work, and the row a step graph walks
--
-- The delivery lane's first table (T2.6), and the one T2.7 will advance.
--
-- ── WHY THIS IS NOT pg-boss's TABLE ─────────────────────────────────────────
--
-- The scheduler uses pg-boss, which keeps its own queue tables in its own
-- `pgboss` schema. It is tempting to let those be "the jobs" and save a table.
-- They are not the same thing, and conflating them loses both halves:
--
--   pg-boss's row is a DELIVERY ATTEMPT. It exists to be retried, backed off,
--   archived and eventually deleted. It is infrastructure: at-least-once
--   delivery of a message. It carries no tenant, obeys no RLS, and pg-boss is
--   free to change its shape between versions.
--
--   THIS row is a FACT ABOUT THE BUSINESS. "We owe this client this piece of
--   work, it is on step 3 of its graph, and here is who it came from." It is
--   tenant-scoped, it outlives every retry, and a year from now somebody will
--   ask what it did and when.
--
-- So pg-boss carries the TRIGGER; this table carries the WORK. A queue message
-- that is delivered twice must find the job already here and do nothing, which
-- is what the unique constraints below are for.
--
-- ── IDEMPOTENCY IS THE WHOLE DESIGN ─────────────────────────────────────────
--
-- Every route into this table is at-least-once. pg-boss redelivers on a crash;
-- the ledger sweep re-reads events it has already seen; a worker restart mid-
-- transaction leaves the trigger unacknowledged. None of that may produce a
-- second job, because a second job is a second set of tasks for staff and a
-- second invoice at the end of it.
--
-- `source_ref` is what makes that structural rather than careful: it is the id
-- of the thing that CAUSED this job — an engagement, later an obligation
-- instance — and `UNIQUE (tenant_id, source_kind, source_ref)` means the second
-- attempt conflicts instead of inserting. The service turns that conflict into
-- "already done", which is the correct answer.
--
-- ── STATE IS A COLUMN WITH A CHECK, NOT A TABLE OF ROWS ─────────────────────
--
-- T3.1 says states and priorities are ROWS, deliberately, because a firm
-- renames its work-item states. A JOB's states are not the firm's vocabulary —
-- they are the engine's own mechanics, the same at every firm, and a firm that
-- renamed `running` would be renaming something it does not own. Compare
-- `config.entry.kind`, which is also a CHECK for the same reason.

-- The schema is created BEFORE `SET ROLE`, as 0001 and 0002 do. CREATE SCHEMA
-- needs CREATE on the DATABASE, which bib_owner deliberately does not hold —
-- it owns objects, it does not own the database. So the migration runner (a
-- superuser locally, a migration_runner in prod) creates it and hands ownership
-- to bib_owner; everything after SET ROLE is then owned by the right role.
CREATE SCHEMA IF NOT EXISTS delivery AUTHORIZATION bib_owner;
REVOKE ALL ON SCHEMA delivery FROM PUBLIC;
GRANT USAGE ON SCHEMA delivery TO bib_app;

SET ROLE bib_owner;

-- Shared trigger for this schema, mirroring tenancy.set_updated_at. A second
-- function rather than reaching across schemas, so `delivery` can be read,
-- dropped or moved without a dangling dependency on another schema's helper.
CREATE OR REPLACE FUNCTION delivery.set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE delivery.job (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenancy.tenant(id),

  -- What caused this job to exist. `engagement` is the only kind today — a
  -- signed letter's advance was recorded and the work may begin. `obligation`
  -- joins it with T3.2, and the CHECK is what makes adding one a deliberate
  -- change rather than a typo that silently creates a third kind.
  source_kind   text NOT NULL CHECK (source_kind IN ('engagement', 'obligation')),
  -- The id of that thing. NOT a foreign key, and that is deliberate: the two
  -- kinds point at different tables, so a single FK cannot express it, and a
  -- pair of nullable FKs would let a row name both or neither. The uniqueness
  -- below is what this column is for; the referent is validated by the service
  -- that writes it, which is the only place that knows which kind it holds.
  source_ref    uuid NOT NULL,

  -- The engine's own mechanics, not the firm's vocabulary — see the note above.
  --   pending   created, nothing has run yet
  --   running   the orchestrator is walking its steps (T2.7)
  --   blocked   waiting on a human decision or an external system
  --   done      reached a terminal step
  --   cancelled stopped deliberately; never reused
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'blocked', 'done', 'cancelled')),

  -- Which workflow this job walks, pinned. Null until T2.7 exists and there is
  -- a template to pin — a job created today records that it is owed and waits.
  -- When it lands it is a `config.version` id, frozen: editing a workflow must
  -- never rewrite the path a job already started down. That is the registry's
  -- whole argument for pinning, and the reason this is an id and not a name.
  template_version_id uuid,

  -- When the work may begin. THE T-X COLUMN: an obligation due on the 20th with
  -- ten days' lead time is a job that becomes runnable on the 10th. A job is
  -- created as soon as it is KNOWN and waits here until it is DUE, so the
  -- calendar can be materialised a year ahead without a year of noise.
  runnable_at   timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- IDEMPOTENCY, structurally. One job per cause, per firm. See the note above:
  -- every route into this table can fire twice, and the second must lose.
  UNIQUE (tenant_id, source_kind, source_ref),
  -- The composite-key target, for the tables T2.7 will hang off a job.
  UNIQUE (id, tenant_id),

  -- A job that has started has a start time, and one that is finished has both.
  -- Written as a constraint rather than trusted to the service, because the
  -- orchestrator will be the second writer and "who forgot to set it" is not a
  -- question anybody should have to answer.
  CONSTRAINT job_timestamps_follow_status CHECK (
    (status = 'pending'   AND started_at IS NULL  AND finished_at IS NULL) OR
    (status IN ('running', 'blocked') AND started_at IS NOT NULL AND finished_at IS NULL) OR
    (status IN ('done', 'cancelled')  AND started_at IS NOT NULL AND finished_at IS NOT NULL)
  )
);

CREATE TRIGGER trg_job_updated_at BEFORE UPDATE ON delivery.job
  FOR EACH ROW EXECUTE FUNCTION delivery.set_updated_at();

-- THE query the worker runs on every tick: "what is runnable now, here?".
-- Partial on the two states that can still move, because a finished job is
-- ninety-nine percent of the table within a year and none of it is ever the
-- answer to this question.
CREATE INDEX idx_job_runnable ON delivery.job (tenant_id, runnable_at)
  WHERE status IN ('pending', 'running');

-- Tenant-scoped, so the wall applies. No identity-mode clause: nothing asks
-- "this user's jobs across firms" — a job belongs to the firm that owes the work.
ALTER TABLE delivery.job ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_isolation ON delivery.job
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

-- SELECT, INSERT, UPDATE — never DELETE. A job is the record that work was
-- owed; cancelling it is a state, and a cancelled job that vanished would take
-- the reason with it. Set explicitly rather than inherited, because this is a
-- new schema and 0001's ALTER DEFAULT PRIVILEGES covers only `tenancy`.
GRANT SELECT, INSERT, UPDATE ON delivery.job TO bib_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bib_owner IN SCHEMA delivery
  GRANT SELECT, INSERT, UPDATE ON TABLES TO bib_app;

RESET ROLE;
