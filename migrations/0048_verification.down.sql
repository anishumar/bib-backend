-- Down for 0048. Newest-first, IF EXISTS throughout.
--
-- It REFUSES rather than deletes, in one case, for 0047's reason: narrowing
-- `entry_kind_check` back to seven would leave every `verification_policy`
-- entry violating it, and those are a firm's own answer to who may sign off its
-- work. A down migration that silently discarded that is worse than one that
-- stops.
--
-- Dropping `step_approval` is a different kind of loss and the exception cannot
-- cover it: it is the only record that anybody's work was ever checked, and the
-- only place a rejection's reason is kept. Undoing this takes both, which is
-- the honest consequence of undoing it rather than something to work around.
--
-- `membership.reports_to_user_id` goes with it, and takes the firm's reporting
-- line with it — a fact nothing else in this schema holds.

SET ROLE bib_owner;

DO $mig$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM config.entry WHERE kind = 'verification_policy';
  IF n > 0 THEN
    RAISE EXCEPTION
      'cannot undo 0048: % verification_policy entries exist, and narrowing entry_kind_check would leave rows violating it. These are a firm''s own answer to who may check whose work. Remove them deliberately first, or leave this migration applied.', n;
  END IF;
END $mig$;

DROP TRIGGER IF EXISTS trg_step_approval_maker_frozen ON delivery.step_approval;
DROP TRIGGER IF EXISTS trg_step_approval_derive_maker ON delivery.step_approval;
DROP TRIGGER IF EXISTS trg_step_approval_updated_at ON delivery.step_approval;
DROP POLICY IF EXISTS step_approval_isolation ON delivery.step_approval;
DROP INDEX IF EXISTS delivery.idx_step_approval_job;
DROP INDEX IF EXISTS delivery.idx_step_approval_pending;
DROP INDEX IF EXISTS delivery.idx_step_approval_one_open;
DROP TABLE IF EXISTS delivery.step_approval;
-- Both functions go with their only table. `delivery.set_updated_at` is 0041's
-- and shared, so it stays.
DROP FUNCTION IF EXISTS delivery.freeze_step_approval_maker();
DROP FUNCTION IF EXISTS delivery.derive_step_approval_maker();

DROP INDEX IF EXISTS tenancy.idx_membership_reports_to;
ALTER TABLE tenancy.membership DROP CONSTRAINT IF EXISTS membership_reports_to_is_not_self;
ALTER TABLE tenancy.membership DROP CONSTRAINT IF EXISTS membership_reports_to_fkey;
ALTER TABLE tenancy.membership DROP COLUMN IF EXISTS reports_to_user_id;

ALTER TABLE config.entry DROP CONSTRAINT entry_kind_check;
ALTER TABLE config.entry
  ADD CONSTRAINT entry_kind_check
    CHECK (kind IN ('service', 'role', 'policy', 'clause', 'dunning',
                    'workflow_template', 'confidence_tier'));

RESET ROLE;
