-- Down for 0047. Newest-first, IF EXISTS throughout.
--
-- It refuses rather than deletes, in one case. Narrowing `entry_kind_check` back
-- to six would leave every `confidence_tier` entry violating it, and those are
-- a firm's own decision about when a machine may act without anybody watching.
-- A down migration that silently discarded that is worse than one that stops.
--
-- Dropping the table is a different kind of loss and the exception cannot cover
-- it: `agent_run` is the only record that an unattended action happened, and
-- the only source of any accuracy figure. Undoing this takes both. That is the
-- honest consequence of undoing it, not something to work around.

SET ROLE bib_owner;

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM config.entry WHERE kind = 'confidence_tier';
  IF n > 0 THEN
    RAISE EXCEPTION
      'cannot undo 0047: % confidence_tier entries exist, and narrowing entry_kind_check would leave rows violating it. These are a firm''s own answer to when a machine may act unattended. Remove them deliberately first, or leave this migration applied.', n;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_agent_run_no_rewrite ON delivery.agent_run;
DROP TRIGGER IF EXISTS trg_agent_run_updated_at ON delivery.agent_run;
DROP POLICY IF EXISTS agent_run_isolation ON delivery.agent_run;
DROP INDEX IF EXISTS delivery.idx_agent_run_undecided;
DROP INDEX IF EXISTS delivery.idx_agent_run_step;
DROP TABLE IF EXISTS delivery.agent_run;
-- The function goes with its only table. `delivery.set_updated_at` is 0041's and
-- shared, so it stays.
DROP FUNCTION IF EXISTS delivery.refuse_agent_run_rewrite();

ALTER TABLE config.entry DROP CONSTRAINT entry_kind_check;
ALTER TABLE config.entry
  ADD CONSTRAINT entry_kind_check
    CHECK (kind IN ('service', 'role', 'policy', 'clause', 'dunning', 'workflow_template'));

RESET ROLE;
