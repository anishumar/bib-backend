-- Reverses 0026. Newest first, IF EXISTS throughout. Drops nothing shared.
SET ROLE bib_owner;

DROP TRIGGER IF EXISTS trg_territory_rule_updated ON crm.territory_rule;
DROP TABLE IF EXISTS crm.territory_rule;

ALTER TABLE crm.lead DROP CONSTRAINT IF EXISTS lead_jurisdiction_code_chk;
ALTER TABLE crm.lead DROP COLUMN IF EXISTS jurisdiction;

RESET ROLE;
