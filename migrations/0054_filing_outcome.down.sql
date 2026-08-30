-- Down for 0054. Newest-first, IF EXISTS throughout.
--
-- Dropping the two flags takes the writer for `filed_on` with them, so the
-- product returns to the state T3.2 shipped in: a calendar whose rows say
-- "Pending" forever. The `filed_on` dates already written are NOT cleared —
-- they are true facts about work that really was finished, and 0053 still holds
-- the column. Re-applying this migration re-seeds the flags, and its backfill
-- picks up anything that closed while they were gone.

SET ROLE bib_owner;

DROP INDEX IF EXISTS delivery.idx_obligation_state_one_filed;

ALTER TABLE delivery.obligation_state DROP CONSTRAINT IF EXISTS obligation_state_filed_chk;
ALTER TABLE delivery.obligation_state DROP COLUMN IF EXISTS is_filed;

ALTER TABLE delivery.work_item_state DROP CONSTRAINT IF EXISTS work_item_state_success_chk;
ALTER TABLE delivery.work_item_state DROP COLUMN IF EXISTS is_success;

RESET ROLE;
