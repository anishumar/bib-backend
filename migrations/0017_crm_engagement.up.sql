-- 0017 · C4 engagement letters, and the engagements they create (T2.3)
--
-- A proposal is what the firm OFFERED. An engagement letter is what both sides
-- AGREED, and it is the document that creates obligations — the first object in
-- this product with legal weight rather than commercial weight. Everything
-- below follows from that one difference.
--
-- TWO TABLES, because a letter and the work it sells have different lifetimes.
-- The letter is signed once and never changes. An engagement runs for a year,
-- is paused, renewed or closed, and is what the delivery lane schedules against
-- from T2.4 on. Signing fans one letter out into one engagement PER LINE.
--
-- SIGNATURE FREEZES, and by a TRIGGER rather than a check in the service. The
-- precedent is the config freeze in 0005 and the reason is stronger here: an
-- application-level rule protects against the application, and "what did they
-- sign" must also be protected against a migration, a backfill and a 2 a.m.
-- psql session. It is the one question about this table that a court asks.
--
-- Money is `numeric`, one currency and one rate per letter, lines held to it by
-- a composite key — identical to proposals (0011), for the same reasons.

SET ROLE bib_owner;

-- The target for the letter's reference back to the proposal it came from.
-- 0011 gave crm.proposal a composite key on (id, tenant_id, CURRENCY), which is
-- what holds a proposal line to its document's currency; a letter needs the
-- narrower (id, tenant_id), because it inherits nothing about currency from the
-- quote it came out of. Added here rather than by editing 0011, which is
-- applied and therefore frozen.
ALTER TABLE crm.proposal
  ADD CONSTRAINT proposal_id_tenant_key UNIQUE (id, tenant_id);

