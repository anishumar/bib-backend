-- 0020 · The document reference (G1.1)
--
-- Neither a proposal nor an engagement letter had a human-facing identifier.
-- Every one of them is quoted back on the phone ("about EL-2026-0007…") and
-- cited by an auditor, and a uuid is neither quotable nor citable. This adds
-- `ref` to both documents, NOT NULL, unique per firm.
--
-- ── The generator, and the decision behind it ───────────────────────────────
--
-- `<TYPE>-<YEAR>-<NNNN>`: PR-2026-0007, EL-2026-0007. ONE SERIES PER FIRM, PER
-- DOCUMENT TYPE, PER CALENDAR YEAR — which is the second of the two options the
-- board parked (per issuing entity per year, or one continuous series), and it
-- is chosen rather than defaulted into:
--
--   The demo's shape was EL-US-2026-0007, where `US` is the ISSUING ENTITY's
--   jurisdiction. In this schema an issuing entity is a `core.party` (0021) and
--   its jurisdiction lives on `core.legal_entity` — which the firm's own entity
--   is not required to have: nothing has ever written `core.organization.
--   is_firm_self`, and no route registers the firm itself as a legal entity. A
--   segment the model cannot always supply would mean either inventing a
--   jurisdiction or a reference that is sometimes three segments and sometimes
--   four, and both are worse than a shorter number.
--
--   Per-entity numbering needs that discriminator IN THE STRING, not merely in
--   a column, because `UNIQUE (tenant_id, ref)` would otherwise make two
--   entities' seventh letters of 2026 collide. So the two questions are one
--   question, and they are both blocked on the same missing code.
--
--   What answers "who issued this" is `issuing_entity_party_id` (0021) — a
--   column, which a query can group by and a screen can render, rather than two
--   letters somebody has to know how to read.
--
-- WHY A COUNTER TABLE AND NOT A POSTGRES SEQUENCE. The board's reasoning is
-- that a document reference WANTS sequence semantics: the number is kept when
-- the write that asked for it rolls back, gaps are honest, and two people
-- drafting at once never wait on each other. A `SEQUENCE` object gives exactly
-- that — but a sequence is a schema object, and this series is keyed by tenant
-- and year, so a real sequence would mean either DDL on the drafting path (one
-- object per firm per year, created inside a request) or ONE sequence shared by
-- every firm on the installation. The second is a cross-tenant side channel:
-- the number is printed on a document a CLIENT reads, so a shared sequence
-- tells one firm's clients how much business every other firm on the platform
-- is doing.
--
-- So the counter is a row, and the SEMANTICS are restored above it: the adapter
-- advances this row in its OWN committed transaction and then writes the
-- document in a second one, so a failed draft BURNS its number exactly as a
-- sequence would. That discipline is the whole difference from T3.4, which
-- needs the opposite one — an invoice number is allocated INSIDE the invoice's
-- transaction and held under lock precisely so that no number is ever burnt.
-- Same table shape, opposite transaction boundary, opposite guarantee. Do not
-- copy this table into billing and assume the hard half is done.
--
-- ── Why this migration REFUSES rather than backfills ────────────────────────
--
-- The precedent is 0018, and the reasoning is the same twice over:
--
--   THE FREEZE. `crm.engagement_letter` carries `trg_el_freeze`, rewritten by
--   0019 to compare the whole row against a three-column allow-list. An UPDATE
--   that wrote a `ref` onto a signed letter is refused, by any role, including
--   this migration and a 2 a.m. psql session. That is the freeze WORKING. The
--   answer is not to disable it.
--
--   THERE IS NO HONEST VALUE. A reference is what the client's copy SAYS. A
--   document that went out without a number never had one, and minting one for
--   it now would put a number on our copy that appears nowhere on theirs — the
--   precise failure the reference exists to prevent.
--
-- This product has no production data, so the honest route is to refuse by name
-- rather than to fail later on a constraint somebody then has to diagnose. The
-- forward path for an environment that DOES hold issued documents is in the
-- exception message, because that is where the person who needs it will look.

SET ROLE bib_owner;

DO $$
DECLARE
  proposal_count bigint;
  letter_count   bigint;
