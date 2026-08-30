-- Down for 0050. Newest-first, IF EXISTS throughout, and it drops nothing
-- shared: `delivery.set_updated_at` is 0041's and every table in the schema
-- uses it, so the triggers go and the function stays.
--
-- Undoing this takes the firm's own vocabulary with it — the names it typed,
-- the order it arranged them in, and which state it decided means "stuck".
-- None of that exists anywhere else, and that is the honest consequence of
-- undoing this rather than something to work around: the seed can restore the
-- product's eight names, never the firm's.
--
-- It will also REFUSE while 0051 is applied, because `delivery.work_item`
-- carries foreign keys into both tables. That is correct and deliberate: down
-- migrations run newest-first, so 0051's down goes first and this one then
-- succeeds. A CASCADE here would silently take every work item at every firm.

SET ROLE bib_owner;

DROP TRIGGER IF EXISTS trg_work_item_priority_updated_at ON delivery.work_item_priority;
DROP POLICY  IF EXISTS work_item_priority_isolation ON delivery.work_item_priority;
DROP INDEX   IF EXISTS delivery.idx_work_item_priority_rank;
DROP INDEX   IF EXISTS delivery.idx_work_item_priority_one_statutory_default;
DROP INDEX   IF EXISTS delivery.idx_work_item_priority_one_default;
DROP TABLE   IF EXISTS delivery.work_item_priority;

DROP TRIGGER IF EXISTS trg_work_item_state_updated_at ON delivery.work_item_state;
DROP POLICY  IF EXISTS work_item_state_isolation ON delivery.work_item_state;
DROP INDEX   IF EXISTS delivery.idx_work_item_state_order;
DROP INDEX   IF EXISTS delivery.idx_work_item_state_one_initial;
DROP TABLE   IF EXISTS delivery.work_item_state;

RESET ROLE;
