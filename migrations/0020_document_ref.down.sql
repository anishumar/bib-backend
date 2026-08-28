-- Reverses 0020, newest object first. Re-runnable.
--
-- Note what going back costs: every reference already handed out is dropped,
-- and re-applying 0020 starts the series again from 0001 — so a document whose
-- number a client is holding would be reissued to a different document. That is
-- the honest reading of "undo the document reference", and it is why this down
-- exists for a development database and nowhere else.
SET ROLE bib_owner;

ALTER TABLE crm.engagement_letter
  DROP CONSTRAINT IF EXISTS el_ref_tenant_key,
  DROP CONSTRAINT IF EXISTS el_ref_shape_chk,
  DROP COLUMN IF EXISTS ref;

ALTER TABLE crm.proposal
  DROP CONSTRAINT IF EXISTS proposal_ref_tenant_key,
  DROP CONSTRAINT IF EXISTS proposal_ref_shape_chk,
  DROP COLUMN IF EXISTS ref;

DROP TABLE IF EXISTS crm.document_ref_series;

RESET ROLE;