BEGIN
  SELECT count(*) INTO proposal_count FROM crm.proposal;
  SELECT count(*) INTO letter_count   FROM crm.engagement_letter;

  IF proposal_count > 0 OR letter_count > 0 THEN
    RAISE EXCEPTION
      'migration 0020 adds a NOT NULL document reference to crm.proposal (% rows) and crm.engagement_letter (% rows), and neither can be backfilled: a signed letter is frozen by trg_el_freeze (0017, rewritten by 0019) so the UPDATE is refused by design, and no document that has already gone out carries a number the client could quote back — minting one now would put a reference on our copy that appears nowhere on theirs. This product has no production data — drop and re-create the database, run `npm run migrate`, then `npm run smoke` to re-seed. If you are reading this WITH REAL ISSUED DOCUMENTS in the table, do NOT disable the freeze: add ref as a NULLABLE column instead, require it only for documents drafted after this migration, and give the existing ones no number, because they have none.',
      proposal_count, letter_count
      USING ERRCODE = 'restrict_violation';
  END IF;
END $$;

-- ── crm.document_ref_series ── the counter, one row per firm per type per year.
--
-- No `id` column: the series IS its key, and a surrogate would let two rows
-- claim the same series. The primary key is therefore what the adapter's upsert
-- conflicts on.
CREATE TABLE crm.document_ref_series (
  tenant_id     uuid NOT NULL REFERENCES tenancy.tenant(id),
  -- The two documents that carry a reference today. A CHECK rather than a
  -- lookup table: the set is the product's and adding to it is a code change,
  -- the same argument the ledger's verb registry makes.
  document_type text NOT NULL CHECK (document_type IN ('proposal', 'engagement_letter')),
  -- The calendar year the series belongs to, in UTC — the year the drafting
  -- happened, not the year of any date on the document. A firm far enough east
  -- may see a document drafted late on 31 December carry the next year's
  -- number; that is a visible, explicable one-off, and deriving the year from a
  -- date the document has not got yet would be worse.
  year          integer NOT NULL CHECK (year BETWEEN 2000 AND 9999),
  -- The highest number handed out. Zero means the series exists and nothing has
  -- drawn from it, which is a state the upsert never actually leaves behind.
  last_number   integer NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_ref_series_pkey PRIMARY KEY (tenant_id, document_type, year)
);
CREATE TRIGGER trg_document_ref_series_updated_at
  BEFORE UPDATE ON crm.document_ref_series
  FOR EACH ROW EXECUTE FUNCTION tenancy.set_updated_at();

-- ── the reference itself ──
--
-- UNIQUE SCOPE: per TENANT. Two firms may both issue EL-2026-0007 and neither
-- has any way to see the other's, so a global unique index would be a shared
-- namespace between tenants for no benefit — and it would make one firm's
-- drafting fail because of another firm's volume.
--
-- The CHECK pins the prefix per table, so an engagement letter cannot be given
-- a proposal's number by a caller that got the arguments the wrong way round.
ALTER TABLE crm.proposal
  ADD COLUMN ref text NOT NULL,
  ADD CONSTRAINT proposal_ref_shape_chk CHECK (ref ~ '^PR-[0-9]{4}-[0-9]{4,}$'),
  ADD CONSTRAINT proposal_ref_tenant_key UNIQUE (tenant_id, ref);

ALTER TABLE crm.engagement_letter
  ADD COLUMN ref text NOT NULL,
  ADD CONSTRAINT el_ref_shape_chk CHECK (ref ~ '^EL-[0-9]{4}-[0-9]{4,}$'),
  ADD CONSTRAINT el_ref_tenant_key UNIQUE (tenant_id, ref);

-- THE TENANT WALL, identical in shape to every other business table.
ALTER TABLE crm.document_ref_series ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_ref_series_isolation ON crm.document_ref_series
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

RESET ROLE;

-- No DELETE: a series that has handed out numbers must keep its high-water mark
-- forever, or the next document reissues a reference a client already holds.
GRANT SELECT, INSERT, UPDATE ON crm.document_ref_series TO bib_app;
