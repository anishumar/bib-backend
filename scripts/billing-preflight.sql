-- Billing preflight: READ-ONLY. Run it BEFORE anyone switches "Automatic billing" ON for a firm.
-- (Audit 2026-10-03, billing cluster; moved into the repo from Shrestha's workspace on 2026-10-04
-- so the person deploying has it. Release note: docs/deploy/release-2026-10-04.md.)
--
-- How to run (it reads every firm, so it needs the OWNER, not bib_app):
--   local:  docker exec -i bib-postgres psql -U postgres -d bib -f - < scripts/billing-preflight.sql
--   QA:     psql "<the bib-owner-database-url secret>" -f scripts/billing-preflight.sql
--           (through the Cloud SQL Auth Proxy from your machine; see docs/deploy/runbook.md)
--
-- The script does SET ROLE bib_owner: the tables' owner is not filtered by RLS (FORCE RLS is
-- not on). CHECK THE FIRST LINE OF OUTPUT: if "firms visible" is 0, RLS is hiding the rows and
-- every other answer below is a false "all clear".
-- Nothing here writes.

SET ROLE bib_owner;

\echo '== Visibility check: firms visible (must be more than 0)'
SELECT count(*) AS "firms visible" FROM tenancy.tenant;

\echo '== B02: invoices whose total changes when each line is rounded to whole paise (0325)'
WITH old AS (
  SELECT l.invoice_id,
         sum(round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100), 4)
           + round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100) * l.tax_percent / 100, 4)) AS total
    FROM crm.invoice_line l WHERE l.removed_at IS NULL GROUP BY l.invoice_id
), new AS (
  SELECT l.invoice_id,
         sum(round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100), 2)
           + round(round(l.quantity * l.unit_amount * (1 - l.discount_percent / 100), 2) * l.tax_percent / 100, 2)) AS total
    FROM crm.invoice_line l WHERE l.removed_at IS NULL GROUP BY l.invoice_id
)
SELECT i.status, count(*) AS invoices, max(abs(o.total - n.total)) AS largest_change
  FROM old o JOIN new n USING (invoice_id) JOIN crm.invoice i ON i.id = o.invoice_id
 WHERE o.total <> n.total
 GROUP BY i.status ORDER BY i.status;

\echo '== B51: drafts that still hold a number drawn before 0322'
SELECT count(*) AS numbered_drafts,
       count(DISTINCT tenant_id) AS firms,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM crm.invoice j
          WHERE j.tenant_id = d.tenant_id AND j.entity_party_id = d.entity_party_id
            AND j.financial_year = d.financial_year AND j.status IN ('issued', 'cancelled')
            AND j.issued_on IS NOT NULL AND j.sequence_number > d.sequence_number)) AS would_issue_out_of_order
  FROM crm.invoice d
 WHERE d.status = 'draft' AND d.number IS NOT NULL;

\echo '== B51: the same, per firm (top 10)'
SELECT t.name, count(*) AS numbered_drafts, min(d.created_at)::date AS oldest
  FROM crm.invoice d JOIN tenancy.tenant t ON t.id = d.tenant_id
 WHERE d.status = 'draft' AND d.number IS NOT NULL
 GROUP BY t.name ORDER BY 2 DESC LIMIT 10;

\echo '== B03: issued invoices whose year is not the year of their issue date (1 April)'
SELECT count(*) FROM crm.invoice
 WHERE status = 'issued' AND financial_year <> crm.financial_year_of(issued_on);

\echo '== B05: cancelled invoices with money on them'
SELECT count(*) AS cancelled_with_payments, coalesce(sum(p.paid), 0) AS money
  FROM crm.invoice i
  JOIN (SELECT invoice_id, sum(amount) AS paid FROM crm.payment GROUP BY invoice_id) p ON p.invoice_id = i.id
 WHERE i.status = 'cancelled' AND p.paid <> 0;

\echo '== B06: advances already credited below zero'
SELECT count(*) FROM crm.advance_pool WHERE remaining < 0;

\echo '== B07: invoices in another currency than the firm reports in, at a rate of exactly 1'
SELECT i.status, count(*) FROM crm.invoice i JOIN tenancy.tenant t ON t.id = i.tenant_id
 WHERE i.currency <> t.reporting_currency AND i.fx_rate = 1 GROUP BY i.status;

\echo '== B21: drafts whose due date has already passed (they will be refused at issue until changed)'
SELECT count(*) FROM crm.invoice WHERE status = 'draft' AND due_on < current_date;

\echo '== F03 WARNING: signed letters with a quantity other than 1 on a recurring line'
\echo '   (each bills quantity x fee EVERY period once automatic billing is on)'
SELECT t.name AS firm, l.ref AS letter, l.status, ll.description, ll.billing_frequency,
       ll.quantity, ll.unit_amount, ll.discount_percent,
       round(ll.quantity * ll.unit_amount * (1 - ll.discount_percent / 100), 2) AS bills_each_period
  FROM crm.engagement_letter_line ll
  JOIN crm.engagement_letter l ON l.id = ll.engagement_letter_id AND l.tenant_id = ll.tenant_id
  JOIN tenancy.tenant t ON t.id = l.tenant_id
 WHERE ll.removed_at IS NULL
   AND ll.quantity <> 1
   AND ll.billing_frequency IN ('monthly', 'quarterly', 'annually')
   AND l.status = 'signed'
 ORDER BY t.name, l.ref, ll.position;
