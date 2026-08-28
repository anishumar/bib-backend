-- Reverses 0011, newest object first. The composite-key targets added to
-- crm.lead and config.version go too, but only after the tables that reference
-- them — and neither is dropped IF the other migrations that use that pattern
-- added it, which is why each names its own constraint.
SET ROLE bib_owner;

DROP TABLE IF EXISTS crm.proposal_line;
DROP TABLE IF EXISTS crm.proposal;

ALTER TABLE config.version DROP CONSTRAINT IF EXISTS version_id_tenant_key;
ALTER TABLE crm.lead       DROP CONSTRAINT IF EXISTS lead_id_tenant_key;

RESET ROLE;
