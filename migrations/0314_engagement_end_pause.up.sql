-- 0314 · An engagement can end, pause and resume; a client can then be put away (V2.3, V2.4)
--
-- ── THE GAP ────────────────────────────────────────────────────────────────
--
-- 0017 wrote five statuses and an `ends_on` column, and only `active` (and
-- `pending_advance`) was ever written. So a client who left kept getting a job
-- and a task every month, its filings kept coming, and it stayed in MRR. And a
-- client with any history could never be archived: the archive guard (0035,
-- 0086) counted EVERY lead, proposal, letter and engagement that ever named it,
-- closed or not.
--
-- ── ENDING (the user's decisions, 2026-09-28) ──────────────────────────────
--
-- An end records the LAST DAY the firm serves (`ends_on`, inclusive) and a
-- reason, and the status changes at once: `completed`, or `cancelled` when the
-- end falls before the work ever began. So MRR (`status = 'active'`) drops on
-- the day the end is recorded. The work up to the end date still happens: the
-- recurring spawn and the compliance generator both keep reading an ended
-- engagement for the periods that START on or before `ends_on`, and never
-- after. Ending withdraws the engagement's untouched upcoming filings for
-- periods after the end, through the SAME code as removing a filing from a
-- service (T6.16), with its own reason `engagement_ended`.
--
-- The reason is prose a person wrote about a client, so it lives on this row
-- and never in the ledger (`engagement.ended` carries ids, days and counts).
--
-- ── PAUSING ────────────────────────────────────────────────────────────────
--
-- `paused`: no new jobs and no new filings (both read `active`), filings
-- already on the calendar stay. Resuming records `resumed_on`: a recurring
-- period that ENDED before that day is never spawned (it fell inside the
-- pause), and the generator back-fills any filing that fell due meanwhile, as
-- missed when its date has passed, for a partner to decide.
--
-- ── THE WALLS ARE ONE-DIRECTIONAL, ON PURPOSE ──────────────────────────────
--
-- An end record (ended_at, reason, the actor) implies an ended status; a pause
-- stamp implies `paused`. Not the reverse: rows written `cancelled` by the
-- integration tests' own fixtures (and any written before this migration) have
-- no end record, and a two-way CHECK would refuse this migration on them.
--
-- ── THE ARCHIVE GUARD COUNTS ONLY WHAT IS STILL LIVE ───────────────────────
--
-- Decided 2026-09-28: a client may be archived once nothing is live. An open
-- lead (new, contacted, qualified), a proposal or letter in progress (draft,
-- sent), and an engagement that is pending its advance, active or paused still
-- refuse. Converted, lost and abandoned leads, answered or expired proposals,
-- signed and withdrawn letters, and ended engagements do not. The flow for a
-- client who leaves: end each engagement, then archive. "You cannot put away a
-- client you are still working with" is unchanged; what changed is that
-- history no longer counts as working with them.

SET ROLE bib_owner;

-- ── crm.engagement ─────────────────────────────────────────────────────────

ALTER TABLE crm.engagement
  ADD COLUMN end_reason        text,
  ADD COLUMN ended_at          timestamptz,
  ADD COLUMN ended_by_user_id  uuid,
  ADD COLUMN paused_at         timestamptz,
  ADD COLUMN paused_by_user_id uuid,
  ADD COLUMN resumed_on        date;

-- By id alone: tenancy.user_account is GLOBAL (ADR-02) and has no tenant_id.
ALTER TABLE crm.engagement
  ADD CONSTRAINT engagement_ended_by_fkey
    FOREIGN KEY (ended_by_user_id) REFERENCES tenancy.user_account (id),
  ADD CONSTRAINT engagement_paused_by_fkey
    FOREIGN KEY (paused_by_user_id) REFERENCES tenancy.user_account (id);

ALTER TABLE crm.engagement
  -- The three halves of an end are written together or not at all.
  ADD CONSTRAINT engagement_end_whole CHECK (
    (ended_at IS NULL AND end_reason IS NULL AND ended_by_user_id IS NULL)
    OR (ended_at IS NOT NULL AND end_reason IS NOT NULL AND ends_on IS NOT NULL)
  ),
  -- An end record implies an ended status (see above for why not the reverse).
  ADD CONSTRAINT engagement_end_means_ended CHECK (
    ended_at IS NULL OR status IN ('completed', 'cancelled')
  ),
  ADD CONSTRAINT engagement_end_reason_said CHECK (
    end_reason IS NULL OR length(btrim(end_reason)) BETWEEN 1 AND 1000
  ),
  ADD CONSTRAINT engagement_pause_means_paused CHECK (
    paused_at IS NULL OR status = 'paused'
  ),
  ADD CONSTRAINT engagement_paused_by_needs_stamp CHECK (
    paused_by_user_id IS NULL OR paused_at IS NOT NULL
  );

COMMENT ON COLUMN crm.engagement.ends_on IS
  'The LAST day the firm serves this engagement (inclusive), set when it is ended (0314). Periods starting after it get no job and no filing.';
COMMENT ON COLUMN crm.engagement.end_reason IS
  'Why it ended, in the firm''s words (0314). Prose about a client: kept here, never in the ledger.';
COMMENT ON COLUMN crm.engagement.resumed_on IS
  'The firm''s day it last resumed after a pause (0314). A recurring period that ended before it is never spawned.';

-- ── delivery.obligation_instance: a second reason to withdraw ──────────────

ALTER TABLE delivery.obligation_instance
  DROP CONSTRAINT obligation_instance_withdrawn_reason_check;
ALTER TABLE delivery.obligation_instance
  ADD CONSTRAINT obligation_instance_withdrawn_reason_check
    CHECK (withdrawn_reason IN ('service_unlinked', 'engagement_ended'));

-- ── The archive guard: only what is still live refuses ─────────────────────
--
-- 0086's body, each probe narrowed to the LIVE states named above. Same
-- trigger, same firing conditions, same probe order.

CREATE OR REPLACE FUNCTION core.refuse_archive_with_references() RETURNS trigger AS $$
DECLARE
  refs text[] := '{}';
BEGIN
  IF EXISTS (SELECT 1 FROM crm.lead
             WHERE tenant_id = NEW.tenant_id AND party_id = NEW.id
               AND deleted_at IS NULL
               AND stage IN ('new', 'contacted', 'qualified')) THEN
    refs := array_append(refs, 'an open lead');
  END IF;

  IF EXISTS (SELECT 1 FROM crm.proposal
             WHERE tenant_id = NEW.tenant_id AND party_id = NEW.id
               AND deleted_at IS NULL
               AND status IN ('draft', 'sent')) THEN
    refs := array_append(refs, 'a proposal in progress');
  END IF;

  IF EXISTS (SELECT 1 FROM crm.proposal_line pl
             JOIN crm.proposal p ON p.id = pl.proposal_id
             WHERE pl.tenant_id = NEW.tenant_id AND pl.entity_party_id = NEW.id
               AND p.deleted_at IS NULL
               AND p.status IN ('draft', 'sent')) THEN
    refs := array_append(refs, 'a line of a proposal in progress');
  END IF;

  IF EXISTS (SELECT 1 FROM crm.engagement_letter
             WHERE tenant_id = NEW.tenant_id AND party_id = NEW.id
               AND deleted_at IS NULL
               AND status IN ('draft', 'sent')) THEN
    refs := array_append(refs, 'an engagement letter in progress');
  END IF;

  IF EXISTS (SELECT 1 FROM crm.engagement_letter_line ll
             JOIN crm.engagement_letter l ON l.id = ll.engagement_letter_id
             WHERE ll.tenant_id = NEW.tenant_id AND ll.entity_party_id = NEW.id
               AND l.deleted_at IS NULL
               AND l.status IN ('draft', 'sent')) THEN
    refs := array_append(refs, 'a line of an engagement letter in progress');
  END IF;

  IF EXISTS (SELECT 1 FROM crm.engagement
             WHERE tenant_id = NEW.tenant_id
               AND (party_id = NEW.id OR entity_party_id = NEW.id)
               AND status IN ('pending_advance', 'active', 'paused')) THEN
    refs := array_append(refs, 'a live engagement');
  END IF;

  IF cardinality(refs) > 0 THEN
    RAISE EXCEPTION
      'party % cannot be archived: it still has %. End its engagements and close or withdraw what is in progress first. Archiving only hides a party from pickers and lists: it is permanent and its history is the ledger.',
      NEW.id, array_to_string(refs, ', ')
      USING ERRCODE = 'restrict_violation',
            DETAIL  = array_to_string(refs, ', ');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

RESET ROLE;
