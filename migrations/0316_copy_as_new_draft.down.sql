-- 0316 down · forget which drafts were copied from which documents. The drafts
-- themselves stay; only the pointer goes.

SET ROLE bib_owner;

DROP INDEX IF EXISTS crm.el_copied_from_idx;
ALTER TABLE crm.engagement_letter
  DROP CONSTRAINT IF EXISTS el_not_copied_from_itself_chk,
  DROP CONSTRAINT IF EXISTS el_copied_from_fk,
  DROP COLUMN IF EXISTS copied_from_id;

DROP INDEX IF EXISTS crm.proposal_copied_from_idx;
ALTER TABLE crm.proposal
  DROP CONSTRAINT IF EXISTS proposal_not_copied_from_itself_chk,
  DROP CONSTRAINT IF EXISTS proposal_copied_from_fk,
  DROP COLUMN IF EXISTS copied_from_id;

RESET ROLE;
