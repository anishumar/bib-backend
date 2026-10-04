-- 0319 down · Billing timing on letter lines and fee groups. Forgets what every
-- letter said about when it is billed, signed ones included.

SET ROLE bib_owner;

ALTER TABLE crm.engagement_letter_fee_group
  DROP CONSTRAINT el_fee_group_billing_on_chk,
  DROP CONSTRAINT el_fee_group_billing_timing_chk,
  DROP COLUMN billing_on,
  DROP COLUMN billing_timing;

ALTER TABLE crm.engagement_letter_line
  DROP CONSTRAINT el_line_billing_on_chk,
  DROP CONSTRAINT el_line_billing_timing_chk,
  DROP COLUMN billing_on,
  DROP COLUMN billing_timing;

RESET ROLE;
