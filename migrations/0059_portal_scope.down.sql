-- Reverses 0059. Dropped in the reverse order of creation: the policy needs the
-- function, and the function is what the policy is written in terms of.
SET ROLE bib_owner;

DROP POLICY IF EXISTS work_item_portal_scope ON delivery.work_item;

DROP FUNCTION IF EXISTS crm.portal_sees(uuid);

DROP TABLE IF EXISTS crm.portal_access;

DROP INDEX IF EXISTS tenancy.membership_party_audience_key;

ALTER TABLE tenancy.membership
  DROP CONSTRAINT IF EXISTS membership_id_tenant_key;

ALTER TABLE tenancy.membership
  DROP CONSTRAINT IF EXISTS membership_party_fkey;

ALTER TABLE tenancy.membership
  DROP COLUMN IF EXISTS party_id;

RESET ROLE;
