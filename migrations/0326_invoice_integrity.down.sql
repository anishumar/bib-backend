-- 0326 down · Back to 0027/0028/0066/0322 as they were.
--
-- REFUSES while two lines of one invoice share a position (a line added after
-- another was struck off): 0027's constraint cannot hold them both.

SET ROLE bib_owner;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM crm.invoice_line GROUP BY invoice_id, position HAVING count(*) > 1) THEN
    RAISE EXCEPTION
      '0326 down: some invoices have a struck-off line and a live line at the same position. 0027''s constraint cannot hold both; renumber them first.';
  END IF;
END;
$$;

-- ── 5. 0066's portal policy ───────────────────────────────────────────────
DROP POLICY invoice_portal_issued ON crm.invoice;
CREATE POLICY invoice_portal_issued ON crm.invoice AS RESTRICTIVE
  USING      (NOT crm.is_portal_session() OR status IN ('issued', 'cancelled'))
  WITH CHECK (NOT crm.is_portal_session() OR status IN ('issued', 'cancelled'));

-- ── 4. 0028's balance ──────────────────────────────────────────────────────
CREATE OR REPLACE VIEW crm.invoice_balance WITH (security_invoker = true) AS
SELECT i.id            AS invoice_id,
       i.tenant_id,
       i.party_id,
       i.status,
       i.currency,
       i.due_on,
       COALESCE(t.total, 0)   AS invoiced,
       COALESCE(p.paid, 0)    AS paid,
       COALESCE(c.credited, 0) AS credited,
       COALESCE(t.total, 0) - COALESCE(p.paid, 0) - COALESCE(c.credited, 0) AS outstanding
FROM crm.invoice i
LEFT JOIN crm.invoice_totals t ON t.invoice_id = i.id
LEFT JOIN (
  SELECT invoice_id, sum(amount) AS paid FROM crm.payment GROUP BY invoice_id
) p ON p.invoice_id = i.id
LEFT JOIN (
  SELECT invoice_id, sum(amount) AS credited FROM crm.credit_note GROUP BY invoice_id
) c ON c.invoice_id = i.id;

COMMENT ON VIEW crm.invoice_balance IS
  'What each invoice still owes: invoiced - paid - credited, in numeric. Derived rather than stored, because a paid flag and an amount_paid column are caches of this addition and drift the first time a payment is corrected.';

-- ── 3. Cancelling a paid invoice, and 0028's payment guard ─────────────────
DROP TRIGGER trg_invoice_cancel_unpaid ON crm.invoice;
DROP FUNCTION crm.refuse_cancelling_a_paid_invoice();

CREATE OR REPLACE FUNCTION crm.refuse_payment_on_unissued() RETURNS trigger AS $$
DECLARE
  state text;
BEGIN
  SELECT status INTO state FROM crm.invoice WHERE id = NEW.invoice_id;
  IF state <> 'issued' THEN
    RAISE EXCEPTION
      'invoice % is %, so a payment cannot be applied to it. Money against a draft has nothing to settle, and money against a cancelled invoice is a refund or a reallocation.',
      NEW.invoice_id, state USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 2. 0322's freeze, as it was ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION crm.refuse_invoice_number_change() RETURNS trigger AS $$
BEGIN
  IF NEW.number IS DISTINCT FROM OLD.number
     OR NEW.sequence_number IS DISTINCT FROM OLD.sequence_number THEN
    IF NOT (OLD.number IS NULL AND OLD.sequence_number IS NULL
            AND OLD.status = 'draft' AND NEW.status = 'issued'
            AND NEW.number IS NOT NULL AND NEW.sequence_number IS NOT NULL) THEN
      RAISE EXCEPTION
        'invoice % is numbered %, and an invoice number is not editable — a consecutive series is a legal record. Cancel it and issue a new one.',
        OLD.id, coalesce(OLD.number, '(not yet)') USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF NEW.financial_year IS DISTINCT FROM OLD.financial_year
     OR NEW.entity_party_id IS DISTINCT FROM OLD.entity_party_id THEN
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

-- ── 1. Positions ───────────────────────────────────────────────────────────
DROP INDEX crm.invoice_line_position_unique;
ALTER TABLE crm.invoice_line
  ADD CONSTRAINT invoice_line_position_unique UNIQUE (invoice_id, position);

RESET ROLE;
