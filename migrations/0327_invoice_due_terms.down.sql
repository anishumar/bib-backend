-- 0327 down · The firm's payment terms go; due dates already on invoices stay.

SET ROLE bib_owner;

ALTER TABLE tenancy.tenant DROP COLUMN invoice_due_days;

RESET ROLE;
