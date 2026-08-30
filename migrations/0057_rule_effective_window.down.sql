-- Down for 0057.
--
-- Dropping these columns loses every cutover a firm has recorded, and the rules
-- on both sides of one then govern the SAME periods — which the generator will
-- happily materialise twice, because the re-run key is per template. So a firm
-- that has actually superseded a rule cannot roll this back without deciding
-- which of the two rows to retire, and that is a decision, not a migration.
--
-- Left as a plain drop rather than a refusal because the honest case for it is
-- a rollback minutes after deploy, before anybody has superseded anything.

SET ROLE bib_owner;

ALTER TABLE delivery.obligation_template
  DROP CONSTRAINT IF EXISTS obligation_template_window_chk;

ALTER TABLE delivery.obligation_template
  DROP COLUMN IF EXISTS effective_from,
  DROP COLUMN IF EXISTS effective_to;

RESET ROLE;
