-- Down for 0023. Newest-first, IF EXISTS everywhere, and it drops nothing
-- shared.
--
-- WHAT THIS LOSES, stated rather than discovered: every jurisdiction, billing
-- frequency, tailored scope block, out-of-pocket estimate and pricing note
-- recorded since 0023 ran. The columns are the only place those facts live, and
-- the four overrides in particular are the WORDING an issued document carries —
-- dropping them puts every document back to printing whatever the catalogue
-- says today.
--
-- AND IT CAN REFUSE, which is correct. Restoring `unit_amount NOT NULL` fails
-- if any line was written without a price. There is no honest value to backfill
-- — zero is the statement this migration existed to stop anyone making — so the
-- failure is the answer: those lines have to be decided on by a person before
-- the schema can go back to a shape that cannot hold them.

SET ROLE bib_owner;

-- The view first: it reads the columns below.
DROP VIEW IF EXISTS crm.proposal_totals;
CREATE VIEW crm.proposal_totals WITH (security_invoker = true) AS
SELECT a.proposal_id,
       a.tenant_id,
       count(*)             AS line_count,
       sum(a.gross)         AS gross,
       sum(a.gross - a.net) AS discount,
       sum(a.net)           AS net
FROM crm.proposal_line_amount a
GROUP BY a.proposal_id, a.tenant_id;
GRANT SELECT ON crm.proposal_totals TO bib_app;

ALTER TABLE crm.engagement_letter_line
  DROP CONSTRAINT IF EXISTS el_line_oop_currency_chk,
  DROP CONSTRAINT IF EXISTS el_line_oop_range_chk,
  DROP CONSTRAINT IF EXISTS el_line_oop_is_whole_chk,
  DROP CONSTRAINT IF EXISTS el_line_unpriced_has_no_discount_chk,
  DROP CONSTRAINT IF EXISTS el_line_unpriced_needs_reason_chk,
  DROP CONSTRAINT IF EXISTS el_line_unit_amount_non_negative_chk,
  DROP CONSTRAINT IF EXISTS el_line_pricing_note_not_blank_chk,
  DROP CONSTRAINT IF EXISTS el_line_overrides_not_blank_chk,
  DROP CONSTRAINT IF EXISTS el_line_billing_frequency_chk,
  DROP CONSTRAINT IF EXISTS el_line_jurisdiction_chk,
  DROP COLUMN IF EXISTS pricing_note,
  DROP COLUMN IF EXISTS oop_currency,
  DROP COLUMN IF EXISTS oop_estimate_max,
  DROP COLUMN IF EXISTS oop_estimate_min,
  DROP COLUMN IF EXISTS exclusions_override,
  DROP COLUMN IF EXISTS volume_limits_override,
  DROP COLUMN IF EXISTS client_obligations_override,
  DROP COLUMN IF EXISTS scope_override,
  DROP COLUMN IF EXISTS billing_frequency,
  DROP COLUMN IF EXISTS jurisdiction,
  ALTER COLUMN unit_amount SET NOT NULL;

ALTER TABLE crm.proposal_line
  DROP CONSTRAINT IF EXISTS proposal_line_oop_currency_chk,
  DROP CONSTRAINT IF EXISTS proposal_line_oop_range_chk,
  DROP CONSTRAINT IF EXISTS proposal_line_oop_is_whole_chk,
  DROP CONSTRAINT IF EXISTS proposal_line_unpriced_has_no_discount_chk,
  DROP CONSTRAINT IF EXISTS proposal_line_unpriced_needs_reason_chk,
  DROP CONSTRAINT IF EXISTS proposal_line_unit_amount_non_negative_chk,
  DROP CONSTRAINT IF EXISTS proposal_line_pricing_note_not_blank_chk,
  DROP CONSTRAINT IF EXISTS proposal_line_overrides_not_blank_chk,
  DROP CONSTRAINT IF EXISTS proposal_line_billing_frequency_chk,
  DROP CONSTRAINT IF EXISTS proposal_line_jurisdiction_chk,
  DROP COLUMN IF EXISTS pricing_note,
  DROP COLUMN IF EXISTS oop_currency,
  DROP COLUMN IF EXISTS oop_estimate_max,
  DROP COLUMN IF EXISTS oop_estimate_min,
  DROP COLUMN IF EXISTS exclusions_override,
  DROP COLUMN IF EXISTS volume_limits_override,
  DROP COLUMN IF EXISTS client_obligations_override,
  DROP COLUMN IF EXISTS scope_override,
  DROP COLUMN IF EXISTS billing_frequency,
  DROP COLUMN IF EXISTS jurisdiction,
  ALTER COLUMN unit_amount SET NOT NULL;

RESET ROLE;
