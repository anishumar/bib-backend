-- 0330 down · drops the task notes and the maker's review note. Destroys what
-- people wrote in them, which is the honest meaning of taking this back.
SET ROLE bib_owner;

DROP TABLE IF EXISTS delivery.work_item_note;

ALTER TABLE delivery.work_item_approval
  DROP CONSTRAINT IF EXISTS work_item_approval_request_note_is_text;
ALTER TABLE delivery.work_item_approval
  DROP COLUMN IF EXISTS request_note;

RESET ROLE;
