-- 0390 down · Responses go back to having no "on the client's behalf" flag.
--
-- REFUSED while any response was recorded on a client's behalf, and the check
-- runs FIRST so a refusal destroys nothing (0067's lesson about a down that
-- fails halfway). Without the column such a row is a colleague's id in
-- `responded_by` on a response that reads as the CLIENT's own: the firm's
-- screen would say their contact sent it, and the portal would print the
-- colleague's name on the client's page. Rolling that back is a decision about
-- those rows, not something a down should take silently.

SET ROLE bib_owner;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM delivery.client_ask_response WHERE on_behalf) THEN
    RAISE EXCEPTION '0390 down: responses recorded on a client''s behalf would read as the client''s own without on_behalf; deal with those rows before rolling back';
  END IF;
END $$;

DROP POLICY IF EXISTS client_ask_response_on_behalf_firm_only ON delivery.client_ask_response;

ALTER TABLE delivery.client_ask_response
  DROP COLUMN IF EXISTS on_behalf;

RESET ROLE;
