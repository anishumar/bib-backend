-- 0081 down. Drops the pin, which loses WHICH signature image each letter was
-- issued under. The bytes themselves are untouched — they live in
-- `files.document_version` and are referenced by `files.brand_asset` — so what
-- goes is the snapshot, and every letter falls back to rendering a bare rule.
--
-- The constraint is dropped before the column only for readability; `DROP COLUMN`
-- would take it either way.
SET ROLE bib_owner;

ALTER TABLE crm.engagement_letter
  DROP CONSTRAINT IF EXISTS el_firm_signature_version_tenant_fkey,
  DROP COLUMN IF EXISTS firm_signature_version_id;

RESET ROLE;
