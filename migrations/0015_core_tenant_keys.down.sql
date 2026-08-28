-- Reverses 0015, restoring the id-only references. Note what this re-opens: one
-- firm's row could again hang off another firm's object. It is a `down`, not a
-- recommendation.
SET ROLE bib_owner;

ALTER TABLE core.party_relationship
  DROP CONSTRAINT IF EXISTS party_relationship_to_party_tenant_fkey,
  DROP CONSTRAINT IF EXISTS party_relationship_from_party_tenant_fkey;
ALTER TABLE core.party_relationship
  ADD CONSTRAINT party_relationship_from_party_id_fkey
    FOREIGN KEY (from_party_id) REFERENCES core.party (id),
  ADD CONSTRAINT party_relationship_to_party_id_fkey
    FOREIGN KEY (to_party_id) REFERENCES core.party (id);

ALTER TABLE core.party_identifier
  DROP CONSTRAINT IF EXISTS party_identifier_party_tenant_fkey;
ALTER TABLE core.party_identifier
  ADD CONSTRAINT party_identifier_party_id_fkey
    FOREIGN KEY (party_id) REFERENCES core.party (id);

ALTER TABLE core.legal_entity
  DROP CONSTRAINT IF EXISTS legal_entity_organization_tenant_fkey;
ALTER TABLE core.legal_entity
  ADD CONSTRAINT legal_entity_party_id_fkey
    FOREIGN KEY (party_id) REFERENCES core.organization (party_id);

ALTER TABLE core.person
  DROP CONSTRAINT IF EXISTS person_party_tenant_fkey;
ALTER TABLE core.person
  ADD CONSTRAINT person_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id);

ALTER TABLE core.organization
  DROP CONSTRAINT IF EXISTS organization_party_tenant_fkey;
ALTER TABLE core.organization
  ADD CONSTRAINT organization_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.party (id);

ALTER TABLE core.organization
  DROP CONSTRAINT IF EXISTS organization_party_id_tenant_key;

RESET ROLE;
