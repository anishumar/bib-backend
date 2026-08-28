-- Reverse of 0006: back to the two independent references 0005 created.
SET ROLE bib_owner;

ALTER TABLE config.version
  DROP CONSTRAINT IF EXISTS version_entry_tenant_fkey,
  ADD CONSTRAINT version_entry_id_fkey
    FOREIGN KEY (entry_id) REFERENCES config.entry (id);

ALTER TABLE config.entry
  DROP CONSTRAINT IF EXISTS config_entry_id_tenant_key;

RESET ROLE;
