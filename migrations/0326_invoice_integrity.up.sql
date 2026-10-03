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
--   3. AN ISSUED INVOICE WITH MONEY ON IT IS NOT CANCELLED (B05). Cancelling a
--      paid invoice orphaned the payment (the receivables and every list drop a
--      cancelled invoice) and re-opened the bill behind it to be raised again;
--      the audit found 16 such rows locally. The service refuses in plain words
--      (a credit note, or reverse a mistaken payment first); this trigger is
--      what an import or a psql session meets. A payment's own trigger now reads
--      the invoice FOR SHARE, so a payment and a cancellation at the same moment
--      serialise instead of both passing. Existing cancelled rows are untouched.
--   4. ONLY AN ISSUED INVOICE OWES ANYTHING, IN THE VIEW ITSELF (B22).
--      `crm.invoice_balance` computed `outstanding` whatever the status, so the
--      balance route and the dunning approval queue reported a CANCELLED
--      invoice's full total as owed (110 locally), and a partner could approve a
--      credit hold over it. The screens filtered it one by one; the view now says
--      it once: outstanding is invoiced - paid - credited for an issued invoice
--      and 0 for a draft (nobody was asked) or a cancelled one (withdrawn).
--      `invoiced`, `paid` and `credited` still say what they say.
--   5. THE CLIENT SEES ONLY WHAT WAS ISSUED TO THEM (F06). 0066's policy let a
--      cancelled invoice through, including a draft cancelled before it was ever
--      sent ("Cancelled · Not issued" on the client's page). It now asks whether
--      the invoice was ever issued (`issued_on`, kept on a cancelled one, 0029).

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

-- ── 3. Money on it: not cancelled ──────────────────────────────────────────
CREATE FUNCTION crm.refuse_cancelling_a_paid_invoice() RETURNS trigger AS $$
DECLARE
  paid numeric;
BEGIN
  SELECT coalesce(sum(amount), 0) INTO paid FROM crm.payment WHERE invoice_id = OLD.id;
  IF paid <> 0 THEN
    RAISE EXCEPTION
      'invoice % has % of payments against it, so it cannot be cancelled: the money would be attached to nothing. Issue a credit note, or record a refund of a mistaken payment first.',
      coalesce(OLD.number, OLD.id::text), paid USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoice_cancel_unpaid
  BEFORE UPDATE OF status ON crm.invoice
  FOR EACH ROW
  WHEN (OLD.status = 'issued' AND NEW.status = 'cancelled')
  EXECUTE FUNCTION crm.refuse_cancelling_a_paid_invoice();

-- 0028's payment guard, reading the invoice FOR SHARE: a cancellation holding
-- the row makes this wait and then see `cancelled`.
CREATE OR REPLACE FUNCTION crm.refuse_payment_on_unissued() RETURNS trigger AS $$
DECLARE
  state text;
BEGIN
  SELECT status INTO state FROM crm.invoice WHERE id = NEW.invoice_id FOR SHARE;
  IF state <> 'issued' THEN
    RAISE EXCEPTION
      'invoice % is %, so a payment cannot be applied to it. Money against a draft has nothing to settle, and money against a cancelled invoice is a refund or a reallocation.',
      NEW.invoice_id, state USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 4. Outstanding means issued ────────────────────────────────────────────
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
       CASE WHEN i.status = 'issued'
            THEN COALESCE(t.total, 0) - COALESCE(p.paid, 0) - COALESCE(c.credited, 0)
            ELSE 0
       END AS outstanding
FROM crm.invoice i
LEFT JOIN crm.invoice_totals t ON t.invoice_id = i.id
LEFT JOIN (
  SELECT invoice_id, sum(amount) AS paid FROM crm.payment GROUP BY invoice_id
) p ON p.invoice_id = i.id
LEFT JOIN (
  SELECT invoice_id, sum(amount) AS credited FROM crm.credit_note GROUP BY invoice_id
) c ON c.invoice_id = i.id;

COMMENT ON VIEW crm.invoice_balance IS
  'What each invoice still owes: invoiced - paid - credited, in numeric, for an ISSUED invoice; 0 for a draft or a cancelled one (0326). Derived rather than stored, because a paid flag and an amount_paid column are caches of this addition and drift the first time a payment is corrected.';

-- ── 5. The client sees what was issued to them ─────────────────────────────
DROP POLICY invoice_portal_issued ON crm.invoice;
CREATE POLICY invoice_portal_issued ON crm.invoice AS RESTRICTIVE
  USING      (NOT crm.is_portal_session() OR issued_on IS NOT NULL)
  WITH CHECK (NOT crm.is_portal_session() OR issued_on IS NOT NULL);

RESET ROLE;
