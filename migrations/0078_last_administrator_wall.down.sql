-- Down for 0078.
--
-- Trigger, then the function it calls, then the helper that function calls —
-- dependency order, so nothing is dropped while something still refers to it.
--
-- Rolling this back returns the last-administrator invariant to being kept by
-- the application's check-then-act alone, which is correct in the ordinary case
-- and loses the race described in the up migration.
SET ROLE bib_owner;

DROP TRIGGER IF EXISTS administrator_survives ON tenancy.membership;
DROP FUNCTION IF EXISTS tenancy.administrator_survives();
DROP FUNCTION IF EXISTS tenancy.is_administering_role(uuid, text);

RESET ROLE;
