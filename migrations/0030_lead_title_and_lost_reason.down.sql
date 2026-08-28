-- Reverse of 0030, newest object first.
--
-- IT REFUSES rather than collapsing `abandoned` into `lost`, which is the only
-- other way this down could run once a firm has used the stage. Collapsing them
-- destroys precisely the signal 0030 exists to create — after the down, a
-- FOLLOW-UP problem and a PRICING problem are the same row again and no record
-- anywhere says which any of them was. A migration that quietly loses the fact
-- it was written to capture is worse than one that stops and says so.
--
-- `title` and `lost_reason` go with the columns, as a down does. That is data
-- loss and it is what "revert this migration" means; the refusal above is not
-- about losing data but about losing it INVISIBLY, as a value that still looks
-- correct.

SET ROLE bib_owner;

DO $$
DECLARE
  abandoned_count bigint;
BEGIN
  SELECT count(*) INTO abandoned_count FROM crm.lead WHERE stage = 'abandoned';

  IF abandoned_count > 0 THEN
    RAISE EXCEPTION
      'reverting migration 0030 would leave % lead(s) at stage ''abandoned'', which the restored lead_stage_check does not permit. Do NOT move them to ''lost'': ''abandoned'' means the prospect went quiet (a FOLLOW-UP problem) and ''lost'' means they chose somebody else (a PRICING problem), and 0030 exists because those are different rows. Decide what each of these leads actually was, UPDATE crm.lead SET stage = ... for each one with the reason recorded elsewhere first, then run this down again.',
      abandoned_count
      USING ERRCODE = 'restrict_violation';
  END IF;
END $$;

ALTER TABLE crm.lead
  DROP CONSTRAINT IF EXISTS lead_lost_reason_present_chk,
  DROP CONSTRAINT IF EXISTS lead_lost_reason_scope_chk,
  DROP CONSTRAINT IF EXISTS lead_title_present_chk;

DROP INDEX IF EXISTS crm.lead_one_open_per_party;
CREATE UNIQUE INDEX lead_one_open_per_party ON crm.lead (party_id)
  WHERE stage NOT IN ('converted', 'lost');

ALTER TABLE crm.lead DROP CONSTRAINT IF EXISTS lead_closed_when_terminal_chk;
ALTER TABLE crm.lead
  ADD CONSTRAINT lead_closed_when_terminal_chk CHECK (
    (stage IN ('converted', 'lost')     AND closed_at IS NOT NULL) OR
    (stage NOT IN ('converted', 'lost') AND closed_at IS NULL)
  );

ALTER TABLE crm.lead DROP CONSTRAINT IF EXISTS lead_stage_check;
ALTER TABLE crm.lead
  ADD CONSTRAINT lead_stage_check CHECK (
    stage IN ('new', 'contacted', 'qualified', 'converted', 'lost')
  );

ALTER TABLE crm.lead
  DROP COLUMN IF EXISTS lost_reason,
  DROP COLUMN IF EXISTS title;

RESET ROLE;
