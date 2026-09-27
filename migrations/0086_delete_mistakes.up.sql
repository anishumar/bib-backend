-- 0086 · Deleting a lead, a draft proposal or a draft letter made by mistake
--
-- Decided 2026-09-27 (user): something created by mistake can be DELETED while
-- nothing depends on it and it has not left the firm, and a deletion HIDES the
-- row rather than erasing it — "gone from every list, picker and count; the
-- audit log notes who deleted it".
--
-- ── WHY A NEW WORD WAS NEEDED ────────────────────────────────────────────────
--
-- Every way this product puts something away records a BUSINESS OUTCOME: a lead
-- that went nowhere is `lost` or `abandoned` (0007, 0030), a proposal is
-- `rejected` or `expired` (0011), a letter is `withdrawn` (0017). Each is the
-- record of something that happened to a real prospect, and these tables hold
-- no DELETE grant precisely so that record stays — "the pipeline's own history
-- is what makes a conversion rate mean anything" (0007).
--
-- A lead typed in by mistake is none of those. Closing it as `lost` puts a lost
-- deal into the pipeline that never existed — the very number the missing
-- grant protects — and a mistaken draft proposal had no way out at all, because
-- a draft can only become `sent`. What the product had no word for is THERE
-- WAS NO PROSPECT, THERE WAS NO OFFER.
--
-- ── WHY HIDDEN AND NOT ERASED ────────────────────────────────────────────────
--
-- `bib_app` still holds no DELETE on any of the three tables, and
-- tests/lead/pipeline.integration.test.ts still asserts it. Two columns say it
-- instead: `deleted_at` (when) and `deleted_by_user_id` (who, for the page — the
-- ledger's `*.deleted` event is the audit record and names the actor either
-- way). A deleted row:
--
--   * leaves every LIST and everything that COUNTS one — the pipeline, the
--     quotes, the letters, the rotation's desk load, the one-open-lead index,
--     the live-successor index and the archive guard;
--   * still RESOLVES BY ID, and says it was deleted. The ledger holds events
--     against its id for ever (0003 cannot be edited), and a timeline pointing
--     at a row marked deleted is honest where one pointing at nothing is not;
--   * is FINAL, like a withdrawn document link (0302): nothing about it changes
--     again. Bringing one back is a decision nobody has taken, and when it is
--     taken it is a migration relaxing the guards below, on purpose.
--
-- It is the argument the four existing soft deletes already rest on —
-- `removed_at` on a proposal line, a letter line, a document block and a fee
-- group: a thing struck off BEFORE IT WENT OUT. It is widened from a line of a
-- document to the whole document, and to the lead the document would have come
-- from, and no further. `core` still carries no soft delete (G0.3).
--
-- ── WHEN IT IS ALLOWED — one guard per table ────────────────────────────────
--
--   crm.lead               never once `converted` — a won deal is the record of
--                          a win — and never while a LIVE proposal was drafted
--                          from it. A lead already closed `lost` or `abandoned`
--                          may be deleted: that is often exactly how a mistake
--                          was put away while there was nothing else to do. The
--                          service allows it to an administrator only, because
--                          it changes the pipeline's numbers; that half is a
--                          rule about WHO, which a trigger cannot see.
--   crm.proposal           a `draft`, and never while a LIVE letter cites it.
--                          Once sent, the client holds it: it is a document to
--                          answer, not a mistake to delete.
--   crm.engagement_letter  a `draft`. Nothing can depend on a draft letter — an
--                          engagement needs a signature, a signature request
--                          needs a send, and only a SIGNED letter is superseded.
--
-- "Live" means not deleted, so deleting in the right order always works: the
-- letter, then the quote it cites, then the lead the quote came from.
--
-- A deletion changes nothing else about the row in the same statement. Without
-- that, one UPDATE could move a lead to `converted` and delete it at once, and
-- the guard — which reads the row as it WAS — would let it through.
--
-- The service refuses each case first, by name, saying what to delete or close
-- first; these triggers are the wall for the writers that are not the service —
-- an import, an agent, a psql session. `restrict_violation`, as the archive
-- guard (0035) and the signed-letter freeze (0019) raise, and every trigger on
-- `crm.engagement_letter` is NAMED to sort after `trg_el_freeze`: BEFORE
-- triggers fire in name order, and a change to a SIGNED letter must be refused
-- as that (tests/architecture/signed-letter-freeze.integration.test.ts demands
-- `restrict_violation` for every column, these two included).
--
-- ── NOTHING NEW MAY POINT AT A DELETED ROW ──────────────────────────────────
--
-- The other direction, 0305's rule for an archived client: a proposal may not be
-- drafted from a deleted lead, and a letter may not cite a deleted proposal. The
-- services refuse first; these fire only when the reference itself is new or
-- changed, raise `check_violation` as 0305's guard does, and name rows by id,
-- never by title — the message reaches a server log.
--
-- ── THE INDEXES THAT HOLD ONE LIVE ROW ──────────────────────────────────────
--
-- `lead_one_open_per_party` (0007, widened by 0030) and
-- `el_one_live_successor_per_letter` (0022) each allow ONE live row per key. A
-- deleted row is not live: left in, a deleted open lead would stop the firm ever
-- capturing a lead for that client again, and a deleted draft successor would
-- leave a signed letter that could never be replaced. Both are rebuilt with
-- `AND deleted_at IS NULL`, keeping their scope — the lead index per PARTY
-- (party ids are global, so per firm too), the successor index per (tenant,
-- superseded letter). `findOpenForParty` and `findSuccessor` repeat the new
-- predicates exactly, as their comments demand.
--
-- ── AND THE ARCHIVE GUARD (0035, 0036) ──────────────────────────────────────
--
-- A deleted lead, proposal or letter — and a line of a deleted proposal or
-- letter — no longer stops a client being archived. That is the whole change
-- to the guard: which references count as ongoing work in general is a separate
-- decision and is not taken here.

