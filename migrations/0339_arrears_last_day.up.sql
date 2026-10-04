-- 0339: an arrears bill is made on its period's LAST day (Q042).
--
-- Ashish, 2026-10-04: "woh bill na aap 1st November ko na bana kar 31st
-- October ko hi banao ... last day of the period pe hum bill bana lete hain".
-- The bill is a reminder to invoice; the invoice raised from it takes the day
-- it is issued and its number then (0322), so nothing about the invoice moves.
--
-- From here `scheduleFor` sets an arrears schedule's first bill on the first
-- period's last day, and `billingDues` bills every period of a schedule that
-- starts that way on its own last day, read off the period (never "first plus
-- N months", which drifts: 30 November plus a month is 30 December).
--
-- THIS MOVES THE SCHEDULES ALREADY SET the same way: an arrears schedule (the
-- letter's word, the group's for a grouped line, or none, which is arrears)
-- whose first bill is exactly the day after its first period moves back one
-- day, to that period's last day. A letter that chose its own date, an
-- advance, and a day a person typed are left exactly as they are. Bills
-- already written keep their day (history). No ledger event: this is the
-- firm's rule changing, not a person's decision about one engagement.
--
-- Idempotent: a row moved no longer matches.
SET ROLE bib_owner;

UPDATE crm.engagement e
   SET first_invoice_on = e.first_invoice_on - 1
  FROM crm.engagement_letter_line ll
  LEFT JOIN crm.engagement_letter_fee_group g
    ON g.id = ll.fee_group_id AND g.tenant_id = ll.tenant_id
 WHERE ll.id = e.engagement_letter_line_id AND ll.tenant_id = e.tenant_id
   AND e.billing_from IS NOT NULL AND e.first_invoice_on IS NOT NULL
   AND coalesce(CASE WHEN g.id IS NOT NULL THEN g.billing_timing ELSE ll.billing_timing END, 'arrears') = 'arrears'
   AND e.first_invoice_on = (e.billing_from + CASE coalesce(g.billing_frequency, ll.billing_frequency)
                                                WHEN 'monthly'   THEN interval '1 month'
                                                WHEN 'quarterly' THEN interval '3 months'
                                                WHEN 'annually'  THEN interval '1 year'
                                              END)::date;

RESET ROLE;
