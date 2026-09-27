-- Reverses 0086. Re-runnable.
--
-- REFUSES WHILE ANYTHING IS DELETED. Dropping the two columns would bring every
-- deleted lead, draft proposal and draft letter back into the lists and the
-- counts, silently — and the rebuilt one-open-lead index could then fail to
-- build over a client holding a deleted open lead beside a live one. What to do
-- with rows somebody deliberately deleted is a decision, not a side effect of a
-- rollback, so this stops and says so rather than choosing. `to_jsonb(...) ->>`
-- reads the column without naming it, so a second run, after the columns are
-- gone, counts nothing and carries on. It counts AS THE OWNER, which row-level
-- security does not filter: under any other role an unset tenant would hide
-- every row and the count would say nothing is deleted.
SET ROLE bib_owner;

DO $$
DECLARE
  deleted bigint;
BEGIN
  SELECT (SELECT count(*) FROM crm.lead l WHERE to_jsonb(l) ->> 'deleted_at' IS NOT NULL)
       + (SELECT count(*) FROM crm.proposal p WHERE to_jsonb(p) ->> 'deleted_at' IS NOT NULL)
       + (SELECT count(*) FROM crm.engagement_letter e WHERE to_jsonb(e) ->> 'deleted_at' IS NOT NULL)
    INTO deleted;
  IF deleted > 0 THEN
    RAISE EXCEPTION
      '0086 cannot be reversed: % leads, proposals or letters are deleted, and dropping deleted_at would put every one of them back in the lists. Decide what happens to them first.',
      deleted;
  END IF;
END $$;

-- 0036's archive guard, every reference counted again.
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

  -- THE SIXTH, and the reason this migration exists. Nullable on a proposal
  -- line — a prospect may hold no company yet, and Incorporation is a line
  -- whose entity is its own output — so this finds only the lines that actually
  -- name somebody.
  IF EXISTS (SELECT 1 FROM crm.proposal_line
             WHERE tenant_id = NEW.tenant_id AND entity_party_id = NEW.id) THEN
    refs := array_append(refs, 'a proposal line');
  END IF;

  IF EXISTS (SELECT 1 FROM crm.engagement_letter
             WHERE tenant_id = NEW.tenant_id AND party_id = NEW.id) THEN
    refs := array_append(refs, 'an engagement letter');
  END IF;

  IF EXISTS (SELECT 1 FROM crm.engagement_letter_line
             WHERE tenant_id = NEW.tenant_id AND entity_party_id = NEW.id) THEN
    refs := array_append(refs, 'an engagement letter line');
  END IF;

  -- Both of the engagement's references, because both are "an engagement points
  -- at this party": party_id is who is billed, entity_party_id is who the work
  -- is delivered to (0018), and either one rendering an archived counterparty
  -- is the case this refusal exists for.
  IF EXISTS (SELECT 1 FROM crm.engagement
             WHERE tenant_id = NEW.tenant_id
               AND (party_id = NEW.id OR entity_party_id = NEW.id)) THEN
    refs := array_append(refs, 'an engagement');
  END IF;

  IF cardinality(refs) > 0 THEN
    -- DETAIL carries the machine-readable list, so the adapter can name what
    -- refers to the party in a domain error instead of re-deriving it.
    RAISE EXCEPTION
      'party % cannot be archived: it is still referenced by %. Archiving only hides a party from pickers and lists — close or supersede what points at it first. Nothing here deletes anything: the party is permanent and its history is the ledger.',
      NEW.id, array_to_string(refs, ', ')
      USING ERRCODE = 'restrict_violation',
            DETAIL  = array_to_string(refs, ', ');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_el_quote_not_deleted ON crm.engagement_letter;
DROP FUNCTION IF EXISTS crm.refuse_reference_to_deleted_proposal();
DROP TRIGGER IF EXISTS trg_proposal_lead_not_deleted ON crm.proposal;
DROP FUNCTION IF EXISTS crm.refuse_reference_to_deleted_lead();

DROP TRIGGER IF EXISTS trg_el_guard_deletion ON crm.engagement_letter;
DROP FUNCTION IF EXISTS crm.refuse_bad_letter_deletion();
DROP TRIGGER IF EXISTS trg_proposal_guard_deletion ON crm.proposal;
DROP FUNCTION IF EXISTS crm.refuse_bad_proposal_deletion();
DROP TRIGGER IF EXISTS trg_lead_guard_deletion ON crm.lead;
DROP FUNCTION IF EXISTS crm.refuse_bad_lead_deletion();

-- The two indexes as 0022 and 0030 left them.
DROP INDEX IF EXISTS crm.el_one_live_successor_per_letter;
CREATE UNIQUE INDEX el_one_live_successor_per_letter
  ON crm.engagement_letter (tenant_id, supersedes_id)
  WHERE supersedes_id IS NOT NULL AND status <> 'withdrawn';

DROP INDEX IF EXISTS crm.lead_one_open_per_party;
CREATE UNIQUE INDEX lead_one_open_per_party ON crm.lead (party_id)
  WHERE stage NOT IN ('converted', 'lost', 'abandoned');

ALTER TABLE crm.engagement_letter
  DROP CONSTRAINT IF EXISTS el_deleted_by_needs_at_chk,
  DROP COLUMN IF EXISTS deleted_by_user_id,
  DROP COLUMN IF EXISTS deleted_at;

ALTER TABLE crm.proposal
  DROP CONSTRAINT IF EXISTS proposal_deleted_by_needs_at_chk,
  DROP COLUMN IF EXISTS deleted_by_user_id,
  DROP COLUMN IF EXISTS deleted_at;

ALTER TABLE crm.lead
  DROP CONSTRAINT IF EXISTS lead_deleted_by_needs_at_chk,
  DROP COLUMN IF EXISTS deleted_by_user_id,
  DROP COLUMN IF EXISTS deleted_at;

RESET ROLE;
