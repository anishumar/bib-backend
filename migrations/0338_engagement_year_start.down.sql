SET ROLE bib_owner;

ALTER TABLE crm.engagement DROP COLUMN IF EXISTS year_start_month;

RESET ROLE;
