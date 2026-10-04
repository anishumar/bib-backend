-- Down for 0344. Newest-first, IF EXISTS throughout.
--
-- It puts D1's keys back, and those keys cannot hold a document whose lines are
-- in more than one currency. So while any such document exists, the down
-- REFUSES rather than deleting lines or rewriting prices, which would change
-- what a client was quoted or signed. Every document that was single-currency
-- reads exactly as before; their rate tables are empty.

DO $$
DECLARE
  mixed integer;
BEGIN
  SELECT count(*) INTO mixed FROM (
    SELECT 1 FROM crm.proposal_line l JOIN crm.proposal p ON p.id = l.proposal_id
     WHERE l.currency <> p.currency
    UNION ALL
    SELECT 1 FROM crm.engagement_letter_line l JOIN crm.engagement_letter el ON el.id = l.engagement_letter_id
     WHERE l.currency <> el.currency
    UNION ALL
    SELECT 1 FROM crm.engagement_letter_fee_group g JOIN crm.engagement_letter el ON el.id = g.engagement_letter_id
     WHERE g.currency <> el.currency
    UNION ALL
    SELECT 1 FROM crm.billing_due d JOIN crm.engagement_letter el ON el.id = d.engagement_letter_id
     WHERE d.currency <> el.currency
  ) x;
  IF mixed > 0 THEN
    RAISE EXCEPTION
      '0344 down refused: % lines, groups or advances are in a currency other than their document''s, and one currency per document cannot hold them.',
      mixed;
  END IF;
END $$;

SET ROLE bib_owner;

-- MRR at the letter's one rate, as 0083 had it.
CREATE OR REPLACE VIEW crm.engagement_mrr WITH (security_invoker = true) AS
WITH shares AS (
  SELECT l.id AS line_id,
         g.billing_frequency AS group_frequency,
         CASE
           WHEN row_number() OVER w < count(*) OVER w
             THEN round(g.amount / count(*) OVER w, 4)
           ELSE g.amount - round(g.amount / count(*) OVER w, 4) * (count(*) OVER w - 1)
         END AS share
  FROM crm.engagement_letter_line l
  JOIN crm.engagement_letter_fee_group g
    ON g.id = l.fee_group_id AND g.tenant_id = l.tenant_id
  WHERE l.removed_at IS NULL AND g.removed_at IS NULL
  WINDOW w AS (PARTITION BY g.id ORDER BY l.position
               ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
)
SELECT e.id                          AS engagement_id,
       e.tenant_id,
       e.party_id,
       e.entity_party_id,
       e.status,
       l.service_version_id,
       coalesce(s.group_frequency, l.billing_frequency) AS billing_frequency,
       l.currency,
       el.fx_rate,
       el.fx_rate_date,

       CASE
         WHEN s.line_id IS NOT NULL THEN s.share
         WHEN l.unit_amount IS NULL THEN NULL
         ELSE round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100), 4)
       END                           AS line_amount,

       CASE
         WHEN s.line_id IS NOT NULL THEN
           CASE s.group_frequency
             WHEN 'monthly'   THEN s.share
             WHEN 'quarterly' THEN round(s.share / 3, 4)
             WHEN 'annually'  THEN round(s.share / 12, 4)
             ELSE NULL
           END
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
         WHEN s.line_id IS NOT NULL THEN
           CASE s.group_frequency
             WHEN 'monthly'   THEN round(s.share * el.fx_rate, 4)
             WHEN 'quarterly' THEN round(s.share * el.fx_rate / 3, 4)
             WHEN 'annually'  THEN round(s.share * el.fx_rate / 12, 4)
             ELSE NULL
           END
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
         WHEN s.line_id IS NOT NULL THEN
           CASE s.group_frequency
             WHEN 'one_time' THEN 'one_time'
             WHEN 'custom'   THEN 'custom_frequency'
             ELSE NULL
           END
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
LEFT JOIN shares s ON s.line_id = l.id
WHERE l.removed_at IS NULL;

