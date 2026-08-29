-- Reverses 0029 by restoring 0027's constraint.
--
-- NOTE, because a `down` that fails is worse than one that does not exist: this
-- will REFUSE to apply if any invoice has been issued and then cancelled, since
-- those rows are exactly what 0027's equality forbids. That is correct — going
-- back means the data is no longer representable — and the error names the
-- constraint, which is the shortest path to understanding why.
SET ROLE bib_owner;

ALTER TABLE crm.invoice DROP CONSTRAINT IF EXISTS invoice_issued_has_date_chk;
ALTER TABLE crm.invoice
  ADD CONSTRAINT invoice_issued_has_date_chk
    CHECK ((status = 'issued') = (issued_on IS NOT NULL));

RESET ROLE;
