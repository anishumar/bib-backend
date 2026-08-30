-- Down for 0051. Newest-first, IF EXISTS throughout, and it drops nothing
-- shared: `delivery.set_updated_at` is 0041's and every table in the schema
-- uses it, so the triggers go and the function stays. The four functions this
-- migration created ARE dropped — they exist only for these tables.
--
-- Undoing this takes every work item at every firm with it: who owned it, when
-- it was due, why it was blocked, and every review it went through. None of
-- that is reconstructible from the job tables, which know nothing about
-- assignees or due dates, and the honest thing is to say so rather than to
-- pretend the engagement rows could rebuild it.

SET ROLE bib_owner;

DROP TRIGGER IF EXISTS trg_work_item_approval_maker_frozen ON delivery.work_item_approval;
DROP TRIGGER IF EXISTS trg_work_item_approval_derive_maker ON delivery.work_item_approval;
DROP TRIGGER IF EXISTS trg_work_item_approval_updated_at ON delivery.work_item_approval;
DROP POLICY  IF EXISTS work_item_approval_isolation ON delivery.work_item_approval;
DROP INDEX   IF EXISTS delivery.idx_work_item_approval_work;
DROP INDEX   IF EXISTS delivery.idx_work_item_approval_pending;
DROP INDEX   IF EXISTS delivery.idx_work_item_approval_one_open;
DROP TABLE   IF EXISTS delivery.work_item_approval;
DROP FUNCTION IF EXISTS delivery.freeze_work_item_approval_maker();
DROP FUNCTION IF EXISTS delivery.derive_work_item_approval_maker();

DROP POLICY IF EXISTS work_item_dependency_isolation ON delivery.work_item_dependency;
DROP INDEX  IF EXISTS delivery.idx_work_item_dependency_blocker;
DROP INDEX  IF EXISTS delivery.idx_work_item_dependency_work;
DROP TABLE  IF EXISTS delivery.work_item_dependency;

DROP TRIGGER IF EXISTS trg_checklist_item_no_ticked_delete ON delivery.checklist_item;
DROP TRIGGER IF EXISTS trg_checklist_item_updated_at ON delivery.checklist_item;
DROP POLICY  IF EXISTS checklist_item_isolation ON delivery.checklist_item;
DROP INDEX   IF EXISTS delivery.idx_checklist_item_work;
DROP TABLE   IF EXISTS delivery.checklist_item;
DROP FUNCTION IF EXISTS delivery.refuse_ticked_checklist_delete();

DROP TRIGGER IF EXISTS trg_work_item_state_facts ON delivery.work_item;
DROP TRIGGER IF EXISTS trg_work_item_updated_at ON delivery.work_item;
DROP POLICY  IF EXISTS work_item_isolation ON delivery.work_item;
DROP INDEX   IF EXISTS delivery.idx_work_item_one_per_engagement;
DROP INDEX   IF EXISTS delivery.idx_work_item_job;
DROP INDEX   IF EXISTS delivery.idx_work_item_client;
DROP INDEX   IF EXISTS delivery.idx_work_item_due;
DROP INDEX   IF EXISTS delivery.idx_work_item_unassigned;
DROP INDEX   IF EXISTS delivery.idx_work_item_assignee_open;
DROP TABLE   IF EXISTS delivery.work_item;
DROP FUNCTION IF EXISTS delivery.enforce_work_item_state_facts();

RESET ROLE;
