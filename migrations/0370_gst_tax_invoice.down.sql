-- 0370 down · Back to 0325's arithmetic.
--
-- The views KEEP the columns 0370 appended, as zeros: CREATE OR REPLACE cannot
-- drop a column, and dropping the views would take every view built on them
-- (invoice_balance, advance_pool, receivable_ageing, and other branches' own)
-- with them. What they compute is 0325's again, and they no longer read the
-- invoice columns dropped below.

SET ROLE bib_owner;

CREATE OR REPLACE VIEW crm.invoice_line_amount WITH (security_invoker = true) AS
SELECT l.id AS invoice_line_id,
       l.invoice_id,
       l.tenant_id,
       crm.round_to_minor_unit(l.quantity * l.unit_amount, l.currency) AS gross,
       crm.round_to_minor_unit(l.quantity * l.unit_amount * (1 - l.discount_percent / 100), l.currency) AS net,
       crm.round_to_minor_unit(
         crm.round_to_minor_unit(l.quantity * l.unit_amount * (1 - l.discount_percent / 100), l.currency)
           * l.tax_percent / 100,
         l.currency) AS tax,
       0::numeric AS cgst,
       0::numeric AS sgst,
       0::numeric AS utgst,
       0::numeric AS igst
FROM crm.invoice_line l
WHERE l.removed_at IS NULL;

CREATE OR REPLACE VIEW crm.invoice_totals WITH (security_invoker = true) AS
SELECT a.invoice_id,
       a.tenant_id,
       count(*)                     AS line_count,
       sum(a.gross)                 AS gross,
       sum(a.gross - a.net)         AS discount,
       sum(a.net)                   AS net,
       sum(a.tax)                   AS tax,
       sum(a.net) + sum(a.tax)      AS total,
       sum(a.cgst)                  AS cgst,
       sum(a.sgst)                  AS sgst,
       sum(a.utgst)                 AS utgst,
       sum(a.igst)                  AS igst,
       0::numeric            AS tds,
       sum(a.net) + sum(a.tax)      AS net_payable
FROM crm.invoice_line_amount a
GROUP BY a.invoice_id, a.tenant_id;

DROP TRIGGER IF EXISTS trg_invoice_tax_frozen ON crm.invoice;
DROP FUNCTION IF EXISTS crm.refuse_issued_tax_change();

ALTER TABLE crm.invoice
  DROP CONSTRAINT IF EXISTS invoice_bank_account_fkey,
  DROP CONSTRAINT IF EXISTS invoice_lut_fkey,
  DROP COLUMN IF EXISTS tax_treatment,
  DROP COLUMN IF EXISTS supplier_gstin,
  DROP COLUMN IF EXISTS supplier_state_code,
  DROP COLUMN IF EXISTS recipient_gstin,
  DROP COLUMN IF EXISTS place_of_supply_state_code,
  DROP COLUMN IF EXISTS place_of_supply_country,
  DROP COLUMN IF EXISTS chosen_place_of_supply,
  DROP COLUMN IF EXISTS lut_id,
  DROP COLUMN IF EXISTS bank_account_id,
  DROP COLUMN IF EXISTS tds_section,
  DROP COLUMN IF EXISTS tds_percent;

ALTER TABLE crm.invoice_line DROP COLUMN IF EXISTS sac;

RESET ROLE;
