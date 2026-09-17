-- 0300 · Recurring, non-statutory work comes round every period — one job per
--        period, and the two uniqueness rules that made that impossible relaxed
--        by exactly the width of a period
--
-- ── THE GAP THIS CLOSES ────────────────────────────────────────────────────
--
-- A monthly bookkeeping service is signed once and delivered twelve times a
-- year. Until now the engine turned an engagement into ONE job, which walked
-- the firm's process ONCE, and `job_engagement UNIQUE (tenant_id,
-- engagement_id)` guaranteed nothing could ever produce a second. The only
-- per-period machinery in the product is the compliance calendar (T3.2), and
-- it is for the LAW: its rows carry a statutory date, sit on the statutory
-- priority and land in the partner's missed-deadline queue. Bookkeeping is not
-- a filing, and the firm that asked for this excluded GST filing from it in
-- writing. So the first real client's first real service would have run its
-- ten-step checklist in the month it was signed and never again.
--
-- The design is the one every practice-management tool in this market uses —
-- a template, a repeat, a fresh copy per period named for the period — and
-- the first number in `(B)`'s 0300–0400 block.
--
-- ── WHAT CHANGES, AND WHAT DELIBERATELY DOES NOT ───────────────────────────
--
--   · a FOURTH job kind, `engagement_period`. Its `source_ref` is derived from
--     the group key AND the period, so a redelivered sweep conflicts on the
--     open-job index instead of building a second checklist for the same
--     month. The three existing kinds keep their meaning byte for byte.
--   · the PERIOD on the job — start, end and the label a person calls it
--     ("Sep 2026", "Q2 FY2026-27"). Copied at spawn rather than derived, for
--     the reason `split_code` already argues: the board renders it on every
--     card, and it must not move when a firm re-files a service.
--   · the link table's absolute rule becomes "one engagement, one job PER
--     PERIOD". `NULLS NOT DISTINCT` is what keeps the old rule absolute for
--     every one-time engagement: a null period is one value, not a wildcard,
--     so two null-period links for one engagement still collide exactly as
--     they did under the two-column key.
--   · the work item's one-per-engagement index gains the job, because a
--     monthly engagement now has one umbrella task per month, each on its own
--     job. Ad hoc work is still unconstrained — the predicate is unchanged.
--
-- The obligation engine is untouched. A statutory filing keeps its calendar
-- row; what it gains is a checklist per period, which is what its process was
-- written for.

SET ROLE bib_owner;

-- ── the fourth kind ──────────────────────────────────────────────────────────
ALTER TABLE delivery.job DROP CONSTRAINT job_source_kind_check;
ALTER TABLE delivery.job
  ADD CONSTRAINT job_source_kind_check
    CHECK (source_kind IN ('engagement', 'obligation', 'engagement_group', 'engagement_period'));

-- ── the period, on the job ───────────────────────────────────────────────────
--
-- `date` columns and not timestamps: a period is a calendar fact in the
-- firm's own year, and "which month is this job for" has no instant in it.
-- `runnable_at` stays the one instant, resolved from the period's end in the
-- firm's own time zone by the service that writes it.
ALTER TABLE delivery.job
  ADD COLUMN period_start date,
  ADD COLUMN period_end   date,
  ADD COLUMN period_label text,
  -- All three or none. A job that knew its start but not its label would
  -- render as a blank on the board, and a label with no dates could not be
  -- deduplicated against.
  ADD CONSTRAINT job_period_is_whole CHECK (
    (period_start IS NULL) = (period_end IS NULL)
    AND (period_start IS NULL) = (period_label IS NULL)
    AND (period_start IS NULL OR period_start <= period_end)
  ),
  -- The kind and the period agree: a period job always has one, nothing else
  -- ever does. Two facts that could drift are made one fact.
  ADD CONSTRAINT job_period_matches_kind CHECK (
    (source_kind = 'engagement_period') = (period_start IS NOT NULL)
  );

-- ── one engagement, one job PER PERIOD ───────────────────────────────────────
ALTER TABLE delivery.job_engagement
  ADD COLUMN period_start date;

ALTER TABLE delivery.job_engagement
  DROP CONSTRAINT job_engagement_one_job_per_engagement;

-- NULLS NOT DISTINCT (Postgres 15+; this product runs 17). Without it the
-- three-column key would let a one-time engagement be linked twice, because a
-- plain UNIQUE treats every NULL as a fresh value — and that is precisely the
-- at-least-once duplicate the old two-column rule existed to refuse.
ALTER TABLE delivery.job_engagement
  ADD CONSTRAINT job_engagement_one_job_per_engagement_period
    UNIQUE NULLS NOT DISTINCT (tenant_id, engagement_id, period_start);

-- ── one umbrella task per engagement PER JOB ─────────────────────────────────
--
-- Every existing engagement-bearing work item has exactly one job, so the
-- three-column index holds over the rows already there. The predicate is
-- unchanged: ad hoc work carries no engagement and is not covered.
DROP INDEX delivery.idx_work_item_one_per_engagement;
CREATE UNIQUE INDEX idx_work_item_one_per_engagement
  ON delivery.work_item (tenant_id, engagement_id, job_id) NULLS NOT DISTINCT
  WHERE engagement_id IS NOT NULL;

RESET ROLE;
