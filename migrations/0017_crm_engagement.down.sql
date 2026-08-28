-- Reverses 0017, newest object first.
SET ROLE bib_owner;

DROP TABLE IF EXISTS crm.engagement;
DROP TABLE IF EXISTS crm.engagement_letter_clause;
DROP TABLE IF EXISTS crm.engagement_letter_line;
DROP TABLE IF EXISTS crm.engagement_letter;
DROP FUNCTION IF EXISTS crm.refuse_signed_child_change();
DROP FUNCTION IF EXISTS crm.refuse_signed_change();

ALTER TABLE crm.proposal DROP CONSTRAINT IF EXISTS proposal_id_tenant_key;

RESET ROLE;
