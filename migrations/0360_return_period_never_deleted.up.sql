-- 0360 · A return period is cleared, never deleted (fix forward of 0359)
--
-- 0359 granted bib_app DELETE on core.legal_entity_return_period. Every core
-- table is permanent for the app role (tests/party/archive.integration.test.ts
-- holds the wall), so the grant goes and "take it off" becomes a mark:
-- `cleared_at`. Setting the period again un-clears the same row. Every reader
-- asks `cleared_at IS NULL`.
SET ROLE bib_owner;

REVOKE DELETE ON core.legal_entity_return_period FROM bib_app;

ALTER TABLE core.legal_entity_return_period ADD COLUMN cleared_at timestamptz;

COMMENT ON COLUMN core.legal_entity_return_period.cleared_at IS
  'Taken off: the company no longer has this period recorded (0360). Readers ask cleared_at IS NULL; setting it again clears this.';

RESET ROLE;
