-- Reverse of 0007. Dropping the schema takes crm.lead, its policy, trigger and
-- indexes with it; the unique key added to core.party goes separately, since
-- that table is not ours to drop.
DROP SCHEMA IF EXISTS crm CASCADE;

SET ROLE bib_owner;
ALTER TABLE core.party DROP CONSTRAINT IF EXISTS party_id_tenant_key;
RESET ROLE;
