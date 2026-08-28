-- Down for 0024: 0017's function body, restored verbatim.
--
-- WHAT THIS PUTS BACK, stated rather than discovered: the hole. A line or clause
-- of a SIGNED engagement letter can again be moved onto another letter, which
-- removes a term from a signed agreement with no error anywhere. The triggers
-- themselves are 0017's and are not touched — CREATE OR REPLACE swaps the body
-- underneath them, so there is no window in which nothing is enforced.

SET ROLE bib_owner;

CREATE OR REPLACE FUNCTION crm.refuse_signed_child_change() RETURNS trigger AS $$
DECLARE
  parent_status text;
  parent_id uuid;
BEGIN
  parent_id := CASE TG_OP WHEN 'DELETE' THEN OLD.engagement_letter_id
                          ELSE NEW.engagement_letter_id END;
  SELECT status INTO parent_status FROM crm.engagement_letter WHERE id = parent_id;
  IF parent_status = 'signed' THEN
    RAISE EXCEPTION
      'engagement letter % is signed, so its terms are frozen. Supersede it with a new letter.',
      parent_id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION crm.refuse_signed_child_change() IS NULL;

RESET ROLE;
