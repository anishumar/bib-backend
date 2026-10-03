-- 0325 down · Back to 0027's four-place arithmetic.

SET ROLE bib_owner;

CREATE OR REPLACE VIEW crm.invoice_line_amount WITH (security_invoker = true) AS
SELECT l.id AS invoice_line_id,
       l.invoice_id,
       l.tenant_id,
       round(l.quantity * l.unit_amount, 4) AS gross,
       round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100), 4) AS net,
       round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100)
             * l.tax_percent / 100, 4) AS tax
FROM crm.invoice_line l
WHERE l.removed_at IS NULL;

COMMENT ON VIEW crm.invoice_line_amount IS NULL;

DROP FUNCTION crm.round_to_minor_unit(numeric, text);
DROP FUNCTION crm.currency_minor_unit(text);

RESET ROLE;
