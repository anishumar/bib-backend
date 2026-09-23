-- 0080 · A letter out for signature with DocuSign — who was asked, and which envelope.
--
-- The first number in `(A)`'s 0080+ range.
--
-- ── WHY A TABLE OF ITS OWN AND NOT COLUMNS ON THE LETTER ─────────────────────
--
-- `crm.engagement_letter` is frozen WHOLE once signed (0019 inverted the freeze:
-- a new column is frozen the day it exists, and adding an exemption needs an
-- argument). A signature request is not a term of the agreement: it is the
-- PLUMBING that obtained the signature, and it keeps moving AFTER the letter
-- freezes — the sweep records the outcome in the same pass that signs. On the
-- letter row that would be a fourth exemption bought for plumbing; here it is an
-- ordinary UPDATE on a row that was never a term.
--
-- ── WHY `sent` IS THE STATE, AND THERE IS NO FIFTH ONE ───────────────────────
--
-- Decided 2026-09-23. `sent` already means "the terms are frozen and the client
-- has been asked to sign", which is exactly where a letter sits while its
-- envelope is out. What a fifth state would have added — WHICH provider asked,
-- and whether the asking has actually happened yet — is this row, and it is
-- read beside the letter rather than instead of it.
--
-- ── ONE ROW PER LETTER, EVER ─────────────────────────────────────────────────
--
-- `UNIQUE (tenant_id, engagement_letter_id)`, scoped per firm like everything
-- else. A letter is sent once — `draft → sent` is its only forward move, and a
-- sent letter's only moves are `signed` and `withdrawn`, both terminal. A retry
-- after DocuSign refused is the SAME request tried again, never a second one;
-- asking again after a decline is a NEW letter, because a declined letter is
-- withdrawn.
--
-- ── WHAT IS PERSONAL AND WHERE IT STAYS ──────────────────────────────────────
--
-- `signer_name` and `signer_email` are personal data. They live in this
-- erasable row and NEVER in the ledger: `engagement_letter.signature_requested`
-- carries the provider and the envelope id, and the events that follow carry
-- the outcome. The name is also what the letter records as its signatory when
-- the sweep signs it — the person DocuSign asked is the person who signed.
SET ROLE bib_owner;

CREATE TABLE crm.letter_signature_request (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenancy.tenant(id),
  engagement_letter_id uuid NOT NULL,
  -- The provider's own name, as `ESignProvider.method` spells it. A CHECK
  -- rather than free text because the sweep dispatches on it; a second
  -- provider is a migration and a case in the service, together.
  provider             text NOT NULL CHECK (provider IN ('docusign')),
  signer_name          text NOT NULL CHECK (length(btrim(signer_name)) > 0),
  signer_email         text NOT NULL CHECK (signer_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  requested_by         uuid REFERENCES tenancy.user_account(id),
  -- DocuSign's envelope id, once one exists. NULL means the request is
  -- recorded and DocuSign has not accepted an envelope for it yet — either the
  -- call is in flight or it failed and `last_failure` says why.
  envelope_id          text,
  raised_at            timestamptz,
  -- The lease that stops two callers raising two envelopes for one letter. Set
  -- by the claim, cleared on failure; a claim older than the lease is presumed
  -- dead and may be taken again.
  claimed_at           timestamptz,
  -- The provider's own words, kept so the letter page can say why the client
  -- has not received anything. Overwritten by the next attempt, cleared by a
  -- success: this is the CURRENT fault, not a history.
  last_failure         text,
  attempts             integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- How it ended. `completed` → the letter was signed; `declined` / `voided`
  -- → the letter was withdrawn. NULL while the envelope is still out.
  outcome              text CHECK (outcome IN ('completed', 'declined', 'voided')),
  settled_at           timestamptz,
  -- When the provider's SIGNED PDF and its certificate of completion were
  -- filed in bib's own document store. NULL on a completed request means the
  -- signature is recorded and the copies are still to fetch — the sweep keeps
  -- trying, because a provider's retention policy is not bib's evidence.
  copies_filed_at      timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT letter_signature_request_id_tenant_key UNIQUE (id, tenant_id),
  -- The tenant travels with the reference (CLAUDE.md, the tenant wall): an
  -- id-only key would let one firm's request hang off another firm's letter.
  CONSTRAINT letter_signature_request_letter_fkey
    FOREIGN KEY (engagement_letter_id, tenant_id)
    REFERENCES crm.engagement_letter (id, tenant_id),
  CONSTRAINT letter_signature_request_one_per_letter
    UNIQUE (tenant_id, engagement_letter_id),
  -- Scoped per firm, like every key here. Envelope ids are GUIDs DocuSign
  -- mints, so a collision inside one firm is the same envelope recorded twice.
  CONSTRAINT letter_signature_request_envelope_once
    UNIQUE (tenant_id, envelope_id),
  CONSTRAINT letter_signature_request_raised_together CHECK (
    (envelope_id IS NULL) = (raised_at IS NULL)
  ),
  CONSTRAINT letter_signature_request_settled_together CHECK (
    (outcome IS NULL) = (settled_at IS NULL)
  ),
  -- Only a signed envelope has signed copies to file. `IS NOT DISTINCT FROM`
  -- and not `=`: while `outcome` is NULL, `outcome = 'completed'` is NULL, and
  -- a CHECK that evaluates to NULL PASSES — the integration test caught
  -- exactly that.
  CONSTRAINT letter_signature_request_copies_of_a_signature CHECK (
    copies_filed_at IS NULL OR outcome IS NOT DISTINCT FROM 'completed'
  ),
  -- Nothing settles an envelope that never existed.
  CONSTRAINT letter_signature_request_settles_a_raised_one CHECK (
    outcome IS NULL OR envelope_id IS NOT NULL
  )
);

CREATE TRIGGER trg_letter_signature_request_updated_at
  BEFORE UPDATE ON crm.letter_signature_request
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- What the sweep reads: every request still waiting on something, per firm.
CREATE INDEX idx_letter_signature_request_open
  ON crm.letter_signature_request (tenant_id, created_at)
  WHERE outcome IS NULL;

-- And every signed one whose copies are not yet in bib's own store.
CREATE INDEX idx_letter_signature_request_unfiled
  ON crm.letter_signature_request (tenant_id, settled_at)
  WHERE outcome = 'completed' AND copies_filed_at IS NULL;

ALTER TABLE crm.letter_signature_request ENABLE ROW LEVEL SECURITY;
CREATE POLICY letter_signature_request_isolation ON crm.letter_signature_request
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- No portal policy, and no portal route reads this table: gate 2 contains it,
-- the arrangement 0065 made for `crm.client_freeze`. Whether a client may see
-- which address the firm sent their envelope to is a question for a firm.
GRANT SELECT, INSERT, UPDATE ON crm.letter_signature_request TO bib_app;

RESET ROLE;
