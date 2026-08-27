-- 0001 · tenancy bootstrap
--
-- Creates the tenancy schema and the identity spine. Roles (bib_owner, bib_app)
-- are ensured by cmd/migrate BEFORE this runs — they are cluster-level and need
-- their password injected from config, so they cannot live in a committed SQL
-- file. Everything else that a fresh database needs is here: extensions, the
-- shared updated_at trigger, the three identity tables, and — the point of the
-- whole product — the row-level-security tenant wall on membership.
--
-- Applied by cmd/migrate as a role that can SET ROLE bib_owner (superuser
-- locally; a migration_runner member of bib_owner in prod).

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email

CREATE SCHEMA IF NOT EXISTS tenancy AUTHORIZATION bib_owner;
REVOKE ALL ON SCHEMA tenancy FROM PUBLIC;
GRANT USAGE ON SCHEMA tenancy TO bib_app;

SET ROLE bib_owner;

-- Shared trigger: keeps updated_at honest without the app having to remember.
CREATE OR REPLACE FUNCTION tenancy.set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── tenant ── GLOBAL: the platform's registry of firms. Not tenant-scoped —
-- it IS the set of tenants, managed by the platform, never by a tenant.
CREATE TABLE tenancy.tenant (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE,               -- url-safe handle, lowercase
  name       text NOT NULL,
  status     text NOT NULL DEFAULT 'active'
             CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_tenant_updated_at BEFORE UPDATE ON tenancy.tenant
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- ── user_account ── GLOBAL: identity lives ABOVE tenant (ADR-02). One human,
-- one login, one row — regardless of how many firms they belong to. No
-- tenant_id: a person is not owned by a tenant.
CREATE TABLE tenancy.user_account (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      citext NOT NULL UNIQUE,             -- the global identity key
  status     text NOT NULL DEFAULT 'active'
             CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_user_updated_at BEFORE UPDATE ON tenancy.user_account
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- ── membership ── the join, and the first tenant-scoped table. (user × tenant
-- × audience × role). A user may hold many, across many tenants. audience is a
-- product invariant (closed set); role is the firm's own vocabulary (free
-- text, resolved against config later). commercial_visibility is the orthogonal
-- fee axis — NOT a role.
CREATE TABLE tenancy.membership (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenancy.tenant(id),
  user_id               uuid NOT NULL REFERENCES tenancy.user_account(id),
  audience              text NOT NULL CHECK (audience IN ('STAFF', 'CLIENT_PORTAL')),
  role                  text NOT NULL,
  commercial_visibility boolean NOT NULL DEFAULT false,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, audience)
);
CREATE TRIGGER trg_membership_updated_at BEFORE UPDATE ON tenancy.membership
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();
CREATE INDEX idx_membership_user ON tenancy.membership (user_id);

-- THE TENANT WALL. bib_app is NOBYPASSRLS and never owns these tables, so this
-- policy is enforced for every business query. Two modes, both under RLS:
--   • tenant mode  — business queries after SET LOCAL app.tenant_id
--   • identity mode — org-switch / login reads a user's memberships ACROSS
--                     tenants via SET LOCAL app.user_id (never a tenant bypass)
-- With neither set, current_setting(..., true) is NULL, the predicate is NULL,
-- and zero rows return. The wall holds by default, not by remembering to filter.
-- NULLIF(..., '') is load-bearing, not decorative: under connection pooling a
-- custom GUC that has been touched once leaves an empty-string PLACEHOLDER
-- (not NULL) on that connection, and ''::uuid raises "invalid input syntax".
-- NULLIF turns the unset case back into NULL, so the clause is simply false and
-- the wall holds — instead of the query erroring.
ALTER TABLE tenancy.membership ENABLE ROW LEVEL SECURITY;
CREATE POLICY membership_isolation ON tenancy.membership
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

RESET ROLE;

-- Grants. RLS still applies to bib_app (NOBYPASSRLS, not owner); these grants
-- only decide which verbs are reachable, never which rows.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA tenancy TO bib_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bib_owner IN SCHEMA tenancy
  GRANT SELECT, INSERT, UPDATE ON TABLES TO bib_app;
