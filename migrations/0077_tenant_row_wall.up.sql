-- The one wall in this schema with a single course of bricks.
--
-- ── WHERE THE ASYMMETRY IS ─────────────────────────────────────────────────
--
-- Every tenant-scoped table in this database is defended three times over: RLS
-- with a policy keyed on `app.tenant_id`, a composite `(id, tenant_id)` foreign
-- key so a row cannot even REFER to another firm's, and the `withTenant`
-- resolver as the only sanctioned way to reach any of it. Three independent
-- things have to be wrong at once for a leak.
--
-- `tenancy.tenant` is GLOBAL and has none of them, by design: the org switcher
-- has to read the firms a user belongs to before any firm is chosen, so there
-- is no context to filter on. That is correct for READS.
--
-- It is thinner than it looks for WRITES. The firm's own row carries things a
-- firm changes about itself — who signs its engagement letters, its work-split
-- axis, its time zone — and every one of those writes is protected by nothing
-- but a `WHERE id = $tenantId` in application code that got the id from the
-- session. One repository method that takes the id from somewhere else, or
-- forgets the predicate, and one firm rewrites another's signatory. Nothing in
-- the database would notice; that is the whole difference from every other
-- table here.
--
-- ── WHAT THIS TRIGGER DOES, AND WHAT IT DELIBERATELY DOES NOT ──────────────
--
-- When a request HAS a tenant context — it went through `withTenant`, which is
-- every app-facing path — it may update ONE row: its own. Anything else is
-- refused by the database rather than trusted to the predicate.
--
-- When there is NO tenant context, nothing changes. That is provisioning:
-- creating a firm, and the platform suspending one, both run with no context
-- because they are acts ABOVE tenant, and they reach this table through
-- `/internal` with a capability-bearing key rather than a session. Refusing
-- those would be refusing the only writes that legitimately name a firm they
-- are not inside.
--
-- So this cannot break a correct write and cannot be satisfied by a wrong one.
-- It is a backstop, not a new rule: it enforces exactly what the application
-- code already intends, one layer down, where a mistake in that code cannot
-- reach past it.
--
-- The trigger runs as the definer so it reads the same settings the statement
-- does; `current_setting(..., true)` returns NULL rather than raising when the
-- setting has never been set, which is the ordinary provisioning case.
SET ROLE bib_owner;

CREATE OR REPLACE FUNCTION tenancy.tenant_row_is_own()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  scope text := current_setting('app.tenant_id', true);
BEGIN
  -- No scope means provisioning — see the header. Empty string is the same
  -- thing said differently: `set_config` writes '' where a caller passed
  -- nothing, and treating it as a real id would refuse every provisioning
  -- write instead of allowing it.
  IF scope IS NULL OR scope = '' THEN
    RETURN NEW;
  END IF;

  IF NEW.id::text <> scope THEN
    RAISE EXCEPTION
      'a request scoped to firm % may not write firm %', scope, NEW.id
      USING ERRCODE = '42501';
  END IF;

  -- The id itself is not a field anybody may move. Changing it would carry the
  -- row out from under the check that just passed.
  IF OLD.id <> NEW.id THEN
    RAISE EXCEPTION 'a firm''s id is not writable' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_row_is_own
  BEFORE UPDATE ON tenancy.tenant
  FOR EACH ROW EXECUTE FUNCTION tenancy.tenant_row_is_own();

COMMENT ON FUNCTION tenancy.tenant_row_is_own() IS
  'The RLS backstop this global table cannot have. Inside a tenant-scoped request a firm may update only its own row; with no scope set (provisioning, via /internal) nothing is restricted.';

RESET ROLE;
