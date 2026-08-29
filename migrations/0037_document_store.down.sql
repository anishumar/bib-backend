-- Down for 0037. Newest-first, IF EXISTS throughout.
--
-- This one drops a SCHEMA, which no other down migration in this repo does, so
-- the reasoning is worth stating: `files` is created by this migration and by
-- nothing else, and it holds nothing but these four tables. Dropping it is
-- therefore the exact inverse rather than a shared resource being taken away —
-- unlike `delivery.set_updated_at` (0044's note) or the `pgcrypto`/`citext`
-- extensions, which are shared and are never dropped by a down.
--
-- **Undoing this destroys the only copy of every uploaded file's metadata**, and
-- with it the link between the blobs in the storage backend and anything that
-- explains what they are. The blobs themselves are NOT touched — the storage
-- port has no delete and this migration cannot reach it — so the honest
-- consequence is orphaned bytes the product can no longer identify, not freed
-- space. That is the correct trade for a down migration (losing data is worse
-- than leaving data), and it is stated so nobody runs this expecting a clean
-- undo.
--
-- It refuses rather than proceeding if any document exists, on the same
-- principle as 0044: a down migration that silently discarded a client's signed
-- engagement letter is worse than one that stops.

SET ROLE bib_owner;

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM files.document;
  IF n > 0 THEN
    RAISE EXCEPTION
      'cannot undo 0037: % documents are stored, and dropping the schema would leave their bytes in the storage backend with nothing left to identify them. These include signed engagement letters and client identity proofs. Remove them deliberately first, or leave this migration applied.', n;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_brand_asset_updated_at ON files.brand_asset;
DROP POLICY IF EXISTS brand_asset_isolation ON files.brand_asset;
DROP INDEX IF EXISTS files.brand_asset_one_active;
DROP TABLE IF EXISTS files.brand_asset;

DROP POLICY IF EXISTS document_link_isolation ON files.document_link;
DROP INDEX IF EXISTS files.idx_document_link_document;
DROP INDEX IF EXISTS files.idx_document_link_subject;
DROP TABLE IF EXISTS files.document_link;

DROP POLICY IF EXISTS document_version_isolation ON files.document_version;
DROP INDEX IF EXISTS files.idx_document_version_hash;
DROP INDEX IF EXISTS files.idx_document_version_document;
DROP TABLE IF EXISTS files.document_version;

DROP TRIGGER IF EXISTS trg_document_updated_at ON files.document;
DROP POLICY IF EXISTS document_isolation ON files.document;
DROP INDEX IF EXISTS files.idx_document_tenant_kind;
DROP INDEX IF EXISTS files.idx_document_tenant_party;
DROP TABLE IF EXISTS files.document;

DROP FUNCTION IF EXISTS files.set_updated_at();

RESET ROLE;

DROP SCHEMA IF EXISTS files;
