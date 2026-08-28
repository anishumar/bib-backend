-- 0005 · P2 master configuration registry — the versioned-config spine (T2.5)
--
-- "A new service is a config row." The point of this table pair is that the
-- things a firm changes weekly — which services it sells, what its roles are
-- called and what they may do — stop being code and become data the firm owns.
--
-- The whole difficulty is VERSIONING, and specifically PINNING. A running job
-- must keep reading the template version it started on: edit a workflow in
-- flight and you have silently rewritten every job already walking it, which is
-- how a filing ends up following steps nobody approved. So a version, once
-- published, is FROZEN — enforced by a trigger here rather than trusted to the
-- application — and a consumer that must not move stores the version's id and
-- reads that row forever, including after it has been archived.
--
-- Two tables, on purpose:
--   entry    the THING being configured, (tenant, kind, key): 'the GST filing
--            service', 'the partner role'. One stable identity across versions,
--            so a pin and a live read are talking about the same thing.
--   version  what that thing SAID at a point in time. Immutable once published.
--
-- ONE SPINE, SEVERAL KINDS. This pass ships the two kinds that have consumers
-- waiting — 'service' (the catalogue T2.2 quotes from) and 'role' (which
-- replaces the hardcoded permission matrix). Workflow templates and rule packs
-- become two more kinds when T2.7 and T4.3 actually read them, and they need no
-- new versioning machinery. That is why T2.5 lands before the lanes split.
--
-- The body is jsonb and NOT a set of typed columns. Each kind has its own shape,
-- the shapes grow as their consumers land, and typed columns would mean a
-- migration every time a firm's catalogue gains a field. The shapes are instead
-- validated at the door, per kind, in domain/config/model.ts — a body that does
-- not satisfy its kind is refused before it is written, not discovered later.

CREATE SCHEMA IF NOT EXISTS config AUTHORIZATION bib_owner;
REVOKE ALL ON SCHEMA config FROM PUBLIC;
GRANT USAGE ON SCHEMA config TO bib_app;

SET ROLE bib_owner;

-- ── entry ── the configured thing. kind is a CLOSED set and mirrors
-- ConfigKind in the domain: a kind with no body validator would accept
-- anything, so adding one is a code change, reviewed, and this CHECK is the
-- database's half of that agreement.
CREATE TABLE config.entry (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenancy.tenant(id),
  kind       text NOT NULL CHECK (kind IN ('service', 'role')),
  key        text NOT NULL,          -- the firm's own handle: 'gst-filing', 'partner'
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- UNIQUE SCOPE: per (tenant, kind), never global. Two firms may both call a
  -- service 'gst-filing' and both call a role 'partner' — that is the entire
  -- point of the registry. One firm may not have two of either.
  UNIQUE (tenant_id, kind, key)
);
CREATE TRIGGER trg_config_entry_updated_at BEFORE UPDATE ON config.entry
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- ── version ── what the entry said, at a version number. A draft is working
-- state and freely editable; publishing freezes it forever.
CREATE TABLE config.version (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenancy.tenant(id),
  entry_id     uuid NOT NULL REFERENCES config.entry(id),
  version      integer NOT NULL CHECK (version > 0),
  status       text NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'published', 'archived')),
  body         jsonb NOT NULL,
  published_at timestamptz,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- The three states, and the timestamps each one must and must not carry. A
  -- row claiming to be published with no published_at would make "what was in
  -- force on 31 March" unanswerable, which is the question this table exists
  -- to answer.
  CONSTRAINT version_status_dates_chk CHECK (
    (status = 'draft'     AND published_at IS NULL     AND archived_at IS NULL) OR
    (status = 'published' AND published_at IS NOT NULL AND archived_at IS NULL) OR
    (status = 'archived'  AND published_at IS NOT NULL AND archived_at IS NOT NULL)
  ),

  -- UNIQUE SCOPE: per entry, not per tenant and not global. Version numbers
  -- count within one configured thing — 'gst-filing' at v3 alongside
  -- 'roc-annual' at v1 is the ordinary state of a catalogue.
  UNIQUE (entry_id, version)
);
CREATE TRIGGER trg_config_version_updated_at BEFORE UPDATE ON config.version
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- UNIQUE SCOPE: at most ONE published version per entry, at any moment.
-- Partial, so any number of drafts and archived versions may sit beside it.
-- Without this, "the published version of the partner role" is a question with
-- two answers and the permission check picks one arbitrarily.
CREATE UNIQUE INDEX config_version_one_published ON config.version (entry_id)
  WHERE status = 'published';

-- Listing an entry's history, newest first.
CREATE INDEX idx_config_version_entry ON config.version (entry_id, version DESC);