SET ROLE bib_owner;

-- ── The columns ──────────────────────────────────────────────────────────────
--
-- `tenancy.user_account` is GLOBAL (ADR-02), so `deleted_by_user_id` is an
-- id-only reference by design, exactly as `crm.lead.owner_user_id` is; the
-- tenant-key guard asks only about references between tenant-scoped tables.
-- Nullable, with `at` required beside it: the actor is a PERSON whenever the
-- product deletes, and the ledger names whoever it was in every case.

ALTER TABLE crm.lead
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by_user_id uuid REFERENCES tenancy.user_account (id),
  ADD CONSTRAINT lead_deleted_by_needs_at_chk
    CHECK (deleted_by_user_id IS NULL OR deleted_at IS NOT NULL);

COMMENT ON COLUMN crm.lead.deleted_at IS
  'When this lead was DELETED as entered by mistake (0086): out of the pipeline and every count, still readable by id. Not an outcome — lost and abandoned are what happened to a real prospect; this says there was none. Final: a deleted lead never changes again.';
COMMENT ON COLUMN crm.lead.deleted_by_user_id IS
  'Who deleted it, for the page. The ledger''s lead.deleted event is the audit record and names the actor either way.';

ALTER TABLE crm.proposal
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by_user_id uuid REFERENCES tenancy.user_account (id),
  ADD CONSTRAINT proposal_deleted_by_needs_at_chk
    CHECK (deleted_by_user_id IS NULL OR deleted_at IS NOT NULL);

COMMENT ON COLUMN crm.proposal.deleted_at IS
  'When this DRAFT was deleted as made by mistake (0086), before it went out: off the list of quotes, still readable by id. Its reference is not reused — a proposal reference may gap (0020). Final.';
COMMENT ON COLUMN crm.proposal.deleted_by_user_id IS
  'Who deleted it, for the page. The ledger''s proposal.deleted event is the audit record.';

