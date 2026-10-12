-- 0389 down · the AI reader's call record. Dropping it drops the record of what
-- was spent and on which model; nothing else references it.

SET ROLE bib_owner;

DROP POLICY IF EXISTS extraction_usage_isolation ON fin.extraction_usage;
DROP INDEX IF EXISTS fin.idx_extraction_usage_item;
DROP INDEX IF EXISTS fin.idx_extraction_usage_month;
DROP TABLE IF EXISTS fin.extraction_usage;

RESET ROLE;
