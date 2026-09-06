-- Down for 0075.
--
-- The grants go first and the column last, so that if anything refuses, the
-- thing still standing is the more capable state rather than a half-revoked
-- one. Dropping the column is safe in itself: `last_seen_at` is derived
-- operational data, not a record of anything — the trail of who signed in and
-- when is `ledger.event`, untouched here.
--
-- Rolling this back restores the fourteen-day absolute TTL as the only clock
-- and leaves both tables un-sweepable again. Both are the states this migration
-- exists to end, which is what a down migration is for.
SET ROLE bib_owner;

REVOKE DELETE ON tenancy.magic_link FROM bib_app;
REVOKE DELETE ON tenancy.session FROM bib_app;

DROP INDEX IF EXISTS tenancy.session_expiry_idx;

ALTER TABLE tenancy.session
  DROP COLUMN last_seen_at;

RESET ROLE;
