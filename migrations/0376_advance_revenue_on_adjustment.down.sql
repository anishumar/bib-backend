-- 0376 down: the manager share as 0363 left it (split by the mappings at the
-- advance's own date). `counts_on` cannot leave a replaced view, so it stays,
-- always NULL.

SET ROLE bib_owner;

DROP VIEW crm.advance_invoice;

CREATE OR REPLACE VIEW crm.invoice_manager_share WITH (security_invoker = true) AS
SELECT i.id AS invoice_id, i.tenant_id, i.manager_user_id, t.net AS net_share, 'invoice'::text AS basis,
       NULL::date AS counts_on
  FROM crm.invoice i
  JOIN crm.invoice_totals t ON t.invoice_id = i.id AND t.tenant_id = i.tenant_id
 WHERE NOT EXISTS (SELECT 1 FROM crm.adhoc_advance aa WHERE aa.invoice_id = i.id AND aa.tenant_id = i.tenant_id)
UNION ALL
SELECT al.invoice_id, al.tenant_id, al.manager_user_id, sum(coalesce(al.kept_amount, al.amount)), 'allocation', NULL::date
  FROM crm.advance_allocation al
 GROUP BY al.invoice_id, al.tenant_id, al.manager_user_id
UNION ALL
SELECT i.id, i.tenant_id, i.manager_user_id, t.net - coalesce(m.mapped, 0), 'unmapped', NULL::date
  FROM crm.adhoc_advance aa
  JOIN crm.invoice i ON i.id = aa.invoice_id AND i.tenant_id = aa.tenant_id
  JOIN crm.invoice_totals t ON t.invoice_id = i.id AND t.tenant_id = i.tenant_id
  LEFT JOIN (
    SELECT al.adhoc_advance_id, al.tenant_id, sum(coalesce(al.kept_amount, al.amount)) AS mapped
      FROM crm.advance_allocation al
     GROUP BY al.adhoc_advance_id, al.tenant_id
  ) m ON m.adhoc_advance_id = aa.id AND m.tenant_id = aa.tenant_id;

RESET ROLE;
