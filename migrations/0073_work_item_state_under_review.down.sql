-- Down for 0073.
--
-- Nothing can be refused here, which is the difference between this and 0072's
-- down: that one NARROWED a vocabulary and had to delete rows before tightening
-- a CHECK. This drops a column, and every rule that reads it goes with the code
-- being rolled back.
--
-- WHAT IS LOST IS WHICH STATE THE FIRM CHOSE, and that is honest rather than
-- recoverable: the states themselves are untouched, every work item stays
-- exactly where it is, and re-applying 0073 simply starts from "no firm has
-- said" — which is the same place every firm starts anyway. Nothing is
-- rewritten to look like something it was not.
--
-- The index goes first: dropping the column would take it anyway, but naming it
-- means a partial re-run leaves nothing dangling.
SET ROLE bib_owner;

DROP INDEX IF EXISTS delivery.idx_work_item_state_one_under_review;

ALTER TABLE delivery.work_item_state
  DROP CONSTRAINT IF EXISTS work_item_state_review_is_not_blocked,
  DROP CONSTRAINT IF EXISTS work_item_state_review_is_not_terminal,
  DROP CONSTRAINT IF EXISTS work_item_state_review_is_not_initial,
  DROP CONSTRAINT IF EXISTS work_item_state_review_is_active;

ALTER TABLE delivery.work_item_state
  DROP COLUMN IF EXISTS is_under_review;

RESET ROLE;