DROP TRIGGER IF EXISTS trg_billing_due_advance_currency ON crm.billing_due;
DROP FUNCTION IF EXISTS crm.refuse_advance_in_another_currency();
ALTER TABLE crm.billing_due DROP CONSTRAINT IF EXISTS billing_due_letter_fkey;
ALTER TABLE crm.billing_due
  ADD CONSTRAINT billing_due_letter_fkey
    FOREIGN KEY (engagement_letter_id, tenant_id, currency)
    REFERENCES crm.engagement_letter (id, tenant_id, currency);

DROP TRIGGER IF EXISTS trg_el_fx_rate_currencies ON crm.engagement_letter_fx_rate;
DROP TRIGGER IF EXISTS trg_el_fee_group_currencies ON crm.engagement_letter_fee_group;
DROP TRIGGER IF EXISTS trg_el_line_currencies ON crm.engagement_letter_line;
DROP TRIGGER IF EXISTS trg_el_currencies ON crm.engagement_letter;
DROP TRIGGER IF EXISTS trg_proposal_fx_rate_currencies ON crm.proposal_fx_rate;
DROP TRIGGER IF EXISTS trg_proposal_line_currencies ON crm.proposal_line;
DROP TRIGGER IF EXISTS trg_proposal_currencies ON crm.proposal;
DROP FUNCTION IF EXISTS crm.check_document_currencies_trigger();
DROP FUNCTION IF EXISTS crm.check_document_currencies(text, uuid);

ALTER TABLE crm.engagement_letter_line DROP CONSTRAINT IF EXISTS el_line_fee_group_fkey;
ALTER TABLE crm.engagement_letter_line
  ADD CONSTRAINT el_line_fee_group_fkey
    FOREIGN KEY (fee_group_id, engagement_letter_id, tenant_id)
    REFERENCES crm.engagement_letter_fee_group (id, engagement_letter_id, tenant_id);

ALTER TABLE crm.engagement_letter_fee_group DROP CONSTRAINT IF EXISTS el_fee_group_id_letter_tenant_currency_key;
ALTER TABLE crm.engagement_letter_fee_group DROP CONSTRAINT IF EXISTS el_fee_group_letter_fkey;
ALTER TABLE crm.engagement_letter_fee_group
  ADD CONSTRAINT el_fee_group_letter_fkey
    FOREIGN KEY (engagement_letter_id, tenant_id, currency)
    REFERENCES crm.engagement_letter (id, tenant_id, currency);

ALTER TABLE crm.engagement_letter_line DROP CONSTRAINT IF EXISTS el_line_letter_fkey;
ALTER TABLE crm.engagement_letter_line
  ADD CONSTRAINT el_line_letter_fkey
    FOREIGN KEY (engagement_letter_id, tenant_id, currency)
    REFERENCES crm.engagement_letter (id, tenant_id, currency);

-- 0312's shape: a draft's currency change carries its lines with it.
ALTER TABLE crm.proposal_line DROP CONSTRAINT IF EXISTS proposal_line_proposal_fkey;
ALTER TABLE crm.proposal_line
  ADD CONSTRAINT proposal_line_proposal_fkey
    FOREIGN KEY (proposal_id, tenant_id, currency)
    REFERENCES crm.proposal (id, tenant_id, currency)
    ON UPDATE CASCADE;

DROP TRIGGER IF EXISTS trg_proposal_fx_rate_parent_not_deleted ON crm.proposal_fx_rate;
DROP TRIGGER IF EXISTS trg_el_fx_rate_parent_not_deleted ON crm.engagement_letter_fx_rate;
DROP TRIGGER IF EXISTS trg_el_fx_rate_freeze ON crm.engagement_letter_fx_rate;
DROP TRIGGER IF EXISTS trg_el_fx_rate_updated_at ON crm.engagement_letter_fx_rate;
DROP TRIGGER IF EXISTS trg_proposal_fx_rate_updated_at ON crm.proposal_fx_rate;
DROP POLICY IF EXISTS engagement_letter_fx_rate_isolation ON crm.engagement_letter_fx_rate;
DROP POLICY IF EXISTS proposal_fx_rate_isolation ON crm.proposal_fx_rate;
DROP TABLE IF EXISTS crm.engagement_letter_fx_rate;
DROP TABLE IF EXISTS crm.proposal_fx_rate;

RESET ROLE;