-- ADD COLUMN with no default writes no rows, so no trigger fires and no signed
-- letter is touched. From this moment both columns are inside the signed-letter
-- freeze (0019 compares the whole row), so a signed letter can never be
-- deleted — the same answer the guard below gives, reached independently.
ALTER TABLE crm.engagement_letter
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by_user_id uuid REFERENCES tenancy.user_account (id),
  ADD CONSTRAINT el_deleted_by_needs_at_chk
    CHECK (deleted_by_user_id IS NULL OR deleted_at IS NOT NULL);

COMMENT ON COLUMN crm.engagement_letter.deleted_at IS
  'When this DRAFT was deleted as made by mistake (0086), before it went out for signature: off the list of letters, still readable by id. A letter the client has seen is withdrawn, never deleted. Final.';
COMMENT ON COLUMN crm.engagement_letter.deleted_by_user_id IS
  'Who deleted it, for the page. The ledger''s engagement_letter.deleted event is the audit record.';

-- ── The indexes that hold one live row ──────────────────────────────────────

DROP INDEX crm.lead_one_open_per_party;
CREATE UNIQUE INDEX lead_one_open_per_party ON crm.lead (party_id)
  WHERE stage NOT IN ('converted', 'lost', 'abandoned') AND deleted_at IS NULL;

DROP INDEX crm.el_one_live_successor_per_letter;
CREATE UNIQUE INDEX el_one_live_successor_per_letter
  ON crm.engagement_letter (tenant_id, supersedes_id)
  WHERE supersedes_id IS NOT NULL AND status <> 'withdrawn' AND deleted_at IS NULL;

-- ── The guards: when a deletion is allowed, and that it is final ────────────

CREATE FUNCTION crm.refuse_bad_lead_deletion() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  drafted text;
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION
      'lead % was deleted at % and cannot change. A deleted lead is final; if the prospect is real, capture a new lead.',
      OLD.id, OLD.deleted_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Deleting, and nothing else in the same statement.
  IF (to_jsonb(NEW) - 'deleted_at' - 'deleted_by_user_id' - 'updated_at')
       IS DISTINCT FROM (to_jsonb(OLD) - 'deleted_at' - 'deleted_by_user_id' - 'updated_at') THEN
    RAISE EXCEPTION
      'lead % cannot be deleted and changed in one statement. Deleting records that it was entered by mistake, and nothing else.',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.stage = 'converted' THEN
    RAISE EXCEPTION
      'lead % cannot be deleted: it was converted, and a won deal is the record of a win, not a mistake.',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT string_agg(p.ref, ', ' ORDER BY p.ref) INTO drafted
    FROM crm.proposal p
   WHERE p.tenant_id = NEW.tenant_id AND p.lead_id = NEW.id AND p.deleted_at IS NULL;
  IF drafted IS NOT NULL THEN
    RAISE EXCEPTION
      'lead % cannot be deleted: proposal % was drafted from it. Delete that proposal first if it was a mistake too, or close the lead instead.',
      NEW.id, drafted
      USING ERRCODE = 'restrict_violation', DETAIL = drafted;
  END IF;

  RETURN NEW;
END $$;

