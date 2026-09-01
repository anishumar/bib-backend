-- Reverses 0061 — and it can FAIL, on purpose.
--
-- Putting `valid_to > valid_from` back refuses any empty-range row the firm has
-- since recorded, which is a grant somebody revoked on the day they made it.
-- There is no honest value to rewrite those to: moving the date forward would
-- restate that the person HAD access for a day, which is the thing this
-- migration exists to stop saying. So the rollback fails loudly against real
-- data rather than quietly editing an access record.
SET ROLE bib_owner;

ALTER TABLE crm.portal_access
  DROP CONSTRAINT portal_access_dates_ordered;

ALTER TABLE crm.portal_access
  ADD CONSTRAINT portal_access_dates_ordered CHECK (
    valid_to IS NULL OR valid_to > valid_from
  );

RESET ROLE;
