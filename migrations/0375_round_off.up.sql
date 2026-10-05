-- 0375 · Round off: the invoice total to the nearest whole unit (Q087, 2026-10-05).
--
-- 10x, asked whether the total is rounded to the nearest rupee with a "Round
-- off" line or kept to the paise: "round off". The common practice of Indian
-- billing software (Tally, Zoho Books): the total after tax is rounded to the
-- nearest rupee, half away from zero, and the difference prints as its own
-- line. The lines and their tax are NOT rounded; only the total moves.
--
--   1. `crm.firm_entity.round_off_total`: the issuing company's choice, OFF
--      until the firm turns it on (Your firm -> Companies). A firm's setting,
--      like every billing choice here: switching it on for every Indian
--      company would move every firm's draft totals on deploy without anybody
--      having asked. 10x turns it on for its Indian company after the deploy.
--   2. `crm.invoice.round_off`: what an invoice did, FROZEN AT ISSUE (written
--      by the issuing UPDATE, then guarded by 0370's trigger). A draft follows
--      its company. An invoice issued before this has NULL and does not round,
--      so no issued figure moves.
--   3. `crm.invoice_totals`: `total` is the rounded total, so every balance,
--      receivable and dunning row follows; `round_off` (appended) is the
--      difference; `net_payable` is the rounded total less the TDS.

SET ROLE bib_owner;

ALTER TABLE crm.firm_entity ADD COLUMN round_off_total boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN crm.firm_entity.round_off_total IS
  'Whether this company rounds an invoice total to the nearest whole unit with a Round off line (Q087, 0375). Off until the firm turns it on.';
GRANT UPDATE (round_off_total) ON crm.firm_entity TO bib_app;

ALTER TABLE crm.invoice ADD COLUMN round_off boolean;
COMMENT ON COLUMN crm.invoice.round_off IS
  'Whether the issued invoice rounded its total (Q087, 0375), as its company stood when it was issued. NULL on a draft (it follows the company) and on an invoice issued before 0375 (it does not round). Frozen at issue.';

-- Whether a company rounds its totals. One statement of it, read by the view
-- (for a draft) and by the issuing write (to freeze it). A company that is not
-- on the firm's list (the fallback issuer) does not round.
CREATE FUNCTION crm.company_rounds_off(p_tenant uuid, p_party uuid) RETURNS boolean
  LANGUAGE sql STABLE
AS $$
  SELECT coalesce(
    (SELECT fe.round_off_total FROM crm.firm_entity fe
      WHERE fe.tenant_id = p_tenant AND fe.party_id = p_party),
    false)
$$;
GRANT EXECUTE ON FUNCTION crm.company_rounds_off(uuid, uuid) TO bib_app;

-- 0370's freeze, with the new column in it.
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
    OR NEW.tds_percent IS DISTINCT FROM OLD.tds_percent
    OR NEW.round_off IS DISTINCT FROM OLD.round_off) THEN
    RAISE EXCEPTION
      'invoice % has been issued, so the tax it charges, where it was supplied, what it says the client deducts and how its total is rounded cannot change. Cancel it and issue a new one.',
      coalesce(OLD.number, OLD.id::text) USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- The totals, rounded where the invoice rounds. Columns keep 0370's order;
-- `round_off` is appended.
CREATE OR REPLACE VIEW crm.invoice_totals WITH (security_invoker = true) AS
WITH s AS (
  SELECT a.invoice_id,
         a.tenant_id,
         count(*)                     AS line_count,
         sum(a.gross)                 AS gross,
         sum(a.gross - a.net)         AS discount,
         sum(a.net)                   AS net,
         sum(a.tax)                   AS tax,
         sum(a.net) + sum(a.tax)      AS unrounded,
         sum(a.cgst)                  AS cgst,
         sum(a.sgst)                  AS sgst,
         sum(a.utgst)                 AS utgst,
         sum(a.igst)                  AS igst,
         coalesce(crm.round_to_minor_unit(sum(a.net) * i.tds_percent / 100, i.currency), 0.0000)::numeric AS tds,
         CASE WHEN i.status = 'draft'
              THEN crm.company_rounds_off(i.tenant_id, i.entity_party_id)
              ELSE coalesce(i.round_off, false)
         END AS rounds
  FROM crm.invoice_line_amount a
  JOIN crm.invoice i ON i.id = a.invoice_id AND i.tenant_id = a.tenant_id
  GROUP BY a.invoice_id, a.tenant_id, i.tds_percent, i.currency, i.status, i.round_off, i.tenant_id, i.entity_party_id
), r AS (
  SELECT s.*,
         (CASE WHEN s.rounds THEN round(s.unrounded, 0) - s.unrounded ELSE 0.0000 END)::numeric AS round_off
  FROM s
)
SELECT r.invoice_id,
       r.tenant_id,
       r.line_count,
       r.gross,
       r.discount,
       r.net,
       r.tax,
       -- What the client owes: net of discount, plus tax, rounded where the
       -- invoice rounds (Q087).
       r.unrounded + r.round_off    AS total,
       r.cgst,
       r.sgst,
       r.utgst,
       r.igst,
       r.tds,
       r.unrounded + r.round_off - r.tds AS net_payable,
       r.round_off
FROM r;

COMMENT ON VIEW crm.invoice_totals IS
  'Derived, never stored (0027, 0370, 0375): sums of the rounded lines, the tax by component, the total rounded to the whole unit where the invoice rounds (round_off is the difference), the TDS the client is expected to deduct (rate on the pre-tax net) and the net it remits.';

RESET ROLE;
