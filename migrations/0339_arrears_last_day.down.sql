-- Moves an arrears schedule whose first bill is its first period's last day
-- forward to the day after, as before 0339. A schedule set on the last day
-- after 0339 moves too: the code that reads it is gone with this down.
SET ROLE bib_owner;

UPDATE crm.engagement e
   SET first_invoice_on = e.first_invoice_on + 1
  FROM crm.engagement_letter_line ll
  LEFT JOIN crm.engagement_letter_fee_group g
    ON g.id = ll.fee_group_id AND g.tenant_id = ll.tenant_id
 WHERE ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
   AND e.billing_from IS NOT NULL AND e.first_invoice_on IS NOT NULL
   AND coalesce(CASE WHEN g.id IS NOT NULL THEN g.billing_timing ELSE ll.billing_timing END, 'arrears') = 'arrears'
   AND e.first_invoice_on + 1 = (e.billing_from + CASE coalesce(g.billing_frequency, ll.billing_frequency)
                                                    WHEN 'monthly'   THEN interval '1 month'
                                                    WHEN 'quarterly' THEN interval '3 months'
                                                    WHEN 'annually'  THEN interval '1 year'
                                                  END)::date;

RESET ROLE;
