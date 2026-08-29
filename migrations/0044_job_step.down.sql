-- Down for 0044. Newest-first, IF EXISTS throughout, and it drops nothing
-- shared: `delivery.set_updated_at` is 0041's and every table in the schema uses
-- it, so the trigger goes and the function stays.
--
-- Undoing this takes every job's step history with it — what was done, what was
-- skipped and why, and who did it. There is nowhere else it lives, and that is
-- the honest consequence of undoing this rather than something to work around.
--
-- The kind CHECK goes back to 0033's five. Any `workflow_template` entry a firm
-- has published would then violate it, so this refuses rather than deleting the
-- firm's own process: a down migration that silently discarded config a partner
-- wrote is worse than one that stops.

SET ROLE bib_owner;

DROP TRIGGER IF EXISTS trg_job_step_updated_at ON delivery.job_step;
DROP POLICY IF EXISTS job_step_isolation ON delivery.job_step;
DROP INDEX IF EXISTS delivery.idx_job_step_open;
DROP INDEX IF EXISTS delivery.idx_job_step_job;
DROP TABLE IF EXISTS delivery.job_step;

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM config.entry WHERE kind = 'workflow_template';
  IF n > 0 THEN
    RAISE EXCEPTION
      'cannot undo 0044: % workflow_template entries exist, and narrowing entry_kind_check would leave rows violating it. These are processes a firm wrote. Remove them deliberately first, or leave this migration applied.', n;
  END IF;
END $$;

ALTER TABLE config.entry DROP CONSTRAINT entry_kind_check;
ALTER TABLE config.entry
  ADD CONSTRAINT entry_kind_check
    CHECK (kind IN ('service', 'role', 'policy', 'clause', 'dunning'));

RESET ROLE;
