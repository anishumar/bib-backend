-- 0363 down · the ad-hoc advance. The pool goes back to 0320's definition.

SET ROLE bib_owner;

DROP VIEW IF EXISTS crm.invoice_manager_share;

-- CREATE OR REPLACE cannot drop columns, so the view is dropped and made again.
DROP VIEW IF EXISTS crm.advance_pool;
CREATE VIEW crm.advance_pool WITH (security_invoker = true) AS
SELECT a.id AS advance_due_id,
       a.tenant_id,
       a.party_id,
       a.currency,
       a.engagement_letter_id,
       a.engagement_id,
       i.id     AS invoice_id,
       i.number AS invoice_number,
       t.net    AS invoice_net,
       t.total  AS invoice_total,
       coalesce(c.credited, 0) AS credited,
       least(coalesce(la.net, a.amount, t.net), t.net)
         - coalesce(c.credited, 0) * t.net / nullif(t.total, 0) AS advance_net,
       coalesce(u.applied, 0) AS applied,
       round(least(coalesce(la.net, a.amount, t.net), t.net)
         - coalesce(c.credited, 0) * t.net / nullif(t.total, 0)
         - coalesce(u.applied, 0), 2) AS remaining
  FROM crm.billing_due a
  JOIN crm.invoice i ON i.id = a.invoice_id AND i.tenant_id = a.tenant_id AND i.status = 'issued'
  JOIN crm.invoice_totals t ON t.invoice_id = i.id AND t.tenant_id = i.tenant_id
  LEFT JOIN crm.invoice_line_amount la
    ON la.invoice_line_id = a.invoice_line_id AND la.tenant_id = a.tenant_id
  LEFT JOIN (
    SELECT cn.invoice_id, cn.tenant_id, sum(cn.amount) AS credited
      FROM crm.credit_note cn
     GROUP BY cn.invoice_id, cn.tenant_id
  ) c ON c.invoice_id = i.id AND c.tenant_id = i.tenant_id
  LEFT JOIN (
    SELECT b.advance_invoice_id, b.tenant_id, sum(b.advance_applied) AS applied
      FROM crm.billing_due b
      LEFT JOIN crm.invoice bi ON bi.id = b.invoice_id AND bi.tenant_id = b.tenant_id
     WHERE b.advance_invoice_id IS NOT NULL
       AND b.skipped_at IS NULL
       AND (b.covered_at IS NOT NULL OR bi.status IN ('draft', 'issued'))
     GROUP BY b.advance_invoice_id, b.tenant_id
  ) u ON u.advance_invoice_id = i.id AND u.tenant_id = i.tenant_id
 WHERE a.kind = 'advance';
GRANT SELECT ON crm.advance_pool TO bib_app;
COMMENT ON VIEW crm.advance_pool IS
  'What is left of each advance on an issued invoice, before tax: its money, less credit notes at their pre-tax share, less what bills have taken from it (0320). Derived, never stored.';

ALTER TABLE tenancy.tenant DROP COLUMN IF EXISTS advance_unmapped_day;

DROP INDEX IF EXISTS crm.idx_billing_due_advance_allocation;
ALTER TABLE crm.billing_due
  DROP CONSTRAINT IF EXISTS billing_due_advance_allocation_chk,
  DROP CONSTRAINT IF EXISTS billing_due_advance_allocation_fkey,
  DROP COLUMN IF EXISTS advance_allocation_id;

DROP TABLE IF EXISTS crm.engagement_letter_advance;
DROP FUNCTION IF EXISTS crm.check_letter_names_own_advance();
DROP TABLE IF EXISTS crm.advance_allocation;
DROP FUNCTION IF EXISTS crm.refuse_advance_allocation_change();
DROP FUNCTION IF EXISTS crm.check_advance_allocation_target();
DROP TABLE IF EXISTS crm.adhoc_advance;

RESET ROLE;
