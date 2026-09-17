-- 0301 · Whose desk a step sits on
--
-- ── THE GAP THIS CLOSES ────────────────────────────────────────────────────
--
-- A job's steps (0044) record who DID a step — `performed_by`, written at
-- completion — and nothing about who is EXPECTED to. The template says "a
-- person"; the firm's first real process says "Analyst / Associate / Senior
-- Associate" on eight of ten steps and "Manager" on the ninth, and the only
-- routing the product had was the month's umbrella task landing on the Dept
-- SPOC. Every step of every job was therefore on everybody's desk and on
-- nobody's: any member of staff could tick any step, and the analyst who was
-- meant to open the cycle had no screen that said so. "Who does what" was
-- being decided on WhatsApp, which is the thing this product replaces.
--
-- One nullable column. The template step carries the BAND (a grade range, in
-- the body, no DDL); the job step carries the PERSON. It is written at job
-- start (the Dept SPOC, when they are inside the band), moved by a hand-over
-- or by somebody taking the step, and read by the "steps on your desk" list.
-- Completing a step that sits on somebody else's desk is refused by the
-- service, not here: the database cannot know who is asking.
--
-- The FK is to the GLOBAL user table by id alone, exactly as `performed_by`
-- is on the same row (0044) and `assignee_user_id` on `work_item` (0051):
-- identity is above tenant (ADR-02), and "is this person a member of THIS
-- firm" is the service's question, asked of the roster.

SET ROLE bib_owner;

ALTER TABLE delivery.job_step
  ADD COLUMN assignee_user_id uuid;

ALTER TABLE delivery.job_step
  ADD CONSTRAINT job_step_assignee_fkey
    FOREIGN KEY (assignee_user_id) REFERENCES tenancy.user_account (id);

-- "What is on my desk" — the one read this column exists for. Partial on the
-- open states, because a finished step is nobody's desk any more.
CREATE INDEX idx_job_step_assignee_open
  ON delivery.job_step (tenant_id, assignee_user_id)
  WHERE assignee_user_id IS NOT NULL
    AND status IN ('pending', 'running', 'blocked');

COMMENT ON COLUMN delivery.job_step.assignee_user_id IS
  'Whose desk this step sits on — expected to do it, as distinct from performed_by, who did. '
  'Null means nobody in particular: anybody inside the template step''s grade band may take it.';

RESET ROLE;
