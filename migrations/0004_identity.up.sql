-- 0004 · identity: credentials, sessions, magic links (T1.7)
--
-- Until now the only "authentication" was a trusted x-user-id header — safe
-- locally, and explicitly marked as never shippable. This migration gives the
-- system a real one: a credential the user proves, exchanged for a session the
-- server can validate and revoke.
--
-- ALL THREE TABLES ARE GLOBAL — no tenant_id, no RLS — and that is a
-- consequence of ADR-02, not an oversight:
--
--   GLOBAL: a login belongs to a PERSON, never to a firm. One human has one
--   credential and one session no matter how many tenants they belong to, and
--   the session is the thing that DECIDES which tenant is active. Gating it on
--   app.tenant_id would be circular — the row that resolves the tenant cannot
--   be filtered by the tenant it has not resolved yet. The tenant wall applies
--   one step later, when the resolved session sets app.tenant_id for the
--   request. They sit beside user_account, which is global for the same reason.
--
-- Nothing here stores a usable secret. Passwords are scrypt-hashed with their
-- parameters and salt encoded alongside; session and magic-link tokens are
-- stored as SHA-256 of the value handed to the client. A dump of these tables
-- yields nothing anyone can log in with.

SET ROLE bib_owner;

-- ── credential ── what the user proves. Separate from user_account on purpose:
-- an account is identity, a credential is one WAY to prove it. A user with no
-- row here (invited, never set a password) is a normal state, not an error, and
-- signs in by magic link.
CREATE TABLE tenancy.credential (
  user_id       uuid PRIMARY KEY REFERENCES tenancy.user_account(id),
  -- Self-describing: 'scrypt$N$r$p$salt$hash'. The cost parameters travel WITH
  -- the hash, so they can be raised later without invalidating existing
  -- passwords — the next successful login re-hashes at the new cost.
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_credential_updated_at BEFORE UPDATE ON tenancy.credential
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- ── session ── a proven login, with an expiry and a revocation switch.
--
-- Server-side and opaque, deliberately, rather than a self-contained JWT: a
-- session that cannot be revoked before it expires is a liability in a product
-- where a firm dismisses staff and expects access to stop THAT AFTERNOON. One
-- indexed lookup per request buys "revoke now" and is worth it.
--
-- active_tenant_id / active_audience are the org-switch: which of the user's
-- memberships this session is currently acting under. Null while the user has
-- not chosen (more than one membership); set at login when there is exactly one.
CREATE TABLE tenancy.session (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES tenancy.user_account(id),
  -- SHA-256 of the token the client holds. The token itself is never stored,
  -- so this column cannot be replayed as a credential.
  token_hash       text NOT NULL UNIQUE,
  active_tenant_id uuid REFERENCES tenancy.tenant(id),
  active_audience  text CHECK (active_audience IN ('STAFF', 'CLIENT_PORTAL')),
  issued_at        timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- A tenant without an audience (or the reverse) is a half-resolved context —
  -- exactly the state the four gates cannot reason about. Both or neither.
  CONSTRAINT session_context_paired_chk
    CHECK ((active_tenant_id IS NULL) = (active_audience IS NULL))
);
CREATE TRIGGER trg_session_updated_at BEFORE UPDATE ON tenancy.session
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();
CREATE INDEX idx_session_user ON tenancy.session (user_id);
-- Sweeping expired sessions is a maintenance job run as the owner; the app
-- role has no DELETE and revokes by setting revoked_at (soft delete only).
CREATE INDEX idx_session_expires ON tenancy.session (expires_at);

-- ── magic_link ── a single-use, short-lived token emailed to a proven address.
-- It is how an invited user signs in before they have a password (T6.5's portal
-- invite is the same mechanism with purpose='invite').
CREATE TABLE tenancy.magic_link (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES tenancy.user_account(id),
  token_hash  text NOT NULL UNIQUE,          -- SHA-256, same reasoning as session
  purpose     text NOT NULL CHECK (purpose IN ('login', 'invite')),
  expires_at  timestamptz NOT NULL,
  -- Single use: set on redemption. A consumed link is dead even before expiry,
  -- which is what makes a forwarded or logged email survivable.
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_magic_link_updated_at BEFORE UPDATE ON tenancy.magic_link
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();
CREATE INDEX idx_magic_link_user ON tenancy.magic_link (user_id);

RESET ROLE;

-- Grants. The tenancy schema's default privileges (0001) already extend
-- SELECT/INSERT/UPDATE to bib_app for tables the owner creates; stated here
-- explicitly so this migration reads on its own. No DELETE: revocation and
-- consumption are UPDATEs, and soft delete is the house rule.
GRANT SELECT, INSERT, UPDATE ON tenancy.credential TO bib_app;
GRANT SELECT, INSERT, UPDATE ON tenancy.session    TO bib_app;
GRANT SELECT, INSERT, UPDATE ON tenancy.magic_link TO bib_app;
