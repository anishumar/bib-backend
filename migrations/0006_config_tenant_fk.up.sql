-- 0006 · a config version can only belong to an entry in the SAME tenant
--
-- 0005 gave config.version two independent references: entry_id -> config.entry
-- and tenant_id -> tenancy.tenant. Nothing tied them together, and foreign-key
-- checks run as a system operation that RLS does not filter. So an admin at
-- firm A, holding a config entry id belonging to firm B, could insert a version
-- with tenant_id = A pointing at B's entry: both constraints pass, and the RLS
-- WITH CHECK on the version passes too because the row really is A's.
--
-- It leaks nothing — RLS still hides the row from B, and B's reads are
-- unaffected — but it lets one firm's row attach to another firm's object, and
-- the tenant wall is supposed to make that unrepresentable rather than merely
-- invisible. The composite foreign key below makes it impossible: the pair
-- (entry_id, tenant_id) must exist together on config.entry.
--
-- WHY THIS IS A SEPARATE MIGRATION and not an edit to 0005: 0005 has been
-- applied. The rule is fix forward with a new number, and it has no exception
-- for "the same afternoon" — an applied migration that gets edited silently
-- diverges any environment that already ran it. See migrations/README.md.

SET ROLE bib_owner;

-- The target of the composite reference. Redundant with the primary key on id
-- alone, which is exactly why it is safe: it adds no constraint on the data, it
-- only gives the foreign key below something to point at.
ALTER TABLE config.entry
  ADD CONSTRAINT config_entry_id_tenant_key UNIQUE (id, tenant_id);

ALTER TABLE config.version
  DROP CONSTRAINT version_entry_id_fkey,
  ADD CONSTRAINT version_entry_tenant_fkey
    FOREIGN KEY (entry_id, tenant_id) REFERENCES config.entry (id, tenant_id);

RESET ROLE;
