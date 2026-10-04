-- 0327 · A firm's own payment terms (audit 2026-10-03, B20).
--
-- Bills auto-drafted by the billing desk (the advance at signing, and every
-- raise from To raise) carried no due date, and an invoice with no due date is
-- never chased by client reminders. A firm may now say "our invoices are due N
-- days after the invoice date"; an invoice ISSUED with no due date then takes
-- issue date + N. A due date somebody typed is always kept.
--
-- NO DEFAULT, on purpose. Payment terms are the firm's commercial fact (7, 15,
-- 30 days, or on receipt) and nobody has told us 10x Global's; a guessed
-- number would put a date on every invoice that the firm never agreed to. Empty
-- means what it meant before: no due date unless a person types one.
--
-- A column on the tenant row like `auto_billing` and the advance policy: one
-- value per firm, read on every issue.

SET ROLE bib_owner;

ALTER TABLE tenancy.tenant
  ADD COLUMN invoice_due_days smallint
    CONSTRAINT tenant_invoice_due_days_chk CHECK (invoice_due_days BETWEEN 0 AND 365);

COMMENT ON COLUMN tenancy.tenant.invoice_due_days IS
  'The firm''s own payment terms: an invoice issued with no due date is due this many days after its issue date (0327). NULL, the default, means no due date unless a person types one. 0 is due on receipt.';

RESET ROLE;
