-- 0322 down · Puts the number back on the draft. REFUSES while any invoice has
-- no number (a draft made since 0322, or one cancelled before issue): giving it
-- one now would draw numbers nobody issued. Cancel or issue those first, and
-- run only against a database somebody is trying to rescue.

SET ROLE bib_owner;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM crm.invoice WHERE number IS NULL) THEN
    RAISE EXCEPTION
      '0322 down: % invoice(s) have no number yet (drafts since 0322). Issue or cancel them, and decide what a cancelled unnumbered draft should be, before going back.',
      (SELECT count(*) FROM crm.invoice WHERE number IS NULL);
  END IF;
END;
$$;

DROP TABLE crm.advance_digest;
DROP TABLE crm.issuer_tax_default;

ALTER TABLE tenancy.tenant
  DROP COLUMN advance_digest_hour,
  DROP COLUMN advance_digest_weekday,
  DROP COLUMN advance_partner_min_rank,
  DROP COLUMN advance_unpaid_overdue_days,
  DROP COLUMN advance_draft_overdue_days;

-- 0027's freeze, as it was.
CREATE OR REPLACE FUNCTION crm.refuse_invoice_number_change() RETURNS trigger AS $$
BEGIN
  IF NEW.number IS DISTINCT FROM OLD.number
     OR NEW.financial_year IS DISTINCT FROM OLD.financial_year
     OR NEW.sequence_number IS DISTINCT FROM OLD.sequence_number
     OR NEW.entity_party_id IS DISTINCT FROM OLD.entity_party_id THEN
    RAISE EXCEPTION
      'invoice % is numbered %, and an invoice number is not editable — a consecutive series is a legal record. Cancel it and issue a new one.',
      OLD.id, OLD.number USING ERRCODE = 'restrict_violation';
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

ALTER TABLE crm.invoice DROP CONSTRAINT invoice_issued_is_numbered_chk;
ALTER TABLE crm.invoice DROP CONSTRAINT invoice_number_whole_chk;
ALTER TABLE crm.invoice ALTER COLUMN sequence_number SET NOT NULL;
ALTER TABLE crm.invoice ALTER COLUMN number SET NOT NULL;

COMMENT ON COLUMN crm.invoice.number IS NULL;

RESET ROLE;
