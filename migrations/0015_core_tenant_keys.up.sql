-- 0015 · the composite-key sweep across `core`
--
-- The gap 0007 recorded and deliberately did not half-fix: every reference
-- inside `core` pointed at its parent BY ID ALONE. Foreign-key checks run as a
-- system operation that RLS does not filter, so firm A holding firm B's party
-- id could insert a row with `tenant_id = A` pointing at B's party — both
-- constraints pass, and the RLS WITH CHECK passes too, because the row really
-- is A's.
--
-- It leaks nothing. RLS still hides B's party from A and A's row from B. What
-- it allows is one firm's row hanging off another firm's object, and the tenant
-- wall is supposed to make that UNREPRESENTABLE rather than merely invisible —
-- which is the whole argument of CLAUDE.md's "three independent places". A
-- constraint that only holds because the application is careful is not one of
-- the three.
--
-- Six references, five tables, and this is all of them: the same query that
-- found these — every FK from a tenant-scoped table to a tenant-scoped table
-- that does not carry tenant_id — now returns nothing for core, crm, config,
-- tenancy and ledger alike. 0006 did config, 0007 did crm.lead, 0011 did
-- proposals; this closes the set.
--
-- WHY IT IS SAFE TO ADD NOW: every existing row was created through the
-- application, under one tenant's RLS context, so none of them can violate
-- these. Verified before writing this migration. If any environment does hold a
-- crossed row, this ALTER fails loudly and that is the correct outcome — such a
-- row is corruption, and inventing a fix for it here would hide it.

SET ROLE bib_owner;

-- The target for legal_entity's reference. core.party already got its own in
-- 0007. Redundant with the primary key on party_id alone, which is exactly why
-- it is safe: it constrains no data, it only gives a foreign key something to
-- point at that carries the tenant with it.
ALTER TABLE core.organization
  ADD CONSTRAINT organization_party_id_tenant_key UNIQUE (party_id, tenant_id);

-- ── the subtypes ── an organization/person row belongs to a party in its OWN
-- firm. Without this, the subtype detail of one firm's party could be another
-- firm's row.
ALTER TABLE core.organization
  DROP CONSTRAINT organization_party_id_fkey,
  ADD CONSTRAINT organization_party_tenant_fkey
    FOREIGN KEY (party_id, tenant_id) REFERENCES core.party (id, tenant_id);

ALTER TABLE core.person
  DROP CONSTRAINT person_party_id_fkey,
  ADD CONSTRAINT person_party_tenant_fkey
    FOREIGN KEY (party_id, tenant_id) REFERENCES core.party (id, tenant_id);

-- ── legal_entity ── points at core.organization, not core.party, because only
-- an organization can be registered. The composite key keeps that reference
-- inside the firm too.
ALTER TABLE core.legal_entity
  DROP CONSTRAINT legal_entity_party_id_fkey,
  ADD CONSTRAINT legal_entity_organization_tenant_fkey
    FOREIGN KEY (party_id, tenant_id)
    REFERENCES core.organization (party_id, tenant_id);

-- ── identifiers ── a PAN attached to another firm's party is the worst of
-- these in practice: identifiers are what lead capture DEDUPLICATES on, so a
-- crossed row would make one firm's capture resolve to another firm's party.
ALTER TABLE core.party_identifier
  DROP CONSTRAINT party_identifier_party_id_fkey,
  ADD CONSTRAINT party_identifier_party_tenant_fkey
    FOREIGN KEY (party_id, tenant_id) REFERENCES core.party (id, tenant_id);

-- ── relationships ── BOTH ends. A directorship is only meaningful if both
-- parties are the same firm's records; one end pointing outside would put
-- another firm's company on this firm's party-360 screen.
ALTER TABLE core.party_relationship
  DROP CONSTRAINT party_relationship_from_party_id_fkey,
  ADD CONSTRAINT party_relationship_from_party_tenant_fkey
    FOREIGN KEY (from_party_id, tenant_id) REFERENCES core.party (id, tenant_id);

ALTER TABLE core.party_relationship
  DROP CONSTRAINT party_relationship_to_party_id_fkey,
  ADD CONSTRAINT party_relationship_to_party_tenant_fkey
    FOREIGN KEY (to_party_id, tenant_id) REFERENCES core.party (id, tenant_id);

RESET ROLE;
