-- Reverse of 0310. The estimates go with the columns, which is what reverting
-- this migration means; nothing else depends on them.

SET ROLE bib_owner;

ALTER TABLE crm.lead
  DROP CONSTRAINT IF EXISTS lead_estimated_value_currency_iso4217_chk,
  DROP CONSTRAINT IF EXISTS lead_estimated_value_pair_chk,
  DROP CONSTRAINT IF EXISTS lead_estimated_value_nonneg_chk;

ALTER TABLE crm.lead
  DROP COLUMN IF EXISTS estimated_value_currency,
  DROP COLUMN IF EXISTS estimated_value;

RESET ROLE;
