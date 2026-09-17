-- Down for 0300.
--
-- Restores the one-job-per-engagement world. It CANNOT succeed while any
-- `engagement_period` job exists: the narrower CHECK on `source_kind` refuses
-- them, and the two-column link key would refuse an engagement linked to
-- several months. That is the honest shape of rolling this back — the rows a
-- period job holds are real work on real desks, and a down that quietly threw
-- them away would be worse than one that stops. Cancel or remove those jobs
-- (and their links and umbrella tasks) deliberately, as bib_owner, first.

SET ROLE bib_owner;

DROP INDEX delivery.idx_work_item_one_per_engagement;
CREATE UNIQUE INDEX idx_work_item_one_per_engagement
  ON delivery.work_item (tenant_id, engagement_id)
  WHERE engagement_id IS NOT NULL;

ALTER TABLE delivery.job_engagement
  DROP CONSTRAINT job_engagement_one_job_per_engagement_period;
ALTER TABLE delivery.job_engagement
  ADD CONSTRAINT job_engagement_one_job_per_engagement UNIQUE (tenant_id, engagement_id);
ALTER TABLE delivery.job_engagement
  DROP COLUMN period_start;

ALTER TABLE delivery.job
  DROP CONSTRAINT job_period_matches_kind,
  DROP CONSTRAINT job_period_is_whole,
  DROP COLUMN period_start,
  DROP COLUMN period_end,
  DROP COLUMN period_label;

ALTER TABLE delivery.job DROP CONSTRAINT job_source_kind_check;
ALTER TABLE delivery.job
  ADD CONSTRAINT job_source_kind_check
    CHECK (source_kind IN ('engagement', 'obligation', 'engagement_group'));

RESET ROLE;
