-- 0385 down · An ask goes back to having no due day and no template.
--
-- REFUSED while any ask was raised by a template, and the check runs FIRST, so
-- a refusal destroys nothing (0067's lesson about a down that fails halfway).
-- Such an ask has no person in `raised_by`, and 0063's NOT NULL cannot be put
-- back over it; inventing a raiser to make the down succeed would put a name on
-- an act nobody performed. Withdraw or re-raise those asks by hand first if a
-- rollback is really meant. A due day a PERSON typed is simply lost: the ask
-- itself, its prompt and its answers stay.

SET ROLE bib_owner;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM delivery.client_ask WHERE raised_by IS NULL) THEN
    RAISE EXCEPTION '0385 down: asks raised by a request template have no person in raised_by, and 0063''s NOT NULL cannot be restored over them; deal with those asks before rolling back';
  END IF;
END $$;

DROP INDEX IF EXISTS delivery.client_ask_template_item_once;

ALTER TABLE delivery.client_ask
  DROP CONSTRAINT IF EXISTS client_ask_raised_by_person_or_template,
  DROP CONSTRAINT IF EXISTS client_ask_template_all_or_none,
  DROP CONSTRAINT IF EXISTS client_ask_template_version_fkey,
  DROP COLUMN IF EXISTS request_item_key,
  DROP COLUMN IF EXISTS request_template_key,
  DROP COLUMN IF EXISTS request_template_version_id,
  DROP COLUMN IF EXISTS due_on,
  ALTER COLUMN raised_by SET NOT NULL;

RESET ROLE;
