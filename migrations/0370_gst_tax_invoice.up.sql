-- 0370 · The invoice as a GST tax invoice (Q056, S5, 2026-10-05).
--
-- CGST Rule 46 asks a tax invoice for the SAC of each service, the place of
-- supply, the tax split into CGST and SGST (or UTGST) within a state and IGST
-- between states, the LUT for an export without tax, and whether tax is payable
-- on reverse charge. This migration stores what decides those, on the invoice,
-- and computes the split in the view every balance already reads.
--
--   1. `crm.invoice_line.sac`: the line's service code, copied from the
--      catalogue service when the line is made (or typed for a line with no
--      service), and settable on a draft. Six digits in chapter 99.
--   2. On `crm.invoice`, decided on the draft and FROZEN WHEN IT IS ISSUED
--      (the trigger below): `tax_treatment` (`domain/invoice/gst.ts`), the
--      supplier's and the recipient's GSTIN and the supplier's state code, the
--      place of supply (a state code, or a country outside India), a state a
--      person chose for it, the LUT and the bank account it prints, and the
--      TDS the client deducts (section and rate, Q057).
--   3. `crm.invoice_line_amount` gains `cgst`, `sgst`, `utgst`, `igst`; its
--      `tax` becomes their sum on a GST invoice. EACH COMPONENT is rounded to
--      the minor unit on the line's rounded net: 18% within a state is 9% + 9%,
--      each rounded, which is what the invoice prints beside each other.
--      `crm.invoice_totals` gains their sums, the TDS (the rate on the pre-tax
--      total, CBDT Circular 23/2017) and the net the client remits.
--
-- AN INVOICE FROM BEFORE THIS HAS `tax_treatment` NULL, and the view computes
-- it exactly as 0325 did, so no issued figure moves. Drafts take a treatment
-- the next time a line is added or they are issued. `plain` is a company
-- outside India, or an Indian company with no GSTIN: one tax figure, as before.
--
-- e-invoicing (IRN, QR) is not built (S6). Everything an IRP payload needs
-- from the invoice is here: GSTINs, state codes, place of supply, SAC per line.

SET ROLE bib_owner;

-- ── 1. The line's service code ─────────────────────────────────────────────
ALTER TABLE crm.invoice_line
  ADD COLUMN sac text CONSTRAINT invoice_line_sac_chk CHECK (sac IS NULL OR sac ~ '^99[0-9]{4}$');

COMMENT ON COLUMN crm.invoice_line.sac IS
  'The service''s SAC (chapter 99, six digits) as this invoice prints it (Q056, 0370). From the catalogue service when the line is made or issued; typed for a line with no service. Frozen with the line once issued.';

-- ── 2. What the invoice says about tax ─────────────────────────────────────
ALTER TABLE crm.invoice
  ADD COLUMN tax_treatment text
    CONSTRAINT invoice_tax_treatment_chk CHECK (tax_treatment IS NULL OR tax_treatment IN
      ('plain', 'gst_intra', 'gst_intra_ut', 'gst_inter', 'gst_export_lut', 'gst_export_igst')),
  ADD COLUMN supplier_gstin text,
  ADD COLUMN supplier_state_code text
    CONSTRAINT invoice_supplier_state_chk CHECK (supplier_state_code IS NULL OR supplier_state_code ~ '^[0-9]{2}$'),
  ADD COLUMN recipient_gstin text,
  -- The place of supply: a state (`place_of_supply_state_code`) or a country
  -- outside India (`place_of_supply_country`, not 'IN'); never both.
  ADD COLUMN place_of_supply_state_code text
    CONSTRAINT invoice_pos_state_chk CHECK (place_of_supply_state_code IS NULL OR place_of_supply_state_code ~ '^[0-9]{2}$'),
  ADD COLUMN place_of_supply_country text
    CONSTRAINT invoice_pos_country_chk CHECK (place_of_supply_country IS NULL OR place_of_supply_country ~ '^[A-Z]{2}$'),
  -- A state a PERSON chose on the draft, over the client's own (a client
  -- registered in several states). NULL: follow the client.
  ADD COLUMN chosen_place_of_supply text
    CONSTRAINT invoice_chosen_pos_chk CHECK (chosen_place_of_supply IS NULL OR chosen_place_of_supply ~ '^[0-9]{2}$'),
  ADD COLUMN lut_id uuid,
  ADD COLUMN bank_account_id uuid,
  -- Q057: the TDS the client deducts, as its setting stood (0371) when the
  -- invoice was drafted or issued. Both or neither.
  ADD COLUMN tds_section text
    CONSTRAINT invoice_tds_section_chk CHECK (tds_section IS NULL OR tds_section ~ '^[0-9]{3}[A-Z]{0,2}(\([0-9a-z]{1,3}\))?$'),
  ADD COLUMN tds_percent numeric(5,2)
    CONSTRAINT invoice_tds_percent_chk CHECK (tds_percent IS NULL OR (tds_percent > 0 AND tds_percent <= 100)),
  ADD CONSTRAINT invoice_tds_whole_chk CHECK ((tds_section IS NULL) = (tds_percent IS NULL)),
  ADD CONSTRAINT invoice_pos_one_chk
    CHECK (place_of_supply_state_code IS NULL OR place_of_supply_country IS NULL),
  -- Zero-rated means an LUT was in force, and the invoice names it.
  ADD CONSTRAINT invoice_export_lut_chk CHECK (tax_treatment IS DISTINCT FROM 'gst_export_lut' OR lut_id IS NOT NULL),
  ADD CONSTRAINT invoice_lut_fkey
    FOREIGN KEY (lut_id, tenant_id) REFERENCES crm.firm_entity_lut (id, tenant_id),
  ADD CONSTRAINT invoice_bank_account_fkey
    FOREIGN KEY (bank_account_id, tenant_id) REFERENCES crm.firm_entity_bank_account (id, tenant_id);

