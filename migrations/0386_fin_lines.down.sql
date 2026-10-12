-- 0386 down · FinCompliance's reads, lines and sheet layouts. Newest first;
-- nothing outside `fin` references a row in them.

SET ROLE bib_owner;

DROP TRIGGER IF EXISTS trg_transaction_line_proposed_frozen ON fin.transaction_line;
DROP FUNCTION IF EXISTS fin.refuse_proposed_change();

DROP POLICY IF EXISTS transaction_line_isolation ON fin.transaction_line;
DROP TABLE IF EXISTS fin.transaction_line;

DROP POLICY IF EXISTS read_isolation ON fin.read;
DROP INDEX IF EXISTS fin.idx_read_status;
DROP INDEX IF EXISTS fin.idx_read_recent;
DROP TABLE IF EXISTS fin.read;

DROP POLICY IF EXISTS source_format_isolation ON fin.source_format;
DROP INDEX IF EXISTS fin.idx_source_format_lookup;
DROP INDEX IF EXISTS fin.source_format_learnt_once;
DROP TABLE IF EXISTS fin.source_format;

ALTER TABLE fin.intake_item DROP CONSTRAINT IF EXISTS intake_item_version_key;

RESET ROLE;
