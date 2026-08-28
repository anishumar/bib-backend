-- 0035 · core.party.archived_at — the lifecycle column, and the decision that
--        there will never be a `deleted_at` (G0.3)
--
-- ── THE DECISION ─────────────────────────────────────────────────────────────
--
-- PARTIES ARE PERMANENT. No `core` table carries `deleted_at`, and none ever
-- will. CLAUDE.md said "soft delete only" while no core table had the column
-- and no DELETE route existed, so the next person to read that line would
-- assume a filter that was not there — a stated rule the schema does not
-- implement is worse than no rule. The line is corrected in CLAUDE.md by the
-- same commit that adds this file.
--
-- A real company's lifecycle is answered by two things that already exist: the
-- ledger (what happened to this counterparty, and who did it) and
-- `core.legal_entity.status` (active / dormant / under_strike_off / struck_off
-- / dissolved — the states a registrar actually recognises). `bib_app` holds no
-- DELETE grant on any `core` table, so hard delete is already impossible at the
-- database level; this migration keeps it that way and grants nothing new.
--
-- What was genuinely missing is narrower than deletion: a client created by
-- mistake, or one the firm stopped acting for six years ago, still turns up in
-- every picker with no way to put it away. So ONE column, on `core.party` only:
--
--     archived_at   means "hide this from pickers and lists"
--                   NOT  "this never existed"
--
-- ── THE READ ASYMMETRY, WHICH IS THE WHOLE DESIGN ────────────────────────────
--
-- The LIST hides archived parties unless it is explicitly asked for them. But
-- reading ONE party BY ID always resolves, archived or not, because a signed
-- engagement letter's counterparty must never render blank. That is the same
-- principle 0017's signature freeze protects, and it is exactly why this is one
-- `archived_at` on one table rather than `deleted_at` across `core` behind a
-- filter that every read from now until the end of the product has to remember
-- to write. Both halves are enforced in
-- `infrastructure/postgres/party-repository.ts` and proved in
-- `tests/party/archive.integration.test.ts`.
--
-- ── WHY THE REFUSAL IS A TRIGGER AND NOT A SERVICE CHECK ─────────────────────
--
-- Archiving is refused while anything still points at the party. That check
-- lives HERE, in the database, for the reason 0005's publish freeze and 0017's
-- signature freeze live there: an application rule protects against the
-- application, and the writers most in need of stopping are the ones that are
-- not the application — a client import, an agent, a backfill migration, a 2
-- a.m. psql session. Every one of those can set a column; none of them calls
-- PartyService.
--
-- The cost that argument normally loses to is per-UPDATE work: five EXISTS
-- probes across `crm` on every write to `core.party` would be paid by every
-- rename and every display-name correction, forever. It is not paid here.
-- `BEFORE UPDATE OF archived_at` restricts the trigger to statements that
-- mention the column, and the WHEN clause narrows it to the NULL → NOT NULL
-- transition, so the probes run only on the archiving act itself — a
-- deliberate, human-scale action. An ordinary UPDATE of `core.party` fires
-- nothing at all, and un-archiving fires nothing either.
--
-- What it does cost is a direction of dependency: `core` now names `crm`
-- tables, and `crm` is the module that depends on `core`, not the reverse. That
-- is the honest price and it is accepted deliberately. Because plpgsql resolves
-- names at execution time, it creates no ordering dependency between migrations
-- — but it does mean dropping a `crm` table would leave this function raising a
-- different error than it means to, which is what the down migration is for.
--
-- The alternatives, and what each would have cost:
--
--   · A check in `PartyService` — free, and walked straight past by every
--     writer that is not the service. This codebase has written that failure
--     mode down twice already (0005, 0017) and paid for it once.
--   · Triggers on the five `crm` tables instead — the wrong end. Those fire
--     when a REFERENCE is created; the act being guarded is archiving the
--     PARTY. Guarding both ends is five more triggers to keep in step with this
--     one, for a rule that only ever has to hold at one moment.
--   · A foreign key onto a partial unique index over live parties — not
--     expressible. A foreign key must reference a full unique constraint, and
--     archiving would then have to cascade, which is the delete this entire
--     migration exists to refuse.
--
-- ── THE ENUMERATION HAZARD ───────────────────────────────────────────────────
--
-- The referring columns are listed one by one below, which carries exactly the
-- hazard 0017's frozen-column list carries: a SIXTH reference to `core.party`
-- added next month is not covered until somebody adds it here. ADD A REFERENCE
-- TO core.party, ADD IT TO THIS FUNCTION.
--
-- One reference is deliberately absent: `crm.proposal_line.entity_party_id`.
-- The decision this migration implements enumerated leads, proposals,
-- engagement letters, an engagement letter line's entity and engagements, and
-- widening a refusal past what was decided is a product change, not an
-- implementation detail. Adding it is two lines here when somebody decides it.
--
-- Cost note: four of the five probes land on an existing `(tenant_id,
-- party_id)` or `(tenant_id, entity_party_id)` index. `crm.lead`'s only
-- party index is partial to OPEN leads, so that one probe is a scan of the
-- firm's leads — paid once, at the moment somebody archives a party, and not
-- worth a cross-module index for that.

