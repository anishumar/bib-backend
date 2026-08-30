-- Down for 0053. Newest-first, IF EXISTS throughout.
--
-- Undoing this drops the generated calendar. That is recoverable in a way 0052's
-- down is not: every row here is derived, so re-applying and running one sweep
-- rebuilds it. What does NOT come back is the link to the tasks already raised
-- from it — a work item whose `obligation` produced it survives with nothing
-- pointing at it, and nobody can then say which filing it was for.
--
-- Run it knowing that, or run 0052's down as well and re-seed from scratch.

SET ROLE bib_owner;

DROP TRIGGER IF EXISTS trg_obligation_instance_updated_at ON delivery.obligation_instance;
DROP POLICY  IF EXISTS obligation_instance_isolation ON delivery.obligation_instance;
DROP INDEX   IF EXISTS delivery.idx_obligation_instance_unraised;
DROP INDEX   IF EXISTS delivery.idx_obligation_instance_engagement;
DROP INDEX   IF EXISTS delivery.idx_obligation_instance_template;
DROP INDEX   IF EXISTS delivery.idx_obligation_instance_entity;
DROP INDEX   IF EXISTS delivery.idx_obligation_instance_due;
DROP TABLE   IF EXISTS delivery.obligation_instance;

RESET ROLE;
