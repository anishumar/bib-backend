-- Reverses 0028, newest first, IF EXISTS throughout — including the correction
-- to 0027's series key, which is put back the way 0027 left it.
SET ROLE bib_owner;

DROP VIEW IF EXISTS crm.invoice_balance;

DROP TRIGGER IF EXISTS trg_credit_note_freeze ON crm.credit_note;
DROP TRIGGER IF EXISTS trg_credit_note_updated ON crm.credit_note;
DROP TABLE IF EXISTS crm.credit_note;
DROP FUNCTION IF EXISTS crm.refuse_credit_note_change();

DROP TRIGGER IF EXISTS trg_payment_invoice_issued ON crm.payment;
DROP TRIGGER IF EXISTS trg_payment_updated ON crm.payment;
DROP TABLE IF EXISTS crm.payment;
DROP FUNCTION IF EXISTS crm.refuse_payment_on_unissued();

ALTER TABLE crm.invoice DROP CONSTRAINT IF EXISTS invoice_series_fkey;
ALTER TABLE crm.invoice DROP CONSTRAINT IF EXISTS invoice_series_type_chk;
ALTER TABLE crm.invoice DROP COLUMN IF EXISTS series_type;

ALTER TABLE crm.invoice_series DROP CONSTRAINT IF EXISTS invoice_series_pkey;
ALTER TABLE crm.invoice_series DROP CONSTRAINT IF EXISTS invoice_series_type_chk;
ALTER TABLE crm.invoice_series DROP COLUMN IF EXISTS document_type;
ALTER TABLE crm.invoice_series
  ADD CONSTRAINT invoice_series_pkey PRIMARY KEY (tenant_id, entity_party_id, financial_year);

ALTER TABLE crm.invoice
  ADD CONSTRAINT invoice_series_fkey
    FOREIGN KEY (tenant_id, entity_party_id, financial_year)
      REFERENCES crm.invoice_series (tenant_id, entity_party_id, financial_year);

RESET ROLE;
