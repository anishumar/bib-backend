-- Reverses 0032. Newest first, IF EXISTS throughout. Drops nothing shared.
SET ROLE bib_owner;

DROP TRIGGER IF EXISTS trg_dunning_action_freeze ON crm.dunning_action;
DROP TRIGGER IF EXISTS trg_dunning_action_updated ON crm.dunning_action;
DROP TABLE IF EXISTS crm.dunning_action;
DROP FUNCTION IF EXISTS crm.refuse_dunning_reversal();

ALTER TABLE crm.invoice DROP CONSTRAINT IF EXISTS invoice_id_tenant_key;

RESET ROLE;
