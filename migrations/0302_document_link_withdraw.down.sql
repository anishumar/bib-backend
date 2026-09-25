-- 0302 · down. Withdrawn rows are DELETED here rather than kept, because the
-- original `document_link_once` constraint cannot be re-added over a history
-- that holds a withdrawn and a live link for the same pair. Run only against
-- a database somebody is rescuing; the withdrawals are gone with it.
SET ROLE bib_owner;

REVOKE UPDATE (withdrawn_at, withdrawn_by) ON files.document_link FROM bib_app;
DROP TRIGGER IF EXISTS document_link_withdrawn_is_final ON files.document_link;
DROP FUNCTION IF EXISTS files.refuse_withdrawn_link_change();

DELETE FROM files.document_link WHERE withdrawn_at IS NOT NULL;

DROP INDEX IF EXISTS files.document_link_once;
ALTER TABLE files.document_link
  ADD CONSTRAINT document_link_once
    UNIQUE (tenant_id, document_id, subject_kind, subject_ref);

ALTER TABLE files.document_link
  DROP CONSTRAINT IF EXISTS document_link_withdrawer_needs_withdrawal,
  DROP COLUMN IF EXISTS withdrawn_by,
  DROP COLUMN IF EXISTS withdrawn_at;

RESET ROLE;
