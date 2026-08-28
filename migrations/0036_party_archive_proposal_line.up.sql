-- 0036 · the sixth reference into core.party — crm.proposal_line.entity_party_id
--
-- WHY THIS IS 0036 AND NOT AN EDIT TO 0035.
--
-- 0035 is applied and committed, so it is frozen; this fixes forward, which is
-- the only way that rule permits. But the more useful answer is why 0035 was
-- wrong, because the reasoning it wrote down was careful and still reached the
-- wrong place.
--
-- 0035 enumerated FIVE references and explicitly declined a sixth,
-- `crm.proposal_line.entity_party_id`, on the grounds that the decision it was
-- implementing had named five and that widening a refusal past what was decided
-- is a product change rather than an implementation detail. That is a good
-- instinct and it produced a bad guard, for two reasons 0035 did not weigh:
--
--   1. IT IS THE SAME FIELD AT AN EARLIER STAGE. `entity_party_id` is one
--      concept — who the work is delivered to (0018) — and it appears on the
--      proposal line, the engagement letter line and the engagement, which are
--      three stages of ONE document chain. 0035 probed the last two and skipped
--      the first. That is not a narrower rule, it is an inconsistent one: the
--      same subsidiary is protected once a letter names it and unprotected
--      while a live quote names it, and nobody can state that rule out loud.
--
--   2. IT IS THE CHEAPEST OF THE SIX. 0035's cost argument was about probe
--      expense, and `idx_proposal_line_entity (tenant_id, entity_party_id)` has
--      existed since 0018 — so this probe is an index hit, cheaper than the
--      `crm.lead` probe 0035 DID include, which has no covering index and scans.
--      The one reference left out was the one that cost least.
--
-- Proven live before this was written: a party named only by a live proposal
-- line archived successfully under 0035.
--
-- Nothing else changes. Same trigger, same firing conditions — `BEFORE UPDATE
-- OF archived_at` with the WHEN clause on the NULL → NOT NULL transition — so
-- an ordinary UPDATE still fires nothing and un-archiving is still never
-- refused. This replaces the function body only, and the enumeration hazard
-- 0035 named is unchanged and now covers all six: ADD A REFERENCE TO
-- core.party, ADD IT TO THIS FUNCTION.
--
-- The probe order follows the document chain — lead, proposal, proposal line,
-- engagement letter, letter line, engagement — because the DETAIL list is read
-- by a person deciding what to close first, and the order it arrives in should
-- be the order the work happened in.

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

RESET ROLE;
