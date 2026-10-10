-- 0381 down · FinCompliance's intake and the per-firm switch. Drops the `fin`
-- schema whole: nothing outside it references a row in it.

SET ROLE bib_owner;

DROP POLICY IF EXISTS intake_item_isolation ON fin.intake_item;
DROP INDEX IF EXISTS fin.idx_intake_item_recent;
DROP TABLE IF EXISTS fin.intake_item;

ALTER TABLE tenancy.tenant DROP COLUMN IF EXISTS fin_enabled_since;

RESET ROLE;

DROP SCHEMA IF EXISTS fin;
