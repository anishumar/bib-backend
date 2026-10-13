-- 0393: when a quoted recurring fee is invoiced, chosen with the service.
--
-- The letter has carried this since 0319, but it could only be set on the
-- letter's draft, so a firm chose it after the quote had been agreed (the
-- user, 2026-10-13). The proposal line carries the same two columns and the
-- letter drafted from it takes them. Neither document prints them: the client
-- sees how often the work is billed, not on which day the invoice is raised.

SET ROLE bib_owner;

ALTER TABLE crm.proposal_line
  ADD COLUMN billing_timing text,
  ADD COLUMN billing_on     date,
  ADD CONSTRAINT proposal_line_billing_timing_chk
    CHECK (billing_timing IS NULL OR billing_timing IN ('arrears', 'advance', 'on_date')),
  ADD CONSTRAINT proposal_line_billing_on_chk
    CHECK ((billing_timing IS NOT DISTINCT FROM 'on_date') = (billing_on IS NOT NULL));

COMMENT ON COLUMN crm.proposal_line.billing_timing IS
  'As engagement_letter_line.billing_timing (0393): arrears, advance or on_date; copied to the letter drafted from the proposal. NULL = not chosen.';
COMMENT ON COLUMN crm.proposal_line.billing_on IS
  'The first invoice date when billing_timing is on_date (0393); NULL otherwise.';

RESET ROLE;
