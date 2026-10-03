-- 0325 · An invoice adds up to whole paise (audit 2026-10-03, B02).
--
-- `crm.invoice_line_amount` (0027) rounded a line's net and tax to FOUR places
-- and summed them. Tax is the first figure that is not already whole paise: a
-- pro-rata bill of 27,419.35 at 18% carries 4,935.483 of tax and a total of
-- 32,354.833. The PDF prints 32,354.83, the client pays 32,354.83, and 0.003
-- stays outstanding for good: the invoice never leaves the receivables, the
-- dunning ladder climbs to a credit hold over "INR 0.00", and an advance that
-- was paid never reads `paid`, so its reminders and the weekly escalation never
-- stop. The audit found 12 local drafts like it, all from billing dues.
--
-- The fix is the one every invoicing system makes: EACH LINE is rounded to the
-- currency's minor unit (paise for INR; none for JPY; three places for KWD),
-- half away from zero, which for an amount that is never negative is half up;
-- the TAX is worked out on the line's rounded net (the taxable value the
-- invoice prints) and rounded the same way; and the invoice's totals are SUMS
-- OF THOSE ROUNDED LINES. So the figure on paper, the figure in every balance
-- and the figure a client pays are one number. `invoice_totals`,
-- `invoice_balance`, `receivable_ageing`, `advance_pool` and the PDF all read
-- this view, so they follow without being touched.
--
-- The values keep FOUR decimal places on the wire ("32354.8300"): every reader
-- already parses that scale, and a total changing from "11800.0000" to
-- "11800.00" would be a second change nobody asked for.
--
-- AN ISSUED INVOICE'S FIGURES CAN MOVE HERE, by less than one minor unit per
-- line, and only where a line's tax was not already whole paise. That is a
-- derived view correcting itself to what the copy of record printed (the PDF
-- always printed two places); nothing stored changes.

SET ROLE bib_owner;

-- ISO 4217's minor units. A currency not listed has two, which is right for
-- every currency this product bills in today (INR, AED, SGD, USD, GBP, EUR).
CREATE FUNCTION crm.currency_minor_unit(currency text) RETURNS integer AS $$
  SELECT CASE upper(currency)
           WHEN 'BIF' THEN 0 WHEN 'CLP' THEN 0 WHEN 'DJF' THEN 0 WHEN 'GNF' THEN 0
           WHEN 'ISK' THEN 0 WHEN 'JPY' THEN 0 WHEN 'KMF' THEN 0 WHEN 'KRW' THEN 0
           WHEN 'PYG' THEN 0 WHEN 'RWF' THEN 0 WHEN 'UGX' THEN 0 WHEN 'UYI' THEN 0
           WHEN 'VND' THEN 0 WHEN 'VUV' THEN 0 WHEN 'XAF' THEN 0 WHEN 'XOF' THEN 0
           WHEN 'XPF' THEN 0
           WHEN 'BHD' THEN 3 WHEN 'IQD' THEN 3 WHEN 'JOD' THEN 3 WHEN 'KWD' THEN 3
           WHEN 'LYD' THEN 3 WHEN 'OMR' THEN 3 WHEN 'TND' THEN 3
           ELSE 2
         END;
$$ LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE;

COMMENT ON FUNCTION crm.currency_minor_unit(text) IS
  'How many decimal places a currency''s smallest coin has (ISO 4217): 2 for INR, 0 for JPY, 3 for KWD. An invoice line is rounded to it (0325).';

-- An amount rounded to the currency's minor unit, carried at four places so the
-- wire keeps the scale it always had.
CREATE FUNCTION crm.round_to_minor_unit(amount numeric, currency text) RETURNS numeric AS $$
  SELECT round(amount, crm.currency_minor_unit(currency))::numeric(38, 4);
$$ LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE;

COMMENT ON FUNCTION crm.round_to_minor_unit(numeric, text) IS
  'An amount rounded half away from zero to the currency''s minor unit, at scale 4 (0325).';

CREATE OR REPLACE VIEW crm.invoice_line_amount WITH (security_invoker = true) AS
SELECT l.id AS invoice_line_id,
       l.invoice_id,
       l.tenant_id,
       crm.round_to_minor_unit(l.quantity * l.unit_amount, l.currency) AS gross,
       crm.round_to_minor_unit(l.quantity * l.unit_amount * (1 - l.discount_percent / 100), l.currency) AS net,
       -- On the ROUNDED net: the tax on a tax invoice is the rate applied to the
       -- taxable value printed beside it.
       crm.round_to_minor_unit(
         crm.round_to_minor_unit(l.quantity * l.unit_amount * (1 - l.discount_percent / 100), l.currency)
           * l.tax_percent / 100,
         l.currency) AS tax
FROM crm.invoice_line l
WHERE l.removed_at IS NULL;

COMMENT ON VIEW crm.invoice_line_amount IS
  'One invoice line''s money: gross, net of discount and tax, EACH rounded to the currency''s minor unit (0325), so every total that sums them is whole paise and a client who pays the printed total owes nothing.';

GRANT EXECUTE ON FUNCTION crm.currency_minor_unit(text) TO bib_app;
GRANT EXECUTE ON FUNCTION crm.round_to_minor_unit(numeric, text) TO bib_app;

RESET ROLE;
