-- 0375 down: totals unrounded again (0370's arithmetic), the freeze without
-- round_off, and the two columns and the function gone.

SET ROLE bib_owner;

CREATE OR REPLACE VIEW crm.invoice_totals WITH (security_invoker = true) AS
SELECT a.invoice_id,
       a.tenant_id,
       count(*)                     AS line_count,
       sum(a.gross)                 AS gross,
       sum(a.gross - a.net)         AS discount,
       sum(a.net)                   AS net,
       sum(a.tax)                   AS tax,
       -- What the client owes: net of discount, plus tax.
       sum(a.net) + sum(a.tax)      AS total,
       sum(a.cgst)                  AS cgst,
       sum(a.sgst)                  AS sgst,
       sum(a.utgst)                 AS utgst,
       sum(a.igst)                  AS igst,
       -- Q057: what the client is expected to deduct, on the amount BEFORE tax,
       -- and the net it remits. The receivable stays `total`.
       coalesce(crm.round_to_minor_unit(sum(a.net) * i.tds_percent / 100, i.currency), 0.0000)::numeric AS tds,
       sum(a.net) + sum(a.tax)
         - coalesce(crm.round_to_minor_unit(sum(a.net) * i.tds_percent / 100, i.currency), 0.0000) AS net_payable,
       -- 0375's column cannot leave a replaced view (advance_pool,
       -- invoice_balance and invoice_manager_share are built on it), so it
       -- stays, always zero, until a later up gives it meaning again.
       0.0000::numeric AS round_off
FROM crm.invoice_line_amount a
JOIN crm.invoice i ON i.id = a.invoice_id AND i.tenant_id = a.tenant_id
GROUP BY a.invoice_id, a.tenant_id, i.tds_percent, i.currency;

CREATE OR REPLACE FUNCTION crm.refuse_issued_tax_change() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
       NEW.tax_treatment IS DISTINCT FROM OLD.tax_treatment
    OR NEW.supplier_gstin IS DISTINCT FROM OLD.supplier_gstin
    OR NEW.supplier_state_code IS DISTINCT FROM OLD.supplier_state_code
    OR NEW.recipient_gstin IS DISTINCT FROM OLD.recipient_gstin
    OR NEW.place_of_supply_state_code IS DISTINCT FROM OLD.place_of_supply_state_code
    OR NEW.place_of_supply_country IS DISTINCT FROM OLD.place_of_supply_country
    OR NEW.chosen_place_of_supply IS DISTINCT FROM OLD.chosen_place_of_supply
    OR NEW.lut_id IS DISTINCT FROM OLD.lut_id
    OR NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id
    OR NEW.tds_section IS DISTINCT FROM OLD.tds_section
    OR NEW.tds_percent IS DISTINCT FROM OLD.tds_percent) THEN
    RAISE EXCEPTION
      'invoice % has been issued, so the tax it charges, where it was supplied and what it says the client deducts cannot change. Cancel it and issue a new one.',
      coalesce(OLD.number, OLD.id::text) USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP FUNCTION crm.company_rounds_off(uuid, uuid);
ALTER TABLE crm.invoice DROP COLUMN round_off;
ALTER TABLE crm.firm_entity DROP COLUMN round_off_total;

RESET ROLE;
