-- 0305 · An archived client gains no NEW lead, proposal, letter or engagement
--
-- ── THE HOLE 0035 NAMED AND LEFT ───────────────────────────────────────────
--
-- 0035 refuses to ARCHIVE a party while a lead, a proposal, an engagement
-- letter, a letter line's entity or an engagement points at it. That is a rule
-- about the moment of archiving and nothing more: afterwards, nothing stopped
-- a NEW reference. Lead capture resolves a party by PAN, phone or email without
-- asking whether it was put away, so a web enquiry carrying an archived
-- client's PAN attached a fresh lead to it, and a proposal or a letter could be
-- drafted against it by id. The invariant the schema held was "nothing pointed
-- at it at the instant it was archived", which is weaker than "an archived
-- party is one the firm is not working with".
--
-- ── THE DECISION (Shrestha, 2026-09-25) ────────────────────────────────────
--
-- REFUSE, and make restoring an explicit act. Quietly un-archiving on capture
-- was the other defensible answer and it was not taken: putting a client away
-- is a decision somebody made, and a web form must not be able to undo it
-- without a person seeing that it happened. Restoring already exists — the
-- client page's Restore button, `POST /parties/{id}/unarchive`, its own ledger
-- verb — so the refusal has somewhere to send people.
--
-- ── WHY A TRIGGER AS WELL AS THE SERVICES ──────────────────────────────────
--
-- 0035's own argument, pointed the other way. The services now refuse with a
-- sentence naming the client (lead capture, drafting a proposal or a letter,
-- adding a line whose entity is archived); that is what a person is TOLD. The
-- trigger is the wall under it, for the writers that are not those services:
-- an import, an agent, a script, a psql session. 0035 put its refusal on
-- `core.party` because the act it guards is archiving; the act guarded here is
-- CREATING A REFERENCE, so the triggers sit on the referring tables — the end
-- 0035 rightly called wrong for its own question.
--
-- ── WHAT IT COVERS, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────
--
-- The six references a firm's commercial work makes to a client or an entity:
-- `crm.lead.party_id`, `crm.proposal.party_id`, `crm.proposal_line
-- .entity_party_id`, `crm.engagement_letter.party_id`, `crm.engagement_letter
-- _line.entity_party_id`, and both of `crm.engagement`'s. The engagement's is
-- belt-and-braces — it is written only by signing a letter whose lines were
-- checked when they were added — and costs nothing.
--
-- NOT the firm's own issuing entity, and NOT the person a letter is addressed
-- to care-of: neither is the client, and neither was part of what was asked.
-- NOT the delivery tables either (work items, obligations, asks) — those are
-- produced FROM an engagement, which already cannot exist for an archived
-- party.
--
-- It fires on INSERT, and on UPDATE only when the reference itself CHANGES, so
-- an ordinary edit of a row that already existed fires nothing. The probe is a
-- primary-key lookup on `core.party`.

SET ROLE bib_owner;

CREATE OR REPLACE FUNCTION core.refuse_reference_to_archived_party() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  i      integer;
  col    text;
  ref    uuid;
  before uuid;
BEGIN
  FOR i IN 0 .. TG_NARGS - 1 LOOP
    col := TG_ARGV[i];
    ref := (to_jsonb(NEW) ->> col)::uuid;
    CONTINUE WHEN ref IS NULL;
    IF TG_OP = 'UPDATE' THEN
      before := (to_jsonb(OLD) ->> col)::uuid;
      CONTINUE WHEN ref IS NOT DISTINCT FROM before;
    END IF;
    -- The id, never the name: this message reaches a server log, and a
    -- client's name is theirs to have erased.
    IF EXISTS (SELECT 1 FROM core.party
               WHERE id = ref AND tenant_id = NEW.tenant_id AND archived_at IS NOT NULL) THEN
      RAISE EXCEPTION
        'party % is archived, so a new %.% may not name it; restore the party first',
        ref, TG_TABLE_SCHEMA, TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE TRIGGER lead_not_to_archived_party
  BEFORE INSERT OR UPDATE OF party_id ON crm.lead
  FOR EACH ROW EXECUTE FUNCTION core.refuse_reference_to_archived_party('party_id');

CREATE TRIGGER proposal_not_to_archived_party
  BEFORE INSERT OR UPDATE OF party_id ON crm.proposal
  FOR EACH ROW EXECUTE FUNCTION core.refuse_reference_to_archived_party('party_id');

CREATE TRIGGER proposal_line_not_to_archived_party
  BEFORE INSERT OR UPDATE OF entity_party_id ON crm.proposal_line
  FOR EACH ROW EXECUTE FUNCTION core.refuse_reference_to_archived_party('entity_party_id');

CREATE TRIGGER engagement_letter_not_to_archived_party
  BEFORE INSERT OR UPDATE OF party_id ON crm.engagement_letter
  FOR EACH ROW EXECUTE FUNCTION core.refuse_reference_to_archived_party('party_id');

CREATE TRIGGER engagement_letter_line_not_to_archived_party
  BEFORE INSERT OR UPDATE OF entity_party_id ON crm.engagement_letter_line
  FOR EACH ROW EXECUTE FUNCTION core.refuse_reference_to_archived_party('entity_party_id');

CREATE TRIGGER engagement_not_to_archived_party
  BEFORE INSERT OR UPDATE OF party_id, entity_party_id ON crm.engagement
  FOR EACH ROW EXECUTE FUNCTION
    core.refuse_reference_to_archived_party('party_id', 'entity_party_id');

COMMENT ON FUNCTION core.refuse_reference_to_archived_party() IS
  'Refuses a NEW reference to an archived core.party from the commercial tables (0305). The archive-time refusal is 0035''s; this is the other direction.';

RESET ROLE;
