-- 0029 · An invoice that was issued and then cancelled keeps its date
--
-- THE BUG, and it shipped in 0027. `invoice_issued_has_date_chk` said:
--
--   CHECK ((status = 'issued') = (issued_on IS NOT NULL))
--
-- which reads as "an invoice has a date exactly when it is issued" and is
-- almost right. What it actually forbids is the ordinary act of CANCELLING AN
-- ISSUED INVOICE: the status becomes 'cancelled' while `issued_on` stays set —
-- correctly, because the document WAS issued and a copy is with the client and,
-- in India, with the government — and the equality fails. `crm.invoice.cancel`
-- therefore raised 23514 on exactly the invoices most likely to need cancelling.
--
-- It was not caught by T3.4's own tests because every one of them cancelled a
-- DRAFT — the state where both sides of the equality are false and it happens
-- to hold. T3.5's first payment test cancelled an issued one, and found it.
-- Worth recording: a constraint that is wrong only on the transition nobody
-- tested is exactly what an equality between two independent facts produces.
--
-- THE RULE, stated as three cases rather than as an equality, because it IS
-- three cases and the equality was an attempt to compress them into one:
--
--   issued    → must have a date. That is the date on the document.
--   draft     → must not. Nothing has been issued.
--   cancelled → EITHER, and only the row knows which. A draft cancelled before
--               it went out has no date; an issued invoice that was withdrawn
--               keeps the one it went out with.
--
-- No data migration: the constraint is being RELAXED, so every existing row
-- already satisfies it. Verified before writing this.

SET ROLE bib_owner;

ALTER TABLE crm.invoice DROP CONSTRAINT invoice_issued_has_date_chk;

ALTER TABLE crm.invoice
  ADD CONSTRAINT invoice_issued_has_date_chk CHECK (
    (status = 'issued'    AND issued_on IS NOT NULL) OR
    (status = 'draft'     AND issued_on IS NULL)     OR
    (status = 'cancelled')
  );

COMMENT ON COLUMN crm.invoice.issued_on IS
  'The date on the document. NULL only while it is a draft — a cancelled invoice that was issued KEEPS its date, because it was issued and a copy is with the client.';

RESET ROLE;
