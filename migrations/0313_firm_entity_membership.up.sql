-- 0313 · A company is the firm's by MEMBERSHIP, not by routing (T6.18 S6)
--
-- ── THE HOLE ────────────────────────────────────────────────────────────────
--
-- Until now "one of the firm's own companies" (`crm.is_firm_entity`, 0306) was
-- the firm itself, OR a company some `crm.firm_entity_preference` row named.
-- A preference row is the firm's ROUTING rule — which company issues to
-- clients in which country — so membership was a side effect of routing. The
-- Our companies screen found what that costs (S5, 2026-09-28): point a
-- company's LAST country at another company and it stops being the firm's. It
-- vanished from Our companies, Brand, the prose tabs and every "Issued by"
-- picker, and nothing on any screen could bring it back. The screen was made
-- to refuse that move; this is the durable fix.
--
-- ── THE SHAPE ───────────────────────────────────────────────────────────────
--
-- `crm.firm_entity` says which parties ARE the firm's companies, one row each,
-- whatever the routing says. Tenant-scoped under RLS, keyed to the party by a
-- composite (id, tenant_id) key like every reference here, and never deleted:
-- a company the firm stops using is RETIRED (`retired_at`), because documents
-- it issued still name it. Nothing retires one yet; the column is here so the
-- day something does, it is a stamp and not a DELETE.
--
-- Three writers keep it whole, so nothing that made a company the firm's
-- before this migration stops doing so:
--   1. the backfill below: the firm itself and every company a preference row
--      names today;
--   2. `POST /firm-entities`, which writes the row in the same transaction as
--      the organization, its registration and its first country;
--   3. a trigger on `crm.firm_entity_preference`: naming a party in a routing
--      row makes it a member (the older path — `smoke.sh` and the test
--      fixtures create a company that way), and moving the routing AWAY never
--      unmakes it.
--
-- `crm.is_firm_entity` then reads membership instead of routing. The firm
-- itself stays in by `is_firm_self` as well, so a firm whose own row somehow
-- missed the backfill is still its own company.

SET ROLE bib_owner;

CREATE TABLE crm.firm_entity (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenancy.tenant(id),
  party_id    uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- A company the firm no longer issues from. Never a DELETE: its documents
  -- still name it.
  retired_at  timestamptz,

  CONSTRAINT firm_entity_tenant_key UNIQUE (id, tenant_id),
  -- One row per company per firm: membership is a yes or a no.
  CONSTRAINT firm_entity_one_per_party UNIQUE (tenant_id, party_id),
  CONSTRAINT firm_entity_party_fkey
    FOREIGN KEY (party_id, tenant_id) REFERENCES core.party (id, tenant_id)
);

ALTER TABLE crm.firm_entity ENABLE ROW LEVEL SECURITY;
CREATE POLICY firm_entity_isolation ON crm.firm_entity
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- No portal policy: no portal route reads which companies are the firm's.

-- SELECT and INSERT, and UPDATE of the retirement stamp only. Never DELETE.
GRANT SELECT, INSERT ON crm.firm_entity TO bib_app;
REVOKE UPDATE ON crm.firm_entity FROM bib_app;
GRANT UPDATE (retired_at) ON crm.firm_entity TO bib_app;

COMMENT ON TABLE crm.firm_entity IS
  'Which parties are the firm''s OWN companies (T6.18 S6, 0313): one row each, whatever the routing rule (crm.firm_entity_preference) says, retired by retired_at and never deleted. crm.is_firm_entity reads it.';

-- ── The backfill: everybody who is the firm's today ─────────────────────────

INSERT INTO crm.firm_entity (tenant_id, party_id)
SELECT o.tenant_id, o.party_id FROM core.organization o WHERE o.is_firm_self
UNION
SELECT f.tenant_id, f.firm_entity_party_id FROM crm.firm_entity_preference f
ON CONFLICT (tenant_id, party_id) DO NOTHING;

-- ── Routing a country to a party makes it a member ──────────────────────────
--
-- AFTER, so the preference row is already valid (its own key to the party has
-- passed) before membership is written from it. The insert runs as the caller,
-- inside the caller's tenant, so the RLS check above is the ordinary one.

CREATE FUNCTION crm.routed_party_is_a_firm_entity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO crm.firm_entity (tenant_id, party_id)
  VALUES (NEW.tenant_id, NEW.firm_entity_party_id)
  ON CONFLICT (tenant_id, party_id) DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_firm_entity_preference_member
  AFTER INSERT OR UPDATE OF firm_entity_party_id ON crm.firm_entity_preference
  FOR EACH ROW EXECUTE FUNCTION crm.routed_party_is_a_firm_entity();

-- ── Membership, not routing ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION crm.is_firm_entity(p_tenant uuid, p_party uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM core.organization o
                  WHERE o.tenant_id = p_tenant AND o.party_id = p_party AND o.is_firm_self)
      OR EXISTS (SELECT 1 FROM crm.firm_entity m
                  WHERE m.tenant_id = p_tenant AND m.party_id = p_party
                    AND m.retired_at IS NULL)
$$;

COMMENT ON FUNCTION crm.is_firm_entity(uuid, uuid) IS
  'One of the firm''s own companies: the firm itself, or a live member of crm.firm_entity (0313; before it, a party a routing row named, 0306). The one definition the invoice picker, the services and the triggers share.';

RESET ROLE;
