SET ROLE bib_owner;

DROP INDEX IF EXISTS delivery.idx_job_step_assignee_open;
ALTER TABLE delivery.job_step DROP CONSTRAINT IF EXISTS job_step_assignee_fkey;
ALTER TABLE delivery.job_step DROP COLUMN IF EXISTS assignee_user_id;

RESET ROLE;
