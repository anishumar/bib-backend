-- Down for 0066. Newest-first, IF EXISTS throughout.
--
-- ORDER MATTERS ONCE HERE, and it is the reason this file is not a flat list of
-- drops: `document_portal_visible` REFERENCES `is_client_visible`, so it has to
-- go BEFORE the column can. Postgres would refuse the DROP COLUMN otherwise —
-- the database catching it rather than the migration being clever, but a down
-- that fails halfway has left the schema somewhere neither file describes.
--
-- 0063's `document_portal_scope` is NOT touched, up or down. The up added a
-- second policy beside it precisely so this file never has to restore somebody
-- else's text — a down that recreated it and failed would leave a database with
-- NO portal scope on `files.document` at all, which is the one direction a down
-- must never be able to go.

SET ROLE bib_owner;

DROP POLICY IF EXISTS document_portal_visible ON files.document;

DROP POLICY IF EXISTS credit_note_portal_scope ON crm.credit_note;
DROP POLICY IF EXISTS payment_portal_scope     ON crm.payment;
DROP POLICY IF EXISTS invoice_line_portal_scope ON crm.invoice_line;
DROP POLICY IF EXISTS invoice_portal_issued   ON crm.invoice;
DROP POLICY IF EXISTS invoice_portal_scope     ON crm.invoice;

DROP INDEX IF EXISTS files.idx_document_client_visible;

-- The backfill is not undone, because there is nothing left to undo it ON: the
-- column carrying it goes with this statement.
ALTER TABLE files.document DROP COLUMN IF EXISTS is_client_visible;

RESET ROLE;
