-- Down for 0063.
--
-- The two tables go, and with them every ask a firm has raised and every answer
-- a client has sent — which is the honest consequence of rolling back a feature
-- rather than something to soften. There is nothing to preserve them INTO.
--
-- ── THE SUBJECT-KIND CHECK IS PUT BACK, AND IT WILL FAIL IF IT MUST ───────
--
-- Narrowing the vocabulary again is refused by the database if any
-- `document_link` row already names `work_item` — an `ADD CONSTRAINT ... CHECK`
-- validates existing rows. That is deliberate and it is the same shape as
-- 0061's down: a rollback that silently dropped those links would leave files
-- attached to nothing, and a client's uploaded register would stop being
-- findable from the task it was uploaded against. Better to fail loudly and
-- make somebody decide.
--
-- The order matters. The response table's foreign keys point at the ask and at
-- `files.document`, and the ask's point at `delivery.work_item` — so children
-- first, then the unique constraints they were reaching for.

SET ROLE bib_owner;

DROP POLICY IF EXISTS document_link_portal_scope ON files.document_link;
DROP POLICY IF EXISTS document_version_portal_scope ON files.document_version;
DROP POLICY IF EXISTS document_portal_scope ON files.document;

DROP TABLE IF EXISTS delivery.client_ask_response;
DROP TABLE IF EXISTS delivery.client_ask;

ALTER TABLE files.document
  DROP CONSTRAINT IF EXISTS document_id_party_tenant_key;
ALTER TABLE delivery.work_item
  DROP CONSTRAINT IF EXISTS work_item_id_client_tenant_key;

ALTER TABLE files.document_link
  DROP CONSTRAINT IF EXISTS document_link_subject_kind_check;
ALTER TABLE files.document_link
  ADD CONSTRAINT document_link_subject_kind_check CHECK (subject_kind IN (
    'party', 'lead', 'proposal', 'engagement_letter',
    'engagement', 'invoice', 'job'
  ));

RESET ROLE;