-- ── engagement_letter ── the document.
CREATE TABLE crm.engagement_letter (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenancy.tenant(id),
  party_id    uuid NOT NULL,

  -- Where it came from, when it came from anywhere. NULLABLE: a renewal or a
  -- walk-in engagement has no proposal, and inventing one to satisfy a column
  -- would put rows in the pipeline nobody is working.
  proposal_id uuid,

  -- The letter's OWN jurisdiction, chosen when it is drafted rather than
  -- derived from the client's registrations at read time. A legal document has
  -- to record the jurisdiction it was WRITTEN for, permanently; deriving it
  -- later from a mutable relationship would silently restate it. It also
  -- settles the Dubai-client-of-an-Indian-firm case by asking rather than
  -- guessing.
  jurisdiction text NOT NULL CHECK (jurisdiction ~ '^[A-Z]{2}$'),

  title       text NOT NULL CHECK (btrim(title) <> ''),
  status      text NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft', 'sent', 'signed', 'withdrawn')),

  currency     text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  fx_rate      numeric(20,10) NOT NULL CHECK (fx_rate > 0),
  fx_rate_date date NOT NULL,

  -- THE ADVANCE-FEE GATE. When an advance is required, the engagements this
  -- letter creates start `pending_advance` and no `contract.activated` is
  -- emitted until it is recorded — so the gate is real rather than advisory:
  -- no advance, no jobs.
  advance_required boolean NOT NULL DEFAULT false,
  advance_amount   numeric(18,4) CHECK (advance_amount >= 0),
  advance_recorded_at timestamptz,
  advance_recorded_by uuid REFERENCES tenancy.user_account(id),

  -- ── the signature ──
  sent_at              timestamptz,
  signed_at            timestamptz,
  -- Who signed, as attested. Personal data, deliberately in an ERASABLE row —
  -- it must never reach the ledger, whose payloads carry ids only.
  signed_by_name       text,
  -- Which provider, or 'attested' when a person recorded a wet signature.
  signature_method     text,
  -- The provider's envelope id, or the firm's own reference for a paper copy.
  signature_reference  text,
  -- SHA-256 of the canonical rendering at the moment of signing. The pins below
  -- make the document reconstructible; this makes it VERIFIABLE — recompute and
  -- compare, and "is this what they signed" has an answer. No PDF: document
  -- storage does not exist yet, and a column pretending it did would be the
  -- stub-that-lies.
  signed_content_hash  text CHECK (signed_content_hash ~ '^[0-9a-f]{64}$'),

  withdrawn_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT el_sent_when_left_draft_chk CHECK (
    (status = 'draft' AND sent_at IS NULL) OR (status <> 'draft' AND sent_at IS NOT NULL)
  ),
  -- A signed letter carries the whole signature or none of it. A signed_at with
  -- no method and no hash is a document nobody can verify, which is the same as
  -- an unsigned one except that it claims otherwise.
  CONSTRAINT el_signature_is_whole_chk CHECK (
    (status <> 'signed'
       AND signed_at IS NULL AND signed_by_name IS NULL
       AND signature_method IS NULL AND signed_content_hash IS NULL)
    OR
    (status = 'signed'
       AND signed_at IS NOT NULL AND signed_by_name IS NOT NULL
       AND signature_method IS NOT NULL AND signed_content_hash IS NOT NULL)
  ),
  CONSTRAINT el_withdrawn_when_withdrawn_chk CHECK (
    (status = 'withdrawn' AND withdrawn_at IS NOT NULL) OR
    (status <> 'withdrawn' AND withdrawn_at IS NULL)
  ),
  -- An advance amount only means something when one is required, and a recorded
  -- advance carries who recorded it.
  CONSTRAINT el_advance_is_coherent_chk CHECK (
    (advance_required AND advance_amount IS NOT NULL) OR
    (NOT advance_required AND advance_amount IS NULL AND advance_recorded_at IS NULL)
  ),
  CONSTRAINT el_advance_record_is_whole_chk CHECK (
    (advance_recorded_at IS NULL     AND advance_recorded_by IS NULL) OR
    (advance_recorded_at IS NOT NULL AND advance_recorded_by IS NOT NULL)
  ),

  CONSTRAINT el_party_tenant_fkey
    FOREIGN KEY (party_id, tenant_id) REFERENCES core.party (id, tenant_id),
  CONSTRAINT el_proposal_tenant_fkey
    FOREIGN KEY (proposal_id, tenant_id) REFERENCES crm.proposal (id, tenant_id),
  -- What the lines and clauses point back at: the letter, its tenant AND its
  -- currency in one key, so a line in another currency is unrepresentable.
  CONSTRAINT el_id_tenant_currency_key UNIQUE (id, tenant_id, currency),
  CONSTRAINT el_id_tenant_key UNIQUE (id, tenant_id)
);
CREATE TRIGGER trg_el_updated_at BEFORE UPDATE ON crm.engagement_letter
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- ── engagement_letter_line ── one thing agreed, at one price. One of these
-- becomes one engagement at signature; that fan-out IS this task's acceptance.
CREATE TABLE crm.engagement_letter_line (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenancy.tenant(id),
  engagement_letter_id uuid NOT NULL,

  -- THE PIN, the same frozen config.version a proposal line holds. The agreed
  -- price may differ from the quoted one — that is why the money is here and
  -- not read back through the proposal — but the SERVICE is the same catalogue
  -- row, so a firm can still ask what it sold and at what list price.
  service_version_id uuid NOT NULL,

  description text NOT NULL CHECK (btrim(description) <> ''),
  position    integer NOT NULL CHECK (position > 0),
  quantity    numeric(14,4) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_amount numeric(18,4) NOT NULL CHECK (unit_amount >= 0),
  currency    text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  discount_percent numeric(5,2) NOT NULL DEFAULT 0
                   CHECK (discount_percent >= 0 AND discount_percent <= 100),

  removed_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT el_line_letter_fkey
    FOREIGN KEY (engagement_letter_id, tenant_id, currency)
    REFERENCES crm.engagement_letter (id, tenant_id, currency),
  CONSTRAINT el_line_service_version_tenant_fkey
    FOREIGN KEY (service_version_id, tenant_id) REFERENCES config.version (id, tenant_id),
  CONSTRAINT el_line_id_tenant_key UNIQUE (id, tenant_id)
);
CREATE TRIGGER trg_el_line_updated_at BEFORE UPDATE ON crm.engagement_letter_line
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

CREATE UNIQUE INDEX el_line_one_per_position
  ON crm.engagement_letter_line (engagement_letter_id, position) WHERE removed_at IS NULL;

