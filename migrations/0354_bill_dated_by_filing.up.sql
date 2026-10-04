-- 0354: a yearly bill dated by its statutory filing (Q071, 2026-10-05).
--
-- Ashish, 4 Oct 2026 (Q071): most yearly work is statutory with a due date,
-- and its bill is made ON that due date (audit 30 September, GSTR-9
-- 31 December, UAE corporate tax nine months after the client's year end),
-- not on the last day of the year as every recurring period was (Q042).
--
-- So a yearly service whose catalogue entry carries yearly compliance rules
-- (T6.16, linked on the rule's lineage) is billed, for each of its billing
-- years, on the EARLIEST due date of that client company's yearly filings
-- that falls inside the year (the user, 2026-10-05: earliest, the first
-- deliverable). The bill names the FILING's year, not the billing year: the
-- audit billed on 30 September 2026 is the audit of FY 2025-26, and that is
-- how the firm invoices it.
--
-- This column records WHICH filing set the bill's day, so:
--   - the date is explained (the bill says why it is not the year's last day);
--   - Work vs Billing puts that filing under the bill it dated, not under the
--     billing year that holds the filing's own period;
--   - nothing re-derives it later from a calendar that may have moved.
--
-- NULL for every bill dated the ordinary way, including every bill written
-- before this migration: bills already made keep their day (history). Bills
-- are append-only for `bib_app` (INSERT, plus UPDATE of named columns), and
-- the table-level INSERT grant of 0318 covers the new column.
SET ROLE bib_owner;

ALTER TABLE crm.billing_due
  ADD COLUMN dated_by_filing_id uuid,
  ADD CONSTRAINT billing_due_dated_by_filing_fkey
    FOREIGN KEY (dated_by_filing_id, tenant_id)
    REFERENCES delivery.obligation_instance (id, tenant_id),
  -- Only a period bill is dated by a filing: an advance is dated by signing
  -- and a final bill by its job.
  ADD CONSTRAINT billing_due_dated_by_filing_kind_chk
    CHECK (dated_by_filing_id IS NULL OR kind = 'period');

COMMENT ON COLUMN crm.billing_due.dated_by_filing_id IS
  'The yearly statutory filing whose due date this yearly bill was made on (0354, Q071); NULL = dated by the schedule (the period''s last day, its start, or the letter''s own date).';

RESET ROLE;
