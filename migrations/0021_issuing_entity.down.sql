-- Reverses 0021, newest object first. Re-runnable.
--
-- Note what going back costs: every document loses the record of which of the
-- firm's own entities issued it, and that fact exists nowhere else — it was a
-- snapshot, deliberately, so it cannot be re-derived from the preference rows
-- that are dropped here alongside it.
SET ROLE bib_owner;

DROP INDEX IF EXISTS crm.idx_el_issuing_entity;
DROP INDEX IF EXISTS crm.idx_proposal_issuing_entity;

ALTER TABLE crm.engagement_letter
  DROP CONSTRAINT IF EXISTS el_issuing_entity_tenant_fkey,
  DROP COLUMN IF EXISTS issuing_entity_party_id;

ALTER TABLE crm.proposal
  DROP CONSTRAINT IF EXISTS proposal_issuing_entity_tenant_fkey,
  DROP COLUMN IF EXISTS issuing_entity_party_id;

DROP TABLE IF EXISTS crm.firm_entity_preference;

RESET ROLE;
