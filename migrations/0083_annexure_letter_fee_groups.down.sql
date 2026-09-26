-- Down for 0083. Newest-first, IF EXISTS everywhere, and it drops nothing
-- shared.
--
-- WHAT THIS LOSES, stated rather than discovered: every fee group and which
-- services each one covered, every letter's cover letter and acceptance
-- paragraphs, and the record of which letters print in the Annexure layout —
-- every letter goes back to the classic one, including drafts.
--
-- AND IT CAN REFUSE, which is correct, the way 0023's down can. Restoring
-- 0023's "an unpriced line says why" fails while a grouped line has no pricing
-- note, and restoring the block kinds fails while a cover or acceptance line
-- exists. There is no honest value to write into either — a retainer's share is
-- not a price anybody agreed to — so those rows need a person's decision before
-- the schema can go back to a shape that cannot hold them.

SET ROLE bib_owner;

-- The view first: it reads the fee groups below. 0038's definition, verbatim.
CREATE OR REPLACE VIEW crm.engagement_mrr WITH (security_invoker = true) AS
SELECT e.id                          AS engagement_id,
       e.tenant_id,
       e.party_id,
       e.entity_party_id,
       e.status,
       l.service_version_id,
       l.billing_frequency,
       l.currency,
       el.fx_rate,
       el.fx_rate_date,
       CASE
         WHEN l.unit_amount IS NULL THEN NULL
         ELSE round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100), 4)
       END                           AS line_amount,
       CASE
         WHEN l.unit_amount IS NULL THEN NULL
         WHEN l.billing_frequency = 'monthly'
           THEN round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100), 4)
         WHEN l.billing_frequency = 'quarterly'
           THEN round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100) / 3, 4)
         WHEN l.billing_frequency = 'annually'
           THEN round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100) / 12, 4)
         ELSE NULL
       END                           AS monthly_amount,
       CASE
         WHEN l.unit_amount IS NULL THEN NULL
         WHEN l.billing_frequency = 'monthly'
           THEN round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100) * el.fx_rate, 4)
         WHEN l.billing_frequency = 'quarterly'
           THEN round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100) * el.fx_rate / 3, 4)
         WHEN l.billing_frequency = 'annually'
           THEN round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100) * el.fx_rate / 12, 4)
         ELSE NULL
       END                           AS monthly_reporting,
       CASE
         WHEN l.unit_amount IS NULL                  THEN 'unpriced'
         WHEN l.billing_frequency IS NULL            THEN 'no_frequency_stated'
         WHEN l.billing_frequency = 'one_time'       THEN 'one_time'
         WHEN l.billing_frequency = 'custom'         THEN 'custom_frequency'
         ELSE NULL
       END                           AS excluded_because
FROM crm.engagement e
JOIN crm.engagement_letter_line l
  ON l.id = e.engagement_letter_line_id AND l.tenant_id = e.tenant_id
JOIN crm.engagement_letter el
  ON el.id = l.engagement_letter_id AND el.tenant_id = l.tenant_id
WHERE l.removed_at IS NULL;

COMMENT ON VIEW crm.engagement_mrr IS
  'One row per engagement, with its fee normalised to a month and converted at the rate stored on its letter. Derived, never stored. `excluded_because` names what could not be counted — a total that silently drops what it does not understand is worse than no total.';

-- The block kinds.
ALTER TABLE crm.document_block
  DROP CONSTRAINT IF EXISTS document_block_letter_only_kinds_chk,
  DROP CONSTRAINT IF EXISTS document_block_kind_check;
ALTER TABLE crm.document_block
  ADD CONSTRAINT document_block_kind_check
    CHECK (kind IN ('exclusion', 'commercial', 'team'));

ALTER TABLE crm.standard_document_block
  DROP CONSTRAINT IF EXISTS standard_document_block_kind_check;
ALTER TABLE crm.standard_document_block
  ADD CONSTRAINT standard_document_block_kind_check
    CHECK (kind IN ('exclusion', 'commercial', 'team'));

-- A line's membership, and the rule it widened.
DROP TRIGGER IF EXISTS trg_el_line_group_is_live ON crm.engagement_letter_line;
DROP FUNCTION IF EXISTS crm.refuse_line_in_removed_fee_group();
DROP INDEX IF EXISTS crm.idx_el_line_fee_group;

ALTER TABLE crm.engagement_letter_line
  DROP CONSTRAINT IF EXISTS el_line_unpriced_needs_reason_chk,
  DROP CONSTRAINT IF EXISTS el_line_grouped_is_unpriced_chk,
  DROP CONSTRAINT IF EXISTS el_line_fee_group_fkey;
ALTER TABLE crm.engagement_letter_line
  ADD CONSTRAINT el_line_unpriced_needs_reason_chk
    CHECK (unit_amount IS NOT NULL OR pricing_note IS NOT NULL);
ALTER TABLE crm.engagement_letter_line
  DROP COLUMN IF EXISTS fee_group_id;

-- The groups.
DROP TABLE IF EXISTS crm.engagement_letter_fee_group;
DROP FUNCTION IF EXISTS crm.refuse_fee_group_without_its_lines();

-- The layout.
ALTER TABLE crm.engagement_letter
  DROP CONSTRAINT IF EXISTS el_layout_chk,
  DROP COLUMN IF EXISTS layout;

RESET ROLE;
