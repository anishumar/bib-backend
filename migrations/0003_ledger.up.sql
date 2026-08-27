-- 0003 · P7 audit ledger (the append-only event log)
--
-- Everything that happens writes here: the audit trail a regulator asks for,
-- the trigger source the engine consumes, and later the AI's memory of what a
-- firm has done. It is built now rather than later because it cannot be
-- reconstructed retroactively — history not captured is history gone.
--
-- Three properties this migration exists to guarantee:
--   1. APPEND-ONLY, twice over. bib_app is granted SELECT + INSERT and nothing
--      else, and a trigger rejects UPDATE/DELETE/TRUNCATE for EVERY role
--      including the owner. Corrections are new events, never edits.
--   2. TENANT-SCOPED. Same wall as every other business table: tenant_id +
--      RLS + policy, with bib_app NOBYPASSRLS.
--   3. NO PII. The payload is a jsonb of ids and machine facts. Personal data
--      lives in erasable rows and is referenced BY ID from here, so a DPDP /
--      GDPR erasure never has to mutate an immutable log. The rule is enforced
--      in the domain (domain/ledger/model.ts) at the write path; this comment
--      is the reason it exists.
--
-- The event vocabulary itself (which verbs exist, what object each names) is
-- code, not data — docs/EVENT-CONTRACT.md and domain/ledger/model.ts. A verb
-- registry in the database would let a typo become a permanent new verb.

CREATE SCHEMA IF NOT EXISTS ledger AUTHORIZATION bib_owner;
REVOKE ALL ON SCHEMA ledger FROM PUBLIC;
GRANT USAGE ON SCHEMA ledger TO bib_app;

SET ROLE bib_owner;

-- ── event ── one row per thing that happened. No updated_at and no deleted_at,
-- deliberately: there is no state to keep in sync because the row never changes.
CREATE TABLE ledger.event (
  id          uuid PRIMARY KEY,                  -- supplied by the app: random,
                                                 -- or derived (uuid v5) from an
                                                 -- idempotency key so a retried
                                                 -- callback re-lands on THIS row
  tenant_id   uuid NOT NULL REFERENCES tenancy.tenant(id),

  -- Who did it. Once agents write to these tables this is the only way to
  -- answer "who did this" — and a regulator will ask. Null actor_id is legal
  -- only for 'system'; a human or agent must name itself (CHECK below).
  actor_type  text NOT NULL CHECK (actor_type IN ('human', 'agent', 'system')),
  actor_id    uuid,

  -- What happened, past tense and dotted: 'party.created', 'proposal.sent'.
  -- The valid set is the registry in domain/ledger/model.ts, checked before the
  -- insert; the column is text so adding a verb is a code change, not a DDL one.
  verb        text NOT NULL,

  -- What it happened TO. object_type is derived from the verb by the registry,
  -- so the pair can never disagree.
  object_type text NOT NULL,
  object_id   uuid NOT NULL,

  payload     jsonb NOT NULL DEFAULT '{}',       -- ids and machine facts; NO PII

  -- Two clocks, because they answer different questions. occurred_at is when it
  -- happened in the business (an external callback may report a past moment);
  -- recorded_at is when we learned of it. Reconciliation needs both.
  occurred_at timestamptz NOT NULL DEFAULT now(),
  recorded_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT event_actor_identified_chk
    CHECK ((actor_type = 'system' AND actor_id IS NULL) OR
           (actor_type <> 'system' AND actor_id IS NOT NULL))
);

-- The tenant timeline ("what happened at this firm lately") is the read this
-- table exists for; the object timeline ("everything that ever happened to this
-- invoice") is the second. Both are tenant-first because RLS filters on that.
CREATE INDEX idx_event_tenant_occurred ON ledger.event (tenant_id, occurred_at DESC);
CREATE INDEX idx_event_object ON ledger.event (tenant_id, object_type, object_id, occurred_at DESC);
CREATE INDEX idx_event_actor ON ledger.event (tenant_id, actor_id, occurred_at DESC);
CREATE INDEX idx_event_verb ON ledger.event (tenant_id, verb, occurred_at DESC);

-- IMMUTABILITY, defence 1 of 2: a trigger, which binds every role — including
-- bib_owner and a superuser session that forgot what this table is. Grants
-- alone would leave the owner able to rewrite history.
CREATE OR REPLACE FUNCTION ledger.reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'ledger.event is append-only: % is not permitted on it. A correction is a NEW event, not an edit.',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_event_immutable_row
  BEFORE UPDATE OR DELETE ON ledger.event
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_mutation();

-- TRUNCATE does not fire row triggers, so it gets its own statement-level one.
CREATE TRIGGER trg_event_immutable_truncate
  BEFORE TRUNCATE ON ledger.event
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation();

-- THE TENANT WALL, identical in shape to 0001/0002. NULLIF(..., '') keeps the
-- unset/pooled-placeholder case NULL → predicate false → zero rows, never an
-- "invalid input syntax for uuid" error.
ALTER TABLE ledger.event ENABLE ROW LEVEL SECURITY;
CREATE POLICY event_isolation ON ledger.event
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

RESET ROLE;

-- IMMUTABILITY, defence 2 of 2: the grant. Note what is ABSENT — no UPDATE, no
-- DELETE, no TRUNCATE. Unlike the tenancy and core schemas, this schema's
-- default privileges also withhold them, so a future table added here is
-- append-only by default rather than by remembering.
GRANT SELECT, INSERT ON ledger.event TO bib_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bib_owner IN SCHEMA ledger
  GRANT SELECT, INSERT ON TABLES TO bib_app;