-- THE FREEZE. A published version's content can never change, because
-- something may be pinned to it: a job that started on v2 must read the same
-- v2 tomorrow. A trigger rather than a grant, for the same reason the ledger
-- uses one — a grant stops the application, a trigger also stops the 2 a.m.
-- psql session and the owner role.
--
-- What IS still allowed on a published row: archiving it (status +
-- archived_at), and updated_at moving. Everything else is refused.
CREATE OR REPLACE FUNCTION config.refuse_frozen_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A draft never took effect and nothing can be pinned to it, so deleting
    -- one is harmless. A published version may be somebody's pin, and there is
    -- no way to know from here whether it is.
    IF OLD.status = 'draft' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION
      'config.version %/v% is % and cannot be deleted: a running job may be pinned to it. Publish a replacement instead.',
      OLD.entry_id, OLD.version, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Drafts are working state: edit them freely until they are published.
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF NEW.body         IS DISTINCT FROM OLD.body
     OR NEW.version      IS DISTINCT FROM OLD.version
     OR NEW.entry_id     IS DISTINCT FROM OLD.entry_id
     OR NEW.tenant_id    IS DISTINCT FROM OLD.tenant_id
     OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION
      'config.version %/v% is published and frozen: anything pinned to it must still read what it read yesterday. Publish a new version instead of editing this one.',
      OLD.entry_id, OLD.version
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'published' AND NEW.status NOT IN ('published', 'archived') THEN
    RAISE EXCEPTION
      'config.version %/v% is published; the only state it may move to is archived, not %.',
      OLD.entry_id, OLD.version, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'archived' AND NEW.status <> 'archived' THEN
    RAISE EXCEPTION
      'config.version %/v% is archived, and archiving is final. Publish a new version to change what is in force.',
      OLD.entry_id, OLD.version
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_config_version_freeze
  BEFORE UPDATE OR DELETE ON config.version
  FOR EACH ROW EXECUTE FUNCTION config.refuse_frozen_change();

-- TRUNCATE fires no row triggers, and truncating this table would destroy
-- every pin at once. bib_app has no TRUNCATE grant; this covers everyone else.
CREATE OR REPLACE FUNCTION config.refuse_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'config.version holds the versions other rows are pinned to; TRUNCATE would strand every one of them.'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_config_version_no_truncate
  BEFORE TRUNCATE ON config.version
  FOR EACH STATEMENT EXECUTE FUNCTION config.refuse_truncate();

-- THE TENANT WALL, identical in shape to 0001/0002/0003. A firm's catalogue and
-- its role definitions are its own. NULLIF(..., '') keeps the unset/pooled
-- placeholder case NULL → predicate false → zero rows, never a cast error.
ALTER TABLE config.entry   ENABLE ROW LEVEL SECURITY;
ALTER TABLE config.version ENABLE ROW LEVEL SECURITY;

CREATE POLICY config_entry_isolation ON config.entry
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY config_version_isolation ON config.version
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

RESET ROLE;

-- Grants. No DELETE: nothing in the product deletes a config row, and the
-- freeze trigger above is the backstop for the rows that must never go.
GRANT SELECT, INSERT, UPDATE ON config.entry   TO bib_app;
GRANT SELECT, INSERT, UPDATE ON config.version TO bib_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bib_owner IN SCHEMA config
  GRANT SELECT, INSERT, UPDATE ON TABLES TO bib_app;

-- ── Seeding the role registry for the firms that already exist ──────────────
--
-- From here the role matrix IS these rows. There is deliberately NO fallback to
-- a built-in table when a tenant has none, because both available fallbacks are
-- worse than seeding:
--
--   • Merge with product defaults, and a firm can never REMOVE a permission —
--     it silently keeps one it believes it took away.
--   • Use the defaults only when a tenant has no rows at all, and the first
--     role a firm publishes locks out everyone holding any other role.
--
-- So every tenant owns a complete set from the moment it exists: new firms are
-- seeded inside createTenant (usecase/tenancy/service.ts) in the same call that
-- creates them, and the firms that already exist are seeded right here. A
-- tenant with no role rows is then a real fault, and gate 3 says so loudly
-- (UNKNOWN_ROLE) rather than quietly granting something.
--
-- These bodies are the same four roles as DEFAULT_ROLES in
-- src/domain/authz/model.ts. tests/config/seed-parity.test.ts parses the
-- literal below and fails if the two ever drift, so a permission added in the
-- code but not here cannot ship. Keep it on one line.
WITH seed(roles) AS (VALUES ('{"partner":{"label":"Partner","permissions":["party:read","party:write","ledger:read","config:read","tenant:admin"]},"manager":{"label":"Manager","permissions":["party:read","party:write","ledger:read","config:read"]},"associate":{"label":"Associate","permissions":["party:read","party:write","config:read"]},"client_contact":{"label":"Client contact","permissions":[]}}'::jsonb)),  -- @default-roles-seed
role_row AS (
  SELECT e.key AS key, e.value AS body FROM seed, jsonb_each(seed.roles) AS e
),
new_entry AS (
  INSERT INTO config.entry (tenant_id, kind, key)
  SELECT t.id, 'role', r.key
  FROM tenancy.tenant t CROSS JOIN role_row r
  RETURNING id, tenant_id, key
)
INSERT INTO config.version (tenant_id, entry_id, version, status, body, published_at)
SELECT ne.tenant_id, ne.id, 1, 'published', r.body, now()
FROM new_entry ne JOIN role_row r ON r.key = ne.key;
