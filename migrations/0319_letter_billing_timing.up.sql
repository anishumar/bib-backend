-- 0319 · When a recurring fee is billed, written into the engagement letter
--         (auto-invoice, phase 1b)
--
-- 0318 gave each engagement a billing schedule (`billing_from` +
-- `first_invoice_on`), set by hand on "Billing not set up". A schedule nobody
-- sets is a service delivered unbilled, which is the whole problem the feature
-- exists for. Ashish (2026-10-01): the billing terms are agreed at onboarding
-- and captured in the EL. So the letter says it, per line and per fee group,
-- and signing sets the schedule from it.
--
-- ── billing_timing ────────────────────────────────────────────────────────
--
--   'arrears'  after each period (October's work invoiced on 1 November):
--              the firm's default.
--   'advance'  at the start of each period (October's invoiced on 1 October).
--   'on_date'  on a date the firm chooses, `billing_on` (a yearly audit
--              invoiced in November); later invoices follow one span after.
--
-- NULL is a letter written before this, or a line nobody chose for: signing
-- treats it as 'arrears'. Nullable, and no default, on purpose: a NOT NULL or
-- a default would put a value on every letter already signed (CLAUDE.md: no
-- new NOT NULL on a letter line), and the signed letter's content hash prints
-- the timing only where it is set, so earlier letters hash the same.
--
-- A date goes with 'on_date' and only with it. Written with IS NOT DISTINCT
-- FROM because a CHECK that comes out NULL passes, and `NULL = 'on_date'` is
-- NULL: the plain `=` let a date sit beside no timing at all.
--
-- Frozen with the letter like every column: `crm.refuse_signed_child_change`
-- refuses any change to a line or group of a signed letter whatever the column.

SET ROLE bib_owner;

ALTER TABLE crm.engagement_letter_line
  ADD COLUMN billing_timing text,
  ADD COLUMN billing_on     date,
  ADD CONSTRAINT el_line_billing_timing_chk
    CHECK (billing_timing IS NULL OR billing_timing IN ('arrears', 'advance', 'on_date')),
  ADD CONSTRAINT el_line_billing_on_chk
    CHECK ((billing_timing IS NOT DISTINCT FROM 'on_date') = (billing_on IS NOT NULL));

ALTER TABLE crm.engagement_letter_fee_group
  ADD COLUMN billing_timing text,
  ADD COLUMN billing_on     date,
  ADD CONSTRAINT el_fee_group_billing_timing_chk
    CHECK (billing_timing IS NULL OR billing_timing IN ('arrears', 'advance', 'on_date')),
  ADD CONSTRAINT el_fee_group_billing_on_chk
    CHECK ((billing_timing IS NOT DISTINCT FROM 'on_date') = (billing_on IS NOT NULL));

COMMENT ON COLUMN crm.engagement_letter_line.billing_timing IS
  'When a recurring fee is invoiced (0319): arrears (after each period), advance (at its start) or on_date (billing_on, then one span after). NULL = not chosen; signing treats it as arrears.';
COMMENT ON COLUMN crm.engagement_letter_line.billing_on IS
  'The first invoice date when billing_timing is on_date (0319); NULL otherwise.';
COMMENT ON COLUMN crm.engagement_letter_fee_group.billing_timing IS
  'As engagement_letter_line.billing_timing, for a fee group (0319): a group is billed once.';
COMMENT ON COLUMN crm.engagement_letter_fee_group.billing_on IS
  'The first invoice date when billing_timing is on_date (0319); NULL otherwise.';

RESET ROLE;
