-- 0326 · Invoice integrity (audit 2026-10-03, billing cluster).
--
--   1. A STRUCK-OFF LINE NO LONGER HOLDS ITS POSITION (B04). 0027's
--      `invoice_line_position_unique (invoice_id, position)` counted lines struck
--      off a draft, while `addLine` numbers the next line from the live ones: a
--      draft with lines 1 and 2, line 2 struck off, could not take another line
--      (duplicate key, a 500). Scoped to LIVE lines, as the proposal, letter and
--      fee-group positions already are. Concurrent adds are serialised on the
--      invoice row by the repository (B36).
--   2. AN INVOICE'S YEAR IS ITS ISSUE DATE'S (B03). 0322 drew the number at issue
--      but kept the year chosen at the draft, so an advance auto-drafted on 28
--      March and issued on 3 April went out as INV/2026-27/00NN dated in FY
--      2027-28, against the consecutive-series rule. The freeze now admits the
--      year changing in exactly one write: the one that numbers an unnumbered
--      draft and issues it. Everything else it refused it still refuses.

SET ROLE bib_owner;

-- ── 1. Positions among live lines only ─────────────────────────────────────
ALTER TABLE crm.invoice_line DROP CONSTRAINT invoice_line_position_unique;
-- CONSCIOUSLY SCOPED: one live line per position per invoice. A struck-off line
-- keeps the position it had, for the record, and frees it.
CREATE UNIQUE INDEX invoice_line_position_unique
  ON crm.invoice_line (invoice_id, position) WHERE removed_at IS NULL;

-- ── 2. The year moves with the number, at issue ────────────────────────────
CREATE OR REPLACE FUNCTION crm.refuse_invoice_number_change() RETURNS trigger AS $$
DECLARE
  -- The one write 0322 admits: an unnumbered draft taking its number as it is
  -- issued. Since 0326 that write may also move it to the issue date's year.
  numbering_at_issue boolean :=
    OLD.number IS NULL AND OLD.sequence_number IS NULL
    AND OLD.status = 'draft' AND NEW.status = 'issued'
    AND NEW.number IS NOT NULL AND NEW.sequence_number IS NOT NULL;
BEGIN
  IF (NEW.number IS DISTINCT FROM OLD.number
      OR NEW.sequence_number IS DISTINCT FROM OLD.sequence_number)
     AND NOT numbering_at_issue THEN
    RAISE EXCEPTION
      'invoice % is numbered %, and an invoice number is not editable — a consecutive series is a legal record. Cancel it and issue a new one.',
      OLD.id, coalesce(OLD.number, '(not yet)') USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.entity_party_id IS DISTINCT FROM OLD.entity_party_id
     OR (NEW.financial_year IS DISTINCT FROM OLD.financial_year AND NOT numbering_at_issue) THEN
    RAISE EXCEPTION
      'invoice % belongs to its company''s series for its financial year, and that does not move. Cancel it and raise a new one.',
      OLD.id USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'issued' AND (
       NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.fx_rate IS DISTINCT FROM OLD.fx_rate
    OR NEW.fx_rate_date IS DISTINCT FROM OLD.fx_rate_date
    OR NEW.issued_on IS DISTINCT FROM OLD.issued_on
    OR NEW.party_id IS DISTINCT FROM OLD.party_id) THEN
    RAISE EXCEPTION
      'invoice % has been issued, so what it says the client owes cannot change. Cancel it and issue a new one.',
      OLD.id USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.irn IS NOT NULL AND NEW.irn IS DISTINCT FROM OLD.irn THEN
    RAISE EXCEPTION
      'invoice % is registered as IRN %, and that is the registry''s identifier, not ours.',
      OLD.id, OLD.irn USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

RESET ROLE;
