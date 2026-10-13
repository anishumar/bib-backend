SET ROLE bib_owner;

ALTER TABLE crm.proposal_line
  DROP CONSTRAINT IF EXISTS proposal_line_billing_on_chk,
  DROP CONSTRAINT IF EXISTS proposal_line_billing_timing_chk,
  DROP COLUMN IF EXISTS billing_on,
  DROP COLUMN IF EXISTS billing_timing;

RESET ROLE;
