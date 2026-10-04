-- 0338: an engagement keeps the financial year its periods were first cut on.
--
-- Since 0337 each of the firm's companies may keep its own year, and the
-- billing sweep and the recurring-work scheduler re-cut every engagement's
-- periods from the company's year on every pass. So a company that moved from
-- April to January in October re-cut a yearly service already billed for
-- April 2026 to March 2027 into "2026" (January to December): a second bill
-- for months already billed, and a second yearly job beside the open one
-- (final review of 0337, finding #2).
--
-- THE YEAR IS PINNED WHEN IT IS FIRST USED, as a series' start_month is
-- (0337): when billing is scheduled (go-live, or set by hand) or when the
-- first recurring period is cut, whichever comes first, and never moved after.
-- A company's year change applies to engagements that start after it.
--
-- BACKFILL: an engagement already scheduled for billing or already holding a
-- period job was cut on the firm's year (no company had its own before 0337),
-- so it is pinned to the firm's published compliance-policy start month. A
-- firm that never published one keeps NULL: its quarters and years waited.
SET ROLE bib_owner;

ALTER TABLE crm.engagement
  ADD COLUMN year_start_month smallint
  CONSTRAINT engagement_year_start_month_check CHECK (year_start_month BETWEEN 1 AND 12);

COMMENT ON COLUMN crm.engagement.year_start_month IS
  'The month the financial year its billing and recurring work periods are cut on starts in, fixed '
  'when first used (billing scheduled, or the first period cut) and never moved: a later change of '
  'its company''s year applies to new engagements only (0338). NULL = not cut yet: the issuing '
  'company''s year, else the firm''s.';

UPDATE crm.engagement en
   SET year_start_month = (v.body ->> 'fiscalYearStartMonth')::smallint
  FROM config.entry e
  JOIN config.version v ON v.entry_id = e.id AND v.status = 'published'
 WHERE e.tenant_id = en.tenant_id
   AND e.kind = 'compliance_policy' AND e.key = 'default'
   AND jsonb_typeof(v.body -> 'fiscalYearStartMonth') = 'number'
   AND (v.body ->> 'fiscalYearStartMonth') ~ '^(1[0-2]|[1-9])$'
   AND (en.billing_from IS NOT NULL
        OR EXISTS (SELECT 1 FROM delivery.job_engagement je
                    WHERE je.engagement_id = en.id AND je.tenant_id = en.tenant_id
                      AND je.period_start IS NOT NULL));

RESET ROLE;
