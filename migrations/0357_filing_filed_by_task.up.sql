-- 0357 · Which task filed a filing (Q063, 2026-10-05)
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
--
-- 10x (Ashish, 2026-10-04): "Job marked as done means the return is being
-- filed." A recurring service's month task ("GST · Sep 2026") is the work the
-- firm marks done, and until now it filed nothing: a filing was filed only by
-- ITS OWN task (`work_item_id`, raised at T-X or linked by hand, CA#36). So
-- September's GSTR-1 and GSTR-3B stayed Pending after the job was finished,
-- then turned Missed, on the firm's calendar and on the client's portal.
--
-- Now completing a period job's task files every unfiled filing of that
-- company inside the job's period, of a rule the task's service carries. And
-- reopening the task must undo EXACTLY what it did: un-file the filings it
-- filed and never one somebody filed through its own task. That needs the
-- answer to "which task filed this", which `work_item_id` cannot give: the
-- job's task is not the filing's task, and the filing's own task may still be
-- open on a desk while the job has filed it.
--
-- ── THE COLUMN ──────────────────────────────────────────────────────────────
--
-- `filed_by_work_item_id`: the task whose completion filed this row. Set by the
-- one writer of `filed_on` (`ObligationService.reconcileFiling`, through
-- `markFiled`) and cleared with it. A task reopening un-files ONLY the rows
-- naming it, so:
--   · the job's task reopened  -> its filings go back to Pending;
--   · a filing's own task reopened after the JOB filed it -> nothing moves (it
--     would have un-filed a return that was filed, before this column).
-- Composite key to the task, the tenant wall's rule (0067's pattern).
--
-- ── BACKFILL ────────────────────────────────────────────────────────────────
--
-- Every row filed before this was filed by its own task (0054 and CA#36 are the
-- only writers), so a filed row with a task names that task. A filed row with
-- no task (none is known to exist) keeps NULL, and nothing reopening can then
-- un-file it, which is the safe direction for a statement about a filing.

SET ROLE bib_owner;

ALTER TABLE delivery.obligation_instance
  ADD COLUMN filed_by_work_item_id uuid;

ALTER TABLE delivery.obligation_instance
  ADD CONSTRAINT obligation_instance_filed_by_work_item_fkey
    FOREIGN KEY (filed_by_work_item_id, tenant_id)
    REFERENCES delivery.work_item (id, tenant_id);

-- Named the task that filed it only while it IS filed.
ALTER TABLE delivery.obligation_instance
  ADD CONSTRAINT obligation_instance_filed_by_needs_filed CHECK (
    filed_by_work_item_id IS NULL OR filed_on IS NOT NULL
  );

COMMENT ON COLUMN delivery.obligation_instance.filed_by_work_item_id IS
  'The task whose completion filed this row: its own task, or a period job''s task (Q063, 0357). '
  'Reopening a task un-files only the rows naming it. NULL while unfiled.';

UPDATE delivery.obligation_instance
   SET filed_by_work_item_id = work_item_id
 WHERE filed_on IS NOT NULL
   AND work_item_id IS NOT NULL;

-- What a reopened task asks: the rows it filed.
CREATE INDEX idx_obligation_instance_filed_by
  ON delivery.obligation_instance (tenant_id, filed_by_work_item_id)
  WHERE filed_by_work_item_id IS NOT NULL;

RESET ROLE;
