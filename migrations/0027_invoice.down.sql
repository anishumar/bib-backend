-- Reverses 0027. Newest first, IF EXISTS throughout. Drops nothing shared:
-- tenancy.set_updated_at() belongs to every table in the database.
SET ROLE bib_owner;

DROP VIEW IF EXISTS crm.invoice_totals;
DROP VIEW IF EXISTS crm.invoice_line_amount;

DROP TRIGGER IF EXISTS trg_invoice_line_freeze ON crm.invoice_line;
DROP TRIGGER IF EXISTS trg_invoice_line_updated ON crm.invoice_line;
DROP TABLE IF EXISTS crm.invoice_line;
DROP FUNCTION IF EXISTS crm.refuse_issued_invoice_line_change();

DROP TRIGGER IF EXISTS trg_invoice_number_freeze ON crm.invoice;
DROP TRIGGER IF EXISTS trg_invoice_updated ON crm.invoice;
DROP TABLE IF EXISTS crm.invoice;
DROP FUNCTION IF EXISTS crm.refuse_invoice_number_change();

DROP TRIGGER IF EXISTS trg_invoice_series_updated ON crm.invoice_series;
DROP TABLE IF EXISTS crm.invoice_series;

DROP FUNCTION IF EXISTS crm.financial_year_of(date);

ALTER TABLE crm.engagement DROP CONSTRAINT IF EXISTS engagement_id_tenant_key;

RESET ROLE;
