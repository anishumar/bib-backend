-- Down for 0077.
--
-- The trigger goes before the function it calls, which is the only ordering
-- constraint here. Rolling this back returns `tenancy.tenant` to being defended
-- by application predicates alone — the state this migration exists to end, and
-- the state every other tenant table in this database has never been in.
SET ROLE bib_owner;

DROP TRIGGER IF EXISTS tenant_row_is_own ON tenancy.tenant;
DROP FUNCTION IF EXISTS tenancy.tenant_row_is_own();

RESET ROLE;
