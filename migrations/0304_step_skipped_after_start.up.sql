-- 0304 · A step can stop applying AFTER it has opened, and the row says so
--
-- ── THE GAP ────────────────────────────────────────────────────────────────
--
-- A step's condition was judged ONCE, at the moment the step would start. Its
-- facts are not frozen there: the recurrence comes from the service, which is
-- read LIVE (T2.7), and the jurisdiction from the entity's registration, which
-- a firm corrects. So a step can sit on somebody's desk long after the firm's
-- own rule stopped applying to it — "annual summary" on a client the firm has
-- since moved to monthly — and the only way off the desk was to tick it done,
-- which records work nobody did.
--
-- The orchestrator now re-judges an OPENED step on every walk and skips it
-- when its condition definitely fails and nobody has recorded any work on it
-- (see `OrchestratorService.applyConditions`). That needs one thing this
-- table refused.
--
-- ── WHY THE CHECK MOVES ────────────────────────────────────────────────────
--
-- 0044 wrote `skipped` with NEITHER timestamp: "a step that was never going to
-- happen did not start and did not finish". True of a step skipped before it
-- opened, and false of this one — it DID open, it sat on a desk, and "why was
-- this on my list for three days and then gone" is answered by exactly the
-- start time the old CHECK forced the row to throw away.
--
-- So a skipped step may now carry `started_at` — the day it opened — and still
-- never carries `finished_at`. The second half is 0044's reason unchanged: a
-- finish time on a skip would make "when did this job's work end" answer with
-- the moment somebody's step stopped applying.
--
-- `performed_by` is untouched: `job_step_skipped_has_no_performer` still says
-- nobody performs a skip, and the orchestrator only skips a step no work was
-- recorded on.

SET ROLE bib_owner;

ALTER TABLE delivery.job_step DROP CONSTRAINT job_step_timestamps_follow_status;

ALTER TABLE delivery.job_step
  ADD CONSTRAINT job_step_timestamps_follow_status CHECK (
    (status = 'pending'                AND started_at IS NULL     AND finished_at IS NULL) OR
    (status = 'skipped'                                           AND finished_at IS NULL) OR
    (status IN ('running', 'blocked')  AND started_at IS NOT NULL AND finished_at IS NULL) OR
    (status IN ('done', 'failed')      AND started_at IS NOT NULL AND finished_at IS NOT NULL)
  );

COMMENT ON COLUMN delivery.job_step.started_at IS
  'When the step opened. On a skipped step: set only if it was skipped AFTER it opened (0304).';

RESET ROLE;
