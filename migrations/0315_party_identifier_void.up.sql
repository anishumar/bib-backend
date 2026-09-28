-- 0315 · A mistyped identifier can be voided, and only an OPEN one blocks a duplicate (V2.5)
--
-- ── THE GAP ────────────────────────────────────────────────────────────────
--
-- A PAN or GSTIN typed wrong was permanent: nothing could edit or end one,
-- and the duplicate check (`findByValue`) matched EVERY row, ended or not, so
-- a PAN put on the wrong client also blocked it from the right one. The
-- "Deleting a mistake" section named this as the next piece of work.
--
-- ── TWO ACTS, NOT ONE ──────────────────────────────────────────────────────
--
-- ENDING is a fact about the world: a GSTIN cancelled on 30 September. It
-- sets `valid_to`, the column 0002 already had and nothing wrote.
-- VOIDING is a fact about the firm's own records: it was entered by mistake
-- and never belonged to this client. It is `voided_at` + `voided_by_user_id`,
-- the row is kept (nothing is deleted in `core`), and every screen shows it
-- as voided. A voided row is final.
--
-- Either act FREES the value: the duplicate check now matches only an OPEN
-- identifier (not voided, no end day). The service owns that read; there is
-- still no UNIQUE here, because an ended GSTIN may legitimately be recorded
-- again on the company that holds it next.

SET ROLE bib_owner;

ALTER TABLE core.party_identifier
  ADD COLUMN voided_at         timestamptz,
  ADD COLUMN voided_by_user_id uuid;

-- By id alone: tenancy.user_account is GLOBAL (ADR-02).
ALTER TABLE core.party_identifier
  ADD CONSTRAINT party_identifier_voided_by_fkey
    FOREIGN KEY (voided_by_user_id) REFERENCES tenancy.user_account (id),
  ADD CONSTRAINT party_identifier_voided_by_needs_stamp
    CHECK (voided_by_user_id IS NULL OR voided_at IS NOT NULL);

-- The duplicate check's read: open identifiers of one type and value.
CREATE INDEX idx_party_identifier_open
  ON core.party_identifier (tenant_id, type, value)
  WHERE voided_at IS NULL AND valid_to IS NULL;

COMMENT ON COLUMN core.party_identifier.voided_at IS
  'Entered by mistake (0315): kept, shown as voided, and no longer blocks the value on another party.';

-- A VOIDED row is final: no change to it at all afterwards.
CREATE OR REPLACE FUNCTION core.refuse_change_to_voided_identifier() RETURNS trigger AS $$
BEGIN
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'identifier % was voided and cannot change', OLD.id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_party_identifier_voided_final
  BEFORE UPDATE ON core.party_identifier
  FOR EACH ROW EXECUTE FUNCTION core.refuse_change_to_voided_identifier();

RESET ROLE;
