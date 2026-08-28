-- 0007 · C1 leads & pipeline (T2.1)
--
-- A lead is not a shadow copy of a prospect. It is a PIPELINE RECORD ATTACHED
-- TO A PARTY, because everything with a counterparty in this product is a party
-- (CLAUDE.md) and the acceptance for this task says a duplicate lead "merges to
-- the existing party". A separate pre-party lead table would mean the same
-- company existing twice with nothing joining the two, and a conversion step
-- whose only job is to undo that.
--
-- So capture resolves a party first — by identifier, before anything is written
-- — and the lead row carries only what is about the OPPORTUNITY: where it came
-- from, where it has got to, and whose desk it is on.
--
-- THE MERGE RULE IS A DATABASE CONSTRAINT, not a convention: at most one OPEN
-- lead per party. Two open leads for the same prospect is two people ringing
-- them and two forecasts counting them.
--
-- There is no timeline table. The timeline IS the ledger — every capture,
-- merge, stage move and reassignment writes an event against the lead's id, so
-- `GET /api/v1/objects/lead/{id}/events` is the history, already immutable,
-- already tenant-scoped, already free of personal data.

CREATE SCHEMA IF NOT EXISTS crm AUTHORIZATION bib_owner;
REVOKE ALL ON SCHEMA crm FROM PUBLIC;
GRANT USAGE ON SCHEMA crm TO bib_app;

SET ROLE bib_owner;

-- The target for a tenant-safe composite foreign key, the same shape 0006 added
-- for config. Redundant with the primary key on id alone, which is why it is
-- safe: it constrains no data, it only gives crm.lead something to point at
-- that carries the tenant with it.
--
-- KNOWN GAP, recorded rather than half-fixed: core.organization, core.person,
-- core.legal_entity, core.party_identifier and core.party_relationship all
-- still reference their parents by id alone. Foreign-key checks run as a system
-- operation RLS does not filter, so each is the same hole 0006 closed. Sweeping
-- them is its own migration and its own commit — see the board.
ALTER TABLE core.party
  ADD CONSTRAINT party_id_tenant_key UNIQUE (id, tenant_id);

-- ── lead ── one opportunity, about one party.
CREATE TABLE crm.lead (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenancy.tenant(id),
  party_id      uuid NOT NULL,

  -- Where it came from and where it has got to. Closed sets, mirroring
  -- domain/lead/model.ts: the code branches on these names, so a firm cannot
  -- invent one yet and the error says so rather than silently accepting it.
  -- They become a config kind when the pipeline screen (T6.2) exists and a firm
  -- asks to rename something — designing that vocabulary before either is the
  -- trap T2.5 deliberately avoided for workflow templates.
  source        text NOT NULL
                CHECK (source IN ('referral', 'inbound', 'outbound', 'event', 'partner', 'other')),
  stage         text NOT NULL DEFAULT 'new'
                CHECK (stage IN ('new', 'contacted', 'qualified', 'converted', 'lost')),

  -- Whose desk it is on. NULLABLE: an unassigned lead is a real and useful
  -- state — it is the queue somebody works from — and pretending otherwise
  -- would mean inventing an owner at capture. Assignment is manual for now;
  -- round-robin and territory are their own task, recorded on the board.
  owner_user_id uuid REFERENCES tenancy.user_account(id),

  -- Free text about the opportunity. Deliberately here and NOT in any event
  -- payload: notes are where somebody writes "spoke to Priya, call her mobile",
  -- and this row can be erased where the ledger cannot.
  notes         text,

  captured_at   timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- A closed lead has a closing date and an open one does not. Without this,
  -- "how long is the pipeline taking" is answered from a column that is
  -- sometimes set and sometimes not, and nobody notices which.
  CONSTRAINT lead_closed_when_terminal_chk CHECK (
    (stage IN ('converted', 'lost')     AND closed_at IS NOT NULL) OR
    (stage NOT IN ('converted', 'lost') AND closed_at IS NULL)
  ),

  -- The tenant travels with the reference: a lead can only be about a party in
  -- its OWN firm. See the note on party_id_tenant_key above.
  CONSTRAINT lead_party_tenant_fkey
    FOREIGN KEY (party_id, tenant_id) REFERENCES core.party (id, tenant_id)
);
CREATE TRIGGER trg_lead_updated_at BEFORE UPDATE ON crm.lead
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- UNIQUE SCOPE: one OPEN lead per party, per tenant (the tenant comes with
-- party_id through the composite key above). Partial, so a party may have any
-- number of CLOSED leads behind it — a prospect who went cold in March and came
-- back in September is two opportunities and should be counted as two.
--
-- This index is the merge rule. Capture finds the party by identifier and, if
-- it already has an open lead, appends to that one instead of starting a rival.
CREATE UNIQUE INDEX lead_one_open_per_party ON crm.lead (party_id)
  WHERE stage NOT IN ('converted', 'lost');

-- The two reads the pipeline exists for: "what is in my pipeline, by stage" and
-- "what is on my desk". Both tenant-first because RLS filters on that.
CREATE INDEX idx_lead_tenant_stage ON crm.lead (tenant_id, stage, captured_at DESC);
CREATE INDEX idx_lead_tenant_owner ON crm.lead (tenant_id, owner_user_id, captured_at DESC);

-- THE TENANT WALL, identical in shape to 0001/0002/0003/0005.
ALTER TABLE crm.lead ENABLE ROW LEVEL SECURITY;
CREATE POLICY lead_isolation ON crm.lead
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

RESET ROLE;

-- Grants. No DELETE: a lead that went nowhere is `lost`, not erased — the
-- pipeline's own history is what makes a conversion rate mean anything.
GRANT SELECT, INSERT, UPDATE ON crm.lead TO bib_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bib_owner IN SCHEMA crm
  GRANT SELECT, INSERT, UPDATE ON TABLES TO bib_app;
