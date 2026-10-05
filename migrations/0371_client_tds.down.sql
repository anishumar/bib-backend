-- 0371 down. invoice_balance keeps its appended `tds` column, as zero (see
-- 0370's down for why a view is not dropped).
SET ROLE bib_owner;

CREATE OR REPLACE FUNCTION crm.refuse_cancelling_a_paid_invoice() RETURNS trigger AS $$
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
       END AS outstanding,
       0::numeric AS tds
FROM crm.invoice i
LEFT JOIN crm.invoice_totals t ON t.invoice_id = i.id
LEFT JOIN (
  SELECT invoice_id, sum(amount) AS paid FROM crm.payment GROUP BY invoice_id
) p ON p.invoice_id = i.id
LEFT JOIN (
  SELECT invoice_id, sum(amount) AS credited FROM crm.credit_note GROUP BY invoice_id
) c ON c.invoice_id = i.id;

ALTER TABLE crm.payment DROP CONSTRAINT IF EXISTS payment_something_chk;
-- A TDS-only row cannot survive the old rule; it would block the down, which is right.
ALTER TABLE crm.payment ADD CONSTRAINT payment_amount_check CHECK (amount <> 0);
ALTER TABLE crm.payment DROP COLUMN IF EXISTS tds_amount;

DROP TABLE IF EXISTS crm.client_tds;

RESET ROLE;