COMMENT ON COLUMN crm.invoice.tax_treatment IS
  'Which taxes the invoice charges (Q056, 0370): plain (one tax figure), gst_intra (CGST+SGST), gst_intra_ut (CGST+UTGST), gst_inter (IGST), gst_export_lut (zero-rated under an LUT), gst_export_igst (IGST on an export). NULL: an invoice from before 0370, computed as 0325 did. Frozen at issue.';

-- Frozen once issued. The issuing write itself (draft -> issued) may set them.
CREATE FUNCTION crm.refuse_issued_tax_change() RETURNS trigger
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

CREATE TRIGGER trg_invoice_tax_frozen
  BEFORE UPDATE ON crm.invoice
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_issued_tax_change();

-- ── 3. The split, in the view every balance reads ──────────────────────────
--
-- `net` is computed once (the rounded taxable value); every component is the
-- rate (or half of it) on that, rounded. The columns before `cgst` keep their
-- names, order and types, so every view built on this one is untouched.
CREATE OR REPLACE VIEW crm.invoice_line_amount WITH (security_invoker = true) AS
WITH l AS (
  SELECT l.id, l.invoice_id, l.tenant_id, l.currency, l.tax_percent, i.tax_treatment AS treatment,
         crm.round_to_minor_unit(l.quantity * l.unit_amount, l.currency) AS gross,
         crm.round_to_minor_unit(l.quantity * l.unit_amount * (1 - l.discount_percent / 100), l.currency) AS net
  FROM crm.invoice_line l
  JOIN crm.invoice i ON i.id = l.invoice_id AND i.tenant_id = l.tenant_id
  WHERE l.removed_at IS NULL
), c AS (
  SELECT l.*,
         CASE WHEN l.treatment IN ('gst_intra', 'gst_intra_ut')
              THEN crm.round_to_minor_unit(l.net * (l.tax_percent / 2) / 100, l.currency) ELSE 0.0000 END AS half,
         CASE WHEN l.treatment IN ('gst_inter', 'gst_export_igst')
              THEN crm.round_to_minor_unit(l.net * l.tax_percent / 100, l.currency) ELSE 0.0000 END AS whole
  FROM l
)
SELECT c.id AS invoice_line_id,
       c.invoice_id,
       c.tenant_id,
       c.gross,
       c.net,
       (CASE
          WHEN c.treatment IS NULL OR c.treatment = 'plain'
            THEN crm.round_to_minor_unit(c.net * c.tax_percent / 100, c.currency)
          WHEN c.treatment IN ('gst_intra', 'gst_intra_ut') THEN c.half * 2
          WHEN c.treatment IN ('gst_inter', 'gst_export_igst') THEN c.whole
          ELSE 0.0000
        END)::numeric AS tax,
       (CASE WHEN c.treatment IN ('gst_intra', 'gst_intra_ut') THEN c.half ELSE 0.0000 END)::numeric AS cgst,
       (CASE WHEN c.treatment = 'gst_intra' THEN c.half ELSE 0.0000 END)::numeric AS sgst,
       (CASE WHEN c.treatment = 'gst_intra_ut' THEN c.half ELSE 0.0000 END)::numeric AS utgst,
       c.whole::numeric AS igst
FROM c;

COMMENT ON VIEW crm.invoice_line_amount IS
  'One invoice line''s money (0325, 0370): gross and net rounded to the currency''s minor unit; on a GST invoice CGST and SGST (or UTGST) each at half the rate, or IGST at the whole rate, each rounded on the net, and tax their sum; zero on an export under an LUT; on a plain or pre-0370 invoice the rate on the net, rounded once.';

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
         - coalesce(crm.round_to_minor_unit(sum(a.net) * i.tds_percent / 100, i.currency), 0.0000) AS net_payable
FROM crm.invoice_line_amount a
JOIN crm.invoice i ON i.id = a.invoice_id AND i.tenant_id = a.tenant_id
GROUP BY a.invoice_id, a.tenant_id, i.tds_percent, i.currency;

COMMENT ON VIEW crm.invoice_totals IS
  'Derived, never stored (0027, 0370): sums of the rounded lines, the tax by component, the TDS the client is expected to deduct (rate on the pre-tax net) and the net it remits. A stored subtotal drifts from its lines the first time one moves.';

RESET ROLE;
