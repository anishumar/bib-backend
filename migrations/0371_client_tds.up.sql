-- 0371 · The TDS a client deducts (Q057, S5, 2026-10-05).
--
-- 10x: "A separate line item in the invoice showing TDS deduction followed by
-- net remittance to be done by the client". An Indian client paying a
-- professional fee deducts income tax at source (s.194J, 10% today) and remits
-- the rest; the firm claims the deducted part against its own tax from Form
-- 26AS. So the invoice still DEMANDS its full total, and the client's money
-- arrives as two parts: a bank transfer and a TDS deduction. Before this, the
-- deducted part read as owed for ever, and the chaser kept asking for it.
--
--   1. `crm.client_tds`: one row per client, its section and rate, or neither
--      (it does not deduct). Copied onto each invoice (0370's `tds_section`,
--      `tds_percent`) when it is drafted and again when it is issued, and frozen
--      there: changing a client's rate never restates an issued invoice.
--   2. `crm.payment.tds_amount`: the TDS the client deducted, recorded beside
--      the money it sent. Signed like the amount (a TDS later paid in cash
--      instead is a negative TDS and a positive amount). A payment may be TDS
--      alone (the client deducted, the transfer came on another day).
--   3. `crm.invoice_balance` gains `tds`, and an invoice is settled when the
--      money paid, the TDS deducted and the credit notes cover it:
--      outstanding = invoiced - paid - tds - credited. `paid` still means money
--      received, so a cash report does not count tax the firm has not yet
--      claimed.
--   4. A cancelled invoice is refused when TDS was recorded against it, as one
--      with money is (0326).

SET ROLE bib_owner;

-- ── 1. The client's setting ────────────────────────────────────────────────
CREATE TABLE crm.client_tds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenancy.tenant (id),
  party_id    uuid NOT NULL,
  -- NULL and NULL: the client does not deduct (any more).
  section     text CHECK (section IS NULL OR section ~ '^[0-9]{3}[A-Z]{0,2}(\([0-9a-z]{1,3}\))?$'),
  percent     numeric(5,2) CHECK (percent IS NULL OR (percent > 0 AND percent <= 100)),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT client_tds_whole_chk CHECK ((section IS NULL) = (percent IS NULL)),
  CONSTRAINT client_tds_tenant_key UNIQUE (id, tenant_id),
  -- One setting per client per firm.
  CONSTRAINT client_tds_one_per_party UNIQUE (tenant_id, party_id),
  CONSTRAINT client_tds_party_fkey
    FOREIGN KEY (party_id, tenant_id) REFERENCES core.party (id, tenant_id)
);

ALTER TABLE crm.client_tds ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_tds_isolation ON crm.client_tds
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TRIGGER trg_client_tds_updated
  BEFORE UPDATE ON crm.client_tds
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

GRANT SELECT, INSERT ON crm.client_tds TO bib_app;
GRANT UPDATE (section, percent, updated_at) ON crm.client_tds TO bib_app;

COMMENT ON TABLE crm.client_tds IS
  'Whether a client deducts TDS on the firm''s fees, and under which section at what rate (Q057, 0371). Copied onto each invoice and frozen there at issue.';

-- ── 2. TDS beside the money ────────────────────────────────────────────────
ALTER TABLE crm.payment
  ADD COLUMN tds_amount numeric(18,4) NOT NULL DEFAULT 0,
  DROP CONSTRAINT payment_amount_check,
  ADD CONSTRAINT payment_something_chk CHECK (amount <> 0 OR tds_amount <> 0);

COMMENT ON COLUMN crm.payment.tds_amount IS
  'The TDS the client deducted from this remittance (Q057, 0371), signed like amount. With amount, what settles the invoice; kept apart because it is a tax credit the firm claims, not money in the bank.';

-- ── 3. Settled when money, TDS and credit cover it ─────────────────────────
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
            THEN COALESCE(t.total, 0) - COALESCE(p.paid, 0) - COALESCE(p.tds, 0) - COALESCE(c.credited, 0)
            ELSE 0
       END AS outstanding,
       COALESCE(p.tds, 0)     AS tds
FROM crm.invoice i
LEFT JOIN crm.invoice_totals t ON t.invoice_id = i.id
LEFT JOIN (
  SELECT invoice_id, sum(amount) AS paid, sum(tds_amount) AS tds FROM crm.payment GROUP BY invoice_id
) p ON p.invoice_id = i.id
LEFT JOIN (
  SELECT invoice_id, sum(amount) AS credited FROM crm.credit_note GROUP BY invoice_id
) c ON c.invoice_id = i.id;

COMMENT ON VIEW crm.invoice_balance IS
  'What each invoice still owes: invoiced - paid - tds - credited, in numeric, for an ISSUED invoice; 0 for a draft or a cancelled one (0326, 0371). paid is money received; tds the tax the client deducted (Q057). Derived rather than stored.';

-- ── 4. TDS on it: not cancelled ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION crm.refuse_cancelling_a_paid_invoice() RETURNS trigger AS $$
DECLARE
  paid numeric;
  tds numeric;
BEGIN
  SELECT coalesce(sum(amount), 0), coalesce(sum(tds_amount), 0) INTO paid, tds
    FROM crm.payment WHERE invoice_id = OLD.id;
  IF paid <> 0 OR tds <> 0 THEN
    RAISE EXCEPTION
      'invoice % has % of payments and % of TDS against it, so it cannot be cancelled: they would be attached to nothing. Issue a credit note, or record a refund of a mistaken payment first.',
      coalesce(OLD.number, OLD.id::text), paid, tds USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

RESET ROLE;
