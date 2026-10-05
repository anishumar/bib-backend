-- 0360 down · cleared rows are dropped back to 0359's shape (where they were deleted).
SET ROLE bib_owner;
DELETE FROM core.legal_entity_return_period WHERE cleared_at IS NOT NULL;
ALTER TABLE core.legal_entity_return_period DROP COLUMN IF EXISTS cleared_at;
GRANT DELETE ON core.legal_entity_return_period TO bib_app;
RESET ROLE;
