-- Down for 0336: puts back what 0001 granted and what 0078 left unset. Both
-- were the weaker state (see the up); this exists so the migration can be
-- reversed, not because either is wanted.

GRANT SELECT, INSERT, UPDATE ON tenancy.schema_migrations TO bib_app;

SET ROLE bib_owner;

ALTER FUNCTION tenancy.administrator_survives() RESET search_path;

RESET ROLE;
