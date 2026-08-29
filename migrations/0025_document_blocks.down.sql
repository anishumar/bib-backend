-- Reverses 0025. Newest first, IF EXISTS throughout. Drops nothing shared:
-- `crm.refuse_signed_child_change()` and `tenancy.set_updated_at()` are used by
-- the line and clause tables and by every table in the database respectively.
SET ROLE bib_owner;

DROP TRIGGER IF EXISTS trg_doc_block_freeze ON crm.document_block;
DROP TRIGGER IF EXISTS trg_doc_block_updated ON crm.document_block;
DROP TABLE IF EXISTS crm.document_block;

DROP TRIGGER IF EXISTS trg_std_block_updated ON crm.standard_document_block;
DROP TABLE IF EXISTS crm.standard_document_block;

RESET ROLE;
