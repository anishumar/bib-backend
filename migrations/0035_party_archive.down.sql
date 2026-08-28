-- Reverses 0035, newest object first. Re-runnable.
--
-- The trigger goes before the function it calls, and the function before the
-- column its WHEN clause reads. Dropping the column would take the trigger with
-- it anyway; doing it in order means each statement says what it means.
SET ROLE bib_owner;

DROP TRIGGER IF EXISTS trg_party_archive_guard ON core.party;
DROP FUNCTION IF EXISTS core.refuse_archive_with_references();
DROP INDEX IF EXISTS core.idx_party_tenant_live;

ALTER TABLE core.party DROP COLUMN IF EXISTS archived_at;

RESET ROLE;
