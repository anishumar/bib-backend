-- 0037 · The document store (T3.6, P8 + P9) — bytes, versions, and what they
-- are attached to.
--
-- ── WHY A NEW SCHEMA AND NOT `crm` ─────────────────────────────────────────
--
-- `crm.document_block` (G1.7) and `crm.document_ref_series` (0020) already
-- exist and neither of them is about a FILE. A block is a paragraph of prose
-- inside a proposal; the series hands out `PR-2026-0007`. A table called
-- `crm.document` sitting beside `crm.document_block` would read as "the document
-- a block belongs to", which is the exact opposite of what it is, and nobody
-- reading the directory a year from now would guess otherwise.
--
-- The second reason is the load-bearing one: this store is attached to things
-- across the whole product — a party, a lead, an engagement letter, an invoice,
-- a delivery job, and the obligations T3.2 will add. It is not CRM's, and
-- putting it in `crm` would make every other module import from a schema it has
-- no other business in.
--
-- ── WHAT IS SEPARATE FROM WHAT, AND WHY IT IS THREE TABLES ─────────────────
--
-- A document has an IDENTITY that outlives any particular file: "the signed
-- engagement letter for Kaveri Foods" is one thing whether it has been reissued
-- once or four times. `files.document` is that identity. `files.document_version`
-- is a specific set of bytes. Merging them makes re-issuing a document either
-- impossible or destructive, and for a document a client has already received,
-- destructive is the wrong answer — "which version did they sign" is asked
-- every time a filing is questioned.
--
-- `files.document_link` is separate for a different reason: the SAME document is
-- legitimately attached to more than one thing. A PAN card belongs to the party
-- and is also evidence on the engagement that needed it. A column on
-- `files.document` would force a choice between them and lose the other.
--
-- ── CONTENT-ADDRESSED, AND WHAT THAT BUYS AND COSTS ────────────────────────
--
-- `storage_key` is derived from the SHA-256 of the bytes, so the same file
-- uploaded twice occupies one blob. That is not premature optimisation: a firm
-- attaching one client's PAN card to six engagements is the ordinary case, and
-- so is a client re-uploading the file they already sent.
--
-- The cost, stated rather than discovered later: **two documents can share a
-- blob**, so the bytes behind a version are not owned by it. Nothing may
-- therefore delete a blob because one document that referenced it went away.
-- That is not a constraint this product has to defend, because `bib_app` holds
-- no DELETE grant on anything and the storage port deliberately has no delete
-- method — but if either of those ever changes, this comment is the reason it
-- must not.
--
-- The hash is also the integrity check. `content_hash` is what the engagement
-- letter's own `content_hash` (T2.3) commits to, so a letter and the file a
-- client received are comparable rather than merely both present.
--
-- ── VERSIONS ARE APPEND-ONLY, ENFORCED BY THE GRANT ────────────────────────
--
-- `files.document_version` gets SELECT and INSERT and nothing else, exactly as
-- the `ledger` schema does. A trigger would work too and would be weaker: a
-- trigger is a rule the table carries, a missing grant is a permission the role
-- does not hold, and an import or an agent walks past the first and not the
-- second. A version that could be edited is a document whose history is a
-- suggestion.
--
-- Note what this means for the OTHER two tables: `files.document` takes UPDATE
-- (a title is a label and gets corrected) and `files.document_link` does not
-- (an attachment made in error is a fact about what somebody did — see the
-- link table's own comment).
--
-- ── THE POLYMORPHIC SUBJECT, AND THE FK THAT CANNOT EXIST ──────────────────
--
-- `(subject_kind, subject_ref)` follows `delivery.job`'s `(source_kind,
-- source_ref)` (0041) rather than inventing a second idiom for the same shape.
-- The honest consequence is the same one: **`subject_ref` has no foreign key**,
-- because it points at a different table depending on the kind beside it, and
-- Postgres has no way to say that.
--
-- What that costs is real and is not hidden: a link can name a row that does not
-- exist, and no constraint will catch it. What contains the damage is the CHECK
-- on `subject_kind` — an unknown kind is refused at the write, so the failure
-- mode is a dangling reference within a KNOWN vocabulary rather than a link to
-- anything at all. The read model resolves the subject and a link that resolves
-- to nothing is visible as such rather than rendering blank.
--
-- This is also why `subject_kind` is a CHECK and not a free text column. Adding
-- a kind is a migration, and that is the point: every kind needs the read model
-- to learn how to resolve it, and a kind nothing can resolve is a link nobody
-- can follow.
--
-- ── BRAND ASSETS: THE HALF OF DOCUMENT GENERATION NOBODY SCHEDULED ─────────
--
-- The board carried `brand_asset` in "deliberately NOT on this board" with the
-- note that PDF generation cannot ship without it. It is here rather than in a
-- task of its own because it is one small table over the store this migration
-- already builds, and because a renderer with nowhere to read a logo from is a
-- renderer that hardcodes one.
--
-- **It is keyed on the ENTITY, not the firm**, and that is G1.2's rule applied
-- to paper: a firm with an Indian entity and a US entity signs on two
-- letterheads, and a letter issued by the US entity printing the Indian logo is
-- the same class of error as one printing Indian governing law (G1.8). The
-- partial unique index is what makes "the current logo" a lookup rather than a
-- sort — one active asset per (entity, kind), superseded by inserting a new row
-- and clearing the old flag, so the one that was in force when a document was
-- issued stays readable.

CREATE SCHEMA IF NOT EXISTS files AUTHORIZATION bib_owner;

SET ROLE bib_owner;

-- Shared by the three tables that carry a mutable column. `updated_at` on an
-- append-only table would be a lie, so `document_version` and `document_link`
-- do not get this trigger and do not have the column.
CREATE OR REPLACE FUNCTION files.set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── files.document ─────────────────────────────────────────────────────────

CREATE TABLE files.document (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenancy.tenant (id),

  title       text NOT NULL CHECK (length(btrim(title)) > 0),

  -- What this document IS, which decides who may see it and how it is rendered.
  -- `generated` is the product's own output (a rendered letter or invoice);
  -- `uploaded` is a file a person supplied. The distinction matters because a
  -- generated document can be re-rendered from its source and an uploaded one
  -- is the only copy in existence.
  origin      text NOT NULL CHECK (origin IN ('generated', 'uploaded')),

  -- The narrower classification, and it is deliberately a CHECK rather than a
  -- config kind: these are the product's own document types, not a vocabulary a
  -- firm changes weekly. A firm's own filing categories, when they are asked
  -- for, are a different axis and belong in the registry.
  kind        text NOT NULL CHECK (kind IN (
                'proposal', 'engagement_letter', 'invoice', 'credit_note',
                'identity_proof', 'statutory_filing', 'working_paper',
                'correspondence', 'brand_asset', 'other'
              )),

  -- WHOSE document, and it is nullable on purpose. A firm's own letterhead
  -- belongs to no client; a client's PAN card belongs to exactly one. This is
  -- the column Gate 4 (record-scope) will filter the client portal on, which is
  -- why it is here before the portal needs it — adding it later means
  -- backfilling a fact nobody recorded, which is the same argument
  -- `job_step.performed_by` was added under (T2.7).
  party_id    uuid,

  -- Null means the system generated it. `tenancy.user_account` is GLOBAL, so
  -- this is an id-only reference by design and not a missed composite key —
  -- the same shape as `job_step.performed_by`.
  created_by  uuid REFERENCES tenancy.user_account (id),

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- The composite the tenant wall requires of anything referencing this table.
  CONSTRAINT document_id_tenant_key UNIQUE (id, tenant_id),

  -- Carries the tenant, per the wall: an id-only reference would let one firm's
  -- document hang off another firm's party with every policy satisfied.
  FOREIGN KEY (party_id, tenant_id) REFERENCES core.party (id, tenant_id)
);

CREATE INDEX idx_document_tenant_party
  ON files.document (tenant_id, party_id, created_at DESC);
CREATE INDEX idx_document_tenant_kind
  ON files.document (tenant_id, kind, created_at DESC);

CREATE TRIGGER trg_document_updated_at
  BEFORE UPDATE ON files.document
  FOR EACH ROW EXECUTE FUNCTION files.set_updated_at();

ALTER TABLE files.document ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_isolation ON files.document
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

-- ── files.document_version ─────────────────────────────────────────────────

CREATE TABLE files.document_version (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenancy.tenant (id),
  document_id   uuid NOT NULL,

  -- Ascending from 1, per document. Not a global sequence: "version 3" is a
  -- fact about this document and reading it should not require knowing how many
  -- other documents the firm stored in between.
  version_no    integer NOT NULL CHECK (version_no > 0),

  -- Lower-case hex SHA-256 of the bytes. The CHECK is worth its cost because
  -- this value is evidence: it is what an engagement letter's own content hash
  -- is compared against, and a truncated or upper-case digest would compare
  -- unequal to an identical file and look like tampering.
  content_hash  text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),

  -- Zero-byte files are refused. A zero-byte upload is always a failed one, and
  -- storing it means a client sees "PAN card attached" over nothing.
  byte_size     bigint NOT NULL CHECK (byte_size > 0),

  media_type    text NOT NULL CHECK (length(btrim(media_type)) > 0),

  -- What the file was called when it arrived, kept verbatim. It is a label, not
  -- a path — nothing resolves it against a filesystem.
  filename      text NOT NULL CHECK (length(btrim(filename)) > 0),

  -- Where the bytes live, as the storage port understands it. Derived from the
  -- tenant and the content hash, so it is stable and re-derivable; stored rather
  -- than recomputed because the derivation is the storage adapter's business and
  -- a stored key survives a change of scheme.
  storage_key   text NOT NULL CHECK (length(btrim(storage_key)) > 0),

  created_by    uuid REFERENCES tenancy.user_account (id),
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT document_version_one_per_no UNIQUE (document_id, version_no),
  CONSTRAINT document_version_id_tenant_key UNIQUE (id, tenant_id),

  FOREIGN KEY (document_id, tenant_id) REFERENCES files.document (id, tenant_id)
);

CREATE INDEX idx_document_version_document
  ON files.document_version (document_id, version_no DESC);

-- Content-addressed lookup: "do we already hold these bytes for this firm".
-- Per tenant and not global — one firm must not learn that another holds a file
-- by observing that its own upload deduplicated.
CREATE INDEX idx_document_version_hash
  ON files.document_version (tenant_id, content_hash);

ALTER TABLE files.document_version ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_version_isolation ON files.document_version
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

-- ── files.document_link ────────────────────────────────────────────────────

CREATE TABLE files.document_link (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenancy.tenant (id),
  document_id   uuid NOT NULL,

  -- See the header: this pair is `delivery.job`'s idiom, and `subject_ref` has
  -- no foreign key because it cannot have one.
  subject_kind  text NOT NULL CHECK (subject_kind IN (
                  'party', 'lead', 'proposal', 'engagement_letter',
                  'engagement', 'invoice', 'job'
                )),
  subject_ref   uuid NOT NULL,

  -- Why this document is attached to this subject, when the answer is not "it
  -- just is" — `signed_copy`, `evidence`, `annexure`. Nullable, because most
  -- attachments have no role worth naming and a mandatory one would be filled
  -- with noise.
  role          text CHECK (role IS NULL OR length(btrim(role)) > 0),

  created_by    uuid REFERENCES tenancy.user_account (id),
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- One link per (document, subject). Attaching the same file to the same
  -- engagement twice is a double-click, not a second fact.
  CONSTRAINT document_link_once
    UNIQUE (tenant_id, document_id, subject_kind, subject_ref),

  FOREIGN KEY (document_id, tenant_id) REFERENCES files.document (id, tenant_id)
);

CREATE INDEX idx_document_link_subject
  ON files.document_link (tenant_id, subject_kind, subject_ref);
CREATE INDEX idx_document_link_document
  ON files.document_link (tenant_id, document_id);

ALTER TABLE files.document_link ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_link_isolation ON files.document_link
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

-- ── files.brand_asset ──────────────────────────────────────────────────────

CREATE TABLE files.brand_asset (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenancy.tenant (id),

  -- The firm's own entity this asset represents. NOT NULL: an asset belonging
  -- to "the firm" rather than to one of its companies is exactly the ambiguity
  -- G1.2 removed from the documents themselves.
  entity_party_id     uuid NOT NULL,

  kind                text NOT NULL CHECK (kind IN ('logo', 'signature', 'letterhead')),

  -- The bytes. A brand asset is a document like any other, so it is stored once
  -- in the store above rather than in a column of its own — which also means a
  -- logo carries a content hash and an upload history for free.
  document_version_id uuid NOT NULL,

  -- Superseding rather than editing: the logo in force when a letter was issued
  -- stays readable. `is_active` and not `deleted_at`, and the distinction is
  -- G3.3's — the firm changed its logo, it did not make a mistake.
  is_active           boolean NOT NULL DEFAULT true,

  created_by          uuid REFERENCES tenancy.user_account (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT brand_asset_id_tenant_key UNIQUE (id, tenant_id),

  FOREIGN KEY (entity_party_id, tenant_id) REFERENCES core.party (id, tenant_id),
  FOREIGN KEY (document_version_id, tenant_id)
    REFERENCES files.document_version (id, tenant_id)
);

-- "The current logo for this entity" is one row, not a sort over history. A
-- partial index rather than a constraint because superseded rows must be able
-- to pile up freely.
CREATE UNIQUE INDEX brand_asset_one_active
  ON files.brand_asset (tenant_id, entity_party_id, kind)
  WHERE is_active;

CREATE TRIGGER trg_brand_asset_updated_at
  BEFORE UPDATE ON files.brand_asset
  FOR EACH ROW EXECUTE FUNCTION files.set_updated_at();

ALTER TABLE files.brand_asset ENABLE ROW LEVEL SECURITY;
CREATE POLICY brand_asset_isolation ON files.brand_asset
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

-- ── Grants ─────────────────────────────────────────────────────────────────
--
-- Stated per table rather than by ALTER DEFAULT PRIVILEGES on the schema,
-- because the three shapes genuinely differ and a default would flatten them:
--
--   document        SELECT, INSERT, UPDATE  — a title is a label and is corrected.
--   document_version SELECT, INSERT         — append-only. THIS IS THE POINT.
--   document_link   SELECT, INSERT          — see below.
--   brand_asset     SELECT, INSERT, UPDATE  — superseding flips `is_active`.
--
-- No DELETE anywhere, per CLAUDE.md: `bib_app` holds no DELETE grant on a single
-- table in this database.
--
-- `document_link` has no UPDATE for the same reason `document_version` has none:
-- changing what a document is attached to, in place, rewrites the answer to
-- "what was filed against this engagement" with no trace. Detaching is not
-- implemented in this migration and needs its own decision — a `detached_at`
-- column is the obvious shape, and it is deliberately absent rather than
-- guessed, because whether an attachment made in error should vanish from the
-- engagement or remain visible as withdrawn is a question for a firm.
GRANT USAGE ON SCHEMA files TO bib_app;

GRANT SELECT, INSERT, UPDATE ON files.document TO bib_app;
GRANT SELECT, INSERT         ON files.document_version TO bib_app;
GRANT SELECT, INSERT         ON files.document_link TO bib_app;
GRANT SELECT, INSERT, UPDATE ON files.brand_asset TO bib_app;

RESET ROLE;
