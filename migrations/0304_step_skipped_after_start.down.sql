-- 0304 down · back to 0044's rule: a skipped step carries no timestamps.
--
-- Refused while any row was skipped after it opened — the ADD below fails and,
-- because the new constraint is added under a temporary name FIRST, nothing is
-- dropped before the refusal. Clearing those start times is a decision about
-- history, not something a down migration should do quietly.
SET ROLE bib_owner;

ALTER TABLE delivery.job_step
  ADD CONSTRAINT job_step_timestamps_follow_status_0044 CHECK (
    (status IN ('pending', 'skipped') AND started_at IS NULL  AND finished_at IS NULL) OR
    (status IN ('running', 'blocked')  AND started_at IS NOT NULL AND finished_at IS NULL) OR
    (status IN ('done', 'failed')      AND started_at IS NOT NULL AND finished_at IS NOT NULL)
  );
ALTER TABLE delivery.job_step DROP CONSTRAINT IF EXISTS job_step_timestamps_follow_status;
ALTER TABLE delivery.job_step
  RENAME CONSTRAINT job_step_timestamps_follow_status_0044 TO job_step_timestamps_follow_status;

COMMENT ON COLUMN delivery.job_step.started_at IS NULL;

RESET ROLE;
