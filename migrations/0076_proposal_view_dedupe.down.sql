-- Down for 0076.
--
-- The column is the only thing added, and it holds no fact that is not either
-- derivable (`first_viewed_at` for a proposal viewed once) or purely
-- operational. Dropping it returns `view_count` to counting requests, which is
-- what it counted before.
SET ROLE bib_owner;

ALTER TABLE crm.proposal
  DROP COLUMN last_viewed_at;

RESET ROLE;
