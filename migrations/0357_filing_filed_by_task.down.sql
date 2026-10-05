-- 0357 down · forget which task filed a filing. `filed_on` stays as it is.
SET ROLE bib_owner;

DROP INDEX IF EXISTS delivery.idx_obligation_instance_filed_by;

ALTER TABLE delivery.obligation_instance
  DROP CONSTRAINT IF EXISTS obligation_instance_filed_by_needs_filed;
ALTER TABLE delivery.obligation_instance
  DROP CONSTRAINT IF EXISTS obligation_instance_filed_by_work_item_fkey;
ALTER TABLE delivery.obligation_instance
  DROP COLUMN IF EXISTS filed_by_work_item_id;

RESET ROLE;
