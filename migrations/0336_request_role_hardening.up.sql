-- 0336 · Two things the request role and the one definer function should
-- never have had (audit 2026-10-03, B30 and B38).
--
-- B30 (security audit F-06-1). `bib_app` held INSERT, SELECT and UPDATE on
-- `tenancy.schema_migrations`. 0001's `GRANT … ON ALL TABLES IN SCHEMA
-- tenancy TO bib_app` ran after the migrator had created its bookkeeping table
-- there, and caught it. A request that can write that table can mark a
-- migration applied that never ran, or un-mark one so the next deploy runs it
-- twice. Nothing reads or writes it as bib_app: `cmd/migrate` connects as the
-- table's OWNER (the role that created it), and the boot check asks nothing of
-- it. So everything is revoked.
--
-- The REVOKE runs as the migrator, before `SET ROLE`: the table belongs to the
-- migrator and the grant was the migrator's (0001 had already RESET ROLE), and
-- a role revokes only grants it made. The check after it fails the migration,
-- naming the fix, if anything is left (a grant somebody else made by hand).
--
-- B38. `tenancy.administrator_survives()` (0078) is SECURITY DEFINER, the only
-- one in the product, and ran with the CALLER's search_path. Every name in it
-- is schema-qualified, so the risk was low; a definer function pins its
-- search_path regardless, so nothing a caller can create can stand in for a
-- built-in it calls (`count`, `hashtext`, `pg_advisory_xact_lock`). pg_temp
-- goes LAST explicitly: left out, it is searched FIRST.

REVOKE ALL ON tenancy.schema_migrations FROM bib_app;

DO $$
BEGIN
  IF has_table_privilege('bib_app', 'tenancy.schema_migrations', 'INSERT')
     OR has_table_privilege('bib_app', 'tenancy.schema_migrations', 'UPDATE')
     OR has_table_privilege('bib_app', 'tenancy.schema_migrations', 'DELETE')
     OR has_table_privilege('bib_app', 'tenancy.schema_migrations', 'TRUNCATE')
     OR has_table_privilege('bib_app', 'tenancy.schema_migrations', 'SELECT') THEN
    RAISE EXCEPTION
      '0336: bib_app still holds a privilege on tenancy.schema_migrations that this role could not revoke. Revoke it as the role that granted it: REVOKE ALL ON tenancy.schema_migrations FROM bib_app;';
  END IF;
END $$;

SET ROLE bib_owner;

ALTER FUNCTION tenancy.administrator_survives() SET search_path = pg_catalog, pg_temp;

RESET ROLE;