SET ROLE bib_owner;

-- NULL means live. A timestamp rather than a boolean because "when did this
-- stop appearing in our lists" is a question somebody asks, and the ledger
-- answers who but the row should answer when without a join.
ALTER TABLE core.party ADD COLUMN archived_at timestamptz;

-- The cheap read is "the live parties at this firm, in display order". Tenant
-- first because RLS has already narrowed to one tenant by the time this index
-- is consulted, display_name second because that is the ORDER BY, and PARTIAL
-- on archived_at IS NULL because the default list never wants the others — so
-- archived rows cost the index nothing at all.
CREATE INDEX idx_party_tenant_live ON core.party (tenant_id, display_name)
  WHERE archived_at IS NULL;

-- ── the refusal ──
--
-- Runs as the caller (no SECURITY DEFINER), so under `bib_app` the probes are
-- RLS-filtered to the session's tenant on top of the explicit predicate. The
-- explicit `tenant_id = NEW.tenant_id` is what makes it correct for the owner
-- role and a psql session too, where RLS does not apply.
CREATE OR REPLACE FUNCTION core.refuse_archive_with_references() RETURNS trigger AS $$
DECLARE
  refs text[] := '{}';
BEGIN
  IF EXISTS (SELECT 1 FROM crm.lead
             WHERE tenant_id = NEW.tenant_id AND party_id = NEW.id) THEN
    refs := array_append(refs, 'a lead');
  END IF;

  IF EXISTS (SELECT 1 FROM crm.proposal
             WHERE tenant_id = NEW.tenant_id AND party_id = NEW.id) THEN
    refs := array_append(refs, 'a proposal');
  END IF;

  IF EXISTS (SELECT 1 FROM crm.engagement_letter
             WHERE tenant_id = NEW.tenant_id AND party_id = NEW.id) THEN
    refs := array_append(refs, 'an engagement letter');
  END IF;

  IF EXISTS (SELECT 1 FROM crm.engagement_letter_line
             WHERE tenant_id = NEW.tenant_id AND entity_party_id = NEW.id) THEN
    refs := array_append(refs, 'an engagement letter line');
  END IF;

  -- Both of the engagement's references, because both are "an engagement points
  -- at this party": party_id is who is billed, entity_party_id is who the work
  -- is delivered to (0018), and either one rendering an archived counterparty
  -- is the case this refusal exists for.
  IF EXISTS (SELECT 1 FROM crm.engagement
             WHERE tenant_id = NEW.tenant_id
               AND (party_id = NEW.id OR entity_party_id = NEW.id)) THEN
    refs := array_append(refs, 'an engagement');
  END IF;

  IF cardinality(refs) > 0 THEN
    -- DETAIL carries the machine-readable list, so the adapter can name what
    -- refers to the party in a domain error instead of re-deriving it.
    RAISE EXCEPTION
      'party % cannot be archived: it is still referenced by %. Archiving only hides a party from pickers and lists — close or supersede what points at it first. Nothing here deletes anything: the party is permanent and its history is the ledger.',
      NEW.id, array_to_string(refs, ', ')
      USING ERRCODE = 'restrict_violation',
            DETAIL  = array_to_string(refs, ', ');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_party_archive_guard
  BEFORE UPDATE OF archived_at ON core.party
  FOR EACH ROW
  WHEN (NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL)
  EXECUTE FUNCTION core.refuse_archive_with_references();

RESET ROLE;

-- No new grants. `bib_app` already holds SELECT, INSERT, UPDATE on core (0002)
-- and SELECT on the crm tables the guard probes, and it holds DELETE on
-- nothing. Archiving is an UPDATE of one column; that is the point.
