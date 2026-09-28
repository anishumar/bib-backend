-- 0314 down · engagements that never end, and the archive guard that counts all history.
--
-- REFUSES rather than destroys (0311's arrangement). An engagement that has
-- been ended or paused, or a filing withdrawn because its engagement ended,
-- would be misread by the schema before 0314: an ended engagement would lose
-- the day it ends and the reason, and a withdrawn filing would carry a reason
-- the old CHECK does not allow. The down stops and says what to do instead.

SET ROLE bib_owner;

DO $$
DECLARE
  ended int;
  paused int;
  withdrawn int;
BEGIN
  SELECT count(*) INTO ended FROM crm.engagement WHERE ended_at IS NOT NULL;
  SELECT count(*) INTO paused FROM crm.engagement WHERE paused_at IS NOT NULL OR resumed_on IS NOT NULL;
  SELECT count(*) INTO withdrawn FROM delivery.obligation_instance
   WHERE withdrawn_reason = 'engagement_ended';
  IF ended + paused + withdrawn > 0 THEN
    RAISE EXCEPTION
      '0314 down refused: % ended engagement(s), % paused or resumed, % filing(s) withdrawn by an end. Rolling back would drop the end day, the reason and the pause record. Fix forward with a new migration instead.',
      ended, paused, withdrawn;
  END IF;
END $$;

-- The archive guard as 0086 left it: every reference counts, closed or not.
CREATE OR REPLACE FUNCTION core.refuse_archive_with_references() RETURNS trigger AS $$
DECLARE
  refs text[] := '{}';
BEGIN
  IF EXISTS (SELECT 1 FROM crm.lead
             WHERE tenant_id = NEW.tenant_id AND party_id = NEW.id
               AND deleted_at IS NULL) THEN
    refs := array_append(refs, 'a lead');
  END IF;

  IF EXISTS (SELECT 1 FROM crm.proposal
             WHERE tenant_id = NEW.tenant_id AND party_id = NEW.id
               AND deleted_at IS NULL) THEN
    refs := array_append(refs, 'a proposal');
  END IF;

  IF EXISTS (SELECT 1 FROM crm.proposal_line pl
             JOIN crm.proposal p ON p.id = pl.proposal_id
             WHERE pl.tenant_id = NEW.tenant_id AND pl.entity_party_id = NEW.id
               AND p.deleted_at IS NULL) THEN
    refs := array_append(refs, 'a proposal line');
  END IF;

  IF EXISTS (SELECT 1 FROM crm.engagement_letter
             WHERE tenant_id = NEW.tenant_id AND party_id = NEW.id
               AND deleted_at IS NULL) THEN
    refs := array_append(refs, 'an engagement letter');
  END IF;

  IF EXISTS (SELECT 1 FROM crm.engagement_letter_line ll
             JOIN crm.engagement_letter l ON l.id = ll.engagement_letter_id
             WHERE ll.tenant_id = NEW.tenant_id AND ll.entity_party_id = NEW.id
               AND l.deleted_at IS NULL) THEN
    refs := array_append(refs, 'an engagement letter line');
  END IF;

  IF EXISTS (SELECT 1 FROM crm.engagement
             WHERE tenant_id = NEW.tenant_id
               AND (party_id = NEW.id OR entity_party_id = NEW.id)) THEN
    refs := array_append(refs, 'an engagement');
  END IF;

  IF cardinality(refs) > 0 THEN
    RAISE EXCEPTION
      'party % cannot be archived: it is still referenced by %. Archiving only hides a party from pickers and lists — close or supersede what points at it first, or delete it if it was entered by mistake. Nothing here deletes the party: it is permanent and its history is the ledger.',
      NEW.id, array_to_string(refs, ', ')
      USING ERRCODE = 'restrict_violation',
            DETAIL  = array_to_string(refs, ', ');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE delivery.obligation_instance
  DROP CONSTRAINT obligation_instance_withdrawn_reason_check;
ALTER TABLE delivery.obligation_instance
  ADD CONSTRAINT obligation_instance_withdrawn_reason_check
    CHECK (withdrawn_reason IN ('service_unlinked'));

ALTER TABLE crm.engagement
  DROP CONSTRAINT IF EXISTS engagement_paused_by_needs_stamp,
  DROP CONSTRAINT IF EXISTS engagement_pause_means_paused,
  DROP CONSTRAINT IF EXISTS engagement_end_reason_said,
  DROP CONSTRAINT IF EXISTS engagement_end_means_ended,
  DROP CONSTRAINT IF EXISTS engagement_end_whole,
  DROP CONSTRAINT IF EXISTS engagement_paused_by_fkey,
  DROP CONSTRAINT IF EXISTS engagement_ended_by_fkey;

ALTER TABLE crm.engagement
  DROP COLUMN IF EXISTS resumed_on,
  DROP COLUMN IF EXISTS paused_by_user_id,
  DROP COLUMN IF EXISTS paused_at,
  DROP COLUMN IF EXISTS ended_by_user_id,
  DROP COLUMN IF EXISTS ended_at,
  DROP COLUMN IF EXISTS end_reason;

COMMENT ON COLUMN crm.engagement.ends_on IS NULL;

RESET ROLE;
