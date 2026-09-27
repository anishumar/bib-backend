-- 0311 down · 0051's rule back: a note only on a task nobody has.
--
-- REFUSES rather than destroys (0309's arrangement). A task the owner rule put
-- on a Key Manager's or the signing partner's desk carries the note saying
-- why, and the CHECK this restores refuses exactly those rows. Clearing the
-- notes here would silently take away the only sentence telling that person
-- the task is theirs to hand out, so the down stops and says what to do.
--
-- Safe to run by hand and twice (the 0067 lesson): the refusal comes before
-- any change, and the constraint is dropped by name before it is added.

SET ROLE bib_owner;

DO $$
DECLARE
  noted int;
BEGIN
  SELECT count(*) INTO noted
  FROM delivery.work_item
  WHERE assignee_user_id IS NOT NULL AND assignment_note IS NOT NULL;
  IF noted > 0 THEN
    RAISE EXCEPTION
      '0311 down: % task(s) sit on a fallback owner''s desk with the note saying why. The rule this restores refuses them. Hand them out first (moving a task by hand clears its note), then run this again.',
      noted;
  END IF;
END $$;

ALTER TABLE delivery.work_item
  DROP CONSTRAINT IF EXISTS work_item_note_only_when_unassigned;
ALTER TABLE delivery.work_item
  ADD CONSTRAINT work_item_note_only_when_unassigned CHECK (
    assignee_user_id IS NULL OR assignment_note IS NULL
  );

RESET ROLE;
