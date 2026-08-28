-- 0018 · The entity a line is for (G0.1)
--
-- An engagement is `service × ONE LEGAL ENTITY` — the firm's own confirmed
-- "Per Company" rule: vCFO for a group of four companies is FOUR engagements,
-- not one. Until now `crm.engagement` was spawned with the LETTER's party — the
-- client — and the line it fanned out from named no entity at all, so that
-- dimension did not exist anywhere in the commercial chain.
--
-- The consequence is not cosmetic. `obligation_instance` (T3.2) keys on an
-- entity: an entity owes GSTR-3B, a client does not. With no entity on the line
-- the compliance calendar has no join to generate against, and
-- `core.legal_entity` — carefully modelled with jurisdiction, entity type and
-- financial-year end — is reachable from nothing downstream. That is why this
-- one migration blocks the whole delivery lane.
--
-- KEEP BOTH COLUMNS. `party_id` stays exactly where it is: the client is who is
-- BILLED, the entity is who the work is DELIVERED TO, and a firm needs both.
-- Invoicing (T3.4) reads the first, the calendar reads the second. Collapsing
-- them is what got us here.
--
-- The foreign key points at `core.party`, NOT `core.legal_entity`. Whether an
-- EL line may only name an entity the firm has already incorporated is a
-- product decision and it is still open — Incorporation is a service whose line
-- has no entity yet because that entity is the line's own OUTPUT. Tightening it
-- later is one composite key on `legal_entity` and one constraint swap.
--
-- ── Why this migration REFUSES rather than backfills ────────────────────────
--
-- `crm.engagement_letter_line` carries `trg_el_line_freeze` (0017): once a
-- letter is signed its lines cannot be written at all, by ANY role, because
-- "what did they sign" has to hold against a migration and a 2 a.m. psql
-- session and not merely against the application. A NOT NULL column therefore
-- cannot be added to a table that already holds lines of signed letters — and
-- that is the freeze WORKING, not a defect in it.
--
-- There is also no honest value to backfill. No row has ever recorded an
-- entity, so writing the client's party into one would put a term into a signed
-- document that the document never said. So this migration applies only to an
-- empty commercial chain, and it says so by name rather than failing on a
-- constraint somebody then has to diagnose.
--
-- The forward path once real letters exist is written into the exception
-- message below, because that is where the person who needs it will be looking.

SET ROLE bib_owner;

DO $$
DECLARE
  line_count       bigint;
  engagement_count bigint;
BEGIN
  SELECT count(*) INTO line_count       FROM crm.engagement_letter_line;
  SELECT count(*) INTO engagement_count FROM crm.engagement;

  IF line_count > 0 OR engagement_count > 0 THEN
    RAISE EXCEPTION
      'migration 0018 adds a NOT NULL entity to crm.engagement_letter_line (% rows) and crm.engagement (% rows), and neither can be backfilled: the lines of a signed letter are frozen by trg_el_line_freeze (0017), and no row has ever recorded an entity, so any value written would be a term the document never said. This product has no production data — drop and re-create the database, run `npm run migrate`, then `npm run smoke` to re-seed. If you are reading this WITH REAL SIGNED LETTERS in the table, do NOT disable the trigger: add entity_party_id as a NULLABLE column instead and require it only for letters drafted after this migration.',
      line_count, engagement_count
      USING ERRCODE = 'restrict_violation';
  END IF;
END $$;

-- ── crm.proposal_line ── the entity MAY be named.
--
-- Nullable on purpose, and it is the one place in this migration where that is
-- the right answer. A prospect may hold no entity yet — that is often exactly
-- what they are buying — and an Incorporation line's entity is the line's own
-- output. A proposal is an OFFER; it does not have to know yet.
ALTER TABLE crm.proposal_line
  ADD COLUMN entity_party_id uuid,
  ADD CONSTRAINT proposal_line_entity_tenant_fkey
    FOREIGN KEY (entity_party_id, tenant_id) REFERENCES core.party (id, tenant_id);

-- ── crm.engagement_letter_line ── the entity MUST be named.
--
-- On signature each live line becomes exactly one engagement, and an engagement
-- is service × one legal entity. NOT NULL in the DATABASE rather than a check in
-- the service, because a rule in a service is one an import, a backfill or an
-- agent walks straight past — and this is the join the entire compliance
-- calendar will be generated from.
ALTER TABLE crm.engagement_letter_line
  ADD COLUMN entity_party_id uuid NOT NULL,
  ADD CONSTRAINT el_line_entity_tenant_fkey
    FOREIGN KEY (entity_party_id, tenant_id) REFERENCES core.party (id, tenant_id);

-- ── crm.engagement ── carried across by the fan-out, not re-derived.
--
-- Stored rather than read back through the line, for the same reason the line's
-- money is stored rather than read back through the catalogue: the engagement is
-- what the delivery lane schedules against for a year, and it must not depend on
-- a join to answer whose entity it is.
ALTER TABLE crm.engagement
  ADD COLUMN entity_party_id uuid NOT NULL,
  ADD CONSTRAINT engagement_entity_tenant_fkey
    FOREIGN KEY (entity_party_id, tenant_id) REFERENCES core.party (id, tenant_id);

-- Tenant first in every one of these: RLS has already narrowed to a tenant by
-- the time any of them is used, and "this entity's engagements" is the question
-- the calendar asks on every spawn.
CREATE INDEX idx_proposal_line_entity ON crm.proposal_line (tenant_id, entity_party_id);
CREATE INDEX idx_el_line_entity       ON crm.engagement_letter_line (tenant_id, entity_party_id);
CREATE INDEX idx_engagement_entity    ON crm.engagement (tenant_id, entity_party_id);

RESET ROLE;
