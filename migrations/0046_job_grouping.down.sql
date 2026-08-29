-- Down for 0046. Newest-first, IF EXISTS throughout.
--
-- It refuses rather than destroys, in one case and deliberately. Narrowing
-- `job_source_kind_check` back to two kinds would leave every merged job
-- violating it, and the only way to make that succeed would be to delete jobs —
-- real delivery work, with steps somebody performed and a ledger that says so.
-- A down migration that quietly threw that away is worse than one that stops
-- and says what it found.
--
-- Restoring the plain `UNIQUE (tenant_id, source_kind, source_ref)` has the same
-- shape of problem for a different reason: a group whose job finished and was
-- succeeded by a second job for a later engagement is a legal state under 0046
-- and a duplicate under the constraint it replaced. Checked before it is
-- re-added, for the same reason.

SET ROLE bib_owner;

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM delivery.job WHERE source_kind = 'engagement_group';
  IF n > 0 THEN
    RAISE EXCEPTION
      'cannot undo 0046: % merged jobs exist (source_kind = engagement_group), and narrowing job_source_kind_check would leave rows violating it. These are jobs with steps people performed. Cancel and re-spawn that work deliberately first, or leave this migration applied.', n;
  END IF;

  SELECT count(*) INTO n FROM (
    SELECT 1 FROM delivery.job
    GROUP BY tenant_id, source_kind, source_ref
    HAVING count(*) > 1
  ) dup;
  IF n > 0 THEN
    RAISE EXCEPTION
      'cannot undo 0046: % causes have more than one job, which 0046 permits (a group whose job finished before a later engagement arrived) and the constraint being restored does not. Resolve those deliberately first, or leave this migration applied.', n;
  END IF;
END $$;

DROP POLICY IF EXISTS job_engagement_isolation ON delivery.job_engagement;
DROP INDEX IF EXISTS delivery.idx_job_engagement_job;
DROP TABLE IF EXISTS delivery.job_engagement;

DROP INDEX IF EXISTS delivery.idx_job_open_per_source;
ALTER TABLE delivery.job
  ADD CONSTRAINT job_tenant_id_source_kind_source_ref_key
    UNIQUE (tenant_id, source_kind, source_ref);

ALTER TABLE delivery.job
  DROP CONSTRAINT IF EXISTS job_split_code_needs_an_axis,
  DROP COLUMN IF EXISTS split_code,
  DROP COLUMN IF EXISTS split_axis;

ALTER TABLE delivery.job DROP CONSTRAINT job_source_kind_check;
ALTER TABLE delivery.job
  ADD CONSTRAINT job_source_kind_check
    CHECK (source_kind IN ('engagement', 'obligation'));

RESET ROLE;