-- WHEN: an ordinary update of a live lead fires nothing.
CREATE TRIGGER trg_lead_guard_deletion
  BEFORE UPDATE ON crm.lead
  FOR EACH ROW
  WHEN (OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION crm.refuse_bad_lead_deletion();

CREATE FUNCTION crm.refuse_bad_proposal_deletion() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  citing text;
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION
      'proposal % was deleted at % and cannot change. A deleted draft is final; draft a new proposal if the work is real.',
      OLD.ref, OLD.deleted_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF (to_jsonb(NEW) - 'deleted_at' - 'deleted_by_user_id' - 'updated_at')
       IS DISTINCT FROM (to_jsonb(OLD) - 'deleted_at' - 'deleted_by_user_id' - 'updated_at') THEN
    RAISE EXCEPTION
      'proposal % cannot be deleted and changed in one statement. Deleting records that it was made by mistake, and nothing else.',
      OLD.ref
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION
      'proposal % cannot be deleted: it is %, and only a draft that never went out can be. The client has the document; answer it instead.',
      OLD.ref, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT string_agg(l.ref, ', ' ORDER BY l.ref) INTO citing
    FROM crm.engagement_letter l
   WHERE l.tenant_id = NEW.tenant_id AND l.proposal_id = NEW.id AND l.deleted_at IS NULL;
  IF citing IS NOT NULL THEN
    RAISE EXCEPTION
      'proposal % cannot be deleted: engagement letter % cites it. Delete that draft letter first if it was a mistake too.',
      OLD.ref, citing
      USING ERRCODE = 'restrict_violation', DETAIL = citing;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_proposal_guard_deletion
  BEFORE UPDATE ON crm.proposal
  FOR EACH ROW
  WHEN (OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION crm.refuse_bad_proposal_deletion();

CREATE FUNCTION crm.refuse_bad_letter_deletion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION
      'engagement letter % was deleted at % and cannot change. A deleted draft is final; draft a new letter if the engagement is real.',
      OLD.ref, OLD.deleted_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF (to_jsonb(NEW) - 'deleted_at' - 'deleted_by_user_id' - 'updated_at')
       IS DISTINCT FROM (to_jsonb(OLD) - 'deleted_at' - 'deleted_by_user_id' - 'updated_at') THEN
    RAISE EXCEPTION
      'engagement letter % cannot be deleted and changed in one statement. Deleting records that it was made by mistake, and nothing else.',
      OLD.ref
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION
      'engagement letter % cannot be deleted: it is %, and only a draft that never went out can be. A letter the client has seen is withdrawn; a signed one is superseded.',
      OLD.ref, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$;

-- `trg_el_guard_deletion` sorts after `trg_el_freeze` — see the header.
CREATE TRIGGER trg_el_guard_deletion
  BEFORE UPDATE ON crm.engagement_letter
  FOR EACH ROW
  WHEN (OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION crm.refuse_bad_letter_deletion();

-- ── Nothing new may point at a deleted row ──────────────────────────────────

CREATE FUNCTION crm.refuse_reference_to_deleted_lead() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lead_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.lead_id IS NOT DISTINCT FROM OLD.lead_id THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM crm.lead
              WHERE id = NEW.lead_id AND tenant_id = NEW.tenant_id AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION
      'lead % was deleted as entered by mistake, so proposal % may not be drafted from it',
      NEW.lead_id, NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_proposal_lead_not_deleted
  BEFORE INSERT OR UPDATE OF lead_id ON crm.proposal
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_reference_to_deleted_lead();

CREATE FUNCTION crm.refuse_reference_to_deleted_proposal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.proposal_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.proposal_id IS NOT DISTINCT FROM OLD.proposal_id THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM crm.proposal
              WHERE id = NEW.proposal_id AND tenant_id = NEW.tenant_id AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION
      'proposal % was deleted as made by mistake, so engagement letter % may not cite it',
      NEW.proposal_id, NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- Sorts after `trg_el_freeze`, like every trigger on the letter.
CREATE TRIGGER trg_el_quote_not_deleted
  BEFORE INSERT OR UPDATE OF proposal_id ON crm.engagement_letter
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_reference_to_deleted_proposal();

-- ── The archive guard: a deleted row is not a reference ─────────────────────
--
-- 0036's body, with each probe skipping a deleted row — and, for the two line
-- tables, a line of a deleted document. Same trigger, same firing conditions,
-- same probe order (the document chain, so the DETAIL list reads in the order
-- the work happened in).

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

  -- An engagement exists only for a SIGNED letter, and a signed letter is never
  -- deleted, so this probe needs no such clause.
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

RESET ROLE;
