-- 0313 down · membership by routing again: a company is the firm's while a
-- preference row names it (0306's definition).
--
-- REFUSES rather than destroys (0311's and 0312's arrangement). A company that
-- is the firm's only by membership, with no country routed to it, would stop
-- being the firm's the moment this runs: it would vanish from every picker and
-- show up among the CLIENTS. The down stops and says what to do instead.
--
-- Safe to run by hand and twice: the refusal comes before any change, and
-- everything is dropped with IF EXISTS.

SET ROLE bib_owner;

DO $$
DECLARE
  orphaned int;
BEGIN
  IF to_regclass('crm.firm_entity') IS NOT NULL THEN
    EXECUTE $q$
      SELECT count(*) FROM crm.firm_entity m
      WHERE m.retired_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM core.organization o
                         WHERE o.tenant_id = m.tenant_id AND o.party_id = m.party_id
                           AND o.is_firm_self)
        AND NOT EXISTS (SELECT 1 FROM crm.firm_entity_preference f
                         WHERE f.tenant_id = m.tenant_id
                           AND f.firm_entity_party_id = m.party_id)
    $q$ INTO orphaned;
    IF orphaned > 0 THEN
      RAISE EXCEPTION
        '0313 down: % of the firm''s companies are the firm''s only by membership, with no country routed to them. Without 0313 they would stop being the firm''s and appear among the clients. Route a country to each (Our companies), then run this again.',
        orphaned;
    END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION crm.is_firm_entity(p_tenant uuid, p_party uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM core.organization o
                  WHERE o.tenant_id = p_tenant AND o.party_id = p_party AND o.is_firm_self)
      OR EXISTS (SELECT 1 FROM crm.firm_entity_preference f
                  WHERE f.tenant_id = p_tenant AND f.firm_entity_party_id = p_party)
$$;

COMMENT ON FUNCTION crm.is_firm_entity(uuid, uuid) IS
  'One of the firm''s own companies: the firm itself, or an issuer a firm_entity_preference row names (0306). The one definition the invoice picker, the services and the triggers share.';

DROP TRIGGER IF EXISTS trg_firm_entity_preference_member ON crm.firm_entity_preference;
DROP FUNCTION IF EXISTS crm.routed_party_is_a_firm_entity();
DROP TABLE IF EXISTS crm.firm_entity;

RESET ROLE;
