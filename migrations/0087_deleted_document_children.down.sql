-- Reverses 0087. Re-runnable. Nothing to restore: the guard only refused, so
-- taking it away changes no row. 0086's services still refuse the same changes
-- to lines, clauses and fee groups; a deleted draft's prose goes back to being
-- guarded by the page alone.
SET ROLE bib_owner;

DROP TRIGGER IF EXISTS trg_doc_block_parent_not_deleted ON crm.document_block;
DROP TRIGGER IF EXISTS trg_el_fee_group_parent_not_deleted ON crm.engagement_letter_fee_group;
DROP TRIGGER IF EXISTS trg_el_clause_parent_not_deleted ON crm.engagement_letter_clause;
DROP TRIGGER IF EXISTS trg_el_line_parent_not_deleted ON crm.engagement_letter_line;
DROP TRIGGER IF EXISTS trg_proposal_line_parent_not_deleted ON crm.proposal_line;
DROP FUNCTION IF EXISTS crm.refuse_change_under_deleted_document();

RESET ROLE;
