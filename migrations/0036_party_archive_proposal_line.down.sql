-- Reverses 0036. Re-runnable.
--
-- There is no object to drop — 0036 replaced a function body — so the reversal
-- is to put 0035's five-probe body back, without the proposal-line probe.
-- CREATE OR REPLACE is idempotent, and downs run newest-first, so 0035's down
-- takes the function away afterwards if the whole feature is being unwound.
SET ROLE bib_owner;

CREATE OR REPLACE FUNCTION core.refuse_archive_with_references() RETURNS trigger AS $$
DECLARE
  refs text[] := '{}';
BEGIN
  IF EXISTS (SELECT 1 FROM crm.lead
             WHERE tenant_id = NEW.tenant_id AND party_id = NEW.id) THEN
    refs := array_append(refs, 'a lead');
  END IF;

  IF EXISTS (SELECT 1 FROM crm.proposal
             WHERE tenant_id = NEW.tenant_id AND party_id = NEW.id) THEN
    refs := array_append(refs, 'a proposal');
  END IF;

  IF EXISTS (SELECT 1 FROM crm.engagement_letter
             WHERE tenant_id = NEW.tenant_id AND party_id = NEW.id) THEN
    refs := array_append(refs, 'an engagement letter');
  END IF;

  IF EXISTS (SELECT 1 FROM crm.engagement_letter_line
             WHERE tenant_id = NEW.tenant_id AND entity_party_id = NEW.id) THEN
    refs := array_append(refs, 'an engagement letter line');
  END IF;

  IF EXISTS (SELECT 1 FROM crm.engagement
             WHERE tenant_id = NEW.tenant_id
               AND (party_id = NEW.id OR entity_party_id = NEW.id)) THEN
    refs := array_append(refs, 'an engagement');
  END IF;

  IF cardinality(refs) > 0 THEN
    RAISE EXCEPTION
      'party % cannot be archived: it is still referenced by %. Archiving only hides a party from pickers and lists — close or supersede what points at it first. Nothing here deletes anything: the party is permanent and its history is the ledger.',
      NEW.id, array_to_string(refs, ', ')
      USING ERRCODE = 'restrict_violation',
            DETAIL  = array_to_string(refs, ', ');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

RESET ROLE;
