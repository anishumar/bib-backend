-- Reverses 0018, newest object first. Re-runnable.
SET ROLE bib_owner;

DROP INDEX IF EXISTS crm.idx_engagement_entity;
DROP INDEX IF EXISTS crm.idx_el_line_entity;
DROP INDEX IF EXISTS crm.idx_proposal_line_entity;

ALTER TABLE crm.engagement
  DROP CONSTRAINT IF EXISTS engagement_entity_tenant_fkey,
  DROP COLUMN IF EXISTS entity_party_id;

ALTER TABLE crm.engagement_letter_line
  DROP CONSTRAINT IF EXISTS el_line_entity_tenant_fkey,
  DROP COLUMN IF EXISTS entity_party_id;

ALTER TABLE crm.proposal_line
  DROP CONSTRAINT IF EXISTS proposal_line_entity_tenant_fkey,
  DROP COLUMN IF EXISTS entity_party_id;

RESET ROLE;