-- ── engagement_letter_clause ── the wording, PINNED.
-- A live read would answer "what exactly did they agree to" with today's text,
-- which is the wrong answer in the only conversation where that question comes
-- up. So the letter stores the clause VERSION ids it was assembled from, and
-- they resolve forever because a published config version is frozen and an
-- archived one stays readable.
CREATE TABLE crm.engagement_letter_clause (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenancy.tenant(id),
  engagement_letter_id uuid NOT NULL,
  clause_version_id    uuid NOT NULL,
  position    integer NOT NULL CHECK (position > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT el_clause_letter_fkey
    FOREIGN KEY (engagement_letter_id, tenant_id)
    REFERENCES crm.engagement_letter (id, tenant_id),
  CONSTRAINT el_clause_version_tenant_fkey
    FOREIGN KEY (clause_version_id, tenant_id) REFERENCES config.version (id, tenant_id),
  -- UNIQUE SCOPE: one position per letter, and one appearance per clause. The
  -- same term twice on one contract is a drafting error, not a choice.
  CONSTRAINT el_clause_one_per_position UNIQUE (engagement_letter_id, position),
  CONSTRAINT el_clause_once_per_letter UNIQUE (engagement_letter_id, clause_version_id)
);

-- ── engagement ── one ongoing piece of work, sold by one letter line.
--
-- Deliberately carries no money of its own: it references the line, which is
-- frozen at signature, so the two can never disagree. A renewal at a different
-- price is a NEW LETTER (agreed on the board), which is what keeps that true.
CREATE TABLE crm.engagement (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenancy.tenant(id),
  engagement_letter_id      uuid NOT NULL,
  engagement_letter_line_id uuid NOT NULL,
  party_id    uuid NOT NULL,

  status      text NOT NULL DEFAULT 'pending_advance'
              CHECK (status IN ('pending_advance', 'active', 'paused', 'completed', 'cancelled')),

  activated_at timestamptz,
  ends_on      date,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- An engagement that has ever been active has a date for it. Without this,
  -- "how long from signature to work starting" is answered from a column that
  -- is sometimes set and nobody notices which.
  CONSTRAINT engagement_activated_chk CHECK (
    (status = 'pending_advance' AND activated_at IS NULL) OR
    (status <> 'pending_advance' AND activated_at IS NOT NULL)
  ),

  -- ONE ENGAGEMENT PER LINE — the acceptance, as a constraint rather than a
  -- convention. Fanning out twice would double the work and the revenue.
  CONSTRAINT engagement_one_per_line UNIQUE (engagement_letter_line_id),

  CONSTRAINT engagement_letter_tenant_fkey
    FOREIGN KEY (engagement_letter_id, tenant_id)
    REFERENCES crm.engagement_letter (id, tenant_id),
  CONSTRAINT engagement_line_tenant_fkey
    FOREIGN KEY (engagement_letter_line_id, tenant_id)
    REFERENCES crm.engagement_letter_line (id, tenant_id),
  CONSTRAINT engagement_party_tenant_fkey
    FOREIGN KEY (party_id, tenant_id) REFERENCES core.party (id, tenant_id)
);
CREATE TRIGGER trg_engagement_updated_at BEFORE UPDATE ON crm.engagement
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- The reads these exist for.
CREATE INDEX idx_el_tenant_status  ON crm.engagement_letter (tenant_id, status, created_at DESC);
CREATE INDEX idx_el_tenant_party   ON crm.engagement_letter (tenant_id, party_id, created_at DESC);
CREATE INDEX idx_el_line_letter    ON crm.engagement_letter_line (engagement_letter_id, position);
CREATE INDEX idx_el_clause_letter  ON crm.engagement_letter_clause (engagement_letter_id, position);
CREATE INDEX idx_engagement_tenant ON crm.engagement (tenant_id, status, created_at DESC);
CREATE INDEX idx_engagement_party  ON crm.engagement (tenant_id, party_id);

-- THE TENANT WALL, identical in shape to every other business table.
ALTER TABLE crm.engagement_letter ENABLE ROW LEVEL SECURITY;
CREATE POLICY el_isolation ON crm.engagement_letter
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE crm.engagement_letter_line ENABLE ROW LEVEL SECURITY;
CREATE POLICY el_line_isolation ON crm.engagement_letter_line
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE crm.engagement_letter_clause ENABLE ROW LEVEL SECURITY;
CREATE POLICY el_clause_isolation ON crm.engagement_letter_clause
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE crm.engagement ENABLE ROW LEVEL SECURITY;
CREATE POLICY engagement_isolation ON crm.engagement
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ── THE FREEZE ──
--
-- A signed letter is immutable, enforced here rather than in the service. The
-- config registry's freeze (0005) is the precedent; this one matters more,
-- because the question it protects — what exactly did the client sign — is one
-- a court asks, and an application-level rule cannot answer it against a
-- migration or a psql session.
--
-- What IS still allowed on a signed letter: recording the advance, and
-- updated_at moving. Everything else is refused, and nothing may be deleted.
CREATE OR REPLACE FUNCTION crm.refuse_signed_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'signed' THEN
      RAISE EXCEPTION
        'engagement letter % is signed and cannot be deleted: it is the record of what the client agreed to. Supersede it with a new letter instead.',
        OLD.id USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'signed' THEN
    RETURN NEW;
  END IF;

  IF NEW.status              IS DISTINCT FROM OLD.status
     OR NEW.party_id         IS DISTINCT FROM OLD.party_id
     OR NEW.tenant_id        IS DISTINCT FROM OLD.tenant_id
     OR NEW.jurisdiction     IS DISTINCT FROM OLD.jurisdiction
     OR NEW.title            IS DISTINCT FROM OLD.title
     OR NEW.currency         IS DISTINCT FROM OLD.currency
     OR NEW.fx_rate          IS DISTINCT FROM OLD.fx_rate
     OR NEW.fx_rate_date     IS DISTINCT FROM OLD.fx_rate_date
     OR NEW.advance_required IS DISTINCT FROM OLD.advance_required
     OR NEW.advance_amount   IS DISTINCT FROM OLD.advance_amount
     OR NEW.signed_at        IS DISTINCT FROM OLD.signed_at
     OR NEW.signed_by_name   IS DISTINCT FROM OLD.signed_by_name
     OR NEW.signature_method IS DISTINCT FROM OLD.signature_method
     OR NEW.signed_content_hash IS DISTINCT FROM OLD.signed_content_hash THEN
    RAISE EXCEPTION
      'engagement letter % is signed and frozen: it is the record of what the client agreed to, and it must read tomorrow exactly as it reads today. Supersede it with a new letter instead of editing this one.',
      OLD.id USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_el_freeze
  BEFORE UPDATE OR DELETE ON crm.engagement_letter
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_signed_change();

-- The lines and clauses of a signed letter are frozen too — the freeze above
-- would be decorative if the terms underneath it could still move.
CREATE OR REPLACE FUNCTION crm.refuse_signed_child_change() RETURNS trigger AS $$
DECLARE
  parent_status text;
  parent_id uuid;
BEGIN
  parent_id := CASE TG_OP WHEN 'DELETE' THEN OLD.engagement_letter_id
                          ELSE NEW.engagement_letter_id END;
  SELECT status INTO parent_status FROM crm.engagement_letter WHERE id = parent_id;
  IF parent_status = 'signed' THEN
    RAISE EXCEPTION
      'engagement letter % is signed, so its terms are frozen. Supersede it with a new letter.',
      parent_id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_el_line_freeze
  BEFORE INSERT OR UPDATE OR DELETE ON crm.engagement_letter_line
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_signed_child_change();
CREATE TRIGGER trg_el_clause_freeze
  BEFORE INSERT OR UPDATE OR DELETE ON crm.engagement_letter_clause
  FOR EACH ROW EXECUTE FUNCTION crm.refuse_signed_child_change();

RESET ROLE;

-- Grants. No DELETE anywhere: a letter that went nowhere is `withdrawn`, and a
-- signed one is the record. What the firm offered and withdrew is the history.
GRANT SELECT, INSERT, UPDATE ON crm.engagement_letter        TO bib_app;
GRANT SELECT, INSERT, UPDATE ON crm.engagement_letter_line   TO bib_app;
GRANT SELECT, INSERT, UPDATE ON crm.engagement_letter_clause TO bib_app;
GRANT SELECT, INSERT, UPDATE ON crm.engagement               TO bib_app;
