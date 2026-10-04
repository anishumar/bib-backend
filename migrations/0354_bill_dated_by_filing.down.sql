-- Drops which filing dated a yearly bill. The bills keep their day; only the
-- reason for it is lost, and the code that reads it goes with this down.
SET ROLE bib_owner;

ALTER TABLE crm.billing_due
  DROP CONSTRAINT IF EXISTS billing_due_dated_by_filing_kind_chk,
  DROP CONSTRAINT IF EXISTS billing_due_dated_by_filing_fkey,
  DROP COLUMN IF EXISTS dated_by_filing_id;

RESET ROLE;
