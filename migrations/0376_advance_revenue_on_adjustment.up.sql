-- 0376 · An advance is the revenue of the manager whose bill it is adjusted on (Q085, 2026-10-05).
--
-- 10x, asked whether an advance may be credited to a manager without a
-- service: "No, Invoice to be mapped to manager, not at advance stage." So an
-- advance is nobody's revenue when it is invoiced. It becomes a manager's when
-- it is ADJUSTED: when a service's bill takes some of it (0320's FIFO, 0363's
-- mappings), that part is the bill's manager's, counted on the day the bill
-- counts (its invoice's issue date, or the bill's own date when the advance
-- covered all of it and no invoice was needed). Unearned until then; the
-- same reclassification an accountant makes from "advance from clients" to
-- revenue.
--
-- `crm.invoice_manager_share` keeps its columns (0363) and gains `counts_on`
-- (appended): the day a row counts on, NULL for the invoice's own issue date.
-- Every row still belongs to one invoice, and an invoice's rows still add up
-- to its net:
--
--   invoice       an ordinary invoice, its whole net, to its manager (as before);
--   advance       an advance taken before the letter (0363), its whole net, to
--                 nobody;
--   advance_line  a letter's advance line (0320) moved off its invoice's
--                 manager onto nobody: one row minus, one row plus;
--   adjusted      on an ADVANCE's invoice, each part a bill took: plus to the
--                 bill's manager, minus to nobody, on the day the bill counts.
--
-- So "nobody" (the report's "Advances not yet adjusted") holds exactly what is
-- still unearned, and the firm's total for a period is still what it invoiced.
-- The mapping rows (0363's 'allocation' / 'unmapped') leave the view: a
-- mapping says where an advance WILL go, not that it has been earned.
--
-- `crm.advance_invoice`: the invoices that are advances, whose money and
-- balance the manager report also puts on nobody.

SET ROLE bib_owner;

CREATE OR REPLACE VIEW crm.invoice_manager_share WITH (security_invoker = true) AS
SELECT i.id AS invoice_id, i.tenant_id, i.manager_user_id, t.net AS net_share, 'invoice'::text AS basis,
       NULL::date AS counts_on
  FROM crm.invoice i
  JOIN crm.invoice_totals t ON t.invoice_id = i.id AND t.tenant_id = i.tenant_id
 WHERE NOT EXISTS (SELECT 1 FROM crm.adhoc_advance aa WHERE aa.invoice_id = i.id AND aa.tenant_id = i.tenant_id)
UNION ALL
SELECT i.id, i.tenant_id, NULL::uuid, t.net, 'advance', NULL::date
  FROM crm.adhoc_advance aa
  JOIN crm.invoice i ON i.id = aa.invoice_id AND i.tenant_id = aa.tenant_id
  JOIN crm.invoice_totals t ON t.invoice_id = i.id AND t.tenant_id = i.tenant_id
UNION ALL
SELECT i.id, i.tenant_id, x.manager_user_id, x.share, 'advance_line', NULL::date
  FROM crm.billing_due d
  JOIN crm.invoice i ON i.id = d.invoice_id AND i.tenant_id = d.tenant_id
  JOIN crm.invoice_line_amount la ON la.invoice_line_id = d.invoice_line_id AND la.tenant_id = d.tenant_id
  CROSS JOIN LATERAL (VALUES (i.manager_user_id, -la.net), (NULL::uuid, la.net)) AS x(manager_user_id, share)
 WHERE d.kind = 'advance' AND d.invoice_line_id IS NOT NULL
UNION ALL
SELECT d.advance_invoice_id, d.tenant_id, x.manager_user_id, x.share, 'adjusted', day.counts_on
  FROM crm.billing_due d
  LEFT JOIN crm.invoice bill ON bill.id = d.invoice_id AND bill.tenant_id = d.tenant_id
  CROSS JOIN LATERAL (
    SELECT CASE WHEN d.covered_at IS NOT NULL THEN d.bill_on
                WHEN bill.status = 'issued' THEN bill.issued_on
           END AS counts_on
  ) day
  CROSS JOIN LATERAL (VALUES (d.manager_user_id, d.advance_applied), (NULL::uuid, -d.advance_applied)) AS x(manager_user_id, share)
 WHERE d.kind <> 'advance'
   AND d.advance_invoice_id IS NOT NULL
   AND d.advance_applied > 0
   AND day.counts_on IS NOT NULL;

COMMENT ON VIEW crm.invoice_manager_share IS
  'Whose revenue each part of an invoice is, before tax (0363, 0376, Q085): an ordinary invoice its manager''s; an advance nobody''s until a bill takes some of it, then that part the bill''s manager''s on the day the bill counts (counts_on; NULL is the invoice''s issue date). An invoice''s rows add up to its net.';

CREATE VIEW crm.advance_invoice WITH (security_invoker = true) AS
SELECT aa.invoice_id, aa.tenant_id FROM crm.adhoc_advance aa
UNION
SELECT d.invoice_id, d.tenant_id FROM crm.billing_due d WHERE d.kind = 'advance' AND d.invoice_id IS NOT NULL;

COMMENT ON VIEW crm.advance_invoice IS
  'The invoices that are advances (0320''s letter advances, 0363''s ad-hoc ones). Their money and balance are nobody''s in the revenue by manager until adjusted (0376, Q085).';

GRANT SELECT ON crm.advance_invoice TO bib_app;

RESET ROLE;
